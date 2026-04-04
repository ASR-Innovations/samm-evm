const { ethers } = require('ethers');

const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const V2_FACTORY = '0xB7f907f7A9eBC822a80BD25E224be42Ce0A698A0';
const WETH9 = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

// Known Sepolia test tokens
const KNOWN_TOKENS = {
  '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14': { symbol: 'WETH', decimals: 18 },
  '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': { symbol: 'USDC', decimals: 6 },
  '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06': { symbol: 'USDT', decimals: 6 },
  '0x29f2D40B0605204364af54EC677bD022dA425d03': { symbol: 'WBTC', decimals: 8 },
  '0x68194a729C2450ad26072b3D33ADaCbcef39D574': { symbol: 'DAI', decimals: 18 },
  '0x779877A7B0D9E8603169DdbD7836e478b4624789': { symbol: 'LINK', decimals: 18 },
  '0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904': { symbol: 'LINK', decimals: 18 },
};

const factoryAbi = ['function allPairsLength() view returns (uint)','function allPairs(uint) view returns (address)','function getPair(address,address) view returns (address)'];
const pairAbi = ['function getReserves() view returns (uint112,uint112,uint32)','function token0() view returns (address)','function token1() view returns (address)'];
const erc20Abi = ['function symbol() view returns (string)','function decimals() view returns (uint8)'];

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const factory = new ethers.Contract(V2_FACTORY, factoryAbi, provider);
  
  // Check wallet balance first
  const wallet = '0x004566C322f5F1CBC0594928556441f8D38EA589';
  const balance = await provider.getBalance(wallet);
  console.log(`Wallet ${wallet} Sepolia ETH: ${ethers.formatEther(balance)}`);
  
  // Check specific known token pairs with WETH
  const knownTokens = Object.keys(KNOWN_TOKENS).filter(a => a.toLowerCase() !== WETH9.toLowerCase());
  
  console.log('\n=== Checking known token pairs with WETH ===');
  for (const token of knownTokens) {
    try {
      const pairAddr = await factory.getPair(WETH9, token);
      if (pairAddr !== '0x0000000000000000000000000000000000000000') {
        const pair = new ethers.Contract(pairAddr, pairAbi, provider);
        const [r0, r1] = await pair.getReserves();
        const t0 = await pair.token0();
        const info = KNOWN_TOKENS[token];
        const isT0Weth = t0.toLowerCase() === WETH9.toLowerCase();
        const wethReserve = isT0Weth ? r0 : r1;
        const tokenReserve = isT0Weth ? r1 : r0;
        console.log(`\nWETH/${info.symbol}: ${pairAddr}`);
        console.log(`  WETH: ${ethers.formatEther(wethReserve)}`);
        console.log(`  ${info.symbol}: ${ethers.formatUnits(tokenReserve, info.decimals)}`);
        console.log(`  Has liquidity: ${wethReserve > 0n && tokenReserve > 0n ? 'YES' : 'NO'}`);
      }
    } catch(e) {
      console.log(`WETH/${KNOWN_TOKENS[token].symbol}: error - ${e.message.substring(0, 60)}`);
    }
  }
  
  // Also check first 15 pairs by index for liquid WETH pairs
  console.log('\n=== Scanning first 15 pairs by index ===');
  const count = await factory.allPairsLength();
  console.log('Total pairs:', count.toString());
  
  const batch = 5;
  for (let start = 0; start < 15; start += batch) {
    const promises = [];
    for (let i = start; i < Math.min(start + batch, 15); i++) {
      promises.push((async () => {
        try {
          const pa = await factory.allPairs(i);
          const pair = new ethers.Contract(pa, pairAbi, provider);
          const [r0, r1] = await pair.getReserves();
          if (r0 > 0n && r1 > 0n) {
            const t0 = await pair.token0();
            const t1 = await pair.token1();
            let sym0, sym1, dec0 = 18, dec1 = 18;
            if (KNOWN_TOKENS[t0]) { sym0 = KNOWN_TOKENS[t0].symbol; dec0 = KNOWN_TOKENS[t0].decimals; }
            else { try { sym0 = await (new ethers.Contract(t0, erc20Abi, provider)).symbol(); } catch(e) { sym0 = 'UNK'; } }
            if (KNOWN_TOKENS[t1]) { sym1 = KNOWN_TOKENS[t1].symbol; dec1 = KNOWN_TOKENS[t1].decimals; }
            else { try { sym1 = await (new ethers.Contract(t1, erc20Abi, provider)).symbol(); } catch(e) { sym1 = 'UNK'; } }
            const hw = t0.toLowerCase() === WETH9.toLowerCase() || t1.toLowerCase() === WETH9.toLowerCase();
            return `Pair ${i}: ${sym0}/${sym1} ${hw ? '*** WETH ***' : ''}\n  ${sym0}: ${ethers.formatUnits(r0, dec0)}\n  ${sym1}: ${ethers.formatUnits(r1, dec1)}`;
          }
          return null;
        } catch(e) { return null; }
      })());
    }
    const results = await Promise.all(promises);
    results.filter(r => r).forEach(r => console.log(r));
  }
}

main().catch(e => console.error('Error:', e.message));
