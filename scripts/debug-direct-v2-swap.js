/**
 * Try the newer UniversalRouter (0x8b84...) for V2 swaps on Sepolia.
 * Also try direct V2 pair swap (bypassing router) to isolate issues.
 */
require('dotenv').config();
const { ethers } = require('ethers');

const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const WETH9 = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const ROUTER_OLD = '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b';
const ROUTER_NEW = '0x8b844f885672f333Bc0042cB669255f93a4C1E6b';
const V2_FACTORY = '0xB7f907f7A9eBC822a80BD25E224be42Ce0A698A0';
const ROME = '0xbF23b6361146D7b1756bD68651aF6cb83bD1bcA0';

const routerABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable',
];
const pairABI = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data) external',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  console.log('Wallet:', wallet.address);
  
  // Get WETH contract
  const wethContract = new ethers.Contract(WETH9, [
    'function deposit() payable',
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
    'function approve(address,uint256) returns (bool)',
  ], wallet);
  
  // Get pair info
  const factoryC = new ethers.Contract(V2_FACTORY, [
    'function getPair(address,address) view returns (address)',
  ], provider);
  const pairAddr = await factoryC.getPair(WETH9, ROME);
  const pair = new ethers.Contract(pairAddr, pairABI, provider);
  const t0 = await pair.token0();
  const [r0, r1] = await pair.getReserves();
  console.log('Pair:', pairAddr);
  console.log('token0:', t0);
  console.log('reserves:', r0.toString(), '/', r1.toString());
  
  const isWethT0 = t0.toLowerCase() === WETH9.toLowerCase();
  const [wethRes, romeRes] = isWethT0 ? [r0, r1] : [r1, r0];
  
  // ─── Method 1: Try direct V2 pair swap (wrap WETH, send to pair, call swap) ───
  console.log('\n=== Method 1: Direct V2 Pair Swap ===');
  const swapAmt = ethers.parseEther('0.0001');
  
  // Calculate output
  const amtFee = swapAmt * 997n;
  const expectedOut = (amtFee * romeRes) / (wethRes * 1000n + amtFee);
  console.log('Amount in:', ethers.formatEther(swapAmt), 'ETH');
  console.log('Expected Rome out:', ethers.formatEther(expectedOut));
  
  // Step 1: Wrap ETH → WETH
  console.log('Wrapping ETH → WETH...');
  const wrapTx = await wethContract.deposit({ value: swapAmt });
  await wrapTx.wait();
  console.log('WETH wrapped. Balance:', ethers.formatEther(await wethContract.balanceOf(wallet.address)));
  
  // Step 2: Transfer WETH to the pair
  console.log('Transferring WETH to pair...');
  const transferTx = await wethContract.transfer(pairAddr, swapAmt);
  await transferTx.wait();
  console.log('WETH transferred to pair');
  
  // Step 3: Call swap on pair
  // amount0Out = Rome if Rome is token0, else 0
  // amount1Out = Rome if Rome is token1, else 0
  const amount0Out = isWethT0 ? 0n : expectedOut;
  const amount1Out = isWethT0 ? expectedOut : 0n;
  
  console.log('Calling pair.swap...');
  console.log('  amount0Out:', amount0Out.toString());
  console.log('  amount1Out:', amount1Out.toString());
  
  try {
    const pairWithWallet = new ethers.Contract(pairAddr, pairABI, wallet);
    const swapTx = await pairWithWallet.swap(amount0Out, amount1Out, wallet.address, '0x', {
      gasLimit: 200000n,
    });
    console.log('Swap tx:', swapTx.hash);
    const receipt = await swapTx.wait();
    console.log('✅ Direct V2 swap SUCCESS! Block:', receipt.blockNumber, 'Gas:', receipt.gasUsed.toString());
    console.log('Explorer: https://sepolia.etherscan.io/tx/' + swapTx.hash);
    
    const romeC = new ethers.Contract(ROME, ['function balanceOf(address) view returns (uint256)'], provider);
    const romeBal = await romeC.balanceOf(wallet.address);
    console.log('Rome balance:', ethers.formatEther(romeBal));
    
  } catch (e) {
    console.log('Direct V2 swap failed:', e.message.substring(0, 300));
  }
  
  // ─── Method 2: Try new router ───
  console.log('\n=== Method 2: New UniversalRouter (0x8b84...) ===');
  const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
  const MSG_SENDER = '0x0000000000000000000000000000000000000001';
  
  const wrapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'], [ADDRESS_THIS, swapAmt]
  );
  const swapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'uint256', 'address[]', 'bool'],
    [MSG_SENDER, swapAmt, 0n, [WETH9, ROME], false]
  );
  
  const routerNew = new ethers.Contract(ROUTER_NEW, routerABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  
  try {
    await routerNew.execute.staticCall(
      new Uint8Array([0x0b, 0x08]), [wrapInput, swapInput], deadline,
      { value: swapAmt }
    );
    console.log('New router staticCall SUCCESS!');
  } catch (e) {
    console.log('New router also failed:', e.message.substring(0, 200));
  }
}

main().catch(console.error);
