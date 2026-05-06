'use strict';
/**
 * Solana Client — pool state reads + instruction builders for the
 * spl-token-swap / SAMM program.
 *
 * All public-key parameters may be either a PublicKey instance or a
 * base-58 string; helpers normalise them automatically.
 */

const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

// ── Constants ─────────────────────────────────────────────────────
const POOL_STATE_SIZE = 324; // bytes in the on-chain pool state account

// ── Helpers ───────────────────────────────────────────────────────
function pk(v) {
  return typeof v === 'string' ? new PublicKey(v) : v;
}

function readU64LE(buf, offset) {
  // Node.js Buffer can read BigUInt64LE directly
  return buf.readBigUInt64LE(offset);
}

function readPubkey(buf, offset) {
  return new PublicKey(buf.slice(offset, offset + 32));
}

// ── Pool state parser ─────────────────────────────────────────────
/**
 * Parse the 324-byte on-chain pool state account into a plain object.
 * Layout matches TokenSwapLayout in the TypeScript client.
 */
function parsePoolState(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < POOL_STATE_SIZE) {
    throw new Error(`Pool account data too small: ${buf.length} (expected ${POOL_STATE_SIZE})`);
  }
  let o = 0;
  const version       = buf[o++];
  const isInitialized = buf[o++] === 1;
  const bumpSeed      = buf[o++];
  const poolTokenProgramId   = readPubkey(buf, o); o += 32;
  const tokenAccountA        = readPubkey(buf, o); o += 32;
  const tokenAccountB        = readPubkey(buf, o); o += 32;
  const tokenPool            = readPubkey(buf, o); o += 32;
  const mintA                = readPubkey(buf, o); o += 32;
  const mintB                = readPubkey(buf, o); o += 32;
  const feeAccount           = readPubkey(buf, o); o += 32;
  const tradeFeeNumerator          = readU64LE(buf, o); o += 8;
  const tradeFeeDenominator        = readU64LE(buf, o); o += 8;
  const ownerTradeFeeNumerator     = readU64LE(buf, o); o += 8;
  const ownerTradeFeeDenominator   = readU64LE(buf, o); o += 8;
  const ownerWithdrawFeeNumerator  = readU64LE(buf, o); o += 8;
  const ownerWithdrawFeeDenominator= readU64LE(buf, o); o += 8;
  const hostFeeNumerator           = readU64LE(buf, o); o += 8;
  const hostFeeDenominator         = readU64LE(buf, o); o += 8;
  const curveType      = buf[o++];
  const curveParameters = buf.slice(o, o + 32);

  return {
    version, isInitialized, bumpSeed,
    poolTokenProgramId, tokenAccountA, tokenAccountB,
    tokenPool, mintA, mintB, feeAccount,
    tradeFeeNumerator, tradeFeeDenominator,
    ownerTradeFeeNumerator, ownerTradeFeeDenominator,
    ownerWithdrawFeeNumerator, ownerWithdrawFeeDenominator,
    hostFeeNumerator, hostFeeDenominator,
    curveType, curveParameters,
  };
}

// ── On-chain reads ────────────────────────────────────────────────
async function getPoolState(connection, poolAddress) {
  const key = pk(poolAddress);
  const info = await connection.getAccountInfo(key);
  if (!info) throw new Error(`Pool account not found: ${key.toBase58()}`);
  return parsePoolState(Buffer.from(info.data));
}

async function getTokenBalance(connection, tokenAccountAddress) {
  const key = pk(tokenAccountAddress);
  const resp = await connection.getTokenAccountBalance(key);
  const v = resp.value;
  return {
    amount: BigInt(v.amount),
    decimals: v.decimals,
    uiAmount: v.uiAmount,
  };
}

/**
 * Read pool reserves from chain.
 * Returns { state, reserveA, reserveB, decimalsA, decimalsB, mintA, mintB }.
 */
async function getPoolReserves(connection, poolAddress) {
  const state = await getPoolState(connection, poolAddress);
  const [rA, rB] = await Promise.all([
    getTokenBalance(connection, state.tokenAccountA),
    getTokenBalance(connection, state.tokenAccountB),
  ]);
  return {
    state,
    reserveA: rA.amount,
    reserveB: rB.amount,
    decimalsA: rA.decimals,
    decimalsB: rB.decimals,
    mintA: state.mintA,
    mintB: state.mintB,
  };
}

// ── Swap authority PDA ────────────────────────────────────────────
function findSwapAuthority(programId, tokenSwap) {
  return PublicKey.findProgramAddressSync(
    [pk(tokenSwap).toBuffer()],
    pk(programId)
  ); // returns [pubkey, bumpSeed]
}

// ── Instruction builders ──────────────────────────────────────────

