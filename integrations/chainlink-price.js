/**
 * Chainlink Price Oracle
 *
 * Reads price feeds from Chainlink AggregatorV3 contracts on Ethereum Sepolia.
 * Provides decentralized, tamper-proof price data for SAMM's arbitrage bot
 * and dynamic shard manager — replacing the centralized CoinGecko dependency.
 *
 * Architecture:
 *   The SAMM arb bot previously called CoinGecko HTTP API every 60s.
 *   Now it calls Chainlink AggregatorV3.latestRoundData() on-chain.
 *   Benefits:
 *     - Decentralized (DON-validated, not single API)
 *     - Tamper-proof (on-chain, cryptographically signed)
 *     - No rate limits (RPC calls, not HTTP API)
 *     - Heartbeat guarantees (prices update within known intervals)
 */

const { ethers } = require('ethers');

// Chainlink AggregatorV3 ABI (minimal — only what we need)
const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
];

// Chainlink Price Feed addresses on Ethereum Sepolia
// Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum
const SEPOLIA_FEEDS = {
  'ETH/USD':  '0x694AA1769357215DE4FAC081bf1f309aDC325306',
  'BTC/USD':  '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
  'USDC/USD': '0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E',
  'DAI/USD':  '0x14866185B1962B63C3Ea9E03Bc1da838bab34C19',
  'LINK/USD': '0xc59E3633BAAC79493d908e63626716e204A45EdF',
};

// Map SAMM token symbols to Chainlink feed keys
const TOKEN_TO_FEED = {
  'WETH': 'ETH/USD',
  'WBTC': 'BTC/USD',
  'USDC': 'USDC/USD',
  'USDT': 'USDC/USD', // USDT ≈ USDC (no dedicated Sepolia feed)
  'DAI':  'DAI/USD',
};

class ChainlinkPriceOracle {
  /**
   * @param {string} sepoliaRpcUrl — RPC URL for Ethereum Sepolia
   */
  constructor(sepoliaRpcUrl) {
    this.enabled = !!sepoliaRpcUrl;
    this.priceCache = {};
    this.lastUpdate = 0;
    this.updateInterval = 30_000; // 30s cache (Chainlink heartbeats are 1h for most feeds)
    this.feedContracts = {};
    this.feedDecimals = {};

    if (!this.enabled) {
      console.log('⚠️  ChainlinkPriceOracle: No SEPOLIA_RPC_URL — Chainlink feeds disabled');
      return;
    }

    try {
      this.provider = new ethers.JsonRpcProvider(sepoliaRpcUrl);

      // Create contract instances for each feed
      for (const [feedName, address] of Object.entries(SEPOLIA_FEEDS)) {
        this.feedContracts[feedName] = new ethers.Contract(address, AGGREGATOR_ABI, this.provider);
      }

      console.log('✅ ChainlinkPriceOracle: Initialized with Sepolia feeds');
      console.log(`   Feeds: ${Object.keys(SEPOLIA_FEEDS).join(', ')}`);
    } catch (err) {
      console.log(`⚠️  ChainlinkPriceOracle init error: ${err.message?.slice(0, 100)}`);
      this.enabled = false;
    }
  }

  /**
   * Fetch latest price from a single Chainlink feed.
   *
   * @param {string} feedName — e.g. "ETH/USD"
   * @returns {object} — { price, roundId, updatedAt, decimals, staleness }
   */
  async getFeedPrice(feedName) {
    const contract = this.feedContracts[feedName];
    if (!contract) throw new Error(`Unknown feed: ${feedName}`);

    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
      await contract.latestRoundData();

    // Get decimals (usually 8 for USD pairs)
    if (!this.feedDecimals[feedName]) {
      this.feedDecimals[feedName] = await contract.decimals();
    }
    const decimals = this.feedDecimals[feedName];

    const price = parseFloat(ethers.formatUnits(answer, decimals));
    const stalenessSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);

