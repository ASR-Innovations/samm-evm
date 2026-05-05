'use strict';
/**
 * Solana Adapter
 *
 * Thin wrapper over solana-client/index.js that mirrors the interface the
 * rest of the backend (api-server, arbitrage-bot, shard-manager) used when
 * talking to EVM contracts.  Drop-in replacement — same method signatures,
 * same return shapes.
 */

const { PublicKey } = require('@solana/web3.js');
const { getPoolReserves, executeSwap, POOL_STATE_SIZE } = require('./solana-client');
const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const RUST_BINARY = path.join(__dirname, 'rust-samm', 'target', 'release', 'samm');
const RUST_AVAILABLE = fs.existsSync(RUST_BINARY);

function rustCall(subcommand, params) {
  const json = JSON.stringify(params);
  const out = execSync(`"${RUST_BINARY}" ${subcommand} '${json}'`, {
    encoding: 'utf8', timeout: 5000,
  });
  return JSON.parse(out.trim());
}

class SolanaAdapter {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {import('@solana/web3.js').Keypair|null} keypair  — null → read-only
   * @param {object} deployment  — parsed solana-devnet.json
   * @param {string} programId   — base58 program ID
   */
  constructor(connection, keypair, deployment, programId) {
    this.connection = connection;
    this.keypair    = keypair;
    this.deployment = deployment;
    this.programId  = programId;
  }

  // ── Pool reads ─────────────────────────────────────────────────

  /**
   * Returns [reserveA, reserveB, mintA, mintB] as bigints / PublicKeys.
   * Matches the shape the rest of the backend expects.
   */
  async getReserves(poolAddress) {
    const r = await getPoolReserves(this.connection, poolAddress);
    return {
      reserveA: r.reserveA,
      reserveB: r.reserveB,
      decimalsA: r.decimalsA,
      decimalsB: r.decimalsB,
      mintA: r.mintA,
      mintB: r.mintB,
    };
  }

  /**
   * Quote a swap using the Rust binary (same math as the on-chain program).
   * tokenInMint / tokenOutMint: base58 strings.
   * Returns { amountIn, amountOut, tradeFee, ownerFee } (all bigint).
   */
  async calculateSwapSAMM(amountOut, tokenInMint, tokenOutMint, poolAddress) {
    if (!RUST_AVAILABLE) throw new Error('Rust binary not built — run: npm run rust:build');

    const r = await getPoolReserves(this.connection, poolAddress);
    const mintAStr = r.mintA.toBase58();

    let sourceReserve, destReserve;
    if (mintAStr === (typeof tokenInMint === 'string' ? tokenInMint : tokenInMint.toBase58())) {
      sourceReserve = Number(r.reserveA);
      destReserve   = Number(r.reserveB);
    } else {
      sourceReserve = Number(r.reserveB);
      destReserve   = Number(r.reserveA);
    }

    const feeNum   = Number(r.state.tradeFeeNumerator);
    const feeDenom = Number(r.state.tradeFeeDenominator);

    const res = rustCall('swap-samm', {
      output_amount:  Number(amountOut),
      source_reserve: sourceReserve,
      dest_reserve:   destReserve,
      trade_fee_num:  feeNum   || 25,
      trade_fee_denom:feeDenom || 10000,
      owner_fee_num:  0,
      owner_fee_denom:1,
    });

    return {
      amountIn:  BigInt(res.amount_in),
      amountOut: BigInt(res.amount_out),
      tradeFee:  BigInt(res.trade_fee),
      ownerFee:  BigInt(res.owner_fee),
    };
  }

  /**
   * Execute a swap on-chain.
   * slippageBps: basis-points tolerance on amountIn (default 100 = 1%).
   */
  async swapSAMM(amountOut, maxAmountIn, tokenInMint, tokenOutMint, poolAddress) {
    if (!this.keypair) throw new Error('No keypair — read-only mode');
    const sig = await executeSwap(
      this.connection,
      this.keypair,
      this.programId,
      poolAddress,
      tokenInMint,
      tokenOutMint,
      BigInt(amountOut),
      BigInt(maxAmountIn),
    );
    return sig;
  }

  // ── Deployment helpers ─────────────────────────────────────────

  /** Return all known pools for a token pair (symbol strings). */
  getPoolsForPair(tokenASymbol, tokenBSymbol) {
    const key1 = `${tokenASymbol}-${tokenBSymbol}`;
    const key2 = `${tokenBSymbol}-${tokenASymbol}`;
    return this.deployment.pools[key1] || this.deployment.pools[key2] || [];
  }

  /** Return mint address (base58) for a token symbol. */
  getMint(symbol) {
    const t = this.deployment.tokens[symbol];
    if (!t) throw new Error(`Unknown token: ${symbol}`);
    return t.mint;
  }

  getDecimals(symbol) {
    return this.deployment.tokens[symbol]?.decimals ?? 6;
  }
}

module.exports = SolanaAdapter;
