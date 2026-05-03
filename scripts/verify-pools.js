#!/usr/bin/env node
'use strict';
/**
 * Read all deployed pool accounts and print their current state.
 *
 * Usage:
 *   SOLANA_PROGRAM_ID=<id> node scripts/verify-pools.js
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { getPoolState, getTokenBalance } = require('../solana-client');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const DEPLOY_JSON = path.join(__dirname, '..', 'deployment-data', 'solana-devnet.json');
const RPC_URL     = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID  = process.env.SOLANA_PROGRAM_ID || '';

const connection  = new Connection(RPC_URL, 'confirmed');
const deployment  = JSON.parse(fs.readFileSync(DEPLOY_JSON, 'utf8'));

function fmt(raw, dec) {
  const s   = raw.toString().padStart(dec + 1, '0');
  const idx = s.length - dec;
  return `${s.slice(0, idx)}.${s.slice(idx)}`;
}

async function main() {
  console.log(`🌐 Network:  ${RPC_URL}`);
  console.log(`📋 Program:  ${PROGRAM_ID || '(not set)'}`);
  console.log(`📄 File:     ${DEPLOY_JSON}\n`);

  let anyPool = false;
  for (const [pair, shards] of Object.entries(deployment.pools)) {
    if (!shards.length) {
      console.log(`${pair}: no pools deployed`);
      continue;
    }
    const [symA, symB] = pair.split('-');
    const tA = deployment.tokens[symA];
    const tB = deployment.tokens[symB];

    console.log(`\n═══ ${pair} (${shards.length} shard${shards.length > 1 ? 's' : ''}) ═══`);

    for (const shard of shards) {
      anyPool = true;
      try {
        const state = await getPoolState(connection, shard.address);
        const rA    = await getTokenBalance(connection, state.tokenAccountA);
        const rB    = await getTokenBalance(connection, state.tokenAccountB);

        const decA = tA?.decimals ?? rA.decimals;
        const decB = tB?.decimals ?? rB.decimals;

        console.log(`  ${shard.name}`);
        console.log(`    Address:     ${shard.address}`);
        console.log(`    Initialized: ${state.isInitialized}`);
        console.log(`    Mint A:      ${state.mintA.toBase58()}`);
        console.log(`    Mint B:      ${state.mintB.toBase58()}`);
        console.log(`    Reserve A:   ${fmt(rA.amount, decA)} ${symA}`);
        console.log(`    Reserve B:   ${fmt(rB.amount, decB)} ${symB}`);
        console.log(`    Pool mint:   ${state.tokenPool.toBase58()}`);
        console.log(`    Fee account: ${state.feeAccount.toBase58()}`);
        console.log(`    Trade fee:   ${state.tradeFeeNumerator}/${state.tradeFeeDenominator}`);
        console.log(`    Explorer: https://explorer.solana.com/address/${shard.address}?cluster=devnet`);
      } catch (e) {
        console.log(`  ${shard.name}: ❌ ${e.message}`);
      }
    }
  }

  if (!anyPool) {
    console.log('\n⚠️  No pools found. Run: node scripts/initialize-pools.js');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
