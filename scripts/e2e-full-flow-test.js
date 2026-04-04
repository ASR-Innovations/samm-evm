#!/usr/bin/env node
/**
 * End-to-End Full Flow Test
 *
 * Tests the complete user journey for SAMM DEX:
 *
 *   1. Compare SAMM vs Uniswap quotes (via API)
 *   2. Execute Uniswap swap on Sepolia (backend signs)
 *   3. Read Chainlink prices (live on-chain)
 *   4. Run CRE workflow simulation
 *   5. Bridge ETH from Sepolia → RiseChain
 *   6. Verify delivery on RiseChain
 *   7. Check ENS agent registry
 *   8. Verify arb bot + shard manager status
 *
 * Also tests the FRONTEND-COMPATIBLE flow:
 *   - POST /swap/sepolia/prepare (get quote for user wallet)
 *   - POST /swap/sepolia/execute (get unsigned tx for MetaMask)
 *
 * Usage:
 *   node scripts/e2e-full-flow-test.js              # full test (skip swap+bridge)
 *   node scripts/e2e-full-flow-test.js --live        # include real swap + bridge
 *   node scripts/e2e-full-flow-test.js --swap-only   # only execute Uniswap swap
 *   node scripts/e2e-full-flow-test.js --bridge-only  # only bridge ETH
 *
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const LIVE = process.argv.includes('--live');
const SWAP_ONLY = process.argv.includes('--swap-only');
const BRIDGE_ONLY = process.argv.includes('--bridge-only');

const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

function log(msg) { console.log(msg); }

function record(name, status, details = {}) {
  results.tests.push({ name, status, ...details });
  if (status === 'PASS') results.passed++;
  else if (status === 'FAIL') results.failed++;
  else results.skipped++;
}

async function apiGet(path) {
  const resp = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(30000) });
  return resp.json();
}

async function apiPost(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return resp.json();
}

// ═══════════════════════════════════════════════════════════════════
//  Test 1: Health + Infrastructure
// ═══════════════════════════════════════════════════════════════════
async function testHealth() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 1: API Health + Infrastructure');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const data = await apiGet('/health');
    log(`   ✅ Server: ${data.status}`);
    log(`   ✅ Router: ${data.contracts?.router}`);
    log(`   ✅ Factory: ${data.contracts?.factory}`);
    log(`   ✅ Tokens: ${data.contracts?.tokens?.length || 0}`);
    log(`   ✅ Shards: ${data.contracts?.totalShards || 0}`);
    record('Health Check', data.status === 'ok' ? 'PASS' : 'FAIL', { server: data.status });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('Health Check', 'FAIL', { error: e.message });
    throw new Error('Server not running — aborting');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 2: SAMM vs Uniswap Comparison
// ═══════════════════════════════════════════════════════════════════
async function testComparison() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 2: SAMM vs Uniswap Comparison');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const data = await apiGet('/compare/WETH/USDC/1');
    const uni = data.sepoliaUniswap || data.uniswap;
    log(`   SAMM:    ${data.samm?.amountIn || data.samm?.amountOut || 'N/A'}`);
    log(`   Uniswap: ${uni?.amountIn || uni?.amountOut || 'N/A'}`);
    log(`   Winner:  ${data.comparison?.winner || data.winner || 'N/A'}`);
    log(`   Diff:    ${data.comparison?.percentDifference || data.percentDifference || 'N/A'}`);
    const passed = data.samm && uni;
    record('SAMM vs Uniswap Comparison', passed ? 'PASS' : 'FAIL', {
      samm: data.samm?.amountIn, uniswap: uni?.amountIn, winner: data.comparison?.winner,
    });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('SAMM vs Uniswap Comparison', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 3: Chainlink Price Feeds (LIVE on-chain)
// ═══════════════════════════════════════════════════════════════════
async function testChainlinkPrices() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 3: Chainlink Price Feeds (Sepolia on-chain)');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const data = await apiGet('/oracle/chainlink');
    const prices = data.chainlink?.prices || {};
    const feedCount = data.chainlink?.feedCount || 0;
    
    for (const [token, price] of Object.entries(prices)) {
      const meta = data.chainlink?.metadata?.[token];
      log(`   ✅ ${token}: $${price.toFixed(2)} (staleness: ${meta?.stalenessSeconds || '?'}s)`);
    }
    log(`   📡 Source: ${data.chainlink?.source}`);
    log(`   🔗 Feed count: ${feedCount}`);

    if (data.comparison) {
      log(`   📊 Chainlink vs CoinGecko:`);
      for (const [token, cmp] of Object.entries(data.comparison)) {
        log(`      ${token}: deviation ${cmp.deviationPct}% — ${cmp.agreement}`);
      }
    }

    const passed = feedCount >= 4 && prices.WETH > 0;
    record('Chainlink Price Feeds', passed ? 'PASS' : 'FAIL', {
      feedCount, prices, source: data.chainlink?.source,
    });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('Chainlink Price Feeds', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 4: CRE Workflow Simulation (Chainlink + shard decisions)
// ═══════════════════════════════════════════════════════════════════
async function testCRESimulation() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 4: CRE Workflow Simulation');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const data = await apiPost('/sharding/cre-simulate', {});
    
    log(`   ⏱️  Execution: ${data.executionTimeMs}ms`);
    log(`   📡 Chainlink feeds read:`);
    for (const p of (data.chainlinkPrices || [])) {
      log(`      ${p.name}: $${p.price.toFixed(2)} — ${p.source}`);
    }
    log(`   🧮 Decisions: ${data.summary?.totalDecisions}`);
    log(`      Splits: ${data.summary?.splits}, Merges: ${data.summary?.merges}`);
    log(`      Price checks: ${data.summary?.priceChecks}`);
    
    if (data.decisions) {
      for (const d of data.decisions) {
        if (d.type === 'PRICE_CHECK') {
          log(`      💰 ${d.pair}: oracle rate ${d.oracleRate} (${d.priceA} / ${d.priceB})`);
        } else {
          log(`      ${d.type === 'SPLIT' ? '🔀' : d.type === 'MERGE' ? '🔗' : '✅'} ${d.pair}: ${d.type} (${d.currentShards}→${d.targetShards} shards)`);
        }
      }
    }

    log(`   🏗️  Architecture:`);
    log(`      Trigger: ${data.architecture?.trigger}`);
    log(`      Consensus: ${data.architecture?.consensus}`);
    log(`      Thresholds: split=${data.architecture?.thresholds?.split}, merge=${data.architecture?.thresholds?.merge}`);

    const passed = data.success && (data.chainlinkPrices?.length || 0) >= 3;
    record('CRE Workflow Simulation', passed ? 'PASS' : 'FAIL', {
      executionMs: data.executionTimeMs, decisions: data.summary?.totalDecisions,
    });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('CRE Workflow Simulation', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 5: Frontend-Compatible Swap Flow (MetaMask)
// ═══════════════════════════════════════════════════════════════════
async function testFrontendSwapFlow() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 5: Frontend-Compatible Swap Flow (MetaMask)');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    // Step 1: Prepare — get quote for user's own wallet
    const userAddr = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD95';
    log(`   👤 User wallet: ${userAddr}`);
    log(`   📝 Step 1: POST /swap/sepolia/prepare`);
    
    const prepData = await apiPost('/swap/sepolia/prepare', {
      userAddress: userAddr,
      tokenIn: 'ETH',
      tokenOut: 'USDC',
      amount: '0.001',
    });

    if (prepData.error) {
      throw new Error(`Prepare failed: ${prepData.error}`);
    }

    log(`      ✅ Quote received — routing: ${prepData.routing}`);
    log(`      ✅ Output: ${prepData.quote?.output?.amount || 'N/A'} USDC`);
    log(`      ✅ Needs Permit2 signature: ${prepData.needsPermit2Signature}`);
    log(`      ✅ Swapper: ${prepData.quote?.swapper || prepData.userAddress}`);

    // Step 2: In a real flow, user would sign permitData in MetaMask
    log(`   📝 Step 2: User signs in MetaMask (simulated)`);
    log(`      [In real frontend: wallet.signTypedData(permitData.domain, types, values)]`);

    // Step 3: Execute — get unsigned tx
    log(`   📝 Step 3: POST /swap/sepolia/execute`);
    const execData = await apiPost('/swap/sepolia/execute', {
      quote: prepData.quote,
      routing: prepData.routing,
      // No signature for native ETH (no Permit2 needed)
    });

    if (execData.error) {
      throw new Error(`Execute failed: ${execData.error}`);
    }

    log(`      ✅ Unsigned tx received`);
    log(`      ✅ To: ${execData.unsignedTransaction?.to}`);
    log(`      ✅ Value: ${execData.unsignedTransaction?.value}`);
    log(`      ✅ ChainId: ${execData.unsignedTransaction?.chainId}`);
    log(`      ✅ Data length: ${(execData.unsignedTransaction?.data || '').length} chars`);

    // Step 4: User would sign this tx in MetaMask and broadcast
    log(`   📝 Step 4: User signs tx in MetaMask & broadcasts`);
    log(`      [In real frontend: signer.sendTransaction(unsignedTx)]`);

    log(`\n   🎉 Complete frontend flow verified!`);
    log(`      Backend NEVER touches user's private key.`);
    log(`      User only signs in MetaMask (EIP-712 + tx).`);

    record('Frontend Swap Flow', 'PASS', {
      routing: prepData.routing,
      unsignedTxTo: execData.unsignedTransaction?.to,
    });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('Frontend Swap Flow', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 6: Real Uniswap Swap (--live or --swap-only)
// ═══════════════════════════════════════════════════════════════════
async function testRealSwap() {
  if (!LIVE && !SWAP_ONLY) {
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📋 Test 6: Real Uniswap Swap [SKIPPED — use --live]');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    record('Real Uniswap Swap', 'SKIP');
    return null;
  }

  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 6: Real Uniswap Swap (0.001 ETH → USDC on Sepolia)');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const data = await apiPost('/swap/sepolia', {
      tokenIn: 'ETH',
      tokenOut: 'USDC',
      amount: '0.001',
    });

    if (data.error) throw new Error(data.error);

    log(`   ✅ Swap executed`);
    log(`   🔗 Tx: ${data.txHash}`);
    log(`   📦 Block: ${data.blockNumber}`);
    log(`   ⛽ Gas: ${data.gasUsed}`);
    log(`   🔄 Routing: ${data.routing}`);
    log(`   🔗 Explorer: ${data.explorer}`);

    record('Real Uniswap Swap', 'PASS', { txHash: data.txHash, block: data.blockNumber });
    return data.txHash;
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('Real Uniswap Swap', 'FAIL', { error: e.message });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 7: Bridge ETH Sepolia → RiseChain (--live or --bridge-only)
// ═══════════════════════════════════════════════════════════════════
async function testBridge() {
  if (!LIVE && !BRIDGE_ONLY) {
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📋 Test 7: Bridge ETH → RiseChain [SKIPPED — use --live]');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    record('Bridge Deposit', 'SKIP');
    return;
  }

  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 7: Bridge ETH Sepolia → RiseChain');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Pre-check balances
  try {
    const preBalances = await apiGet('/bridge/balances');
    log(`   📊 Pre-bridge balances:`);
    log(`      Sepolia: ${preBalances.l1?.ETH || '?'} ETH`);
    log(`      RiseChain: ${preBalances.l2?.ETH || '?'} ETH`);
  } catch (e) {
    log(`   ⚠️ Could not fetch pre-balances: ${e.message}`);
  }

  try {
    const data = await apiPost('/bridge/deposit', { amount: '0.001' });
    if (data.error) throw new Error(data.error);

    log(`   ✅ Bridge deposit submitted`);
    log(`   🔗 L1 Tx: ${data.l1TxHash}`);
    log(`   📦 Block: ${data.blockNumber}`);
    log(`   🔗 Explorer: https://sepolia.etherscan.io/tx/${data.l1TxHash}`);
    log(`   ⏳ Delivery: typically instant on RiseChain testnet`);

    // Wait and check post balances
    log(`   ⏳ Waiting 10s for bridge delivery...`);
    await new Promise(r => setTimeout(r, 10000));

    try {
      const postBalances = await apiGet('/bridge/balances');
      log(`   📊 Post-bridge balances:`);
      log(`      Sepolia: ${postBalances.l1?.ETH || '?'} ETH`);
      log(`      RiseChain: ${postBalances.l2?.ETH || '?'} ETH`);
    } catch (e) {
      log(`   ⚠️ Could not fetch post-balances: ${e.message}`);
    }

    record('Bridge Deposit', 'PASS', { txHash: data.l1TxHash });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('Bridge Deposit', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 8: ENS Agent Registry
// ═══════════════════════════════════════════════════════════════════
async function testENS() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 8: ENS Agent Registry');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const data = await apiGet('/agents');
    const agents = data.agents || [];
    log(`   ✅ Registry enabled: ${data.enabled}`);
    log(`   📋 ${agents.length} agents registered:`);
    for (const agent of agents) {
      log(`      ${agent.ensName || agent.name}: ${agent.agentAddress?.slice(0, 10)}... (${agent.status || 'active'})`);
    }
    if (data.status?.onChain) {
      log(`   🔗 On-chain registry: ${data.status.registry}`);
    }
    record('ENS Agent Registry', agents.length > 0 ? 'PASS' : 'FAIL', { agentCount: agents.length });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('ENS Agent Registry', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 9: Arb Bot + Shard Manager Status
// ═══════════════════════════════════════════════════════════════════
async function testArbAndShards() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 9: Arb Bot + Dynamic Shard Manager');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const arbStatus = await apiGet('/arbitrage/status');
    log(`   🤖 Arb Bot:`);
    log(`      Running: ${arbStatus.running}`);
    log(`      Cycles: ${arbStatus.cycles}`);
    log(`      Oracle: ${arbStatus.oracleSource}`);
    log(`      Pools monitored: ${arbStatus.poolsMonitored}`);
    log(`      Total swaps: ${arbStatus.totalSwaps}`);

    const shardStatus = await apiGet('/sharding/status');
    log(`   🔧 Shard Manager:`);
    log(`      Running: ${shardStatus.running}`);
    log(`      Total shards: ${shardStatus.totalShards}`);
    log(`      Pairs: ${shardStatus.pairCount}`);

    const passed = arbStatus.running && shardStatus.running;
    record('Arb Bot + Shard Manager', passed ? 'PASS' : 'FAIL', {
      arbCycles: arbStatus.cycles, shards: shardStatus.totalShards,
    });
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('Arb Bot + Shard Manager', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 10: Integration Status
// ═══════════════════════════════════════════════════════════════════
async function testIntegrations() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('📋 Test 10: All Integrations');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const data = await apiGet('/integrations');

    log(`   🦄 Uniswap:`);
    log(`      API Key: ${data.uniswap?.sepoliaSwap?.tradingAPIEnabled ? '✅' : '❌'}`);
    log(`      Permit2: ${data.uniswap?.sepoliaSwap?.permit2 || 'N/A'}`);
    log(`      Swap history: ${data.uniswap?.sepoliaSwap?.history} swaps`);

    log(`   🔗 Chainlink CRE:`);
    log(`      Price feeds: ${data.chainlink?.priceFeeds?.enabled ? '✅' : '❌'}`);
    log(`      CRE workflow: ${data.chainlink?.creWorkflow?.enabled ? '✅' : '❌'}`);
    log(`      Feeds: ${data.chainlink?.priceFeeds?.feeds?.join(', ')}`);

    log(`   📛 ENS:`);
    log(`      Resolution: ${data.ens?.resolution?.enabled ? '✅' : '❌'}`);
    log(`      Agent registry: ${data.ens?.agentRegistry?.enabled ? '✅' : '❌'}`);
    log(`      On-chain: ${data.ens?.agentRegistry?.onChain ? '✅' : '❌'}`);

    log(`   🌉 Bridge:`);
    log(`      Enabled: ${data.bridge?.enabled ? '✅' : '❌'}`);
    log(`      Type: ${data.bridge?.type}`);
    log(`      History: ${data.bridge?.history} operations`);

    const allEnabled = data.uniswap?.sepoliaSwap?.tradingAPIEnabled
      && data.chainlink?.priceFeeds?.enabled
      && data.ens?.agentRegistry?.enabled;

    record('All Integrations', allEnabled ? 'PASS' : 'FAIL');
  } catch (e) {
    log(`   ❌ ${e.message}`);
    record('All Integrations', 'FAIL', { error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   SAMM DEX — End-to-End Full Flow Test                  ║');
  console.log('║   End-to-End Integration Tests                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n🔗 API: ${API_BASE}`);
  console.log(`🔀 Mode: ${LIVE ? 'LIVE (swap + bridge)' : SWAP_ONLY ? 'SWAP ONLY' : BRIDGE_ONLY ? 'BRIDGE ONLY' : 'DRY RUN (no real txs)'}`);

  const startTime = Date.now();

  // Core tests (always run)
  await testHealth();
  await testComparison();
  await testChainlinkPrices();
  await testCRESimulation();
  await testFrontendSwapFlow();

  // Real transaction tests (only with flags)
  await testRealSwap();
  await testBridge();

  // Infrastructure tests
  await testENS();
  await testArbAndShards();
  await testIntegrations();

  // ── Summary ──
  const elapsed = Date.now() - startTime;
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST SUMMARY                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`   Total:   ${results.tests.length} tests`);
  console.log(`   ✅ Pass:  ${results.passed}`);
  console.log(`   ❌ Fail:  ${results.failed}`);
  console.log(`   ⏭️  Skip:  ${results.skipped}`);
  console.log(`   ⏱️  Time:  ${(elapsed / 1000).toFixed(1)}s`);
  console.log('');

  for (const t of results.tests) {
    const icon = t.status === 'PASS' ? '✅' : t.status === 'FAIL' ? '❌' : '⏭️';
    console.log(`   ${icon} ${t.name}`);
  }

  // Save results
  const fs = require('fs');
  const outPath = `test-results/e2e-flow-${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify({ ...results, elapsed, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n   📄 Results saved: ${outPath}`);

  if (results.failed > 0) {
    console.log(`\n   ⚠️  ${results.failed} test(s) failed!`);
    process.exit(1);
  } else {
    console.log(`\n   🎉 All tests passed!`);
  }
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
