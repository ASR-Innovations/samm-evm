#!/usr/bin/env node
'use strict';
/**
 * Initialize all SAMM pools on devnet.
 *
 * Creates 7 trading pairs × 4 shards each = 28 pools.
 * Existing pools (by address in the JSON) are skipped automatically.
 *
 * Fee structure (per the research paper):
 *   - Stable pairs (USDC-USDT, USDC-DAI, USDT-DAI): 5 bps  (0.05%)
 *   - Regular pairs (WETH/WBTC/DAI vs USDC/USDT):   10 bps (0.10%)
 *
 * Shard sizes (USD liquidity each side):
 *   S1 = Small:  $10,000  | S2 = Medium: $50,000
 *   S3 = Large: $200,000  | S4 = XL:   $1,000,000
 */

const {
  Connection, Keypair, PublicKey,
  SystemProgram, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  createAccount,
  createInitializeMintInstruction,
  createTransferInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  mintTo,
} = require('@solana/spl-token');
const { TransactionInstruction } = require('@solana/web3.js');
const bs58  = require('bs58');
const fs    = require('fs');
const path  = require('path');
require('dotenv').config();

const DEPLOY_JSON = path.join(__dirname, '..', 'deployment-data', 'solana-devnet.json');
const RPC_URL     = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID  = process.env.SOLANA_PROGRAM_ID;

if (!PROGRAM_ID)                  { console.error('❌ SOLANA_PROGRAM_ID not set'); process.exit(1); }
if (!process.env.SOLANA_PRIVATE_KEY) { console.error('❌ SOLANA_PRIVATE_KEY not set'); process.exit(1); }

const connection = new Connection(RPC_URL, 'confirmed');
const payer      = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
const programPk  = new PublicKey(PROGRAM_ID);

// ── Pair definitions ──────────────────────────────────────────────────────────

// Approximate prices (for computing balanced shard liquidity)
const PRICES = { USDC: 1, USDT: 1, DAI: 1, WETH: 3000, WBTC: 65000 };

// fee_numerator / 10000 = fee rate
// 5 = 0.05%  (stable),  10 = 0.10% (regular)
const PAIRS = [
  { key: 'USDC-USDT', symA: 'USDC', symB: 'USDT', feeBps: 5,  type: 'stable'  },
  { key: 'USDC-DAI',  symA: 'USDC', symB: 'DAI',  feeBps: 5,  type: 'stable'  },
  { key: 'USDT-DAI',  symA: 'USDT', symB: 'DAI',  feeBps: 5,  type: 'stable'  },
  { key: 'WETH-USDC', symA: 'WETH', symB: 'USDC', feeBps: 10, type: 'regular' },
  { key: 'WBTC-USDC', symA: 'WBTC', symB: 'USDC', feeBps: 10, type: 'regular' },
  { key: 'WETH-WBTC', symA: 'WETH', symB: 'WBTC', feeBps: 10, type: 'regular' },
  { key: 'WETH-USDT', symA: 'WETH', symB: 'USDT', feeBps: 10, type: 'regular' },
];

// USD liquidity per side per shard tier
const SHARD_USD = [10_000, 50_000, 200_000, 1_000_000];
const SHARD_NAMES = ['Small', 'Medium', 'Large', 'XL'];

// ── Instruction builder ───────────────────────────────────────────────────────

function encodeInitInstruction({ tradeFeeNum, ownerFeeNum, curveType = 0 }) {
  const buf = Buffer.allocUnsafe(1 + 8 * 8 + 1 + 32);
  let o = 0;
  const DENOM = 10000n;
  buf.writeUInt8(0, o); o += 1;
  buf.writeBigUInt64LE(BigInt(tradeFeeNum), o); o += 8;  // trade_fee_numerator
  buf.writeBigUInt64LE(DENOM, o); o += 8;                 // trade_fee_denominator
  buf.writeBigUInt64LE(BigInt(ownerFeeNum), o); o += 8;  // owner_fee_numerator
  buf.writeBigUInt64LE(DENOM, o); o += 8;                 // owner_fee_denominator
  buf.writeBigUInt64LE(0n, o); o += 8;                    // withdraw_fee_numerator
  buf.writeBigUInt64LE(1n, o); o += 8;                    // withdraw_fee_denominator
  buf.writeBigUInt64LE(0n, o); o += 8;                    // host_fee_numerator
  buf.writeBigUInt64LE(1n, o); o += 8;                    // host_fee_denominator
  buf.writeUInt8(curveType, o); o += 1;
  buf.fill(0, o);
  return buf;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateMint(sym, decimals) {
  const d = deployment.tokens[sym];
  if (d?.mint && d.mint.length > 10) {
    console.log(`   ✓ ${sym} mint: ${d.mint}`);
    return new PublicKey(d.mint);
  }
  console.log(`   Creating ${sym} mint (${decimals} dec)...`);
  const kp = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
      space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(kp.publicKey, decimals, payer.publicKey, payer.publicKey),
  ), [payer, kp]);
  console.log(`   ✅ ${sym}: ${kp.publicKey.toBase58()}`);
  if (!deployment.tokens[sym]) deployment.tokens[sym] = { decimals, price: PRICES[sym] || 1 };
  deployment.tokens[sym].mint = kp.publicKey.toBase58();
  return kp.publicKey;
}

