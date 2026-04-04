const { ethers } = require('ethers');

const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const V2_FACTORY = '0xB7f907f7A9eBC822a80BD25E224be42Ce0A698A0';
const WETH9 = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

const factoryAbi = [
  'function allPairsLength() view returns (uint)',
  'function allPairs(uint) view returns (address)',
  'function getPair(address,address) view returns (address)'
];
const pairAbi = [
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];
const erc20Abi = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const factory = new ethers.Contract(V2_FACTORY, factoryAbi, provider);
  
  const count = await factory.allPairsLength();
  console.log('Total V2 pairs on Sepolia:', count.toString());
  
  const check = Math.min(Number(count), 50);
  let liquidPairs = [];
  
  for (let i = 0; i < check; i++) {
    try {
      const pairAddr = await factory.allPairs(i);
      const pair = new ethers.Contract(pairAddr, pairAbi, provider);
      const [r0, r1] = await pair.getReserves();
      
      if (r0 > 0n && r1 > 0n) {
        const t0 = await pair.token0();
        const t1 = await pair.token1();
        const hasWETH = t0.toLowerCase() === WETH9.toLowerCase() || t1.toLowerCase() === WETH9.toLowerCase();
        
        let sym0 = 'UNKNOWN', sym1 = 'UNKNOWN', dec0 = 18, dec1 = 18;
        try {
          const tok0 = new ethers.Contract(t0, erc20Abi, provider);
          sym0 = await tok0.symbol();
          dec0 = await tok0.decimals();
        } catch(e) {}
        try {
          const tok1 = new ethers.Contract(t1, erc20Abi, provider);
          sym1 = await tok1.symbol();
          dec1 = await tok1.decimals();
        } catch(e) {}
        
        console.log(`\nPair ${i}: ${pairAddr} ${hasWETH ? '*** HAS WETH ***' : ''}`);
        console.log(`  ${sym0} (${t0}): ${ethers.formatUnits(r0, dec0)}`);
        console.log(`  ${sym1} (${t1}): ${ethers.formatUnits(r1, dec1)}`);
        
        liquidPairs.push({ index: i, pair: pairAddr, t0, t1, sym0, sym1, r0, r1, hasWETH });
      }
    } catch(e) {
      // skip
    }
  }
  
  console.log('\n\n=== SUMMARY ===');
  console.log(`Found ${liquidPairs.length} pairs with liquidity out of ${check} checked`);
  console.log('WETH pairs:', liquidPairs.filter(p => p.hasWETH).length);
  
  // Also check wallet balance
  const wallet = '0x004566C322f5F1CBC0594928556441f8D38EA589';
  const balance = await provider.getBalance(wallet);
  console.log(`\nWallet ${wallet} Sepolia ETH: ${ethers.formatEther(balance)}`);
}

main().catch(e => console.error('Error:', e.message));
