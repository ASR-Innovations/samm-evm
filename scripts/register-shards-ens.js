/**
 * Register all SAMM pool shards in the ENS Agent Registry
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

async function main() {
  const RPC_URL = process.env.RISECHAIN_RPC_URL || 'https://testnet.riselabs.xyz/http';
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  // Find latest ENS registry deployment
  const deployDir = path.join(__dirname, '..', 'deployment-data');
  const ensFile = fs.readdirSync(deployDir)
    .filter(f => f.startsWith('ens-registry-risechain'))
    .sort().pop();
  
  if (!ensFile) {
    console.error('No ENS registry deployment found. Run deploy-ens-registry-risechain.js first.');
    process.exit(1);
  }
  
  const ensData = JSON.parse(fs.readFileSync(path.join(deployDir, ensFile), 'utf8'));
  const registryAddr = ensData.contracts.SAMMAgentRegistry;
  console.log(`ENS Registry: ${registryAddr}`);
  
  const registryABI = [
    'function registerOrUpdateShard(string pair, string tier, string ensName, address shardAddress, bool active) external',
    'function listShards() view returns (tuple(string pair, string tier, string ensName, address shardAddress, bool active, uint64 updatedAt)[])',
  ];
  const registry = new ethers.Contract(registryAddr, registryABI, wallet);
  
  // Load production deployment
  const prodFile = fs.readdirSync(deployDir)
    .filter(f => f.startsWith('production-risechain'))
    .sort().pop();
  const prodData = JSON.parse(fs.readFileSync(path.join(deployDir, prodFile), 'utf8'));
  
  console.log('\n🧩 Registering shards...\n');
  
  let registered = 0;
  for (const [pairName, shards] of Object.entries(prodData.contracts.shards)) {
    for (const shard of shards) {
      const tierMatch = shard.name.replace(pairName + '-', '');
      const ensName = `${tierMatch.toLowerCase()}.${pairName.toLowerCase()}.samm.eth`;
      
      try {
        const tx = await registry.registerOrUpdateShard(
          pairName, tierMatch, ensName, shard.address, true
        );
        await tx.wait();
        console.log(`  ✅ ${shard.name}: ${ensName} → ${shard.address.slice(0, 10)}...`);
        registered++;
      } catch (e) {
        console.log(`  ❌ ${shard.name}: ${e.message.slice(0, 60)}`);
      }
    }
  }
  
  // Verify
  const allShards = await registry.listShards();
  console.log(`\n📋 Total shards registered: ${allShards.length}`);
  console.log(`✅ Done (${registered} registered)`);
}

main().catch(e => { console.error(e); process.exit(1); });
