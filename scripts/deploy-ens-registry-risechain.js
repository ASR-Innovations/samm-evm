/**
 * Deploy SAMMAgentRegistry on RiseChain and register all agents + shards
 * 
 * Usage: npx hardhat run scripts/deploy-ens-registry-risechain.js --network risechain
 */

const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SAMM Agent Registry — Deploy & Register on RiseChain');
  console.log('═══════════════════════════════════════════════════════════');
  
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeployer: ${deployer.address}`);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} ETH\n`);

  // ── Deploy SAMMAgentRegistry ──
  console.log('📦 Deploying SAMMAgentRegistry...');
  const Registry = await hre.ethers.getContractFactory('SAMMAgentRegistry');
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`✅ SAMMAgentRegistry deployed at: ${registryAddr}\n`);

  // ── Load production deployment data ──
  const deploymentFiles = fs.readdirSync(path.join(__dirname, '..', 'deployment-data'))
    .filter(f => f.startsWith('production-risechain'));
  
  let productionData = {};
  if (deploymentFiles.length > 0) {
    const latest = deploymentFiles.sort().pop();
    productionData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'deployment-data', latest), 'utf8')
    );
    console.log(`📄 Loaded deployment data from ${latest}`);
  }

  // ── Register Agents ──
  console.log('\n🤖 Registering agents...\n');

  const agents = [
    {
      name: 'pool-router',
      ensName: 'pool-router.samm.eth',
      address: productionData.crossPoolRouter || '0x6A45347a8DbC629000F725c544D695209b0c3d00',
      role: 'routing',
    },
    {
      name: 'arb-bot',
      ensName: 'arb-bot.samm.eth',
      address: deployer.address,
      role: 'arbitrage',
    },
    {
      name: 'shard-manager',
      ensName: 'shard-manager.samm.eth',
      address: productionData.shardOrchestrator || '0x93174f86F57A97827680c279e07704AbE2a0b0c0',
      role: 'shard-orchestration',
    },
    {
      name: 'token-faucet',
      ensName: 'faucet.samm.eth',
      address: productionData.tokenFaucet || '0x42a930BF9259cE3D9e76bb1d8C61b52daf68dBE4',
      role: 'token-distribution',
    },
    {
      name: 'pool-factory',
      ensName: 'factory.samm.eth',
      address: productionData.factory || '0xc4c6ceABeBBfA1Bf9D219fE80F5b95982664fb94',
      role: 'pool-creation',
    },
  ];

  for (const agent of agents) {
    const tx = await registry.registerOrUpdateAgent(
      agent.name,
      agent.ensName,
      agent.address,
      agent.role,
      true
    );
    await tx.wait();
    console.log(`  ✅ ${agent.name} (${agent.ensName}) → ${agent.address}`);
    
    // Set text records
    const keys = ['description', 'url', 'chain'];
    const values = [
      `SAMM ${agent.role} agent`,
      'https://samm-dex.xyz',
      'risechain-testnet',
    ];
    const txRecords = await registry.setBatchAgentTextRecords(agent.name, keys, values);
    await txRecords.wait();
    console.log(`     📝 Set ${keys.length} text records`);
  }

  // ── Register Shards ──
  console.log('\n🧩 Registering shard identities...\n');

  const pairs = ['WETH-USDC', 'USDC-USDT', 'WETH-USDT', 'WBTC-USDC', 'USDC-DAI'];
  const tiers = ['Small', 'Medium', 'Large', 'Small-Dynamic'];

  // Get pool addresses from deployment data
  const pools = productionData.pools || {};
  
  for (const pair of pairs) {
    for (const tier of tiers) {
      const poolKey = `${pair}-${tier}`;
      const poolAddr = pools[poolKey] || '0x0000000000000000000000000000000000000001';
      
      if (poolAddr !== '0x0000000000000000000000000000000000000001') {
        const ensName = `${tier.toLowerCase()}.${pair.toLowerCase()}.samm.eth`;
        const tx = await registry.registerOrUpdateShard(
          pair, tier, ensName, poolAddr, true
        );
        await tx.wait();
        console.log(`  ✅ ${pair}/${tier}: ${ensName} → ${poolAddr.slice(0, 10)}...`);
      }
    }
  }

  // ── Verify ──
  console.log('\n📋 Verification:');
  const allAgents = await registry.listAgents();
  console.log(`  Agents registered: ${allAgents.length}`);
  for (const a of allAgents) {
    console.log(`    ${a.name} (${a.ensName}) → ${a.agentAddress} [${a.role}] active=${a.active}`);
  }

  const allShards = await registry.listShards();
  console.log(`  Shards registered: ${allShards.length}`);

  // ── Save deployment data ──
  const output = {
    network: 'risechain-testnet',
    chainId: 11155931,
    deployer: deployer.address,
    timestamp: Date.now(),
    contracts: {
      SAMMAgentRegistry: registryAddr,
    },
    agents: agents.map(a => ({ ...a })),
    shardCount: allShards.length,
  };

  const outPath = path.join(__dirname, '..', 'deployment-data', 
    `ens-registry-risechain-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n💾 Deployment data saved to ${path.basename(outPath)}`);
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✅ ENS Agent Registry deployment complete!');
  console.log(`  📍 Contract: ${registryAddr}`);
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('Deploy failed:', e);
  process.exit(1);
});
