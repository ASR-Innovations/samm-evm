#!/usr/bin/env node
'use strict';
/**
 * user-swap-flow.js — End-to-End User Transaction Flow
 *
 * Demonstrates exactly how a user interacts with the SAMM DEX:
 *
 *   Step 1 — Faucet: get test tokens (devnet only)
 *   Step 2 — Quote:  preview the swap (fees, price impact, route, shard selection)
 *   Step 3 — Swap:   execute on-chain atomically (ONE transaction, ONE signature)
 *   Step 4 — Verify: before vs after balances with delta
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
 * MULTI-HOP ATOMICITY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Whether the swap is USDC→USDT (1 hop) or WBTC→DAI (WBTC→USDC→DAI, 2 hops),
 * it ALWAYS executes in a SINGLE Solana transaction.
 *
 * The router builds N×(Approve + SwapSAMM) instructions — one pair per shard
 * per hop — all in one atomic tx.  If any instruction fails, the entire swap
 * reverts.  The user signs ONCE; there are no intermediate custody steps.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHARD SELECTION (automatic — user never touches this)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   c-Non-Splitting Property (c = 0.96):
 *     If amountOut < 0.96 × destReserve, routing to a single shard is always
 *     cheaper than splitting.  The router enforces this automatically.
 *
 *   Smaller-Better Principle:
 *     The router quotes every eligible shard via the Rust math binary and
 *     picks the one with the lowest amountIn (best price for the user).
 *     For equal reserves, a smaller shard charges less per unit swapped.
 *
 *   Split routing (rare):
 *     Only when amountOut ≥ 0.96 × destReserve AND splitting is actually cheaper.
 *     Trade is spread proportionally across all viable shards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WALLET-CONNECTED dApp FLOW (production)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. GET /quote/:tokenIn/:tokenOut/:amountOut
 *      → amountIn, fees, route, shard selection, price impact (no signing)
 *
 *   2. POST /build-tx  { tokenIn, tokenOut, amountOut, userAddress }
 *      → Server builds the Transaction, returns base64; NO server-side signing
 *
 *   3. User's wallet (Phantom, Backpack, etc.) receives the base64 transaction,
 *      shows what it will do, and user approves → wallet signs
 *
 *   4. Frontend submits the signed transaction to Solana RPC
 *      → Returns: transaction signature
 *
 *   5. Frontend polls GET /tx/:signature or Solana's confirmTransaction
 *      → Shows success / failure to user
 *
 * Currently POST /swap handles steps 2-4 all at once using the server keypair
 * (suitable for testing, arb bot, and operator's own funds).
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

function sep(n = 70) { return '─'.repeat(n); }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function cyan(s)  { return `\x1b[36m${s}\x1b[0m`; }
function red(s)   { return `\x1b[31m${s}\x1b[0m`; }
function dim(s)   { return `\x1b[2m${s}\x1b[0m`; }

function fmtDelta(before, after, sym) {
  const b = parseFloat(before  || '0');
  const a = parseFloat(after   || '0');
  const d = a - b;
  const sign = d >= 0 ? '+' : '';
  const color = d > 0 ? green : d < 0 ? red : dim;
  return `${color(`${sign}${d.toFixed(8)}`)} ${sym}  (${before} → ${after})`;
}

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

  console.log(`         Route:   ${q.routePath}  (${q.hops} hop${q.hops > 1 ? 's' : ''}, SINGLE atomic tx)`);
  console.log(`         Swap:    ${AMOUNT_OUT} ${TOKEN_OUT} out`);
  console.log(`         Pay:     ${q.amountIn} ${TOKEN_IN}  (${ q.amountInUSD} USD)`);
  console.log(`         Receive: ${q.amountOut} ${TOKEN_OUT} (${q.amountOutUSD} USD)`);
  console.log(`         Rate:    ${q.effectiveRate} ${TOKEN_OUT}/${TOKEN_IN}`);
  console.log(`         Fee:     ${q.totalFee} ${TOKEN_IN} (${q.totalFeeUSD} USD) — ${q.totalFeeBps} bps`);
  console.log(`         Impact:  ${q.priceImpactPct}%`);

  if (q.hopDetails?.length) {
    console.log(`\n         Shard selection per hop:`);
    for (const h of q.hopDetails) {
      const cStatus = h.aboveC ? '⚠️  above c-threshold (split eligible)' : '✅ below c-threshold (single-shard optimal)';
      console.log(`           Hop ${h.hop}: ${h.tokenIn}→${h.tokenOut}`);
      console.log(`             Selected: ${h.shardSelected}  (strategy: ${h.strategy}, ${h.shardCount} shard(s))`);
      console.log(`             Fee: ${h.feeBps} bps  Impact: ${h.priceImpactPct}%`);
      console.log(`             c-property: ${cStatus}`);
      if (h.smallerBetterSavings > 0) {
        console.log(`             Smaller-better: saved ${h.smallerBetterSavings} raw units vs next shard`);
      }
      if (h.legs?.length > 1) {
        console.log(`             Split legs:`);
        for (const l of h.legs) {
          console.log(`               ${l.shard}: out=${l.amountOut} in=${l.amountIn}`);
        }
      }
    }
  }

  // ── Step 3: Capture balance BEFORE swap ──────────────────────────────────
  console.log(`\n${cyan('Step 3 — Capture balance before swap')}`);
  const balsBefore = await get(`/balances/${WALLET}`);
  const beforeIn  = balsBefore.balances?.[TOKEN_IN]?.balance  || '0';
  const beforeOut = balsBefore.balances?.[TOKEN_OUT]?.balance || '0';
  console.log(`         ${TOKEN_IN.padEnd(5)} before: ${beforeIn}`);
  console.log(`         ${TOKEN_OUT.padEnd(5)} before: ${beforeOut}`);

  // ── Step 4: Execute ───────────────────────────────────────────────────────
  console.log(`\n${cyan('Step 4 — Execute swap (one atomic Solana transaction, one signature)')}`);
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

  // ── Step 5: Verify before vs after balances ───────────────────────────────
  console.log(`\n${cyan('Step 5 — Verify before vs after balances (slippage check)')}`);
  const balsAfter = await get(`/balances/${WALLET}`);
  const afterOut  = balsAfter.balances?.[TOKEN_OUT]?.balance || '0';

  console.log(`         Wallet: ${WALLET}\n`);

  // Show delta for all tokens that changed
  const allTokens = new Set([
    ...Object.keys(balsBefore.balances || {}),
    ...Object.keys(balsAfter.balances  || {}),
  ]);
  for (const sym of allTokens) {
    const b = parseFloat(balsBefore.balances?.[sym]?.balance || '0');
    const a = parseFloat(balsAfter.balances?.[sym]?.balance  || '0');
    if (Math.abs(a - b) < 1e-10) continue; // unchanged
    const d = a - b;
    const sign = d >= 0 ? '+' : '';
    const col = d > 0 ? green : red;
    console.log(`         ${sym.padEnd(5)} ${col(`${sign}${d.toFixed(8)}`)}   (${b.toFixed(8)} → ${a.toFixed(8)})`);
  }

  // Slippage sanity check
  const actualOut = parseFloat(afterOut) - parseFloat(beforeOut);
  const expectedOut = parseFloat(AMOUNT_OUT);
  const slippage = ((expectedOut - actualOut) / expectedOut) * 100;
  if (Math.abs(slippage) < 0.01) {
    console.log(green(`\n         ✅ Received exactly ${actualOut.toFixed(8)} ${TOKEN_OUT} (0.00% slippage)`));
  } else {
    console.log(`\n         Slippage: ${Math.abs(slippage).toFixed(4)}% (expected ${expectedOut}, got ${actualOut.toFixed(8)})`);
  }

  console.log(`\n${bold('═'.repeat(70))}`);
  console.log(green(bold('  ✅ Full user flow complete — swap executed on Solana devnet!')));
  console.log(`\n  Multi-hop / single-hop: always ONE Solana transaction, ONE signature.`);
  console.log(`  For a wallet-connected dApp: GET /quote → POST /build-tx → wallet signs → submit`);
  console.log(`  See samm-router.js buildAtomicTransaction() for transaction construction.`);
  console.log(bold(`${'═'.repeat(70)}\n`));
}

main().catch(e => { console.error(red('\n❌ Fatal: ' + e.message)); process.exit(1); });
