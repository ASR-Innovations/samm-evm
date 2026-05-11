'use strict';
/**
 * test-liquidity.js — test depositAllTokenTypes on every active pool shard.
 *
 * Deposits 0.5% of current reserves into each shard, then withdraws it all back.
 * Uses the correct signer pattern: userTransferAuthority = payer keypair (isSigner: true).
 * No createApproveInstruction needed — user signs directly.
 *
 * Usage:
 *   node scripts/test-liquidity.js              # deposit + withdraw all 27 active shards
 *   node scripts/test-liquidity.js deposit      # deposit only
 *   node scripts/test-liquidity.js withdraw     # withdraw only (needs prior deposit)
 */

require('dotenv').config();
const { Connection, Keypair, Transaction, PublicKey } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const {
  getPoolReserves,
  findSwapAuthority,
  depositAllInstruction,
  withdrawAllInstruction,
} = require('../solana-client/index.js');

const DATA = require('../deployment-data/solana-devnet.json');
const PROGRAM_ID = process.env.SOLANA_PROGRAM_ID || DATA.programId;
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const MODE = (process.argv[2] || 'both').toLowerCase(); // deposit | withdraw | both

// Build mint → symbol map
const MINT_SYM = {};
const SYM_MINT = {};
for (const [sym, t] of Object.entries(DATA.tokens)) {
  MINT_SYM[t.mint] = sym;
  SYM_MINT[sym] = t.mint;
}

function parsePair(pairKey) {
  const [a, b] = pairKey.split('-');
  return { symA: a, symB: b, mintA: SYM_MINT[a], mintB: SYM_MINT[b] };
}

async function getLpSupply(connection, poolMintAddr) {
  const res = await connection.getTokenSupply(new PublicKey(poolMintAddr));
  return BigInt(res.value.amount);
}

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
      if (value.err) throw new Error('on-chain error: ' + JSON.stringify(value.err));
      if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
        return sig;
      }
    }
    const h = await connection.getBlockHeight();
    if (h > deadline) throw new Error('tx expired: ' + sig);
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function depositShard(connection, payer, pair, shard) {
  const { symA, symB } = parsePair(pair);
  const r = await getPoolReserves(connection, shard.address);

  // Use 0.5% of each reserve — pure BigInt arithmetic
  const rawA = r.reserveA / 200n;
  const rawB = r.reserveB / 200n;
  if (rawA === 0n || rawB === 0n) throw new Error('Reserves too small for 0.5% deposit');

  const totalSupply = await getLpSupply(connection, shard.poolMint);
  if (totalSupply === 0n) throw new Error('LP mint supply is 0');

  // LP tokens to request = totalSupply * 0.5% (conservative lower bound)
  const poolTokenAmount = totalSupply / 200n;
  if (poolTokenAmount === 0n) throw new Error('LP token amount rounds to 0');

  // maxA/maxB = requested + 2% slippage
  const maxA = rawA + rawA / 50n;
  const maxB = rawB + rawB / 50n;

  const mintAKey = new PublicKey(SYM_MINT[symA]);
  const mintBKey = new PublicKey(SYM_MINT[symB]);
  const poolMintKey = new PublicKey(shard.poolMint);

  const userATA_A = getAssociatedTokenAddressSync(mintAKey, payer.publicKey);
  const userATA_B = getAssociatedTokenAddressSync(mintBKey, payer.publicKey);
  const userATA_LP = getAssociatedTokenAddressSync(poolMintKey, payer.publicKey);

  const [authority] = findSwapAuthority(PROGRAM_ID, shard.address);

  const tx = new Transaction();
  // Ensure LP ATA exists
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userATA_LP, payer.publicKey, poolMintKey
  ));
  tx.add(depositAllInstruction({
    programId: PROGRAM_ID,
    tokenSwap: shard.address,
    authority,
    userTransferAuthority: payer.publicKey,
    depositTokenA: userATA_A,
    depositTokenB: userATA_B,
    swapTokenA: new PublicKey(shard.tokenAccountA),
    swapTokenB: new PublicKey(shard.tokenAccountB),
    poolMint: poolMintKey,
    destination: userATA_LP,
    mintA: r.mintA,
    mintB: r.mintB,
    poolTokenAmount,
    maximumTokenA: maxA,
    maximumTokenB: maxB,
  }));

  return sendAndConfirm(connection, tx, [payer]);
}

