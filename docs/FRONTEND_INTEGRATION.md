# SAMM DEX — Frontend Integration Guide

**Network:** Solana Devnet  
**SAMM Pool Program:** `AvtCT5zyjHWMjVDepZUnJWNGJQeJfrk84ZtvhuaECrUZ`  
**Router Program:** `DHwrqPKt3m2zXSiA57h97Z1zuyYE3s2KTwhnnAkaHVPu`  
**API Server:** `http://localhost:3000` (or your deployed Railway URL)

Machine-readable reference: [`deployment-data/frontend-integration.json`](../deployment-data/frontend-integration.json)

---

## How swaps work (user perspective)

| Flow | What happens |
|------|-------------|
| User calls `POST /swap` | Server builds a Solana transaction |
| Router program executes on-chain | Reads live reserves from all shards, picks best one |
| One transaction, one signature | Even 2-hop swaps (WBTC→USDC→DAI) are atomic |
| User receives exact `amountOut` | Exact-output model — "I want exactly 100 USDT" |

The router enforces two invariants automatically — no client trust required:
- **c-Non-Splitting (c=0.96):** single-shard routing is provably optimal when `amountOut < 0.96 × shard reserve`
- **Smaller-Better:** among available shards, the one with largest reserves requires least input tokens

---

## Token Mints (Devnet)

| Symbol | Mint Address | Decimals |
|--------|-------------|----------|
| USDC | `8NYkWmgtd5Sd2YfitVoQviWNY8wtDXTuH4bykDP3yZKM` | 6 |
| USDT | `5MVkBousJgvBwynVCw8oqAb5vNoyVaB59MGMRybLmpW7` | 6 |
| WETH | `CC9VEegiHtEet2LXWoLWwt1QdEjPFgBtwLDAxnB6xVk7` | 9 |
| WBTC | `yhD6NWN78cZSZcbfiyVrvBMSDjQEiEnDEc2PgFdURku` | 8 |
| DAI  | `7EPCJuQFajxDQzbhA7LKmCsZfr4H43a6GX5oULQjdpNs` | 9 |

---

## Pool Shards (Devnet)

Each pair has 1–4 shards of increasing size (Small/Medium/Large/XL). The router automatically selects the best shard on-chain.

| Pair | Shard | Pool State Address |
|------|-------|--------------------|
| USDC-USDT | Small  | `AaCzwwGiuBUaLwyj6ComyMBWWhfLZwGncCUdhzpcsTGT` |
| USDC-USDT | Medium | `HYcqqLeofeuJHYJivnSbJegGX2dS13ifxxW5S5CF6Rnd` |
| USDC-USDT | Large  | `7ypNMju4UcwA4hQYUkNm3vv62a6uzNA8vggMeg19Xzmr` |
| USDC-USDT | XL     | `BxgLJLZSYVdHJ9LQ2kgKBNnsgmQmL44eU6qJ2PyJ9J72` |
| WETH-USDC | Small  | `4VkjGLszvjZ1C2YVCA3gvALfhW2meLquLDao1K3huCV2` |
| WETH-USDC | Medium | `JBatFMGXjapf4sHfhWdnWC25irQ8S6Gu72oUCt7zTRsD` |
| WETH-USDC | Large  | `AJLUAP8VXBmCovsjq1r1H8KoqqJ6xYawsGAQV4TD6Wdgf` |
| WETH-USDC | XL     | `4faBmJPGPjHCdt3GMy57fjJwDmsU5GbaWjqJ3Tk9timp` |
| WBTC-USDC | Small  | `BonBFDPxAGY1zCdNsUAb2sgm6AReTc63Cpqh7jRopDzx` |
| WBTC-USDC | Medium | `8ZGE1QBDFRMBuj1ZXABnzxpSD8CwUt9KqUzoMcy4SYkB` |
| WBTC-USDC | Large  | `6wnREvxGMUESf5eNhBxiqGBf8x7BkpT9EDHYsjvdQW77` |
| WBTC-USDC | XL     | `4S2HJ7nYYNYu2uU5YphReYvnWwgdDy6cufngR1xoNpaV` |
| DAI-USDC  | Small  | `ExaWxELZ3yKvq685txS7nCYE5thtZphLGCXFWobENUoN` |
| USDC-DAI  | Small  | `A9tqtkjUCVnrWZ6Am5N7KCJ1kJsnpu6YXD1nSuzb1ETk` |
| USDC-DAI  | Medium | `GVdCMkMjhcuJcuBBpfohTVNGHLvvkKHf4DxhR1EgpTwP` |
| USDC-DAI  | Large  | `AK71KtZcSEv8ajtoYkHqVY55bAoJAyyQyTqN6r8Qpx8e` |
| USDC-DAI  | XL     | `BMnBcRpkYcNqKe41qL2j5rLq6FTJRnVmJfdg18zJJPED` |
| USDT-DAI  | Small  | `HFfjnASbjoxB33GFRt6Am8Z5ne4RPoQLYmaRCb9A4gH`  |
| USDT-DAI  | Medium | `4nBZRd6mex85nLRVfNg5zcH7rey3qpqkf6r1LtB7Uf5R` |
| USDT-DAI  | Large  | `8NMJoEayhYpKAiSi2Ne2jC1HkdxwjCqXqPybfP8zNDAU` |
| USDT-DAI  | XL     | `4xPNrXnGqphkKjnNMWwqXyJvfFEDXRxo9Tp1KpoVK374` |
| WETH-WBTC | Small  | `8J5siYcTnFZUdeABDUqtWuPR2Wd935gmQFWWMo7C3w6n` |
| WETH-WBTC | Medium | `5AViEp8PxwQ85M7gmXzv9insRCCkuNRyJ3EaUrPFqrM8` |
| WETH-WBTC | Large  | `9AXTrhnAqghMYVFkjCwY8ZyRJJTHx6vug9ERLDHQA5Xv` |
| WETH-WBTC | XL     | `Ba5nDjwLJL8PpcJCzgnBQGxhAgmJaWHehEoQh9yCgGNe` |
| WETH-USDT | Small  | `HyXDz7XTWG6JxFz2QHAcgfjxtxY8efud75y4egyt1qx4` |
| WETH-USDT | Medium | `CMM4Qpj2WNcYhXEp6q8WUm3TrLY1uL8oWAgFs5vRANzw` |
| WETH-USDT | Large  | `DDXMhGbjn7g8mQ9UcXpJ9YQmEiEQMtRXzfRfrpE6mXzp` |
| WETH-USDT | XL     | `54HrDuNiiepAqy3JJF1oPq2CfpCC5o5pgZQ3vF83hrYS` |

