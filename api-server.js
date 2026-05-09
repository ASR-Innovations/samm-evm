'use strict';
/**
 * SAMM DEX API Server — Solana edition
 *
 * Just run `node api-server.js` with a .env file.
 * Reads pools from deployment-data/solana-devnet.json.
 * Auto-starts arb bot and dynamic shard manager when a keypair is present.
 */

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const SolanaAdapter = require('./solana-adapter');
const ArbitrageBot  = require('./arbitrage-bot');
const DynamicShardManager = require('./dynamic-shard-manager');
const TxQueue = require('./tx-queue');
require('dotenv').config();

// ─── Process-level error handlers ─────────────────────────────────
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

// BigInt-safe JSON serialization (BigInt → string to avoid "Do not know how to serialize a BigInt")
app.set('json replacer', (_key, val) => typeof val === 'bigint' ? val.toString() : val);

// ─── Config ───────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '3000');
const RPC_URL     = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE || 'solana-devnet.json';
const deploymentPath  = path.join(__dirname, 'deployment-data', DEPLOYMENT_FILE);

let deployment;
try {
  deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
} catch (e) {
  console.error(`Failed to load ${deploymentPath}: ${e.message}`);
  process.exit(1);
}

const PROGRAM_ID = process.env.SOLANA_PROGRAM_ID || deployment.programId;

// Derive WebSocket endpoint so sendAndConfirmTransaction can subscribe to confirmations.
// Alchemy (and most private RPC providers) use wss:// at the same path as https://.
const WS_URL = (process.env.SOLANA_WS_URL
  || RPC_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://'));
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  wsEndpoint: WS_URL,
});

// Wallet keypair (optional — read-only mode without it)
let keypair  = null;
let txQueue  = null;
if (process.env.SOLANA_PRIVATE_KEY) {
  const raw = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
  keypair  = Keypair.fromSecretKey(raw);
  txQueue  = new TxQueue(connection, keypair);
}

const adapter = new SolanaAdapter(connection, keypair, deployment, PROGRAM_ID);
const SAMMRouter = require('./samm-router');
const router = new SAMMRouter(connection, keypair, deployment, PROGRAM_ID);
const { routerSwap } = require('./samm-router-client');

const ROUTER_PROGRAM_ID = deployment.routerProgramId || process.env.SAMM_ROUTER_PROGRAM_ID || null;

// ─── Oracle ───────────────────────────────────────────────────────
const geckoIds = { WETH: 'ethereum', WBTC: 'bitcoin', USDC: 'usd-coin', USDT: 'tether', DAI: 'dai' };
let oraclePrices = {};
let lastOracleUpdate = 0;

async function refreshOracle() {
  if (Date.now() - lastOracleUpdate < 60_000 && Object.keys(oraclePrices).length > 0) return oraclePrices;
  try {
    const ids  = Object.values(geckoIds).join(',');
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (resp.ok) {
      const data = await resp.json();
      for (const [sym, id] of Object.entries(geckoIds)) {
        if (data[id]?.usd) oraclePrices[sym] = data[id].usd;
      }
      lastOracleUpdate = Date.now();
    }
  } catch { /* fall through to deployment prices */ }

  for (const [sym, d] of Object.entries(deployment.tokens)) {
    if (!oraclePrices[sym]) oraclePrices[sym] = d.price;
  }
  return oraclePrices;
}

// ─── Helpers ──────────────────────────────────────────────────────
function formatUnits(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, '0');
  const idx = s.length - decimals;
  return `${s.slice(0, idx)}.${s.slice(idx)}`;
}

function parseUnits(amount, decimals) {
  const [int, frac = ''] = String(amount).split('.');
  const padded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(int + padded);
}

const poolStateCache = new Map();

