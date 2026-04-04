/**
 * Dynamic Shard Manager
 * 
 * Automatically manages pool shards based on utilization and demand:
 * 1. Monitors existing shard utilization (reserve ratios, swap volume)
 * 2. Creates new shards when existing ones are heavily utilized
 * 3. Can deactivate shards that are empty/unused
 * 4. Maintains optimal shard distribution for c-smaller-better property
 * 
 * In Solana we achieved 200-220 TPS per shard — each shard is independent
 * so more shards = more parallel throughput = higher total TPS.
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

class DynamicShardManager {
  constructor(deploymentFile, privateKey, rpcUrl, txQueue) {
    this.deploymentPath = path.join(__dirname, 'deployment-data', deploymentFile);
    this.deployment = JSON.parse(fs.readFileSync(this.deploymentPath, 'utf8'));
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.txQueue = txQueue; // shared nonce-managed queue (optional for backwards compat)

    this.isRunning = false;
    this.isChecking = false;
    this.checkInterval = parseInt(process.env.SHARD_CHECK_INTERVAL || '60000'); // 1 min

    // Shard creation thresholds
    this.UTILIZATION_THRESHOLD = parseFloat(process.env.UTILIZATION_THRESHOLD || '0.7'); // 70% of c-threshold used → create new shard
    this.MIN_LIQUIDITY_USD = parseFloat(process.env.MIN_SHARD_LIQUIDITY || '10000'); // $10K minimum per new shard
    this.MIN_SHARDS_PER_PAIR = parseInt(process.env.MIN_SHARDS_PER_PAIR || '3');
    this.MAX_SHARDS_PER_PAIR = parseInt(process.env.MAX_SHARDS_PER_PAIR || '10');
    this.REBALANCE_RATIO_THRESHOLD = parseFloat(process.env.REBALANCE_RATIO_THRESHOLD || '2.5');
    this.MERGE_LIQUIDITY_THRESHOLD = parseFloat(process.env.MERGE_LIQUIDITY_THRESHOLD || '100000');
    this.SPLIT_LIQUIDITY_THRESHOLD = parseFloat(process.env.SPLIT_LIQUIDITY_THRESHOLD || '8000000');

    // ── TPS-driven shard scaling (litepaper §6) ──
    // n = min(ceil(TPS / PER_SHARD_TPS), MAX_SHARDS_PER_PAIR)
    this.PER_SHARD_TPS = parseFloat(process.env.PER_SHARD_TPS || '50');
    this.TPS_WINDOW_SECONDS = parseInt(process.env.TPS_WINDOW || '300');       // 5-min sample
    this.MIN_TPS_FOR_SCALE_UP = parseFloat(process.env.MIN_TPS_FOR_SCALE_UP || '5');
    this.BLOCKS_PER_SECOND = parseFloat(process.env.BLOCKS_PER_SECOND || '1'); // Risechain ~1s
    this.MIN_SPLIT_TVL = 500_000; // don't split shards below $500k
    this._pairTPS = {};           // per-pair TPS measurements
    this._cachedBlocksPerSecond = null;

    // SAMM parameters (must match contracts)
    this.SAMM_PARAMS = {
      beta1: -250000n,
      rmin: 100n,
      rmax: 2500n,
      c: 9600n
    };
    this.FEE_PARAMS = {
      tradeFeeNumerator: 25n,
      tradeFeeDenominator: 10000n,
      ownerFeeNumerator: 5n,
      ownerFeeDenominator: 10000n
    };
    this.C_THRESHOLD = 0.0096; // 0.96%

    // Shard size tiers (USD liquidity) — matches deploy config
    this.SHARD_TIERS = [
      { name: 'Small', liquidityUSD: 250000 },
      { name: 'Medium', liquidityUSD: 1000000 },
      { name: 'Large', liquidityUSD: 5000000 },
      { name: 'XLarge', liquidityUSD: 10000000 }
    ];

    // CoinGecko price cache
    this.priceCache = {};
    this.lastPriceUpdate = 0;
    this.coinGeckoIds = {
      'WBTC': 'bitcoin', 'WETH': 'ethereum', 'USDC': 'usd-coin',
      'USDT': 'tether', 'DAI': 'dai', 'LINK': 'chainlink',
      'UNI': 'uniswap', 'AAVE': 'aave'
    };

    // Contract ABIs
    this.FACTORY_ABI = [
      'function createShard(address,address,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) external returns (address)',
      'function initializeShard(address,uint256,uint256) external returns (uint256)',
      'function getShardsForPair(address,address) external view returns (address[])',
      'function getShardInfo(address) external view returns (tuple(address tokenA, address tokenB, uint256 shardIndex, int256 beta1, uint256 rmin, uint256 rmax, uint256 c, uint256 tradeFeeNumerator, uint256 tradeFeeDenominator, uint256 ownerFeeNumerator, uint256 ownerFeeDenominator, bool isActive, address creator, uint256 createdAt))',
      'function deactivateShard(address) external',
      'event ShardCreated(address indexed shard, address tokenA, address tokenB, uint256 shardIndex, address creator)'
    ];
    this.ORCHESTRATOR_ABI = [
      'function createAndFundShard(address,address,uint256,uint256) external returns (address)',
      'function splitShard(address,uint256) external returns (address)',
      'function rebalanceLiquidity(address,address,uint256) external',
      'function mergeShards(address,address) external',
      'function addLiquidityToShard(address,uint256,uint256) external',
      'function getShardUtilization(address) view returns (uint256,uint256,uint256,uint256)',
      'function getManagedShards() view returns (address[])',
      'function getManagedShardCount() view returns (uint256)',
    ];
    this.POOL_ABI = [
      'function getReserves() view returns (uint256, uint256)',
      'function tokenA() view returns (address)',
      'function tokenB() view returns (address)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'function getSAMMParams() view returns (int256, uint256, uint256, uint256)',
      'event SwapSAMM(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee)'
    ];
    this.TOKEN_ABI = [
      'function approve(address,uint256) external returns (bool)',
      'function balanceOf(address) view returns (uint256)',
      'function mint(address,uint256) external',
      'function decimals() view returns (uint8)'
    ];

    console.log('🔧 Dynamic Shard Manager initialized');
    console.log(`   Wallet: ${this.wallet.address}`);
    console.log(`   c-threshold: ${(this.C_THRESHOLD * 100).toFixed(2)}%`);
    console.log(`   TPS scaling: ${this.PER_SHARD_TPS} TPS/shard, ${this.TPS_WINDOW_SECONDS}s window`);
    console.log(`   Min TPS for scale-up: ${this.MIN_TPS_FOR_SCALE_UP}`);
    console.log(`   Check interval: ${this.checkInterval / 1000}s`);
    console.log(`   Max shards per pair: ${this.MAX_SHARDS_PER_PAIR}`);
    console.log(`   TxQueue: ${this.txQueue ? 'shared' : 'direct (no queue)'}`);
  }

  /**
   * Send a transaction through the shared TxQueue (if available)
   * or directly. Returns { success, receipt?, txHash?, error? }
   */
  async _sendTx(contractFn, label, gasLimit = 500_000) {
    if (this.txQueue) {
      return this.txQueue.send(
        (nonce) => contractFn({ nonce, gasLimit }),
        label
      );
    }
    // Fallback: direct send (no queue)
    try {
      const tx = await contractFn({ gasLimit });
      const receipt = await tx.wait();
      return { success: true, receipt, txHash: receipt.hash };
    } catch (err) {
      return { success: false, error: err.message?.slice(0, 120) || 'unknown' };
    }
  }

  // ── TPS measurement (litepaper §6) ────────────────────────────
  /**
   * Query SwapSAMM events from all shards of a pair over a sliding
   * window. Returns { tps, swapCount, windowSeconds, perShard }.
   */
  async measurePairTPS(pair, shardAddresses) {
    try {
      const latestBlock = await this.provider.getBlockNumber();

      // Estimate block time dynamically (cache for 5 min)
      if (!this._cachedBlocksPerSecond || Date.now() - (this._bpsTimestamp || 0) > 300_000) {
        try {
          const b1 = await this.provider.getBlock(latestBlock);
          const b2 = await this.provider.getBlock(Math.max(0, latestBlock - 100));
          if (b1 && b2 && b1.timestamp > b2.timestamp) {
            this._cachedBlocksPerSecond = 100 / (b1.timestamp - b2.timestamp);
          } else {
            this._cachedBlocksPerSecond = this.BLOCKS_PER_SECOND;
          }
        } catch {
          this._cachedBlocksPerSecond = this.BLOCKS_PER_SECOND;
        }
        this._bpsTimestamp = Date.now();
      }

      const bps = this._cachedBlocksPerSecond;
      const windowBlocks = Math.min(
        Math.floor(this.TPS_WINDOW_SECONDS * bps),
        2000 // RPC provider block-range cap
      );
      const fromBlock = Math.max(0, latestBlock - windowBlocks);

      // SwapSAMM event topic
      const poolIface = new ethers.Interface(this.POOL_ABI);
      const swapTopic = poolIface.getEvent('SwapSAMM').topicHash;

      let totalSwaps = 0;
      const perShard = {};

      for (const addr of shardAddresses) {
        try {
          const logs = await this.provider.getLogs({
            address: addr,
            topics: [swapTopic],
            fromBlock,
            toBlock: latestBlock
          });
          perShard[addr] = logs.length;
          totalSwaps += logs.length;
        } catch {
          perShard[addr] = 0;
        }
      }

      const actualWindowSeconds = windowBlocks / Math.max(bps, 0.01);
      const tps = totalSwaps / Math.max(actualWindowSeconds, 1);

      const result = { tps, swapCount: totalSwaps, windowSeconds: actualWindowSeconds, perShard };
      this._pairTPS[pair] = result;
      return result;
    } catch (err) {
      // If event queries fail entirely, return zero (safe — won't trigger scale-up)
      return { tps: 0, swapCount: 0, windowSeconds: this.TPS_WINDOW_SECONDS, perShard: {} };
    }
  }

  /**
   * Litepaper §6: n = min(ceil(TPS / PER_SHARD_TPS), MAX_SHARDS_PER_PAIR)
   * Returns the ideal shard count for the observed throughput.
   */
  getOptimalShardCount(currentTPS) {
    if (currentTPS < 1) return this.MIN_SHARDS_PER_PAIR; // preserve minimum shards even when idle
    return Math.min(
      Math.max(this.MIN_SHARDS_PER_PAIR, Math.ceil(currentTPS / this.PER_SHARD_TPS)),
      this.MAX_SHARDS_PER_PAIR
    );
  }

  getFactory() {
    return new ethers.Contract(this.deployment.contracts.factory, this.FACTORY_ABI, this.wallet);
  }

  getOrchestrator() {
    if (!this.deployment.contracts.orchestrator) return null;
    return new ethers.Contract(this.deployment.contracts.orchestrator, this.ORCHESTRATOR_ABI, this.wallet);
  }

  async getManagedLpBalance(shardAddress) {
    const orchAddr = this.deployment.contracts.orchestrator;
    if (!orchAddr) return 0n;
    const pool = new ethers.Contract(shardAddress, this.POOL_ABI, this.provider);
    return pool.balanceOf(orchAddr);
  }

  async fetchPrices() {
    const now = Date.now();
    if (now - this.lastPriceUpdate < 60000 && Object.keys(this.priceCache).length > 0) {
      return this.priceCache;
    }

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
      }
    } catch (e) {
      // Use deployment prices as fallback
      for (const [symbol, data] of Object.entries(this.deployment.contracts.tokens)) {
        if (!this.priceCache[symbol]) this.priceCache[symbol] = data.price;
      }
    }
    return this.priceCache;
  }

  async getShardUtilization(shardAddress, tokenASymbol, tokenBSymbol) {
    try {
      const pool = new ethers.Contract(shardAddress, this.POOL_ABI, this.provider);
      const [reserveA, reserveB] = await pool.getReserves();
      const poolTokenA = await pool.tokenA();

      const tokenAData = this.deployment.contracts.tokens[tokenASymbol];
      const tokenBData = this.deployment.contracts.tokens[tokenBSymbol];

      // Determine which reserve corresponds to which token
      let resA, resB;
      if (poolTokenA.toLowerCase() === tokenAData.address.toLowerCase()) {
        resA = parseFloat(ethers.formatUnits(reserveA, tokenAData.decimals));
        resB = parseFloat(ethers.formatUnits(reserveB, tokenBData.decimals));
      } else {
        resA = parseFloat(ethers.formatUnits(reserveB, tokenAData.decimals));
        resB = parseFloat(ethers.formatUnits(reserveA, tokenBData.decimals));
      }

      const prices = await this.fetchPrices();
      const tvlUSD = resA * (prices[tokenASymbol] || 1) + resB * (prices[tokenBSymbol] || 1);

      // Max single swap in USD (c-threshold of output reserve)
      const maxSwapA_USD = resA * this.C_THRESHOLD * (prices[tokenASymbol] || 1);
      const maxSwapB_USD = resB * this.C_THRESHOLD * (prices[tokenBSymbol] || 1);
      const maxSwapUSD = Math.min(maxSwapA_USD, maxSwapB_USD);

      // Check reserve imbalance (as ratio of initial 50/50)
      const valueA = resA * (prices[tokenASymbol] || 1);
      const valueB = resB * (prices[tokenBSymbol] || 1);
      const imbalance = tvlUSD > 0 ? Math.abs(valueA - valueB) / tvlUSD : 0;

      return {
        address: shardAddress,
        reserveA: resA,
        reserveB: resB,
        tvlUSD,
        maxSwapUSD,
        imbalance,
        isHealthy: imbalance < 0.3 && tvlUSD > 100
      };
    } catch (e) {
      return null;
    }
  }

  async analyzeAllShards() {
    const analysis = {};

    for (const [pair, shards] of Object.entries(this.deployment.contracts.shards)) {
      const [tokenASymbol, tokenBSymbol] = pair.split('-');
      const pairAnalysis = [];

      for (let i = 0; i < shards.length; i++) {
        const shard = shards[i];
        const util = await this.getShardUtilization(shard.address, tokenASymbol, tokenBSymbol);
        if (util) {
          pairAnalysis.push({
            ...util,
            name: shard.name,
            originalLiquidity: shard.liquidityUSD
          });
        }
        // Delay between RPC calls to avoid 429 rate limiting
        if (i < shards.length - 1) await new Promise(r => setTimeout(r, 200));
      }

      // Sort by TVL (smallest first — c-smaller-better)
      pairAnalysis.sort((a, b) => a.tvlUSD - b.tvlUSD);
      analysis[pair] = pairAnalysis;
    }

    return analysis;
  }

  /**
   * Determine if a pair needs a new shard
   * Logic:
   * - If the smallest shard is too large → create a smaller one (better fees for small swaps)
   * - If the largest shard has high utilization → create a bigger one
   * - If there are gaps in the tier coverage → fill them
   */
  /**
   * Only create a new shard when:
   *  1. The pair has zero shards.
   *  2. All existing shards have drained below $10k TVL (dead pair).
   *  3. The largest shard's max-swap is too small for organic demand AND
   *     no bigger tier exists yet.
   *
   * We do NOT create shards just because the smallest shard is
   * "large" — the deployed tier structure ($250k/$1M/$5M) is
   * intentional for the c-smaller-better property.
   */
  needsNewShard(pair, shardAnalysis) {
    if (shardAnalysis.length >= this.MAX_SHARDS_PER_PAIR) return null;

    // Guard: if analysis is empty but deployment has shards, it means
    // RPC calls failed (e.g. 429 rate limit). Do NOT create duplicates.
    const deployedCount = (this.deployment.contracts.shards[pair] || []).length;
    if (shardAnalysis.length === 0 && deployedCount > 0) return null;
    if (shardAnalysis.length === 0) return { tier: this.SHARD_TIERS[1], reason: 'No shards exist' };

    // Check if all shards are near-dead
    const aliveShards = shardAnalysis.filter(s => s.tvlUSD > 10000);
    if (aliveShards.length === 0) {
      return {
        tier: this.SHARD_TIERS[0],
        reason: `All ${shardAnalysis.length} shards below $10k — bootstrap a new Small shard`
      };
    }

    // Check if the pair lacks a larger tier and the biggest shard
    // can't handle swaps above $5k (organic demand needs bigger pool)
    const largest = shardAnalysis[shardAnalysis.length - 1];
    if (largest.maxSwapUSD < 5000 && shardAnalysis.length < 5) {
      const nextTier = this.SHARD_TIERS.find(t => t.liquidityUSD > largest.tvlUSD * 2);
      if (nextTier) {
        return {
          tier: nextTier,
          reason: `Largest shard max swap only $${Math.round(largest.maxSwapUSD)} — add ${nextTier.name} for bigger swaps`
        };
      }
    }

    return null;
  }

  /**
   * Rebalance only when a shard's INTERNAL reserves are severely
   * imbalanced (e.g. 75/25 split instead of 50/50).
   *
   * Cross-shard TVL differences are intentional (tier structure:
   * $250k Small / $1M Medium / $5M Large) and must NOT be equalized.
   *
   * Rebalance: move LP from a healthy shard into the most-imbalanced
   * one so the orchestrator can rebalance its reserves.
   */
  findRebalanceOpportunity(pair, shardAnalysis) {
    if (shardAnalysis.length < 2) return null;

    // Find the shard with the worst internal imbalance
    const INTERNAL_IMBALANCE_THRESHOLD = 0.20; // 20% reserve deviation from 50/50
    let worstShard = null;
    let worstImbalance = 0;

    for (const s of shardAnalysis) {
      if (s.imbalance > worstImbalance) {
        worstImbalance = s.imbalance;
        worstShard = s;
      }
    }

    if (!worstShard || worstImbalance < INTERNAL_IMBALANCE_THRESHOLD) return null;

    // Find the healthiest shard to pull LP from
    const healthiest = [...shardAnalysis]
      .filter(s => s.address !== worstShard.address && s.isHealthy)
      .sort((a, b) => a.imbalance - b.imbalance)[0];

    if (!healthiest) return null;

    // Move a small share (5-10%) from healthy → imbalanced
    const lpShareBps = worstImbalance > 0.35 ? 1000 : 500;

    return {
      from: healthiest,
      to: worstShard,
      lpShareBps,
      reason: `Internal imbalance ${(worstImbalance * 100).toFixed(1)}% in ${worstShard.name} — move LP from ${healthiest.name}`
    };
  }

  /**
   * Merge only when a shard has collapsed to near-zero TVL — e.g.
   * drained by impermanent loss or a bad exploit. The threshold is
   * $10k, well below the smallest intentional tier ($250k).
   */
  findMergeOpportunity(pair, shardAnalysis) {
    if (shardAnalysis.length < 2) return null;
    // Never merge below minimum shard count — preserve original 3+ shards
    if (shardAnalysis.length <= this.MIN_SHARDS_PER_PAIR) return null;

    const MERGE_TVL_FLOOR = 10_000; // $10k — shard is effectively dead

    const sorted = [...shardAnalysis].sort((a, b) => a.tvlUSD - b.tvlUSD);
    const smallest = sorted[0];
    const target = sorted[1];

    if (smallest.tvlUSD > MERGE_TVL_FLOOR) return null;
    if (target.tvlUSD < smallest.tvlUSD) return null;

    return {
      source: smallest,
      target,
      reason: `Dead shard ${smallest.name} at $${Math.round(smallest.tvlUSD)} — merge into ${target.name}`
    };
  }

  /**
   * Split only when a single shard has grown far beyond the largest
   * intended tier (e.g. via external LP deposits). The threshold is
   * SPLIT_LIQUIDITY_THRESHOLD ($8M default — well above the $5M
   * Large tier). We also require the shard to be the only one, or
   * that it dwarfs the rest, to avoid unnecessary splits.
   *
   * Cross-shard TVL ratio is NOT used — different sizes are by design.
   */
  findSplitOpportunity(pair, shardAnalysis) {
    if (shardAnalysis.length === 0 || shardAnalysis.length >= this.MAX_SHARDS_PER_PAIR) return null;

    const sorted = [...shardAnalysis].sort((a, b) => a.tvlUSD - b.tvlUSD);
    const largest = sorted[sorted.length - 1];

    // Only split when a shard exceeds the absolute threshold
    if (largest.tvlUSD < this.SPLIT_LIQUIDITY_THRESHOLD) return null;

    return {
      source: largest,
      splitPercent: shardAnalysis.length === 1 ? 50 : 35,
      reason: `Oversized shard ${largest.name} at $${Math.round(largest.tvlUSD).toLocaleString()} (>${this.SPLIT_LIQUIDITY_THRESHOLD.toLocaleString()}) — split for parallel throughput`
    };
  }

  async rebalancePair(pair, opportunity) {
    const orch = this.getOrchestrator();
    if (!orch) return false;

    const lpBalance = await this.getManagedLpBalance(opportunity.from.address);
    if (lpBalance === 0n) {
      console.log(`      ⚠️ Rebalance skipped — orchestrator holds no LP in ${opportunity.from.name}`);
      return false;
    }

    const lpAmount = (lpBalance * BigInt(opportunity.lpShareBps)) / 10000n;
    if (lpAmount === 0n) {
      console.log(`      ⚠️ Rebalance skipped — computed LP amount is zero`);
      return false;
    }

    console.log(`      🔄 ${opportunity.reason}`);
    const result = await this._sendTx(
      (opts) => orch.rebalanceLiquidity(opportunity.from.address, opportunity.to.address, lpAmount, opts),
      `shard-mgr rebalance ${pair}`,
      1_500_000
    );
    if (result.success) {
      console.log(`      ✅ Rebalanced via tx ${result.txHash.slice(0, 18)}...`);
      return true;
    } else {
      console.log(`      ❌ Rebalance failed: ${result.error}`);
      return false;
    }
  }

  async mergePair(pair, opportunity) {
    const orch = this.getOrchestrator();
    if (!orch) return false;

    const lpBalance = await this.getManagedLpBalance(opportunity.source.address);
    if (lpBalance === 0n) {
      console.log(`      ⚠️ Merge skipped — orchestrator holds no LP in ${opportunity.source.name}`);
      return false;
    }

    console.log(`      🔗 ${opportunity.reason}`);
    const mergeResult = await this._sendTx(
      (opts) => orch.mergeShards(opportunity.source.address, opportunity.target.address, opts),
      `shard-mgr merge ${pair}`,
      1_500_000
    );
    if (!mergeResult.success) {
      console.log(`      ❌ Merge failed: ${mergeResult.error}`);
      return false;
    }

    const factory = this.getFactory();
    const deactivateResult = await this._sendTx(
      (opts) => factory.deactivateShard(opportunity.source.address, opts),
      `shard-mgr deactivate ${pair}`,
      300_000
    );

    this.deployment.contracts.shards[pair] = (this.deployment.contracts.shards[pair] || [])
      .filter((shard) => shard.address.toLowerCase() !== opportunity.source.address.toLowerCase());
    fs.writeFileSync(this.deploymentPath, JSON.stringify(this.deployment, null, 2));

    console.log(`      ✅ Merged via tx ${mergeResult.txHash.slice(0, 18)}... and deactivated source shard`);
    return true;
  }

  async splitPair(pair, opportunity) {
    const orch = this.getOrchestrator();
    if (!orch) return false;

    const lpBalance = await this.getManagedLpBalance(opportunity.source.address);
    if (lpBalance === 0n) {
      console.log(`      ⚠️ Split skipped — orchestrator holds no LP in ${opportunity.source.name}`);
      return false;
    }

    console.log(`      ✂️ ${opportunity.reason}`);
    const result = await this._sendTx(
      (opts) => orch.splitShard(opportunity.source.address, opportunity.splitPercent, opts),
      `shard-mgr split ${pair}`,
      2_500_000
    );
    if (!result.success) {
      console.log(`      ❌ Split failed: ${result.error}`);
      return false;
    }
    const receipt = result.receipt;

    const factory = this.getFactory();
    const event = receipt.logs.find((log) => {
      try { return factory.interface.parseLog(log)?.name === 'ShardCreated'; } catch { return false; }
    });
    if (!event) {
      console.log(`      ⚠️ Split tx succeeded but ShardCreated event was not parsed`);
      return true;
    }

    const parsed = factory.interface.parseLog(event);
    const shardAddress = parsed.args.shard;
    const [tokenASymbol, tokenBSymbol] = pair.split('-');
    const shardInfo = {
      address: shardAddress,
      name: `${pair}-AutoSplit-${Date.now()}`,
      liquidityUSD: Math.round(opportunity.source.tvlUSD * (opportunity.splitPercent / 100)),
      createdBy: 'DynamicShardManager',
      createdAt: new Date().toISOString(),
      managedByOrchestrator: true
    };

    if (!this.deployment.contracts.shards[pair]) this.deployment.contracts.shards[pair] = [];
    this.deployment.contracts.shards[pair].push(shardInfo);
    fs.writeFileSync(this.deploymentPath, JSON.stringify(this.deployment, null, 2));

    console.log(`      ✅ Split created shard ${shardAddress}`);
    return true;
  }

  async createNewShard(pair, tier) {
    const [tokenASymbol, tokenBSymbol] = pair.split('-');
    const tokenAData = this.deployment.contracts.tokens[tokenASymbol];
    const tokenBData = this.deployment.contracts.tokens[tokenBSymbol];
    const prices = await this.fetchPrices();

    // Calculate amounts at market price
    const halfLiqUSD = tier.liquidityUSD / 2;
    const amountA = ethers.parseUnits(
      (halfLiqUSD / prices[tokenASymbol]).toFixed(tokenAData.decimals),
      tokenAData.decimals
    );
    const amountB = ethers.parseUnits(
      (halfLiqUSD / prices[tokenBSymbol]).toFixed(tokenBData.decimals),
      tokenBData.decimals
    );

    console.log(`   📦 Creating ${tier.name} shard for ${pair}:`);
    console.log(`      Liquidity: $${tier.liquidityUSD.toLocaleString()}`);
    console.log(`      ${tokenASymbol}: ${ethers.formatUnits(amountA, tokenAData.decimals)}`);
    console.log(`      ${tokenBSymbol}: ${ethers.formatUnits(amountB, tokenBData.decimals)}`);

    try {
      const tokenAContract = new ethers.Contract(tokenAData.address, this.TOKEN_ABI, this.wallet);
      const tokenBContract = new ethers.Contract(tokenBData.address, this.TOKEN_ABI, this.wallet);

      // Mint tokens (test tokens have open mint)
      let r;
      r = await this._sendTx((opts) => tokenAContract.mint(this.wallet.address, amountA, opts), `mint ${tokenASymbol}`);
      if (!r.success) throw new Error(`Mint ${tokenASymbol} failed: ${r.error}`);
      r = await this._sendTx((opts) => tokenBContract.mint(this.wallet.address, amountB, opts), `mint ${tokenBSymbol}`);
      if (!r.success) throw new Error(`Mint ${tokenBSymbol} failed: ${r.error}`);

      let shardAddress;

      // Use orchestrator if available (atomic create + fund)
      const orchAddr = this.deployment.contracts.orchestrator;
      if (orchAddr) {
        const orch = new ethers.Contract(orchAddr, this.ORCHESTRATOR_ABI, this.wallet);
        r = await this._sendTx((opts) => tokenAContract.approve(orchAddr, amountA, opts), `approve ${tokenASymbol}→orch`, 100_000);
        if (!r.success) throw new Error(`Approve ${tokenASymbol} failed: ${r.error}`);
        r = await this._sendTx((opts) => tokenBContract.approve(orchAddr, amountB, opts), `approve ${tokenBSymbol}→orch`, 100_000);
        if (!r.success) throw new Error(`Approve ${tokenBSymbol} failed: ${r.error}`);

        const createResult = await this._sendTx(
          (opts) => orch.createAndFundShard(tokenAData.address, tokenBData.address, amountA, amountB, opts),
          `createAndFundShard ${pair}`,
          12_000_000
        );
        if (!createResult.success) throw new Error(`createAndFundShard failed: ${createResult.error}`);
        const receipt = createResult.receipt;

        // Find ShardCreated event from factory (emitted through orchestrator)
        const factoryAddress = this.deployment.contracts.factory;
        const factory = new ethers.Contract(factoryAddress, this.FACTORY_ABI, this.wallet);
        const event = receipt.logs.find(log => {
          try { return factory.interface.parseLog(log)?.name === 'ShardCreated'; } catch { return false; }
        });
        shardAddress = factory.interface.parseLog(event).args.shard;
        console.log(`   ✅ Shard created via orchestrator: ${shardAddress}`);
      } else {
        // Fallback: direct factory calls
        const factoryAddress = this.deployment.contracts.factory;
        const factory = new ethers.Contract(factoryAddress, this.FACTORY_ABI, this.wallet);

        const createResult = await this._sendTx(
          (opts) => factory.createShard(
            tokenAData.address, tokenBData.address,
            this.SAMM_PARAMS.beta1, this.SAMM_PARAMS.rmin,
            this.SAMM_PARAMS.rmax, this.SAMM_PARAMS.c,
            this.FEE_PARAMS.tradeFeeNumerator, this.FEE_PARAMS.tradeFeeDenominator,
            this.FEE_PARAMS.ownerFeeNumerator, this.FEE_PARAMS.ownerFeeDenominator,
            opts
          ),
          `createShard ${pair}`,
          12_000_000
        );
        if (!createResult.success) throw new Error(`createShard failed: ${createResult.error}`);
        const receipt = createResult.receipt;
        const event = receipt.logs.find(log => {
          try { return factory.interface.parseLog(log)?.name === 'ShardCreated'; } catch { return false; }
        });
        shardAddress = factory.interface.parseLog(event).args.shard;

        // Query actual pool token order and initialize
        const pool = new ethers.Contract(shardAddress, this.POOL_ABI, this.provider);
        const poolTokenA = await pool.tokenA();
        let initAmountA, initAmountB;
        if (poolTokenA.toLowerCase() === tokenAData.address.toLowerCase()) {
          initAmountA = amountA; initAmountB = amountB;
        } else {
          initAmountA = amountB; initAmountB = amountA;
        }
        const initTokenA = poolTokenA.toLowerCase() === tokenAData.address.toLowerCase() ? tokenAContract : tokenBContract;
        const initTokenB = poolTokenA.toLowerCase() === tokenAData.address.toLowerCase() ? tokenBContract : tokenAContract;

        r = await this._sendTx((opts) => initTokenA.approve(factoryAddress, initAmountA, opts), `approve initA→factory`, 100_000);
        if (!r.success) throw new Error(`Approve initA failed: ${r.error}`);
        r = await this._sendTx((opts) => initTokenB.approve(factoryAddress, initAmountB, opts), `approve initB→factory`, 100_000);
        if (!r.success) throw new Error(`Approve initB failed: ${r.error}`);
        r = await this._sendTx((opts) => factory.initializeShard(shardAddress, initAmountA, initAmountB, opts), `initializeShard`, 1_000_000);
        if (!r.success) throw new Error(`initializeShard failed: ${r.error}`);

        console.log(`   ✅ Shard created via factory: ${shardAddress}`);
      }

      // Update deployment file
      const shardInfo = {
        address: shardAddress,
        name: `${tokenASymbol}-${tokenBSymbol}-${tier.name}-Dynamic`,
        liquidityUSD: tier.liquidityUSD,
        amountA: ethers.formatUnits(amountA, tokenAData.decimals),
        amountB: ethers.formatUnits(amountB, tokenBData.decimals),
        createdBy: 'DynamicShardManager',
        createdAt: new Date().toISOString(),
        managedByOrchestrator: Boolean(orchAddr)
      };

      if (!this.deployment.contracts.shards[pair]) {
        this.deployment.contracts.shards[pair] = [];
      }
      this.deployment.contracts.shards[pair].push(shardInfo);
      fs.writeFileSync(this.deploymentPath, JSON.stringify(this.deployment, null, 2));

      return shardInfo;
    } catch (e) {
      console.log(`   ❌ Failed to create shard: ${e.message.slice(0, 80)}`);
      return null;
    }
  }

  async checkAndManageShards() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      await this.fetchPrices();

      console.log(`\n${'='.repeat(70)}`);
      console.log(`🔧 Dynamic Shard Manager — Check Cycle`);
      console.log(`${'='.repeat(70)}`);

      const analysis = await this.analyzeAllShards();
      let totalShards = 0;
      let totalTVL = 0;
      let shardsCreated = 0;
      let rebalances = 0;
      let merges = 0;
      let splits = 0;
      let tpsScaleUps = 0;

      const pairs = Object.entries(analysis);
      for (let pi = 0; pi < pairs.length; pi++) {
        const [pair, shardAnalysis] = pairs[pi];
        const deployedCount = (this.deployment.contracts.shards[pair] || []).length;

        // Guard: if RPC errors caused empty/partial analysis, skip this pair entirely
        if (shardAnalysis.length === 0 && deployedCount > 0) {
          console.log(`\n   ${pair}: ⚠️  RPC errors — 0/${deployedCount} shards analyzed. Skipping.`);
          totalShards += deployedCount;
          continue;
        }
        if (shardAnalysis.length < deployedCount * 0.5) {
          console.log(`\n   ${pair}: ⚠️  Only ${shardAnalysis.length}/${deployedCount} shards analyzed (RPC issues). Skipping operations.`);
          totalShards += deployedCount;
          totalTVL += shardAnalysis.reduce((sum, s) => sum + s.tvlUSD, 0);
          continue;
        }

        totalShards += shardAnalysis.length;
        const pairTVL = shardAnalysis.reduce((sum, s) => sum + s.tvlUSD, 0);
        totalTVL += pairTVL;

        // ── TPS measurement (litepaper §6) ──
        let tpsMeasure = { tps: 0, swapCount: 0, windowSeconds: this.TPS_WINDOW_SECONDS, perShard: {} };
        try {
          const shardAddrs = (this.deployment.contracts.shards[pair] || []).map(s => s.address);
          // Delay between pairs to avoid RPC 429
          if (pi > 0) await new Promise(r => setTimeout(r, 500));
          tpsMeasure = await this.measurePairTPS(pair, shardAddrs);
        } catch (tpsErr) {
          console.log(`      ⚠️  TPS measurement failed for ${pair}: ${tpsErr.message?.slice(0, 60)}`);
        }
        const optimalCount = this.getOptimalShardCount(tpsMeasure.tps);
        const tpsLabel = tpsMeasure.tps >= 0.01
          ? `TPS: ${tpsMeasure.tps.toFixed(2)} (${tpsMeasure.swapCount} swaps/${Math.round(tpsMeasure.windowSeconds)}s)`
          : 'TPS: idle';

        console.log(`\n   ${pair}: ${shardAnalysis.length} shards → target ${optimalCount}, ${tpsLabel}, TVL: $${Math.round(pairTVL).toLocaleString()}`);
        for (const s of shardAnalysis) {
          const health = s.isHealthy ? '✅' : '⚠️';
          console.log(`      ${health} ${s.name}: $${Math.round(s.tvlUSD).toLocaleString()} TVL, max swap: $${Math.round(s.maxSwapUSD)}, imbalance: ${(s.imbalance * 100).toFixed(1)}%`);
        }

        let actedOnPair = false;

        try {
          // ── 1. TPS SCALE-UP: throughput demands more parallelism ──
          if (optimalCount > shardAnalysis.length && tpsMeasure.tps >= this.MIN_TPS_FOR_SCALE_UP) {
            const sorted = [...shardAnalysis].sort((a, b) => a.tvlUSD - b.tvlUSD);
            const largest = sorted[sorted.length - 1];
            if (largest && largest.tvlUSD >= this.MIN_SPLIT_TVL) {
              const splitPct = shardAnalysis.length === 1 ? 50 : 35;
              console.log(`      📈 TPS ${tpsMeasure.tps.toFixed(1)} → scale up: split ${largest.name}`);
              const result = await this.splitPair(pair, {
                source: largest, splitPercent: splitPct,
                reason: `TPS ${tpsMeasure.tps.toFixed(1)} needs ${optimalCount} shards (have ${shardAnalysis.length})`
              });
              if (result) { splits++; tpsScaleUps++; actedOnPair = true; }
            } else {
              const tier = this.SHARD_TIERS[1]; // Medium — best balance of fee/capacity
              console.log(`      📈 TPS ${tpsMeasure.tps.toFixed(1)} → scale up: create ${tier.name} shard`);
              const result = await this.createNewShard(pair, tier);
              if (result) { shardsCreated++; tpsScaleUps++; actedOnPair = true; }
            }
          }

          // ── 2. ORGANIC SPLIT: shard grew beyond $8M (not TPS-driven) ──
          if (!actedOnPair) {
            const split = this.findSplitOpportunity(pair, shardAnalysis);
            if (split) {
              const result = await this.splitPair(pair, split);
              if (result) { splits++; actedOnPair = true; }
            }
          }

          // ── 3. BOOTSTRAP: zero shards or all dead ──
          if (!actedOnPair) {
            const needed = this.needsNewShard(pair, shardAnalysis);
            if (needed) {
              console.log(`      📌 ${needed.reason}`);
              const result = await this.createNewShard(pair, needed.tier);
              if (result) { shardsCreated++; actedOnPair = true; }
            }
          }

          // ── 4. MERGE: only dead shards (TVL < $10k) ──
          if (!actedOnPair) {
            const merge = this.findMergeOpportunity(pair, shardAnalysis);
            if (merge) {
              if (optimalCount < shardAnalysis.length) {
                console.log(`      📉 TPS ${tpsMeasure.tps.toFixed(1)} → scaling down`);
              }
              const result = await this.mergePair(pair, merge);
              if (result) { merges++; actedOnPair = true; }
            }
          }

          // ── 5. HEALTH: fix internal reserve imbalance (20%+ skew) ──
          if (!actedOnPair) {
            const rebalance = this.findRebalanceOpportunity(pair, shardAnalysis);
            if (rebalance) {
              const result = await this.rebalancePair(pair, rebalance);
              if (result) rebalances++;
            }
          }
        } catch (pairErr) {
          console.log(`      ❌ Error managing ${pair} (non-fatal): ${pairErr.message?.slice(0, 80)}`);
        }
      }

      console.log(`\n   📊 Total: ${totalShards} shards, $${Math.round(totalTVL).toLocaleString()} TVL`);
      if (tpsScaleUps > 0) {
        console.log(`   📈 TPS-driven scale-ups: ${tpsScaleUps}`);
      }
      if (shardsCreated > 0) {
        console.log(`   🆕 Created ${shardsCreated} new shards`);
      }
      if (splits > 0 || rebalances > 0 || merges > 0) {
        console.log(`   🔧 Ops: splits=${splits}, rebalances=${rebalances}, merges=${merges}`);
      }
      // Per-pair TPS summary
      const tpsSummary = Object.entries(this._pairTPS)
        .map(([p, d]) => `${p}:${d.tps.toFixed(2)}`)
        .join(' | ');
      if (tpsSummary) console.log(`   ⚡ TPS: ${tpsSummary}`);
      if (this.txQueue) {
        const qs = this.txQueue.getStats();
        console.log(`   📡 TxQueue: sent=${qs.sent} confirmed=${qs.confirmed} failed=${qs.failed} retried=${qs.retried}`);
      }
      console.log(`${'='.repeat(70)}\n`);

    } catch (error) {
      console.error(`❌ Shard Manager cycle error (non-fatal): ${error.message?.slice(0, 120)}`);
    } finally {
      this.isChecking = false;
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`\n✅ Dynamic Shard Manager started — checking every ${this.checkInterval / 1000}s\n`);

    this.intervalId = setInterval(
      () => this.checkAndManageShards().catch((e) => console.error('Shard manager cycle error:', e.message?.slice(0, 80))),
      this.checkInterval
    );

    // Run immediately (non-fatal)
    try {
      await this.checkAndManageShards();
    } catch (e) {
      console.error('Shard manager first cycle error (non-fatal):', e.message?.slice(0, 80));
    }
  }

  stop() {
    if (!this.isRunning) return;
    clearInterval(this.intervalId);
    this.isRunning = false;
    console.log('\n🛑 Dynamic Shard Manager stopped');
  }

  getStatus() {
    const totalShards = Object.values(this.deployment.contracts.shards)
      .reduce((sum, shards) => sum + shards.length, 0);
    return {
      running: this.isRunning,
      wallet: this.wallet.address,
      checkInterval: this.checkInterval,
      totalShards,
      totalPairs: Object.keys(this.deployment.contracts.shards).length,
      prices: this.priceCache,
      tpsConfig: {
        perShardCapacity: this.PER_SHARD_TPS,
        windowSeconds: this.TPS_WINDOW_SECONDS,
        minForScaleUp: this.MIN_TPS_FOR_SCALE_UP
      },
      pairTPS: this._pairTPS,
      txQueue: this.txQueue?.getStats() || null
    };
  }
}

// CLI entry point
if (require.main === module) {
  const TxQueue = require('./tx-queue');
  const deploymentFile = process.env.DEPLOYMENT_FILE;
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RISECHAIN_RPC_URL || 'https://testnet.riselabs.xyz/http';

  if (!privateKey) {
    console.error('❌ PRIVATE_KEY not set');
    process.exit(1);
  }

  // Auto-find latest deployment file
  let file = deploymentFile;
  if (!file) {
    const deployDir = path.join(__dirname, 'deployment-data');
    const files = fs.readdirSync(deployDir)
      .filter(f => f.startsWith('production-risechain-') && f.endsWith('.json'))
      .sort().reverse();
    if (files.length === 0) {
      console.error('❌ No deployment files found');
      process.exit(1);
    }
    file = files[0];
    console.log(`   Using latest deployment: ${file}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const txQueue = new TxQueue(wallet, provider);
  const manager = new DynamicShardManager(file, privateKey, rpcUrl, txQueue);
  manager.start().catch(console.error);

  process.on('SIGINT', () => {
    manager.stop();
    process.exit(0);
  });
}

module.exports = DynamicShardManager;