/**
 * Build a Swap instruction (opcode 1).
 * Uses the same account layout as the TypeScript TokenSwap.swapInstruction().
 */
function swapInstruction({
  programId,
  tokenSwap,
  authority,
  userTransferAuthority,
  userSource,
  poolSource,
  poolDestination,
  userDestination,
  poolMint,
  feeAccount,
  sourceMint,
  destinationMint,
  sourceTokenProgramId = TOKEN_PROGRAM_ID,
  destinationTokenProgramId = TOKEN_PROGRAM_ID,
  poolTokenProgramId = TOKEN_PROGRAM_ID,
  hostFeeAccount = null,
  amountOut,
  maximalAmountIn,
}) {
  // Encode: u8 instruction=1, u64 amount_out (exact output wanted), u64 maximal_amount_in (ceiling)
  const data = Buffer.allocUnsafe(1 + 8 + 8);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(BigInt(amountOut), 1);
  data.writeBigUInt64LE(BigInt(maximalAmountIn), 9);

  const keys = [
    { pubkey: pk(tokenSwap),             isSigner: false, isWritable: false },
    { pubkey: pk(authority),             isSigner: false, isWritable: false },
    // SAMM uses invoke_signed with PDA seeds; outer tx does not need PDA signature
    { pubkey: pk(userTransferAuthority), isSigner: false, isWritable: false },
    { pubkey: pk(userSource),            isSigner: false, isWritable: true  },
    { pubkey: pk(poolSource),            isSigner: false, isWritable: true  },
    { pubkey: pk(poolDestination),       isSigner: false, isWritable: true  },
    { pubkey: pk(userDestination),       isSigner: false, isWritable: true  },
    { pubkey: pk(poolMint),              isSigner: false, isWritable: true  },
    { pubkey: pk(feeAccount),            isSigner: false, isWritable: true  },
    { pubkey: pk(sourceMint),            isSigner: false, isWritable: false },
    { pubkey: pk(destinationMint),       isSigner: false, isWritable: false },
    { pubkey: pk(sourceTokenProgramId),      isSigner: false, isWritable: false },
    { pubkey: pk(destinationTokenProgramId), isSigner: false, isWritable: false },
    { pubkey: pk(poolTokenProgramId),        isSigner: false, isWritable: false },
  ];
  if (hostFeeAccount) {
    keys.push({ pubkey: pk(hostFeeAccount), isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({ keys, programId: pk(programId), data });
}

/**
 * Build a DepositAllTokenTypes instruction (opcode 2).
 */
function depositAllInstruction({
  programId, tokenSwap, authority, userTransferAuthority,
  depositTokenA, depositTokenB, swapTokenA, swapTokenB,
  poolMint, destination,
  tokenProgramIdA = TOKEN_PROGRAM_ID,
  tokenProgramIdB = TOKEN_PROGRAM_ID,
  poolTokenProgramId = TOKEN_PROGRAM_ID,
  poolTokenAmount, maximumTokenA, maximumTokenB,
}) {
  const data = Buffer.allocUnsafe(1 + 8 + 8 + 8);
  data.writeUInt8(2, 0);
  data.writeBigUInt64LE(BigInt(poolTokenAmount), 1);
  data.writeBigUInt64LE(BigInt(maximumTokenA), 9);
  data.writeBigUInt64LE(BigInt(maximumTokenB), 17);

  const keys = [
    { pubkey: pk(tokenSwap),             isSigner: false, isWritable: false },
    { pubkey: pk(authority),             isSigner: false, isWritable: false },
    { pubkey: pk(userTransferAuthority), isSigner: true,  isWritable: false },
    { pubkey: pk(depositTokenA),         isSigner: false, isWritable: true  },
    { pubkey: pk(depositTokenB),         isSigner: false, isWritable: true  },
    { pubkey: pk(swapTokenA),            isSigner: false, isWritable: true  },
    { pubkey: pk(swapTokenB),            isSigner: false, isWritable: true  },
    { pubkey: pk(poolMint),              isSigner: false, isWritable: true  },
    { pubkey: pk(destination),           isSigner: false, isWritable: true  },
    { pubkey: pk(tokenProgramIdA),       isSigner: false, isWritable: false },
    { pubkey: pk(tokenProgramIdB),       isSigner: false, isWritable: false },
    { pubkey: pk(poolTokenProgramId),    isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: pk(programId), data });
}

/**
 * Build a WithdrawAllTokenTypes instruction (opcode 3).
 */
function withdrawAllInstruction({
  programId, tokenSwap, authority, userTransferAuthority,
  sourcePoolAccount, swapTokenA, swapTokenB,
  withdrawTokenA, withdrawTokenB, poolMint, feeAccount,
  tokenProgramIdA = TOKEN_PROGRAM_ID,
  tokenProgramIdB = TOKEN_PROGRAM_ID,
  poolTokenProgramId = TOKEN_PROGRAM_ID,
  poolTokenAmount, minimumTokenA, minimumTokenB,
}) {
  const data = Buffer.allocUnsafe(1 + 8 + 8 + 8);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(BigInt(poolTokenAmount), 1);
  data.writeBigUInt64LE(BigInt(minimumTokenA), 9);
  data.writeBigUInt64LE(BigInt(minimumTokenB), 17);

  const keys = [
    { pubkey: pk(tokenSwap),             isSigner: false, isWritable: false },
    { pubkey: pk(authority),             isSigner: false, isWritable: false },
    { pubkey: pk(userTransferAuthority), isSigner: true,  isWritable: false },
    { pubkey: pk(poolMint),              isSigner: false, isWritable: true  },
    { pubkey: pk(sourcePoolAccount),     isSigner: false, isWritable: true  },
    { pubkey: pk(swapTokenA),            isSigner: false, isWritable: true  },
    { pubkey: pk(swapTokenB),            isSigner: false, isWritable: true  },
    { pubkey: pk(withdrawTokenA),        isSigner: false, isWritable: true  },
    { pubkey: pk(withdrawTokenB),        isSigner: false, isWritable: true  },
    { pubkey: pk(feeAccount),            isSigner: false, isWritable: true  },
    { pubkey: pk(tokenProgramIdA),       isSigner: false, isWritable: false },
    { pubkey: pk(tokenProgramIdB),       isSigner: false, isWritable: false },
    { pubkey: pk(poolTokenProgramId),    isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: pk(programId), data });
}

// ── High-level helpers ────────────────────────────────────────────

/**
 * Execute an exact-output SAMM swap. The program takes the exact amount you want to receive
 * and pulls up to maximalAmountIn from the user's source account.
 *
 * @param {Connection} connection
 * @param {Keypair} payer           — fee payer and user wallet
 * @param {string} programId        — token swap program (base58)
 * @param {string} poolAddress      — token swap state account (base58)
 * @param {string} sourceMint       — mint of the token being sold (base58)
 * @param {string} destinationMint  — mint of the token being bought (base58)
 * @param {bigint} amountOut        — exact amount to receive (raw integer units)
 * @param {bigint} maximalAmountIn  — max willing to pay incl. slippage (raw integer units)
 * @param {string|null} [recentBlockhash]
 * @returns {Promise<string>} transaction signature
 */
async function executeSwap(
  connection,
  payer,
  programId,
  poolAddress,
  sourceMint,
  destinationMint,
  amountOut,
  maximalAmountIn,
  recentBlockhash = null,
) {
  const state = await getPoolState(connection, poolAddress);
  const [authority] = findSwapAuthority(programId, poolAddress);

  const srcMintKey = pk(sourceMint);
  const dstMintKey = pk(destinationMint);
  const mintAKey   = state.mintA;

  // Determine which pool token accounts are source vs destination
  const isASource = mintAKey.equals(srcMintKey);
  const poolSource = isASource ? state.tokenAccountA : state.tokenAccountB;
  const poolDest   = isASource ? state.tokenAccountB : state.tokenAccountA;

  // User ATAs
  const userSource = getAssociatedTokenAddressSync(srcMintKey, payer.publicKey);
  const userDest   = getAssociatedTokenAddressSync(dstMintKey, payer.publicKey);

  const tx = new Transaction();

  // Ensure user destination ATA exists
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userDest, payer.publicKey, dstMintKey
  ));

  // Approve the swap authority to pull up to maximalAmountIn from user's source account
  tx.add(createApproveInstruction(
    userSource, authority, payer.publicKey, maximalAmountIn
  ));

  // Swap instruction (exact output: program pulls exactly what the curve requires, up to maximalAmountIn)
  tx.add(swapInstruction({
    programId,
    tokenSwap: poolAddress,
    authority,
    userTransferAuthority: authority,
    userSource,
    poolSource,
    poolDestination: poolDest,
    userDestination: userDest,
    poolMint: state.tokenPool,
    feeAccount: state.feeAccount,
    sourceMint: srcMintKey,
    destinationMint: dstMintKey,
    poolTokenProgramId: state.poolTokenProgramId,
    amountOut,
    maximalAmountIn,
  }));

  if (recentBlockhash) {
    tx.recentBlockhash = recentBlockhash;
  } else {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
  }
  tx.feePayer = payer.publicKey;

  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
}

module.exports = {
  parsePoolState,
  getPoolState,
  getTokenBalance,
  getPoolReserves,
  findSwapAuthority,
  swapInstruction,
  depositAllInstruction,
  withdrawAllInstruction,
  executeSwap,
  POOL_STATE_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
};
