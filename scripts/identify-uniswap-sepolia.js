const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');

const C1 = '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b';
const C2 = '0x8b844f885672f333bc0042cb669255f93a4c1e6b';

async function tryCall(addr, abi, fn, label) {
  try {
    const c = new ethers.Contract(addr, abi, p);
    const result = await c[fn]();
    console.log(`  ${label}.${fn}() = ${result}`);
    return result;
  } catch (e) {
    console.log(`  ${label}.${fn}() FAILED: ${e.message.slice(0, 60)}`);
    return null;
  }
}

(async () => {
  console.log('=== Contract 1:', C1, '===');
  // V2 Router
  await tryCall(C1, ['function factory() view returns (address)'], 'factory', 'C1');
  await tryCall(C1, ['function WETH() view returns (address)'], 'WETH', 'C1');
  // V3 Router  
  await tryCall(C1, ['function WETH9() view returns (address)'], 'WETH9', 'C1');
  // UniversalRouter / SwapRouter02
  await tryCall(C1, ['function multicall(uint256,bytes[]) payable returns (bytes[])'], 'multicall', 'C1');

  console.log('\n=== Contract 2:', C2, '===');
  // V2 Factory
  await tryCall(C2, ['function allPairsLength() view returns (uint)'], 'allPairsLength', 'C2');
  await tryCall(C2, ['function feeTo() view returns (address)'], 'feeTo', 'C2');
  // V3 Factory
  await tryCall(C2, ['function owner() view returns (address)'], 'owner', 'C2');
  // Could be another router
  await tryCall(C2, ['function factory() view returns (address)'], 'factory', 'C2');
  await tryCall(C2, ['function WETH9() view returns (address)'], 'WETH9', 'C2');
  await tryCall(C2, ['function WETH() view returns (address)'], 'WETH', 'C2');
  
  // Check known Uniswap V2 Sepolia addresses
  console.log('\n=== Known Uniswap V2 on Sepolia ===');
  // Official Uniswap V2 Router02 on Sepolia: 0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3 (might differ)
  // Let's check the standard ones
  const knownV2Router = '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008'; // common sepolia V2 router
  const codeLen = await p.getCode(knownV2Router);
  console.log('  Known V2 Router code length:', codeLen.length);
})();
