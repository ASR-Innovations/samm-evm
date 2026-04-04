const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { ChainlinkPriceOracle } = require('./integrations/chainlink-price');

class ArbitrageBot {
  constructor(deploymentFile, privateKey, rpcUrl, txQueue) {
    this.deploymentPath = path.join(__dirname, 'deployment-data', deploymentFile);
    this.deployment = JSON.parse(fs.readFileSync(this.deploymentPath, 'utf8'));
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.txQueue = txQueue; // shared nonce-managed queue

    this.tokens = {};
    this.pools = new Map();
    this.isRunning = false;
    this.isScanning = false;
    this.checkInterval = parseInt(process.env.ARB_CHECK_INTERVAL || '30000');
    this.priceCache = {};
    this.lastPriceUpdate = 0;
    this.priceUpdateInterval = 60000;

    // ── Sizing parameters ──
    this.C_THRESHOLD = 0.0096;          // 0.96% of output reserve = max swap
    this.SAFETY_MARGIN = 0.90;          // use 90% of c-limit
    this.MIN_DEVIATION_PCT = 0.30;      // ignore deviations ≤ trade fee (prevents oscillation)
    this.TARGET_REBALANCE_PCT = 0.50;   // close 50% of gap (prevents overshoot)

    // Approved shard addresses (skip redundant approve txs)
    this._approved = new Set();

    // Cooldown: prevent re-swapping same shard too soon (prevents ping-pong)
    this._shardCooldown = new Map();    // shard address → last swap cycle #
    this.COOLDOWN_CYCLES = 3;           // skip shard for N cycles after a swap

    this.coinGeckoIds = {
      'WBTC': 'bitcoin', 'WETH': 'ethereum', 'USDC': 'usd-coin',
      'USDT': 'tether', 'DAI': 'dai', 'LINK': 'chainlink',
      'UNI': 'uniswap', 'AAVE': 'aave'
    };

    // ── Chainlink Oracle (primary, decentralized) ──
    this.chainlinkOracle = new ChainlinkPriceOracle(process.env.SEPOLIA_RPC_URL);
    this.oracleSource = 'none'; // tracks which oracle was used last

    // Cumulative stats
    this.stats = { cycles: 0, swaps: 0, totalUSD: 0, failures: 0 };

    // Swap history (last 1000 entries)
    this.history = [];
    this.MAX_HISTORY = 1000;

    console.log('🤖 Arbitrage Bot initialized');
    console.log(`   Wallet: ${this.wallet.address}`);
    console.log(`   c-threshold: ${(this.C_THRESHOLD * 100).toFixed(4)}% (safety ${(this.SAFETY_MARGIN * 100).toFixed(0)}%)`);
    console.log(`   Min deviation: ${this.MIN_DEVIATION_PCT}%`);
    console.log(`   Target rebalance: ${(this.TARGET_REBALANCE_PCT * 100).toFixed(0)}% of gap`);
    console.log(`   Cooldown: ${this.COOLDOWN_CYCLES} cycles between swaps per shard`);
    console.log(`   Check interval: ${this.checkInterval}ms`);
  }

  // ── Price feed (Chainlink primary, CoinGecko fallback) ──
  async fetchRealPrices() {
    const now = Date.now();
    if (now - this.lastPriceUpdate < this.priceUpdateInterval && Object.keys(this.priceCache).length > 0) {
      return this.priceCache;
    }

    // ── TRY 1: Chainlink (decentralized, on-chain) ──
    if (this.chainlinkOracle.enabled) {
      try {
        const chainlinkPrices = await this.chainlinkOracle.getPriceMap();
        if (Object.keys(chainlinkPrices).length >= 3) {
          for (const [symbol, price] of Object.entries(chainlinkPrices)) {
            this.priceCache[symbol] = price;
          }
          this.lastPriceUpdate = now;
          this.oracleSource = 'chainlink';
          console.log('✅ Chainlink prices updated (decentralized oracle)');
          // Still fill any missing tokens from deployment defaults
          for (const [symbol, data] of Object.entries(this.deployment.contracts.tokens)) {
            if (!this.priceCache[symbol]) this.priceCache[symbol] = data.price;
          }
          return this.priceCache;
        }
      } catch (err) {
        console.log(`⚠️  Chainlink failed, falling back to CoinGecko: ${err.message?.slice(0, 60)}`);
      }
    }

    // ── TRY 2: CoinGecko (centralized fallback) ──
    try {
      const ids = Object.values(this.coinGeckoIds).join(',');
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
      );
      if (response.ok) {
        const data = await response.json();
        for (const [symbol, geckoId] of Object.entries(this.coinGeckoIds)) {
          if (data[geckoId]?.usd) this.priceCache[symbol] = data[geckoId].usd;
        }
        this.lastPriceUpdate = now;
        this.oracleSource = 'coingecko';
        console.log('✅ CoinGecko prices updated (centralized fallback)');
      }
    } catch {
      console.log('⚠️  CoinGecko failed, using cached prices');
    }

