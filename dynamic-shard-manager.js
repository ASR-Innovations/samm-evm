'use strict';
/**
 * Dynamic Shard Manager — Solana edition
 *
 * Monitors pool shards for utilization and demand, and creates / merges /
 * rebalances shards as needed.
 *
 * On Solana, each shard is an independent pool state account that uses the
 * same deployed program.  Creating a new shard means calling the program's
 * Initialize instruction.  The deployment JSON is updated on disk whenever
 * a shard is created or removed.
 *
 * Current phase: monitoring + analytics are fully implemented; on-chain
 * shard creation is stubbed behind ENABLE_AUTO_SHARD_CREATE=true because
 * it requires the program to be deployed and a funded wallet.
 */

const fs   = require('fs');
const path = require('path');
const SolanaAdapter = require('./solana-adapter');

class DynamicShardManager {
  /**
   * @param {string}  deploymentFile
   * @param {import('@solana/web3.js').Keypair} keypair
   * @param {import('@solana/web3.js').Connection} connection
   * @param {import('./tx-queue')} txQueue
   * @param {string}  programId
   */
  constructor(deploymentFile, keypair, connection, txQueue, programId) {
    this.deploymentPath = path.join(__dirname, 'deployment-data', deploymentFile);
    this.deployment     = JSON.parse(fs.readFileSync(this.deploymentPath, 'utf8'));
    this.keypair    = keypair;
    this.connection = connection;
    this.txQueue    = txQueue;
    this.programId  = programId;

    this.adapter = new SolanaAdapter(connection, keypair, this.deployment, programId);

    this.isRunning  = false;
    this.isChecking = false;
    this.checkInterval = parseInt(process.env.SHARD_CHECK_INTERVAL || '60000');

    // Thresholds
    this.UTILIZATION_THRESHOLD = parseFloat(process.env.UTILIZATION_THRESHOLD || '0.7');
    this.MAX_SHARDS_PER_PAIR   = parseInt(process.env.MAX_SHARDS_PER_PAIR    || '10');
    this.C_THRESHOLD           = 0.0096;

    // TPS-driven scaling (litepaper §6)
    this.PER_SHARD_TPS         = parseFloat(process.env.PER_SHARD_TPS       || '50');
    this.TPS_WINDOW_SECONDS    = parseInt(process.env.TPS_WINDOW            || '300');
    this.MIN_TPS_FOR_SCALE_UP  = parseFloat(process.env.MIN_TPS_FOR_SCALE_UP|| '5');

    this.SPLIT_LIQUIDITY_THRESHOLD = parseFloat(process.env.SPLIT_LIQUIDITY_THRESHOLD || '8000000');
    this.MIN_SPLIT_TVL             = 500_000;

    this._pairTPS = {};

    // SAMM parameters (match deployed program)
    this.SAMM_PARAMS = { tradeFeeNumerator: 25n, tradeFeeDenominator: 10000n };

    this.SHARD_TIERS = [
      { name: 'Small',  liquidityUSD: 250_000 },
      { name: 'Medium', liquidityUSD: 1_000_000 },
      { name: 'Large',  liquidityUSD: 5_000_000 },
      { name: 'XLarge', liquidityUSD: 10_000_000 },
    ];

    this.priceCache = {};
    this.lastPriceUpdate = 0;
    this.coinGeckoIds = {
      WBTC: 'bitcoin', WETH: 'ethereum', USDC: 'usd-coin', USDT: 'tether', DAI: 'dai',
    };

    console.log('🔧 Dynamic Shard Manager initialized (Solana)');
    console.log(`   Wallet: ${this.keypair.publicKey.toBase58()}`);
    console.log(`   TPS scaling: ${this.PER_SHARD_TPS} TPS/shard`);
    console.log(`   Check interval: ${this.checkInterval / 1000}s`);
  }