async function getPoolData(poolAddress) {
  const cached = poolStateCache.get(poolAddress);
  if (cached && Date.now() - cached.ts < 10_000) return cached.data;

  const r = await adapter.getReserves(poolAddress);
  const mintAStr = r.mintA.toBase58();

  // Resolve symbols from mint addresses
  let symA, symB, decA = r.decimalsA, decB = r.decimalsB;
  for (const [sym, d] of Object.entries(deployment.tokens)) {
    if (d.mint === mintAStr)   { symA = sym; decA = d.decimals ?? r.decimalsA; }
    if (d.mint === r.mintB.toBase58()) { symB = sym; decB = d.decimals ?? r.decimalsB; }
  }

  const data = {
    address:  poolAddress,
    tokenA:   symA,
    tokenB:   symB,
    mintA:    mintAStr,
    mintB:    r.mintB.toBase58(),
    reserveA: formatUnits(r.reserveA, decA),
    reserveB: formatUnits(r.reserveB, decB),
    reserveARaw: r.reserveA,
    reserveBRaw: r.reserveB,
    decimalsA: decA,
    decimalsB: decB,
  };
  poolStateCache.set(poolAddress, { data, ts: Date.now() });
  return data;
}

// ─── Rust SAMM binary ──────────────────────────────────────────────
const RUST_BINARY = path.join(__dirname, 'rust-samm', 'target', 'release', 'samm');
const RUST_BINARY_AVAILABLE = fs.existsSync(RUST_BINARY);

function rustCall(subcommand, params) {
  const json = JSON.stringify(params);
  const out  = execSync(`"${RUST_BINARY}" ${subcommand} '${json}'`, {
    encoding: 'utf8', timeout: 5000,
  });
  return JSON.parse(out.trim());
}

// ─── Module-level instances (started in initialize()) ─────────────
let arbitrageBot = null;
let shardManager = null;

