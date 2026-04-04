# SAMM — Sharded Automated Market Maker

A novel DEX protocol implementing **sharded liquidity pools** with dynamic fee optimisation, TPS-driven auto-scaling, and an integrated arbitrage rebalancer. Live on **RiseChain Testnet**.

---

## What Is SAMM?

Traditional AMMs force every trade — regardless of size — through one enormous pool.  
SAMM inverts this by **sharding** each token pair into multiple pools of increasing size:

| Tier | TVL Target | Best For |
|------|-----------|----------|
| Small | $250 K | Trades < $1 K |
| Medium | $1 M | Trades $1 K – $5 K |
| Large | $5 M | Trades $5 K+ |
| Dynamic | auto-scaled | Spill-over during high TPS |

The **CrossPoolRouter** automatically selects the **smallest shard** that can handle your trade.  
Smaller shards → lower fees → better rates (the **c-smaller-better** property from the SAMM litepaper).

### Fee Formula

$$
\text{fee} = \max\!\bigl(r_{\min},\; \beta_1 \cdot \tfrac{O_A}{R_A} + r_{\max}\bigr)
$$

| Parameter | Value | Meaning |
|-----------|-------|---------|
| β₁ | −250 000 | Steep fee curve slope |
| rₘᵢₙ | 100 (0.01%) | Floor fee rate |
| rₘₐₓ | 2 500 (0.25%) | Ceiling fee rate |
| c | 9 600 (0.96%) | Shard eligibility threshold |

---

## Architecture

```
                          ┌──────────────────────┐
                          │  api-server.js (REST) │  ← port 3000
                          └──────┬───────────────┘
                    ┌────────────┼────────────────┐
                    ▼            ▼                ▼
          arbitrage-bot.js  dynamic-shard-     tx-queue.js
          (rebalancer)      manager.js         (nonce serialiser)
                │            (TPS scaler)          │
                │                │                 │
     ┌──────────┴───┐    ┌──────┴───────┐         │
     │ Chainlink    │    │ CRE Workflow │         │
     │ AggregatorV3 │    │ (workflow.ts)│         │
     │ (Sepolia)    │    │  Chainlink   │         │
     └──────────────┘    │  DON sim    │         │
                         └──────────────┘         │
                    └────────────┼────────────────┘
                                 ▼
          ┌──────────────────────────────────────────┐
          │   RiseChain Testnet (Solidity contracts)  │
          └──────────────────────────────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
   CrossPoolRouter  SAMMPool-    SAMMAgent-     Uniswap
                    Factory      Registry      Trading API
                         │                     (Sepolia)
                         ▼
                   SAMMPool shards (22 live pools)
```

### On-Chain Contracts

| Contract | Purpose |
|----------|---------|
| **SAMMPool** | Individual liquidity shard with SAMM curve |
| **SAMMPoolFactory** | Creates & indexes shards per pair |
| **CrossPoolRouter** | Multi-hop swaps with auto shard selection |
| **DynamicShardOrchestrator** | On-chain shard creation (called by backend) |
| **SAMMCurve / SAMMFees** | Pure-math libraries for pricing |
| **TokenFaucet** | Testnet token dispenser |

### Off-Chain Backend

| Module | Purpose |
|--------|---------|
| **api-server.js** | Express REST API — auto-discovers deployment, starts subsystems |
| **arbitrage-bot.js** | Monitors every shard for oracle deviation, rebalances with 50% gap closure |
| **dynamic-shard-manager.js** | Reads TPS, applies litepaper §6 formula: n = min(⌈TPS/50⌉, 10) |
| **tx-queue.js** | Serialises all wallet transactions to prevent nonce collisions |

---

## Security Model

> **The backend wallet sends transactions.** The arb bot and shard manager use a single `PRIVATE_KEY` to sign rebalancing swaps and create new shards. This is by design.

