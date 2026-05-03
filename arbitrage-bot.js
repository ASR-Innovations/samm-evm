'use strict';
/**
 * Arbitrage Bot — Solana edition
 *
 * Monitors SAMM pool shards, detects price deviations from oracle, and
 * rebalances them by executing swaps.  Same rebalancing logic as the EVM
 * version; chain-specific code replaced with Solana adapter calls.
 */

const fs   = require('fs');
const path = require('path');
const SolanaAdapter = require('./solana-adapter');

class ArbitrageBot {
  /**
   * @param {string}  deploymentFile  — filename inside deployment-data/
   * @param {import('@solana/web3.js').Keypair} keypair
   * @param {import('@solana/web3.js').Connection} connection
   * @param {import('./tx-queue')} txQueue — shared serial queue
   * @param {string}  programId — base58 token-swap program ID
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
    this.isScanning = false;
    this.checkInterval = parseInt(process.env.ARB_CHECK_INTERVAL || '30000');
    this.priceCache = {};
    this.lastPriceUpdate = 0;
    this.priceUpdateInterval = 60_000;

    // ── Sizing parameters ──
    this.C_THRESHOLD       = 0.0096;
    this.SAFETY_MARGIN     = 0.90;
    this.MIN_DEVIATION_PCT = 0.30;
    this.TARGET_REBALANCE_PCT = 0.50;
    // Hard cap per swap in USD — prevents runaway rebalances on badly-imbalanced pools
    this.MAX_SWAP_USD = parseFloat(process.env.MAX_SWAP_USD || '500');

    this._approved   = new Set();
    this._shardCooldown = new Map();
    this.COOLDOWN_CYCLES = 3;

    this.coinGeckoIds = {
      WBTC: 'bitcoin', WETH: 'ethereum', USDC: 'usd-coin',
      USDT: 'tether',  DAI:  'dai',
    };

    this.stats   = { cycles: 0, swaps: 0, totalUSD: 0, failures: 0 };
    this.history = [];
    this.MAX_HISTORY = 1000;

    console.log('🤖 Arbitrage Bot initialized (Solana)');
    console.log(`   Wallet: ${this.keypair.publicKey.toBase58()}`);
    console.log(`   c-threshold: ${(this.C_THRESHOLD * 100).toFixed(4)}%  min-dev: ${this.MIN_DEVIATION_PCT}%`);
    console.log(`   Check interval: ${this.checkInterval}ms`);
  }

  // ── Price feed ─────────────────────────────────────────────────
  async fetchPrices() {
    const now = Date.now();
    if (now - this.lastPriceUpdate < this.priceUpdateInterval && Object.keys(this.priceCache).length > 0) {
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
    } catch { /* use cached */ }

    for (const [sym, d] of Object.entries(this.deployment.tokens)) {
      if (!this.priceCache[sym]) this.priceCache[sym] = d.price;
    }
    return this.priceCache;
  }

  // ── Pool state ─────────────────────────────────────────────────
  async getPoolData(poolAddress, tokenASymbol, tokenBSymbol) {
    try {
      const r = await this.adapter.getReserves(poolAddress);
      const tA = this.deployment.tokens[tokenASymbol];
      const tB = this.deployment.tokens[tokenBSymbol];
      if (!tA || !tB) return null;

      const decA = tA.decimals ?? 6;
      const decB = tB.decimals ?? 6;

      const isAFirst = r.mintA.toBase58() === tA.mint;
      const tokenAReserve = isAFirst ? Number(r.reserveA) / 10 ** decA : Number(r.reserveB) / 10 ** decA;
      const tokenBReserve = isAFirst ? Number(r.reserveB) / 10 ** decB : Number(r.reserveA) / 10 ** decB;

      if (tokenAReserve === 0 || tokenBReserve === 0) return null;

      const priceA = this.priceCache[tokenASymbol] || 1;
      const priceB = this.priceCache[tokenBSymbol] || 1;

      return {
        price: tokenBReserve / tokenAReserve,
        tokenAReserve,
        tokenBReserve,
        tvlUSD: tokenAReserve * priceA + tokenBReserve * priceB,
      };
    } catch { return null; }
  }

  // ── Imbalance scanner ──────────────────────────────────────────
  async findImbalances() {
    const imbalances = [];
    for (const [pair, shards] of Object.entries(this.deployment.pools)) {
      if (!shards.length) continue;
      const [tokenASymbol, tokenBSymbol] = pair.split('-');
      const priceA = this.priceCache[tokenASymbol] || 1;
      const priceB = this.priceCache[tokenBSymbol] || 1;
      const targetPrice = priceA / priceB;

      for (const shard of shards) {
        const poolData = await this.getPoolData(shard.address, tokenASymbol, tokenBSymbol);
        if (!poolData) continue;
        const deviation = ((poolData.price - targetPrice) / targetPrice) * 100;
        if (Math.abs(deviation) > this.MIN_DEVIATION_PCT) {
          imbalances.push({
            pair, tokenASymbol, tokenBSymbol,
            shard: shard.address, shardName: shard.name,
            currentPrice: poolData.price, targetPrice, deviation,
            liquidityUSD: poolData.tvlUSD,
            tokenAReserve: poolData.tokenAReserve,
            tokenBReserve: poolData.tokenBReserve,
          });
        }
      }
    }
    return imbalances;
  }

  // ── Swap sizing (unchanged) ────────────────────────────────────
  computeSwapUSD(imbalance) {
    const { tokenASymbol, tokenBSymbol, deviation, tokenAReserve, tokenBReserve } = imbalance;
    const priceA = this.priceCache[tokenASymbol] || 1;
    const priceB = this.priceCache[tokenBSymbol] || 1;
    const absDev = Math.abs(deviation) / 100;
    const outputReserveUSD = deviation > 0
      ? tokenBReserve * priceB
      : tokenAReserve * priceA;
    const idealUSD = absDev * this.TARGET_REBALANCE_PCT * outputReserveUSD;
    const maxUSD   = outputReserveUSD * this.C_THRESHOLD * this.SAFETY_MARGIN;
    return Math.max(20, Math.min(idealUSD, maxUSD, this.MAX_SWAP_USD));
  }

  // ── Execute a single rebalance ─────────────────────────────────
  async rebalanceShard(imbalance) {
    const { tokenASymbol, tokenBSymbol, shard, shardName, deviation,
            pair, currentPrice, targetPrice, tokenAReserve, tokenBReserve, liquidityUSD } = imbalance;
    const tA = this.deployment.tokens[tokenASymbol];
    const tB = this.deployment.tokens[tokenBSymbol];

    let tokenInSym, tokenOutSym, tokenInMint, tokenOutMint, tokenOutDec;

    try {
      if (deviation > 0) {
        tokenInSym  = tokenASymbol; tokenOutSym  = tokenBSymbol;
        tokenInMint = tA.mint;      tokenOutMint = tB.mint;
        tokenOutDec = tB.decimals ?? 6;
      } else {
        tokenInSym  = tokenBSymbol; tokenOutSym  = tokenASymbol;
        tokenInMint = tB.mint;      tokenOutMint = tA.mint;
        tokenOutDec = tA.decimals ?? 6;
      }

      const swapUSD     = this.computeSwapUSD(imbalance);
      const outPrice    = this.priceCache[tokenOutSym] || 1;
      const amtOutFloat = swapUSD / outPrice;
      const rawOut      = BigInt(Math.round(amtOutFloat * 10 ** tokenOutDec));

      console.log(`\n   ┌─ ${shardName} (${pair}) ────────────────────────────────────`);
      console.log(`   │ Spot: ${currentPrice.toFixed(6)}  Oracle: ${targetPrice.toFixed(6)}  Dev: ${deviation > 0 ? '+' : ''}${deviation.toFixed(3)}%`);
      console.log(`   │ TVL: $${Math.round(liquidityUSD).toLocaleString()} | Action: sell ${tokenInSym} → buy ${tokenOutSym} ($${swapUSD.toFixed(0)})`);

      // Quote
      const q = await this.adapter.calculateSwapSAMM(rawOut, tokenInMint, tokenOutMint, shard);
      const maxIn = (q.amountIn * 120n) / 100n;

      // Pre-flight: check wallet balance covers maxIn
      const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
      const { PublicKey } = require('@solana/web3.js');
      const { getTokenBalance } = require('./solana-client');
      const inMintPk = new PublicKey(tokenInMint);
      const userInATA = getAssociatedTokenAddressSync(inMintPk, this.keypair.publicKey);
      const walletBal = await getTokenBalance(this.connection, userInATA).catch(() => ({ amount: 0n }));
      if (walletBal.amount < maxIn) {
        const dec = this.deployment.tokens[tokenInSym]?.decimals ?? 6;
        const needed = Number(maxIn) / 10 ** dec;
        const have = Number(walletBal.amount) / 10 ** dec;
        console.log(`   │ ⚠️  Insufficient ${tokenInSym}: need ${needed.toFixed(4)}, have ${have.toFixed(4)} — skipping`);
        console.log(`   └────────────────────────────────────────────────────`);
        this.stats.failures++;
        this._recordSwap({ timestamp: new Date().toISOString(), cycle: this.stats.cycles,
          pair, shard: shardName, direction: `${tokenInSym}→${tokenOutSym}`,
          amountUSD: parseFloat(swapUSD.toFixed(2)), preDeviation: parseFloat(deviation.toFixed(4)),
          txHash: null, status: 'skipped', error: `insufficient ${tokenInSym}` });
        return { success: false, error: `insufficient ${tokenInSym}` };
      }

      // Execute directly — executeSwap handles its own blockhash + confirm
      const { executeSwap } = require('./solana-client');
      let result;
      try {
        const sig = await executeSwap(
          this.connection, this.keypair, this.programId,
          shard, tokenInMint, tokenOutMint,
          rawOut,  // exact amount out desired
          maxIn,   // maximum amount in allowed
        );
        result = { success: true, txHash: sig };
      } catch (execErr) {
        result = { success: false, error: execErr.message?.slice(0, 120) || 'swap failed' };
      }

      if (result.success) {
        this.stats.swaps++;
        this.stats.totalUSD += swapUSD;
        this._shardCooldown.set(shard, this.stats.cycles);

        let postSpotStr = '?', postDevStr = '?', postDevNum = null;
        try {
          const post = await this.getPoolData(shard, tokenASymbol, tokenBSymbol);
          if (post) {
            postDevNum = ((post.price - targetPrice) / targetPrice) * 100;
            postSpotStr = post.price.toFixed(6);
            postDevStr  = `${postDevNum > 0 ? '+' : ''}${postDevNum.toFixed(3)}%`;
          }
        } catch { /* non-critical */ }

        console.log(`   │ ✅ Post-swap: spot=${postSpotStr} dev=${postDevStr}`);
        console.log(`   │ 🔗 tx: ${result.txHash}`);
        console.log(`   └────────────────────────────────────────────────────`);
        this._recordSwap({ timestamp: new Date().toISOString(), cycle: this.stats.cycles,
          pair, shard: shardName, direction: `${tokenInSym}→${tokenOutSym}`,
          amountIn: Number(q.amountIn), amountOut: Number(rawOut), amountUSD: parseFloat(swapUSD.toFixed(2)),
          preSpotPrice: currentPrice, oraclePrice: targetPrice,
          preDeviation: parseFloat(deviation.toFixed(4)),
          postDeviation: postDevNum !== null ? parseFloat(postDevNum.toFixed(4)) : null,
          txHash: result.txHash, status: 'success' });
      } else {
        this.stats.failures++;
        console.log(`   │ ❌ Failed: ${result.error}`);
        console.log(`   └────────────────────────────────────────────────────`);
        this._recordSwap({ timestamp: new Date().toISOString(), cycle: this.stats.cycles,
          pair, shard: shardName, direction: `${tokenInSym}→${tokenOutSym}`,
          amountUSD: parseFloat(swapUSD.toFixed(2)),
          preDeviation: parseFloat(deviation.toFixed(4)),
          txHash: null, status: 'failed', error: result.error });
      }
      return result;
    } catch (err) {
      this.stats.failures++;
      const msg = err.message?.slice(0, 80) || 'unknown';
      console.log(`   │ ❌ Error: ${msg}`);
      console.log(`   └────────────────────────────────────────────────────`);
      this._recordSwap({ timestamp: new Date().toISOString(), cycle: this.stats.cycles,
        pair, shard: shardName, direction: `${tokenInSym || '?'}→${tokenOutSym || '?'}`,
        amountUSD: 0, preDeviation: parseFloat(deviation.toFixed(4)),
        txHash: null, status: 'error', error: msg });
      return { success: false, error: msg };
    }
  }

  // ── Main cycle ─────────────────────────────────────────────────
  async checkAndRebalance() {
    if (this.isScanning) return;
    this.isScanning = true;
    try {
      await this.fetchPrices();
      this.stats.cycles++;

      console.log(`\n${'═'.repeat(70)}`);
      console.log(`🔍 Arb Bot — Cycle #${this.stats.cycles}`);
      console.log(`${'═'.repeat(70)}`);

      const imbalances = await this.findImbalances();
      if (!imbalances.length) {
        console.log(`✅ All pools within tolerance (±${this.MIN_DEVIATION_PCT}%)`);
        console.log(`${'═'.repeat(70)}\n`);
        return;
      }

      imbalances.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
      console.log(`📋 ${imbalances.length} pools deviated`);

      let rebalanced = 0, failed = 0, skipped = 0;
      for (const imb of imbalances) {
        const last = this._shardCooldown.get(imb.shard);
        if (last && (this.stats.cycles - last) < this.COOLDOWN_CYCLES) {
          skipped++;
          continue;
        }
        const r = await this.rebalanceShard(imb);
        r.success ? rebalanced++ : failed++;
      }

      console.log(`\n📊 Cycle #${this.stats.cycles}: ${rebalanced} swapped, ${failed} failed, ${skipped} cooled`);
      console.log(`   Cumulative: ${this.stats.swaps} swaps, $${Math.round(this.stats.totalUSD).toLocaleString()} vol`);
      console.log(`${'═'.repeat(70)}\n`);
    } catch (err) {
      console.error(`❌ Arb cycle error: ${err.message?.slice(0, 120)}`);
    } finally {
      this.isScanning = false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────
  async start() {
    if (this.isRunning) return;
    await this.fetchPrices();
    this.isRunning = true;
    console.log(`\n✅ Arb Bot started — every ${this.checkInterval / 1000}s\n`);
    await this.checkAndRebalance();
    this.intervalId = setInterval(
      () => this.checkAndRebalance().catch(e => console.error('Arb cycle error:', e.message?.slice(0, 80))),
      this.checkInterval,
    );
  }

  stop() {
    if (!this.isRunning) return;
    clearInterval(this.intervalId);
    this.isRunning = false;
    console.log('\n🛑 Arb Bot stopped');
  }

  _recordSwap(entry) {
    this.history.push(entry);
    if (this.history.length > this.MAX_HISTORY) this.history = this.history.slice(-this.MAX_HISTORY);
  }

  getHistory(limit = 50, filter = {}) {
    let h = [...this.history].reverse();
    if (filter.pair)   h = h.filter(e => e.pair === filter.pair);
    if (filter.status) h = h.filter(e => e.status === filter.status);
    return h.slice(0, limit);
  }

  getStatus() {
    return {
      running: this.isRunning,
      wallet: this.keypair.publicKey.toBase58(),
      checkInterval: this.checkInterval,
      poolsMonitored: Object.values(this.deployment.pools).reduce((s, a) => s + a.length, 0),
      prices: this.priceCache,
      stats: this.stats,
      recentSwaps: this.history.slice(-5).reverse(),
      txQueue: this.txQueue?.getStats() || null,
    };
  }
}

module.exports = ArbitrageBot;
