// Quick debug: test if SAMM swap works via direct contract call
require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
  const p = new ethers.JsonRpcProvider(process.env.RISECHAIN_RPC_URL);
  const w = new ethers.Wallet(process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : '0x' + process.env.PRIVATE_KEY, p);
  const d = require('../deployment-data/production-risechain-1774811017268.json');
  
  const router = new ethers.Contract(d.contracts.router, [
    'function quoteSwap((address tokenIn, address tokenOut, uint256 amountOut)[] hops) view returns (tuple(uint256 expectedAmountIn, uint256[] hopAmountsIn, uint256[] hopFees, address[] selectedShards, uint256[] priceImpacts))',
    'function executeSwap((address tokenIn, address tokenOut, uint256 amountOut)[] hops, uint256 maxAmountIn, address recipient) external returns (tuple(uint256 totalAmountIn, uint256 totalAmountOut, uint256 totalFees, uint256[] hopAmountsIn, uint256[] hopAmountsOut, uint256[] hopFees, address[] selectedShards))',
  ], w);

  const tIn = d.contracts.tokens.WETH.address;
  const tOut = d.contracts.tokens.USDC.address;
  const amtOut = ethers.parseUnits('1', 6);

  console.log('Quoting 1 USDC...');
  const q = await router.quoteSwap([{ tokenIn: tIn, tokenOut: tOut, amountOut: amtOut }]);
  console.log('Quote OK, amountIn:', ethers.formatUnits(q.expectedAmountIn, 18), 'WETH');
  console.log('Selected shard:', q.selectedShards[0]);

  // Check allowance
  const tokenContract = new ethers.Contract(tIn, [
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) external returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], w);
  const allow = await tokenContract.allowance(w.address, d.contracts.router);
  console.log('Allowance:', ethers.formatUnits(allow, 18), 'WETH');

  const balance = await tokenContract.balanceOf(w.address);
  console.log('Balance:', ethers.formatUnits(balance, 18), 'WETH');

  if (allow < q.expectedAmountIn) {
    console.log('Approving...');
    const tx = await tokenContract.approve(d.contracts.router, ethers.MaxUint256);
    await tx.wait();
    console.log('Approved');
  }

  // Static call first
  const maxIn = q.expectedAmountIn * 150n / 100n;
  try {
    const result = await router.executeSwap.staticCall(
      [{ tokenIn: tIn, tokenOut: tOut, amountOut: amtOut }],
      maxIn, w.address
    );
    console.log('Static call OK, totalAmountIn:', ethers.formatUnits(result.totalAmountIn, 18));
  } catch (e) {
    console.log('Static call FAILED:', e.message?.slice(0, 300));
    // Try with higher gas
    try {
      const result = await router.executeSwap.staticCall(
        [{ tokenIn: tIn, tokenOut: tOut, amountOut: amtOut }],
        maxIn, w.address,
        { gasLimit: 2_000_000 }
      );
      console.log('Static call OK (higher gas), totalAmountIn:', ethers.formatUnits(result.totalAmountIn, 18));
    } catch (e2) {
      console.log('Static call FAILED (higher gas):', e2.message?.slice(0, 300));
    }
  }

  // Try calling pool directly
  const poolAddr = q.selectedShards[0];
  const pool = new ethers.Contract(poolAddr, [
    'function calculateSwapSAMM(uint256,address,address) view returns (tuple(uint256 amountIn,uint256 amountOut,uint256 tradeFee,uint256 ownerFee))',
    'function swapSAMM(uint256,uint256,address,address,address) external returns (uint256)',
    'function getReserves() view returns (uint256,uint256)',
    'function tokenA() view returns (address)',
    'function tokenB() view returns (address)',
  ], w);

  console.log('\nPool direct test on:', poolAddr);
  const [rA, rB] = await pool.getReserves();
  const pTokenA = await pool.tokenA();
  const pTokenB = await pool.tokenB();
  console.log('tokenA:', pTokenA, 'tokenB:', pTokenB);
  console.log('reserveA:', ethers.formatUnits(rA, 18), 'reserveB:', ethers.formatUnits(rB, 6));
  
  const calcResult = await pool.calculateSwapSAMM(amtOut, tIn, tOut);
  console.log('calculateSwapSAMM OK, amountIn:', ethers.formatUnits(calcResult.amountIn, 18));

  // Approve pool directly
  const poolAllow = await tokenContract.allowance(w.address, poolAddr);
  console.log('Pool allowance:', ethers.formatUnits(poolAllow, 18));
  if (poolAllow < calcResult.amountIn) {
    console.log('Approving pool...');
    const atx = await tokenContract.approve(poolAddr, ethers.MaxUint256);
    await atx.wait();
    console.log('Pool approved');
  }

  // Static call on pool directly  
  const maxInPool = calcResult.amountIn * 120n / 100n;
  try {
    await pool.swapSAMM.staticCall(amtOut, maxInPool, tIn, tOut, w.address, { gasLimit: 500_000 });
    console.log('Pool static call OK');
  } catch (e) {
    console.log('Pool static call FAILED:', e.message?.slice(0, 300));
  }

  // Try real pool swap
  console.log('\nExecuting direct pool swap...');
  try {
    const tx = await pool.swapSAMM(amtOut, maxInPool, tIn, tOut, w.address, { gasLimit: 500_000 });
    console.log('TX:', tx.hash);
    const receipt = await tx.wait();
    console.log('Confirmed block:', receipt.blockNumber, 'gas:', receipt.gasUsed.toString(), 'status:', receipt.status);
  } catch (e) {
    console.log('Pool swap FAILED:', e.message?.slice(0, 300));
  }
}

main().catch(e => console.error('FATAL:', e.message));