| Component | Sends Txs? | Why |
|-----------|-----------|-----|
| Arb Bot | ✅ | Rebalances shard reserves toward oracle price |
| Shard Manager | ✅ | Creates new shards when TPS exceeds capacity |
| `POST /swap` | ✅ | Executes user-requested swaps via the backend wallet |
| `GET /quote` | ❌ | Read-only — calls `calculateSwapSAMM()` view function |
| All GET endpoints | ❌ | Read-only on-chain queries |

### What's Protected

- **`.env` is gitignored** — the private key never enters the repo.
- **Railway deployment** injects `PRIVATE_KEY` and `RISECHAIN_RPC_URL` as environment variables via the dashboard.
- The `POST /swap`, `POST /arbitrage/*`, and `POST /sharding/*` endpoints require the wallet to be initialised (i.e. `PRIVATE_KEY` must be set in the environment). Without it, the server runs in **read-only mode** — all GET and quote endpoints still work.

### Public Repo Considerations

Since this repo is public:

1. **Never commit `.env`** — it is already in `.gitignore`.
2. The deployment data in `deployment-data/` contains only **contract addresses** (public on-chain data).
3. Anyone can call the API, but the `POST /swap` endpoint spends **the server's own tokens** (testnet faucet tokens with zero real-world value).
4. The arb bot and shard manager run server-side only — the server wallet holds only testnet tokens minted by the faucet.

---

## Live Deployment (RiseChain Testnet)

**Chain ID:** 11155931  
**RPC:** `https://testnet.riselabs.xyz/http`

### Core Contracts

| Contract | Address |
|----------|---------|
| SAMMPoolFactory | `0xc4c6ceABeBBfA1Bf9D219fE80F5b95982664fb94` |
| CrossPoolRouter | `0x6A45347a8DbC629000F725c544D695209b0c3d00` |
| DynamicShardOrchestrator | `0x93174f86F57A97827680c279e07704AbE2a0b0c0` |
| TokenFaucet | `0x42a930BF9259cE3D9e76bb1d8C61b52daf68dBE4` |

### Tokens

| Token | Address | Decimals |
|-------|---------|----------|
| WETH | `0x0234367975aCbcBe49867dD36bf37C7d05C2E743` | 18 |
| USDC | `0x1B40c25A7cDF5b11c67dc956d6b63EEaE1C349B0` | 6 |
| USDT | `0xa95558713D7E6D3F41bC70E867323A84404586f9` | 6 |
| WBTC | `0xD35648Ad048e450aFd22f3421cE6A5EFFC40DC4D` | 8 |
| DAI | `0x51A046A489da585eB5875845FdC7323c0f1F0606` | 18 |

### Liquidity Shards — 22 pools, ~$42.7M TVL

| Pair | Shards | Combined TVL |
|------|--------|-------------|
| WETH-USDC | Small, Medium, Large, Dynamic | ~$6.60M |
| USDC-USDT | Small, Medium, Large, Dynamic | ~$6.50M |
| WETH-USDT | Small, Medium, Large, Dynamic | ~$6.60M |
| WBTC-USDC | Small, Medium, Large, Dynamic | ~$6.56M |
| USDC-DAI  | Small, Medium, Large, Dynamic | ~$6.50M |

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- npm

### Install

```bash
git clone <repo-url>
cd samm-evm
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env — set PRIVATE_KEY and RISECHAIN_RPC_URL
```

### Compile Contracts

```bash
npx hardhat compile
```

### Run Tests

```bash
npx hardhat test                     # all Hardhat tests
npx hardhat test test/unit/          # unit tests only
npm run test:swap-matrix             # on-chain swap matrix (requires RiseChain)
```

### Deploy (fresh)

```bash
npm run deploy:risechain             # full production deploy
npm run deploy:faucet                # token faucet
npm run deploy:router                # router only
```

### Start the API Server

```bash
npm start
```

The server auto-discovers the latest `production-risechain-*.json` file in `deployment-data/`, starts the arb bot and shard manager, and listens on the configured port.

