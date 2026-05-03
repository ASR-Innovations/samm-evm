#!/usr/bin/env node
'use strict';
/**
 * user-swap-flow.js — End-to-End User Transaction Flow
 *
 * Demonstrates exactly how a user interacts with the SAMM DEX:
 *
 *   Step 1 — Faucet: get test tokens (devnet only)
 *   Step 2 — Quote:  preview the swap (fees, price impact, route)
 *   Step 3 — Swap:   execute on-chain atomically
 *   Step 4 — Verify: check final balances
 *
 * Usage:
 *   node scripts/user-swap-flow.js                        # USDC→USDT 10 (default)
 *   node scripts/user-swap-flow.js WBTC DAI 5             # WBTC→DAI 5 (multi-hop)
 *   node scripts/user-swap-flow.js WETH USDC 50           # WETH→USDC 50
 *
 * Environment:
 *   API_URL=http://localhost:3000   (default)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THE BACKEND BUILDS & SUBMITS THE TRANSACTION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On Solana, "signing" is done by the user's keypair.  The current setup has
 * the server sign with its operator keypair (for easy testing).
 *
 * For a real user-facing dApp the flow would be:
 *
 *   1. Frontend calls GET /quote/:tokenIn/:tokenOut/:amountOut
 *      → Server returns: amountIn, fees, route, price impact (read-only, no signing)
 *
 *   2. Frontend calls POST /build-tx  { tokenIn, tokenOut, amountOut, userAddress }
 *      → Server builds the Transaction object, serializes it, and returns base64
 *      → NO signing happens server-side for user funds
 *
 *   3. User's wallet (Phantom, Backpack, etc.) receives the base64 transaction,
 *      shows the user what it will do, and the user approves → wallet signs
 *
 *   4. Frontend submits the signed transaction to Solana RPC
 *      → Returns: transaction signature
 *
 *   5. Frontend polls GET /tx/:signature or uses Solana's confirmTransaction
 *      → Shows success / failure to user
 *
 * Currently POST /swap handles steps 2-4 all at once using the server keypair
 * (suitable for the operator's own funds, testing, and arb bot).
 *
 * See samm-router.js buildAtomicTransaction() for the transaction construction.
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

const [,, rawIn, rawOut, rawAmt] = process.argv;
const TOKEN_IN   = (rawIn  || 'USDC').toUpperCase();
const TOKEN_OUT  = (rawOut || 'USDT').toUpperCase();
const AMOUNT_OUT = rawAmt  || '10';

const WALLET = '3192e7asquzj5KwXgjer1CfWKGBK8Y5ECo3qWjsjNfVc';

async function get(path) {
  const r = await fetch(`${BASE_URL}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function sep(char = '─', n = 70) { return char.repeat(n); }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function cyan(s)  { return `\x1b[36m${s}\x1b[0m`; }
function red(s)   { return `\x1b[31m${s}\x1b[0m`; }

async function main() {
  console.log(bold(`\n${'═'.repeat(70)}`));
  console.log(bold(`  SAMM DEX — User Swap Flow`));
  console.log(bold(`  ${TOKEN_IN} → ${TOKEN_OUT}   amount out: ${AMOUNT_OUT}`));
  console.log(bold(`${'═'.repeat(70)}\n`));

  // ── Step 1: Fund test wallet (devnet faucet) ──────────────────────────────
  console.log(cyan('Step 1 — Fund wallet (devnet faucet)'));
  console.log(`         Wallet: ${WALLET}`);

  const faucetTokens = {};
  faucetTokens[TOKEN_IN] = TOKEN_IN.match(/WBTC/) ? '0.05' : TOKEN_IN.match(/WETH/) ? '3' : '1000';
  const faucet = await post('/faucet', { address: WALLET, tokens: faucetTokens });
  const fr = faucet.results?.[TOKEN_IN];
  if (fr?.txHash) {
    console.log(green(`         ✅ Minted ${fr.amount} ${TOKEN_IN}`));
    console.log(`            ATA:  ${fr.ata}`);
    console.log(`            TX:   https://explorer.solana.com/tx/${fr.txHash}?cluster=devnet`);
  } else {
    console.log(`         ℹ️  Faucet: ${fr?.error || 'skipped'}`);
  }

  // ── Step 2: Quote ─────────────────────────────────────────────────────────
  console.log(`\n${cyan('Step 2 — Get quote (preview swap before spending)')}`);
  const q = await get(`/quote/${TOKEN_IN}/${TOKEN_OUT}/${AMOUNT_OUT}`);
  if (q.error) { console.log(red(`         ❌ ${q.error}`)); process.exit(1); }

  console.log(`         Swap:    ${AMOUNT_OUT} ${TOKEN_OUT} out`);
  console.log(`         Pay:     ${q.amountIn} ${TOKEN_IN}  (${q.amountInUSD} USD)`);
  console.log(`         Receive: ${q.amountOut} ${TOKEN_OUT} (${q.amountOutUSD} USD)`);
  console.log(`         Rate:    ${q.effectiveRate} ${TOKEN_OUT}/${TOKEN_IN}`);
  console.log(`         Route:   ${q.routePath}  (${q.hops} hop${q.hops > 1 ? 's' : ''})`);
  console.log(`         Fee:     ${q.totalFee} ${TOKEN_IN} (${q.totalFeeUSD} USD) — ${q.totalFeeBps} bps`);
  console.log(`         Impact:  ${q.priceImpactPct}%`);

  if (q.hops > 1) {
    console.log(`\n         Hop details:`);
    for (const h of q.hopDetails) {
      console.log(`           Hop ${h.hop}: ${h.tokenIn}→${h.tokenOut}  ${h.feeBps} bps  via ${h.legs.length} shard(s)`);
    }
  }

  // ── Step 3: Execute ───────────────────────────────────────────────────────
  console.log(`\n${cyan('Step 3 — Execute swap (on-chain atomic transaction)')}`);
  console.log(`         Submitting to Solana devnet…`);

  const swap = await post('/swap', {
    tokenIn:   TOKEN_IN,
    tokenOut:  TOKEN_OUT,
    amountOut: AMOUNT_OUT,
    slippagePct: '1.0',
  });

  if (!swap.success) {
    console.log(red(`         ❌ Swap failed: ${swap.error}`));
    process.exit(1);
  }

  console.log(green(`         ✅ Swap confirmed!`));
  console.log(`         TX Hash: ${swap.txHash}`);
  console.log(`         Explorer: https://explorer.solana.com/tx/${swap.txHash}?cluster=devnet`);
  console.log(`         Paid:    ${swap.amountIn} ${TOKEN_IN}`);
  console.log(`         Route:   ${swap.routePath} (${swap.hops} hop${swap.hops > 1 ? 's' : ''})`);
  console.log(`         Strategy: ${swap.strategy} | shards used: ${swap.shardsUsed}`);

  // ── Step 4: Verify balances ───────────────────────────────────────────────
  console.log(`\n${cyan('Step 4 — Verify final balances')}`);
  const bals = await get(`/balances/${WALLET}`);
  console.log(`         Wallet: ${WALLET}`);
  for (const [sym, b] of Object.entries(bals.balances)) {
    console.log(`           ${sym.padEnd(5)} ${b.balance}`);
  }

  console.log(`\n${bold('═'.repeat(70))}`);
  console.log(green(bold('  ✅ Full user flow complete — swap executed on Solana devnet!')));
  console.log(`\n  For a wallet-connected dApp, the flow is:`);
  console.log(`    GET /quote → display to user → POST /build-tx → wallet signs → submit`);
  console.log(`  See samm-router.js buildAtomicTransaction() for transaction construction.`);
  console.log(bold(`${'═'.repeat(70)}\n`));
}

main().catch(e => { console.error(red('\n❌ Fatal: ' + e.message)); process.exit(1); });
