'use strict';
/**
 * scripts/test-router-live.js
 *
 * Run this in a SECOND terminal while the server is running to see live
 * on-chain swaps verified in real time alongside arb bot logs.
 *
 * Usage:
 *   node scripts/test-router-live.js            # all pairs, default amounts
 *   node scripts/test-router-live.js --loop     # repeat every 30s continuously
 *   node scripts/test-router-live.js USDC USDT 20  # single pair
 *
 * Requires: node api-server.js running on port 3000
 */

const BASE = process.env.API_URL || 'http://localhost:3000';

const COLORS = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

// All test cases — covers every routed pair
const TEST_CASES = [
  // ── Single-hop stablecoin ──────────────────────────────────────────────
  { tokenIn: 'USDC', tokenOut: 'USDT',  amountOut: '10',    slippagePct: '0.5',  label: 'Stablecoin single-hop' },
  { tokenIn: 'USDT', tokenOut: 'USDC',  amountOut: '10',    slippagePct: '0.5',  label: 'Stablecoin reverse' },
  { tokenIn: 'USDC', tokenOut: 'DAI',   amountOut: '10',    slippagePct: '0.5',  label: 'USDC→DAI single-hop' },
  { tokenIn: 'DAI',  tokenOut: 'USDC',  amountOut: '10',    slippagePct: '0.5',  label: 'DAI→USDC single-hop' },
  // ── Single-hop volatile ────────────────────────────────────────────────
  { tokenIn: 'WETH', tokenOut: 'USDC',  amountOut: '50',    slippagePct: '1.0',  label: 'WETH→USDC' },
  { tokenIn: 'USDC', tokenOut: 'WETH',  amountOut: '0.001', slippagePct: '2.0',  label: 'USDC→WETH (cross-decimal)' },
  { tokenIn: 'WBTC', tokenOut: 'USDC',  amountOut: '50',    slippagePct: '1.0',  label: 'WBTC→USDC' },
  { tokenIn: 'WETH', tokenOut: 'USDT',  amountOut: '10',    slippagePct: '1.0',  label: 'WETH→USDT' },
  // ── Two-hop cross-asset ────────────────────────────────────────────────
  { tokenIn: 'WBTC', tokenOut: 'USDT',  amountOut: '50',    slippagePct: '1.5',  label: 'WBTC→USDC→USDT (2-hop)' },
  { tokenIn: 'WBTC', tokenOut: 'DAI',   amountOut: '50',    slippagePct: '2.0',  label: 'WBTC→USDC→DAI  (2-hop)' },
  { tokenIn: 'WETH', tokenOut: 'DAI',   amountOut: '10',    slippagePct: '1.5',  label: 'WETH→USDC→DAI  (2-hop)' },
  { tokenIn: 'DAI',  tokenOut: 'WETH',  amountOut: '0.001', slippagePct: '2.0',  label: 'DAI→USDC→WETH  (2-hop cross-decimal)' },
];

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function fmt(n, d = 6) {
  if (n === undefined || n === null) return '?';
  const f = parseFloat(n);
  return isNaN(f) ? String(n) : f.toFixed(d).replace(/\.?0+$/, '');
}

function shortTx(tx) {
  return tx ? `${tx.slice(0, 8)}...${tx.slice(-6)}` : 'null';
}

async function checkServer() {
  try {
    const h = await get('/health');
    if (h.status !== 'ok') throw new Error('not ok');
    return h;
  } catch {
    console.error(COLORS.red('✗ Cannot reach server at ' + BASE + ' — start it first: node api-server.js'));
    process.exit(1);
  }
}

async function getBalances(address) {
  const r = await get(`/balances/${address}`);
  return r.balances || {};
}