// ─── Initialize ───────────────────────────────────────────────────
async function initialize() {
  await refreshOracle();

  if (!keypair) {
    console.log('\n⏸️  No SOLANA_PRIVATE_KEY — read-only mode (no arb bot, no shard manager)');
    return;
  }

  console.log(`\n📡 Wallet: ${keypair.publicKey.toBase58()}`);
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`   Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (!PROGRAM_ID) {
    console.log('\n⚠️  SOLANA_PROGRAM_ID not set — deploy first, then add to .env');
    return;
  }

  // Auto-start arb bot (non-blocking — don't await, let server start first)
  if (process.env.ENABLE_ARBITRAGE !== 'false') {
    setTimeout(() => {
      arbitrageBot = new ArbitrageBot(DEPLOYMENT_FILE, keypair, connection, txQueue, PROGRAM_ID);
      arbitrageBot.start().catch(e => console.error('⚠️  Arb bot error:', e.message?.slice(0, 100)));
    }, 3000);
  }

  // Auto-start shard manager (non-blocking)
  if (process.env.ENABLE_DYNAMIC_SHARDING !== 'false') {
    setTimeout(() => {
      shardManager = new DynamicShardManager(DEPLOYMENT_FILE, keypair, connection, txQueue, PROGRAM_ID);
      shardManager.start().catch(e => console.error('⚠️  Shard manager error:', e.message?.slice(0, 100)));
    }, 8000);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

// ── Health ──
app.get('/health', async (req, res) => {
  await refreshOracle();
  const walletInfo = keypair ? {
    address: keypair.publicKey.toBase58(),
    balance: await connection.getBalance(keypair.publicKey).then(b => (b / 1e9).toFixed(4)),
  } : null;
  res.json({
    status: 'ok',
    deployment: DEPLOYMENT_FILE,
    network: deployment.network,
    programId:       PROGRAM_ID || null,
    routerProgramId: ROUTER_PROGRAM_ID || null,
    oraclePrices,
    wallet: walletInfo,
    arbitrageBot: arbitrageBot ? { running: arbitrageBot.isRunning, stats: arbitrageBot.stats } : { enabled: false },
    shardManager: shardManager ? { running: shardManager.isRunning } : { enabled: false },
    txQueue: txQueue?.getStats() || null,
  });
});

// ── Tokens ──
app.get('/tokens', async (req, res) => {
  await refreshOracle();
  res.json({ tokens: Object.entries(deployment.tokens).map(([sym, d]) => ({
    symbol: sym, mint: d.mint, decimals: d.decimals,
    price: oraclePrices[sym] || d.price,
  })) });
});

// ── All pools ──
app.get('/pools', async (req, res) => {
  try {
    if (!PROGRAM_ID) return res.json({ pools: [], note: 'Program not deployed yet' });
    await refreshOracle();
    const pools = [];
    for (const [pair, shards] of Object.entries(deployment.pools)) {
      if (!shards.length) continue;
      const sd = await Promise.all(shards.map(async (s) => {
        try {
          const pd = await getPoolData(s.address);
          const liq = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1)
                    + parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
          return { name: s.name, address: s.address, mintA: pd.mintA, mintB: pd.mintB,
            tokenA: pd.tokenA, tokenB: pd.tokenB,
            reserveA: pd.reserveA, reserveB: pd.reserveB,
            liquidityUSD: Math.round(liq) };
        } catch (e) {
          return { name: s.name, address: s.address, error: e.message?.slice(0, 60) };
        }
      }));
      pools.push({ pair, shards: sd, totalLiquidityUSD: sd.reduce((a, b) => a + (b.liquidityUSD || 0), 0) });
    }
    res.json({ pools, totalPairs: pools.length, totalShards: pools.reduce((a, p) => a + p.shards.length, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pools for pair ──
app.get('/pools/:tokenA/:tokenB', async (req, res) => {
  try {
    const { tokenA, tokenB } = req.params;
    const shards = adapter.getPoolsForPair(tokenA, tokenB);
    if (!shards.length) return res.status(404).json({ error: 'Pair not found or no pools deployed', pairs: Object.keys(deployment.pools) });
    await refreshOracle();
    const sd = await Promise.all(shards.map(async (s) => {
      const pd = await getPoolData(s.address);
      const liq = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1)
                + parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
      return { name: s.name, address: s.address, tokenA: pd.tokenA, tokenB: pd.tokenB,
        reserveA: pd.reserveA, reserveB: pd.reserveB, liquidityUSD: Math.round(liq) };
    }));
    res.json({ pair: `${tokenA}-${tokenB}`, shards: sd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /quote/:tokenIn/:tokenOut/:amountOut  (also POST /quote) ─────────────
// Returns detailed routing quote: best shard, fees, slippage, multi-hop path.
async function buildQuoteResponse(tokenIn, tokenOut, amountOut) {
  if (!RUST_BINARY_AVAILABLE) throw new Error('Rust binary not built — run: npm run rust:build');
  const tIn  = deployment.tokens[tokenIn];
  const tOut = deployment.tokens[tokenOut];
  if (!tIn || !tOut) throw Object.assign(new Error('Invalid token'), { status: 400 });

  await refreshOracle();
  const rawOut = parseUnits(amountOut, tOut.decimals);
  const q      = await router.routeQuote(rawOut, tokenIn, tokenOut);

  const amtIn  = parseFloat(formatUnits(q.amountIn, tIn.decimals));
  const amtOut = parseFloat(amountOut);
  const rate   = amtOut / amtIn;
  const pxIn   = oraclePrices[tokenIn]  || tIn.price  || 1;
  const pxOut  = oraclePrices[tokenOut] || tOut.price || 1;
  const oracle = pxIn / pxOut;
  const slip   = oracle > 0 ? ((rate - oracle) / oracle) * 100 : 0;

  const totalFeeRaw = q.hopDetails.reduce((a, h) => a + Number(h.tradeFee), 0);
  const totalFee    = parseFloat(formatUnits(BigInt(Math.ceil(totalFeeRaw)), tIn.decimals));

  return {
    tokenIn, tokenOut,
    amountOut:        amtOut.toString(),
    amountIn:         amtIn.toFixed(8),
    amountInUSD:      (amtIn  * pxIn).toFixed(2),
    amountOutUSD:     (amtOut * pxOut).toFixed(2),
    effectiveRate:    rate.toFixed(8),
    rateDescription:  `1 ${tokenOut} = ${(1/rate).toFixed(8)} ${tokenIn}`,
    oracleRate:       oracle.toFixed(8),
    slippagePct:      slip.toFixed(4),
    totalFee:         totalFee.toFixed(8),
    totalFeeUSD:      (totalFee * pxIn).toFixed(4),
    totalFeeBps:      q.totalFeeBps,
    priceImpactPct:   q.priceImpactPct,
    routePath:        q.path,
    hops:             q.hopDetails.length,
    hopDetails:       q.hopDetails.map(h => ({
      hop:            h.hop,
      tokenIn:        h.tokenIn,
      tokenOut:       h.tokenOut,
      amountIn:       formatUnits(BigInt(h.amountIn), deployment.tokens[h.tokenIn]?.decimals || 6),
      amountOut:      formatUnits(BigInt(h.amountOut), deployment.tokens[h.tokenOut]?.decimals || 6),
      feeBps:         h.feeBps,
      strategy:       h.strategy,
      shardsUsed:     h.shardCount,
      priceImpactPct: h.priceImpactPct,
      legs:           h.legs.map(l => ({
        shard:     l.shard,
        amountIn:  formatUnits(BigInt(l.amountIn), deployment.tokens[h.tokenIn]?.decimals || 6),
        amountOut: formatUnits(BigInt(l.amountOut), deployment.tokens[h.tokenOut]?.decimals || 6),
      })),
    })),
    oraclePrices: { [tokenIn]: pxIn, [tokenOut]: pxOut },
  };
}

app.get('/quote/:tokenIn/:tokenOut/:amountOut', async (req, res) => {
  try {
    const r = await buildQuoteResponse(req.params.tokenIn, req.params.tokenOut, req.params.amountOut);
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/quote', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountOut } = req.body;
    if (!amountOut) return res.status(400).json({ error: 'Missing: amountOut' });
    const r = await buildQuoteResponse(tokenIn, tokenOut, amountOut);
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── POST /swap — execute via on-chain atomic router ───────────────────────────
app.post('/swap', async (req, res) => {
  if (!keypair) return res.status(400).json({ error: 'No wallet — read-only mode' });
  if (!PROGRAM_ID) return res.status(503).json({ error: 'SAMM program not deployed' });
  if (!ROUTER_PROGRAM_ID) return res.status(503).json({ error: 'Router program not deployed — set routerProgramId in deployment JSON' });
  try {
    const { tokenIn, tokenOut, amountOut, slippagePct = '1.0' } = req.body;
    if (!amountOut) return res.status(400).json({ error: 'Missing: amountOut' });
    const tIn  = deployment.tokens[tokenIn];
    const tOut = deployment.tokens[tokenOut];
    if (!tIn || !tOut) return res.status(400).json({ error: 'Invalid token' });

    const rawOut      = parseUnits(amountOut, tOut.decimals);
    const slippageBps = BigInt(Math.round(parseFloat(slippagePct) * 100));

    // Off-chain quote for metadata (fee bps, priceImpact, shard count).
    const quote = await router.routeQuote(rawOut, tokenIn, tokenOut);

    // Compute maxAmountIn using oracle prices — critical for cross-decimal pairs
    // (e.g. USDC→WETH) where the JS router may mis-estimate direction.
    // We use: oracleIn × (1 + slippage + 5% oracle uncertainty buffer).
    await refreshOracle();
    const tInPrice  = oraclePrices[tokenIn]  || tIn.price  || 1;
    const tOutPrice = oraclePrices[tokenOut] || tOut.price || 1;
    const amtOutHuman   = parseFloat(amountOut);
    const oracleInHuman = amtOutHuman * (tOutPrice / tInPrice);
    const bufferBps     = slippageBps + 500n;   // slippage + 5% oracle buffer
    const oracleInRaw   = parseUnits(
      oracleInHuman.toFixed(tIn.decimals),
      tIn.decimals,
    );
    const maxAmountIn = oracleInRaw * (10000n + bufferBps) / 10000n + 1n;

    // On-chain execution: router program reads live reserves, selects best shard,
    // enforces c-Non-Splitting and Smaller-Better, issues CPI atomically.
    const { sig, routePath, hops: routeHops } = await routerSwap({
      connection,
      keypair,
      routerProgramId: ROUTER_PROGRAM_ID,
      sammProgramId:   PROGRAM_ID,
      deployment,
      tokenInSym:   tokenIn,
      tokenOutSym:  tokenOut,
      amountOut:    rawOut,
      slippageBps,
      maxAmountIn,
    });

    res.json({
      success:        true,
      txHash:         sig,
      tokenIn,        tokenOut, amountOut,
      amountIn:       formatUnits(quote.amountIn, tIn.decimals),
      routePath,
      hops:           routeHops,
      routing:        'on-chain',
      strategy:       quote.hopDetails.map(h => h.strategy).join('+'),
      shardsUsed:     quote.hopDetails.reduce((a, h) => a + h.shardCount, 0),
      feeBps:         quote.totalFeeBps,
      priceImpactPct: quote.priceImpactPct,
      explorer:       `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /price/:tokenA/:tokenB ────────────────────────────────────────────────
app.get('/price/:tokenA/:tokenB', async (req, res) => {
  try {
    const { tokenA, tokenB } = req.params;
    const tA = deployment.tokens[tokenA];
    const tB = deployment.tokens[tokenB];
    if (!tA || !tB) return res.status(400).json({ error: 'Invalid token' });
    await refreshOracle();

    // Use the router to quote 1 unit of tokenB
    const rawOut = parseUnits('1', tB.decimals);
    const q = await router.routeQuote(rawOut, tokenA, tokenB);
    const price  = parseFloat(formatUnits(q.amountIn, tA.decimals));
    // oracle = "how much tokenA per 1 tokenB" = tokenB_usd / tokenA_usd
    const oracle = (oraclePrices[tokenB] || tB.price || 1) / (oraclePrices[tokenA] || tA.price || 1);
    const deviation = oracle > 0 ? ((price - oracle) / oracle) * 100 : 0;

    res.json({
      pair:         `${tokenA}/${tokenB}`,
      price:        price.toFixed(8),
      description:  `1 ${tokenB} = ${price.toFixed(8)} ${tokenA}`,
      oracleRate:   oracle.toFixed(8),
      deviationPct: deviation.toFixed(4),
      routePath:    q.path,
      feeBps:       q.totalFeeBps,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Balances ──
app.get('/balance/:address/:token', async (req, res) => {
  try {
    const { address, token } = req.params;
    const t = deployment.tokens[token];
    if (!t) return res.status(400).json({ error: 'Invalid token' });

    const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
    const { PublicKey } = require('@solana/web3.js');
    const { getTokenBalance } = require('./solana-client');

    const userPk = new PublicKey(address);
    const mintPk = new PublicKey(t.mint);
    const ata = getAssociatedTokenAddressSync(mintPk, userPk);
    const bal = await getTokenBalance(connection, ata);

    res.json({ address, token, balance: formatUnits(bal.amount, t.decimals), balanceRaw: bal.amount.toString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/balances/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
    const { PublicKey } = require('@solana/web3.js');
    const { getTokenBalance } = require('./solana-client');

    const userPk = new PublicKey(address);
    const bals = {};
    for (const [sym, t] of Object.entries(deployment.tokens)) {
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(t.mint), userPk);
        const b   = await getTokenBalance(connection, ata);
        bals[sym] = { balance: formatUnits(b.amount, t.decimals), balanceRaw: b.amount.toString(), decimals: t.decimals, mint: t.mint };
      } catch { bals[sym] = { balance: '0', balanceRaw: '0', decimals: t.decimals, mint: t.mint }; }
    }
    res.json({ address, balances: bals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ──
app.get('/stats', async (req, res) => {
  try {
    await refreshOracle();
    let totalLiq = 0;
    const pairStats = {};
    for (const [pair, shards] of Object.entries(deployment.pools)) {
      let pairLiq = 0;
      for (const s of shards) {
        try {
          const pd = await getPoolData(s.address);
          const l  = parseFloat(pd.reserveA) * (oraclePrices[pd.tokenA] || 1)
                   + parseFloat(pd.reserveB) * (oraclePrices[pd.tokenB] || 1);
          pairLiq += l;
        } catch { /* skip */ }
      }
      totalLiq += pairLiq;
      pairStats[pair] = { shards: shards.length, liquidityUSD: Math.round(pairLiq) };
    }
    res.json({
      network: deployment.network,
      programId: PROGRAM_ID || null,
      totalPairs: Object.keys(deployment.pools).length,
      totalShards: Object.values(deployment.pools).reduce((s, a) => s + a.length, 0),
      totalLiquidityUSD: Math.round(totalLiq),
      pairs: pairStats, tokens: Object.keys(deployment.tokens).length, oraclePrices,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Arbitrage Bot ──
app.get('/arbitrage/status', (req, res) => {
  if (!arbitrageBot) return res.json({ enabled: false });
  res.json(arbitrageBot.getStatus());
});

app.get('/arbitrage/history', (req, res) => {
  if (!arbitrageBot) return res.json({ enabled: false, history: [] });
  const limit  = parseInt(req.query.limit || '50');
  const pair   = req.query.pair || undefined;
  const status = req.query.status || undefined;
  res.json({ history: arbitrageBot.getHistory(limit, { pair, status }) });
});

app.post('/arbitrage/start', async (req, res) => {
  if (!keypair) return res.status(400).json({ error: 'No SOLANA_PRIVATE_KEY' });
  if (!PROGRAM_ID) return res.status(503).json({ error: 'Program not deployed yet' });
  if (!arbitrageBot) {
    arbitrageBot = new ArbitrageBot(DEPLOYMENT_FILE, keypair, connection, txQueue, PROGRAM_ID);
  }
  try { await arbitrageBot.start(); res.json({ success: true, status: arbitrageBot.getStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/arbitrage/stop', (req, res) => {
  if (!arbitrageBot) return res.status(400).json({ error: 'Not initialized' });
  arbitrageBot.stop();
  res.json({ success: true, status: arbitrageBot.getStatus() });
});

// ── Dynamic Shard Manager ──
app.get('/sharding/status', (req, res) => {
  if (!shardManager) return res.json({ enabled: false });
  res.json(shardManager.getStatus());
});

app.post('/sharding/start', async (req, res) => {
  if (!keypair) return res.status(400).json({ error: 'No SOLANA_PRIVATE_KEY' });
  if (!shardManager) {
    shardManager = new DynamicShardManager(DEPLOYMENT_FILE, keypair, connection, txQueue, PROGRAM_ID);
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

// Manual deactivate/reactivate endpoints (admin)
app.post('/sharding/deactivate', (req, res) => {
  if (!shardManager) return res.status(400).json({ error: 'Not initialized' });
  const { pair, address, reason } = req.body;
  if (!pair || !address) return res.status(400).json({ error: 'pair and address required' });
  const ok = shardManager.deactivateShard(pair, address, reason || 'manual');
  res.json({ success: ok, message: ok ? `Deactivated ${address}` : 'Not found or already inactive' });
});

app.post('/sharding/reactivate', (req, res) => {
  if (!shardManager) return res.status(400).json({ error: 'Not initialized' });
  const { pair, address } = req.body;
  if (!pair || !address) return res.status(400).json({ error: 'pair and address required' });
  const ok = shardManager.reactivateShard(pair, address);
  res.json({ success: ok, message: ok ? `Reactivated ${address}` : 'Not found or already active' });
});

// ── Rust SAMM Math Verification ──
app.get('/verify-swap', (req, res) => {
  if (!RUST_BINARY_AVAILABLE) {
    return res.status(503).json({ error: 'Rust binary not built. Run: npm run rust:build' });
  }

  const { amountOut, sourceReserve, destReserve, formula } = req.query;
  if (!amountOut || !sourceReserve || !destReserve) {
    return res.status(400).json({
      error: 'Required query params: amountOut, sourceReserve, destReserve',
      example: '/verify-swap?amountOut=1000&sourceReserve=100000&destReserve=100000',
    });
  }

  const output_amount  = Number(amountOut);
  const source_reserve = Number(sourceReserve);
  const dest_reserve   = Number(destReserve);

  if ([output_amount, source_reserve, dest_reserve].some(v => !Number.isInteger(v) || v <= 0)) {
    return res.status(400).json({ error: 'amountOut, sourceReserve, destReserve must be positive integers' });
  }

  try {
    const result = { output_amount, source_reserve, dest_reserve };

    if (!formula || formula === 'samm') {
      result.rust_samm = rustCall('swap-samm', {
        output_amount, source_reserve, dest_reserve,
        trade_fee_num: 25, trade_fee_denom: 10000,
        owner_fee_num: 0,  owner_fee_denom: 1,
      });
    }
    if (!formula || formula === 'paper') {
      result.rust_paper = rustCall('swap-samm-paper', {
        output_amount, source_reserve, dest_reserve,
        owner_fee_num: 0, owner_fee_denom: 1,
      });
    }
    if (result.rust_samm && result.rust_paper) {
      result.base_swap_matches = result.rust_samm.source_amount_swapped === result.rust_paper.source_amount_swapped;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /faucet — mint test tokens to any wallet ────────────────────────────
// Body: { address: "<base58>", tokens?: { USDC: 1000, USDT: 500, ... } }
// Default amounts: 1000 USDC/USDT/DAI, 0.5 WETH (500000000 raw), 0.01 WBTC (1000000 raw)
const FAUCET_DEFAULTS = { USDC: 1000, USDT: 1000, DAI: 1000, WETH: 0.5, WBTC: 0.01 };
const FAUCET_MAX      = { USDC: 10000, USDT: 10000, DAI: 10000, WETH: 5, WBTC: 0.1 };

app.post('/faucet', async (req, res) => {
  if (!keypair) return res.status(400).json({ error: 'No wallet — faucet unavailable in read-only mode' });

  const { address, tokens: requested } = req.body;
  if (!address) return res.status(400).json({ error: 'Missing: address' });

  const {
    PublicKey, Transaction, sendAndConfirmTransaction,
  } = require('@solana/web3.js');
  const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    mintTo,
  } = require('@solana/spl-token');

  let recipient;
  try { recipient = new PublicKey(address); }
  catch { return res.status(400).json({ error: 'Invalid address' }); }

  const amounts = requested || FAUCET_DEFAULTS;
  const results = {};

  for (const [sym, humanAmt] of Object.entries(amounts)) {
    const t = deployment.tokens[sym];
    if (!t?.mint) { results[sym] = { error: 'Unknown token' }; continue; }

    const cap = FAUCET_MAX[sym] || 10000;
    const clamped = Math.min(Number(humanAmt), cap);
    const rawAmt  = BigInt(Math.round(clamped * 10 ** t.decimals));
    if (rawAmt <= 0n) { results[sym] = { error: 'Amount must be positive' }; continue; }

    try {
      const mintPk = new PublicKey(t.mint);
      const ata    = getAssociatedTokenAddressSync(mintPk, recipient);

      // Ensure ATA exists (idempotent)
      const ensureTx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, ata, recipient, mintPk),
      );
      await sendAndConfirmTransaction(connection, ensureTx, [keypair], { commitment: 'confirmed' });

      // Mint
      const sig = await mintTo(connection, keypair, mintPk, ata, keypair, rawAmt);

      results[sym] = {
        amount: clamped.toString(),
        amountRaw: rawAmt.toString(),
        ata: ata.toBase58(),
        txHash: sig,
        explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      };
    } catch (e) {
      results[sym] = { error: e.message?.slice(0, 100) };
    }
  }

  const succeeded = Object.values(results).filter(r => r.txHash).length;
  res.json({
    success: succeeded > 0,
    address,
    minted: succeeded,
    total: Object.keys(results).length,
    results,
  });
});

// ── Error handler ──
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────
initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 SAMM DEX API Server — Solana — port ${PORT}`);
    console.log(`   Network:   ${RPC_URL}`);
    console.log(`   Program:   ${PROGRAM_ID || '(not deployed)'}`);
    console.log(`\n📚 Endpoints:`);
    console.log(`   GET  /health                          — health + status`);
    console.log(`   GET  /tokens                          — tokens with prices`);
    console.log(`   GET  /pools                           — all pools with TVL`);
    console.log(`   GET  /pools/:tokenA/:tokenB           — pools for pair`);
    console.log(`   GET  /quote/:tokenIn/:tokenOut/:amt   — quick quote`);
    console.log(`   POST /quote                           — full quote (multi-hop)`);
    console.log(`   POST /swap                            — execute swap`);
    console.log(`   GET  /price/:tokenA/:tokenB           — spot price`);
    console.log(`   GET  /balance/:addr/:token            — token balance`);
    console.log(`   GET  /balances/:addr                  — all balances`);
    console.log(`   GET  /stats                           — DEX statistics`);
    console.log(`   GET  /arbitrage/status                — arb bot status`);
    console.log(`   GET  /arbitrage/history               — arb swap log`);
    console.log(`   POST /arbitrage/start|stop            — control arb bot`);
    console.log(`   GET  /sharding/status                 — shard manager status`);
    console.log(`   POST /sharding/start|stop|check       — control shard manager`);
    console.log(`   GET  /verify-swap?amountOut=&sourceReserve=&destReserve=`);
    console.log(`   POST /faucet                           — mint test tokens to any wallet`);
    if (!RUST_BINARY_AVAILABLE) {
      console.log(`\n⚠️  Rust binary not found — run: npm run rust:build`);
    }
    console.log(`\n💡 curl http://localhost:${PORT}/health\n`);
  });
}).catch(err => { console.error('Startup failed:', err); process.exit(1); });
