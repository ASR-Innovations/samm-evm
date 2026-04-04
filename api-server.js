/**
 * SAMM DEX API Server
 *
 * Self-contained — just run `node api-server.js` with a .env file.
 * No CLI params needed. Auto-discovers deployment, starts arb bot
 * and dynamic shard manager with shared TxQueue.
 */
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const ArbitrageBot = require('./arbitrage-bot');
const DynamicShardManager = require('./dynamic-shard-manager');
const TxQueue = require('./tx-queue');
const { UniswapQuoter } = require('./integrations/uniswap-client');
const { ChainlinkPriceOracle } = require('./integrations/chainlink-price');
const { ENSAgentRegistry } = require('./integrations/ens-agent-registry');
const UniswapSepoliaSwap = require('./integrations/uniswap-sepolia-swap');
const RiseChainBridge = require('./integrations/risechain-bridge');
require('dotenv').config();

// ─── Process-level error handlers (prevent crash on RPC 429 etc) ────
process.on('uncaughtException', (err) => {
  console.error(`\n⚠️  Uncaught exception (non-fatal): ${err.message?.slice(0, 150)}`);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`\n⚠️  Unhandled rejection (non-fatal): ${msg?.slice(0, 150)}`);
});

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ─────────────────────────────────────────────────────
function findLatestDeployment() {
  if (process.env.DEPLOYMENT_FILE) return process.env.DEPLOYMENT_FILE;
  const deployDir = path.join(__dirname, 'deployment-data');
  const files = fs.readdirSync(deployDir)
    .filter(f => f.startsWith('production-risechain-') && f.endsWith('.json'))
    .sort().reverse();
  if (files.length === 0) throw new Error('No deployment files found');
  return files[0];
}

function normalizePK(pk) {
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}

const DEPLOYMENT_FILE = findLatestDeployment();
const deploymentPath = path.join(__dirname, 'deployment-data', DEPLOYMENT_FILE);
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

const RPC_URL = process.env.RISECHAIN_RPC_URL || 'https://testnet.riselabs.xyz/http';
const provider = new ethers.JsonRpcProvider(RPC_URL);
const PORT = parseInt(process.env.PORT || '3000');

// Wallet + TxQueue (created once, shared everywhere)
let wallet = null;
let txQueue = null;
if (process.env.PRIVATE_KEY) {
  wallet = new ethers.Wallet(normalizePK(process.env.PRIVATE_KEY), provider);
  txQueue = new TxQueue(wallet, provider);
}

// Contracts & state
let router;
const tokens = {};
const poolCache = new Map();
let arbitrageBot = null;
let shardManager = null;
const uniswapQuoter = new UniswapQuoter(process.env.UNISWAP_API_KEY);
const chainlinkOracle = new ChainlinkPriceOracle(process.env.SEPOLIA_RPC_URL);
const ENS_RPC_URL = process.env.ENS_RPC_URL || 'https://ethereum.publicnode.com';
const ensProvider = process.env.ENABLE_ENS === 'false' ? null : new ethers.JsonRpcProvider(ENS_RPC_URL);
const ensRegistry = process.env.ENABLE_ENS === 'false' ? null : new ENSAgentRegistry({
  registryAddress: process.env.ENS_REGISTRY_ADDRESS,
  registryProvider: provider,
  registrySigner: wallet,
  ensProvider,
  baseDomain: process.env.ENS_BASE_DOMAIN || 'samm.eth',
});
let ensSyncTimer = null;

// ─── Uniswap Sepolia Swap & Bridge ──────────────────────────────
const sepoliaRpc = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const uniswapSepolia = process.env.PRIVATE_KEY
  ? new UniswapSepoliaSwap(process.env.PRIVATE_KEY, sepoliaRpc, process.env.UNISWAP_API_KEY)
  : null;
const riseChainBridge = process.env.PRIVATE_KEY
  ? new RiseChainBridge(process.env.PRIVATE_KEY, sepoliaRpc, RPC_URL)
  : null;

// ABIs
const POOL_ABI = [
  'function getReserves() view returns (uint256, uint256)',
  'function tokenA() view returns (address)',
  'function tokenB() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function calculateSwapSAMM(uint256,address,address) view returns (tuple(uint256 amountIn, uint256 amountOut, uint256 tradeFee, uint256 ownerFee))',
  'function swapSAMM(uint256,uint256,address,address,address) external returns (uint256)',
];
const ROUTER_ABI = [
  'function quoteSwap((address tokenIn, address tokenOut, uint256 amountOut)[] hops) view returns (tuple(uint256 expectedAmountIn, uint256[] hopAmountsIn, uint256[] hopFees, address[] selectedShards, uint256[] priceImpacts))',
  'function executeSwap((address tokenIn, address tokenOut, uint256 amountOut)[] hops, uint256 maxAmountIn, address recipient) external returns (tuple(uint256 totalAmountIn, uint256 totalAmountOut, uint256 totalFees, uint256[] hopAmountsIn, uint256[] hopAmountsOut, uint256[] hopFees, address[] selectedShards))',
];
const TOKEN_ABI = [
  'function approve(address,uint256) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

// ─── Oracle ─────────────────────────────────────────────────────
const geckoIds = { WETH: 'ethereum', WBTC: 'bitcoin', USDC: 'usd-coin', USDT: 'tether', DAI: 'dai' };
let oraclePrices = {};
let lastOracleUpdate = 0;

async function refreshOracle() {
  if (Date.now() - lastOracleUpdate < 60_000 && Object.keys(oraclePrices).length > 0) return oraclePrices;
  try {
    const ids = Object.values(geckoIds).join(',');
    const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(10000) });
    if (resp.ok) {
      const data = await resp.json();
      for (const [sym, id] of Object.entries(geckoIds)) {
        if (data[id]?.usd) oraclePrices[sym] = data[id].usd;
      }
      lastOracleUpdate = Date.now();
    }
  } catch { /* fall through */ }
  for (const [sym, d] of Object.entries(deployment.contracts.tokens)) {
    if (!oraclePrices[sym]) oraclePrices[sym] = d.price;
  }
  return oraclePrices;
}

// ─── Initialize ─────────────────────────────────────────────────
async function initialize() {
  await refreshOracle();

  router = new ethers.Contract(deployment.contracts.router, ROUTER_ABI, wallet || provider);

  for (const [symbol, data] of Object.entries(deployment.contracts.tokens)) {
    tokens[symbol] = {
      address: data.address,
      decimals: data.decimals,
      price: oraclePrices[symbol] || data.price,
      contract: new ethers.Contract(data.address, TOKEN_ABI, wallet || provider),
    };
  }

  console.log('✅ Initialized:', DEPLOYMENT_FILE);
  console.log(`📍 Router: ${deployment.contracts.router}`);
  console.log(`📍 Factory: ${deployment.contracts.factory}`);
  console.log(`🪙 Tokens: ${Object.keys(tokens).join(', ')}`);

  if (!wallet) {
    console.log('\n⏸️  No PRIVATE_KEY — read-only mode (no arb bot, no shard manager)');
    if (ensRegistry) {
      try {
        await syncENSRegistry();
      } catch (e) {
        console.error('⚠️  ENS sync (read-only) failed:', e.message?.slice(0, 100));
      }
    }
    return;
  }

  console.log(`\n📡 TxQueue ready (wallet: ${wallet.address})`);

  // Auto-start arb bot (unless ENABLE_ARBITRAGE=false)
  if (process.env.ENABLE_ARBITRAGE !== 'false') {
    console.log('\n🤖 Starting arbitrage bot...');
    arbitrageBot = new ArbitrageBot(DEPLOYMENT_FILE, normalizePK(process.env.PRIVATE_KEY), RPC_URL, txQueue);
    try { await arbitrageBot.start(); }
    catch (e) { console.error('⚠️  Arb bot error (non-fatal):', e.message?.slice(0, 100)); }
  }

  // Auto-start shard manager (unless ENABLE_DYNAMIC_SHARDING=false)
  if (process.env.ENABLE_DYNAMIC_SHARDING !== 'false') {
    console.log('\n🔧 Starting dynamic shard manager...');
    shardManager = new DynamicShardManager(DEPLOYMENT_FILE, normalizePK(process.env.PRIVATE_KEY), RPC_URL, txQueue);
    setTimeout(async () => {
      try { await shardManager.start(); }
      catch (e) { console.error('⚠️  Shard manager error (non-fatal):', e.message?.slice(0, 100)); }
    }, 5000);
  }

  if (ensRegistry) {
    // Run ENS sync in background — don't block server startup
    (async () => {
      try {
        await syncENSRegistry();
        ensSyncTimer = setInterval(() => {
          syncENSRegistry().catch((e) => {
            console.error('⚠️  ENS periodic sync failed:', e.message?.slice(0, 100));
          });
        }, parseInt(process.env.ENS_SYNC_INTERVAL_MS || '120000'));
      } catch (e) {
        console.error('⚠️  ENS sync init failed:', e.message?.slice(0, 100));
      }
    })();
  }
}

