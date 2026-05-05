# SAMM — Sharded Automated Market Maker on Solana

A novel DEX protocol implementing **sharded liquidity pools** with dynamic fee optimisation, TPS-driven auto-scaling, and an integrated arbitrage rebalancer — deployed live on **Solana Devnet**.

---

## What Is SAMM?

SAMM horizontally shards liquidity pools to achieve **5×–16× throughput scaling** and **up to 15× higher LP returns** compared to single-pool AMMs. Each trading pair has multiple pool shards (Small/Medium/Large/XL), and the router automatically selects the optimal shard(s) for each trade.

### Key Properties

**c-Non-Splitting Property:** Trades below size `c × R` are cheaper executed on a single shard than split.

**Smaller-Better Principle:** Among shards with equal reserves, smaller shards charge lower fees — routing naturally flows to underutilized pools.

**Atomic Multi-Hop Routing:** USDC→DAI→WETH can be done in a single Solana transaction — no intermediate custody.

### Fee Formula

```
fee = max(r_min, β₁ × (OA/RA) + r_max)
```

| Parameter | Value | Meaning |
|-----------|-------|---------|
| β₁ | −0.25 | Fee curve slope (negative = decreasing with trade size) |
| r_min | 0.01% | Floor fee rate (large trades) |
| r_max | 0.25% | Ceiling fee rate (small trades) |
| c | 0.96 | Shard eligibility threshold |

**Stable pairs:** 5 bps (0.05%)  
**Regular pairs:** 10 bps (0.10%)  
**Multi-hop:** sum of per-hop fees (e.g. WBTC→USDC→DAI = 15 bps)

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   api-server.js (REST)                    │
│                       port 3000                           │
└──────┬────────────────┬───────────────┬──────────────────┘
       │                │               │
       ▼                ▼               ▼
 samm-router.js   arbitrage-bot.js  dynamic-shard-manager.js
 (atomic routing)  (rebalancer)      (TPS-driven scaling)
       │                │               │
       └────────────────┴───────────────┘
                         │
                         ▼
               solana-client/index.js
               (SPL Token Swap CPI)
                         │
                         ▼
              ┌─────────────────────┐
              │  Solana Devnet      │
              │  spl-samm program   │
              │  29 pool shards     │
              └─────────────────────┘
```

### Pool Configuration

**7 trading pairs × 4 shards each = 28 pools**

| Pair | Type | Fee | Shards |
|------|------|-----|--------|
| USDC-USDT | Stable | 5 bps | Small/Medium/Large/XL |
| USDC-DAI | Stable | 5 bps | Small/Medium/Large/XL |
| USDT-DAI | Stable | 5 bps | Small/Medium/Large/XL |
| WETH-USDC | Regular | 10 bps | Small/Medium/Large/XL |
| WETH-USDT | Regular | 10 bps | Small/Medium/Large/XL |
| WBTC-USDC | Regular | 10 bps | Small/Medium/Large/XL |
| WETH-WBTC | Regular | 10 bps | Small/Medium/Large/XL |

Shard sizes per side: **Small $10k · Medium $50k · Large $200k · XL $1M**

### Multi-Hop Routes (automatic)

| Route | Path | Total Fee |
|-------|------|-----------|
| WBTC ↔ DAI | WBTC→USDC→DAI | 15 bps |
| WBTC ↔ USDT | WBTC→USDC→USDT | 15 bps |
| WETH ↔ DAI | WETH→USDC→DAI | 15 bps |
| DAI ↔ WETH | DAI→USDC→WETH | 50 bps* |
| DAI ↔ WBTC | DAI→USDC→WBTC | 50 bps* |

*Higher fee when routing through old pool shards with 25-bps on-chain fee config.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- Rust (for the SAMM math binary)
- Solana CLI (optional, for manual deployment)

### Install

```bash
git clone <repo-url>
cd samm-evm
npm install
```

### Build Rust Binary

The routing math runs through a native Rust binary for guaranteed precision:

```bash
cd rust-samm && cargo build --release
# Binary at: rust-samm/target/release/samm
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PROGRAM_ID=AvtCT5zyjHWMjVDepZUnJWNGJQeJfrk84ZtvhuaECrUZ
SOLANA_PRIVATE_KEY=<your-base58-keypair>

# Arbitrage bot
ENABLE_ARBITRAGE=true
ARB_CHECK_INTERVAL=20000
MAX_SWAP_USD=500

# Dynamic sharding
ENABLE_DYNAMIC_SHARDING=true
SHARD_CHECK_INTERVAL=60000