### Verify All APIs

```bash
npm run verify:apis
```

Runs 42 read-only tests against every endpoint (no swaps executed).

---

## REST API Reference

Base URL: `http://localhost:3000`

### Read-Only Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health + deployment info |
| `GET` | `/tokens` | All tokens with CoinGecko prices |
| `GET` | `/pools` | All pairs with shards and TVL |
| `GET` | `/pools/:tokenA/:tokenB` | Shards for a specific pair |
| `GET` | `/shards/:tokenA/:tokenB` | Shard details direct from chain |
| `GET` | `/quote/:tokenIn/:tokenOut/:amount` | Single-hop quote (fee, slippage, shard) |
| `POST` | `/quote` | Multi-hop quote (body: `{ route, amountOut }`) |
| `GET` | `/price/:tokenA/:tokenB` | Spot price + oracle deviation |
| `GET` | `/balance/:address/:token` | Token balance |
| `GET` | `/balances/:address` | All token balances for address |
| `GET` | `/stats` | DEX-wide stats (TVL, pair count, shard names) |
| `GET` | `/arbitrage/status` | Arb bot running status |
| `GET` | `/arbitrage/history` | Recent arb swap log |
| `GET` | `/sharding/status` | Shard manager status + TPS readings |
| `GET` | `/compare/:in/:out/:amt` | SAMM vs Uniswap rate comparison |
| `GET` | `/compare/matrix` | Full comparison matrix (all pairs × trade sizes) |
| `GET` | `/oracle/chainlink` | Chainlink vs CoinGecko vs spot prices |
| `GET` | `/oracle/status` | Oracle system status |
| `GET` | `/agents` | ENS-discoverable SAMM agents |
| `GET` | `/agents/:name` | Agent identity + text records |
| `GET` | `/registry/shards` | ENS shard registry |

### Write Endpoints (require `PRIVATE_KEY`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/swap` | Execute swap (server wallet signs tx) |
| `POST` | `/arbitrage/start` | Start arb bot |
| `POST` | `/arbitrage/stop` | Stop arb bot |
| `POST` | `/sharding/start` | Start shard manager |
| `POST` | `/sharding/stop` | Stop shard manager |
| `POST` | `/sharding/check` | Trigger immediate shard check |
| `POST` | `/sharding/cre-simulate` | CRE shard decisions with live Chainlink feeds |
| `POST` | `/swap/sepolia` | Execute Uniswap swap on Sepolia (backend-signed) |
| `POST` | `/swap/sepolia/prepare` | Get Permit2 signature data for user wallet |
| `POST` | `/swap/sepolia/execute` | Get unsigned calldata for user wallet |

### Example Queries

```bash
# Quick quote — buy 100 USDC with WETH
curl http://localhost:3000/quote/WETH/USDC/100

# Multi-hop quote — WETH → USDC → USDT
curl -X POST http://localhost:3000/quote \
  -H "Content-Type: application/json" \
  -d '{"route":["WETH","USDC","USDT"],"amountOut":"500"}'

# Spot price
curl http://localhost:3000/price/WETH/USDC

# DEX stats
curl http://localhost:3000/stats
```

---

## Deployment to Railway

The repo includes `railway.json` and `nixpacks.toml` for one-click Railway deployment.

Set these environment variables in Railway's dashboard:

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Wallet private key (no `0x` prefix) |
| `RISECHAIN_RPC_URL` | Yes | RiseChain RPC endpoint |
| `PORT` | No | Defaults to 3000 |
| `ENABLE_ARBITRAGE` | No | `true` to auto-start arb bot |
| `ENABLE_DYNAMIC_SHARDING` | No | `true` to auto-start shard manager |
| `UNISWAP_API_KEY` | No | Uniswap Trading API key (enables /compare) |
| `SEPOLIA_RPC_URL` | No | Sepolia RPC for Chainlink feeds |
| `ENS_REGISTRY_ADDRESS` | No | Deployed SAMMAgentRegistry address |

