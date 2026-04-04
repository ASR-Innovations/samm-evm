/**
 * Test: Real Uniswap V2 Swap on Sepolia via Direct V2 Pair
 * 
 * Executes a small ETH → Token swap through direct V2 pair interaction
 * (wrap ETH → transfer WETH to pair → pair.swap)
 * 
 * Uses Rome/WETH pair which has good liquidity on Sepolia.
 * 
 * Usage: node scripts/test-uniswap-sepolia-swap.js
 */

require('dotenv').config();
const UniswapSepoliaSwap = require('../integrations/uniswap-sepolia-swap');

// Rome token on Sepolia (good liquidity in WETH/Rome V2 pair)
const ROME_TOKEN = '0xbF23b6361146D7b1756bD68651aF6cb83bD1bcA0';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Uniswap Sepolia — Real Swap Test via Direct V2 Pair');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!process.env.PRIVATE_KEY) {
    console.error('❌ PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const swapper = new UniswapSepoliaSwap(
    process.env.PRIVATE_KEY,
    process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
  );

  // Step 1: Check balances
  console.log('📊 Step 1: Checking wallet balances...');
  const balances = await swapper.getBalances();
  console.log(`  Wallet: ${balances.wallet}`);
  for (const [token, amount] of Object.entries(balances.balances)) {
    if (Number(amount) > 0) {
      console.log(`  ${token}: ${amount}`);
    }
  }

  // Step 2: Check WETH/Rome pair info
  const WETH = UniswapSepoliaSwap.ADDRESSES.WETH9;
  console.log('\n📊 Step 2: Checking WETH/Rome V2 pair...');
  const pairInfo = await swapper.getPairInfo(WETH, ROME_TOKEN);
  if (!pairInfo.exists) {
    console.error('❌ No WETH/Rome V2 pair found on Sepolia');
    process.exit(1);
  }
  console.log(`  Pair: ${pairInfo.pair}`);
  console.log(`  WETH Reserve: ${pairInfo.reserveA}`);
  console.log(`  Rome Reserve: ${pairInfo.reserveB}`);

  // Step 3: Get a quote for a small swap
  const swapAmountETH = '0.0001'; // Very small test swap (save ETH)
  console.log(`\n📊 Step 3: Getting quote for ${swapAmountETH} ETH → Rome...`);
  
  const { ethers } = require('ethers');
  const amountIn = ethers.parseEther(swapAmountETH);
  const quote = await swapper.getSwapQuote(WETH, ROME_TOKEN, amountIn);
  
  if (quote.error) {
    console.error(`❌ Quote error: ${quote.error}`);
    process.exit(1);
  }
  
  console.log(`  Expected Rome out: ${quote.amountOut}`);
  console.log(`  Price impact: ${quote.priceImpact}`);
  console.log(`  Pair address: ${quote.pair}`);

  // Step 4: Execute the swap!
  console.log(`\n🔄 Step 4: Executing swap — ${swapAmountETH} ETH → Rome...`);
  console.log('  ⚠️  This is a REAL on-chain transaction on Sepolia testnet');
  console.log('  Method: Direct V2 pair (wrap ETH → transfer WETH → pair.swap)');
  
  try {
    const result = await swapper.swapETHForToken(ROME_TOKEN, swapAmountETH, 1000); // 10% slippage for testnet
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ✅ SWAP SUCCESSFUL!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Tx Hash:  ${result.txHash}`);
    console.log(`  Block:    ${result.blockNumber}`);
    console.log(`  Gas Used: ${result.gasUsed}`);
    console.log(`  ETH In:   ${result.ethIn}`);
    console.log(`  Method:   ${result.method}`);
    console.log(`  Pair:     ${result.pair}`);
    console.log(`  Status:   ${result.status}`);
    console.log(`  Explorer: https://sepolia.etherscan.io/tx/${result.txHash}`);
    
  } catch (error) {
    console.error('\n❌ Swap failed:', error.message);
    
    if (error.message.includes('insufficient')) {
      console.log('\n💡 Need more Sepolia ETH. Get some from:');
      console.log('   https://www.alchemy.com/faucets/ethereum-sepolia');
      console.log('   https://faucets.chain.link/sepolia');
    }
  }

  // Step 5: Check balances after
  console.log('\n📊 Step 5: Post-swap balances...');
  const balancesAfter = await swapper.getBalances();
  for (const [token, amount] of Object.entries(balancesAfter.balances)) {
    if (Number(amount) > 0) {
      console.log(`  ${token}: ${amount}`);
    }
  }

  // Step 6: Show swap history
  console.log('\n📜 Swap History:');
  const history = swapper.getHistory();
  history.forEach((h, i) => {
    console.log(`  [${i+1}] ${h.status} | ${h.method} | tx: ${h.txHash.slice(0,10)}...`);
  });

  console.log('\n✅ Test complete');
}

main().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
