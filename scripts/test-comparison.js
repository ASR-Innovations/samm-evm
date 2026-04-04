#!/usr/bin/env node
/**
 * Test SAMM vs Uniswap comparison across multiple trade sizes and pairs.
 * Run: node scripts/test-comparison.js
 */
const http = require('http');

function get(path) {
  return new Promise((resolve) => {
    http.get('http://localhost:3000' + path, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ error: d }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

async function main() {
  console.log('\n=== SAMM vs Uniswap Comparison Test ===\n');

  // 1. Test multiple trade sizes for WETH/USDC
  const sizes = [10, 50, 100, 500, 1000, 5000];
  console.log('WETH → USDC comparison:');
  console.log('Trade Size | SAMM Rate     | Uni Rate      | Winner   | Delta %   | Shard');
  console.log('-'.repeat(90));

  for (const sz of sizes) {
    const r = await get('/compare/WETH/USDC/' + sz);
    if (r.comparison) {
      const sammRate = parseFloat(r.samm?.effectiveRate || 0).toFixed(2);
      const uniRate = parseFloat(r.uniswap?.effectiveRate || 0).toFixed(2);
      const shard = r.samm?.shard || '?';
      console.log(
        `${String(sz).padStart(10)} | ${sammRate.padStart(13)} | ${uniRate.padStart(13)} | ${(r.comparison.winner || '?').padEnd(8)} | ${(r.comparison.deltaPercent || 'n/a').padStart(9)}% | ${shard}`
      );
    } else {
      console.log(`${String(sz).padStart(10)} | ERROR: ${JSON.stringify(r).slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 2. Test other pairs
  console.log('\n\nCross-pair comparison (100 units output):');
  console.log('Pair              | SAMM Rate     | Uni Rate      | Winner   | Delta %');
  console.log('-'.repeat(85));

  const pairs = [
    ['USDC', 'USDT', 100],
    ['WBTC', 'USDC', 100],
    ['USDC', 'DAI', 100],
    ['WETH', 'USDT', 100],
  ];

  for (const [tIn, tOut, amt] of pairs) {
    const r = await get(`/compare/${tIn}/${tOut}/${amt}`);
    if (r.comparison) {
      const sammRate = parseFloat(r.samm?.effectiveRate || 0).toFixed(6);
      const uniRate = parseFloat(r.uniswap?.effectiveRate || 0).toFixed(6);
      console.log(
        `${(tIn + '→' + tOut).padEnd(17)} | ${sammRate.padStart(13)} | ${uniRate.padStart(13)} | ${(r.comparison.winner || '?').padEnd(8)} | ${(r.comparison.deltaPercent || 'n/a').padStart(9)}%`
      );
    } else {
      console.log(`${(tIn + '→' + tOut).padEnd(17)} | ERROR: ${JSON.stringify(r).slice(0, 50)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 3. Test ENS resolution
  console.log('\n\n=== ENS Resolution Test ===\n');

  const ensTests = [
    ['vitalik.eth', 'WETH'],
    ['nick.eth', 'USDC'],
  ];

  for (const [name, token] of ensTests) {
    const r = await get(`/balance/${name}/${token}`);
    if (r.address) {
      console.log(`✅ ${name} → ${r.address} (balance: ${r.balance} ${token})`);
    } else {
      console.log(`❌ ${name}: ${r.error || JSON.stringify(r)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 4. Test agent resolution
  console.log('\n=== ENS Agent Registry Test ===\n');
  const agents = await get('/agents');
  if (agents.agents) {
    for (const a of agents.agents) {
      console.log(`✅ ${a.ensName} → ${a.agentAddress} (role: ${a.role}, source: ${a.source})`);
      if (a.textRecords) {
        for (const [k, v] of Object.entries(a.textRecords)) {
          console.log(`   ${k}: ${v}`);
        }
      }
    }
  }

  // Test agent-specific endpoint
  const arbBot = await get('/agents/arb-bot');
  if (arbBot.agent) {
    console.log(`\n✅ /agents/arb-bot resolved: ${arbBot.agent.ensName}`);
    if (arbBot.ensResolution) {
      console.log(`   ENS resolution: ${arbBot.ensResolution.name} → ${arbBot.ensResolution.resolvedAddress || 'not on mainnet (expected for .samm.eth)'}`);
    }
  }

  // 5. Test shard registry
  console.log('\n=== ENS Shard Registry Test ===\n');
  const shards = await get('/registry/shards');
  if (shards.shards) {
    console.log(`Total shards registered: ${shards.count}`);
    for (const s of shards.shards.slice(0, 5)) {
      console.log(`  ${s.ensName} → ${s.shardAddress} (${s.pair} ${s.tier})`);
    }
    if (shards.count > 5) console.log(`  ... and ${shards.count - 5} more`);
  }

  // 6. Test oracle status
  console.log('\n=== Oracle Status ===\n');
  const oracle = await get('/oracle/status');
  console.log(`Primary oracle: ${oracle.primary}`);
  console.log(`Arb bot source: ${oracle.arbBotSource}`);
  console.log(`Chainlink enabled: ${oracle.chainlink?.enabled}`);
  console.log(`Chainlink feeds: ${oracle.chainlink?.feeds?.join(', ')}`);

  console.log('\n=== All Tests Complete ===\n');
}

main().catch(console.error);