// ─── Helpers ────────────────────────────────────────────────────
async function getPoolData(poolAddress) {
  const cached = poolCache.get(poolAddress);
  if (cached && Date.now() - cached.timestamp < 10000) return cached.data;

  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [reserves, tA, tB] = await Promise.all([pool.getReserves(), pool.tokenA(), pool.tokenB()]);

  let symA, symB, decA, decB;
  for (const [sym, d] of Object.entries(tokens)) {
    if (d.address.toLowerCase() === tA.toLowerCase()) { symA = sym; decA = d.decimals; }
    if (d.address.toLowerCase() === tB.toLowerCase()) { symB = sym; decB = d.decimals; }
  }

  const data = {
    address: poolAddress, tokenA: symA, tokenB: symB,
    tokenAAddress: tA, tokenBAddress: tB,
    reserveA: ethers.formatUnits(reserves[0], decA),
    reserveB: ethers.formatUnits(reserves[1], decB),
  };
  poolCache.set(poolAddress, { data, timestamp: Date.now() });
  return data;
}

function findShardName(addr) {
  for (const shards of Object.values(deployment.contracts.shards)) {
    for (const s of shards) {
      if (s.address.toLowerCase() === addr.toLowerCase()) return s.name;
    }
  }
  return addr.slice(0, 12) + '…';
}

function buildHops(routeArray, amountOut) {
  const hops = [];
  for (let i = 0; i < routeArray.length - 1; i++) {
    const tIn = tokens[routeArray[i]], tOut = tokens[routeArray[i + 1]];
    if (!tIn || !tOut) throw new Error(`Invalid token: ${routeArray[i]} or ${routeArray[i + 1]}`);
    hops.push({
      tokenIn: tIn.address, tokenOut: tOut.address,
      amountOut: i === routeArray.length - 2 ? ethers.parseUnits(amountOut.toString(), tOut.decimals) : 0n,
    });
  }
  return hops;
}

async function resolveAddressInput(addressOrEns) {
  if (ethers.isAddress(addressOrEns)) return { address: addressOrEns, ens: null };
  if (!ensRegistry || !addressOrEns?.toLowerCase()?.endsWith('.eth')) {
    throw new Error('Invalid address');
  }
  const resolved = await ensRegistry.resolveAddress(addressOrEns);
  if (!resolved) throw new Error(`Could not resolve ENS name: ${addressOrEns}`);
  return { address: resolved, ens: addressOrEns.toLowerCase() };
}

function normalizeShardEnsName(pair, tier) {
  const safePair = pair.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const safeTier = tier.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `${safeTier}.${safePair}.${process.env.ENS_BASE_DOMAIN || 'samm.eth'}`;
}

async function syncENSRegistry() {
  if (!ensRegistry || !wallet) return;

  const arbStats = arbitrageBot?.stats || { cycles: 0, swaps: 0, totalUSD: 0, failures: 0 };
  const shardStatus = shardManager?.getStatus?.() || {};

  await ensRegistry.registerAgent({
    name: 'arb-bot',
    ensName: process.env.ENS_ARB_BOT_NAME || 'arb-bot',
    agentAddress: wallet.address,
    role: 'arbitrage-bot',
    textRecords: {
      'com.samm.min-deviation': '0.30%',
      'com.samm.rebalance-target': '50%',
      'com.samm.cooldown-cycles': '3',
      'com.samm.oracle-source': arbitrageBot?.oracleSource || 'coingecko',
      'com.samm.total-swaps': arbStats.swaps,
      'com.samm.total-volume-usd': Number(arbStats.totalUSD || 0).toFixed(2),
    },
  });

  await ensRegistry.registerAgent({
    name: 'shard-manager',
    ensName: process.env.ENS_SHARD_MANAGER_NAME || 'shard-manager',
    agentAddress: wallet.address,
    role: 'dynamic-shard-manager',
    textRecords: {
      'com.samm.target-tps-per-shard': shardStatus.PER_SHARD_TPS || 50,
      'com.samm.max-shards-per-pair': shardStatus.MAX_SHARDS_PER_PAIR || 10,
      'com.samm.running': !!shardManager?.isRunning,
    },
  });

  for (const [pair, shards] of Object.entries(deployment.contracts.shards)) {
    for (const shard of shards) {
      await ensRegistry.registerShard({
        pair,
        tier: shard.name,
        ensName: normalizeShardEnsName(pair, shard.name),
        shardAddress: shard.address,
        active: true,
      });
    }
  }

  await ensRegistry.updateAgentStats('arb-bot', {
    'com.samm.total-cycles': arbStats.cycles,
    'com.samm.failures': arbStats.failures,
    'com.samm.last-sync': new Date().toISOString(),
  });
}

// ═════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ═════════════════════════════════════════════════════════════════

// ── Health ──
app.get('/health', async (req, res) => {
  await refreshOracle();
  res.json({
    status: 'ok', deployment: DEPLOYMENT_FILE, chain: deployment.chain || 'risechain',
    oraclePrices, wallet: wallet?.address || null,
    arbitrageBot: arbitrageBot ? { running: arbitrageBot.isRunning, stats: arbitrageBot.stats } : { enabled: false },
    shardManager: shardManager ? { running: shardManager.isRunning } : { enabled: false },
    ens: ensRegistry ? ensRegistry.status() : { enabled: false },
    txQueue: txQueue?.getStats() || null,
  });
});

// ── Tokens ──
app.get('/tokens', async (req, res) => {
  await refreshOracle();
  res.json({ tokens: Object.entries(tokens).map(([sym, d]) => ({
    symbol: sym, address: d.address, decimals: d.decimals, price: oraclePrices[sym] || d.price,
  })) });
});