function seedAmounts(symA, symB, usdPerSide, decA, decB) {
  const priceA = PRICES[symA] || 1;
  const priceB = PRICES[symB] || 1;
  const rawA = Math.round((usdPerSide / priceA) * 10 ** decA);
  const rawB = Math.round((usdPerSide / priceB) * 10 ** decB);
  return { rawA, rawB };
}

async function getUserATA(mint) {
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, mint),
  ), [payer]);
  return ata;
}

// ── Pool initializer ──────────────────────────────────────────────────────────

async function initializePool({ pairKey, mintA, mintB, decA, decB, feeBps, usdPerSide, shardName }) {
  console.log(`\n   📦 Shard ${shardName} ($${(usdPerSide).toLocaleString()} per side, ${feeBps} bps fee)`);

  const swapKp     = Keypair.generate();
  const poolMintKp = Keypair.generate();
  const feeAccKp   = Keypair.generate();
  const poolAKp    = Keypair.generate();
  const poolBKp    = Keypair.generate();

  const [authority, bumpSeed] = PublicKey.findProgramAddressSync(
    [swapKp.publicKey.toBuffer()], programPk,
  );

  // Pool LP mint
  const mintLamports = await getMinimumBalanceForRentExemptMint(connection);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: poolMintKp.publicKey,
      space: MINT_SIZE, lamports: mintLamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(poolMintKp.publicKey, 6, authority, null),
  ), [payer, poolMintKp]);

  // Pool token accounts (owned by authority PDA)
  await createAccount(connection, payer, mintA, authority, poolAKp);
  await createAccount(connection, payer, mintB, authority, poolBKp);
  await createAccount(connection, payer, poolMintKp.publicKey, payer.publicKey, feeAccKp);

  // User LP ATA (to receive initial LP tokens)
  const userLpAta = await getUserATA(poolMintKp.publicKey);

  // User source token accounts for seeding
  const userAtaA = await getUserATA(mintA);
  const userAtaB = await getUserATA(mintB);

  // Mint seed liquidity
  const { rawA, rawB } = seedAmounts(
    pairKey.split('-')[0], pairKey.split('-')[1], usdPerSide, decA, decB,
  );
  await mintTo(connection, payer, mintA, userAtaA, payer, rawA);
  await mintTo(connection, payer, mintB, userAtaB, payer, rawB);

  // Create swap state account
  const SWAP_STATE_SIZE = 324;
  const swapLamports = await connection.getMinimumBalanceForRentExemption(SWAP_STATE_SIZE);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: swapKp.publicKey,
      space: SWAP_STATE_SIZE, lamports: swapLamports, programId: programPk,
    }),
  ), [payer, swapKp]);

  // Transfer seed tokens into pool accounts
  await sendAndConfirmTransaction(connection, new Transaction()
    .add(createTransferInstruction(userAtaA, poolAKp.publicKey, payer.publicKey, rawA))
    .add(createTransferInstruction(userAtaB, poolBKp.publicKey, payer.publicKey, rawB)),
  [payer]);

  // Initialize instruction
  const initData = encodeInitInstruction({ tradeFeeNum: feeBps, ownerFeeNum: 0 });
  const initIx = new TransactionInstruction({
    programId: programPk,
    data: initData,
    keys: [
      { pubkey: swapKp.publicKey,       isSigner: false, isWritable: true  },
      { pubkey: authority,              isSigner: false, isWritable: false },
      { pubkey: poolAKp.publicKey,      isSigner: false, isWritable: false },
      { pubkey: poolBKp.publicKey,      isSigner: false, isWritable: false },
      { pubkey: poolMintKp.publicKey,   isSigner: false, isWritable: true  },
      { pubkey: feeAccKp.publicKey,     isSigner: false, isWritable: true  },
      { pubkey: userLpAta,              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
    ],
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(initIx),
    [payer, swapKp]);

  const fmt = (n, dec) => (n / 10 ** dec).toFixed(dec > 6 ? 4 : 2);
  console.log(`   ✅ ${swapKp.publicKey.toBase58()}`);
  console.log(`      Seeds: ${fmt(rawA, decA)} ${pairKey.split('-')[0]} | ${fmt(rawB, decB)} ${pairKey.split('-')[1]}`);
  console.log(`      https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  return {
    address:       swapKp.publicKey.toBase58(),
    authority:     authority.toBase58(),
    bumpSeed,
    tokenAccountA: poolAKp.publicKey.toBase58(),
    tokenAccountB: poolBKp.publicKey.toBase58(),
    poolMint:      poolMintKp.publicKey.toBase58(),
    feeAccount:    feeAccKp.publicKey.toBase58(),
    liquidityUSD:  usdPerSide * 2,
    feeBps,
    createdAt:     new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

let deployment = JSON.parse(fs.readFileSync(DEPLOY_JSON, 'utf8'));

async function main() {
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`\n🌐 ${RPC_URL}`);
  console.log(`📋 Program: ${PROGRAM_ID}`);
  console.log(`💰 Wallet:  ${payer.publicKey.toBase58()} (${(balance / 1e9).toFixed(4)} SOL)`);
  console.log(`\n🪙 Ensuring token mints exist...`);

  // Build token registry
  const TOKEN_DEFS = {
    USDC: 6,  USDT: 6,  DAI: 9,  WETH: 9,  WBTC: 8,
  };
  const mints = {};
  const decs  = {};
  for (const [sym, dec] of Object.entries(TOKEN_DEFS)) {
    mints[sym] = await getOrCreateMint(sym, dec);
    decs[sym]  = dec;
  }
  fs.writeFileSync(DEPLOY_JSON, JSON.stringify(deployment, null, 2));
  console.log('\n✅ All mints ready\n');

  // Initialize pairs
  for (const pair of PAIRS) {
    const { key, symA, symB, feeBps } = pair;
    console.log(`\n━━━ Pair: ${key} (${feeBps} bps) ━━━`);

    if (!deployment.pools[key]) deployment.pools[key] = [];
    const existingAddresses = new Set(deployment.pools[key].map(s => s.address));
    const newShards = [];

    for (let i = 0; i < SHARD_USD.length; i++) {
      const usdPerSide = SHARD_USD[i];
      const shardName  = `${key}-${SHARD_NAMES[i]}`;

      // Check if this shard size already exists (by name)
      if (deployment.pools[key].some(s => s.name === shardName)) {
        console.log(`   ✓ Shard ${SHARD_NAMES[i]} already exists — skipping`);
        continue;
      }

      try {
        const info = await initializePool({
          pairKey: key, mintA: mints[symA], mintB: mints[symB],
          decA: decs[symA], decB: decs[symB],
          feeBps, usdPerSide, shardName: SHARD_NAMES[i],
        });
        newShards.push({ name: shardName, ...info });

        // Save after each pool to not lose progress on failure
        deployment.pools[key].push({ name: shardName, ...info });
        fs.writeFileSync(DEPLOY_JSON, JSON.stringify(deployment, null, 2));
      } catch (e) {
        console.error(`   ❌ Failed shard ${SHARD_NAMES[i]}: ${e.message.slice(0, 120)}`);
      }
    }
  }

  const totalShards = Object.values(deployment.pools).reduce((a, s) => a + s.length, 0);
  const totalPairs  = Object.keys(deployment.pools).length;
  console.log(`\n🎉 Done! ${totalPairs} pairs, ${totalShards} shards total`);
  console.log(`📄 Deployment data saved to ${DEPLOY_JSON}`);
  console.log(`\n   Verify: node scripts/verify-pools.js`);
  console.log(`   Test:   node scripts/test-swap.js USDC USDT 1.0`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