    // Fall back to deployment prices
    for (const [symbol, data] of Object.entries(this.deployment.contracts.tokens)) {
      if (!this.priceCache[symbol]) this.priceCache[symbol] = data.price;
    }

    return this.priceCache;
  }

  // ── Contract loading ───────────────────────────────────────
  async initialize() {
    console.log('\n📡 Loading contracts...');
    await this.fetchRealPrices();

    for (const [symbol, data] of Object.entries(this.deployment.contracts.tokens)) {
      this.tokens[symbol] = {
        address: data.address,
        decimals: data.decimals,
        oraclePrice: this.priceCache[symbol] || data.price,
        contract: new ethers.Contract(
          data.address,
          [
            'function approve(address,uint256) external returns (bool)',
            'function balanceOf(address) view returns (uint256)',
            'function allowance(address,address) view returns (uint256)'
          ],
          this.wallet
        )
      };
    }

    for (const [pair, shards] of Object.entries(this.deployment.contracts.shards)) {
      for (const shard of shards) {
        const pool = new ethers.Contract(
          shard.address,
          [
            'function getReserves() view returns (uint256,uint256)',
            'function tokenA() view returns (address)',
            'function tokenB() view returns (address)',
            'function calculateSwapSAMM(uint256,address,address) view returns (tuple(uint256 amountIn,uint256 amountOut,uint256 tradeFee,uint256 ownerFee))',
            'function swapSAMM(uint256,uint256,address,address,address) external returns (uint256)'
          ],
          this.wallet
        );

        this.pools.set(shard.address, {
          contract: pool,
          address: shard.address,
          name: shard.name,
          pair,
          liquidityUSD: shard.liquidityUSD,
          _tokenAAddr: null // lazily cached
        });
      }
    }

    console.log(`   ✅ Loaded ${Object.keys(this.tokens).length} tokens, ${this.pools.size} pools`);
  }

  // ── Pool state ─────────────────────────────────────────────
  async getPoolData(poolAddress, tokenASymbol, tokenBSymbol) {
    const poolEntry = this.pools.get(poolAddress);
    if (!poolEntry) return null;

    const tokenA = this.tokens[tokenASymbol];
    const tokenB = this.tokens[tokenBSymbol];
    if (!tokenA || !tokenB) return null;

    try {
      const [reserveA, reserveB] = await poolEntry.contract.getReserves();

      // Cache tokenA address (one-time RPC call per pool)
      if (!poolEntry._tokenAAddr) {
        poolEntry._tokenAAddr = await poolEntry.contract.tokenA();
      }
      const poolTokenA = poolEntry._tokenAAddr;

      let tokenAReserve, tokenBReserve;
      if (poolTokenA.toLowerCase() === tokenA.address.toLowerCase()) {
        tokenAReserve = parseFloat(ethers.formatUnits(reserveA, tokenA.decimals));
        tokenBReserve = parseFloat(ethers.formatUnits(reserveB, tokenB.decimals));
      } else {
        tokenAReserve = parseFloat(ethers.formatUnits(reserveB, tokenA.decimals));
        tokenBReserve = parseFloat(ethers.formatUnits(reserveA, tokenB.decimals));
      }

      if (tokenAReserve === 0 || tokenBReserve === 0) return null;

      return {
        price: tokenBReserve / tokenAReserve,
        tokenAReserve,
        tokenBReserve,
        tvlUSD: tokenAReserve * tokenA.oraclePrice + tokenBReserve * tokenB.oraclePrice
      };
    } catch {
      return null;
    }
  }

  // ── Imbalance scanner ──────────────────────────────────────
  async findImbalances() {
    const imbalances = [];

    for (const [pair, shards] of Object.entries(this.deployment.contracts.shards)) {
      const [tokenASymbol, tokenBSymbol] = pair.split('-');
      const tokenA = this.tokens[tokenASymbol];
      const tokenB = this.tokens[tokenBSymbol];
      if (!tokenA || !tokenB) continue;

      // Refresh oracle prices
      tokenA.oraclePrice = this.priceCache[tokenASymbol] || tokenA.oraclePrice;
      tokenB.oraclePrice = this.priceCache[tokenBSymbol] || tokenB.oraclePrice;

      const targetPrice = tokenA.oraclePrice / tokenB.oraclePrice;

      for (const shard of shards) {
        const poolData = await this.getPoolData(shard.address, tokenASymbol, tokenBSymbol);
        if (!poolData) continue;

        const deviation = ((poolData.price - targetPrice) / targetPrice) * 100;

        if (Math.abs(deviation) > this.MIN_DEVIATION_PCT) {
          imbalances.push({
            pair, tokenASymbol, tokenBSymbol,
            shard: shard.address,
            shardName: shard.name,
            currentPrice: poolData.price,
            targetPrice,
            deviation,
            liquidityUSD: poolData.tvlUSD,
            tokenAReserve: poolData.tokenAReserve,
            tokenBReserve: poolData.tokenBReserve,
          });
        }
      }
    }

    return imbalances;
  }

  // ── Swap sizing ────────────────────────────────────────────
  /**
   * Compute optimal swap amount in USD.
   *
   * To move price by δ% in a constant-product pool you need to swap
   * roughly δ × outputReserve tokens. We aim to close 70% of the gap
   * in one shot, capped at the c-threshold safety margin.
   */
  computeSwapUSD(imbalance) {
    const { tokenASymbol, tokenBSymbol, deviation, tokenAReserve, tokenBReserve } = imbalance;
    const tokenA = this.tokens[tokenASymbol];
    const tokenB = this.tokens[tokenBSymbol];
    const absDev = Math.abs(deviation) / 100; // fraction

    let outputReserveUSD;
    if (deviation > 0) {
      outputReserveUSD = tokenBReserve * tokenB.oraclePrice;
    } else {
      outputReserveUSD = tokenAReserve * tokenA.oraclePrice;
    }

    // Ideal: close 70% of the gap
    const idealUSD = absDev * this.TARGET_REBALANCE_PCT * outputReserveUSD;

    // Hard cap: c-threshold × safety
    const maxUSD = outputReserveUSD * this.C_THRESHOLD * this.SAFETY_MARGIN;

    // Floor: $20 (below this gas isn't worth it)
    return Math.max(20, Math.min(idealUSD, maxUSD));
  }

  // ── Approve helper (once per shard per token) ──────────────
  async ensureApproval(tokenContract, tokenSymbol, spender) {
    const key = `${tokenSymbol}:${spender}`;
    if (this._approved.has(key)) return;

    const result = await this.txQueue.send(
      (nonce) => tokenContract.approve(spender, ethers.MaxUint256, { nonce, gasLimit: 100_000 }),
      `approve ${tokenSymbol} → ${spender.slice(0, 10)}…`
    );
    if (result.success) this._approved.add(key);
  }

  // ── Execute a single rebalance ─────────────────────────────
  async rebalanceShard(imbalance) {
    const { tokenASymbol, tokenBSymbol, shard, shardName, deviation, pair,
            currentPrice, targetPrice, tokenAReserve, tokenBReserve, liquidityUSD } = imbalance;
    const tokenA = this.tokens[tokenASymbol];
    const tokenB = this.tokens[tokenBSymbol];
    const pool = this.pools.get(shard).contract;

    const swapUSD = this.computeSwapUSD(imbalance);
    let tokenInSym, tokenOutSym, tokenIn, tokenOut;

    try {
      if (deviation > 0) {
        // Price too high → sell tokenA to buy tokenB → pushes price down
        tokenIn = tokenA; tokenOut = tokenB;
        tokenInSym = tokenASymbol; tokenOutSym = tokenBSymbol;
      } else {
        // Price too low → sell tokenB to buy tokenA → pushes price up
        tokenIn = tokenB; tokenOut = tokenA;
        tokenInSym = tokenBSymbol; tokenOutSym = tokenASymbol;
      }

      const swapAmountOut = swapUSD / tokenOut.oraclePrice;
      const amountOut = ethers.parseUnits(
        swapAmountOut.toFixed(Math.min(tokenOut.decimals, 8)),
        tokenOut.decimals
      );

      const quote = await pool.calculateSwapSAMM(amountOut, tokenIn.address, tokenOut.address);
      const amtInFloat = parseFloat(ethers.formatUnits(quote.amountIn, tokenIn.decimals));
      const amtOutFloat = parseFloat(ethers.formatUnits(amountOut, tokenOut.decimals));
      const totalFee = parseFloat(ethers.formatUnits(quote.tradeFee + quote.ownerFee, tokenIn.decimals));
      const feePct = (totalFee / amtInFloat) * 100;

      // ── PRE-SWAP detail ──
      console.log(`\n   ┌─ ${shardName} (${pair}) ─────────────────────────────────`);
      console.log(`   │ Spot price:   ${currentPrice.toFixed(6)} ${tokenBSymbol}/${tokenASymbol}`);
      console.log(`   │ Oracle price: ${targetPrice.toFixed(6)} ${tokenBSymbol}/${tokenASymbol}`);
      console.log(`   │ Deviation:    ${deviation > 0 ? '+' : ''}${deviation.toFixed(3)}%`);
      console.log(`   │ TVL: $${Math.round(liquidityUSD).toLocaleString()} | ${tokenAReserve.toFixed(4)} ${tokenASymbol} + ${tokenBReserve.toFixed(2)} ${tokenBSymbol}`);
      console.log(`   │ Action: sell ${amtInFloat.toFixed(6)} ${tokenInSym} → buy ${amtOutFloat.toFixed(6)} ${tokenOutSym} ($${swapUSD.toFixed(0)}) fee=${feePct.toFixed(3)}%`);

      const balance = await tokenIn.contract.balanceOf(this.wallet.address);
      if (balance < quote.amountIn) {
        const balF = ethers.formatUnits(balance, tokenIn.decimals);
        console.log(`   │ ❌ Insufficient ${tokenInSym}: have ${balF}, need ${amtInFloat.toFixed(6)}`);
        console.log(`   └────────────────────────────────────────────────────`);
        return { success: false, error: `Insufficient ${tokenInSym}` };
      }

      await this.ensureApproval(tokenIn.contract, tokenInSym, shard);

      const maxIn = (quote.amountIn * 120n) / 100n;
      const result = await this.txQueue.send(
        (nonce) => pool.swapSAMM(
          amountOut, maxIn,
          tokenIn.address, tokenOut.address,
          this.wallet.address,
          { nonce, gasLimit: 300_000 }
        ),
        `arb ${shardName} ${tokenInSym}→${tokenOutSym}`
      );

      if (result.success) {
        this.stats.swaps++;
        this.stats.totalUSD += swapUSD;
        this._shardCooldown.set(shard, this.stats.cycles);

        // ── POST-SWAP: re-read spot price ──
        let postSpotStr = '?', postDevStr = '?', postSpotNum = null, postDevNum = null;
        try {
          const postData = await this.getPoolData(shard, tokenASymbol, tokenBSymbol);
          if (postData) {
            postSpotNum = postData.price;
            postSpotStr = postData.price.toFixed(6);
            postDevNum = ((postData.price - targetPrice) / targetPrice) * 100;
            postDevStr = `${postDevNum > 0 ? '+' : ''}${postDevNum.toFixed(3)}%`;
          }
        } catch { /* non-critical */ }

        const devReduction = Math.abs(deviation) - Math.abs(postDevNum || 0);
        console.log(`   │ ✅ Post-swap: spot=${postSpotStr} dev=${postDevStr} (reduced by ${devReduction.toFixed(3)}%)`);
        console.log(`   │ 🔗 tx: ${result.txHash}`);
        console.log(`   │    gas: ${result.receipt?.gasUsed?.toString() || '?'}`);
        console.log(`   └────────────────────────────────────────────────────`);

        this._recordSwap({
          timestamp: new Date().toISOString(),
          cycle: this.stats.cycles, pair, shard: shardName,
          direction: `${tokenInSym}→${tokenOutSym}`,
          amountIn: amtInFloat, amountOut: amtOutFloat,
          amountUSD: parseFloat(swapUSD.toFixed(2)),
          preSpotPrice: currentPrice, postSpotPrice: postSpotNum,
          oraclePrice: targetPrice,
          preDeviation: parseFloat(deviation.toFixed(4)),
          postDeviation: postDevNum !== null ? parseFloat(postDevNum.toFixed(4)) : null,
          feePct: parseFloat(feePct.toFixed(4)),
          txHash: result.txHash,
          gasUsed: result.receipt?.gasUsed?.toString() || null,
          status: 'success'
        });
      } else {
        this.stats.failures++;
        console.log(`   │ ❌ Failed: ${result.error}`);
        console.log(`   └────────────────────────────────────────────────────`);
        this._recordSwap({
          timestamp: new Date().toISOString(),
          cycle: this.stats.cycles, pair, shard: shardName,
          direction: `${tokenInSym}→${tokenOutSym}`,
          amountUSD: parseFloat(swapUSD.toFixed(2)),
          preDeviation: parseFloat(deviation.toFixed(4)),
          txHash: null, status: 'failed', error: result.error
        });
      }
      return result;
    } catch (error) {
      this.stats.failures++;
      const msg = error.message?.slice(0, 80) || 'unknown';
      console.log(`   │ ❌ Error: ${msg}`);
      console.log(`   └────────────────────────────────────────────────────`);
      this._recordSwap({
        timestamp: new Date().toISOString(),
        cycle: this.stats.cycles, pair, shard: shardName,
        direction: tokenInSym ? `${tokenInSym}→${tokenOutSym}` : '?',
        amountUSD: parseFloat(swapUSD.toFixed(2)),
        preDeviation: parseFloat(deviation.toFixed(4)),
        txHash: null, status: 'error', error: msg
      });
      return { success: false, error: msg };
    }
  }

  // ── Main cycle ─────────────────────────────────────────────
  async checkAndRebalance() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      await this.fetchRealPrices();
      this.stats.cycles++;

      console.log(`\n${'═'.repeat(70)}`);
      console.log(`🔍 Arb Bot — Cycle #${this.stats.cycles}`);
      console.log(`${'═'.repeat(70)}`);

      const imbalances = await this.findImbalances();

      if (imbalances.length === 0) {
        console.log(`✅ All pools within tolerance (±${this.MIN_DEVIATION_PCT}%)`);
        console.log(`${'═'.repeat(70)}\n`);
        return;
      }

      imbalances.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

      // Summary of deviations by pair
      const byPair = {};
      for (const imb of imbalances) {
        if (!byPair[imb.pair]) byPair[imb.pair] = [];
        byPair[imb.pair].push(imb);
      }
      console.log(`📋 ${imbalances.length} pools deviated across ${Object.keys(byPair).length} pairs:`);
      for (const [p, imbs] of Object.entries(byPair)) {
        const devs = imbs.map(i => `${i.shardName.replace(p + '-', '')}:${i.deviation > 0 ? '+' : ''}${i.deviation.toFixed(2)}%`);
        console.log(`   ${p}: ${devs.join(', ')}`);
      }

      let rebalanced = 0, failed = 0, skipped = 0;
      for (const imbalance of imbalances) {
        // ── Cooldown check ──
        const lastCycle = this._shardCooldown.get(imbalance.shard);
        if (lastCycle && (this.stats.cycles - lastCycle) < this.COOLDOWN_CYCLES) {
          const wait = this.COOLDOWN_CYCLES - (this.stats.cycles - lastCycle);
          console.log(`   ⏳ ${imbalance.shardName}: cooldown (${wait} cycles left, dev=${imbalance.deviation > 0 ? '+' : ''}${imbalance.deviation.toFixed(2)}%)`);
          skipped++;
          continue;
        }

        const result = await this.rebalanceShard(imbalance);
        result.success ? rebalanced++ : failed++;
      }

      console.log(`\n📊 Cycle #${this.stats.cycles}: ${rebalanced} swapped, ${failed} failed, ${skipped} cooled-down`);
      console.log(`   Cumulative: ${this.stats.swaps} swaps, $${Math.round(this.stats.totalUSD).toLocaleString()} vol, ${this.stats.failures} failures`);
      console.log(`${'═'.repeat(70)}\n`);
    } catch (error) {
      console.error(`❌ Arb cycle error (non-fatal): ${error.message?.slice(0, 120)}`);
    } finally {
      this.isScanning = false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────
  async start() {
    if (this.isRunning) return;
    await this.initialize();
    this.isRunning = true;
    console.log(`\n✅ Arb Bot started — every ${this.checkInterval / 1000}s\n`);

    await this.checkAndRebalance();

    this.intervalId = setInterval(
      () => this.checkAndRebalance().catch((e) => console.error('Arb cycle error:', e.message?.slice(0, 80))),
      this.checkInterval
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
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }
  }

  getHistory(limit = 50, filter = {}) {
    let h = [...this.history].reverse(); // newest first
    if (filter.pair) h = h.filter(e => e.pair === filter.pair);
    if (filter.status) h = h.filter(e => e.status === filter.status);
    return h.slice(0, limit);
  }

  getStatus() {
    return {
      running: this.isRunning,
      wallet: this.wallet.address,
      checkInterval: this.checkInterval,
      poolsMonitored: this.pools.size,
      tokensMonitored: Object.keys(this.tokens).length,
      oracleSource: this.oracleSource,
      chainlinkEnabled: this.chainlinkOracle.enabled,
      prices: this.priceCache,
      stats: this.stats,
      recentSwaps: this.history.slice(-5).reverse(),
      txQueue: this.txQueue?.getStats() || null
    };
  }
}

module.exports = ArbitrageBot;