// ── All pools ──
app.get('/pools', async (req, res) => {
  try {
    await refreshOracle();
    const pools = [];
    for (const [pair, shards] of Object.entries(deployment.contracts.shards)) {
      const sd = await Promise.all(shards.map(async (s) => {
        const pd = await getPoolData(s.address);
        const liq = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1) +
                    parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
        return { name: s.name, address: s.address, tokenA: pd.tokenA, tokenB: pd.tokenB,
          reserveA: pd.reserveA, reserveB: pd.reserveB, liquidityUSD: Math.round(liq) };
      }));
      pools.push({ pair, shards: sd, totalLiquidityUSD: sd.reduce((a, b) => a + b.liquidityUSD, 0) });
    }
    res.json({ pools, totalPairs: pools.length, totalShards: pools.reduce((a, p) => a + p.shards.length, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── All pools (flat format for CRE workflow) ──
app.get('/pools/all', async (req, res) => {
  try {
    await refreshOracle();
    const pools = [];
    for (const [pair, shards] of Object.entries(deployment.contracts.shards)) {
      const [tokenA, tokenB] = pair.split('-');
      for (const s of shards) {
        const pd = await getPoolData(s.address);
        const liq = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1) +
                    parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
        pools.push({
          pair, shard: s.name, address: s.address,
          tokenA, tokenB,
          reserveA: pd.reserveA, reserveB: pd.reserveB,
          liquidityUSD: Math.round(liq),
          tps: shardManager?._pairTPS?.[pair]?.tps || 0,
        });
      }
    }
    res.json({ pools, count: pools.length, timestamp: Date.now() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pools for pair ──
app.get('/pools/:tokenA/:tokenB', async (req, res) => {
  try {
    const { tokenA, tokenB } = req.params;
    const shards = deployment.contracts.shards[`${tokenA}-${tokenB}`] ||
                   deployment.contracts.shards[`${tokenB}-${tokenA}`];
    if (!shards) return res.status(404).json({ error: 'Pair not found', pairs: Object.keys(deployment.contracts.shards) });
    await refreshOracle();
    const sd = await Promise.all(shards.map(async (s) => {
      const pd = await getPoolData(s.address);
      const liq = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1) +
                  parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
      return { name: s.name, address: s.address, tokenA: pd.tokenA, tokenB: pd.tokenB,
        reserveA: pd.reserveA, reserveB: pd.reserveB, liquidityUSD: Math.round(liq) };
    }));
    res.json({ pair: `${tokenA}-${tokenB}`, shards: sd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Shards from blockchain ──
app.get('/shards/:tokenA/:tokenB', async (req, res) => {
  try {
    const { tokenA, tokenB } = req.params;
    const tA = tokens[tokenA], tB = tokens[tokenB];
    if (!tA || !tB) return res.status(400).json({ error: 'Invalid token', tokens: Object.keys(tokens) });
    await refreshOracle();
    const fac = new ethers.Contract(deployment.contracts.factory,
      ['function getShardsForPair(address,address) view returns (address[])'], provider);
    const addrs = await fac.getShardsForPair(tA.address, tB.address);
    if (addrs.length === 0) return res.status(404).json({ error: 'No shards' });
    const sd = await Promise.all(addrs.map(async (a) => {
      const pd = await getPoolData(a);
      const liq = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1) +
                  parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
      return { address: a, name: findShardName(a), tokenA: pd.tokenA, tokenB: pd.tokenB,
        reserveA: pd.reserveA, reserveB: pd.reserveB, liquidityUSD: Math.round(liq) };
    }));
    sd.sort((a, b) => a.liquidityUSD - b.liquidityUSD);
    res.json({ tokenA, tokenB, shards: sd, totalShards: sd.length,
      totalLiquidityUSD: sd.reduce((a, b) => a + b.liquidityUSD, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /quote/:tokenIn/:tokenOut/:amountOut — quick quote with slippage ──
app.get('/quote/:tokenIn/:tokenOut/:amountOut', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountOut } = req.params;
    const tIn = tokens[tokenIn], tOut = tokens[tokenOut];
    if (!tIn || !tOut) return res.status(400).json({ error: 'Invalid token' });
    await refreshOracle();

    const hops = [{ tokenIn: tIn.address, tokenOut: tOut.address,
      amountOut: ethers.parseUnits(amountOut, tOut.decimals) }];
    const q = await router.quoteSwap(hops);

    const amtIn = parseFloat(ethers.formatUnits(q.expectedAmountIn, tIn.decimals));
    const amtOut = parseFloat(amountOut);
    const fee = parseFloat(ethers.formatUnits(q.hopFees[0], tIn.decimals));
    const feePct = (fee / amtIn) * 100;
    const rate = amtOut / amtIn;
    const oracle = (oraclePrices[tokenIn] || 1) / (oraclePrices[tokenOut] || 1);
    const slip = ((rate - oracle) / oracle) * 100;
    const usd = amtOut * (oraclePrices[tokenOut] || 1);

    const amtInUSD = amtIn * (oraclePrices[tokenIn] || 1);
    const feeUSD = fee * (oraclePrices[tokenIn] || 1);

    res.json({
      tokenIn, tokenOut, amountOut,
      amountIn: amtIn.toFixed(8),
      amountInUSD: amtInUSD.toFixed(2),
      amountOutUSD: usd.toFixed(2),
      effectiveRate: rate.toFixed(8),
      rateDescription: `1 ${tokenOut} = ${(1 / rate).toFixed(8)} ${tokenIn}`,
      oracleRate: oracle.toFixed(8),
      oracleRateDescription: `1 ${tokenOut} = ${(1 / oracle).toFixed(8)} ${tokenIn} (CoinGecko)`,
      slippagePct: slip.toFixed(4),
      fee: fee.toFixed(8),
      feeUSD: feeUSD.toFixed(4),
      feePct: feePct.toFixed(4),
      selectedShard: findShardName(q.selectedShards[0]),
      selectedShardAddress: q.selectedShards[0],
      priceImpact: `${(Number(q.priceImpacts[0]) / 10000).toFixed(2)}%`,
      oraclePrices: { [tokenIn]: oraclePrices[tokenIn], [tokenOut]: oraclePrices[tokenOut] },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /quote — full quote (single or multi-hop) ──
app.post('/quote', async (req, res) => {
  try {
    const { tokenIn, tokenOut, route, amountOut } = req.body;
    if (!amountOut) return res.status(400).json({ error: 'Missing: amountOut' });
    await refreshOracle();

    const routeArr = route && Array.isArray(route) ? route : [tokenIn, tokenOut];
    if (routeArr.length < 2 || routeArr.some(t => !tokens[t]))
      return res.status(400).json({ error: 'Invalid route', tokens: Object.keys(tokens) });

    const hops = buildHops(routeArr, amountOut);
    const q = await router.quoteSwap(hops);

    const amtIn = parseFloat(ethers.formatUnits(q.expectedAmountIn, tokens[routeArr[0]].decimals));
    const amtOut = parseFloat(amountOut);
    const rate = amtOut / amtIn;
    const oracle = (oraclePrices[routeArr[0]] || 1) / (oraclePrices[routeArr[routeArr.length - 1]] || 1);
    const slip = ((rate - oracle) / oracle) * 100;

    let totalFeeUSD = 0;
    const hopDetails = [];
    for (let i = 0; i < q.hopFees.length; i++) {
      const f = parseFloat(ethers.formatUnits(q.hopFees[i], tokens[routeArr[i]].decimals));
      totalFeeUSD += f * (oraclePrices[routeArr[i]] || 1);
      hopDetails.push({
        tokenIn: routeArr[i], tokenOut: routeArr[i + 1],
        fee: f.toFixed(8), shard: findShardName(q.selectedShards[i]),
        shardAddress: q.selectedShards[i],
        priceImpact: `${(Number(q.priceImpacts[i]) / 10000).toFixed(2)}%`,
      });
    }

    const amtInUSD = amtIn * (oraclePrices[routeArr[0]] || 1);
    const amtOutUSD = amtOut * (oraclePrices[routeArr[routeArr.length - 1]] || 1);

    res.json({
      route: routeArr, amountOut, amountIn: amtIn.toFixed(8),
      amountInUSD: amtInUSD.toFixed(2),
      amountOutUSD: amtOutUSD.toFixed(2),
      effectiveRate: rate.toFixed(8),
      rateDescription: `1 ${routeArr[routeArr.length-1]} = ${(1/rate).toFixed(8)} ${routeArr[0]}`,
      oracleRate: oracle.toFixed(8),
      slippagePct: slip.toFixed(4),
      totalFeeUSD: totalFeeUSD.toFixed(4),
      feePctOfInput: ((totalFeeUSD / amtInUSD) * 100).toFixed(4),
      hops: hopDetails,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /swap — execute swap via router (requires wallet) ──
app.post('/swap', async (req, res) => {
  if (!wallet) return res.status(400).json({ error: 'No wallet — read-only mode' });
  try {
    const { tokenIn, tokenOut, route, amountOut, slippagePct, recipient } = req.body;
    if (!amountOut) return res.status(400).json({ error: 'Missing: amountOut' });
    const slip = parseFloat(slippagePct || '1.0');

    const routeArr = route && Array.isArray(route) ? route : [tokenIn, tokenOut];
    if (routeArr.length < 2 || routeArr.some(t => !tokens[t]))
      return res.status(400).json({ error: 'Invalid route' });

    const hops = buildHops(routeArr, amountOut);
    const q = await router.quoteSwap(hops);
    const maxIn = q.expectedAmountIn * BigInt(Math.round(10000 + slip * 100)) / 10000n;
    const recipientInput = recipient || wallet.address;
    const resolvedRecipient = await resolveAddressInput(recipientInput);

    // Ensure approval
    const tIn = tokens[routeArr[0]];
    const routerAddr = deployment.contracts.router;
    const allow = await tIn.contract.allowance(wallet.address, routerAddr);
    if (allow < maxIn) {
      const r = await txQueue.send(
        (nonce) => tIn.contract.approve(routerAddr, ethers.MaxUint256, { nonce, gasLimit: 100_000 }),
        `approve ${routeArr[0]}→router`
      );
      if (!r.success) return res.status(500).json({ error: `Approve failed: ${r.error}` });
    }

    // Execute
    const result = await txQueue.send(
      (nonce) => router.executeSwap(hops, maxIn, resolvedRecipient.address, { nonce, gasLimit: 800_000 }),
      `swap ${routeArr.join('→')}`
    );
    if (!result.success) return res.status(500).json({ error: result.error });

    const amtIn = ethers.formatUnits(q.expectedAmountIn, tIn.decimals);
    res.json({
      success: true, txHash: result.txHash, blockNumber: result.receipt.blockNumber,
      route: routeArr, amountOut, amountIn: amtIn,
      recipient: resolvedRecipient.address,
      recipientENS: resolvedRecipient.ens,
      selectedShards: q.selectedShards.map(a => findShardName(a)),
      gasUsed: result.receipt.gasUsed.toString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Price ──
app.get('/price/:tokenA/:tokenB', async (req, res) => {
  try {
    const { tokenA, tokenB } = req.params;
    const tA = tokens[tokenA], tB = tokens[tokenB];
    if (!tA || !tB) return res.status(400).json({ error: 'Invalid token' });

    const shards = deployment.contracts.shards[`${tokenA}-${tokenB}`] ||
                   deployment.contracts.shards[`${tokenB}-${tokenA}`];
    if (!shards?.length) return res.status(404).json({ error: 'No pool' });

    const pool = new ethers.Contract(shards[shards.length - 1].address, POOL_ABI, provider);
    const oneUnit = ethers.parseUnits('1', tB.decimals);
    const q = await pool.calculateSwapSAMM(oneUnit, tA.address, tB.address);
    const price = ethers.formatUnits(q.amountIn, tA.decimals);

    await refreshOracle();
    const oracleRate = (oraclePrices[tokenA] || 1) / (oraclePrices[tokenB] || 1);
    const spotRate = parseFloat(price);
    const deviation = ((spotRate - oracleRate) / oracleRate * 100);
    const spotPriceUSD = oraclePrices[tokenB] || 1;

    res.json({
      pair: `${tokenA}/${tokenB}`,
      price,
      description: `1 ${tokenB} = ${price} ${tokenA}`,
      spotPriceUSD: spotPriceUSD.toFixed(2),
      oracleRate: oracleRate.toFixed(8),
      deviationPct: deviation.toFixed(4),
      pool: shards[shards.length - 1].name,
      poolAddress: shards[shards.length - 1].address,
      oraclePrices: { [tokenA]: oraclePrices[tokenA], [tokenB]: oraclePrices[tokenB] },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Balances ──
app.get('/balance/:address/:token', async (req, res) => {
  try {
    const { address, token } = req.params;
    const resolved = await resolveAddressInput(address);
    const t = tokens[token];
    if (!t) return res.status(400).json({ error: 'Invalid token' });
    const bal = await t.contract.balanceOf(resolved.address);
    res.json({
      address: resolved.address,
      input: address,
      resolvedFromENS: resolved.ens,
      token,
      balance: ethers.formatUnits(bal, t.decimals),
      balanceRaw: bal.toString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/balances/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const resolved = await resolveAddressInput(address);
    const bals = {};
    for (const [sym, t] of Object.entries(tokens)) {
      const bal = await t.contract.balanceOf(resolved.address);
      bals[sym] = { balance: ethers.formatUnits(bal, t.decimals), balanceRaw: bal.toString(),
        decimals: t.decimals, address: t.address };
    }
    res.json({
      address: resolved.address,
      input: address,
      resolvedFromENS: resolved.ens,
      balances: bals,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ──
app.get('/stats', async (req, res) => {
  try {
    await refreshOracle();
    let totalLiq = 0;
    const pairStats = {};
    for (const [pair, shards] of Object.entries(deployment.contracts.shards)) {
      let pairLiq = 0;
      for (const s of shards) {
        const pd = await getPoolData(s.address);
        const l = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1) +
                  parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
        pairLiq += l;
      }
      totalLiq += pairLiq;
      pairStats[pair] = { shards: shards.length, liquidityUSD: Math.round(pairLiq),
        shardNames: shards.map(s => s.name) };
    }
    res.json({
      totalPairs: Object.keys(deployment.contracts.shards).length,
      totalShards: Object.values(deployment.contracts.shards).reduce((s, a) => s + a.length, 0),
      totalLiquidityUSD: Math.round(totalLiq),
      pairs: pairStats, tokens: Object.keys(tokens).length,
      router: deployment.contracts.router, factory: deployment.contracts.factory,
      orchestrator: deployment.contracts.orchestrator || null,
      oraclePrices,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Uniswap Comparison ─────────────────────────────────────────

// Helper: get a SAMM quote in the format needed for comparison
async function getSAMMQuoteForComparison(tokenIn, tokenOut, amountOut) {
  const tIn = tokens[tokenIn], tOut = tokens[tokenOut];
  if (!tIn || !tOut) return null;
  try {
    const hops = [{ tokenIn: tIn.address, tokenOut: tOut.address,
      amountOut: ethers.parseUnits(amountOut.toString(), tOut.decimals) }];
    const q = await router.quoteSwap(hops);
    const amtIn = parseFloat(ethers.formatUnits(q.expectedAmountIn, tIn.decimals));
    const fee = parseFloat(ethers.formatUnits(q.hopFees[0], tIn.decimals));
    return {
      amountIn: amtIn.toFixed(8),
      amountOut: amountOut.toString(),
      fee: fee.toFixed(8),
      feePct: ((fee / amtIn) * 100).toFixed(4),
      effectiveRate: (parseFloat(amountOut) / amtIn).toFixed(8),
      shard: findShardName(q.selectedShards[0]),
      shardAddress: q.selectedShards[0],
      priceImpact: `${(Number(q.priceImpacts[0]) / 10000).toFixed(2)}%`,
    };
  } catch (e) {
    console.log(`⚠️  SAMM quote failed: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

// Sepolia token address map (for Uniswap Trading API comparison)
const SEPOLIA_TOKEN_MAP = {
  'WETH': '0x0000000000000000000000000000000000000000',
  'USDC': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  'USDT': '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06',
  'DAI':  '0x68194a729C2450ad26072b3D33ADaCbcef39D574',
  'LINK': '0x779877A7B0D9E8603169DdbD7836e478b4624789',
};

// Helper: get a Sepolia Uniswap Trading API quote (EXACT_OUTPUT)
async function getSepoliaUniswapQuote(tokenIn, tokenOut, amountOut) {
  if (!uniswapSepolia || !uniswapSepolia.apiKey) return null;
  const sepoliaIn = SEPOLIA_TOKEN_MAP[tokenIn];
  const sepoliaOut = SEPOLIA_TOKEN_MAP[tokenOut];
  if (!sepoliaIn || !sepoliaOut) return null;
  const tIn = tokens[tokenIn], tOut = tokens[tokenOut];
  if (!tIn || !tOut) return null;
  try {
    const amtWei = ethers.parseUnits(amountOut.toString(), tOut.decimals);
    const apiData = await uniswapSepolia.getAPIQuote(
      sepoliaIn, sepoliaOut, amtWei.toString(), 'EXACT_OUTPUT', 5.0
    );
    const rawAmountIn = apiData.quote?.amountIn || apiData.quote?.input?.amount || '0';
    const amtIn = parseFloat(ethers.formatUnits(BigInt(rawAmountIn), tIn.decimals));
    return {
      amountIn: amtIn.toFixed(8),
      amountOut: amountOut.toString(),
      routing: apiData.routing,
      effectiveRate: amtIn > 0 ? (parseFloat(amountOut) / amtIn).toFixed(8) : '0',
      source: `Uniswap Trading API (Sepolia testnet)`,
      network: 'sepolia',
      chainId: 11155111,
      apiUsed: true,
    };
  } catch (e) {
    return { error: e.message, source: 'Uniswap Trading API (Sepolia)', apiUsed: true };
  }
}

// GET /compare/:tokenIn/:tokenOut/:amountOut — SAMM vs Uniswap comparison
app.get('/compare/:tokenIn/:tokenOut/:amountOut', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountOut } = req.params;
    if (!tokens[tokenIn] || !tokens[tokenOut])
      return res.status(400).json({ error: 'Invalid token', tokens: Object.keys(tokens) });
    await refreshOracle();

    const sammQuote = await getSAMMQuoteForComparison(tokenIn, tokenOut, amountOut);
    if (!sammQuote) return res.status(500).json({ error: 'SAMM quote failed' });

    // Get Sepolia Uniswap API quote (same testnet tier — real comparison)
    const sepoliaQuote = await getSepoliaUniswapQuote(tokenIn, tokenOut, amountOut);

    // Also get mainnet Uniswap quote for reference
    let mainnetComparison = null;
    try {
      mainnetComparison = await uniswapQuoter.compareWithSAMM(
        sammQuote, tokenIn, tokenOut, amountOut, oraclePrices
      );
    } catch { /* mainnet quote optional */ }

    // Build primary comparison: SAMM vs Sepolia Uniswap
    const sammIn = parseFloat(sammQuote.amountIn);
    let sepoliaComparison = null;
    if (sepoliaQuote && !sepoliaQuote.error) {
      const uniIn = parseFloat(sepoliaQuote.amountIn);
      if (uniIn > 0 && sammIn > 0) {
        const deltaPercent = ((uniIn - sammIn) / uniIn) * 100;
        const winner = sammIn < uniIn ? 'SAMM' : sammIn > uniIn ? 'Uniswap (Sepolia)' : 'Tie';
        const priceIn = oraclePrices[tokenIn] || 1;
        sepoliaComparison = {
          winner,
          deltaPercent: deltaPercent.toFixed(4),
          sammRequiresLessInput: sammIn < uniIn,
          savingsUSD: (Math.abs(uniIn - sammIn) * priceIn).toFixed(4),
          recommendation: winner === 'SAMM'
            ? `Route via SAMM shard ${sammQuote.shard} — saves ${deltaPercent.toFixed(2)}%`
            : `Route via Uniswap Sepolia (${sepoliaQuote.routing}) — saves ${Math.abs(deltaPercent).toFixed(2)}%`,
        };
      }
    }

    res.json({
      tokenIn, tokenOut, amountOut,
      amountOutUSD: (parseFloat(amountOut) * (oraclePrices[tokenOut] || 1)).toFixed(2),
      samm: {
        ...sammQuote,
        source: 'SAMM (RiseChain testnet)',
        network: 'risechain',
        chainId: 11155931,
      },
      sepoliaUniswap: sepoliaQuote,
      comparison: sepoliaComparison,
      mainnetUniswap: mainnetComparison?.uniswap || null,
      mainnetComparison: mainnetComparison?.comparison || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /compare/matrix — Full comparison matrix across all pairs and trade sizes
app.get('/compare/matrix', async (req, res) => {
  try {
    await refreshOracle();
    const matrix = await uniswapQuoter.runComparisonMatrix(
      (tokenIn, tokenOut, amountOut) => getSAMMQuoteForComparison(tokenIn, tokenOut, amountOut),
      oraclePrices
    );
    res.json(matrix);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Chainlink Oracle ───────────────────────────────────────────

// GET /oracle/chainlink — Chainlink vs CoinGecko vs on-chain spot prices
app.get('/oracle/chainlink', async (req, res) => {
  try {
    await refreshOracle();
    const chainlinkData = await chainlinkOracle.fetchAllPrices();
    const comparison = chainlinkOracle.compareWith(oraclePrices, 'CoinGecko');

    // Also get on-chain spot prices from SAMM pools for a 3-way comparison
    const spotPrices = {};
    for (const [pair, shards] of Object.entries(deployment.contracts.shards)) {
      const [tokenA, tokenB] = pair.split('-');
      const tA = tokens[tokenA], tB = tokens[tokenB];
      if (!tA || !tB) continue;
      try {
        const pool = new ethers.Contract(shards[shards.length - 1].address, POOL_ABI, provider);
        const oneUnit = ethers.parseUnits('1', tB.decimals);
        const q = await pool.calculateSwapSAMM(oneUnit, tA.address, tB.address);
        spotPrices[pair] = {
          price: parseFloat(ethers.formatUnits(q.amountIn, tA.decimals)),
          pool: shards[shards.length - 1].name,
        };
      } catch { /* skip */ }
    }

    res.json({
      chainlink: chainlinkData,
      coingecko: oraclePrices,
      comparison,
      spotPrices,
      summary: {
        chainlinkEnabled: chainlinkOracle.enabled,
        feedCount: chainlinkData.feedCount || 0,
        source: chainlinkData.source,
        description: 'Chainlink provides decentralized, DON-validated price feeds. '
          + 'CoinGecko is a centralized API fallback. SAMM spot prices are derived from on-chain reserves.',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /oracle/status — Oracle system status
app.get('/oracle/status', (req, res) => {
  res.json({
    chainlink: chainlinkOracle.getStatus(),
    coingecko: { prices: oraclePrices, lastUpdate: lastOracleUpdate },
    primary: chainlinkOracle.enabled ? 'chainlink' : 'coingecko',
    arbBotSource: arbitrageBot?.oracleSource || 'not started',
  });
});

// ─── ENS Agent Registry ─────────────────────────────────────────

app.get('/agents', async (req, res) => {
  if (!ensRegistry) return res.json({ enabled: false, agents: [] });
  try {
    const agents = await ensRegistry.listAgents();
    res.json({
      enabled: true,
      status: ensRegistry.status(),
      agents,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agents/:name', async (req, res) => {
  if (!ensRegistry) return res.status(404).json({ enabled: false, error: 'ENS registry disabled' });
  try {
    const { name } = req.params;
    const agent = await ensRegistry.getAgent(name);
    if (!agent) return res.status(404).json({ error: `Agent not found: ${name}` });

    const resolvedAddress = agent.ensName ? await ensRegistry.resolveAddress(agent.ensName) : null;
    res.json({
      agent,
      ensResolution: agent.ensName ? {
        name: agent.ensName,
        resolvedAddress,
        matchesRegistryAddress: resolvedAddress
          ? resolvedAddress.toLowerCase() === agent.agentAddress.toLowerCase()
          : false,
      } : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/registry/shards', async (req, res) => {
  if (!ensRegistry) return res.json({ enabled: false, shards: [] });
  try {
    const shards = await ensRegistry.listShards();
    res.json({ enabled: true, count: shards.length, shards });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Arbitrage Bot ──────────────────────────────────────────────
app.get('/arbitrage/status', (req, res) => {
  if (!arbitrageBot) return res.json({ enabled: false });
  res.json(arbitrageBot.getStatus());
});

app.get('/arbitrage/history', (req, res) => {
  if (!arbitrageBot) return res.json({ enabled: false, history: [] });
  const limit = parseInt(req.query.limit || '50');
  const pair = req.query.pair || undefined;
  const status = req.query.status || undefined;
  res.json({ history: arbitrageBot.getHistory(limit, { pair, status }) });
});

app.post('/arbitrage/start', async (req, res) => {
  if (!wallet) return res.status(400).json({ error: 'No PRIVATE_KEY' });
  if (!arbitrageBot) {
    arbitrageBot = new ArbitrageBot(DEPLOYMENT_FILE, normalizePK(process.env.PRIVATE_KEY), RPC_URL, txQueue);
  }
  try { await arbitrageBot.start(); res.json({ success: true, status: arbitrageBot.getStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/arbitrage/stop', (req, res) => {
  if (!arbitrageBot) return res.status(400).json({ error: 'Not initialized' });
  arbitrageBot.stop();
  res.json({ success: true, status: arbitrageBot.getStatus() });
});

// ─── Dynamic Shard Manager ─────────────────────────────────────
app.get('/sharding/status', (req, res) => {
  if (!shardManager) return res.json({ enabled: false });
  res.json(shardManager.getStatus());
});

app.post('/sharding/start', async (req, res) => {
  if (!wallet) return res.status(400).json({ error: 'No PRIVATE_KEY' });
  if (!shardManager) {
    shardManager = new DynamicShardManager(DEPLOYMENT_FILE, normalizePK(process.env.PRIVATE_KEY), RPC_URL, txQueue);
  }
  try { await shardManager.start(); res.json({ success: true, status: shardManager.getStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sharding/stop', (req, res) => {
  if (!shardManager) return res.status(400).json({ error: 'Not initialized' });
  shardManager.stop();
  res.json({ success: true, status: shardManager.getStatus() });
});

app.post('/sharding/check', async (req, res) => {
  if (!shardManager) return res.status(400).json({ error: 'Not initialized' });
  try { await shardManager.checkAndManageShards(); res.json({ success: true, status: shardManager.getStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Uniswap Sepolia Swap ──────────────────────────────────────
app.get('/swap/sepolia/quote', async (req, res) => {
  if (!uniswapSepolia) return res.status(400).json({ error: 'No PRIVATE_KEY or SEPOLIA_RPC_URL' });
  try {
    const { tokenIn, tokenOut, amount } = req.query;
    const WETH = UniswapSepoliaSwap.ADDRESSES.WETH9;
    const tIn = tokenIn || WETH;
    const tOut = tokenOut || UniswapSepoliaSwap.ADDRESSES.USDC;
    const amtWei = ethers.parseEther(amount || '0.001');
    const quote = await uniswapSepolia.getSwapQuote(tIn, tOut, amtWei);
    res.json({ source: 'uniswap-v2-sepolia', network: 'sepolia', ...quote });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/swap/sepolia', async (req, res) => {
  if (!uniswapSepolia) return res.status(400).json({ error: 'No PRIVATE_KEY' });
  if (!uniswapSepolia.apiKey) return res.status(400).json({ error: 'No UNISWAP_API_KEY — Trading API required' });
  try {
    const { tokenIn, tokenOut, amount, type, slippageTolerance } = req.body;
    if (!tokenIn || !tokenOut || !amount)
      return res.status(400).json({
        error: 'Missing: tokenIn, tokenOut, amount',
        hint: 'Use symbol names (ETH, USDC, USDT, DAI, LINK) or raw Sepolia addresses',
        example: { tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.001', type: 'EXACT_INPUT', slippageTolerance: 5.0 },
      });

    // Resolve token symbols → Sepolia addresses
    const SYMBOL_MAP = {
      'ETH':  UniswapSepoliaSwap.ADDRESSES.NATIVE_ETH,
      'WETH': UniswapSepoliaSwap.ADDRESSES.WETH9,
      'USDC': UniswapSepoliaSwap.ADDRESSES.USDC,
      'USDT': UniswapSepoliaSwap.ADDRESSES.USDT,
      'DAI':  UniswapSepoliaSwap.ADDRESSES.DAI,
      'LINK': UniswapSepoliaSwap.ADDRESSES.LINK,
    };
    const DECIMALS = { ETH: 18, WETH: 18, USDC: 6, USDT: 6, DAI: 18, LINK: 18 };

    const resolvedIn  = SYMBOL_MAP[tokenIn.toUpperCase()]  || tokenIn;
    const resolvedOut = SYMBOL_MAP[tokenOut.toUpperCase()] || tokenOut;
    const symbolIn = Object.entries(SYMBOL_MAP).find(([,v]) => v.toLowerCase() === resolvedIn.toLowerCase())?.[0] || tokenIn;
    const decimalsIn = DECIMALS[symbolIn.toUpperCase()] || 18;

    // Parse amount based on type
    const swapType = (type || 'EXACT_INPUT').toUpperCase();
    const amountWei = ethers.parseUnits(amount.toString(), decimalsIn).toString();
    const slip = parseFloat(slippageTolerance || '5.0');

    // If tokenIn is NOT native ETH, ensure Permit2 approval first
    const isNativeETH = resolvedIn === UniswapSepoliaSwap.ADDRESSES.NATIVE_ETH;
    if (!isNativeETH) {
      await uniswapSepolia._ensurePermit2Approval(resolvedIn, BigInt(amountWei));
    }

    // Full Uniswap Trading API flow:
    //   1. POST /v1/quote → get routing, permitData, quote
    //   2. Sign Permit2 EIP-712 typed data (if token swap)
    //   3. POST /v1/swap → get unsigned tx calldata
    //   4. Sign + broadcast transaction
    const result = await uniswapSepolia.executeAPISwap(
      resolvedIn, resolvedOut, amountWei,
      { type: swapType, slippageTolerance: slip }
    );

    res.json({
      success: true,
      description: 'Uniswap swap executed via backend — Trading API + Permit2 signed tx',
      flow: [
        '1. POST /v1/quote to Uniswap Trading API',
        isNativeETH ? '2. Native ETH — no Permit2 needed' : '2. Approve token → Permit2 + sign EIP-712',
        '3. POST /v1/swap for unsigned tx calldata',
        '4. Backend signs + broadcasts to Sepolia',
      ],
      ...result,
      explorer: `https://sepolia.etherscan.io/tx/${result.txHash}`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/swap/sepolia/balances', async (req, res) => {
  if (!uniswapSepolia) return res.status(400).json({ error: 'Not configured' });
  try {
    const balances = await uniswapSepolia.getBalances();
    res.json(balances);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/swap/sepolia/history', (req, res) => {
  if (!uniswapSepolia) return res.json({ history: [] });
  res.json({ history: uniswapSepolia.getHistory() });
});

// ─── Frontend-Compatible Uniswap Swap (user signs in MetaMask) ──────

/**
 * POST /swap/sepolia/prepare
 *
 * Step 1 of the user-facing flow: get a quote + Permit2 data for
 * the user's OWN wallet. The backend proxies the Uniswap Trading API
 * but does NOT sign anything — only the user's MetaMask does.
 *
 * Body: { userAddress, tokenIn, tokenOut, amount, type?, slippageTolerance? }
 */
app.post('/swap/sepolia/prepare', async (req, res) => {
  if (!uniswapSepolia) return res.status(400).json({ error: 'Uniswap integration not configured' });
  if (!uniswapSepolia.apiKey) return res.status(400).json({ error: 'No UNISWAP_API_KEY' });
  try {
    const { userAddress, tokenIn, tokenOut, amount, type, slippageTolerance } = req.body;
    if (!userAddress || !tokenIn || !tokenOut || !amount)
      return res.status(400).json({
        error: 'Missing: userAddress, tokenIn, tokenOut, amount',
        hint: 'userAddress = the wallet address the user connected in MetaMask',
        example: {
          userAddress: '0xYourMetaMaskAddress',
          tokenIn: 'ETH',
          tokenOut: 'USDC',
          amount: '0.001',
          type: 'EXACT_INPUT',
          slippageTolerance: 5.0,
        },
      });

    // Resolve token symbols → Sepolia addresses
    const SYMBOL_MAP = {
      'ETH':  UniswapSepoliaSwap.ADDRESSES.NATIVE_ETH,
      'WETH': UniswapSepoliaSwap.ADDRESSES.WETH9,
      'USDC': UniswapSepoliaSwap.ADDRESSES.USDC,
      'USDT': UniswapSepoliaSwap.ADDRESSES.USDT,
      'DAI':  UniswapSepoliaSwap.ADDRESSES.DAI,
      'LINK': UniswapSepoliaSwap.ADDRESSES.LINK,
    };
    const DECIMALS = { ETH: 18, WETH: 18, USDC: 6, USDT: 6, DAI: 18, LINK: 18 };

    const resolvedIn  = SYMBOL_MAP[tokenIn.toUpperCase()]  || tokenIn;
    const resolvedOut = SYMBOL_MAP[tokenOut.toUpperCase()] || tokenOut;
    const symbolIn = Object.entries(SYMBOL_MAP).find(([,v]) => v.toLowerCase() === resolvedIn.toLowerCase())?.[0] || tokenIn;
    const decimalsIn = DECIMALS[symbolIn.toUpperCase()] || 18;

    const swapType = (type || 'EXACT_INPUT').toUpperCase();
    const amountWei = ethers.parseUnits(amount.toString(), decimalsIn).toString();
    const slip = parseFloat(slippageTolerance || '5.0');

    const result = await uniswapSepolia.prepareSwapForUser(
      userAddress, resolvedIn, resolvedOut, amountWei,
      { type: swapType, slippageTolerance: slip }
    );

    res.json({
      ...result,
      flow: [
        '1. Frontend calls POST /swap/sepolia/prepare (this endpoint)',
        '2. Frontend shows quote to user, user approves',
        result.needsPermit2Signature
          ? '3. User signs permitData in MetaMask (signTypedData_v4)'
          : '3. No Permit2 signature needed (native ETH)',
        '4. Frontend calls POST /swap/sepolia/execute with { quote, signature, permitData, routing }',
        '5. Backend returns unsigned tx → user signs + broadcasts in MetaMask',
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /swap/sepolia/execute
 *
 * Step 2 of the user-facing flow: take the user's Permit2 signature
 * + quote, call Uniswap /v1/swap, return unsigned tx for MetaMask.
 *
 * Body: { quote, signature?, permitData?, routing }
 */
app.post('/swap/sepolia/execute', async (req, res) => {
  if (!uniswapSepolia) return res.status(400).json({ error: 'Uniswap integration not configured' });
  if (!uniswapSepolia.apiKey) return res.status(400).json({ error: 'No UNISWAP_API_KEY' });
  try {
    const { quote, signature, permitData, routing } = req.body;
    if (!quote || !routing)
      return res.status(400).json({
        error: 'Missing: quote, routing (from /swap/sepolia/prepare response)',
        hint: 'Also include signature + permitData if the prepare step returned needsPermit2Signature: true',
      });

    const result = await uniswapSepolia.getSwapCalldata(
      quote, signature || null, permitData || null, routing
    );

    res.json({
      ...result,
      nextStep: 'Sign unsignedTransaction in MetaMask and call eth_sendTransaction',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Bridge: Sepolia ↔ RiseChain ────────────────────────────────
app.get('/bridge/status', (req, res) => {
  if (!riseChainBridge) return res.status(400).json({ error: 'Not configured' });
  res.json(riseChainBridge.getStatus());
});

app.get('/bridge/balances', async (req, res) => {
  if (!riseChainBridge) return res.status(400).json({ error: 'Not configured' });
  try {
    const balances = await riseChainBridge.getBalances();
    res.json(balances);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bridge/deposit', async (req, res) => {
  if (!riseChainBridge) return res.status(400).json({ error: 'Not configured' });
  try {
    const { amount, asset } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    if (asset && asset !== 'ETH') {
      return res.status(400).json({ error: 'Only ETH bridge supported in demo' });
    }
    const result = await riseChainBridge.depositETH(amount);
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bridge/withdraw', async (req, res) => {
  if (!riseChainBridge) return res.status(400).json({ error: 'Not configured' });
  try {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    const result = await riseChainBridge.withdrawETH(amount);
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/bridge/history', (req, res) => {
  if (!riseChainBridge) return res.json({ history: [] });
  res.json({ history: riseChainBridge.getHistory() });
});

// ─── CRE Workflow Status ────────────────────────────────────────
app.get('/sharding/cre-status', (req, res) => {
  const fs = require('fs');
  const workflowPath = path.join(__dirname, 'integrations', 'chainlink-cre-workflow', 'my-workflow');
  const hasWorkflow = fs.existsSync(path.join(workflowPath, 'workflow.ts'));
  const hasConfig = fs.existsSync(path.join(workflowPath, 'config.json'));
  
  let config = {};
  if (hasConfig) {
    try { config = JSON.parse(fs.readFileSync(path.join(workflowPath, 'config.json'), 'utf8')); } catch(e) {}
  }
  
  res.json({
    cre: {
      workflowExists: hasWorkflow,
      configExists: hasConfig,
      workflowName: 'samm-shard-orchestrator',
      trigger: config.schedule || 'not configured',
      splitThreshold: config.splitTpsThreshold || 250,
      mergeThreshold: config.mergeTpsThreshold || 62.5,
      maxShardsPerPair: config.maxShardsPerPair || 10,
      feeds: config.feeds || [],
      pairs: config.pairs || [],
      howToSimulate: 'cre workflow simulate integrations/chainlink-cre-workflow/my-workflow',
      note: 'CRE workflows run on Chainlink DON — simulate locally with CRE CLI, deploy requires Early Access',
    },
    offchainFallback: shardManager ? shardManager.getStatus() : { enabled: false },
  });
});

/**
 * POST /sharding/cre-simulate
 *
 * Runs the CRE workflow logic LIVE — reads Chainlink price feeds
 * from Sepolia on-chain, fetches SAMM pool data from the running
 * api-server, and computes shard decisions.
 *
 * This mirrors what the CRE workflow.ts does on the Chainlink DON,
 * but executed here so judges can see it working in real-time.
 */
app.post('/sharding/cre-simulate', async (req, res) => {
  try {
    const startTime = Date.now();
    const sepoliaRpc = process.env.SEPOLIA_RPC_URL;
    if (!sepoliaRpc) return res.status(400).json({ error: 'SEPOLIA_RPC_URL not configured' });

    const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);

    // Chainlink AggregatorV3 ABI
    const aggABI = [
      'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
      'function decimals() view returns (uint8)',
      'function description() view returns (string)',
    ];

    // CRE workflow config (same feeds as workflow.ts)
    const creConfig = {
      feeds: [
        { name: 'ETH/USD', address: '0x694AA1769357215DE4FAC081bf1f309aDC325306' },
        { name: 'BTC/USD', address: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43' },
        { name: 'USDC/USD', address: '0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E' },
        { name: 'DAI/USD', address: '0x14866185B1962B63C3Ea9E03Bc1da838bab34C19' },
      ],
      pairs: [
        { tokenA: 'WETH', tokenB: 'USDC' },
        { tokenA: 'USDC', tokenB: 'USDT' },
        { tokenA: 'WETH', tokenB: 'USDT' },
        { tokenA: 'WBTC', tokenB: 'USDC' },
        { tokenA: 'USDC', tokenB: 'DAI' },
      ],
      splitTpsThreshold: 250,
      mergeTpsThreshold: 62.5,
      maxShardsPerPair: 10,
      minDeviationPct: 0.30,
    };

    // ── Step 1: Read Chainlink price feeds from Sepolia ──
    const prices = [];
    const feedErrors = [];
    await Promise.all(creConfig.feeds.map(async (feed) => {
      try {
        const contract = new ethers.Contract(feed.address, aggABI, sepoliaProvider);
        const [roundId, answer, , updatedAt] = await contract.latestRoundData();
        const decimals = await contract.decimals();
        const description = await contract.description().catch(() => feed.name);
        const price = parseFloat(ethers.formatUnits(answer, decimals));
        const staleness = Math.floor(Date.now() / 1000) - Number(updatedAt);
        prices.push({
          name: feed.name,
          price,
          roundId: roundId.toString(),
          decimals: Number(decimals),
          updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
          stalenessSeconds: staleness,
          feedAddress: feed.address,
          description,
          source: 'Chainlink AggregatorV3 on Sepolia (LIVE on-chain read)',
        });
      } catch (err) {
        feedErrors.push({ feed: feed.name, address: feed.address, error: err.message?.slice(0, 100) });
      }
    }));

    // ── Step 2: Get SAMM pool data from self ──
    // The 3 original shards (Small/Medium/Large) are NEVER removed.
    // Only Dynamic shards (suffixed -Dynamic) can be created/merged/split.
    const MIN_SHARDS_PER_PAIR = 3;
    let sammData = { pairs: {} };
    for (const [pair, shards] of Object.entries(deployment.contracts?.shards || {})) {
      const originalShards = shards.filter(s => !s.name.includes('Dynamic'));
      const dynamicShards = shards.filter(s => s.name.includes('Dynamic'));
      sammData.pairs[pair] = {
        shardCount: shards.length,
        originalShards: originalShards.length,
        dynamicShards: dynamicShards.length,
        originalNames: originalShards.map(s => s.name),
        dynamicNames: dynamicShards.map(s => s.name),
        tps: shardManager?.pairMetrics?.[pair]?.tps || 0,
        totalTVL: 0,
        shards: [],
      };
    }

    // ── Step 3: Compute shard decisions (same logic as CRE workflow.ts) ──
    const priceMap = new Map(prices.map(p => [p.name, p.price]));
    const decisions = [];
    for (const pair of creConfig.pairs) {
      const pairKey = `${pair.tokenA}-${pair.tokenB}`;
      const pairData = sammData.pairs[pairKey];
      if (!pairData) continue;

      const { shardCount, tps } = pairData;
      const tpsPerShard = shardCount > 0 ? tps / shardCount : 0;

      if (tpsPerShard >= creConfig.splitTpsThreshold) {
        const targetShards = Math.min(
          Math.ceil(tps / creConfig.splitTpsThreshold),
          creConfig.maxShardsPerPair
        );
        decisions.push({
          type: 'SPLIT',
          pair: pairKey,
          reason: `TPS/shard ${tpsPerShard.toFixed(1)} ≥ ${creConfig.splitTpsThreshold} threshold`,
          currentShards: shardCount,
          targetShards,
          tps,
        });
      } else if (tpsPerShard <= creConfig.mergeTpsThreshold && shardCount > MIN_SHARDS_PER_PAIR) {
        // Only merge DYNAMIC shards — the 3 original shards (Small/Medium/Large) are protected
        const targetShards = Math.max(Math.ceil(tps / creConfig.splitTpsThreshold), MIN_SHARDS_PER_PAIR);
        const dynamicCount = pairData.dynamicShards || 0;
        const dynamicToRemove = shardCount - targetShards;
        decisions.push({
          type: 'MERGE',
          pair: pairKey,
          reason: `TPS/shard ${tpsPerShard.toFixed(1)} ≤ ${creConfig.mergeTpsThreshold} — remove ${Math.min(dynamicToRemove, dynamicCount)} dynamic shard(s)`,
          currentShards: shardCount,
          targetShards,
          originalShardsProtected: pairData.originalShards || MIN_SHARDS_PER_PAIR,
          dynamicShardsToRemove: Math.min(dynamicToRemove, dynamicCount),
          note: `Original shards (${(pairData.originalNames || []).join(', ')}) are NEVER removed`,
          tps,
        });
      } else {
        decisions.push({
          type: 'NO_ACTION',
          pair: pairKey,
          reason: `TPS/shard ${tpsPerShard.toFixed(1)} within bounds [${creConfig.mergeTpsThreshold}, ${creConfig.splitTpsThreshold}]`,
          currentShards: shardCount,
          targetShards: shardCount,
          tps,
        });
      }

      // Price deviation check
      const priceA = priceMap.get(`${pair.tokenA === 'WETH' ? 'ETH' : pair.tokenA === 'WBTC' ? 'BTC' : pair.tokenA}/USD`);
      const priceB = priceMap.get(`${pair.tokenB === 'WETH' ? 'ETH' : pair.tokenB === 'WBTC' ? 'BTC' : pair.tokenB}/USD`);
      if (priceA && priceB) {
        const oracleRate = priceA / priceB;
        decisions.push({
          type: 'PRICE_CHECK',
          pair: pairKey,
          oracleRate: oracleRate.toFixed(6),
          priceA: `${pair.tokenA}: $${priceA.toFixed(2)}`,
          priceB: `${pair.tokenB}: $${priceB.toFixed(2)}`,
          source: 'Chainlink Sepolia',
        });
      }
    }

    const elapsed = Date.now() - startTime;

    res.json({
      success: true,
      workflow: 'samm-shard-orchestrator (CRE simulation)',
      timestamp: new Date().toISOString(),
      executionTimeMs: elapsed,
      chainlinkPrices: prices,
      feedErrors: feedErrors.length > 0 ? feedErrors : undefined,
      sammPoolData: sammData,
      decisions,
      summary: {
        totalDecisions: decisions.length,
        splits: decisions.filter(d => d.type === 'SPLIT').length,
        merges: decisions.filter(d => d.type === 'MERGE').length,
        noAction: decisions.filter(d => d.type === 'NO_ACTION').length,
        priceChecks: decisions.filter(d => d.type === 'PRICE_CHECK').length,
        pricesSummary: prices.map(p => `${p.name}=$${p.price.toFixed(2)}`).join(', '),
      },
      architecture: {
        description: 'CRE workflow reads Chainlink price feeds on-chain via EVMClient.callContract, '
          + 'fetches SAMM pool data via HTTP, computes shard decisions using TPS thresholds and price deviations. '
          + 'On Chainlink DON, this runs every 60s via cron trigger with DON consensus.',
        chainlinkFeeds: creConfig.feeds.map(f => f.name),
        thresholds: {
          split: `${creConfig.splitTpsThreshold} TPS/shard`,
          merge: `${creConfig.mergeTpsThreshold} TPS/shard`,
          minDeviation: `${creConfig.minDeviationPct}%`,
        },
        trigger: 'CronCapability — every 60 seconds',
        consensus: 'ConsensusAggregationByFields (DON nodes agree on shard decisions)',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Integration Status ─────────────────────────────────────────
app.get('/integrations', async (req, res) => {
  const status = {
    uniswap: {
      apiQuoter: {
        enabled: !!uniswapQuoter,
        source: 'uniswap-trading-api',
        apiKeyConfigured: !!process.env.UNISWAP_API_KEY,
        apiEndpoint: 'https://trade-api.gateway.uniswap.org/v1',
      },
      sepoliaSwap: {
        enabled: !!uniswapSepolia,
        tradingAPIEnabled: !!(uniswapSepolia && uniswapSepolia.apiKey),
        router: UniswapSepoliaSwap.ADDRESSES.UNIVERSAL_ROUTER,
        v2Factory: UniswapSepoliaSwap.ADDRESSES.V2_FACTORY,
        permit2: UniswapSepoliaSwap.ADDRESSES.PERMIT2,
        network: 'sepolia',
        chainId: 11155111,
        history: uniswapSepolia ? uniswapSepolia.getHistory().length : 0,
      },
    },
    chainlink: {
      priceFeeds: {
        enabled: chainlinkOracle.enabled,
        network: 'sepolia',
        feeds: ['ETH/USD', 'BTC/USD', 'USDC/USD', 'DAI/USD', 'LINK/USD'],
      },
      creWorkflow: {
        enabled: true,
        name: 'samm-shard-orchestrator',
        description: 'Decentralized shard management via Chainlink DON',
        splitThreshold: '250 TPS',
        mergeThreshold: '62.5 TPS',
      },
    },
    ens: {
      resolution: { enabled: !!ensProvider, source: 'ethereum-mainnet' },
      agentRegistry: {
        enabled: !!ensRegistry,
        onChain: !!process.env.ENS_REGISTRY_ADDRESS,
        baseDomain: 'samm.eth',
      },
    },
    bridge: {
      enabled: !!riseChainBridge,
      type: 'OP Stack Canonical Bridge',
      l1: 'Sepolia',
      l2: 'RiseChain Testnet',
      contracts: riseChainBridge ? RiseChainBridge.ADDRESSES : null,
      history: riseChainBridge ? riseChainBridge.getHistory().length : 0,
    },
  };
  res.json(status);
});

// ── Error handler ──
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ──────────────────────────────────────────────────────
initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 SAMM DEX API Server on port ${PORT}`);
    console.log(`\n📚 Endpoints:`);
    console.log(`   GET  /health                          — health + status`);
    console.log(`   GET  /tokens                          — tokens with prices`);
    console.log(`   GET  /pools                           — all pools with TVL`);
    console.log(`   GET  /pools/:tokenA/:tokenB           — pools for pair`);
    console.log(`   GET  /shards/:tokenA/:tokenB          — shards from chain`);
    console.log(`   GET  /quote/:tokenIn/:tokenOut/:amt   — quick quote + slippage`);
    console.log(`   POST /quote                           — full quote (multi-hop)`);
    console.log(`   POST /swap                            — execute swap via router`);
    console.log(`   GET  /price/:tokenA/:tokenB           — spot price`);
    console.log(`   GET  /balance/:addr/:token            — token balance`);
    console.log(`   GET  /balances/:addr                  — all balances`);
    console.log(`   GET  /stats                           — DEX statistics`);
    console.log(`   GET  /compare/:in/:out/:amt           — SAMM vs Uniswap comparison`);
    console.log(`   GET  /compare/matrix                  — full comparison matrix`);
    console.log(`   GET  /oracle/chainlink                 — Chainlink vs CoinGecko prices`);
    console.log(`   GET  /oracle/status                    — oracle system status`);
    console.log(`   GET  /agents                          — ENS-discoverable SAMM agents`);
    console.log(`   GET  /agents/:name                    — agent identity + metadata`);
    console.log(`   GET  /registry/shards                 — ENS shard registry view`);
    console.log(`   GET  /arbitrage/status                — arb bot status`);
    console.log(`   GET  /arbitrage/history?limit=50      — arb swap log`);
    console.log(`   POST /arbitrage/start|stop            — control arb bot`);
    console.log(`   GET  /sharding/status                 — shard manager status`);
    console.log(`   POST /sharding/start|stop|check       — control shard manager`);
    console.log(`   ── Uniswap Sepolia (NEW) ──`);
    console.log(`   GET  /swap/sepolia/quote              — Uniswap V2 quote on Sepolia`);
    console.log(`   POST /swap/sepolia                    — execute real Uniswap swap (backend signs)`);
    console.log(`   POST /swap/sepolia/prepare            — get quote for user's MetaMask wallet`);
    console.log(`   POST /swap/sepolia/execute            — get unsigned tx (user signs in MetaMask)`);
    console.log(`   GET  /swap/sepolia/balances           — Sepolia wallet balances`);
    console.log(`   GET  /swap/sepolia/history            — Sepolia swap history`);
    console.log(`   ── Bridge (NEW) ──`);
    console.log(`   GET  /bridge/status                   — bridge status + contracts`);
    console.log(`   GET  /bridge/balances                 — cross-chain balances`);
    console.log(`   POST /bridge/deposit                  — bridge ETH L1→L2`);
    console.log(`   POST /bridge/withdraw                 — bridge ETH L2→L1`);
    console.log(`   GET  /bridge/history                  — bridge tx history`);
    console.log(`   ── CRE Workflow ──`);
    console.log(`   GET  /sharding/cre-status             — CRE workflow status`);
    console.log(`   POST /sharding/cre-simulate           — run CRE workflow LIVE (Chainlink feeds + decisions)`);
    console.log(`   ── Integrations ──`);
    console.log(`   GET  /integrations                    — integration statuses`);
    console.log(`\n💡 curl http://localhost:${PORT}/health\n`);
  });
}).catch(err => { console.error('Failed:', err); process.exit(1); });
