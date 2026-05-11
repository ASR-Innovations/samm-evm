#!/usr/bin/env node
'use strict';
/**
 * shard-health-check.js
 *
 * For every active shard (27 total):
 *   1. VERIFY  — reads on-chain reserves, TVL, LP supply, price vs oracle
 *   2. SWAP    — executes a ~$10 swap on that specific shard (exact-output)
 *   3. DEPOSIT — adds ~$10 liquidity ($5 each token) to that shard
 *
 * Usage:
 *   node scripts/shard-health-check.js              # all three phases
 *   node scripts/shard-health-check.js verify       # read-only
 *   node scripts/shard-health-check.js swap         # verify + swap only
 *   node scripts/shard-health-check.js deposit      # verify + deposit only
 */

require('dotenv').config();
const { Connection, Keypair, Transaction, PublicKey } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createApproveInstruction,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const {
  getPoolReserves,
  findSwapAuthority,
  swapInstruction,
  depositAllInstruction,
} = require('../solana-client/index.js');

const DATA       = require('../deployment-data/solana-devnet.json');
const PROGRAM_ID = process.env.SOLANA_PROGRAM_ID || DATA.programId;
const RPC        = process.env.SOLANA_RPC_URL    || 'https://api.devnet.solana.com';
const MODE       = (process.argv[2] || 'all').toLowerCase(); // all | verify | swap | deposit

const EXPLORER = sig => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const TARGET_USD = 10; // dollars per shard