async function withdrawShard(connection, payer, pair, shard) {
  const { symA, symB } = parsePair(pair);

  const mintAKey = new PublicKey(SYM_MINT[symA]);
  const mintBKey = new PublicKey(SYM_MINT[symB]);
  const poolMintKey = new PublicKey(shard.poolMint);

  const userATA_LP = getAssociatedTokenAddressSync(poolMintKey, payer.publicKey);

  // Read LP balance — withdraw ALL we hold
  const lpBal = await connection.getTokenAccountBalance(userATA_LP).catch(() => null);
  if (!lpBal || lpBal.value.uiAmount === 0) throw new Error('No LP tokens to withdraw');
  const poolTokenAmount = BigInt(lpBal.value.amount);

  const userATA_A = getAssociatedTokenAddressSync(mintAKey, payer.publicKey);
  const userATA_B = getAssociatedTokenAddressSync(mintBKey, payer.publicKey);
  const [authority] = findSwapAuthority(PROGRAM_ID, shard.address);

  // Fetch current pool state for fee account and mints
  const { state, mintA: mintAKey2, mintB: mintBKey2 } = await getPoolReserves(connection, shard.address);

  const tx = new Transaction();
  tx.add(withdrawAllInstruction({
    programId: PROGRAM_ID,
    tokenSwap: shard.address,
    authority,
    userTransferAuthority: payer.publicKey,
    sourcePoolAccount: userATA_LP,
    swapTokenA: new PublicKey(shard.tokenAccountA),
    swapTokenB: new PublicKey(shard.tokenAccountB),
    withdrawTokenA: userATA_A,
    withdrawTokenB: userATA_B,
    poolMint: poolMintKey,
    feeAccount: state.feeAccount,
    mintA: mintAKey2,
    mintB: mintBKey2,
    poolTokenAmount,
    minimumTokenA: 0n,
    minimumTokenB: 0n,
  }));

  return sendAndConfirm(connection, tx, [payer]);
}

async function main() {
  if (!process.env.SOLANA_PRIVATE_KEY) {
    console.error('SOLANA_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const keyBytes = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
  const payer = Keypair.fromSecretKey(keyBytes);
  const connection = new Connection(RPC, 'confirmed');

  console.log(`\nSAMM Liquidity Test — ${MODE.toUpperCase()}`);
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);
  console.log(`RPC:    ${RPC}\n`);

  // Collect all active shards
  const shards = [];
  for (const [pair, list] of Object.entries(DATA.pools)) {
    for (const s of list) {
      if (!s.inactive) shards.push({ pair, shard: s });
    }
  }
  console.log(`Testing ${shards.length} active shards...\n`);

  let passed = 0, failed = 0;
  const results = [];

  for (const { pair, shard } of shards) {
    const label = shard.name || `${pair}-?`;
    process.stdout.write(`  ${label.padEnd(24)}`);

    try {
      if (MODE === 'deposit' || MODE === 'both') {
        const sig = await depositShard(connection, payer, pair, shard);
        process.stdout.write(`  deposit ✓  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      }
      if (MODE === 'withdraw' || MODE === 'both') {
        const sig = await withdrawShard(connection, payer, pair, shard);
        process.stdout.write(`  withdraw ✓`);
      }
      console.log();
      passed++;
      results.push({ name: label, ok: true });
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
      failed++;
      results.push({ name: label, ok: false, error: e.message });
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed}/${shards.length} passed${failed ? `, ${failed} failed` : ''}`);
  if (failed > 0) {
    console.log('\nFailed shards:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ${r.name}: ${r.error}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