---

## Project Structure

```
samm-evm/
├── contracts/                             # Solidity source
│   ├── SAMMPool.sol                       #   Liquidity pool shard
│   ├── SAMMPoolFactory.sol                #   Factory for creating shards
│   ├── CrossPoolRouter.sol                #   Multi-hop swap router
│   ├── DynamicShardOrchestrator.sol       #   On-chain shard creator
│   ├── SAMMAgentRegistry.sol              #   ENS agent identity registry
│   ├── TokenFaucet.sol                    #   Testnet faucet
│   ├── interfaces/                        #   ISAMMPool, ISAMMPoolFactory, ICrossPoolRouter, IChainlinkAggregator
│   └── libraries/                         #   SAMMCurve.sol, SAMMFees.sol
├── integrations/                          # External protocol integrations
│   ├── uniswap-client.js                 #   Uniswap comparison wrapper
│   ├── uniswap-sepolia-swap.js           #   Uniswap Trading API (swap execution)
│   ├── chainlink-price.js                #   Chainlink AggregatorV3 oracle reader
│   ├── ens-agent-registry.js             #   ENS agent identity manager
│   ├── risechain-bridge.js               #   OP Stack canonical bridge
│   └── chainlink-cre-workflow/           #   CRE SDK workflow spec
│       ├── my-workflow/
│       │   ├── workflow.ts               #     CRE workflow (396 lines)
│       │   ├── main.ts                   #     Entry point
│       │   ├── config.json               #     Feed addresses, thresholds
│       │   └── workflow.yaml             #     CRE project config
│       ├── project.yaml                  #     RPC configuration
│       ├── package.json                  #     CRE SDK dependencies
│       └── README.md                     #     Setup instructions
├── api-server.js                          # REST API server (Express)
├── arbitrage-bot.js                       # Oracle-deviation rebalancer (Chainlink-first)
├── dynamic-shard-manager.js               # TPS-driven shard scaler
├── tx-queue.js                            # Nonce-safe tx serialiser
├── hardhat.config.js                      # Hardhat configuration
├── package.json                           # Dependencies & npm scripts
├── railway.json                           # Railway deployment config
├── nixpacks.toml                          # Nixpacks build config
├── .env.example                           # Environment variable template
├── config/                                # Chain configs (chains.json)
├── deployment-data/                       # Contract addresses (auto-generated)
├── scripts/
│   ├── deploy-production-risechain.js     # Full production deploy
│   ├── deploy-production-risechain-v2.js  # V2 deploy variant
│   ├── deploy-crosspool-router-risechain.js
│   ├── deploy-faucet-risechain.js
│   ├── validate-risechain-swap-matrix.js  # On-chain swap matrix test
│   ├── comprehensive-e2e-test-risechain.js
│   ├── comprehensive-swap-analysis.js     # Detailed swap analysis
│   ├── verify-all-apis.js                 # 42-test API verification
│   ├── bench-batched.js                   # Batched RPC TPS benchmark
│   ├── bench-sustained-tps.js             # Sustained TPS benchmark
│   ├── tps-load-test.js                   # TPS load generator
│   └── initialize-empty-pools.js          # Pool init utility
├── test/                                  # Hardhat / Mocha tests
│   ├── unit/                              #   Unit tests
│   ├── offchain/                          #   Off-chain math verification
│   ├── *.property.test.js                 #   Property-based tests (fast-check)
│   └── *.test.js                          #   Integration tests
├── test-results/                          # Benchmark outputs (gitignored)
└── Research.md                            # SAMM litepaper & research notes
```

---

## Integrations

SAMM extends the core protocol with three purpose-built integrations.

### 🦄 Uniswap — Trading API Integration