  // ── Price feed ─────────────────────────────────────────────────
  async fetchPrices() {
    const now = Date.now();
    if (now - this.lastPriceUpdate < 60_000 && Object.keys(this.priceCache).length > 0) {
      return this.priceCache;
    }
    try {
      const ids  = Object.values(this.coinGeckoIds).join(',');
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
      );
      if (resp.ok) {
        const data = await resp.json();
        for (const [sym, id] of Object.entries(this.coinGeckoIds)) {
          if (data[id]?.usd) this.priceCache[sym] = data[id].usd;
        }
        this.lastPriceUpdate = now;
      }
    } catch { /* use deployment prices */ }
    for (const [sym, d] of Object.entries(this.deployment.tokens)) {
      if (!this.priceCache[sym]) this.priceCache[sym] = d.price;
    }
    return this.priceCache;
  }

  // ── Shard analytics ────────────────────────────────────────────
  async getShardUtilization(shardAddress, tokenASymbol, tokenBSymbol) {
    try {
      const r  = await this.adapter.getReserves(shardAddress);
      const tA = this.deployment.tokens[tokenASymbol];
      const tB = this.deployment.tokens[tokenBSymbol];
      if (!tA || !tB) return null;

      const decA = tA.decimals ?? 6;
      const decB = tB.decimals ?? 6;
      const isAFirst = r.mintA.toBase58() === tA.mint;
      const resA = isAFirst ? Number(r.reserveA) / 10 ** decA : Number(r.reserveB) / 10 ** decA;
      const resB = isAFirst ? Number(r.reserveB) / 10 ** decB : Number(r.reserveA) / 10 ** decB;

      const prices = await this.fetchPrices();
      const priceA = prices[tokenASymbol] || 1;
      const priceB = prices[tokenBSymbol] || 1;

      const tvlUSD    = resA * priceA + resB * priceB;
      const maxSwapUSD = Math.min(resA * this.C_THRESHOLD * priceA, resB * this.C_THRESHOLD * priceB);
      const valueA  = resA * priceA;
      const valueB  = resB * priceB;
      const imbalance = tvlUSD > 0 ? Math.abs(valueA - valueB) / tvlUSD : 0;

      return { address: shardAddress, reserveA: resA, reserveB: resB,
               tvlUSD, maxSwapUSD, imbalance, isHealthy: imbalance < 0.3 && tvlUSD > 100 };
    } catch { return null; }
  }

  async analyzeAllShards() {
    const analysis = {};
    for (const [pair, shards] of Object.entries(this.deployment.pools)) {
      if (!shards.length) { analysis[pair] = []; continue; }
      const [tA, tB] = pair.split('-');
      const pairAnalysis = [];
      for (let i = 0; i < shards.length; i++) {
        const util = await this.getShardUtilization(shards[i].address, tA, tB);
        if (util) pairAnalysis.push({ ...util, name: shards[i].name, originalLiquidityUSD: shards[i].liquidityUSD });
        if (i < shards.length - 1) await new Promise(r => setTimeout(r, 150));
      }
      pairAnalysis.sort((a, b) => a.tvlUSD - b.tvlUSD);
      analysis[pair] = pairAnalysis;
    }
    return analysis;
  }

  // ── TPS (approximate via getSignaturesForAddress) ──────────────
  async measurePairTPS(pair, shardAddresses) {
    try {
      const { PublicKey } = require('@solana/web3.js');
      const WINDOW_SIGS  = 100;

      let totalSwaps = 0;
      let oldestSlot = Infinity;

      for (const addr of shardAddresses) {
        const sigs = await this.connection.getSignaturesForAddress(
          new PublicKey(addr),
          { limit: WINDOW_SIGS },
        );
        totalSwaps += sigs.length;
        if (sigs.length > 0) {
          const s = sigs[sigs.length - 1].slot;
          if (s < oldestSlot) oldestSlot = s;
        }
      }

      if (totalSwaps === 0) return { tps: 0, swapCount: 0, windowSeconds: this.TPS_WINDOW_SECONDS, perShard: {} };

      // Estimate slot time ≈ 0.4s on devnet (conservative: 0.5s)
      const latestSlot = await this.connection.getSlot();
      const slotDiff   = latestSlot - (oldestSlot === Infinity ? latestSlot : oldestSlot);
      const windowSec  = Math.max(slotDiff * 0.5, 1);
      const tps = totalSwaps / windowSec;

      return { tps, swapCount: totalSwaps, windowSeconds: windowSec, perShard: {} };
    } catch {
      return { tps: 0, swapCount: 0, windowSeconds: this.TPS_WINDOW_SECONDS, perShard: {} };
    }
  }

  getOptimalShardCount(tps) {
    if (tps < 1) return 1;
    return Math.min(Math.max(1, Math.ceil(tps / this.PER_SHARD_TPS)), this.MAX_SHARDS_PER_PAIR);
  }

  // ── Decision logic (same thresholds as EVM version) ───────────
  needsNewShard(pair, shardAnalysis) {
    if (shardAnalysis.length >= this.MAX_SHARDS_PER_PAIR) return null;
    const deployedCount = (this.deployment.pools[pair] || []).length;
    if (shardAnalysis.length === 0 && deployedCount > 0) return null;
    if (shardAnalysis.length === 0) return { tier: this.SHARD_TIERS[1], reason: 'No shards exist' };

    const alive = shardAnalysis.filter(s => s.tvlUSD > 10_000);
    if (alive.length === 0) return { tier: this.SHARD_TIERS[0], reason: 'All shards below $10k' };

    const largest = shardAnalysis[shardAnalysis.length - 1];
    if (largest.maxSwapUSD < 5_000 && shardAnalysis.length < 5) {
      const next = this.SHARD_TIERS.find(t => t.liquidityUSD > largest.tvlUSD * 2);
      if (next) return { tier: next, reason: `Largest max-swap only $${Math.round(largest.maxSwapUSD)}` };
    }
    return null;
  }

  findMergeOpportunity(_pair, shardAnalysis) {
    if (shardAnalysis.length < 2) return null;
    const sorted  = [...shardAnalysis].sort((a, b) => a.tvlUSD - b.tvlUSD);
    const smallest = sorted[0];
    const target   = sorted[1];
    if (smallest.tvlUSD > 10_000 || target.tvlUSD < smallest.tvlUSD) return null;
    return { source: smallest, target, reason: `Dead shard ${smallest.name} at $${Math.round(smallest.tvlUSD)}` };
  }

  findSplitOpportunity(_pair, shardAnalysis) {
    if (!shardAnalysis.length || shardAnalysis.length >= this.MAX_SHARDS_PER_PAIR) return null;
    const largest = shardAnalysis[shardAnalysis.length - 1];
    if (largest.tvlUSD < this.SPLIT_LIQUIDITY_THRESHOLD) return null;
    return { source: largest, splitPercent: shardAnalysis.length === 1 ? 50 : 35,
             reason: `Oversized shard $${Math.round(largest.tvlUSD).toLocaleString()}` };
  }

  // ── Soft-deactivation: mark dead shards inactive in deployment JSON ───────
  // On Solana the program has no close instruction, so we can't delete pool
  // accounts on-chain.  Instead, mark shards as { inactive: true } in the
  // deployment file so the router skips them when quoting.
  deactivateShard(pair, shardAddress, reason) {
    const shards = this.deployment.pools[pair];
    if (!shards) return false;
    const shard = shards.find(s => s.address === shardAddress);
    if (!shard || shard.inactive) return false;
    shard.inactive = true;
    shard.deactivatedAt = new Date().toISOString();
    shard.deactivationReason = reason;
    // Persist to deployment JSON so the router picks it up on next load
    try {
      fs.writeFileSync(this.deploymentPath, JSON.stringify(this.deployment, null, 2));
      console.log(`   🔴 Deactivated shard ${shard.name} (${pair}): ${reason}`);
      return true;
    } catch (e) {
      console.error(`   ⚠️  Failed to persist deactivation: ${e.message}`);
      return false;
    }
  }

  // Reactivate a previously deactivated shard
  reactivateShard(pair, shardAddress) {
    const shards = this.deployment.pools[pair];
    if (!shards) return false;
    const shard = shards.find(s => s.address === shardAddress);
    if (!shard || !shard.inactive) return false;
    // Never reactivate pools flagged with a bad-price reason — TVL recovery doesn't fix bad init
    if (shard.permanentlyInactive) return false;
    delete shard.inactive;
    delete shard.deactivatedAt;
    delete shard.deactivationReason;
    try {
      fs.writeFileSync(this.deploymentPath, JSON.stringify(this.deployment, null, 2));
      console.log(`   🟢 Reactivated shard ${shard.name} (${pair})`);
      return true;
    } catch (e) {
      console.error(`   ⚠️  Failed to persist reactivation: ${e.message}`);
      return false;
    }
  }

  // ── (Stubbed) on-chain shard creation ──────────────────────────
  async createNewShard(_pair, _tier) {
    if (process.env.ENABLE_AUTO_SHARD_CREATE !== 'true') {
      console.log(`   ℹ️  Auto-shard creation disabled (set ENABLE_AUTO_SHARD_CREATE=true to enable)`);
      return null;
    }
    console.log(`   ⚠️  createNewShard: not yet implemented for Solana (requires initialize instruction)`);
    return null;
  }

  // ── Main cycle ─────────────────────────────────────────────────
  async checkAndManageShards() {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      await this.fetchPrices();
      console.log(`\n${'='.repeat(70)}`);
      console.log(`🔧 Dynamic Shard Manager — Check Cycle`);
      console.log(`${'='.repeat(70)}`);

      const analysis = await this.analyzeAllShards();
      let totalShards = 0, totalTVL = 0;

      for (const [pair, shardAnalysis] of Object.entries(analysis)) {
        const deployedCount = (this.deployment.pools[pair] || []).length;
        if (shardAnalysis.length === 0 && deployedCount > 0) {
          console.log(`\n   ${pair}: ⚠️  RPC errors — ${deployedCount} deployed but 0 analyzed. Skipping.`);
          totalShards += deployedCount;
          continue;
        }

        totalShards += shardAnalysis.length;
        const pairTVL = shardAnalysis.reduce((s, x) => s + x.tvlUSD, 0);
        totalTVL += pairTVL;

        // TPS measurement
        const shardAddrs = (this.deployment.pools[pair] || []).map(s => s.address);
        const tpsMeasure = await this.measurePairTPS(pair, shardAddrs);
        const optimal    = this.getOptimalShardCount(tpsMeasure.tps);
        this._pairTPS[pair] = tpsMeasure;

        const tpsLabel = tpsMeasure.tps >= 0.01
          ? `TPS: ${tpsMeasure.tps.toFixed(2)} (${tpsMeasure.swapCount} swaps/${Math.round(tpsMeasure.windowSeconds)}s)`
          : 'TPS: idle';

        console.log(`\n   ${pair}: ${shardAnalysis.length} shards → target ${optimal}, ${tpsLabel}, TVL: $${Math.round(pairTVL).toLocaleString()}`);
        for (const s of shardAnalysis) {
          const depShard = (this.deployment.pools[pair] || []).find(d => d.address === s.address);
          const isInactive = depShard?.inactive;
          const h = isInactive ? '🔴' : s.isHealthy ? '✅' : '⚠️';
          console.log(`      ${h} ${s.name}: $${Math.round(s.tvlUSD).toLocaleString()} TVL, max-swap: $${Math.round(s.maxSwapUSD)}, imbalance: ${(s.imbalance * 100).toFixed(1)}%${isInactive ? ' [INACTIVE]' : ''}`);
        }

        // Soft-deactivate dead shards (TVL < $100 and not the only shard for the pair)
        const activeAnalysis = shardAnalysis.filter(s => {
          const dep = (this.deployment.pools[pair] || []).find(d => d.address === s.address);
          return !dep?.inactive;
        });
        if (activeAnalysis.length > 1) {
          for (const s of activeAnalysis) {
            if (s.tvlUSD < 100) {
              this.deactivateShard(pair, s.address, `TVL $${Math.round(s.tvlUSD)} below $100 threshold`);
            }
          }
        }

        // Reactivate shards that have recovered (TVL > $1000)
        const inactiveShards = (this.deployment.pools[pair] || []).filter(d => d.inactive);
        for (const dep of inactiveShards) {
          const recovered = shardAnalysis.find(s => s.address === dep.address && s.tvlUSD > 1000);
          if (recovered) {
            this.reactivateShard(pair, dep.address);
          }
        }

        // New shard needed?
        const needed = this.needsNewShard(pair, shardAnalysis);
        if (needed) {
          console.log(`      📌 ${needed.reason}`);
          await this.createNewShard(pair, needed.tier);
        }

        const split = this.findSplitOpportunity(pair, shardAnalysis);
        if (split) console.log(`      ℹ️  Split candidate: ${split.reason}`);

        const merge = this.findMergeOpportunity(pair, shardAnalysis);
        if (merge) console.log(`      ℹ️  Merge candidate: ${merge.reason}`);
      }

      console.log(`\n   📊 Total: ${totalShards} shards, $${Math.round(totalTVL).toLocaleString()} TVL`);
      const tpsSummary = Object.entries(this._pairTPS)
        .map(([p, d]) => `${p}:${d.tps.toFixed(2)}`).join(' | ');
      if (tpsSummary) console.log(`   ⚡ TPS: ${tpsSummary}`);
      if (this.txQueue) {
        const qs = this.txQueue.getStats();
        console.log(`   📡 TxQueue: sent=${qs.sent} confirmed=${qs.confirmed} failed=${qs.failed}`);
      }
      console.log(`${'='.repeat(70)}\n`);
    } catch (err) {
      console.error(`❌ Shard Manager cycle error: ${err.message?.slice(0, 120)}`);
    } finally {
      this.isChecking = false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`\n✅ Dynamic Shard Manager started — checking every ${this.checkInterval / 1000}s\n`);
    this.intervalId = setInterval(
      () => this.checkAndManageShards().catch(e => console.error('Shard cycle error:', e.message?.slice(0, 80))),
      this.checkInterval,
    );
    try { await this.checkAndManageShards(); }
    catch (e) { console.error('Shard manager first cycle (non-fatal):', e.message?.slice(0, 80)); }
  }

  stop() {
    if (!this.isRunning) return;
    clearInterval(this.intervalId);
    this.isRunning = false;
    console.log('\n🛑 Dynamic Shard Manager stopped');
  }

  getStatus() {
    const totalShards = Object.values(this.deployment.pools).reduce((s, a) => s + a.length, 0);
    return {
      running: this.isRunning,
      wallet: this.keypair.publicKey.toBase58(),
      checkInterval: this.checkInterval,
      totalShards,
      totalPairs: Object.keys(this.deployment.pools).length,
      prices: this.priceCache,
      tpsConfig: { perShardCapacity: this.PER_SHARD_TPS, windowSeconds: this.TPS_WINDOW_SECONDS },
      pairTPS: this._pairTPS,
      txQueue: this.txQueue?.getStats() || null,
    };
  }
}

// CLI entry point
if (require.main === module) {
  const { Connection, Keypair } = require('@solana/web3.js');
  const bs58 = require('bs58');
  const TxQueue = require('./tx-queue');

  const deploymentFile = process.env.DEPLOYMENT_FILE || 'solana-devnet.json';
  const privateKeyB58  = process.env.SOLANA_PRIVATE_KEY;
  const rpcUrl         = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const programId      = process.env.SOLANA_PROGRAM_ID || '';

  if (!privateKeyB58) { console.error('❌ SOLANA_PRIVATE_KEY not set'); process.exit(1); }

  const connection = new Connection(rpcUrl, 'confirmed');
  const keypair    = Keypair.fromSecretKey(bs58.decode(privateKeyB58));
  const txQueue    = new TxQueue(connection, keypair);
  const manager    = new DynamicShardManager(deploymentFile, keypair, connection, txQueue, programId);

  manager.start().catch(console.error);
  process.on('SIGINT', () => { manager.stop(); process.exit(0); });
}

module.exports = DynamicShardManager;
