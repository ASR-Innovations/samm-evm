#!/usr/bin/env node
'use strict';
/**
 * Deploy the SAMM program to Solana devnet and record the program ID.
 *
 * Prerequisites:
 *   1. Build the .so:
 *        cd /Users/rohitprasad/Downloads/spl-samm-main
 *        cargo-build-sbf --manifest-path token-swap/program/Cargo.toml
 *   2. Have ≥ 1.51 SOL in your wallet (airdrop from faucet.solana.com)
 *   3. SOLANA_PRIVATE_KEY set in .env (base58 keypair)
 *
 * Usage:
 *   node scripts/deploy-solana.js [path/to/spl_token_swap.so]
 *
 * Writes programId into deployment-data/solana-devnet.json.
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const DEFAULT_SO = path.join(
  process.env.HOME,
  'Downloads/spl-samm-main/target/deploy/spl_token_swap.so',
);

const SO_PATH   = process.argv[2] || DEFAULT_SO;
const DEPLOY_JSON = path.join(__dirname, '..', 'deployment-data', 'solana-devnet.json');

// ── Checks ────────────────────────────────────────────────────────
if (!fs.existsSync(SO_PATH)) {
  console.error(`❌ .so not found: ${SO_PATH}`);
  console.error(`   Build it first:`);
  console.error(`   cd ~/Downloads/spl-samm-main`);
  console.error(`   cargo-build-sbf --manifest-path token-swap/program/Cargo.toml`);
  process.exit(1);
}

console.log(`🔧 Deploying SAMM program to Solana devnet`);
console.log(`   .so: ${SO_PATH}`);

// Check balance
const balanceOut = execSync('solana balance', { encoding: 'utf8' }).trim();
console.log(`   Wallet balance: ${balanceOut}`);

const balanceSol = parseFloat(balanceOut);
if (balanceSol < 1.6) {
  console.error(`❌ Insufficient balance: ${balanceSol} SOL (need ≥ 1.6 SOL)`);
  console.error(`   Airdrop via: https://faucet.solana.com`);
  console.error(`   Wallet: ${execSync('solana address', { encoding: 'utf8' }).trim()}`);
  process.exit(1);
}

// ── Deploy ────────────────────────────────────────────────────────
console.log('\n🚀 Deploying...');
const result = spawnSync('solana', ['program', 'deploy', SO_PATH], {
  encoding: 'utf8',
  stdio: 'pipe',
});

if (result.status !== 0) {
  console.error('❌ Deploy failed:');
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

const deployOutput = (result.stdout + result.stderr).trim();
console.log(deployOutput);

// Parse "Program Id: <base58>"
const match = deployOutput.match(/Program Id:\s+(\w+)/);
if (!match) {
  console.error('❌ Could not parse Program Id from deploy output');
  console.error('   Raw output:', deployOutput);
  process.exit(1);
}

const programId = match[1];
console.log(`\n✅ Program deployed: ${programId}`);
console.log(`   Explorer: https://explorer.solana.com/address/${programId}?cluster=devnet`);

// ── Update deployment JSON ────────────────────────────────────────
const deployment = JSON.parse(fs.readFileSync(DEPLOY_JSON, 'utf8'));
deployment.programId   = programId;
deployment.deployedAt  = new Date().toISOString();
deployment.network     = 'devnet';
deployment._soPath     = SO_PATH;
fs.writeFileSync(DEPLOY_JSON, JSON.stringify(deployment, null, 2));

console.log(`\n💾 Saved to: ${DEPLOY_JSON}`);
console.log('\nNext steps:');
console.log('  1. Add to .env: SOLANA_PROGRAM_ID=' + programId);
console.log('  2. Create token mints + pools: node scripts/initialize-pools.js');