SAMM uses the **Uniswap Trading API** (`trade-api.gateway.uniswap.org/v1`) to:
1. **Quote comparison** — every SAMM quote is compared against a live Uniswap quote for the same trade
2. **Real swap execution** — `POST /swap/sepolia` calls `/v1/quote` + `/v1/order` to execute on-chain swaps on Sepolia via Universal Router + Permit2
3. **Frontend-compatible flow** — `POST /swap/sepolia/prepare` returns Permit2 data for MetaMask; `POST /swap/sepolia/execute` returns unsigned calldata

**On-chain proof (Sepolia testnet):**

| Tx Hash | Action |
|---------|--------|
| [`0x126fa86b...`](https://sepolia.etherscan.io/tx/0x126fa86beb07c6dca2114fd7d15c60fe4b998ebaf106038380452d488ad53f95) | Uniswap swap via Trading API (ETH → USDC) |
| [`0xf543df01...`](https://sepolia.etherscan.io/tx/0xf543df013d72e21dd4f233d68687bb1b3ef6ed6b105eea1832b881dc8da934b8) | Uniswap swap via Trading API (ETH → USDC) |
| [`0xa80ab036...`](https://sepolia.etherscan.io/tx/0xa80ab036e4e93cefc405) | Uniswap swap via Trading API (ETH → USDC) |
| [`0xbfaa4472...`](https://sepolia.etherscan.io/tx/0xbfaa4472c32edeae6a6d008173a95e7376378da75c87e581d3b57b4dca8661a5) | Bridge deposit (Sepolia → RiseChain, 0.001 ETH) |

| Endpoint | Description |
|----------|-------------|
| `GET /compare/:in/:out/:amt` | SAMM vs Uniswap quote comparison |
| `GET /compare/matrix` | Full comparison across all pairs × trade sizes |
| `POST /swap/sepolia` | Execute Uniswap swap (backend-signed) |
| `POST /swap/sepolia/prepare` | Step 1: Get Permit2 signature data for MetaMask |
| `POST /swap/sepolia/execute` | Step 2: Get unsigned calldata for user wallet |

**Module:** `integrations/uniswap-sepolia-swap.js` — full Trading API integration with Permit2, Universal Router, symbol resolution, and frontend-compatible flow.

### 🔗 Chainlink — CRE Workflow + Decentralized Oracle

**CRE Workflow:** The shard management logic is implemented as a Chainlink CRE workflow (`integrations/chainlink-cre-workflow/my-workflow/workflow.ts`) that runs on a Chainlink DON. Every 60 seconds it:

1. **Reads Chainlink price feeds** on Sepolia (ETH/USD, BTC/USD, USDC/USD, DAI/USD) using `EVMClient.callContract`
2. **Fetches SAMM pool data** via HTTP (reserves, TPS, shard counts)
3. **Computes shard decisions** — split at 250 TPS, merge at 62.5 TPS, always protect 3 original shards
4. **Detects arbitrage** from Chainlink vs spot price deviation

**CRE CLI Simulation (verified ✅):**
```bash
cd integrations/chainlink-cre-workflow
cre workflow simulate my-workflow --non-interactive --trigger-index 0
```

Output:
```
✓ Workflow compiled
📊 Price feed | ETH/USD = $2056.84
📊 Price feed | BTC/USD = $66997.67
📊 Price feed | USDC/USD = $1.00
📊 Price feed | DAI/USD = $1.00
✅ Fetched SAMM data: 5 pairs
🧠 Step 3: Dynamic Shard Analysis (per-pair, original 🔒 vs dynamic ⚡)
🔗 MERGE WETH-USDC: 4 → 3 shards — 3 original shards protected
🔗 MERGE USDC-USDT: 4 → 3 shards — 3 original shards protected
🔗 MERGE WETH-USDT: 5 → 3 shards — 3 original shards protected
🔗 MERGE WBTC-USDC: 5 → 3 shards — 3 original shards protected
🔗 MERGE USDC-DAI: 4 → 3 shards — 3 original shards protected
⚡ Step 5: ChainWrite — 5 mergeShards() calls encoded for DynamicShardOrchestrator
Decisions: 0 splits, 5 merges, 0 rebalances | ChainWrites: 5 pending
✓ Workflow Simulation Result: {...}
╭──────────────────────────────────────────────────────╮
│ Simulation complete! Ready to deploy your workflow?  │
╰──────────────────────────────────────────────────────╯
```

**Chainlink → On-chain state change:** The arb bot (`arbitrage-bot.js`) reads Chainlink AggregatorV3 price feeds on Sepolia in `fetchRealPrices()`. When oracle price deviates >0.3% from any shard's spot price, it executes a corrective `swapSAMM()` transaction on RiseChain — making an **on-chain state change driven by Chainlink data**.

| Endpoint | Description |
|----------|-------------|
| `GET /oracle/chainlink` | Chainlink vs CoinGecko vs spot prices |
| `POST /sharding/cre-simulate` | Run CRE shard decisions with live Chainlink feeds |

**Modules:**
- `integrations/chainlink-price.js` — ChainlinkPriceOracle reading 5 feeds from Sepolia AggregatorV3
- `integrations/chainlink-cre-workflow/` — CRE SDK workflow (396 lines) with `CronCapability`, `EVMClient`, `HTTPClient`, `ConsensusAggregationByFields`
- `contracts/interfaces/IChainlinkAggregator.sol` — on-chain AggregatorV3Interface

### 🏷️ ENS — AI Agent Identity & Shard Discovery

SAMM has **5 autonomous agents** registered on-chain with ENS-style identities:

| Agent | ENS Name | Address | Role |
|-------|----------|---------|------|
| Pool Router | `pool-router.samm.eth` | `0x6A45...3d00` | Trade routing |
| Arb Bot | `arb-bot.samm.eth` | `0x0045...A589` | Price rebalancing |
| Shard Manager | `shard-manager.samm.eth` | `0x0045...A589` | Dynamic sharding |
| Token Faucet | `faucet.samm.eth` | `0x42a9...dBE4` | Token distribution |
| Pool Factory | `factory.samm.eth` | `0xc4c6...fb94` | Pool creation |

**On-chain registry:** `SAMMAgentRegistry` at `0xCa46f85973d0f13377744fBE8D26ABBdc93a241B` on RiseChain.

**ENS solves 4 real problems:**

1. **Agent Discovery** — resolve `arb-bot.samm.eth` → wallet address (no deployment logs needed)
2. **Agent Transparency** — text records expose live config (`com.samm.min-deviation`, `com.samm.total-swaps`, `com.samm.oracle-source`) as verifiable on-chain reputation
3. **Shard Registry** — 42 shards registered with subnames: `small.weth-usdc.samm.eth` → contract address
4. **Human-readable API** — `GET /balance/vitalik.eth/WETH` works alongside raw addresses

**No hard-coded values:** Agents and shards are registered on-chain via `registerOrUpdateAgent()` and `registerOrUpdateShard()` — the API reads from the on-chain registry dynamically. Agent stats (swap count, cycle count, volume) are updated on-chain in real-time via `setBatchAgentTextRecords()`.

| Endpoint | Description |
|----------|-------------|
| `GET /agents` | List all ENS-discoverable agents (reads from on-chain registry) |
| `GET /agents/:name` | Agent identity + text records + ENS resolution |
| `GET /registry/shards` | ENS shard registry (42 shards with subnames) |

**Modules:**
- `contracts/SAMMAgentRegistry.sol` — on-chain registry with batch text record support
- `integrations/ens-agent-registry.js` — dual-mode (local + on-chain) identity manager with auto-sync

### Environment Variables

| Variable | Integration | Required | Description |
|----------|-------|----------|-------------|
| `UNISWAP_API_KEY` | Uniswap | Yes | From developers.uniswap.org |
| `SEPOLIA_RPC_URL` | Chainlink | No | For reading Chainlink feeds (disabled if absent) |
| `ENABLE_ENS` | ENS | No | Enable ENS resolution (`true` by default) |
| `ENS_RPC_URL` | ENS | No | Custom ENS provider RPC (defaults to mainnet) |
| `ENS_BASE_DOMAIN` | ENS | No | Base domain (default: `samm.eth`) |
| `ENS_REGISTRY_ADDRESS` | ENS | No | Deployed SAMMAgentRegistry address |

---

## Demo & Setup Instructions

### Quick Start (local)

```bash
git clone https://github.com/ASR-Innovations/samm-evm.git
cd samm-evm
npm install
cp .env.example .env
# Set PRIVATE_KEY, RISECHAIN_RPC_URL, UNISWAP_API_KEY, SEPOLIA_RPC_URL
npm start
```

The server auto-discovers contracts from `deployment-data/`, starts the arb bot + shard manager, and exposes all endpoints on port 3000.

### Run E2E Tests

```bash
# Read-only mode (no real txs)
node scripts/uniswap-e2e-flow.js

# Live mode (real Uniswap swaps + bridge deposits on Sepolia)
node scripts/uniswap-e2e-flow.js --live
```

### Run CRE Workflow Simulation

```bash
cd integrations/chainlink-cre-workflow
npm install
cre workflow simulate my-workflow --non-interactive --trigger-index 0
```

### On-Chain Transaction Proof

| Network | Tx Hash | Action |
|---------|---------|--------|
| Sepolia | [`0x126fa86b...`](https://sepolia.etherscan.io/tx/0x126fa86beb07c6dca2114fd7d15c60fe4b998ebaf106038380452d488ad53f95) | Uniswap swap (ETH → USDC) via Trading API |
| Sepolia | [`0xf543df01...`](https://sepolia.etherscan.io/tx/0xf543df013d72e21dd4f233d68687bb1b3ef6ed6b105eea1832b881dc8da934b8) | Uniswap swap (ETH → USDC) via Trading API |
| Sepolia | [`0xbfaa4472...`](https://sepolia.etherscan.io/tx/0xbfaa4472c32edeae6a6d008173a95e7376378da75c87e581d3b57b4dca8661a5) | Bridge deposit (0.001 ETH, Sepolia → RiseChain) |
| RiseChain | [`0xCa46f859...`](https://testnet.riselabs.xyz/address/0xCa46f85973d0f13377744fBE8D26ABBdc93a241B) | SAMMAgentRegistry (5 agents, 42 shards) |
| RiseChain | [`0xc4c6ceAB...`](https://testnet.riselabs.xyz/address/0xc4c6ceABeBBfA1Bf9D219fE80F5b95982664fb94) | SAMMPoolFactory (22 live pools) |
| RiseChain | [`0x6A45347a...`](https://testnet.riselabs.xyz/address/0x6A45347a8DbC629000F725c544D695209b0c3d00) | CrossPoolRouter |

---

## Key Concepts

### c-Smaller-Better Property

The SAMM litepaper's core insight: for a given trade size, the **smallest eligible shard always gives the best rate**. The router enforces this — it iterates shards from smallest to largest and uses the first one where the trade-to-reserve ratio stays within the c-threshold.

### TPS-Driven Dynamic Sharding (Litepaper §6)

When on-chain TPS exceeds a per-shard capacity, the shard manager creates additional shards:

```
n = min(⌈TPS / PER_SHARD_TPS⌉, MAX_SHARDS_PER_PAIR)
```

Default: 50 TPS per shard, max 10 shards per pair.

### Arbitrage Bot

Monitors every shard's spot price against decentralized Chainlink price feeds (with CoinGecko as fallback). When deviation exceeds 0.3%, it executes a corrective swap sized at 50% of the gap. A 3-cycle cooldown per shard prevents oscillation.

---

## License

MIT