---

## API Reference

### GET /health
Returns server status, oracle prices, arb bot state, and both program IDs.

```json
{
  "status": "ok",
  "programId": "AvtCT5zyjHWMjVDepZUnJWNGJQeJfrk84ZtvhuaECrUZ",
  "routerProgramId": "DHwrqPKt3m2zXSiA57h97Z1zuyYE3s2KTwhnnAkaHVPu",
  "oraclePrices": { "WETH": 2362.38, "WBTC": 81080, "USDC": 1, "USDT": 1, "DAI": 1 },
  "wallet": { "address": "...", "balance": "7.98" },
  "arbitrageBot": { "running": true, "stats": { "cycles": 145, "swaps": 118, "totalUSD": 30000 } },
  "shardManager": { "running": true }
}
```

---

### GET /quote/:tokenIn/:tokenOut/:amountOut
Get a routing quote without executing. Use this to show the user expected cost before they confirm.

```
GET /quote/USDC/WETH/0.001
GET /quote/WBTC/DAI/100
```

Response:
```json
{
  "tokenIn": "USDC",
  "tokenOut": "WETH",
  "amountOut": "0.001",
  "amountIn": "2.398123",
  "amountInUSD": "2.40",
  "amountOutUSD": "2.36",
  "effectiveRate": "0.00041697",
  "slippagePct": "-1.4320",
  "totalFee": "0.006004",
  "totalFeeBps": 5,
  "routePath": "USDC→WETH",
  "hops": 1,
  "hopDetails": [
    {
      "hop": 1,
      "tokenIn": "USDC",
      "tokenOut": "WETH",
      "amountIn": "2.398123",
      "amountOut": "0.001000000",
      "feeBps": 5,
      "strategy": "single",
      "shardsUsed": 1
    }
  ]
}
```

---

### POST /swap
Execute a swap through the on-chain router. The server's keypair signs.

```json
// Request
{
  "tokenIn": "USDC",
  "tokenOut": "WETH",
  "amountOut": "0.001",
  "slippagePct": "1.0"
}

// Response
{
  "success": true,
  "txHash": "5ewQNJTeM...",
  "tokenIn": "USDC",
  "tokenOut": "WETH",
  "amountOut": "0.001",
  "amountIn": "2.398",
  "routePath": "USDC→WETH",
  "hops": 1,
  "routing": "on-chain",
  "feeBps": 5,
  "priceImpactPct": "0.0010",
  "explorer": "https://explorer.solana.com/tx/5ewQ...?cluster=devnet"
}
```

