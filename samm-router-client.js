'use strict';
/**
 * samm-router-client.js — JS helper for the on-chain SAMM Router program
 *
 * The SAMM Router program (samm-router/) performs all shard selection ON-CHAIN:
 *   - Reads reserves from every shard account at execution time
 *   - Applies the full SAMM adaptive-fee formula in Rust
 *   - Enforces the c-Non-Splitting Property (c = 0.96)
 *   - Selects the shard with the lowest amountIn (Smaller-Better Principle)
 *
 * This JS module builds the instruction data and account list for:
 *   routeSwap      — single-hop (e.g. USDC→USDT, WETH→USDC)
 *   routeSwapMulti — two-hop (e.g. WBTC→USDC→DAI)
 *
 * The JS side only needs to know WHICH shards to pass — not which one is best.
 * Shard selection is provably correct on-chain.
 */

const {
  PublicKey,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// ── Constants ────────────────────────────────────────────────────────────────

/** Opcode for route_swap (single hop) */
const OP_ROUTE_SWAP       = 0;
/** Opcode for route_swap_multi (two-hop) */
const OP_ROUTE_SWAP_MULTI = 1;

/** Accounts per shard group (must match the router program) */
const ACCS_PER_SHARD = 6;

/**
 * Solana legacy transactions are capped at 1232 bytes wire size.
 * With 7 fixed + 2 ATA-creation + 1 router-program accounts, each shard adds
 * 6 × 32 = 192 bytes.  The safe maximums (verified by exact size calculation):
 *   single-hop: 3 shards → ~1053 bytes
 *   each hop of multi: 1 shard → ~931 bytes total
 */
const MAX_SHARDS_SINGLE = 3;
const MAX_SHARDS_MULTI  = 1;

/** Sort order for shard name suffixes (largest = best per Smaller-Better) */
const SIZE_RANK = { XL: 4, Large: 3, Medium: 2, Small: 1 };

function shardSizeRank(shard) {
  for (const [suffix, rank] of Object.entries(SIZE_RANK)) {
    if (shard.name?.endsWith(suffix)) return rank;
  }
  return 0;
}

/** Return up to `limit` shards, sorted largest-first (best per Smaller-Better). */
function topShards(shards, limit) {
  return [...shards]
    .sort((a, b) => shardSizeRank(b) - shardSizeRank(a))
    .slice(0, limit);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pk(v) {
  return typeof v === 'string' ? new PublicKey(v) : v;
}

/**
 * Derive the pool authority PDA for a given pool state account.
 * seeds = [pool_state_pubkey]
 */
function findPoolAuthority(sammProgramId, poolStateAddress) {
  return PublicKey.findProgramAddressSync(
    [pk(poolStateAddress).toBuffer()],
    pk(sammProgramId),
  );
}

/**
 * Build the 6-account group for one shard.
 * Account order: pool_state, pool_authority, pool_token_a, pool_token_b, pool_mint, fee_account
 *
 * @param {string} sammProgramId  — deployed SAMM pool program
 * @param {object} shard          — { address, tokenAccountA, tokenAccountB, poolMint, feeAccount }
 *   (all fields come from solana-devnet.json or /pools endpoint)
 */
function shardAccounts(sammProgramId, shard) {
  const [authority] = findPoolAuthority(sammProgramId, shard.address);
  return [
    { pubkey: pk(shard.address),        isSigner: false, isWritable: true  }, // pool_state
    { pubkey: authority,                isSigner: false, isWritable: false }, // pool_authority
    { pubkey: pk(shard.tokenAccountA),  isSigner: false, isWritable: true  }, // pool_token_a
    { pubkey: pk(shard.tokenAccountB),  isSigner: false, isWritable: true  }, // pool_token_b
    { pubkey: pk(shard.poolMint),       isSigner: false, isWritable: true  }, // lp_mint
    { pubkey: pk(shard.feeAccount),     isSigner: false, isWritable: true  }, // fee_account
  ];
}

// ── Instruction builders ──────────────────────────────────────────────────────

/**
 * Build a `route_swap` instruction (single-hop, on-chain best-shard selection).
 *
 * @param {string}   routerProgramId  — deployed samm-router program ID
 * @param {string}   sammProgramId    — deployed SAMM pool program ID
 * @param {PublicKey} user            — user's wallet public key
 * @param {string}   sourceMint       — input token mint address
 * @param {string}   destMint         — output token mint address
 * @param {bigint}   amountOut        — exact output desired (raw units)
 * @param {bigint}   maxAmountIn      — max input to spend (slippage ceiling)
 * @param {object[]} shards           — array of shard descriptors from deployment JSON
 * @returns {TransactionInstruction}
 */
function routeSwapInstruction({
  routerProgramId,
  sammProgramId,
  user,
  sourceMint,
  destMint,
  amountOut,
  maxAmountIn,
  shards,
}) {
  if (!shards.length || shards.length > 16) {
    throw new Error(`shards must be 1-16, got ${shards.length}`);
  }

  // Instruction data: [opcode(1), amount_out(8), max_amount_in(8), num_shards(1)]
  const data = Buffer.allocUnsafe(18);
  data.writeUInt8(OP_ROUTE_SWAP, 0);
  data.writeBigUInt64LE(BigInt(amountOut),    1);
  data.writeBigUInt64LE(BigInt(maxAmountIn),  9);
  data.writeUInt8(shards.length,              17);

  const userSourceATA = getAssociatedTokenAddressSync(pk(sourceMint), pk(user));
  const userDestATA   = getAssociatedTokenAddressSync(pk(destMint),   pk(user));

  // Fixed accounts (7)
  const keys = [
    { pubkey: pk(user),                    isSigner: true,  isWritable: false }, // 0: user
    { pubkey: userSourceATA,               isSigner: false, isWritable: true  }, // 1: user_source_ata
    { pubkey: userDestATA,                 isSigner: false, isWritable: true  }, // 2: user_dest_ata
    { pubkey: pk(sourceMint),              isSigner: false, isWritable: false }, // 3: source_mint
    { pubkey: pk(destMint),                isSigner: false, isWritable: false }, // 4: dest_mint
    { pubkey: pk(sammProgramId),           isSigner: false, isWritable: false }, // 5: samm_program
    { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false }, // 6: token_program
  ];

  // Per-shard accounts (6 each)
  for (const shard of shards) {
    keys.push(...shardAccounts(sammProgramId, shard));
  }

  return new TransactionInstruction({
    keys,
    programId: pk(routerProgramId),
    data,
  });
}

/**
 * Build a `route_swap_multi` instruction (two-hop, on-chain best-shard selection per hop).
 *
 * @param {string}   routerProgramId  — deployed samm-router program ID
 * @param {string}   sammProgramId    — deployed SAMM pool program ID
 * @param {PublicKey} user
 * @param {string}   sourceMint       — first token mint
 * @param {string}   midMint          — intermediate token mint (e.g. USDC)
 * @param {string}   destMint         — final output token mint
 * @param {bigint}   amountOut        — exact final output desired (raw)
 * @param {bigint}   maxAmountIn      — max source tokens to spend (raw)
 * @param {object[]} shardsHop1       — shards for source→mid pair
 * @param {object[]} shardsHop2       — shards for mid→dest pair
 * @returns {TransactionInstruction}
 */
function routeSwapMultiInstruction({
  routerProgramId,
  sammProgramId,
  user,
  sourceMint,
  midMint,
  destMint,
  amountOut,
  maxAmountIn,
  shardsHop1,
  shardsHop2,
}) {
  if (!shardsHop1.length || shardsHop1.length > 8) throw new Error('shardsHop1 must be 1-8');
  if (!shardsHop2.length || shardsHop2.length > 8) throw new Error('shardsHop2 must be 1-8');

  // Data: [opcode(1), amount_out(8), max_amount_in(8), n_shards_hop1(1), n_shards_hop2(1)]
  const data = Buffer.allocUnsafe(19);
  data.writeUInt8(OP_ROUTE_SWAP_MULTI, 0);
  data.writeBigUInt64LE(BigInt(amountOut),   1);
  data.writeBigUInt64LE(BigInt(maxAmountIn), 9);
  data.writeUInt8(shardsHop1.length,         17);
  data.writeUInt8(shardsHop2.length,         18);

  const userSourceATA = getAssociatedTokenAddressSync(pk(sourceMint), pk(user));
  const userMidATA    = getAssociatedTokenAddressSync(pk(midMint),    pk(user));
  const userDestATA   = getAssociatedTokenAddressSync(pk(destMint),   pk(user));

  // Fixed accounts (9)
  const keys = [
    { pubkey: pk(user),           isSigner: true,  isWritable: false }, // 0: user
    { pubkey: userSourceATA,      isSigner: false, isWritable: true  }, // 1: user_source_ata
    { pubkey: userMidATA,         isSigner: false, isWritable: true  }, // 2: user_mid_ata
    { pubkey: userDestATA,        isSigner: false, isWritable: true  }, // 3: user_dest_ata
    { pubkey: pk(sourceMint),     isSigner: false, isWritable: false }, // 4: source_mint
    { pubkey: pk(midMint),        isSigner: false, isWritable: false }, // 5: mid_mint
    { pubkey: pk(destMint),       isSigner: false, isWritable: false }, // 6: dest_mint
    { pubkey: pk(sammProgramId),  isSigner: false, isWritable: false }, // 7: samm_program
    { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false }, // 8: token_program
  ];

  // Hop-1 shard accounts, then hop-2
  for (const shard of shardsHop1) {
    keys.push(...shardAccounts(sammProgramId, shard));
  }
  for (const shard of shardsHop2) {
    keys.push(...shardAccounts(sammProgramId, shard));
  }

  return new TransactionInstruction({
    keys,
    programId: pk(routerProgramId),
    data,
  });
}

// ── High-level swap builder ───────────────────────────────────────────────────

/**
 * Build a complete atomic transaction that routes via the on-chain SAMM Router.
 *
 * The router program:
 *   1. Reads reserves of all provided shards on-chain
 *   2. Computes SAMM fee + constant-product math for each
 *   3. Enforces c-Non-Splitting: single-shard if amountOut < 0.96 × destReserve
 *   4. Selects best shard (lowest amountIn) — Smaller-Better Principle
 *   5. Issues Approve + SwapSAMM CPIs
 *
 * For multi-hop routes, BOTH hops execute in the SAME atomic transaction.
 * The user signs ONCE.
 *
 * @param {Connection}  connection
 * @param {Keypair}     payer       — fee payer + signer
 * @param {string}      routerProgramId
 * @param {string}      sammProgramId
 * @param {object}      deployment  — parsed solana-devnet.json
 * @param {string}      tokenInSym
 * @param {string}      tokenOutSym
 * @param {bigint}      amountOut
 * @param {bigint}      slippageBps — e.g. 100n = 1%
 * @returns {{ tx: Transaction, routePath: string, hops: number }}
 */
async function buildRouterTransaction({
  connection,
  payer,
  routerProgramId,
  sammProgramId,
  deployment,
  tokenInSym,
  tokenOutSym,
  amountOut,
  slippageBps = 100n,
  // Optional: pre-computed max input (in source-token raw units).
  // When provided, the slippage ceiling is exact.  When omitted, a conservative
  // fallback of amountOut × 10 is used (avoids cross-decimal mis-scaling).
  maxAmountIn = null,
}) {
  const tx = new Transaction();

  function getPoolsForPair(a, b) {
    return deployment.pools[`${a}-${b}`] || deployment.pools[`${b}-${a}`] || [];
  }

  function ensureATA(mint) {
    const ata = getAssociatedTokenAddressSync(pk(mint), payer.publicKey);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, ata, payer.publicKey, pk(mint),
    ));
    return ata;
  }

  // maxIn must be in SOURCE token units.  If not supplied, use a conservative
  // 10× amountOut as a safe upper bound (the on-chain router will still enforce
  // the tightest bound it can compute from live reserves).
  const maxIn = maxAmountIn != null
    ? BigInt(maxAmountIn)
    : amountOut * 10n + 1n;

  const directShards = getPoolsForPair(tokenInSym, tokenOutSym)
    .filter(s => !s.inactive);

  let routePath, hops;

  if (directShards.length) {
    // ── Single-hop ────────────────────────────────────────────────────────────
    routePath = `${tokenInSym}→${tokenOutSym}`;
    hops      = 1;

    const inMint  = deployment.tokens[tokenInSym].mint;
    const outMint = deployment.tokens[tokenOutSym].mint;

    ensureATA(outMint);

    // Limit to MAX_SHARDS_SINGLE largest shards (tx size constraint: ~1053 bytes for 3 shards)
    const selectedShards = topShards(directShards, MAX_SHARDS_SINGLE);
    const hydratedShards = await hydrateShards(connection, selectedShards);

    tx.add(routeSwapInstruction({
      routerProgramId,
      sammProgramId,
      user:        payer.publicKey,
      sourceMint:  inMint,
      destMint:    outMint,
      amountOut,
      maxAmountIn: maxIn,
      shards:      hydratedShards,
    }));
  } else {
    // ── Two-hop via bridge token ───────────────────────────────────────────────
    const bridges = ['USDC', 'USDT', 'DAI', 'WETH'];
    let mid = null, hop1Shards = null, hop2Shards = null;

    for (const b of bridges) {
      if (b === tokenInSym || b === tokenOutSym) continue;
      const h1 = getPoolsForPair(tokenInSym, b).filter(s => !s.inactive);
      const h2 = getPoolsForPair(b, tokenOutSym).filter(s => !s.inactive);
      if (h1.length && h2.length) { mid = b; hop1Shards = h1; hop2Shards = h2; break; }
    }

    if (!mid) {
      throw new Error(`No route found for ${tokenInSym}→${tokenOutSym}`);
    }

    routePath = `${tokenInSym}→${mid}→${tokenOutSym}`;
    hops      = 2;

    const inMint  = deployment.tokens[tokenInSym].mint;
    const midMint = deployment.tokens[mid].mint;
    const outMint = deployment.tokens[tokenOutSym].mint;

    ensureATA(midMint);
    ensureATA(outMint);

    // Multi-hop: 1 shard per hop (tx size constraint: 2 hops × 6 accounts each)
    const hydratedHop1 = await hydrateShards(connection, topShards(hop1Shards, MAX_SHARDS_MULTI));
    const hydratedHop2 = await hydrateShards(connection, topShards(hop2Shards, MAX_SHARDS_MULTI));

    tx.add(routeSwapMultiInstruction({
      routerProgramId,
      sammProgramId,
      user:        payer.publicKey,
      sourceMint:  inMint,
      midMint,
      destMint:    outMint,
      amountOut,
      maxAmountIn: maxIn,
      shardsHop1:  hydratedHop1,
      shardsHop2:  hydratedHop2,
    }));
  }

  return { tx, routePath, hops };
}

