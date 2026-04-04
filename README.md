# SAMM — Sharded Automated Market Maker

A novel DEX protocol implementing **sharded liquidity pools** with dynamic fee optimisation, TPS-driven auto-scaling, and an integrated arbitrage rebalancer. Live on **RiseChain Testnet**.

---

## What Is SAMM?

SAMM: The First Dynamically Sharded AMM
By Horizontally scaling, we achieve 5x-16x throughput and upto 15x higher LP returns 

## A) LP Revenue Optimization

SAMM enhances LP returns by:

- **Fee Differentiation**: Smaller shards offer better fee incentives to LPs, driving liquidity rebalancing.
- **Increased Utilization**: During high demand, dynamic scaling ensures more trades and higher fee income.
- **Minimized Idle Capital**: In low-demand regimes, LPs consolidate in a single shard for maximum ROI.

Simulation results show:
- Up to **15× higher LP returns** vs static multi-shard AMMs under variable load
- Lower impermanent loss due to price convergence

<img width="1550" height="774" alt="image" src="https://github.com/user-attachments/assets/66437907-7efb-495e-b0ec-96c8a611c3d8" />

## B) Throughput Scaling

Testnet deployments indicate:
- Solana: 1 shard ~129 TPS → 4 shards = ~720 TPS
- Sui: 1 shard ~214 TPS → 4 shards = ~520 TPS
- Risechain: Adaptive scaling with linear performance up to 8 shards

Throughput benefits:
- **5×–16×** scaling during peak load
- **<500ms** average latency under 1000 TPS

<img width="1222" height="822" alt="image" src="https://github.com/user-attachments/assets/f310b13b-0144-4316-a9ee-06a092a571d6" />

<img width="1246" height="612" alt="image" src="https://github.com/user-attachments/assets/108b6073-25dc-4f6d-8219-9f8b29c68a1b" />

## Polynomial Fee Function

SAMM introduces a **bounded-ratio polynomial fee function** to balance liquidity across shards.

### Formula:

$$
\text{Fee}(\Delta) = \frac{R_B}{R_A} \cdot \Delta \cdot \max\left\{ r_{\min}, \min\left\{ r_{\max}, \beta_1 R_A^{\beta_2} R_B^{\beta_3} \Delta^{\beta_4} + \beta_5 \right\} \right\}
$$

Where:
- $\Delta$: amount traded
- $(R_A, R_B\)$: token reserves
- $(\beta_i)$: tunable coefficients
- $(r_{\min}$, r_{\max}\): fee ratio bounds

### Intuition:
- Larger trades → higher marginal fee
- Smaller shards → cheaper trades
- Traders are incentivized to route to underutilized shards

---

## c-Non-Splitting Property

SAMM satisfies the **c-non-splitting property**:

>A trade below size $(c \cdot R)$ is cheaper when executed on a single shard than split across multiple.

where

- c is a constant less than 1 - a parameter chosen by the protocol to define a threshold for small trades. It represents the fraction of the pool's reserves.
- 𝑅 refers to the reserve size of a shard's liquidity pool (typically the minimum

### Benefits:
- Traders do not gain from splitting
- Execution remains parallelizable
- Strategyproof for atomic trades

This allows SAMM to retain the simplicity of a single AMM while distributing execution.

---

## Smaller-Better Principle

SAMM satisfies the **Smaller-Better Principle**:

>Among shards with equal prices, **smaller shards are cheaper** due to lower polynomial fees. 

This leads to:

- Flow toward smaller pools
- Equalized liquidity across shards
- Automatic load balancing over time


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
                    │        (TPS scaler)          │
                    └────────────┼────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │   RiseChain Testnet     │
                    │   (Solidity contracts)  │
                    └────────────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
   CrossPoolRouter        SAMMPoolFactory        DynamicShardOrchestrator
          │                      │
          ▼                      ▼
    SAMMPool shards        SAMMCurve / SAMMFees
    (20 live pools)        (math libraries)
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

### Liquidity Shards — 20 pools, ~$32.8M TVL

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

### Write Endpoints (require `PRIVATE_KEY`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/swap` | Execute swap (server wallet signs tx) |
| `POST` | `/arbitrage/start` | Start arb bot |
| `POST` | `/arbitrage/stop` | Stop arb bot |
| `POST` | `/sharding/start` | Start shard manager |
| `POST` | `/sharding/stop` | Stop shard manager |
| `POST` | `/sharding/check` | Trigger immediate shard check |

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

---

## Project Structure

```
samm-evm/
├── contracts/                             # Solidity source
│   ├── SAMMPool.sol                       #   Liquidity pool shard
│   ├── SAMMPoolFactory.sol                #   Factory for creating shards
│   ├── CrossPoolRouter.sol                #   Multi-hop swap router
│   ├── DynamicShardOrchestrator.sol       #   On-chain shard creator
│   ├── TokenFaucet.sol                    #   Testnet faucet
│   ├── interfaces/                        #   ISAMMPool, ISAMMPoolFactory, ICrossPoolRouter
│   └── libraries/                         #   SAMMCurve.sol, SAMMFees.sol
├── api-server.js                          # REST API server (Express)
├── arbitrage-bot.js                       # Oracle-deviation rebalancer
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

Monitors every shard's spot price against CoinGecko oracles. When deviation exceeds 0.3%, it executes a corrective swap sized at 50% of the gap. A 3-cycle cooldown per shard prevents oscillation.

---

## License

MIT