async function runTestCase(tc, wallet, index, total) {
  const tag = `[${index + 1}/${total}]`;
  process.stdout.write(
    `${COLORS.dim(tag)} ${COLORS.bold(tc.tokenIn + '→' + tc.tokenOut)} ` +
    `out=${tc.amountOut} ${COLORS.dim(`(${tc.label})`)}  `
  );

  // Pre-swap balance snapshot
  const pre = await getBalances(wallet);

  const t0 = Date.now();
  const r = await post('/swap', {
    tokenIn:     tc.tokenIn,
    tokenOut:    tc.tokenOut,
    amountOut:   tc.amountOut,
    slippagePct: tc.slippagePct,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';

  if (!r.success) {
    console.log(COLORS.red('✗ FAILED') + '  ' + COLORS.dim((r.error || '?').slice(0, 80)));
    return { ok: false, label: tc.label, error: r.error };
  }

  // Post-swap balance snapshot
  const post_ = await getBalances(wallet);
  const inDelta  = (parseFloat(post_[tc.tokenIn]?.balance  || 0) - parseFloat(pre[tc.tokenIn]?.balance  || 0));
  const outDelta = (parseFloat(post_[tc.tokenOut]?.balance || 0) - parseFloat(pre[tc.tokenOut]?.balance || 0));
  const slipPct  = Math.abs((parseFloat(r.amountIn) * (outDelta === 0 ? 1 : 1) - parseFloat(tc.amountOut)) / parseFloat(tc.amountOut) * 100);

  console.log(
    COLORS.green('✓') + '  ' +
    `in=${COLORS.yellow(fmt(Math.abs(inDelta), 6))} ${tc.tokenIn}  ` +
    `out=${COLORS.green('+' + fmt(outDelta, 6))} ${tc.tokenOut}  ` +
    `hops=${r.hops}  feeBps=${r.feeBps}  ` +
    `${elapsed}  ` +
    COLORS.dim(`tx:${shortTx(r.txHash)}`)
  );
  console.log(
    `         Explorer: https://explorer.solana.com/tx/${r.txHash}?cluster=devnet`
  );

  return { ok: true, label: tc.label, hops: r.hops, inDelta, outDelta };
}

async function runOnePair(tokenIn, tokenOut, amountOut) {
  const h = await checkServer();
  const wallet = h.wallet?.address;
  console.log(COLORS.bold(`\nSingle swap: ${tokenIn}→${tokenOut} (out=${amountOut})`));
  const tc = { tokenIn, tokenOut, amountOut, slippagePct: '2.0', label: 'manual' };
  await runTestCase(tc, wallet, 0, 1);
}

async function runFullSuite() {
  const h = await checkServer();
  const wallet = h.wallet?.address;

  console.log(COLORS.bold('\n══════════════════════════════════════════════════'));
  console.log(COLORS.bold('  SAMM Router — Live On-Chain Test Suite'));
  console.log(COLORS.bold('══════════════════════════════════════════════════'));
  console.log(`  Server:   ${BASE}`);
  console.log(`  Router:   ${h.routerProgramId}`);
  console.log(`  Program:  ${h.programId}`);
  console.log(`  Wallet:   ${wallet}`);
  console.log(`  ArbBot:   ${h.arbitrageBot?.running ? COLORS.green('running') : COLORS.red('stopped')} ` +
    `(${h.arbitrageBot?.stats?.cycles || 0} cycles, ${h.arbitrageBot?.stats?.swaps || 0} swaps)`);
  console.log();

  // Show starting balances
  console.log(COLORS.cyan('── Starting balances ──────────────────────────────'));
  const balances = await getBalances(wallet);
  for (const [tok, b] of Object.entries(balances)) {
    console.log(`  ${tok.padEnd(6)}: ${parseFloat(b.balance).toLocaleString()}`);
  }
  console.log();

  console.log(COLORS.cyan('── Executing swaps ────────────────────────────────'));
  let passed = 0, failed = 0;
  const results = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const result = await runTestCase(TEST_CASES[i], wallet, i, TEST_CASES.length);
    results.push(result);
    if (result.ok) passed++; else failed++;
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log();
  console.log(COLORS.cyan('── Final balances ─────────────────────────────────'));
  const finalBalances = await getBalances(wallet);
  for (const [tok, b] of Object.entries(finalBalances)) {
    const prev = parseFloat(balances[tok]?.balance || 0);
    const curr = parseFloat(b.balance);
    const delta = curr - prev;
    const sign = delta >= 0 ? '+' : '';
    const col = delta === 0 ? COLORS.dim : (delta > 0 ? COLORS.green : COLORS.yellow);
    console.log(`  ${tok.padEnd(6)}: ${curr.toLocaleString().padStart(20)}  ${col(sign + delta.toFixed(6))}`);
  }

  console.log();
  console.log(COLORS.bold('══════════════════════════════════════════════════'));
  const resultLine = `  ${passed}/${TEST_CASES.length} PASSED`;
  console.log(failed === 0
    ? COLORS.green(COLORS.bold(resultLine + ' ✓ ALL ON-CHAIN ROUTER TESTS PASS'))
    : COLORS.red(COLORS.bold(resultLine + ` — ${failed} FAILED`))
  );
  console.log(COLORS.bold('══════════════════════════════════════════════════'));

  // Show arb bot recent activity
  console.log();
  console.log(COLORS.cyan('── Arb Bot — Last 5 swaps ─────────────────────────'));
  try {
    const hist = await get('/arbitrage/history?limit=5');
    for (const s of (hist.history || []).slice(0, 5)) {
      const ok = s.status === 'success';
      const arrow = ok ? COLORS.green('✓') : COLORS.red('✗');
      console.log(
        `  ${arrow} ${s.pair} ${s.direction}  $${(s.amountUSD || 0).toFixed(2)}  ` +
        `dev:${(s.preDeviation || 0).toFixed(2)}%→${(s.postDeviation || 0).toFixed(2)}%  ` +
        COLORS.dim(s.timestamp?.slice(11, 19) || '')
      );
    }
  } catch { /* ignore */ }

  return failed === 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length >= 3 && !args[0].startsWith('--')) {
  // Single pair mode: node test-router-live.js USDC USDT 10
  const [tokenIn, tokenOut, amountOut] = args;
  runOnePair(tokenIn, tokenOut, amountOut).catch(console.error);

} else if (args.includes('--loop')) {
  // Loop mode: run full suite, wait 30s, repeat
  const INTERVAL = 30000;
  (async function loop() {
    while (true) {
      await runFullSuite().catch(e => console.error(COLORS.red('Suite error: ' + e.message)));
      console.log(COLORS.dim(`\nWaiting ${INTERVAL / 1000}s before next run…`));
      await new Promise(r => setTimeout(r, INTERVAL));
    }
  })();

} else {
  // Default: single full suite run
  runFullSuite()
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(e => { console.error(e); process.exit(1); });
}
