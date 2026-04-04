/**
 * Debug: Try V2 swap via direct V2 Router instead of UniversalRouter
 * to isolate the revert issue.
 */
require('dotenv').config();
const { ethers } = require('ethers');

const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const WETH9 = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const V2_FACTORY = '0xB7f907f7A9eBC822a80BD25E224be42Ce0A698A0';
const UNIVERSAL_ROUTER = '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b';

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  console.log('=== Debug V2 Swap ===');
  console.log('Wallet:', wallet.address);
  
  // 1. Check pair reserves more closely
  const factoryABI = ['function getPair(address,address) view returns (address)'];
  const pairABI = [
    'function getReserves() view returns (uint112,uint112,uint32)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function swap(uint256,uint256,address,bytes) external',
  ];
  
  const factory = new ethers.Contract(V2_FACTORY, factoryABI, provider);
  const pairAddr = await factory.getPair(WETH9, USDC);
  console.log('V2 Pair:', pairAddr);
  
  const pair = new ethers.Contract(pairAddr, pairABI, provider);
  const token0 = await pair.token0();
  const token1 = await pair.token1();
  console.log('token0:', token0);
  console.log('token1:', token1);
  
  const [r0, r1] = await pair.getReserves();
  console.log('reserve0:', r0.toString());
  console.log('reserve1:', r1.toString());
  
  // Check if USDC on Sepolia is the Circle one (6 decimals)
  const usdcContract = new ethers.Contract(USDC, [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function balanceOf(address) view returns (uint256)',
  ], provider);
  
  const usdcDecimals = await usdcContract.decimals();
  const usdcSymbol = await usdcContract.symbol();
  const usdcName = await usdcContract.name();
  console.log('\nUSDC contract:', USDC);
  console.log('  name:', usdcName);
  console.log('  symbol:', usdcSymbol);
  console.log('  decimals:', usdcDecimals);
  
  // 2. Check WETH contract
  const wethContract = new ethers.Contract(WETH9, [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function deposit() payable',
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
  ], wallet);
  
  const wethBal = await wethContract.balanceOf(wallet.address);
  console.log('\nWETH balance:', ethers.formatEther(wethBal));
  
  // 3. Try calling staticCall on the router to get the revert reason
  const routerABI = [
    'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable',
  ];
  const router = new ethers.Contract(UNIVERSAL_ROUTER, routerABI, wallet);
  
  const amountIn = ethers.parseEther('0.0005');
  
  // Calculate V2 output
  const isWethToken0 = token0.toLowerCase() === WETH9.toLowerCase();
  const [wethReserve, usdcReserve] = isWethToken0 ? [r0, r1] : [r1, r0];
  console.log('\nWETH reserve:', wethReserve.toString());
  console.log('USDC reserve:', usdcReserve.toString());
  
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * usdcReserve;
  const denominator = wethReserve * 1000n + amountInWithFee;
  const expectedOut = numerator / denominator;
  console.log('Expected USDC out:', expectedOut.toString());
  
  // Build commands
  const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
  const MSG_SENDER = '0x0000000000000000000000000000000000000001';
  
  const wrapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [ADDRESS_THIS, amountIn]
  );
  
  const swapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'uint256', 'address[]', 'bool'],
    [MSG_SENDER, amountIn, 0n, [WETH9, USDC], false]
  );
  
  const commands = new Uint8Array([0x0b, 0x08]);
  const inputs = [wrapInput, swapInput];
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  
  console.log('\n--- Trying staticCall ---');
  try {
    const result = await router.execute.staticCall(
      commands, inputs, deadline,
      { value: amountIn }
    );
    console.log('staticCall succeeded!', result);
  } catch (e) {
    console.log('staticCall reverted:', e.message.substring(0, 200));
    
    // Try with revert data
    if (e.data) {
      console.log('revert data:', e.data);
    }
    
    // Also try with eth_call to get revert reason
    try {
      const encoded = router.interface.encodeFunctionData('execute', [commands, inputs, deadline]);
      const callResult = await provider.call({
        to: UNIVERSAL_ROUTER,
        data: encoded,
        value: amountIn,
        from: wallet.address,
      });
      console.log('eth_call result:', callResult);
    } catch (e2) {
      console.log('eth_call error:', e2.message.substring(0, 300));
      if (e2.data) console.log('eth_call revert data:', e2.data);
    }
  }
}

main().catch(console.error);
