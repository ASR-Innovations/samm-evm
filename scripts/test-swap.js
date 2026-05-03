#!/usr/bin/env node
'use strict';
/**
 * Execute a single SAMM swap end-to-end on Solana devnet.
 *
 * Usage:
 *   SOLANA_PROGRAM_ID=<id> SOLANA_PRIVATE_KEY=<bs58> \
 *     node scripts/test-swap.js [tokenIn] [tokenOut] [amountOut]
 *
 * Defaults: swap 1 USDT out (buy USDT, sell USDC)
 */

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { mintTo, getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');
const { executeSwap, getPoolReserves } = require('../solana-client');
const bs58 = require('bs58');
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const DEPLOY_JSON = path.join(__dirname, '..', 'deployment-data', 'solana-devnet.json');
const RUST_BIN    = path.join(__dirname, '..', 'rust-samm', 'target', 'release', 'samm');
const RPC_URL     = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID  = process.env.SOLANA_PROGRAM_ID;

if (!PROGRAM_ID)  { console.error('❌ SOLANA_PROGRAM_ID not set'); process.exit(1); }
if (!process.env.SOLANA_PRIVATE_KEY) { console.error('❌ SOLANA_PRIVATE_KEY not set'); process.exit(1); }

const connection = new Connection(RPC_URL, 'confirmed');
const payer      = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
const deployment = JSON.parse(fs.readFileSync(DEPLOY_JSON, 'utf8'));

const TOKEN_IN_SYM  = process.argv[2] || 'USDC';
const TOKEN_OUT_SYM = process.argv[3] || 'USDT';
const AMOUNT_OUT    = parseFloat(process.argv[4] || '1.0');

const tIn  = deployment.tokens[TOKEN_IN_SYM];
const tOut = deployment.tokens[TOKEN_OUT_SYM];

if (!tIn || !tOut) {
  console.error(`❌ Unknown tokens: ${TOKEN_IN_SYM}, ${TOKEN_OUT_SYM}`);
  console.error(`   Available: ${Object.keys(deployment.tokens).join(', ')}`);
  process.exit(1);
}

function parseUnits(amount, decimals) {
  const [int, frac = ''] = String(amount).split('.');
  return BigInt(int + frac.padEnd(decimals, '0').slice(0, decimals));
}
function fmt(raw, dec) {
  const s = raw.toString().padStart(dec + 1, '0');
  const i = s.length - dec;
  return `${s.slice(0, i)}.${s.slice(i)}`;
}

async function main() {
  console.log(`🌐 Network:   ${RPC_URL}`);
  console.log(`📋 Program:   ${PROGRAM_ID}`);
  console.log(`💰 Wallet:    ${payer.publicKey.toBase58()}`);
  const bal = await connection.getBalance(payer.publicKey);
  console.log(`   Balance:   ${(bal / 1e9).toFixed(4)} SOL`);

  // Find pool
  const pairKey  = `${TOKEN_IN_SYM}-${TOKEN_OUT_SYM}`;
  const altKey   = `${TOKEN_OUT_SYM}-${TOKEN_IN_SYM}`;
  const shards   = deployment.pools[pairKey] || deployment.pools[altKey];
  if (!shards?.length) {
    console.error(`❌ No pools for ${TOKEN_IN_SYM}-${TOKEN_OUT_SYM}`);
    process.exit(1);
  }
  const poolAddr = shards[0].address;

  console.log(`\n🔍 Pool:     ${poolAddr} (${shards[0].name})`);

  // Read current reserves
  const reserves = await getPoolReserves(connection, poolAddr);
  const isAIn = reserves.mintA.toBase58() === tIn.mint;
  const srcRes = isAIn ? reserves.reserveA : reserves.reserveB;
  const dstRes = isAIn ? reserves.reserveB : reserves.reserveA;

  console.log(`   Reserve ${TOKEN_IN_SYM}:  ${fmt(srcRes, tIn.decimals)}`);
  console.log(`   Reserve ${TOKEN_OUT_SYM}: ${fmt(dstRes, tOut.decimals)}`);

  // Quote
  const rawOut = parseUnits(AMOUNT_OUT, tOut.decimals);
  let amountIn, tradeFee;

  if (fs.existsSync(RUST_BIN)) {
    const q = JSON.parse(execSync(
      `"${RUST_BIN}" swap-samm '${JSON.stringify({
        output_amount: Number(rawOut), source_reserve: Number(srcRes), dest_reserve: Number(dstRes),
        trade_fee_num: 25, trade_fee_denom: 10000, owner_fee_num: 0, owner_fee_denom: 1,
      })}'`, { encoding: 'utf8' }
    ).trim());
    amountIn = BigInt(q.amount_in);
    tradeFee = BigInt(q.trade_fee);
    console.log(`\n📊 Quote (Rust SAMM):`);
    console.log(`   Selling: ${fmt(amountIn, tIn.decimals)} ${TOKEN_IN_SYM}`);
    console.log(`   Buying:  ${AMOUNT_OUT} ${TOKEN_OUT_SYM}`);
    console.log(`   Fee:     ${fmt(tradeFee, tIn.decimals)} ${TOKEN_IN_SYM}`);
  } else {
    // Fallback: simple constant-product estimate
    amountIn = (rawOut * srcRes / (dstRes - rawOut)) + 1n;
    tradeFee = amountIn * 25n / 10000n;
    console.log(`\n📊 Quote (constant-product estimate, no Rust binary):`);
    console.log(`   Selling: ~${fmt(amountIn, tIn.decimals)} ${TOKEN_IN_SYM}`);
  }

  const slippage = 101n;
  const maxIn    = amountIn * slippage / 100n;

  // Ensure user has enough tokenIn — mint if it's a test token
  const srcMint = new PublicKey(tIn.mint);
  const dstMint = new PublicKey(tOut.mint);

  // Ensure source ATA exists and has enough balance
  console.log(`\n   Ensuring ${TOKEN_IN_SYM} ATA exists...`);
  const srcAtaInfo = await getOrCreateAssociatedTokenAccount(connection, payer, srcMint, payer.publicKey);
  const userSrcAta = srcAtaInfo.address;
  const srcBal = BigInt(srcAtaInfo.amount);
  console.log(`   ${TOKEN_IN_SYM} balance: ${fmt(srcBal, tIn.decimals)}`);
  if (srcBal < maxIn) {
    const mintAmt = maxIn * 2n;
    console.log(`   Minting ${fmt(mintAmt, tIn.decimals)} ${TOKEN_IN_SYM} for test...`);
    await mintTo(connection, payer, srcMint, userSrcAta, payer, mintAmt);
  }

  // Ensure destination ATA exists
  await getOrCreateAssociatedTokenAccount(connection, payer, dstMint, payer.publicKey);

  // Execute
  console.log(`\n🚀 Executing swap...`);
  console.log(`   amountOut:      ${AMOUNT_OUT} ${TOKEN_OUT_SYM}`);
  console.log(`   maxAmountIn:    ${fmt(maxIn, tIn.decimals)} ${TOKEN_IN_SYM} (1% slippage)`);

  // Exact-output swap: tell program exactly how much we want out, cap the input at maxIn
  const sig = await executeSwap(
    connection, payer, PROGRAM_ID, poolAddr,
    tIn.mint, tOut.mint,
    rawOut,
    maxIn,
  );

  console.log(`\n✅ Swap confirmed!`);
  console.log(`   Signature: ${sig}`);
  console.log(`   Explorer:  https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // Read updated reserves
  const post = await getPoolReserves(connection, poolAddr);
  const postSrc = isAIn ? post.reserveA : post.reserveB;
  const postDst = isAIn ? post.reserveB : post.reserveA;
  console.log(`\n📈 Post-swap reserves:`);
  console.log(`   ${TOKEN_IN_SYM}: ${fmt(srcRes, tIn.decimals)} → ${fmt(postSrc, tIn.decimals)}`);
  console.log(`   ${TOKEN_OUT_SYM}: ${fmt(dstRes, tOut.decimals)} → ${fmt(postDst, tOut.decimals)}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
