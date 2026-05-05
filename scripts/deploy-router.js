'use strict';
/**
 * scripts/deploy-router.js
 *
 * Builds + deploys the samm-router Solana program to devnet (or whatever
 * cluster your CLI is configured for) and writes the resulting program ID
 * into deployment-data/solana-devnet.json.
 *
 * Usage:
 *   node scripts/deploy-router.js
 *
 * Prerequisites:
 *   - Solana CLI configured (solana config get)
 *   - Sufficient devnet SOL  (solana airdrop 2 if needed)
 *   - cargo-build-sbf in PATH (ships with Solana tools ≥ 3.1)
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const CARGO_TOML  = path.join(ROOT, 'samm-router', 'Cargo.toml');
const SO_PATH     = path.join(ROOT, 'target', 'deploy', 'samm_router.so');
const DEPLOY_FILE = path.join(ROOT, 'deployment-data', 'solana-devnet.json');

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function runCapture(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', cwd: ROOT, ...opts }).trim();
}

// ── 1. Build ─────────────────────────────────────────────────────────────────
console.log('\n=== Building samm-router (cargo build-sbf) ===');
run(`cargo build-sbf --manifest-path "${CARGO_TOML}"`);

if (!fs.existsSync(SO_PATH)) {
  console.error(`Build succeeded but .so not found at: ${SO_PATH}`);
  process.exit(1);
}
const size = (fs.statSync(SO_PATH).size / 1024).toFixed(1);
console.log(`\n✓ Built: ${SO_PATH} (${size} KB)`);

// ── 2. Deploy ────────────────────────────────────────────────────────────────
console.log('\n=== Deploying to Solana devnet ===');
const deployOut = runCapture(`solana program deploy "${SO_PATH}"`);
console.log(deployOut);

const match = deployOut.match(/Program Id:\s+(\S+)/);
if (!match) {
  console.error('Could not parse Program Id from output. Output was:');
  console.error(deployOut);
  process.exit(1);
}
const programId = match[1];
console.log(`\n✓ Router Program ID: ${programId}`);

// ── 3. Persist ───────────────────────────────────────────────────────────────
const deployment = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8'));
deployment.routerProgramId = programId;
fs.writeFileSync(DEPLOY_FILE, JSON.stringify(deployment, null, 2));
console.log(`\n✓ Written routerProgramId to ${path.relative(ROOT, DEPLOY_FILE)}`);

console.log(`\nAdd to .env if needed:\n  SAMM_ROUTER_PROGRAM_ID=${programId}\n`);
