#!/usr/bin/env node
/**
 * Test RiseChain Bridge — Sepolia → RiseChain ETH deposit
 * 
 * Sends a tiny amount (0.001 ETH) from Sepolia through the OP Stack canonical bridge.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const RiseChainBridge = require('./risechain-bridge');

async function main() {
  const bridge = new RiseChainBridge(
    process.env.PRIVATE_KEY,
    process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
    process.env.RISECHAIN_RPC_URL || 'https://testnet.riselabs.xyz/http',
  );

  console.log('═══════════════════════════════════════════════════');
  console.log('🌉 RiseChain Bridge Test — Sepolia → RiseChain');
  console.log('═══════════════════════════════════════════════════');

  // Step 1: Check balances
  console.log('\n📊 Pre-bridge balances:');
  const balances = await bridge.getBalances();
  console.log(`   Sepolia ETH:    ${balances.sepolia.ETH}`);
  console.log(`   RiseChain ETH:  ${balances.risechain.ETH}`);
  console.log(`   Wallet: ${balances.wallet}`);

  // Step 2: Deposit 0.001 ETH from Sepolia → RiseChain
  const amount = '0.001';
  console.log(`\n🚀 Depositing ${amount} ETH...`);
  
  try {
    const result = await bridge.depositETH(amount);
    console.log('\n✅ Bridge deposit result:');
    console.log(JSON.stringify(result, null, 2));

    // Step 3: Check balances after
    console.log('\n📊 Post-bridge balances (L2 credit takes a few minutes):');
    const after = await bridge.getBalances();
    console.log(`   Sepolia ETH:    ${after.sepolia.ETH}`);
    console.log(`   RiseChain ETH:  ${after.risechain.ETH}`);
  } catch (err) {
    console.error(`\n❌ Bridge error: ${err.message}`);
    if (err.data) console.error(`   Data: ${err.data}`);
    if (err.transaction) console.error(`   Tx to: ${err.transaction.to}`);
  }

  console.log('\n═══════════════════════════════════════════════════');
}

main().catch(console.error);
