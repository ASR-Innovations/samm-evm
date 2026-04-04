#!/usr/bin/env node
/**
 * SAMM ↔ Uniswap Smart Swap Routing Test Script
 * ================================================
 * 
 * Demonstrates the full swap routing flow:
 * 
 *   1. Compare SAMM (RiseChain) vs Uniswap (Sepolia) quotes
 *   2. If SAMM wins → execute swap on RiseChain backend
 *   3. If Uniswap wins → Permit2 sign + submit tx on Sepolia
 * 
 * For SAMM swaps:
 *   - Uses the backend API POST /swap (RiseChain testnet)
 *   - Backend handles: approval, router call, nonce management
 * 
 * For Uniswap swaps:
 *   - Uses Uniswap Trading API (POST /v1/quote → Permit2 sign → POST /v1/swap → broadcast)
 *   - Token → Permit2 approval (approve token to Permit2 contract)
 *   - EIP-712 Permit2 signature (signTypedData on wallet)
 *   - POST /v1/swap with quote + signature → get unsigned calldata
 *   - Sign + broadcast the transaction via wallet.sendTransaction
 * 
 * Usage:
 *   node scripts/test-swap-routing.js
 *   node scripts/test-swap-routing.js --token-in USDC --token-out WETH --amount 100
 *   node scripts/test-swap-routing.js --force-uniswap          # force Uniswap path for demo
 *   node scripts/test-swap-routing.js --force-samm              # force SAMM path for demo
 *   node scripts/test-swap-routing.js --dry-run                 # quote only, no execution
 * 
 * SAMM DEX — Uniswap Trading API Integration
 */

require('dotenv').config();
const { ethers } = require('ethers');

// ─── Configuration ───────────────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const UNISWAP_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';
const UNISWAP_API_KEY = process.env.UNISWAP_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const RISECHAIN_RPC = process.env.RISECHAIN_RPC_URL || 'https://testnet.riselabs.xyz/http';

// Sepolia token addresses (for Uniswap Trading API)
const SEPOLIA_TOKENS = {
  WETH: '0x0000000000000000000000000000000000000000', // native ETH
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  USDT: '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06',
  DAI:  '0x68194a729C2450ad26072b3D33ADaCbcef39D574',
  LINK: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
};

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

// ─── CLI Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  return args[idx + 1] || defaultVal;
}
const TOKEN_IN  = getArg('token-in', 'WETH');
const TOKEN_OUT = getArg('token-out', 'USDC');
const AMOUNT    = getArg('amount', '50');           // amount of tokenOut to buy
const DRY_RUN   = args.includes('--dry-run');
const FORCE_UNI = args.includes('--force-uniswap');
const FORCE_SAMM = args.includes('--force-samm');

// ─── Utilities ───────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
const hr = () => log('─'.repeat(72));
const section = (title) => { log(`\n${'═'.repeat(72)}`); log(`  ${title}`); log('═'.repeat(72)); };

async function jsonFetch(url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || data.detail || JSON.stringify(data));
  return data;
}

// ═════════════════════════════════════════════════════════════════════════
//  STEP 1: Get quotes from both venues
// ═════════════════════════════════════════════════════════════════════════

async function getSAMMQuote(tokenIn, tokenOut, amountOut) {
  log(`\n📊 Getting SAMM quote: buy ${amountOut} ${tokenOut} with ${tokenIn}...`);
  try {
    const data = await jsonFetch(`${API_BASE}/quote/${tokenIn}/${tokenOut}/${amountOut}`);
    log(`   ✅ SAMM: ${data.amountIn} ${tokenIn} → ${amountOut} ${tokenOut}`);
    log(`   Rate: ${data.effectiveRate} ${tokenOut}/${tokenIn}`);
    log(`   Shard: ${data.selectedShard} | Fee: ${data.feePct}%`);
    log(`   Price impact: ${data.priceImpact}`);
    return { 
      source: 'SAMM', 
      amountIn: parseFloat(data.amountIn),
      amountOut: parseFloat(amountOut),
      rate: parseFloat(data.effectiveRate),
      fee: parseFloat(data.fee),
      feePct: parseFloat(data.feePct),
      shard: data.selectedShard,
      shardAddress: data.selectedShardAddress,
      priceImpact: data.priceImpact,
      raw: data,
    };
  } catch (e) {
    log(`   ❌ SAMM quote failed: ${e.message}`);
    return null;
  }
}

