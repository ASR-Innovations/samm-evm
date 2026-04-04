# SAMM — ETHGlobal Cannes 2026 Submission


**Project:** SAMM (Sharded Automated Market Maker)  
**GitHub:** [github.com/ASR-Innovations/samm-evm](https://github.com/ASR-Innovations/samm-evm)  
**Branch:** `ethcc-cannes`

---

## What We Built

SAMM is a **sharded DEX** that splits each token pair into multiple liquidity pools (Small, Medium, Large, Dynamic) so trades route to the smallest eligible shard — giving better rates through lower price impact. Live on **RiseChain Testnet** with **22 pools, ~$42.7M TVL**, integrated with Uniswap, Chainlink, and ENS.

---

## 🦄 Uniswap Foundation — Best Uniswap API Integration

### What We Did

Integrated the **Uniswap Trading API** (`trade-api.gateway.uniswap.org/v1`) to enable real swap execution on Sepolia and live rate comparison against SAMM.

### How It Works

1. **Quote Comparison** (`GET /compare/:in/:out/:amt`) — Every SAMM quote is compared against a live Uniswap quote for the same trade in real time
2. **Backend Swap** (`POST /swap/sepolia`) — Full flow: `/v1/quote` → Permit2 EIP-712 sign → `/v1/swap` → broadcast
3. **Frontend Swap** (`POST /swap/sepolia/prepare` + `/execute`) — Returns Permit2 typed data for MetaMask signing + unsigned tx calldata for user broadcast
4. **OP Stack Bridge** (`POST /bridge/deposit`) — Sepolia ↔ RiseChain ETH bridging via L1StandardBridge

### On-Chain Transactions (Sepolia Testnet)

| Tx Hash | Block | Gas | Action |
|---------|-------|-----|--------|
| [`0x126fa86b…`](https://sepolia.etherscan.io/tx/0x126fa86beb07c6dca2114fd7d15c60fe4b998ebaf106038380452d488ad53f95) | 10586939 | 115,234 | Uniswap swap ETH → USDC via Trading API |
| [`0xf543df01…`](https://sepolia.etherscan.io/tx/0xf543df013d72e21dd4f233d68687bb1b3ef6ed6b105eea1832b881dc8da934b8) | 10586926 | 115,218 | Uniswap swap ETH → USDC via Trading API |
| [`0xa80ab036…`](https://sepolia.etherscan.io/tx/0xa80ab036e4e93cefc405) | — | — | Uniswap swap ETH → USDC via Trading API |
| [`0xbfaa4472…`](https://sepolia.etherscan.io/tx/0xbfaa4472c32edeae6a6d008173a95e7376378da75c87e581d3b57b4dca8661a5) | 10586940 | 620,587 | Bridge deposit 0.001 ETH (Sepolia → RiseChain) |

### E2E Test Result: 20/20 PASS

```
node scripts/uniswap-e2e-flow.js --live
```

Full output log: [`test-results/uniswap-e2e-flow-1775286373598.log`](test-results/uniswap-e2e-flow-1775286373598.log)

```
  RESULTS
   Total    20
   ✅ Pass   20
   ❌ Fail   0
   ⏭️  Skip   0
   ⏱️  Time   47.1s
```

Tests executed in **live mode** — real ETH swapped, real bridge deposits, real balance changes:
- ETH: 0.089 → 0.086 (spent on swap + bridge)
- USDC: 29.4 → 35.8 (received from swap)

### Key Files

| File | Purpose |
|------|---------|
| [`integrations/uniswap-sepolia-swap.js`](integrations/uniswap-sepolia-swap.js) | Uniswap Trading API client (quote, Permit2, swap, V2 fallback) |
| [`integrations/uniswap-client.js`](integrations/uniswap-client.js) | Quote comparison wrapper |
| [`integrations/risechain-bridge.js`](integrations/risechain-bridge.js) | OP Stack bridge (Sepolia ↔ RiseChain) |
| [`scripts/uniswap-e2e-flow.js`](scripts/uniswap-e2e-flow.js) | 7-phase E2E test with live swap + bridge |
| [`api-server.js`](api-server.js) | REST API: `/compare`, `/swap/sepolia`, `/bridge/*` endpoints |

### Frontend Integration Flow

```
1. POST /swap/sepolia/prepare    → { quote, permitData, needsPermit2Signature }
2. token.approve(PERMIT2, MAX)   → one-time approval (ERC-20 only)
3. wallet.signTypedData(...)     → user signs Permit2 (ERC-20 only)
4. POST /swap/sepolia/execute    → { unsignedTransaction }
5. wallet.sendTransaction(tx)    → user confirms in MetaMask
```

---

## 🔗 Chainlink — Best CRE Workflow

### What We Did

Built a **CRE workflow** (`workflow.ts`, 678 lines) that decentralizes SAMM's shard management by running on a Chainlink DON. The workflow reads live Chainlink price feeds, fetches SAMM pool data, computes shard scaling decisions, and encodes on-chain execution calldata.

### How It Works — 6 Steps

| Step | Capability | What It Does |
|------|-----------|-------------|
| 1 | `EVMClient.callContract` | Read 4 Chainlink price feeds on Sepolia (ETH/USD, BTC/USD, USDC/USD, DAI/USD) |
| 2 | `HTTPClient.fetch` | Fetch SAMM pool data from API (reserves, TPS, shard counts for 5 pairs) |
| 3 | Compute | Per-pair analysis with original🔒 vs dynamic⚡ labels, reserve inspection |
| 4 | Compute | Formal shard decisions: SPLIT ≥250 TPS, MERGE ≤62.5 TPS, REBALANCE on price deviation |
| 5 | ChainWrite | Encode `splitShard`/`mergeShards`/`rebalanceLiquidity` calldata for DynamicShardOrchestrator |
| 6 | `ConsensusAggregationByFields` | Build consensus report with execution plan + on-chain orchestrator reference |

### Integration Points

- **Blockchain → External API:** Reads Chainlink feeds on Sepolia (EVMClient) + SAMM pool data via HTTP
- **Meaningful use:** The workflow IS the shard management brain — it decides when to scale up/down, which shards to merge, and encodes the exact contract calls
- **On-chain target:** `DynamicShardOrchestrator` at `0x93174f86F57A97827680c279e07704AbE2a0b0c0` on RiseChain

### CRE CLI Simulation — Verified ✅

```bash
cd integrations/chainlink-cre-workflow
cre workflow simulate my-workflow --non-interactive --trigger-index 0
```

Full output log: [`test-results/cre-simulation-output.txt`](test-results/cre-simulation-output.txt)

Key output (abbreviated):
```
✓ Workflow compiled
📡 Step 1: Reading Chainlink price feeds...
📊 Price feed | ETH/USD = $2056.84 | chain=ethereum-testnet-sepolia
📊 Price feed | BTC/USD = $66997.67 | chain=ethereum-testnet-sepolia
📊 Price feed | USDC/USD = $1.00
📊 Price feed | DAI/USD = $1.00
📊 Step 2: Fetching SAMM pool data...
✅ Fetched SAMM data: 5 pairs

┌── WETH-USDC ──────────────────────────────────────
│ Shards: 4 total (3 original + 1 dynamic)
│ TVL:    $6.61M across 4 shards
│   shard[0] 🔒 original | reserveA=407.90 reserveB=837128.79
│   shard[3] ⚡ dynamic | reserveA=269.41 reserveB=554170.15
│ 🔗 DECISION: MERGE — remove 1 dynamic shard(s)
└──────────────────────────────────────────────────

⚡ Step 5: ChainWrite — Execute decisions via DynamicShardOrchestrator
   Target: DynamicShardOrchestrator @ 0x93174f86F57A97827680c279e07704AbE2a0b0c0
   🔗 MERGE WETH-USDC: mergeShards(0x07Dc…, 0x1BdB…) → Calldata: 0x474676af…
   🔗 MERGE USDC-USDT: mergeShards(0xaEe1…, 0x16C8…)
   🔗 MERGE WETH-USDT: mergeShards(0xb5C4…, 0x6bf5…)
   🔗 MERGE WBTC-USDC: mergeShards(0x30Ce…, 0xf566…)
   🔗 MERGE USDC-DAI: mergeShards(0x3303…, 0x3932…)

📋 FINAL REPORT
   Decisions: 0 SPLIT, 5 MERGE, 0 REBALANCE, 0 NO_ACTION
   ChainWrites: 5 pending → DynamicShardOrchestrator @ 0x93174f86…

╭──────────────────────────────────────────────────────╮
│ Simulation complete! Ready to deploy your workflow?  │
╰──────────────────────────────────────────────────────╯
```

### Chainlink → On-Chain State Change

The arb bot (`arbitrage-bot.js`) reads Chainlink AggregatorV3 price feeds on Sepolia. When oracle price deviates >0.3% from any shard's spot price, it executes a corrective `swapSAMM()` transaction on RiseChain — an **on-chain state change driven by Chainlink data**.

### Key Files

| File | Purpose |
|------|---------|
| [`integrations/chainlink-cre-workflow/my-workflow/workflow.ts`](integrations/chainlink-cre-workflow/my-workflow/workflow.ts) | CRE workflow (678 lines) — 6-step orchestration |
| [`integrations/chainlink-price.js`](integrations/chainlink-price.js) | AggregatorV3 reader for 5 Sepolia feeds |
| [`contracts/interfaces/IChainlinkAggregator.sol`](contracts/interfaces/IChainlinkAggregator.sol) | On-chain AggregatorV3Interface |
| [`integrations/chainlink-cre-workflow/my-workflow/config.json`](integrations/chainlink-cre-workflow/my-workflow/config.json) | Feed addresses + thresholds |
| [`arbitrage-bot.js`](arbitrage-bot.js) | Chainlink-driven arb bot (on-chain state change) |
| [`test-results/cre-simulation-output.txt`](test-results/cre-simulation-output.txt) | Full CRE CLI simulation output |

### CRE SDK Capabilities Used

- `CronCapability` — 60-second trigger
- `EVMClient.callContract` — Read Chainlink feeds on-chain
- `HTTPClient.fetch` — External API integration (SAMM pool data)
- `ConsensusAggregationByFields` — DON consensus on report
- `encodeFunctionData` — ChainWrite calldata encoding

---

## 🏷️ ENS — Best ENS Integration for AI Agents

### What We Did

Built an **on-chain agent identity registry** using ENS-style naming for SAMM's 5 autonomous agents and 42 liquidity shards. Agents register themselves, expose live stats as text records, and can discover each other on-chain.

### How ENS Improves Agent Identity (not cosmetic)

| Problem | ENS Solution |
|---------|-------------|
| Agent Discovery | Resolve `arb-bot.samm.eth` → wallet `0x0045…A589` — no deployment logs needed |
| Agent Transparency | Text records expose live config: `com.samm.oracle-source=chainlink`, `com.samm.total-swaps=67` |
| Shard Discovery | 42 shards named: `small.weth-usdc.samm.eth` → contract address |
| Human-readable API | `GET /balance/vitalik.eth/WETH` works alongside raw addresses |

### On-Chain Registry (RiseChain Testnet)

**Contract:** `SAMMAgentRegistry` at [`0xCa46f85973d0f13377744fBE8D26ABBdc93a241B`](https://testnet.riselabs.xyz/address/0xCa46f85973d0f13377744fBE8D26ABBdc93a241B)

**5 Agents Registered:**

| Agent | ENS Name | Address | Role |
|-------|----------|---------|------|
| Pool Router | `pool-router.samm.eth` | `0x6A45347a…3d00` | Trade routing across shards |
| Arb Bot | `arb-bot.samm.eth` | `0x004566C3…A589` | Chainlink-driven price rebalancing |
| Shard Manager | `shard-manager.samm.eth` | `0x93174f86…AbE2` | TPS-driven dynamic sharding |
| Token Faucet | `faucet.samm.eth` | `0x42a930BF…dBE4` | Testnet token distribution |
| Pool Factory | `factory.samm.eth` | `0xc4c6ceAB…fb94` | Pool creation & indexing |

**42 Shards Registered** with ENS subnames (examples):
- `small.weth-usdc.samm.eth` → `0x1BdBf2fD…c6b9`
- `large.wbtc-usdc.samm.eth` → `0x3A741420…f7D3`
- `small-dynamic.usdc-dai.samm.eth` → `0x3303B990…1DFd`

### No Hard-Coded Values

- Agents registered via `registerOrUpdateAgent()` — on-chain, not in code
- Shards registered via `registerOrUpdateShard()` — on-chain, not in code
- Stats updated via `setBatchAgentTextRecords()` — live counts, not static
- API reads from on-chain registry dynamically at runtime

### Functional Demo

```bash
# Start server
npm start

# List all agents (reads from on-chain registry)
curl http://localhost:3000/agents

# Get specific agent + text records
curl http://localhost:3000/agents/arb-bot

# Browse shard registry
curl http://localhost:3000/registry/shards
```

### Key Files

| File | Purpose |
|------|---------|
| [`contracts/SAMMAgentRegistry.sol`](contracts/SAMMAgentRegistry.sol) | On-chain registry with batch text records |
| [`integrations/ens-agent-registry.js`](integrations/ens-agent-registry.js) | Dual-mode identity manager (local + on-chain) |
| [`scripts/deploy-ens-registry-risechain.js`](scripts/deploy-ens-registry-risechain.js) | Deploy + register 5 agents |
| [`scripts/register-shards-ens.js`](scripts/register-shards-ens.js) | Register 42 shards with subnames |
| [`test/offchain/ens-agent-registry.test.js`](test/offchain/ens-agent-registry.test.js) | ENS agent registry tests |

---

## Deployed Contracts (RiseChain Testnet, chainId 11155931)

| Contract | Address |
|----------|---------|
| SAMMPoolFactory | `0xc4c6ceABeBBfA1Bf9D219fE80F5b95982664fb94` |
| CrossPoolRouter | `0x6A45347a8DbC629000F725c544D695209b0c3d00` |
| DynamicShardOrchestrator | `0x93174f86F57A97827680c279e07704AbE2a0b0c0` |
| SAMMAgentRegistry | `0xCa46f85973d0f13377744fBE8D26ABBdc93a241B` |
| TokenFaucet | `0x42a930BF9259cE3D9e76bb1d8C61b52daf68dBE4` |

**22 liquidity pools** across 5 pairs (WETH-USDC, USDC-USDT, WETH-USDT, WBTC-USDC, USDC-DAI), total TVL ~$42.7M.

---

## Output Logs & Artifacts

| Artifact | File | What It Proves |
|----------|------|---------------|
| Uniswap E2E (20/20 pass) | [`test-results/uniswap-e2e-flow-1775286373598.log`](test-results/uniswap-e2e-flow-1775286373598.log) | Real swaps, bridge, Permit2, comparison |
| CRE Simulation | [`test-results/cre-simulation-output.txt`](test-results/cre-simulation-output.txt) | 6-step workflow with ChainWrite calldata |
| SAMM deployment | [`deployment-data/production-risechain-1774811017268.json`](deployment-data/production-risechain-1774811017268.json) | 22 pools, 5 pairs, contract addresses |
| ENS deployment | [`deployment-data/ens-registry-risechain-1775122142454.json`](deployment-data/ens-registry-risechain-1775122142454.json) | 5 agents, registry address |
| Postman collection | [`postman/SAMM-DEX-API.postman_collection.json`](postman/SAMM-DEX-API.postman_collection.json) | Full API test suite |

---

## How to Reproduce

```bash
# Clone and install
git clone https://github.com/ASR-Innovations/samm-evm.git
cd samm-evm
git checkout ethcc-cannes
npm install

# Configure
cp .env.example .env
# Set: PRIVATE_KEY, RISECHAIN_RPC_URL, UNISWAP_API_KEY, SEPOLIA_RPC_URL

# Start server (auto-discovers deployment)
npm start

# Run E2E test (live mode — executes real swaps)
node scripts/uniswap-e2e-flow.js --live

# Run CRE simulation
cd integrations/chainlink-cre-workflow
npm install
cre workflow simulate my-workflow --non-interactive --trigger-index 0
```