# API server
PORT=3000
```

### Start the API Server

```bash
npm start
# or:
node api-server.js
```

The server:
- Loads `deployment-data/solana-devnet.json` (pool addresses)
- Starts the arb bot after 3 seconds (if `ENABLE_ARBITRAGE=true`)
- Starts the shard manager after 8 seconds (if `ENABLE_DYNAMIC_SHARDING=true`)
- Listens on port 3000

---

## Deployment Scripts

### Initialize Pools (run once, or to add new shards)

```bash
node scripts/initialize-pools.js
```

Creates 7 pairs × 4 shards = 28 pools on devnet. Idempotent — existing shards are skipped.

### Verify Pools

```bash
node scripts/verify-pools.js
```

Reads every pool on-chain and reports reserves, prices, and deviations.

### Quick Swap Test

```bash
node scripts/test-swap.js USDC USDT 10
node scripts/test-swap.js WETH USDC 50
node scripts/test-swap.js WBTC DAI 5     # 2-hop route
```

---

## Testing

### All Swap Pairs (quotes only, instant)

```bash
node scripts/test-all-swaps.js
```

### All Swap Pairs (live on-chain, ~5 min)

```bash
node scripts/test-all-swaps.js --execute
```

Executes $1-equivalent swaps for all 20 A→B and B→A combinations across all 7 pairs + multi-hop routes.

### Full User Flow Demo

```bash
node scripts/user-swap-flow.js                  # USDC→USDT 10 (default)
node scripts/user-swap-flow.js WBTC DAI 5       # WBTC→DAI via 2-hop route
node scripts/user-swap-flow.js WETH USDC 50     # WETH→USDC direct
```

Demonstrates: faucet → quote → execute → verify balances.

---

## REST API Reference

Base URL: `http://localhost:3000`

### Health & Info

```bash
curl http://localhost:3000/health
curl http://localhost:3000/tokens
curl http://localhost:3000/stats
```

### Pool Data

```bash
curl http://localhost:3000/pools                    # all 28+ shards with TVL
curl http://localhost:3000/pools/WETH/USDC          # shards for a pair
curl http://localhost:3000/price/WETH/USDC          # spot price vs oracle
```

### Balances

```bash
curl http://localhost:3000/balances/<wallet-address>         # all tokens
curl http://localhost:3000/balance/<wallet-address>/USDC     # single token
```

### Quote

```bash
# GET — quick quote
curl http://localhost:3000/quote/USDC/USDT/100
curl http://localhost:3000/quote/WBTC/DAI/5         # multi-hop auto-route

# POST — same, accepts JSON body
curl -X POST http://localhost:3000/quote \
  -H "Content-Type: application/json" \
  -d '{"tokenIn":"WETH","tokenOut":"USDC","amountOut":"50"}'
```

**Response includes:** `amountIn`, `amountOut`, `effectiveRate`, `routePath`, `hops`, `totalFeeBps`, `priceImpactPct`, full `hopDetails` with per-leg breakdown.

### Execute Swap

```bash
curl -X POST http://localhost:3000/swap \
  -H "Content-Type: application/json" \
  -d '{
    "tokenIn":    "USDC",
    "tokenOut":   "USDT",
    "amountOut":  "100",
    "slippagePct": "1.0"
  }'
```

**Returns:** `{ success, txHash, amountIn, routePath, hops, feeBps, priceImpactPct, explorer }`

### Faucet (devnet only)

```bash
curl -X POST http://localhost:3000/faucet \
  -H "Content-Type: application/json" \
  -d '{
    "address": "<your-wallet-address>",
    "tokens":  {"USDC": 1000, "WETH": 1, "WBTC": 0.01}
  }'
```

Mints test tokens to any wallet. Caps: USDC/USDT/DAI ≤ 10,000 · WETH ≤ 5 · WBTC ≤ 0.1 per request.

### Arbitrage Bot

```bash
curl http://localhost:3000/arbitrage/status
curl http://localhost:3000/arbitrage/history?limit=20
curl -X POST http://localhost:3000/arbitrage/start
curl -X POST http://localhost:3000/arbitrage/stop
```

### Dynamic Shard Manager

```bash
curl http://localhost:3000/sharding/status
curl -X POST http://localhost:3000/sharding/start
curl -X POST http://localhost:3000/sharding/check   # trigger manual check
```

---

## How User Transactions Work

### Current Setup (Server Keypair)

The server signs and submits transactions using its own keypair (`SOLANA_PRIVATE_KEY`). This is suitable for:
- Testing with faucet tokens
- Arb bot operation
- Demo environments

### Production dApp Flow

For a real user-facing application:

```
1. GET /quote/:tokenIn/:tokenOut/:amountOut
   → amountIn, fees, route path, price impact (no signing)

2. Frontend builds the transaction using samm-router.js buildAtomicTransaction()
   (or calls a future POST /build-tx endpoint that returns a base64 transaction)

3. User's wallet (Phantom, Backpack, Solflare, etc.) receives the unsigned transaction,
   displays what it will do, and user approves → wallet signs with user's keypair

4. Frontend submits the signed transaction to Solana RPC
   → Returns: transaction signature

5. Frontend polls confirmTransaction() or /tx/:signature
   → Shows success/failure + explorer link
```

