# SAMM Shard Orchestration — Chainlink CRE Workflow

## What This Is

This directory contains a **Chainlink Runtime Environment (CRE)** workflow specification that decentralizes SAMM's shard management.

Currently, SAMM's `dynamic-shard-manager.js` runs on a single server — if the server goes down, no new shards are created under high TPS load. This CRE workflow wraps the same logic so it runs on a **Chainlink Decentralized Oracle Network (DON)**, making it fault-tolerant and trustless.

## Workflow Logic

```
┌──────────────────────────────────────────────────────────────┐
│ 1. TRIGGER: Scheduled every 60 seconds                      │
│ 2. READ:    Chainlink ETH/USD, BTC/USD price feeds           │
│ 3. READ:    SAMM shard reserves via RPC (RiseChain)          │
│ 4. COMPUTE: Price deviation per shard (oracle vs spot)       │
│ 5. COMPUTE: Shard count: n = min(⌈TPS/50⌉, 10)             │
│ 6. ACTION:  If deviation > 0.3% → signal rebalance          │
│ 7. ACTION:  If shards needed > current → create shard        │
│ 8. REPORT:  Emit on-chain report with decisions              │
└──────────────────────────────────────────────────────────────┘
```

## What Replaces What

| Before (Centralized)               | After (CRE Decentralized)              |
|-------------------------------------|----------------------------------------|
| `dynamic-shard-manager.js`          | `workflow.ts` running on Chainlink DON |
| CoinGecko HTTP API for prices       | Chainlink Price Feeds (on-chain)       |
| Node.js `setInterval()` timer       | CRE scheduled trigger                  |
| Single-server execution             | DON fault-tolerant execution           |
| `arbitrage-bot.js` price source     | Chainlink AggregatorV3 contracts       |

## How to Use

### Simulate locally
```bash
cd integrations/chainlink-cre-workflow
npm install
cre workflow simulate my-workflow --non-interactive --trigger-index 0
```

### Simulate interactively
```bash
cd integrations/chainlink-cre-workflow
cre workflow simulate my-workflow
# Select trigger 0 (cron-trigger) when prompted
```

### Build WASM binary
```bash
cd integrations/chainlink-cre-workflow
cre workflow build my-workflow
```

### Deploy to CRE network
Deploy a successfully simulated workflow to the live CRE network:
```bash
cre workflow deploy my-workflow
```

## Resources

- [CRE Documentation](https://docs.chain.link/cre)
- [CRE Bootcamp](https://smartcontractkit.github.io/cre-bootcamp-2026/)
- [CRE Templates](https://github.com/smartcontractkit/cre-templates/)