// ── Colour helpers ──────────────────────────────────────────────────────────
const C = {
  reset:  s => `\x1b[0m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  blue:   s => `\x1b[34m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

// ── Token lookup ─────────────────────────────────────────────────────────────
const MINT_SYM = {};
for (const [sym, t] of Object.entries(DATA.tokens)) MINT_SYM[t.mint] = sym;

function tokenInfo(sym) { return DATA.tokens[sym]; }

function rawToHuman(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, '0');
  const i = s.length - decimals;
  const whole = s.slice(0, i);
  const frac  = s.slice(i, i + 6).replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function humanUSD(sym, rawAmount) {
  const t = tokenInfo(sym);
  if (!t) return 0;
  return (Number(rawAmount) / 10 ** t.decimals) * t.price;
}

// ── TX helper ────────────────────────────────────────────────────────────────
async function sendAndConfirm(connection, tx, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  const deadline = lastValidBlockHeight + 150;
  while (true) {
    const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
    if (value) {
      if (value.err) throw new Error('on-chain: ' + JSON.stringify(value.err));
      if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') return sig;
    }
    if (await connection.getBlockHeight() > deadline) throw new Error('tx expired');
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── Phase 1: Verify ──────────────────────────────────────────────────────────
async function verifyShard(connection, shard) {
  const r = await getPoolReserves(connection, shard.address);
  const lpInfo = await connection.getTokenSupply(r.state.tokenPool);
  const lpSupply = BigInt(lpInfo.value.amount);

  const symA = MINT_SYM[r.mintA.toBase58()];
  const symB = MINT_SYM[r.mintB.toBase58()];
  const tA   = tokenInfo(symA);
  const tB   = tokenInfo(symB);

  const rA_human = rawToHuman(r.reserveA, tA.decimals);
  const rB_human = rawToHuman(r.reserveB, tB.decimals);
  const tvl      = humanUSD(symA, r.reserveA) + humanUSD(symB, r.reserveB);

  // Spot price: how much A does 1 B cost
  const priceAperB = (Number(r.reserveA) / 10 ** tA.decimals) /
                     (Number(r.reserveB) / 10 ** tB.decimals);
  const oracleAperB = tB.price / tA.price;
  const devPct = ((priceAperB - oracleAperB) / oracleAperB * 100);

  console.log(`  ${C.dim('Reserve A :')} ${C.cyan(rA_human.padStart(20))} ${symA}`);
  console.log(`  ${C.dim('Reserve B :')} ${C.cyan(rB_human.padStart(20))} ${symB}`);
  console.log(`  ${C.dim('TVL       :')} $${tvl.toLocaleString('en-US', { maximumFractionDigits: 2 }).padStart(14)}`);
  console.log(`  ${C.dim('LP Supply :')} ${lpSupply.toLocaleString().padStart(20)}`);
  console.log(`  ${C.dim('Price dev :')} ${Math.abs(devPct) < 1 ? C.green(devPct.toFixed(4) + '%') : C.yellow(devPct.toFixed(4) + '%')}`);

  return { r, symA, symB, tA, tB, lpSupply };
}

// ── Phase 2: Swap ($10 worth, exact-output, buy symB pay symA) ───────────────
async function swapShard(connection, payer, shard, { r, symA, symB, tA, tB }) {
  // Target: buy $TARGET_USD of tokenB
  let amountOut = BigInt(Math.floor(TARGET_USD / tB.price * 10 ** tB.decimals));
  if (amountOut === 0n) throw new Error('amountOut rounds to 0');

  // If pool reserveB < 2x amountOut, scale down to 1% of reserveB so the trade fits
  if (r.reserveB > 0n && amountOut > r.reserveB / 2n) {
    amountOut = r.reserveB / 100n;
    if (amountOut === 0n) throw new Error('Pool too small to swap');
  }

  // maxIn: compute from actual pool price (reserveA/reserveB ratio) + 25% buffer
  // Exact-output constant product: amountIn = reserveA * amountOut / (reserveB - amountOut)
  const poolAmountIn = r.reserveA * amountOut / (r.reserveB - amountOut);
  const maxIn = poolAmountIn + poolAmountIn / 4n; // +25% buffer

  const [authority] = findSwapAuthority(PROGRAM_ID, shard.address);
  const isAIn   = r.mintA.toBase58() === (DATA.tokens[symA]?.mint || r.mintA.toBase58());
  const poolSrc  = isAIn ? r.state.tokenAccountA : r.state.tokenAccountB;
  const poolDest = isAIn ? r.state.tokenAccountB : r.state.tokenAccountA;

  const srcMint  = r.mintA; // paying A
  const dstMint  = r.mintB; // receiving B
  const userSrc  = getAssociatedTokenAddressSync(srcMint, payer.publicKey);
  const userDest = getAssociatedTokenAddressSync(dstMint, payer.publicKey);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, userDest, payer.publicKey, dstMint));
  tx.add(createApproveInstruction(userSrc, authority, payer.publicKey, maxIn));
  tx.add(swapInstruction({
    programId:              PROGRAM_ID,
    tokenSwap:              shard.address,
    authority,
    userTransferAuthority:  authority,
    userSource:             userSrc,
    poolSource:             poolSrc,
    poolDestination:        poolDest,
    userDestination:        userDest,
    poolMint:               r.state.tokenPool,
    feeAccount:             r.state.feeAccount,
    sourceMint:             srcMint,
    destinationMint:        dstMint,
    poolTokenProgramId:     r.state.poolTokenProgramId,
    amountOut,
    maximalAmountIn:        maxIn,
  }));

  const inHuman  = rawToHuman(maxIn, tA.decimals);
  const outHuman = rawToHuman(amountOut, tB.decimals);
  console.log(`  ${C.dim('Swap      :')} buying ${C.cyan(outHuman)} ${symB}, paying ≤${C.cyan(inHuman)} ${symA}`);

  const sig = await sendAndConfirm(connection, tx, [payer]);
  console.log(`  ${C.green('Swap ✓    :')} ${EXPLORER(sig)}`);
  return sig;
}

// ── Phase 3: Deposit ~$10 ($5 each token) ───────────────────────────────────
async function depositShard(connection, payer, shard, { symA, symB, tA, tB }) {
  // Re-read fresh reserves (swap may have changed them since verify)
  const r = await getPoolReserves(connection, shard.address);
  const lpInfo = await connection.getTokenSupply(r.state.tokenPool);
  const lpSupply = BigInt(lpInfo.value.amount);
  if (r.reserveA === 0n || r.reserveB === 0n) throw new Error('Pool is empty');

  // $5 worth of each token
  const halfUSD = TARGET_USD / 2;
  const rawA = BigInt(Math.floor(halfUSD / tA.price * 10 ** tA.decimals));
  const rawB = BigInt(Math.floor(halfUSD / tB.price * 10 ** tB.decimals));
  if (rawA === 0n || rawB === 0n) throw new Error('deposit amount rounds to 0');

  // LP tokens = supply * min(rawA/reserveA, rawB/reserveB)
  const lpFromA = lpSupply * rawA / r.reserveA;
  const lpFromB = lpSupply * rawB / r.reserveB;
  const poolTokenAmount = lpFromA < lpFromB ? lpFromA : lpFromB;
  if (poolTokenAmount === 0n) throw new Error('LP token amount rounds to 0');

  // +3% slippage on max inputs
  const maxA = rawA + rawA * 3n / 100n;
  const maxB = rawB + rawB * 3n / 100n;

  const poolMintKey = r.state.tokenPool;
  const userATA_A  = getAssociatedTokenAddressSync(r.mintA, payer.publicKey);
  const userATA_B  = getAssociatedTokenAddressSync(r.mintB, payer.publicKey);
  const userATA_LP = getAssociatedTokenAddressSync(poolMintKey, payer.publicKey);
  const [authority] = findSwapAuthority(PROGRAM_ID, shard.address);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, userATA_LP, payer.publicKey, poolMintKey));
  tx.add(depositAllInstruction({
    programId:            PROGRAM_ID,
    tokenSwap:            shard.address,
    authority,
    userTransferAuthority: payer.publicKey,
    depositTokenA:        userATA_A,
    depositTokenB:        userATA_B,
    swapTokenA:           new PublicKey(shard.tokenAccountA),
    swapTokenB:           new PublicKey(shard.tokenAccountB),
    poolMint:             poolMintKey,
    destination:          userATA_LP,
    mintA:                r.mintA,
    mintB:                r.mintB,
    poolTokenAmount,
    maximumTokenA:        maxA,
    maximumTokenB:        maxB,
  }));

  const hA = rawToHuman(rawA, tA.decimals);
  const hB = rawToHuman(rawB, tB.decimals);
  console.log(`  ${C.dim('Deposit   :')} ~${C.cyan(hA)} ${symA} + ~${C.cyan(hB)} ${symB} ($${TARGET_USD} total)`);

  const sig = await sendAndConfirm(connection, tx, [payer]);
  console.log(`  ${C.green('Deposit ✓ :')} ${EXPLORER(sig)}`);
  return sig;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.SOLANA_PRIVATE_KEY) {
    console.error('SOLANA_PRIVATE_KEY not set in .env'); process.exit(1);
  }

  const payer      = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
  const connection = new Connection(RPC, 'confirmed');

  const solBal = await connection.getBalance(payer.publicKey);

  const DO_SWAP    = MODE === 'all' || MODE === 'swap';
  const DO_DEPOSIT = MODE === 'all' || MODE === 'deposit';

  console.log(C.bold('\n══════════════════════════════════════════════════════════════'));
  console.log(C.bold('  SAMM Full Shard Health Check'));
  console.log(C.bold('══════════════════════════════════════════════════════════════'));
  console.log(`  Wallet  : ${payer.publicKey.toBase58()}`);
  console.log(`  SOL bal : ${(solBal / 1e9).toFixed(4)} SOL`);
  console.log(`  Program : ${PROGRAM_ID}`);
  console.log(`  RPC     : ${RPC}`);
  console.log(`  Mode    : ${MODE.toUpperCase()}  (verify${DO_SWAP ? ' + swap' : ''}${DO_DEPOSIT ? ' + deposit' : ''})`);
  console.log(`  Target  : $${TARGET_USD} per shard\n`);

  // Collect all shards except permanently broken ones (e.g. initialized 1:1 off oracle)
  const shards = [];
  for (const [pair, list] of Object.entries(DATA.pools)) {
    for (const s of list) if (!s.permanentlyInactive) shards.push({ pair, shard: s });
  }
  console.log(`  ${shards.length} active shards across ${Object.keys(DATA.pools).length} pairs\n`);

  const summary = { passed: 0, failed: 0, swapOk: 0, swapFail: 0, depositOk: 0, depositFail: 0 };
  const failures = [];

  for (let i = 0; i < shards.length; i++) {
    const { pair, shard } = shards[i];
    const label = shard.name || `${pair}-?`;

    console.log(C.bold(`\n[${String(i + 1).padStart(2)}/${shards.length}] ${label}`));
    console.log(`  ${C.dim('Pool    :')} ${shard.address}`);

    // ── Verify ──
    let info;
    try {
      info = await verifyShard(connection, shard);
      summary.passed++;
    } catch (e) {
      console.log(`  ${C.red('Verify ✗  :')} ${e.message}`);
      summary.failed++;
      failures.push({ label, phase: 'verify', error: e.message });
      continue;
    }

    // ── Swap ──
    if (DO_SWAP) {
      try {
        await swapShard(connection, payer, shard, info);
        summary.swapOk++;
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.log(`  ${C.red('Swap ✗    :')} ${e.message.split('\n')[0].slice(0, 120)}`);
        summary.swapFail++;
        failures.push({ label, phase: 'swap', error: e.message.split('\n')[0] });
      }
    }

    // ── Deposit ──
    if (DO_DEPOSIT) {
      try {
        await depositShard(connection, payer, shard, info);
        summary.depositOk++;
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.log(`  ${C.red('Deposit ✗ :')} ${e.message.split('\n')[0].slice(0, 120)}`);
        summary.depositFail++;
        failures.push({ label, phase: 'deposit', error: e.message.split('\n')[0] });
      }
    }
  }

  // ── Summary ──
  console.log(C.bold('\n══════════════════════════════════════════════════════════════'));
  console.log(C.bold('  Results'));
  console.log(C.bold('══════════════════════════════════════════════════════════════'));
  console.log(`  Verified : ${C.green(summary.passed + ' ✓')}  ${summary.failed ? C.red(summary.failed + ' ✗') : ''}`);
  if (DO_SWAP)    console.log(`  Swaps    : ${C.green(summary.swapOk + ' ✓')}  ${summary.swapFail ? C.red(summary.swapFail + ' ✗') : ''}`);
  if (DO_DEPOSIT) console.log(`  Deposits : ${C.green(summary.depositOk + ' ✓')}  ${summary.depositFail ? C.red(summary.depositFail + ' ✗') : ''}`);

  if (failures.length) {
    console.log(C.yellow('\n  Failures:'));
    for (const f of failures) {
      console.log(`    ${C.red('✗')} [${f.phase}] ${f.label}: ${f.error.slice(0, 100)}`);
    }
  } else {
    console.log(C.green('\n  All checks passed ✓'));
  }
  console.log(C.bold('══════════════════════════════════════════════════════════════\n'));
}

main().catch(e => { console.error(C.red('Fatal: ' + e.message)); process.exit(1); });
