#!/usr/bin/env node
'use strict';
/**
 * Comprehensive swap matrix test — $1 worth of each token, all pair combinations.
 *
 * Usage:  node scripts/test-all-swaps.js [--execute]
 *
 * Without --execute: quotes only (no on-chain txs).
 * With    --execute: quotes + live on-chain swaps.
 *
 * Output: formatted table with amountIn, amountOut, effective rate,
 *         price impact, fees, and tx hash (when executed).
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const EXECUTE  = process.argv.includes('--execute');

// Oracle prices (fetched from /tokens on startup)
let oraclePrices = {};

// $1 worth of each token (in human units)
function oneUSDworth(sym) {
  const p = oraclePrices[sym] || 1;
  const amounts = {
    USDC: (1 / p).toFixed(4),
    USDT: (1 / p).toFixed(4),
    DAI:  (1 / p).toFixed(4),
    WETH: (1 / p).toFixed(6),
    WBTC: (1 / p).toFixed(8),
  };
  return amounts[sym] || (1 / p).toFixed(6);
}

// All direct pairs + multi-hop combinations
const PAIRS = [
  // Stable pairs (direct, 5 bps)
  ['USDC', 'USDT'], ['USDT', 'USDC'],
  ['USDC', 'DAI'],  ['DAI',  'USDC'],
  ['USDT', 'DAI'],  ['DAI',  'USDT'],
  // Regular pairs (direct, 10 bps)
  ['WETH', 'USDC'], ['USDC', 'WETH'],
  ['WETH', 'USDT'], ['USDT', 'WETH'],
  ['WBTC', 'USDC'], ['USDC', 'WBTC'],
  ['WETH', 'WBTC'], ['WBTC', 'WETH'],
  // Multi-hop (bridge via USDC, 15-20 bps)
  ['WBTC', 'DAI'],  ['DAI',  'WBTC'],
  ['WBTC', 'USDT'], ['USDT', 'WBTC'],
  ['WETH', 'DAI'],  ['DAI',  'WETH'],
];

async function apiGet(path) {
  const r = await fetch(`${BASE_URL}${path}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return r.json();
}

function pad(s, n, right = false) {
  const str = String(s ?? '');
  return right ? str.padStart(n) : str.padEnd(n);
}

function color(s, code) { return `\x1b[${code}m${s}\x1b[0m`; }
const green  = s => color(s, '32');
const red    = s => color(s, '31');
const yellow = s => color(s, '33');
const cyan   = s => color(s, '36');
const bold   = s => color(s, '1');

async function main() {
  console.log(bold('\n══════════════════════════════════════════════════════════════════'));
  console.log(bold('  SAMM DEX — Comprehensive Swap Matrix'));
  console.log(bold(`  Mode: ${EXECUTE ? 'QUOTE + EXECUTE (live on-chain)' : 'QUOTE ONLY'}`));
  console.log(bold('══════════════════════════════════════════════════════════════════\n'));

  // Fetch oracle prices
  const tokensResp = await apiGet('/tokens');
  for (const t of tokensResp.tokens) oraclePrices[t.symbol] = t.price;
  console.log('Oracle prices:');
  for (const [sym, px] of Object.entries(oraclePrices)) {
    console.log(`  ${pad(sym, 5)} $${px.toLocaleString()}`);
  }
  console.log();

  const results = [];
  const header = [
    pad('TokenIn', 6), pad('TokenOut', 8),
    pad('AmtOut($1)', 12), pad('AmtIn', 16), pad('EffRate', 14),
    pad('FeeBps', 7), pad('Impact%', 9), pad('Hops', 5),
    pad('Status', 10), 'TxHash / Error',
  ].join('│');
  const divider = '─'.repeat(header.replace(/\x1b\[\d+m/g,'').length);

  console.log(cyan(divider));
  console.log(cyan(header));
  console.log(cyan(divider));

  let passed = 0, failed = 0;

  for (const [tokenIn, tokenOut] of PAIRS) {
    const amountOut = oneUSDworth(tokenOut);

    try {
      // Quote
      const q = await apiGet(`/quote/${tokenIn}/${tokenOut}/${amountOut}`);
      if (q.error) throw new Error(q.error);

      let txHash = null, status = 'quoted', errMsg = '';

      if (EXECUTE) {
        await new Promise(r => setTimeout(r, 800)); // rate-limit devnet RPCs
        const s = await apiPost('/swap', {
          tokenIn, tokenOut, amountOut, slippagePct: '2.0',
        });
        if (s.success) {
          txHash = s.txHash;
          status = 'success';
          passed++;
        } else {
          errMsg = (s.error || 'failed').slice(0, 50);
          status = 'failed';
          failed++;
        }
      } else {
        passed++;
      }

      const rate = parseFloat(q.effectiveRate || 0);
      const impact = parseFloat(q.priceImpactPct || 0);

      const row = [
        pad(tokenIn, 6),
        pad(tokenOut, 8),
        pad(amountOut, 12),
        pad(q.amountIn, 16),
        pad(rate.toFixed(8), 14),
        pad(q.totalFeeBps, 7),
        pad(impact.toFixed(4)+'%', 9),
        pad(q.hops, 5),
        pad(status, 10),
        txHash ? txHash.slice(0, 44)+'…' : (errMsg || q.routePath || ''),
      ].join('│');

      const line = status === 'success' ? green(row)
                 : status === 'failed'  ? red(row)
                 : row;
      console.log(line);

      results.push({ tokenIn, tokenOut, amountOut, ...q, txHash, status, errMsg });
    } catch (err) {
      failed++;
      const row = [
        pad(tokenIn, 6), pad(tokenOut, 8), pad(amountOut, 12),
        pad('–', 16), pad('–', 14), pad('–', 7), pad('–', 9), pad('–', 5),
        pad('ERROR', 10), err.message.slice(0, 50),
      ].join('│');
      console.log(red(row));
      results.push({ tokenIn, tokenOut, status: 'error', error: err.message });
    }
  }

  console.log(cyan(divider));

  // Summary
  console.log(bold('\n══ Summary ════════════════════════════════════════════════════════'));
  console.log(`  Total pairs tested : ${PAIRS.length}`);
  if (EXECUTE) {
    console.log(`  ${green('Successful swaps')} : ${passed}`);
    console.log(`  ${red('Failed swaps')}    : ${failed}`);
  } else {
    console.log(`  ${green('Valid quotes')}    : ${passed}`);
    console.log(`  ${red('Quote errors')}    : ${failed}`);
  }

  // Fee breakdown
  const stableSwaps  = results.filter(r => r.totalFeeBps <= 10 && r.hops === 1 && r.status !== 'error');
  const regularSwaps = results.filter(r => r.totalFeeBps > 10 && r.hops === 1 && r.status !== 'error');
  const multiHop     = results.filter(r => r.hops > 1 && r.status !== 'error');

  if (stableSwaps.length) {
    const avgImpact = stableSwaps.reduce((a,r) => a + parseFloat(r.priceImpactPct||0), 0) / stableSwaps.length;
    console.log(`\n  Stable pairs (≤10 bps): ${stableSwaps.length} quotes, avg impact ${avgImpact.toFixed(4)}%`);
  }
  if (regularSwaps.length) {
    const avgImpact = regularSwaps.reduce((a,r) => a + parseFloat(r.priceImpactPct||0), 0) / regularSwaps.length;
    console.log(`  Regular pairs (10 bps): ${regularSwaps.length} quotes, avg impact ${avgImpact.toFixed(4)}%`);
  }
  if (multiHop.length) {
    const avgFee = multiHop.reduce((a,r) => a + (r.totalFeeBps||0), 0) / multiHop.length;
    console.log(`  Multi-hop routes     : ${multiHop.length} quotes, avg total fee ${avgFee.toFixed(0)} bps`);
  }

  console.log(bold('════════════════════════════════════════════════════════════════════\n'));

  if (EXECUTE && failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
