'use strict';
/**
 * Shared Transaction Queue — Solana version
 *
 * Same serial queue pattern as the EVM version, but uses recentBlockhash
 * instead of account nonces.  All transactions run sequentially so the arb
 * bot and shard manager never send conflicting transactions from the same
 * keypair.
 */

class TxQueue {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {import('@solana/web3.js').Keypair}    keypair
   */
  constructor(connection, keypair) {
    this.connection = connection;
    this.keypair    = keypair;
    this._queue     = [];
    this._processing = false;
    this.stats = { sent: 0, confirmed: 0, failed: 0, retried: 0 };
  }

  /**
   * Enqueue a transaction.
   *
   * @param {Function} txFn   — async(blockhash: string) => Transaction
   *                           The function receives a fresh blockhash and
   *                           must return a signed-ready Transaction (or throw).
   * @param {string}   label  — human-readable description for logs
   * @param {number}   maxRetries
   * @returns {Promise<{success:boolean, txHash?:string, error?:string}>}
   */
  send(txFn, label = 'tx', maxRetries = 2) {
    return new Promise((resolve) => {
      this._queue.push({ txFn, label, maxRetries, resolve });
      this._drain();
    });
  }

  async _drain() {
    if (this._processing) return;
    this._processing = true;
    while (this._queue.length > 0) {
      const job = this._queue.shift();
      const result = await this._execute(job);
      job.resolve(result);
    }
    this._processing = false;
  }

  async _execute({ txFn, label, maxRetries }) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { blockhash, lastValidBlockHeight } =
          await this.connection.getLatestBlockhash('confirmed');

        const tx = await txFn(blockhash, lastValidBlockHeight);

        // Caller is responsible for building the Transaction; we sign here
        // if it hasn't been signed yet (partial-sign pattern).
        if (!tx.signatures?.length || tx.signatures.every(s => !s.signature)) {
          tx.recentBlockhash = blockhash;
          tx.feePayer = this.keypair.publicKey;
          tx.sign(this.keypair);
        }

        this.stats.sent++;
        const sig = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });

        await this.connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        this.stats.confirmed++;
        return { success: true, txHash: sig };
      } catch (err) {
        const msg = err.message || '';
        const isBlockhashError =
          msg.includes('Blockhash not found') ||
          msg.includes('block height exceeded') ||
          msg.includes('Transaction simulation failed') && msg.includes('blockhash');

        if (isBlockhashError) {
          this.stats.retried++;
          if (attempt < maxRetries) {
            console.warn(`   ↻ ${label}: blockhash expired, retrying (${attempt + 1}/${maxRetries})`);
            continue;
          }
        }

        this.stats.failed++;
        const short = msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
        console.warn(`   ✗ ${label} failed: ${short}`);
        return { success: false, error: short };
      }
    }

    this.stats.failed++;
    return { success: false, error: 'max retries exceeded' };
  }

  getStats() {
    return { ...this.stats, pending: this._queue.length };
  }
}

module.exports = TxQueue;
