#!/usr/bin/env node
'use strict';
/**
 * refund-pools.js
 *
 * Re-seeds every drained pool shard back to its target liquidity.
 * Uses mintTo directly into each pool's token accounts (server is mint authority).
 * Also calls depositAllInstruction afterwards so LP tokens are re-minted.
 *
 * Usage:
 *   node scripts/refund-pools.js           # re-fund all empty shards
 *   node scripts/refund-pools.js --force   # re-fund all shards regardless of current reserves
 */

require('dotenv').config();
const {
  Connection, Keypair, Transaction, PublicKey,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const {
  getPoolReserves,
  findSwapAuthority,
  depositAllInstruction,
} = require('../solana-client/index.js');

const DATA       = require('../deployment-data/solana-devnet.json');
const PROGRAM_ID = process.env.SOLANA_PROGRAM_ID || DATA.programId;
const RPC        = process.env.SOLANA_RPC_URL    || 'https://api.devnet.solana.com';
const FORCE      = process.argv.includes('--force');

// Prices for computing target amounts (match original initialization)
const PRICES = { USDC: 1, USDT: 1, DAI: 1, WETH: 3000, WBTC: 65000 };

const EXPLORER = sig => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const C = {
  bold:  s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  cyan:  s => `\x1b[36m${s}\x1b[0m`,
  dim:   s => `\x1b[2m${s}\x1b[0m`,
};

function rawAmount(sym, usdPerSide) {
  const t = DATA.tokens[sym];
  const price = PRICES[sym] || 1;
  return BigInt(Math.round((usdPerSide / price) * 10 ** t.decimals));
}

async function sendAndConfirm(connection, tx, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  });
  const deadline = lastValidBlockHeight + 150;
  while (true) {
    const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
    if (value) {
      if (value.err) throw new Error('on-chain: ' + JSON.stringify(value.err));
      if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') return sig;
    }
    if (await connection.getBlockHeight() > deadline) throw new Error('tx expired');
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function main() {
  if (!process.env.SOLANA_PRIVATE_KEY) {
    console.error('SOLANA_PRIVATE_KEY not set'); process.exit(1);
  }
  const payer      = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
  const connection = new Connection(RPC, 'confirmed');
  const solBal     = await connection.getBalance(payer.publicKey);

  console.log(C.bold('\n══════════════════════════════════════════════════════════════'));
  console.log(C.bold('  SAMM Pool Refund — Re-seed empty shards'));
  console.log(C.bold('══════════════════════════════════════════════════════════════'));
  console.log(`  Wallet  : ${payer.publicKey.toBase58()}`);
  console.log(`  SOL bal : ${(solBal / 1e9).toFixed(4)} SOL`);
  console.log(`  Mode    : ${FORCE ? 'FORCE (all shards)' : 'SMART (empty shards only)'}\n`);

  let ok = 0, skip = 0, fail = 0;

  for (const [pair, shards] of Object.entries(DATA.pools)) {
    const [symA, symB] = pair.split('-');
    const tA = DATA.tokens[symA];
    const tB = DATA.tokens[symB];
    if (!tA || !tB) { console.log(`  ⚠ Unknown tokens in pair ${pair} — skip`); continue; }

    for (const shard of shards) {
      if (shard.permanentlyInactive) continue;

      const label = (shard.name || `${pair}-?`).padEnd(24);
      process.stdout.write(`  ${label}`);

      try {
        // Check current state
        const r = await getPoolReserves(connection, shard.address);
        const lpInfo = await connection.getTokenSupply(r.state.tokenPool);
        const lpSupply = BigInt(lpInfo.value.amount);
        const isEmpty = r.reserveA === 0n && r.reserveB === 0n;

        if (!isEmpty && !FORCE) {
          const tvlA = (Number(r.reserveA) / 10 ** tA.decimals).toFixed(2);
          const tvlB = (Number(r.reserveB) / 10 ** tB.decimals).toFixed(2);
          console.log(C.dim(`  skip (reserves: ${tvlA} ${symA} / ${tvlB} ${symB})`));
          skip++;
          continue;
        }

        // Target amounts from deployment's liquidityUSD (half per side)
        const usdPerSide = (shard.liquidityUSD || 20000) / 2;
        const targetA = rawAmount(symA, usdPerSide);
        const targetB = rawAmount(symB, usdPerSide);

        // Step 1: Mint directly into pool token accounts (re-seed)
        process.stdout.write('  seeding...');
        await mintTo(connection, payer, r.mintA, r.state.tokenAccountA, payer, targetA);
        await mintTo(connection, payer, r.mintB, r.state.tokenAccountB, payer, targetB);

        // Step 2: Mint to user ATAs so we can call depositAllInstruction
        // depositAllInstruction when LP supply=0: program ignores poolTokenAmount and
        // uses new_pool_supply(). Token amounts required = full reserves.
        const userATA_A  = getAssociatedTokenAddressSync(r.mintA, payer.publicKey);
        const userATA_B  = getAssociatedTokenAddressSync(r.mintB, payer.publicKey);
        const userATA_LP = getAssociatedTokenAddressSync(r.state.tokenPool, payer.publicKey);

        await mintTo(connection, payer, r.mintA, userATA_A, payer, targetA);
        await mintTo(connection, payer, r.mintB, userATA_B, payer, targetB);

        // Create LP ATA if needed
        const ensureLpTx = new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey, userATA_LP, payer.publicKey, r.state.tokenPool,
          ),
        );
        await sendAndConfirm(connection, ensureLpTx, [payer]);

        // Step 3: Call depositAllInstruction
        // LP supply = 0 → program uses new_pool_supply() ≈ 4.6e18 internally.
        // token amounts to transfer = full pool reserves (targetA seeded in step 1).
        // maximumTokenA/B = targetA * 1.01 (1% buffer for ceiling rounding)
        const [authority] = findSwapAuthority(PROGRAM_ID, shard.address);
        const maxA = targetA + targetA / 100n;
        const maxB = targetB + targetB / 100n;

        const depositTx = new Transaction().add(
          depositAllInstruction({
            programId:             PROGRAM_ID,
            tokenSwap:             shard.address,
            authority,
            userTransferAuthority: payer.publicKey,
            depositTokenA:         userATA_A,
            depositTokenB:         userATA_B,
            swapTokenA:            new PublicKey(shard.tokenAccountA),
            swapTokenB:            new PublicKey(shard.tokenAccountB),
            poolMint:              r.state.tokenPool,
            destination:           userATA_LP,
            mintA:                 r.mintA,
            mintB:                 r.mintB,
            poolTokenAmount:       1n,   // ignored when LP supply=0; program uses new_pool_supply()
            maximumTokenA:         maxA,
            maximumTokenB:         maxB,
          }),
        );

        const sig = await sendAndConfirm(connection, depositTx, [payer]);
        const fmtA = (Number(targetA) / 10 ** tA.decimals).toFixed(4);
        const fmtB = (Number(targetB) / 10 ** tB.decimals).toFixed(4);
        console.log(`  ${C.green('✓')}  ${fmtA} ${symA} + ${fmtB} ${symB}`);
        console.log(`        ${EXPLORER(sig)}`);
        ok++;

        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.log(`  ${C.red('✗')} ${e.message.split('\n')[0].slice(0, 100)}`);
        fail++;
      }
    }
  }

  console.log(C.bold('\n══════════════════════════════════════════════════════════════'));
  console.log(`  ${C.green('Refunded')} : ${ok}   ${C.dim('Skipped')} : ${skip}   ${fail ? C.red('Failed') + ' : ' + fail : ''}`);
  console.log(C.bold('══════════════════════════════════════════════════════════════\n'));
}

main().catch(e => { console.error(C.red('Fatal: ' + e.message)); process.exit(1); });