async function getUniswapSepoliaQuote(tokenIn, tokenOut, amountOut) {
  log(`\n📊 Getting Uniswap Sepolia quote: buy ${amountOut} ${tokenOut} with ${tokenIn}...`);
  
  if (!UNISWAP_API_KEY) {
    log('   ❌ No UNISWAP_API_KEY set — skipping');
    return null;
  }

  const sepoliaIn = SEPOLIA_TOKENS[tokenIn];
  const sepoliaOut = SEPOLIA_TOKENS[tokenOut];
  if (!sepoliaIn || !sepoliaOut) {
    log(`   ❌ Token not supported on Sepolia: ${tokenIn} or ${tokenOut}`);
    return null;
  }

  // We need the decimals to compute the wei amount
  const decimalsMap = { WETH: 18, USDC: 6, USDT: 6, DAI: 18, LINK: 18, WBTC: 8 };
  const outDecimals = decimalsMap[tokenOut] || 18;
  const inDecimals = decimalsMap[tokenIn] || 18;
  const amountWei = ethers.parseUnits(amountOut.toString(), outDecimals).toString();

  try {
    // We use the compare endpoint which already calls Trading API
    const data = await jsonFetch(`${API_BASE}/compare/${tokenIn}/${tokenOut}/${amountOut}`);
    
    if (data.sepoliaUniswap && !data.sepoliaUniswap.error) {
      const uni = data.sepoliaUniswap;
      log(`   ✅ Uniswap Sepolia: ${uni.amountIn} ${tokenIn} → ${amountOut} ${tokenOut}`);
      log(`   Routing: ${uni.routing} | Rate: ${uni.effectiveRate} ${tokenOut}/${tokenIn}`);
      log(`   Source: ${uni.source}`);
      return {
        source: 'Uniswap Sepolia',
        amountIn: parseFloat(uni.amountIn),
        amountOut: parseFloat(amountOut),
        rate: parseFloat(uni.effectiveRate),
        routing: uni.routing,
        chainId: uni.chainId,
        raw: uni,
      };
    } else {
      log(`   ❌ Uniswap quote error: ${data.sepoliaUniswap?.error || 'unknown'}`);
      return null;
    }
  } catch (e) {
    log(`   ❌ Uniswap Sepolia quote failed: ${e.message}`);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  STEP 2: Smart routing decision
// ═════════════════════════════════════════════════════════════════════════

function decideRoute(sammQuote, uniQuote) {
  section('ROUTING DECISION');

  if (!sammQuote && !uniQuote) {
    log('❌ Both quotes failed — cannot route');
    return null;
  }
  if (!sammQuote) {
    log('⚠️  Only Uniswap available → routing to Uniswap Sepolia');
    return { venue: 'uniswap', quote: uniQuote, reason: 'SAMM quote unavailable' };
  }
  if (!uniQuote) {
    log('⚠️  Only SAMM available → routing to SAMM RiseChain');
    return { venue: 'samm', quote: sammQuote, reason: 'Uniswap quote unavailable' };
  }

  // Compare: lower amountIn = better (you spend less)
  const sammIn = sammQuote.amountIn;
  const uniIn = uniQuote.amountIn;
  const deltaPct = ((uniIn - sammIn) / uniIn * 100);
  const winner = sammIn <= uniIn ? 'samm' : 'uniswap';
  const savings = Math.abs(uniIn - sammIn);

  log(`\n   SAMM requires:     ${sammIn.toFixed(8)} ${TOKEN_IN}`);
  log(`   Uniswap requires:  ${uniIn.toFixed(8)} ${TOKEN_IN}`);
  log(`   Delta:             ${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(4)}% ${deltaPct > 0 ? '(SAMM cheaper)' : '(Uniswap cheaper)'}`);
  log(`   Savings:           ${savings.toFixed(8)} ${TOKEN_IN}`);
  hr();

  if (FORCE_UNI) {
    log(`🔧 --force-uniswap flag set → routing to Uniswap Sepolia`);
    return { venue: 'uniswap', quote: uniQuote, reason: 'forced via --force-uniswap flag', deltaPct, savings };
  }
  if (FORCE_SAMM) {
    log(`🔧 --force-samm flag set → routing to SAMM RiseChain`);
    return { venue: 'samm', quote: sammQuote, reason: 'forced via --force-samm flag', deltaPct, savings };
  }

  if (winner === 'samm') {
    log(`✅ Winner: SAMM (saves ${deltaPct.toFixed(2)}%)`);
    log(`   → Will execute on RiseChain backend via POST /swap`);
    return { venue: 'samm', quote: sammQuote, reason: `SAMM cheaper by ${deltaPct.toFixed(2)}%`, deltaPct, savings };
  } else {
    log(`✅ Winner: Uniswap Sepolia (saves ${Math.abs(deltaPct).toFixed(2)}%)`);
    log(`   → Will execute Permit2 tx signing flow on Sepolia`);
    return { venue: 'uniswap', quote: uniQuote, reason: `Uniswap cheaper by ${Math.abs(deltaPct).toFixed(2)}%`, deltaPct, savings };
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  STEP 3A: Execute on SAMM (RiseChain backend)
// ═════════════════════════════════════════════════════════════════════════

async function executeSAMMSwap(quote) {
  section('SAMM SWAP EXECUTION (RiseChain)');
  log(`🔄 Executing swap on SAMM backend...`);
  log(`   Route: ${TOKEN_IN} → ${TOKEN_OUT}`);
  log(`   Amount out: ${AMOUNT} ${TOKEN_OUT}`);
  log(`   Expected in: ${quote.amountIn.toFixed(8)} ${TOKEN_IN}`);
  log(`   Shard: ${quote.shard}`);
  hr();

  if (DRY_RUN) {
    log('🏁 DRY RUN — skipping execution');
    return { dryRun: true, venue: 'SAMM', quote };
  }

  try {
    const result = await jsonFetch(`${API_BASE}/swap`, {
      method: 'POST',
      body: JSON.stringify({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountOut: AMOUNT,
        slippagePct: '2.0',
      }),
    });

    log(`\n   ✅ SAMM Swap Confirmed!`);
    log(`   TX Hash:       ${result.txHash}`);
    log(`   Block:         ${result.blockNumber}`);
    log(`   Gas Used:      ${result.gasUsed}`);
    log(`   Amount In:     ${result.amountIn} ${TOKEN_IN}`);
    log(`   Amount Out:    ${AMOUNT} ${TOKEN_OUT}`);
    log(`   Shard:         ${result.selectedShards?.join(', ')}`);
    log(`   Recipient:     ${result.recipient}`);
    if (result.recipientENS) log(`   ENS Name:      ${result.recipientENS}`);
    hr();
    return { success: true, venue: 'SAMM', ...result };
  } catch (e) {
    log(`   ❌ SAMM swap failed: ${e.message}`);
    return { success: false, venue: 'SAMM', error: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  STEP 3B: Execute on Uniswap Sepolia (Permit2 Tx Signing Flow)
// ═════════════════════════════════════════════════════════════════════════

async function executeUniswapPermit2Swap(quote) {
  section('UNISWAP PERMIT2 SWAP EXECUTION (Sepolia)');

  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY required for Uniswap Permit2 swap');
  if (!UNISWAP_API_KEY) throw new Error('UNISWAP_API_KEY required');

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`, provider);

  const sepoliaIn = SEPOLIA_TOKENS[TOKEN_IN];
  const sepoliaOut = SEPOLIA_TOKENS[TOKEN_OUT];
  const decimalsMap = { WETH: 18, USDC: 6, USDT: 6, DAI: 18, LINK: 18, WBTC: 8 };
  const inDecimals = decimalsMap[TOKEN_IN] || 18;
  const outDecimals = decimalsMap[TOKEN_OUT] || 18;

  // For EXACT_INPUT: we specify how much tokenIn we want to spend
  // Use the quote's amountIn (what the API told us we need)
  const amountInWei = ethers.parseUnits(
    quote.amountIn.toFixed(Math.min(inDecimals, 8)), inDecimals
  ).toString();

  log(`   Wallet:        ${wallet.address}`);
  log(`   Network:       Sepolia (chainId 11155111)`);
  log(`   Token In:      ${TOKEN_IN} (${sepoliaIn})`);
  log(`   Token Out:     ${TOKEN_OUT} (${sepoliaOut})`);
  log(`   Amount In:     ${quote.amountIn.toFixed(8)} ${TOKEN_IN} (${amountInWei} wei)`);
  log(`   Routing:       ${quote.routing}`);
  hr();

  if (DRY_RUN) {
    log('🏁 DRY RUN — skipping execution');
    log('\n📋 What would happen next:');
    log('   1. POST /v1/quote to Uniswap Trading API');
    log('   2. If token swap: approve token → Permit2 contract');
    log('   3. Sign EIP-712 Permit2 typed data (signTypedData)');
    log('   4. POST /v1/swap with quote + Permit2 signature');
    log('   5. Sign + broadcast returned transaction calldata');
    log('   6. Wait for confirmation');
    return { dryRun: true, venue: 'Uniswap Sepolia', quote };
  }

  // ── STEP 1: Get fresh quote from Uniswap Trading API ──────────────
  log('\n📡 Step 1: Getting fresh quote from Uniswap Trading API...');
  const quoteBody = {
    tokenIn: sepoliaIn,
    tokenOut: sepoliaOut,
    tokenInChainId: 11155111,
    tokenOutChainId: 11155111,
    type: 'EXACT_INPUT',
    amount: amountInWei,
    swapper: wallet.address,
    slippageTolerance: 5.0,
  };

  log(`   POST ${UNISWAP_API_BASE}/quote`);
  log(`   Body: ${JSON.stringify(quoteBody, null, 2)}`);

  const quoteResp = await fetch(`${UNISWAP_API_BASE}/quote`, {
    method: 'POST',
    headers: {
      'x-api-key': UNISWAP_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(quoteBody),
    signal: AbortSignal.timeout(15000),
  });

  if (!quoteResp.ok) {
    const err = await quoteResp.json().catch(() => ({}));
    throw new Error(`Uniswap /quote failed ${quoteResp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
  }

  const quoteData = await quoteResp.json();
  log(`   ✅ Quote received — routing: ${quoteData.routing}`);
  log(`   Quote keys: ${Object.keys(quoteData).join(', ')}`);

  const amountOut = quoteData.quote?.amountOut || quoteData.quote?.output?.amount || '0';
  log(`   Expected amountOut: ${amountOut} (${ethers.formatUnits(BigInt(amountOut), outDecimals)} ${TOKEN_OUT})`);

  // ── STEP 2: Handle Permit2 approval (token → Permit2 contract) ────
  const isNativeETH = sepoliaIn === '0x0000000000000000000000000000000000000000';

  if (!isNativeETH) {
    log('\n🔑 Step 2: Ensuring token approval for Permit2 contract...');
    log(`   Token: ${sepoliaIn}`);
    log(`   Permit2: ${PERMIT2_ADDRESS}`);
    
    const tokenContract = new ethers.Contract(sepoliaIn, ERC20_ABI, wallet);
    const currentAllowance = await tokenContract.allowance(wallet.address, PERMIT2_ADDRESS);
    log(`   Current allowance: ${currentAllowance.toString()}`);
    
    if (currentAllowance < BigInt(amountInWei)) {
      log(`   ⚡ Approving token for Permit2 (MaxUint256)...`);
      const approveTx = await tokenContract.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
      log(`   TX: ${approveTx.hash}`);
      const approveReceipt = await approveTx.wait();
      log(`   ✅ Approved! Gas: ${approveReceipt.gasUsed.toString()}`);
    } else {
      log(`   ✅ Already approved (allowance sufficient)`);
    }
  } else {
    log('\n🔑 Step 2: Native ETH — no Permit2 approval needed');
  }

  // ── STEP 3: Sign Permit2 typed data (EIP-712) ─────────────────────
  let permit2Signature = undefined;
  const permitData = quoteData.permitData || null;

  if (permitData) {
    log('\n✍️  Step 3: Signing Permit2 typed data (EIP-712)...');
    log(`   Domain: ${JSON.stringify(permitData.domain)}`);
    log(`   Types: ${Object.keys(permitData.types).join(', ')}`);
    
    // EIP-712 signTypedData — this is what makes Permit2 work
    // The wallet signs structured data that authorizes the Universal Router
    // to spend tokens on behalf of the user, without a separate approve tx
    permit2Signature = await wallet.signTypedData(
      permitData.domain,
      permitData.types,
      permitData.values
    );
    log(`   ✅ Permit2 signature: ${permit2Signature.slice(0, 20)}...${permit2Signature.slice(-8)}`);
  } else {
    log('\n✍️  Step 3: No Permit2 data in quote (native ETH or pre-approved)');
  }

  // ── STEP 4: POST /v1/swap to get unsigned tx calldata ──────────────
  log('\n📡 Step 4: Getting unsigned transaction from Uniswap API...');
  
  const routing = quoteData.routing;
  let swapResponse;

  if (routing === 'CLASSIC' || routing === 'WRAP' || routing === 'UNWRAP' || routing === 'BRIDGE') {
    const swapBody = { quote: quoteData.quote };
    if (permit2Signature && permitData) {
      swapBody.signature = permit2Signature;
      swapBody.permitData = permitData;
    }

    log(`   POST ${UNISWAP_API_BASE}/swap`);
    log(`   Routing: ${routing}`);
    
    const swapResp = await fetch(`${UNISWAP_API_BASE}/swap`, {
      method: 'POST',
      headers: {
        'x-api-key': UNISWAP_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(swapBody),
      signal: AbortSignal.timeout(15000),
    });

    if (!swapResp.ok) {
      const err = await swapResp.json().catch(() => ({}));
      throw new Error(`Uniswap /swap failed ${swapResp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
    }
    swapResponse = await swapResp.json();
  } else {
    // UniswapX order flow
    const orderBody = { quote: quoteData.quote, signature: permit2Signature };
    log(`   POST ${UNISWAP_API_BASE}/order`);
    log(`   Routing: ${routing} (UniswapX order)`);

    const orderResp = await fetch(`${UNISWAP_API_BASE}/order`, {
      method: 'POST',
      headers: {
        'x-api-key': UNISWAP_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderBody),
      signal: AbortSignal.timeout(15000),
    });

    if (!orderResp.ok) {
      const err = await orderResp.json().catch(() => ({}));
      throw new Error(`Uniswap /order failed ${orderResp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
    }
    swapResponse = await orderResp.json();
    log(`   ✅ UniswapX order submitted: ${JSON.stringify(swapResponse).slice(0, 100)}`);
    return { success: true, venue: 'Uniswap Sepolia', method: 'UniswapX', ...swapResponse };
  }

  const txRequest = swapResponse.swap || swapResponse;
  log(`   ✅ Received unsigned tx`);
  log(`   To: ${txRequest.to}`);
  log(`   Data: ${txRequest.data?.slice(0, 66)}...`);
  log(`   Value: ${txRequest.value || '0'} wei`);

  // ── STEP 5: Sign and broadcast the transaction ─────────────────────
  log('\n🚀 Step 5: Signing and broadcasting transaction...');

  const tx = await wallet.sendTransaction({
    to: txRequest.to,
    data: txRequest.data,
    value: txRequest.value ? BigInt(txRequest.value) : 0n,
    gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : 500000n,
    chainId: 11155111,
  });
  log(`   TX Hash: ${tx.hash}`);
  log(`   ⏳ Waiting for confirmation...`);

  const receipt = await tx.wait();

  if (receipt.status !== 1) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }

  log(`\n   ✅ Uniswap Permit2 Swap Confirmed!`);
  log(`   TX Hash:       ${tx.hash}`);
  log(`   Block:         ${receipt.blockNumber}`);
  log(`   Gas Used:      ${receipt.gasUsed.toString()}`);
  log(`   Routing:       ${routing}`);
  log(`   Method:        Permit2 + Uniswap Trading API`);
  log(`   Chain:         Sepolia (11155111)`);
  log(`   Explorer:      https://sepolia.etherscan.io/tx/${tx.hash}`);
  hr();

  return {
    success: true,
    venue: 'Uniswap Sepolia',
    method: `uniswap-trading-api-${routing.toLowerCase()}`,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    routing,
    permit2Used: !!permit2Signature,
    chainId: 11155111,
    explorer: `https://sepolia.etherscan.io/tx/${tx.hash}`,
  };
}

// ═════════════════════════════════════════════════════════════════════════
//  MAIN: Full routing flow
// ═════════════════════════════════════════════════════════════════════════

async function main() {
  section(`SAMM Smart Swap Router — Test Script`);
  log(`   Date:       ${new Date().toISOString()}`);
  log(`   Token In:   ${TOKEN_IN}`);
  log(`   Token Out:  ${TOKEN_OUT}`);
  log(`   Amount:     ${AMOUNT} ${TOKEN_OUT} (to buy)`);
  log(`   Dry Run:    ${DRY_RUN}`);
  log(`   API Base:   ${API_BASE}`);
  log(`   API Key:    ${UNISWAP_API_KEY ? '✅ configured' : '❌ missing'}`);
  log(`   Wallet:     ${PRIVATE_KEY ? '✅ configured' : '❌ missing'}`);
  hr();

  // Verify server is up
  try {
    const health = await jsonFetch(`${API_BASE}/health`);
    log(`\n🟢 SAMM server healthy: ${health.status || 'ok'}`);
  } catch (e) {
    log(`\n🔴 SAMM server not reachable: ${e.message}`);
    log('   Start it with: node api-server.js');
    process.exit(1);
  }

  // ── Phase 1: Get quotes ────────────────────────────────────────────
  section('PHASE 1: QUOTE COMPARISON');

  const [sammQuote, uniQuote] = await Promise.all([
    getSAMMQuote(TOKEN_IN, TOKEN_OUT, AMOUNT),
    getUniswapSepoliaQuote(TOKEN_IN, TOKEN_OUT, AMOUNT),
  ]);

  // ── Phase 2: Decide route ──────────────────────────────────────────
  const decision = decideRoute(sammQuote, uniQuote);
  if (!decision) {
    log('\n💀 No viable route found');
    process.exit(1);
  }

  log(`\n📌 Decision: route via ${decision.venue.toUpperCase()}`);
  log(`   Reason: ${decision.reason}`);

  // ── Phase 3: Execute ───────────────────────────────────────────────
  let result;
  if (decision.venue === 'samm') {
    result = await executeSAMMSwap(decision.quote);
  } else {
    result = await executeUniswapPermit2Swap(decision.quote);
  }

  // ── Summary ────────────────────────────────────────────────────────
  section('EXECUTION SUMMARY');
  log(JSON.stringify({
    timestamp: new Date().toISOString(),
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountOut: AMOUNT,
    venue: decision.venue,
    reason: decision.reason,
    deltaPct: decision.deltaPct,
    dryRun: DRY_RUN,
    result: result,
  }, null, 2));

  log('\n✅ Done!\n');
}

main().catch(e => {
  console.error(`\n❌ Fatal error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