**Supported routes (all tested on-chain):**

| Route | Hops | Via |
|-------|------|-----|
| USDC ↔ USDT | 1 | direct |
| USDC ↔ DAI | 1 | direct |
| DAI ↔ USDT | 1 | direct |
| WETH ↔ USDC | 1 | direct |
| WETH ↔ USDT | 1 | direct |
| WBTC ↔ USDC | 1 | direct |
| WBTC → USDT | 2 | WBTC→USDC→USDT |
| WBTC → DAI | 2 | WBTC→USDC→DAI |
| WETH → DAI | 2 | WETH→USDC→DAI |
| DAI → WETH | 2 | DAI→USDC→WETH |

---

### GET /price/:tokenA/:tokenB
Live spot price with oracle deviation.

```
GET /price/USDC/WETH
```
```json
{
  "pair": "USDC/WETH",
  "price": "0.00041697",
  "description": "1 WETH = 2398.123 USDC",
  "oracleRate": "0.00042309",
  "deviationPct": "-1.4450",
  "routePath": "USDC→WETH",
  "feeBps": 5
}
```

---

### GET /balances/:address
All token balances for any wallet.

```
GET /balances/3192e7asquzj5KwXgjer1CfWKGBK8Y5ECo3qWjsjNfVc
```
```json
{
  "address": "3192e7...",
  "balances": {
    "USDC": { "balance": "108521.83", "balanceRaw": "108521835985", "decimals": 6 },
    "WETH": { "balance": "53.343", "balanceRaw": "53343497482", "decimals": 9 }
  }
}
```

---

### GET /pools
All pools with live TVL. Useful for building a liquidity dashboard.

```json
{
  "pools": [
    {
      "pair": "USDC-USDT",
      "totalLiquidityUSD": 2699646,
      "shards": [
        {
          "name": "USDC-USDT-XL",
          "address": "BxgLJLZSYVdHJ9LQ2kgKBNnsgmQmL44eU6qJ2PyJ9J72",
          "tokenA": "USDC",
          "tokenB": "USDT",
          "reserveA": "674911.653903",
          "reserveB": "674891.562891",
          "liquidityUSD": 1349803
        }
      ]
    }
  ],
  "totalPairs": 8,
  "totalShards": 29
}
```

---

### GET /stats
DEX-wide aggregate stats.

---

### POST /faucet (Devnet only)
Mint test tokens to any wallet. Server is the mint authority.

```json
// Request
{ "address": "<wallet pubkey>", "tokens": { "USDC": 1000, "WETH": 0.5 } }

// Response
{ "minted": 1, "results": { "USDC": { "txHash": "...", "amount": 1000 } } }
```

Max per call: USDC/USDT/DAI = 10,000 | WETH = 5 | WBTC = 0.1

---

## Running the server

```bash
# Start everything (API + arb bot + shard manager)
node api-server.js

# Or via npm
npm start
```

The server auto-starts:
- Arb bot after **3 seconds** (rebalances every 20s using CoinGecko oracle prices)
- Shard manager after **8 seconds** (checks TVL every 60s, deactivates low-TVL shards)

Logs are printed to stdout in real time per cycle.

---

## Running live swap tests (in a second terminal)

```bash
# Full test suite — all 12 pairs
node scripts/test-router-live.js

# Single pair
node scripts/test-router-live.js USDC WETH 0.001
node scripts/test-router-live.js WBTC DAI 100

# Continuous loop (runs every 30s — watch alongside server logs)
node scripts/test-router-live.js --loop
```

---

## Redeploying the router

If you need to upgrade the router program:

```bash
node scripts/deploy-router.js
```

This builds with `cargo build-sbf`, deploys to the configured cluster, and writes the new Program ID into `deployment-data/solana-devnet.json`.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | RPC endpoint (default: devnet) |
| `SOLANA_PROGRAM_ID` | SAMM pool program ID |
| `SAMM_ROUTER_PROGRAM_ID` | On-chain router program ID |
| `SOLANA_PRIVATE_KEY` | Base58 keypair (enables swaps + arb bot) |
| `ENABLE_ARBITRAGE` | `true`/`false` (default: true) |
| `ARB_CHECK_INTERVAL` | Arb check interval ms (default: 20000) |
| `MAX_SWAP_USD` | Max single arb swap in USD (default: 500) |
| `ENABLE_DYNAMIC_SHARDING` | `true`/`false` (default: true) |
| `PORT` | API server port (default: 3000) |