/**
 * Fetch on-chain pool state for each shard to get tokenAccountA/B, poolMint, feeAccount.
 * These are needed to build the account keys for the router instruction.
 */
async function hydrateShards(connection, shards) {
  const { getPoolReserves } = require('./solana-client');
  return Promise.all(shards.map(async s => {
    const { state } = await getPoolReserves(connection, s.address);
    return {
      address:      s.address,
      tokenAccountA: state.tokenAccountA.toBase58(),
      tokenAccountB: state.tokenAccountB.toBase58(),
      poolMint:      state.tokenPool.toBase58(),
      feeAccount:    state.feeAccount.toBase58(),
    };
  }));
}

/**
 * Execute a swap through the on-chain router.
 * Returns the transaction signature.
 */
async function routerSwap({
  connection, keypair, routerProgramId, sammProgramId, deployment,
  tokenInSym, tokenOutSym, amountOut, slippageBps = 100n,
  maxAmountIn = null,
}) {
  const { tx, routePath, hops } = await buildRouterTransaction({
    connection, payer: keypair, routerProgramId, sammProgramId, deployment,
    tokenInSym, tokenOutSym, amountOut, slippageBps, maxAmountIn,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  // Polling-based confirmation — avoids signatureSubscribe WebSocket dependency
  const deadline = lastValidBlockHeight;
  while (true) {
    const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
    if (value) {
      if (value.err) throw new Error('Transaction failed on-chain: ' + JSON.stringify(value.err));
      if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') break;
    }
    const currentHeight = await connection.getBlockHeight();
    if (currentHeight > deadline) throw new Error('Transaction expired (block height exceeded): ' + sig);
    await new Promise(r => setTimeout(r, 1500));
  }

  return { sig, routePath, hops };
}

module.exports = {
  routeSwapInstruction,
  routeSwapMultiInstruction,
  buildRouterTransaction,
  routerSwap,
  hydrateShards,
  shardAccounts,
  findPoolAuthority,
};
