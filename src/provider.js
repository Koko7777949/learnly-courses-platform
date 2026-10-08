'use strict';
/**
 * Mock payout provider — §8 of the pack.
 *
 * Contract:
 *   createPayout(idempotencyKey, providerAccountId, amountMinor, currency)
 *   getPayoutStatus(idempotencyKey)
 *
 * The mock is deliberately an unreliable distributed system, not a function
 * call: it keeps its OWN durable ledger (provider_transactions) keyed by
 * idempotency key, and can move money even when the caller gets a timeout.
 *
 * Scenarios (provider_config.scenario, overridable per account):
 *   success                  -> money moves, caller sees success
 *   permanent_failure        -> nothing moves, caller sees failure
 *   timeout_after_success    -> money moves, caller sees a timeout exception
 */
const { nowIso } = require('./db');

class ProviderTimeoutError extends Error {
  constructor(key) {
    super(`provider timed out for idempotency key ${key} (money may have moved)`);
    this.name = 'ProviderTimeoutError';
    this.idempotencyKey = key;
  }
}
class ProviderPermanentFailureError extends Error {
  constructor(key, reason) {
    super(`provider permanently rejected payout for ${key}: ${reason}`);
    this.name = 'ProviderPermanentFailureError';
    this.reason = reason;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProvider(db, { latencyMs = 120 } = {}) {
  function scenarioFor(accountId) {
    const override = db
      .prepare('SELECT value FROM provider_config WHERE key = ?')
      .get(`scenario_override:${accountId}`);
    if (override) return override.value;
    const global = db.prepare("SELECT value FROM provider_config WHERE key = 'scenario'").get();
    return global ? global.value : 'success';
  }

  /** Provider-side idempotent create. Returns {status, providerTxnId} or throws. */
  async function createPayout(idempotencyKey, providerAccountId, amountMinor, currency) {
    await sleep(latencyMs); // simulated network latency
    if (amountMinor <= 0) throw new Error('provider rejects zero/negative amount');

    const existing = db
      .prepare('SELECT * FROM provider_transactions WHERE idempotency_key = ?')
      .get(idempotencyKey);
    if (existing) {
      // Idempotent replay: same key => same provider record, same outcome.
      if (existing.status === 'SUCCESS') return { status: 'SUCCESS', providerTxnId: existing.provider_txn_id };
      throw new ProviderPermanentFailureError(idempotencyKey, 'previously failed');
    }

    const scenario = scenarioFor(providerAccountId);
    const txnId = `ptxn_${Math.random().toString(36).slice(2, 10)}`;

    if (scenario === 'success') {
      db.prepare(
        `INSERT INTO provider_transactions
           (idempotency_key, provider_account_id, amount_minor, currency, status, provider_txn_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(idempotencyKey, providerAccountId, amountMinor, currency, 'SUCCESS', txnId, nowIso());
      return { status: 'SUCCESS', providerTxnId: txnId };
    }

    if (scenario === 'permanent_failure') {
      db.prepare(
        `INSERT INTO provider_transactions
           (idempotency_key, provider_account_id, amount_minor, currency, status, provider_txn_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(idempotencyKey, providerAccountId, amountMinor, currency, 'FAILED', txnId, nowIso());
      throw new ProviderPermanentFailureError(idempotencyKey, 'recipient account rejected (mock)');
    }

    if (scenario === 'timeout_after_success') {
      // Money MOVES, record is stored, but the response never arrives.
      db.prepare(
        `INSERT INTO provider_transactions
           (idempotency_key, provider_account_id, amount_minor, currency, status, provider_txn_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(idempotencyKey, providerAccountId, amountMinor, currency, 'SUCCESS', txnId, nowIso());
      throw new ProviderTimeoutError(idempotencyKey);
    }

    throw new Error(`unknown provider scenario: ${scenario}`);
  }

  /** Status lookup by idempotency key — used by reconciliation. */
  function getPayoutStatus(idempotencyKey) {
    const row = db
      .prepare('SELECT * FROM provider_transactions WHERE idempotency_key = ?')
      .get(idempotencyKey);
    if (!row) return { status: 'UNKNOWN' };
    return { status: row.status, providerTxnId: row.provider_txn_id, amountMinor: row.amount_minor };
  }

  return { createPayout, getPayoutStatus, ProviderTimeoutError, ProviderPermanentFailureError };
}

module.exports = { makeProvider, ProviderTimeoutError, ProviderPermanentFailureError };
