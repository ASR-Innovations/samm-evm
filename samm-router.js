'use strict';
/**
 * SAMM Router — atomic on-chain routing (single-hop and multi-hop)
 *
 * All routing — whether across multiple shards of one pair OR across multiple
 * token hops — executes in a SINGLE Solana transaction using CPI chaining:
 *
 *   For each leg (one pool shard):
 *     1. Approve(userSourceATA → poolPDA, legMaxIn)   — payer signs outer tx
 *     2. SwapSAMM(pool, exactAmountOut, maxIn)         — pool PDA signs via invoke_signed
 *
 * Multi-hop example (USDT → USDC → WETH):
 *   Hop 1: build legs for USDT-USDC pair  →  outputs to user's USDC ATA
 *   Hop 2: build legs for USDC-WETH pair  →  inputs from user's USDC ATA
 *   All legs in ONE transaction = fully atomic.
 *
 * This is equivalent to an EVM CrossPoolRouter / UniswapV2Router without
 * needing a separate Rust program — Solana instructions are composable.
 */

const {
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const {
  getPoolReserves,
  swapInstruction,
  findSwapAuthority,
} = require('./solana-client');
const { execSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');

const RUST_BINARY = path.join(__dirname, 'rust-samm', 'target', 'release', 'samm');

function pk(v) {
  const { PublicKey } = require('@solana/web3.js');
  return typeof v === 'string' ? new PublicKey(v) : v;
}

function rustQuote(outputAmount, sourceReserve, destReserve,
                   tradeFeeNum = 10, tradeFeeDenom = 10000,
                   ownerFeeNum = 0,  ownerFeeDenom = 1) {
  const params = {
    output_amount:   Number(outputAmount),
    source_reserve:  Number(sourceReserve),
    dest_reserve:    Number(destReserve),
    trade_fee_num:   tradeFeeNum,
    trade_fee_denom: tradeFeeDenom,
    owner_fee_num:   ownerFeeNum,
    owner_fee_denom: ownerFeeDenom || 1,
  };
  const out = execSync(`"${RUST_BINARY}" swap-samm '${JSON.stringify(params)}'`, {
    encoding: 'utf8', timeout: 5000,
  });
  return JSON.parse(out.trim());
}

// ── Internal shard helpers ─────────────────────────────────────────────────────

async function getShardData(connection, shard, tokenInMint) {
  const r = await getPoolReserves(connection, shard.address);
  const mintStr = typeof tokenInMint === 'string' ? tokenInMint : tokenInMint.toBase58();
  const isAIn   = r.mintA.toBase58() === mintStr;
  // Read actual fee params from on-chain state (not deployment JSON)
  const tradeFeeNum    = Number(r.state.tradeFeeNumerator);
  const tradeFeeDenom  = Number(r.state.tradeFeeDenominator) || 10000;
  const ownerFeeNum    = Number(r.state.ownerTradeFeeNumerator);
  const ownerFeeDenom  = Number(r.state.ownerTradeFeeDenominator) || 1;
  return {
    shard,
    sourceReserve: isAIn ? r.reserveA : r.reserveB,
    destReserve:   isAIn ? r.reserveB : r.reserveA,
    poolSource:    isAIn ? r.state.tokenAccountA : r.state.tokenAccountB,
    poolDest:      isAIn ? r.state.tokenAccountB : r.state.tokenAccountA,
    state:         r.state,
    feeBps:        Math.round((tradeFeeNum / tradeFeeDenom) * 10000),
    tradeFeeNum,   tradeFeeDenom,
    ownerFeeNum,   ownerFeeDenom,
  };
}

// ── Quoting ────────────────────────────────────────────────────────────────────

async function quoteSingleHop(connection, totalAmountOut, tokenInMint, shards) {
  if (!shards.length) throw new Error('No shards provided');

  const shardData = await Promise.all(shards.map(async s => {
    try {
      const d = await getShardData(connection, s, tokenInMint);
      if (d.destReserve <= totalAmountOut) return null;
      const q = rustQuote(totalAmountOut, d.sourceReserve, d.destReserve,
                          d.tradeFeeNum, d.tradeFeeDenom, d.ownerFeeNum, d.ownerFeeDenom);
      return {
        ...d,
        amountIn:       BigInt(q.amount_in),
        tradeFee:       BigInt(q.trade_fee),
        ownerFee:       BigInt(q.owner_fee),
        priceImpactPct: (Number(totalAmountOut) / Number(d.destReserve)) * 100,
      };
    } catch { return null; }
  }));

  const viable = shardData
    .filter(Boolean)
    .sort((a, b) => (a.amountIn < b.amountIn ? -1 : a.amountIn > b.amountIn ? 1 : 0));

  if (!viable.length) throw new Error('No shard has sufficient liquidity');

  const best = viable[0];

  // For large price impact (>5%), try proportional split across all viable shards
  if (viable.length > 1 && best.priceImpactPct > 5) {
    try {
      const totalDest = viable.reduce((a, s) => a + s.destReserve, 0n);
      const splitCandidates = viable.map(s => ({
        ...s,
        amountOut: (totalAmountOut * s.destReserve) / totalDest,
      }));

      // Fix rounding: remainder goes to largest shard
      const allocated = splitCandidates.reduce((a, l) => a + l.amountOut, 0n);
      if (allocated < totalAmountOut) splitCandidates[0].amountOut += totalAmountOut - allocated;

      const splitLegs = splitCandidates
        .filter(l => l.amountOut > 0n)
        .map(l => {
          const q = rustQuote(l.amountOut, l.sourceReserve, l.destReserve,
                              l.tradeFeeNum, l.tradeFeeDenom, l.ownerFeeNum, l.ownerFeeDenom);
          return { ...l, amountIn: BigInt(q.amount_in), tradeFee: BigInt(q.trade_fee), amountOut: l.amountOut };
        });

      const splitTotalIn = splitLegs.reduce((a, l) => a + l.amountIn, 0n);
      if (splitTotalIn < best.amountIn) {
        return {
          strategy:       'split',
          totalAmountOut,
          totalAmountIn:  splitTotalIn,
          totalTradeFee:  splitLegs.reduce((a, l) => a + l.tradeFee, 0n),
          priceImpactPct: best.priceImpactPct,
          legs: splitLegs.map(l => ({
            shard:     l.shard,
            amountOut: l.amountOut,
            amountIn:  l.amountIn,
            tradeFee:  l.tradeFee,
            poolSource: l.poolSource,
            poolDest:   l.poolDest,
            state:      l.state,
            feeBps:     l.feeBps,
          })),
        };
      }
    } catch { /* fallback to single */ }
  }

  return {
    strategy:       'single',
    totalAmountOut,
    totalAmountIn:  best.amountIn,
    totalTradeFee:  best.tradeFee,
    priceImpactPct: best.priceImpactPct,
    legs: [{
      shard:     best.shard,
      amountOut: totalAmountOut,
      amountIn:  best.amountIn,
      tradeFee:  best.tradeFee,
      poolSource: best.poolSource,
      poolDest:   best.poolDest,
      state:      best.state,
      feeBps:     best.feeBps,
    }],
  };
}

// ── SAMMRouter class ───────────────────────────────────────────────────────────

class SAMMRouter {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {import('@solana/web3.js').Keypair|null} keypair
   * @param {object} deployment  — parsed solana-devnet.json
   * @param {string} programId
   */
  constructor(connection, keypair, deployment, programId) {
    this.connection = connection;
    this.keypair    = keypair;
    this.deployment = deployment;
    this.programId  = programId;
  }

  getPoolsForPair(symA, symB) {
    return this.deployment.pools[`${symA}-${symB}`]
        || this.deployment.pools[`${symB}-${symA}`]
        || [];
  }

  /** Find a route path between two tokens using known pairs. */
  findPath(tokenInSym, tokenOutSym) {
    // Direct path
    const direct = this.getPoolsForPair(tokenInSym, tokenOutSym);
    if (direct.length) return [[tokenInSym, tokenOutSym]];

    // Single-hop intermediate (bridging token)
    const bridges = ['USDC', 'USDT', 'DAI', 'WETH'];
    for (const mid of bridges) {
      if (mid === tokenInSym || mid === tokenOutSym) continue;
      const leg1 = this.getPoolsForPair(tokenInSym, mid);
      const leg2 = this.getPoolsForPair(mid, tokenOutSym);
      if (leg1.length && leg2.length) return [[tokenInSym, mid], [mid, tokenOutSym]];
    }

    throw new Error(`No route found for ${tokenInSym} → ${tokenOutSym}`);
  }

  /**
   * Compute a full routing quote — single or multi-hop, single or multi-shard.
   *
   * @param {bigint}  amountOut     — exact amount of tokenOut desired
   * @param {string}  tokenInSym    — input token symbol
   * @param {string}  tokenOutSym   — output token symbol
   * @returns detailed route plan
   */
  async routeQuote(amountOut, tokenInSym, tokenOutSym) {
    if (!fs.existsSync(RUST_BINARY)) throw new Error('Rust binary not built');

    const path = this.findPath(tokenInSym, tokenOutSym);
    const hops = [];

    // Work backward from desired output (since SAMM is exact-output)
    let currentAmountOut = amountOut;
    for (let i = path.length - 1; i >= 0; i--) {
      const [inSym, outSym] = path[i];
      const inMint  = this.deployment.tokens[inSym]?.mint;
      const outMint = this.deployment.tokens[outSym]?.mint;
      if (!inMint || !outMint) throw new Error(`Unknown token: ${inSym} or ${outSym}`);

      const shards = this.getPoolsForPair(inSym, outSym);
      if (!shards.length) throw new Error(`No pools for ${inSym}-${outSym}`);

      const hopQuote = await quoteSingleHop(this.connection, currentAmountOut, inMint, shards);
      hops.unshift({ tokenIn: inSym, tokenOut: outSym, inMint, outMint, ...hopQuote });
      currentAmountOut = hopQuote.totalAmountIn; // amount needed for next (earlier) hop
    }

    const totalAmountIn = hops[0].totalAmountIn;
    const maxImpact      = Math.max(...hops.map(h => h.priceImpactPct));

    const inDec  = this.deployment.tokens[tokenInSym]?.decimals  || 6;
    const outDec = this.deployment.tokens[tokenOutSym]?.decimals || 6;

    return {
      tokenIn:         tokenInSym,
      tokenOut:        tokenOutSym,
      amountOut,
      amountIn:        totalAmountIn,
      path:            path.map(([a, b]) => `${a}→${b}`).join(', '),
      hops:            hops.length,
      hopDetails:      hops.map((h, i) => ({
        hop:           i + 1,
        tokenIn:       h.tokenIn,
        tokenOut:      h.tokenOut,
        amountOut:     h.totalAmountOut,
        amountIn:      h.totalAmountIn,
        tradeFee:      h.totalTradeFee,
        feeBps:        h.legs[0]?.feeBps || 10,
        strategy:      h.strategy,
        shardCount:    h.legs.length,
        priceImpactPct: h.priceImpactPct.toFixed(4),
        legs:          h.legs.map(l => ({
          shard:    l.shard.name,
          amountOut: l.amountOut,
          amountIn:  l.amountIn,
        })),
      })),
      totalFeeBps:     hops.reduce((a, h) => a + (h.legs[0]?.feeBps || 10), 0),
      priceImpactPct:  maxImpact.toFixed(4),
      // Human-readable
      amountOutHuman:  Number(amountOut)    / 10 ** outDec,
      amountInHuman:   Number(totalAmountIn) / 10 ** inDec,
      effectiveRate:   (Number(amountOut) / 10 ** outDec) / (Number(totalAmountIn) / 10 ** inDec),
      _hops:           hops, // raw for executeRoute
    };
  }

  /**
   * Build the complete atomic Solana transaction for a quote result.
   * Works for both single-hop and multi-hop routes.
   */
  buildAtomicTransaction(quote, payer, slippageBps) {
    const tx = new Transaction();
    const createdATAs = new Set();

    const ensureATA = (mint, owner) => {
      const ata = getAssociatedTokenAddressSync(pk(mint), pk(owner));
      const key = ata.toBase58();
      if (!createdATAs.has(key)) {
        tx.add(createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, ata, pk(owner), pk(mint),
        ));
        createdATAs.add(key);
      }
      return ata;
    };

    for (const hop of quote._hops) {
      // Ensure intermediate and output ATAs exist
      ensureATA(hop.outMint, payer.publicKey);

      const userSource = getAssociatedTokenAddressSync(pk(hop.inMint), payer.publicKey);
      const userDest   = getAssociatedTokenAddressSync(pk(hop.outMint), payer.publicKey);

      for (const leg of hop.legs) {
        // +1n ensures at least 1 raw token of headroom for small amounts where BigInt truncation
        // would otherwise produce 0% effective slippage tolerance
        const legMaxIn = leg.amountIn * (10000n + slippageBps) / 10000n + 1n;
        const [poolAuthority] = findSwapAuthority(this.programId, leg.shard.address);

        // 1. Approve this pool's PDA to pull legMaxIn from user's source ATA
        tx.add(createApproveInstruction(
          userSource, poolAuthority, payer.publicKey, legMaxIn,
        ));

        // 2. Exact-output SAMM swap — pool PDA signs via invoke_signed inside the program
        tx.add(swapInstruction({
          programId:             this.programId,
          tokenSwap:             leg.shard.address,
          authority:             poolAuthority,
          userTransferAuthority: poolAuthority,
          userSource,
          poolSource:            leg.poolSource,
          poolDestination:       leg.poolDest,
          userDestination:       userDest,
          poolMint:              leg.state.tokenPool,
          feeAccount:            leg.state.feeAccount,
          sourceMint:            pk(hop.inMint),
          destinationMint:       pk(hop.outMint),
          poolTokenProgramId:    leg.state.poolTokenProgramId,
          amountOut:             leg.amountOut,
          maximalAmountIn:       legMaxIn,
        }));
      }
    }

    return tx;
  }

  /**
   * Execute a pre-computed route atomically in one Solana transaction.
   *
   * @param {object} quote      — from routeQuote()
   * @param {bigint} slippageBps — e.g. 50n = 0.5%
   * @returns {string} transaction signature
   */
  async executeRoute(quote, slippageBps = 100n) {
    if (!this.keypair) throw new Error('No keypair — read-only mode');

    const tx = this.buildAtomicTransaction(quote, this.keypair, slippageBps);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.keypair.publicKey;

    return sendAndConfirmTransaction(this.connection, tx, [this.keypair], {
      commitment: 'confirmed',
    });
  }

  /**
   * One-call convenience: quote + execute.
   */
  async swap(amountOut, tokenInSym, tokenOutSym, slippageBps = 100n) {
    const quote = await this.routeQuote(amountOut, tokenInSym, tokenOutSym);
    const sig   = await this.executeRoute(quote, slippageBps);
    return { sig, quote };
  }
}

module.exports = SAMMRouter;
