/**
 * Uniswap Trading API Client
 *
 * Wraps the Uniswap Trading API (https://trade-api.gateway.uniswap.org)
 * to fetch quotes and compare pricing against SAMM's sharded pools.
 *
 * Requires UNISWAP_API_KEY environment variable.
 */

const BASE_URL = 'https://trade-api.gateway.uniswap.org/v1';

// Mainnet token addresses (for Uniswap API comparison)
// We map SAMM's RiseChain testnet tokens to their Ethereum mainnet equivalents
const MAINNET_TOKENS = {
  WETH: {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    decimals: 18,
    chainId: 1,
  },
  USDC: {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    chainId: 1,
  },
  USDT: {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    chainId: 1,
  },
  WBTC: {
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    decimals: 8,
    chainId: 1,
  },
  DAI: {
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    decimals: 18,
    chainId: 1,
  },
};

// A dummy swapper address for quote requests (read-only, no signing)
const DUMMY_SWAPPER = '0x0000000000000000000000000000000000000001';

class UniswapQuoter {
  /**
   * @param {string} apiKey — Uniswap API key from developers.uniswap.org
   */
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.enabled = !!apiKey;
    if (!this.enabled) {
      console.log('⚠️  UniswapQuoter: No UNISWAP_API_KEY — comparison endpoints disabled');
    } else {
      console.log('✅ UniswapQuoter: Initialized with API key');
    }
  }

  /**
   * Get a Uniswap quote for a given trade.
   *
   * @param {string} tokenInSymbol  — e.g. "WETH"
   * @param {string} tokenOutSymbol — e.g. "USDC"
   * @param {string} amount         — Human-readable amount of tokenIn (e.g. "1.5")
   * @param {"EXACT_INPUT"|"EXACT_OUTPUT"} type — Quote type
   * @returns {object|null} — { amountIn, amountOut, gasEstimate, route, ... } or null on failure
   */
  async getQuote(tokenInSymbol, tokenOutSymbol, amount, type = 'EXACT_INPUT') {
    if (!this.enabled) return null;

    const tokenIn = MAINNET_TOKENS[tokenInSymbol];
    const tokenOut = MAINNET_TOKENS[tokenOutSymbol];
    if (!tokenIn || !tokenOut) {
      console.log(`⚠️  UniswapQuoter: Unknown token pair ${tokenInSymbol}/${tokenOutSymbol}`);
      return null;
    }

    // Convert human-readable amount to raw (wei/smallest unit)
    const decimals = type === 'EXACT_INPUT' ? tokenIn.decimals : tokenOut.decimals;
    const rawAmount = this._toRaw(amount, decimals);

    const body = {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      tokenInChainId: tokenIn.chainId,
      tokenOutChainId: tokenOut.chainId,
      type,
      amount: rawAmount,
      swapper: DUMMY_SWAPPER,
      slippageTolerance: 0.5,
    };

    try {
      const resp = await fetch(`${BASE_URL}/quote`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.log(`⚠️  Uniswap API ${resp.status}: ${err.message || err.error || 'unknown'}`);
        return null;
      }

      const data = await resp.json();
      return this._parseQuoteResponse(data, tokenInSymbol, tokenOutSymbol, type);
    } catch (err) {
      console.log(`⚠️  Uniswap API error: ${err.message?.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Compare SAMM quote vs Uniswap quote for the same trade.
   *
   * @param {object} sammQuote — { amountIn, amountOut, fee, feePct, shard, ... }
   * @param {string} tokenIn   — e.g. "WETH"
   * @param {string} tokenOut  — e.g. "USDC"
   * @param {string} amountOut — Desired output amount (human-readable)
   * @param {object} oraclePrices — { WETH: 3500, USDC: 1, ... }
   * @returns {object} — Comparison result with delta
   */
  async compareWithSAMM(sammQuote, tokenIn, tokenOut, amountOut, oraclePrices) {
    // SAMM uses EXACT_OUTPUT (user specifies desired output).
    // We ask Uniswap for EXACT_OUTPUT too, so the comparison is apples-to-apples.
    const uniQuote = await this.getQuote(tokenIn, tokenOut, amountOut, 'EXACT_OUTPUT');

    const result = {
      tokenIn,
      tokenOut,
      amountOut,
      amountOutUSD: (parseFloat(amountOut) * (oraclePrices[tokenOut] || 1)).toFixed(2),
      samm: {
        amountIn: sammQuote.amountIn,
        fee: sammQuote.fee,
        feePct: sammQuote.feePct,
        shard: sammQuote.shard,
        effectiveRate: sammQuote.effectiveRate,
        source: 'SAMM (Sharded AMM)',
      },
      uniswap: null,
      comparison: null,
    };

    if (!uniQuote) {
      result.uniswap = { error: 'Quote unavailable (API key missing or pair not supported)' };
      result.comparison = { winner: 'SAMM (Uniswap unavailable)', deltaPercent: null };
      return result;
    }

    result.uniswap = {
      amountIn: uniQuote.amountIn,
      fee: uniQuote.gasEstimateUSD || '0',
      routing: uniQuote.routing,
      effectiveRate: uniQuote.effectiveRate,
      source: `Uniswap ${uniQuote.routing} (Ethereum Mainnet)`,
    };

    // Compare: who requires less input for the same output?
    const sammIn = parseFloat(sammQuote.amountIn);
    const uniIn = parseFloat(uniQuote.amountIn);

    if (sammIn > 0 && uniIn > 0) {
      const deltaPercent = ((uniIn - sammIn) / uniIn) * 100; // positive = SAMM is cheaper
      const sammInUSD = sammIn * (oraclePrices[tokenIn] || 1);
      const uniInUSD = uniIn * (oraclePrices[tokenIn] || 1);
      const savingsUSD = uniInUSD - sammInUSD;

      result.comparison = {
        winner: deltaPercent > 0 ? 'SAMM' : deltaPercent < 0 ? 'Uniswap' : 'Tie',
        deltaPercent: deltaPercent.toFixed(4),
        sammRequiresLessInput: deltaPercent > 0,
        savingsUSD: savingsUSD.toFixed(4),
        explanation: deltaPercent > 0
          ? `SAMM saves ${deltaPercent.toFixed(2)}% ($${Math.abs(savingsUSD).toFixed(2)}) by routing through the smallest eligible shard (c-smaller-better property).`
          : deltaPercent < 0
          ? `Uniswap is ${Math.abs(deltaPercent).toFixed(2)}% cheaper for this trade size (deeper mainnet liquidity).`
          : 'Both protocols offer the same rate for this trade.',
      };
    } else {
      result.comparison = { winner: 'Unknown', deltaPercent: null };
    }

    return result;
  }

  /**
   * Run a full comparison matrix across all pairs and trade sizes.
   *
   * @param {Function} sammQuoteFn — async (tokenIn, tokenOut, amountOut) => sammQuote
   * @param {object} oraclePrices  — { WETH: 3500, ... }
   * @returns {object} — Matrix of comparisons
   */
  async runComparisonMatrix(sammQuoteFn, oraclePrices) {
    const pairs = [
      ['WETH', 'USDC'],
      ['USDC', 'USDT'],
      ['WETH', 'USDT'],
      ['WBTC', 'USDC'],
      ['USDC', 'DAI'],
    ];

    // Trade sizes in USD — we compute token amounts from oracle prices
    const tradeSizesUSD = [10, 100, 500, 1000, 5000];

    const matrix = [];
    let sammWins = 0, uniWins = 0, ties = 0, errors = 0;

    for (const [tokenIn, tokenOut] of pairs) {
      for (const sizeUSD of tradeSizesUSD) {
        const amountOut = (sizeUSD / (oraclePrices[tokenOut] || 1)).toFixed(8);

        try {
          const sammQuote = await sammQuoteFn(tokenIn, tokenOut, amountOut);
          if (!sammQuote) {
            errors++;
            continue;
          }

          const comparison = await this.compareWithSAMM(
            sammQuote, tokenIn, tokenOut, amountOut, oraclePrices
          );

          matrix.push({
            pair: `${tokenIn}/${tokenOut}`,
            tradeSizeUSD: sizeUSD,
            amountOut,
            ...comparison,
          });

          if (comparison.comparison?.winner === 'SAMM') sammWins++;
          else if (comparison.comparison?.winner === 'Uniswap') uniWins++;
          else ties++;
        } catch (err) {
          errors++;
          matrix.push({
            pair: `${tokenIn}/${tokenOut}`,
            tradeSizeUSD: sizeUSD,
            error: err.message?.slice(0, 100),
          });
        }

        // Rate limit: 200ms between Uniswap API calls
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalComparisons: matrix.length,
        sammWins,
        uniswapWins: uniWins,
        ties,
        errors,
        sammWinRate: matrix.length > 0
          ? `${((sammWins / (sammWins + uniWins + ties)) * 100).toFixed(1)}%`
          : 'N/A',
      },
      insight: sammWins > uniWins
        ? 'SAMM\'s sharded architecture (c-smaller-better property) provides better rates for most trade sizes tested.'
        : 'Uniswap\'s deeper mainnet liquidity provides better rates for most trade sizes tested.',
      matrix,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────

  _toRaw(amount, decimals) {
    const parts = amount.split('.');
    const whole = parts[0] || '0';
    const frac = (parts[1] || '').slice(0, decimals).padEnd(decimals, '0');
    const scale = 10n ** BigInt(decimals);
    return (BigInt(whole) * scale + BigInt(frac)).toString();
  }

  _fromRaw(raw, decimals) {
    const s = raw.padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals) || '0';
    const frac = s.slice(s.length - decimals);
    return `${whole}.${frac}`.replace(/\.?0+$/, '') || '0';
  }

  _parseQuoteResponse(data, tokenInSymbol, tokenOutSymbol, type) {
    const quote = data.quote || data;

    // The API returns amounts in raw units — convert to human-readable
    const tokenIn = MAINNET_TOKENS[tokenInSymbol];
    const tokenOut = MAINNET_TOKENS[tokenOutSymbol];

    const amountIn = this._fromRaw(
      (quote.amountIn || quote.input?.amount || '0').toString(),
      tokenIn.decimals
    );
    const amountOut = this._fromRaw(
      (quote.amountOut || quote.output?.amount || '0').toString(),
      tokenOut.decimals
    );

    const amountInF = parseFloat(amountIn);
    const amountOutF = parseFloat(amountOut);

    return {
      amountIn,
      amountOut,
      effectiveRate: amountOutF > 0 && amountInF > 0
        ? (amountOutF / amountInF).toFixed(8)
        : '0',
      routing: quote.routing || data.routing || 'CLASSIC',
      gasEstimate: quote.gasEstimate || data.gasEstimate || null,
      gasEstimateUSD: quote.gasEstimateUSD || data.gasEstimateUSD || null,
      route: quote.route || data.route || [],
      raw: {
        amountIn: (quote.amountIn || quote.input?.amount || '0').toString(),
        amountOut: (quote.amountOut || quote.output?.amount || '0').toString(),
      },
    };
  }
}

module.exports = { UniswapQuoter, MAINNET_TOKENS };