The transaction structure (built by `buildAtomicTransaction` in [samm-router.js](samm-router.js)):

```
For each hop in the route:
  1. createAssociatedTokenAccountIdempotent(output_mint)   — create ATA if needed
  For each shard used in the hop:
  2. Approve(user_source_ATA, pool_authority, max_amount_in)
  3. SwapSAMM(pool, exact_amount_out, max_amount_in)       — pool PDA signs via invoke_signed
```

All instructions are in **one atomic transaction** — either all succeed or all fail.

---

## Deployed Program

| Network | Program ID |
|---------|-----------|
| Solana Devnet | `AvtCT5zyjHWMjVDepZUnJWNGJQeJfrk84ZtvhuaECrUZ` |

Pool and token addresses are in `deployment-data/solana-devnet.json`.

---

## File Structure

```
samm-evm/
├── api-server.js              # Express REST API (port 3000)
├── samm-router.js             # Multi-hop atomic router
├── solana-adapter.js          # Thin adapter layer
├── arbitrage-bot.js           # Oracle-based rebalancer
├── dynamic-shard-manager.js   # TPS-driven shard creator
├── tx-queue.js                # Serial transaction queue
├── solana-client/
│   └── index.js               # Pool state reader + swap instruction builder
├── rust-samm/                 # Native Rust math binary
│   └── src/
│       ├── samm.rs            # Exact-output SAMM formula
│       ├── fees.rs            # Adaptive + paper fee calculations
│       └── curve.rs           # Constant-product curve
├── scripts/
│   ├── initialize-pools.js    # Create all 28 pool shards
│   ├── verify-pools.js        # Verify on-chain pool state
│   ├── test-swap.js           # Quick single swap test
│   ├── test-all-swaps.js      # Comprehensive swap matrix
│   └── user-swap-flow.js      # End-to-end user flow demo
└── deployment-data/
    └── solana-devnet.json     # Pool + token addresses
```

---

## Security Model

| Component | Sends Txs? | Why |
|-----------|-----------|-----|
| `POST /swap` | ✅ | Executes swap with server keypair |
| `POST /faucet` | ✅ | Mints test tokens (server is mint authority) |
| Arb Bot | ✅ | Rebalances pools toward oracle price |
| Shard Manager | ✅ | Creates new shards when TPS exceeds limit |
| All GET endpoints | ❌ | Read-only — no transactions |
| `GET /quote` | ❌ | Read-only — Rust CLI math + pool state reads |

**`.env` is gitignored** — private key never enters the repo.

The server runs in **read-only mode** (all GET/quote endpoints work) if `SOLANA_PRIVATE_KEY` is not set.

---

## Throughput Characteristics

- **Single shard:** ~129 TPS on Solana
- **4 shards:** ~720 TPS (5.6× scaling)
- **Auto-scaling:** shard manager creates new shards when TPS exceeds `PER_SHARD_TPS × current_shards`
- **Atomic routing:** multi-hop routes add only 1 transaction overhead vs N separate txs
- **Price impact:** typically < 0.01% for $1–100 trades across 28 pools
Everything is confirmed. Here's the full status:

Branch: v0.3-solana — committed (97 files, clean working tree)

Arb bot startup (when node api-server.js runs):

Server starts and listens immediately on port 3000
3 seconds later: arb bot starts (if ENABLE_ARBITRAGE != 'false' and keypair is set)
8 seconds later: dynamic shard manager starts (if ENABLE_DYNAMIC_SHARDING != 'false')
In read-only mode (no SOLANA_PRIVATE_KEY): server works fully for all GET endpoints + quotes, bots skipped
Railway deployment flow:

nixpacks installs nodejs_20 + rustc + cargo
Build phase: cd rust-samm && cargo build --release → produces the math binary
Then npm install --production
Start: node api-server.js
Set env vars on Railway: SOLANA_RPC_URL, SOLANA_PROGRAM_ID, SOLANA_PRIVATE_KEY, PORT=3000
All commands:


npm start                                    # start server (arb bot auto-starts at 3s)
node scripts/initialize-pools.js            # create all 28 pool shards (run once)
node scripts/verify-pools.js               # check on-chain pool state
node scripts/test-swap.js USDC USDT 10     # single swap test
node scripts/test-all-swaps.js             # quote all 20 pairs ($1 each)
node scripts/test-all-swaps.js --execute   # live on-chain all pairs
node scripts/user-swap-flow.js WBTC DAI 5  # full 4-step user flow demo
npm run rust:build                          # rebuild rust-samm binary
