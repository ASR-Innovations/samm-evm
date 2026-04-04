/**
 * Try swapping with different pairs and smaller amounts
 * to find a working V2 swap on Sepolia.
 */
require('dotenv').config();
const { ethers } = require('ethers');

const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const WETH9 = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const UNIVERSAL_ROUTER = '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b';
const V2_FACTORY = '0xB7f907f7A9eBC822a80BD25E224be42Ce0A698A0';

const routerABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable',
];
const pairABI = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const erc20ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const router = new ethers.Contract(UNIVERSAL_ROUTER, routerABI, wallet);
  const factory = new ethers.Contract(V2_FACTORY, [
    'function getPair(address,address) view returns (address)',
    'function allPairs(uint) view returns (address)',
    'function allPairsLength() view returns (uint)',
  ], provider);
  
  console.log('Wallet:', wallet.address);
  console.log('ETH:', ethers.formatEther(await provider.getBalance(wallet.address)));
  
  // Check pair #3 (Rome/WETH - has liquidity)
  const romePairAddr = await factory.allPairs(3);
  const romePair = new ethers.Contract(romePairAddr, pairABI, provider);
  const [r0_r, r1_r] = await romePair.getReserves();
  const t0_r = await romePair.token0();
  const t1_r = await romePair.token1();
  
  const romeToken = t0_r.toLowerCase() === WETH9.toLowerCase() ? t1_r : t0_r;
  const romeContract = new ethers.Contract(romeToken, erc20ABI, provider);
  const romeSymbol = await romeContract.symbol();
  const romeDecimals = await romeContract.decimals();
  
  console.log('\nRome/WETH pair:', romePairAddr);
  console.log('Rome token:', romeToken, romeSymbol, 'decimals:', romeDecimals);
  console.log('Reserves:', r0_r.toString(), '/', r1_r.toString());
  
  // Try very small ETH→Rome swap (0.0001 ETH)
  const amountIn = ethers.parseEther('0.0001');
  const path = [WETH9, romeToken];
  
  // Calculate expected output
  const isWethT0 = t0_r.toLowerCase() === WETH9.toLowerCase();
  const [wethRes, romeRes] = isWethT0 ? [r0_r, r1_r] : [r1_r, r0_r];
  
  const amtFee = amountIn * 997n;
  const num = amtFee * romeRes;
  const den = wethRes * 1000n + amtFee;
  const expectedOut = num / den;
  console.log('Expected Rome out:', ethers.formatUnits(expectedOut, romeDecimals));
  
  const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
  const MSG_SENDER = '0x0000000000000000000000000000000000000001';
  
  const wrapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [ADDRESS_THIS, amountIn]
  );
  
  const swapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'uint256', 'address[]', 'bool'],
    [MSG_SENDER, amountIn, 0n, path, false]
  );
  
  const commands = new Uint8Array([0x0b, 0x08]);
  const inputs = [wrapInput, swapInput];
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  
  console.log('\n--- Trying staticCall with Rome/WETH ---');
  try {
    await router.execute.staticCall(commands, inputs, deadline, { value: amountIn });
    console.log('staticCall SUCCESS! Proceeding with real tx...');
    
    const tx = await router.execute(commands, inputs, deadline, {
      value: amountIn,
      gasLimit: 300000n,
    });
    console.log('Tx submitted:', tx.hash);
    const receipt = await tx.wait();
    console.log('Confirmed! Block:', receipt.blockNumber, 'Gas:', receipt.gasUsed.toString());
    console.log('Status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');
    console.log('Explorer: https://sepolia.etherscan.io/tx/' + tx.hash);
    
    // Check Rome balance after
    const romeBal = await romeContract.balanceOf(wallet.address);
    console.log('Rome balance after:', ethers.formatUnits(romeBal, romeDecimals));
    
  } catch (e) {
    console.log('Failed:', e.message.substring(0, 200));
    
    // Try with even smaller amount
    console.log('\n--- Trying with 0.00001 ETH ---');
    const tinyAmt = ethers.parseEther('0.00001');
    const tinyWrap = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'], [ADDRESS_THIS, tinyAmt]
    );
    const tinySwap = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256', 'uint256', 'address[]', 'bool'],
      [MSG_SENDER, tinyAmt, 0n, path, false]
    );
    try {
      await router.execute.staticCall(new Uint8Array([0x0b, 0x08]), [tinyWrap, tinySwap], deadline, { value: tinyAmt });
      console.log('Tiny staticCall SUCCESS!');
    } catch (e2) {
      console.log('Tiny also failed:', e2.message.substring(0, 200));
    }
  }
  
  // Also try stETH/WETH pair (pair index 10)
  console.log('\n--- Checking stETH/WETH (pair 10) ---');
  try {
    const stethPairAddr = await factory.allPairs(10);
    const stethPair = new ethers.Contract(stethPairAddr, pairABI, provider);
    const [sr0, sr1] = await stethPair.getReserves();
    const st0 = await stethPair.token0();
    const st1 = await stethPair.token1();
    const stethToken = st0.toLowerCase() === WETH9.toLowerCase() ? st1 : st0;
    const stethC = new ethers.Contract(stethToken, erc20ABI, provider);
    console.log('stETH:', stethToken, await stethC.symbol());
    console.log('Reserves:', sr0.toString(), sr1.toString());
  } catch(e) {
    console.log('stETH check failed');
  }
}

main().catch(console.error);