    return {
      feed: feedName,
      price,
      roundId: roundId.toString(),
      updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
      stalenessSeconds,
      decimals: Number(decimals),
      source: 'Chainlink AggregatorV3 (Sepolia)',
    };
  }

  /**
   * Fetch all prices for SAMM tokens.
   * Returns a map compatible with CoinGecko format: { WETH: 3500, USDC: 1, ... }
   *
   * @returns {object} — { prices, metadata }
   */
  async fetchAllPrices() {
    if (!this.enabled) return { prices: {}, metadata: {}, source: 'disabled' };

    // Use cache if fresh
    const now = Date.now();
    if (now - this.lastUpdate < this.updateInterval && Object.keys(this.priceCache).length > 0) {
      return {
        prices: { ...this.priceCache },
        metadata: this._lastMetadata || {},
        source: 'chainlink-cached',
      };
    }

    const prices = {};
    const metadata = {};
    const errors = [];

    // Fetch all feeds in parallel
    const feedPromises = Object.entries(TOKEN_TO_FEED).map(async ([tokenSymbol, feedName]) => {
      try {
        const feedData = await this.getFeedPrice(feedName);
        prices[tokenSymbol] = feedData.price;
        metadata[tokenSymbol] = {
          ...feedData,
          tokenSymbol,
        };
      } catch (err) {
        errors.push({ token: tokenSymbol, feed: feedName, error: err.message?.slice(0, 80) });
      }
    });

    await Promise.all(feedPromises);

    if (Object.keys(prices).length > 0) {
      this.priceCache = { ...prices };
      this._lastMetadata = metadata;
      this.lastUpdate = now;
    }

    if (errors.length > 0) {
      console.log(`⚠️  Chainlink feed errors: ${errors.map(e => `${e.token}: ${e.error}`).join(', ')}`);
    }

    return {
      prices,
      metadata,
      errors: errors.length > 0 ? errors : undefined,
      source: 'chainlink-live',
      feedCount: Object.keys(prices).length,
    };
  }

  /**
   * Get prices in the simple { WETH: 3500, ... } format
   * that the arb bot expects (drop-in replacement for CoinGecko).
   *
   * @returns {object} — Price map
   */
  async getPriceMap() {
    const { prices } = await this.fetchAllPrices();
    return prices;
  }

  /**
   * Compare Chainlink prices with another price source (e.g. CoinGecko).
   *
   * @param {object} otherPrices — { WETH: 3500, USDC: 1, ... }
   * @param {string} otherSource — Label for the other source
   * @returns {object} — Comparison with deviations
   */
  compareWith(otherPrices, otherSource = 'CoinGecko') {
    const comparisons = {};

    for (const [token, chainlinkPrice] of Object.entries(this.priceCache)) {
      const otherPrice = otherPrices[token];
      if (otherPrice && chainlinkPrice) {
        const deviation = ((chainlinkPrice - otherPrice) / otherPrice) * 100;
        comparisons[token] = {
          chainlink: chainlinkPrice,
          [otherSource.toLowerCase()]: otherPrice,
          deviationPct: deviation.toFixed(4),
          agreement: Math.abs(deviation) < 1 ? 'good' : Math.abs(deviation) < 5 ? 'moderate' : 'divergent',
        };
      }
    }

    return comparisons;
  }

  /**
   * Get detailed status for the /oracle/chainlink endpoint.
   */
  getStatus() {
    return {
      enabled: this.enabled,
      lastUpdate: this.lastUpdate > 0 ? new Date(this.lastUpdate).toISOString() : null,
      cachedPrices: { ...this.priceCache },
      feeds: Object.keys(SEPOLIA_FEEDS),
      tokenMapping: { ...TOKEN_TO_FEED },
      cacheAgeMs: this.lastUpdate > 0 ? Date.now() - this.lastUpdate : null,
    };
  }
}

module.exports = { ChainlinkPriceOracle, SEPOLIA_FEEDS, TOKEN_TO_FEED };
