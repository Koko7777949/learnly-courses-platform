'use strict';
/**
 * Instructor Revenue Ledger engine.
 *
 * Implements §2 (business rules), §5 (recognition), §6 (refunds) and §7
 * (payout architecture) of the Engineering Documentation Pack.
 *
 * Correctness properties enforced here:
 *  - All money is integer minor units.
 *  - Allocation snapshot at payment time; later catalog changes never rewrite it.
 *  - Revenue recognized straight-line over [starts_at, ends_at); a payment is
 *    cash received, not revenue earned.
 *  - Refunds only touch the still-unearned portion; recognized revenue is
 *    never clawed back (delta posting is max(0, ...)).
 *  - One active payout intent per instructor; stable idempotency key per
 *    intent; uncertain provider outcome is a first-class state (VERIFY).
 *  - Every balance-changing operation is a single IMMEDIATE transaction;
 *    the remote provider is only ever called OUTSIDE a transaction.
 */
const crypto = require('crypto');
const { platformFee, allocate, earnedToDate, daysBetween } = require('./money');
const { nowIso, emit } = require('./db');

const ACTIVE_PAYOUT_STATES = ['PENDING', 'PROCESSING', 'VERIFY'];

function addMonthsUtc(iso, months) {
  const d = new Date(iso);
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  return out.toISOString();
}

function ensureBalance(db, instructorId) {
  db.prepare(
    `INSERT INTO instructor_balances (instructor_id, earned_minor, paid_minor, reserved_minor, currency, updated_at)
     VALUES (?, 0, 0, 0, 'USD', ?) ON CONFLICT(instructor_id) DO NOTHING`,
  ).run(instructorId, nowIso());
}

/* ------------------------------------------------------------------ */
/* Checkout: subscription + payment + immutable allocation snapshot    */
/* ------------------------------------------------------------------ */

/**
 * Purchase a plan. Creates subscription, participant snapshot, payment record
 * and the revenue allocation snapshot — one transaction.
 */
function subscribe(db, { userId, planId, requestIdempotencyKey, startsAt }) {
  const key = requestIdempotencyKey || crypto.randomUUID();

  const dup = db.prepare(
    'SELECT p.id, p.subscription_id FROM subscription_payments p WHERE p.request_idempotency_key = ?',
  ).get(key);
  if (dup) return { subscriptionId: dup.subscription_id, idempotentReplay: true };

  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(planId);
  if (!plan) throw new Error('plan not found or inactive');
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('user not found');

  const starts = startsAt || nowIso();
  const ends = addMonthsUtc(starts, plan.term_months);
  const providerPaymentId = `ppay_${crypto.randomUUID().slice(0, 12)}`;

  return db.transaction(() => {
    const sub = db.prepare(
      `INSERT INTO subscriptions (user_id, plan_id, starts_at, ends_at, gross_minor, currency, status, provider_payment_id, created_at)
       VALUES (?,?,?,?,?,?, 'active', ?, ?)`,
    ).run(userId, planId, starts, ends, plan.price_minor, plan.currency, providerPaymentId, nowIso());
    const subscriptionId = Number(sub.lastInsertRowid);

    // Participant snapshot: instructors of the plan's courses, weights summed.
    const participants = db.prepare(
      `SELECT ci.instructor_id, SUM(ci.weight) AS weight
         FROM plan_courses pc
         JOIN course_instructors ci ON ci.course_id = pc.course_id
        WHERE pc.plan_id = ?
        GROUP BY ci.instructor_id
        ORDER BY ci.instructor_id`,
    ).all(planId);
    if (participants.length === 0) throw new Error('plan has no courses/instructors');

    const insPart = db.prepare(
      'INSERT INTO subscription_participants (subscription_id, instructor_id, weight) VALUES (?,?,?)',
    );
    for (const p of participants) insPart.run(subscriptionId, p.instructor_id, p.weight);

    const { fee, distributable } = platformFee(plan.price_minor, plan.platform_fee_bps);
    const pay = db.prepare(
      `INSERT INTO subscription_payments
         (subscription_id, provider_payment_id, request_idempotency_key, gross_minor,
          platform_fee_minor, distributable_minor, currency, status, paid_at)
       VALUES (?,?,?,?,?,?,?, 'paid', ?)`,
    ).run(subscriptionId, providerPaymentId, key, plan.price_minor, fee, distributable, plan.currency, nowIso());
    const paymentId = Number(pay.lastInsertRowid);

    // Immutable allocation snapshot — weighted largest remainder, exact at the cent.
    const shares = allocate(distributable, participants);
    const insAlloc = db.prepare(
      `INSERT INTO revenue_allocations
         (payment_id, instructor_id, allocated_minor, recognized_minor, paid_minor, refunded_minor, term_start_at, term_end_at)
       VALUES (?,?,?, 0, 0, 0, ?, ?)`,
    );
    for (const [instructorId, amount] of shares) {
      insAlloc.run(paymentId, instructorId, amount, starts, ends);
      ensureBalance(db, instructorId);
    }

    emit(db, 'subscription.created', 'subscription', subscriptionId, { userId, planId, gross: plan.price_minor });
    emit(db, 'payment.received', 'payment', paymentId, { gross: plan.price_minor, fee, distributable, participants: shares.size });
    return { subscriptionId, paymentId, distributable, participants: participants.length };
  })();
}

/* ------------------------------------------------------------------ */
/* Revenue recognition (§5)                                            */
/* ------------------------------------------------------------------ */

/** Effective allocation base after refunds — the original allocated_minor is never rewritten. */
function allocationBase(row) {
  return row.allocated_minor - row.refunded_minor;
}

function earnedFor(db, allocRow, asOf) {
  const base = allocationBase(allocRow);
  return earnedToDate(base, new Date(allocRow.term_start_at), new Date(allocRow.term_end_at), asOf);
}

/**
 * Post recognition deltas for one instructor: delta = earned_to_date - recognized,
 * only positive deltas are posted (no clawback). Returns total posted.
 */
function recognizeForInstructor(db, instructorId, asOf = new Date()) {
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM revenue_allocations WHERE instructor_id = ?').all(instructorId);
    let total = 0;
    const upd = db.prepare(
      'UPDATE revenue_allocations SET recognized_minor = recognized_minor + ? WHERE id = ?',
    );
    for (const row of rows) {
      const earned = earnedFor(db, row, asOf);
      const delta = Math.max(0, earned - row.recognized_minor);
      if (delta > 0) {
        upd.run(delta, row.id);
        total += delta;
      }
    }
    if (total > 0) {
      ensureBalance(db, instructorId);
      db.prepare('UPDATE instructor_balances SET earned_minor = earned_minor + ?, updated_at = ? WHERE instructor_id = ?')
        .run(total, nowIso(), instructorId);
      emit(db, 'revenue.recognized', 'instructor', instructorId, { delta: total });
    }
    return total;
  })();
}

function recognizeAll(db, asOf = new Date()) {
  const ids = db.prepare('SELECT DISTINCT instructor_id AS id FROM revenue_allocations').all();
  let total = 0;
  for (const { id } of ids) total += recognizeForInstructor(db, id, asOf);
  return total;
}

/* ------------------------------------------------------------------ */
/* Refunds (§6): unused-time only, no clawback                         */
/* ------------------------------------------------------------------ */

/**
 * Mid-term refund. Customer gets the pro-rated unused-time gross back; the
 * instructor side gives up only still-unearned allocation, distributed
 * proportionally (largest remainder with weights = remaining unearned).
 */
function refundSubscription(db, subscriptionId, reason = 'customer request', asOf = new Date()) {
  return db.transaction(() => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
    if (!sub) throw new Error('subscription not found');
    if (sub.status !== 'active') throw new Error(`subscription is ${sub.status}, cannot refund`);
    const pay = db.prepare('SELECT * FROM subscription_payments WHERE subscription_id = ?').get(subscriptionId);
    if (!pay) throw new Error('no payment for subscription');

    const termStart = new Date(sub.starts_at);
    const termEnd = new Date(sub.ends_at);
    const termDays = daysBetween(termStart, termEnd);
    const elapsed = Math.max(0, Math.min(daysBetween(termStart, asOf), termDays));
    const remainingDays = termDays - elapsed;

    // Customer refund: pro-rated unused time on the gross price.
    const refundMinor = Math.floor((pay.gross_minor * remainingDays) / termDays);

    // Instructor side: weights are remaining-unearned per allocation.
    const allocs = db.prepare('SELECT * FROM revenue_allocations WHERE payment_id = ?').all(pay.id);
    const weighted = allocs.map((a) => {
      const earned = earnedFor(db, a, asOf);
      const unearned = allocationBase(a) - earned; // >= 0 by construction
      return { allocation_id: a.id, instructor_id: a.instructor_id, weight: Math.max(0, unearned) };
    });
    const cap = weighted.reduce((s, w) => s + w.weight, 0);

    // Distributable share of the refund; anything above the unearned cap is a
    // platform-side policy item (§6.1) and is never taken from instructors.
    const distributableShare = pay.gross_minor > 0
      ? Math.floor((refundMinor * pay.distributable_minor) / pay.gross_minor)
      : 0;
    const clawback = Math.min(distributableShare, cap);

    const providerRef = `pref_${crypto.randomUUID().slice(0, 12)}`;
    const refundRow = db.prepare(
      `INSERT INTO refunds (payment_id, subscription_id, provider_ref, refund_minor, clawback_minor, status, reason, processed_at)
       VALUES (?,?,?,?,?, 'processed', ?, ?)`,
    ).run(pay.id, subscriptionId, providerRef, refundMinor, clawback, reason, nowIso());
    const refundId = Number(refundRow.lastInsertRowid);

    if (clawback > 0 && cap > 0) {
      const shares = allocate(clawback, weighted.filter((w) => w.weight > 0));
      const insItem = db.prepare(
        'INSERT INTO refund_allocations (refund_id, allocation_id, amount_minor) VALUES (?,?,?)',
      );
      const bumpRefunded = db.prepare(
        'UPDATE revenue_allocations SET refunded_minor = refunded_minor + ? WHERE id = ?',
      );
      for (const [allocId, amount] of shares) {
        insItem.run(refundId, allocId, amount);
        bumpRefunded.run(amount, allocId);
      }
    }

    db.prepare("UPDATE subscriptions SET status = 'refunded' WHERE id = ?").run(subscriptionId);
    emit(db, 'refund.processed', 'refund', refundId, {
      subscriptionId, refundMinor, clawback, cap, platformAbsorbed: refundMinor - clawback,
    });
    return { refundId, refundMinor, clawback, unearnedCap: cap, providerRef };
  })();
}

/* ------------------------------------------------------------------ */
/* Payouts (§7): durable intent -> remote call -> finalize             */
/* ------------------------------------------------------------------ */

function activePayoutFor(db, instructorId) {
  return db.prepare(
    `SELECT * FROM payouts WHERE instructor_id = ? AND status IN ('PENDING','PROCESSING','VERIFY') ORDER BY id DESC LIMIT 1`,
  ).get(instructorId);
}

/** Reserved per allocation via non-terminal payout items. */
function reservedByAllocation(db) {
  const rows = db.prepare(
    `SELECT pi.allocation_id, SUM(pi.amount_minor) AS reserved
       FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id
      WHERE p.status IN ('PENDING','PROCESSING','VERIFY')
      GROUP BY pi.allocation_id`,
  ).all();
  const m = new Map();
  for (const r of rows) m.set(r.allocation_id, r.reserved);
  return m;
}

/**
 * PrepareInstructorPayout (§7.3). Recognize, then atomically claim the
 * payable balance: create payout + items and reserve the amount.
 * Returns {payoutId} or {skipped: reason}.
 */
function prepareInstructorPayout(db, instructorId, { asOf = new Date(), enqueue } = {}) {
  recognizeForInstructor(db, instructorId, asOf);

  const claim = db.transaction(() => {
    if (activePayoutFor(db, instructorId)) return { skipped: 'active_payout_exists' };
    const bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(instructorId);
    if (!bal) return { skipped: 'no_balance_row' };
    const available = bal.earned_minor - bal.paid_minor - bal.reserved_minor;
    if (available <= 0) return { skipped: 'no_payable_balance', available };

    const reserved = reservedByAllocation(db);
    const allocs = db.prepare('SELECT * FROM revenue_allocations WHERE instructor_id = ?').all(instructorId);
    const items = [];
    for (const a of allocs) {
      const payable = a.recognized_minor - a.paid_minor - (reserved.get(a.id) || 0);
      if (payable > 0) items.push({ allocation_id: a.id, amount_minor: payable });
    }
    if (items.length === 0) return { skipped: 'no_eligible_allocations' };

    const amount = items.reduce((s, i) => s + i.amount_minor, 0);
    const now = nowIso();
    const ins = db.prepare(
      `INSERT INTO payouts (instructor_id, amount_minor, currency, idempotency_key, status, attempt_count, created_at, updated_at)
       VALUES (?,?,?, 'tmp', 'PENDING', 0, ?, ?)`,
    ).run(instructorId, amount, bal.currency, now, now);
    const payoutId = Number(ins.lastInsertRowid);
    // Stable idempotency key, created once at claim time and never changed.
    db.prepare('UPDATE payouts SET idempotency_key = ? WHERE id = ?')
      .run(`po_${instructorId}_${payoutId}`, payoutId);

    const insItem = db.prepare('INSERT INTO payout_items (payout_id, allocation_id, amount_minor) VALUES (?,?,?)');
    for (const it of items) insItem.run(payoutId, it.allocation_id, it.amount_minor);

    db.prepare('UPDATE instructor_balances SET reserved_minor = reserved_minor + ?, updated_at = ? WHERE instructor_id = ?')
      .run(amount, now, instructorId);
    emit(db, 'payout.claimed', 'payout', payoutId, { instructorId, amount, items: items.length });
    return { payoutId, amount };
  })();

  if (claim.payoutId && enqueue) enqueue('process_instructor_payout', { payoutId: claim.payoutId });
  return claim;
}

/**
 * ProcessInstructorPayout (§7.3). Durable PROCESSING state is committed
 * BEFORE the remote call; the provider is called outside any transaction.
 */
async function processInstructorPayout(db, payoutId, provider, { enqueue } = {}) {
  const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
  if (!payout) throw new Error(`payout ${payoutId} not found`);
  if (payout.status === 'SUCCEEDED' || payout.status === 'FAILED') return { finalized: payout.status };
  if (payout.status === 'VERIFY') return { handedTo: 'reconciliation' };
  if (payout.status === 'PROCESSING') return { skipped: 'already_in_flight' };

  const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(payout.instructor_id);

  db.transaction(() => {
    db.prepare("UPDATE payouts SET status = 'PROCESSING', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status = 'PENDING'")
      .run(nowIso(), payoutId);
    emit(db, 'payout.provider_called', 'payout', payoutId, {
      idempotencyKey: payout.idempotency_key, attempt: payout.attempt_count + 1,
    });
  })();

  try {
    const result = await provider.createPayout(
      payout.idempotency_key, instructor.provider_account_id, payout.amount_minor, payout.currency,
    );
    finalizeSuccess(db, payoutId, result.providerTxnId);
    return { finalized: 'SUCCEEDED', providerTxnId: result.providerTxnId };
  } catch (err) {
    if (err.name === 'ProviderTimeoutError') {
      db.transaction(() => {
        db.prepare("UPDATE payouts SET status = 'VERIFY', updated_at = ? WHERE id = ? AND status = 'PROCESSING'")
          .run(nowIso(), payoutId);
        emit(db, 'payout.verification_started', 'payout', payoutId, { idempotencyKey: payout.idempotency_key });
      })();
      if (enqueue) enqueue('reconcile_payout', { payoutId }, { delaySec: 2, key: `reconcile_${payoutId}` });
      return { finalized: 'VERIFY' };
    }
    if (err.name === 'ProviderPermanentFailureError') {
      failPayout(db, payoutId, err.message);
      return { finalized: 'FAILED' };
    }
    throw err; // unexpected: job layer will retry
  }
}

/** Idempotent success finalization: reserved -> paid, exactly once. */
function finalizeSuccess(db, payoutId, providerTxnId) {
  return db.transaction(() => {
    const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
    if (!payout) throw new Error(`payout ${payoutId} not found`);
    if (payout.status === 'SUCCEEDED') return { alreadyFinalized: true };
    if (payout.status !== 'PROCESSING' && payout.status !== 'VERIFY') {
      throw new Error(`cannot finalize payout ${payoutId} in state ${payout.status}`);
    }
    const items = db.prepare('SELECT * FROM payout_items WHERE payout_id = ?').all(payoutId);
    const bump = db.prepare('UPDATE revenue_allocations SET paid_minor = paid_minor + ? WHERE id = ?');
    for (const it of items) bump.run(it.amount_minor, it.allocation_id);

    db.prepare(
      `UPDATE instructor_balances
          SET reserved_minor = reserved_minor - ?, paid_minor = paid_minor + ?, updated_at = ?
        WHERE instructor_id = ?`,
    ).run(payout.amount_minor, payout.amount_minor, nowIso(), payout.instructor_id);

    db.prepare(
      `UPDATE payouts SET status = 'SUCCEEDED', provider_transaction_id = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    ).run(providerTxnId || null, nowIso(), nowIso(), payoutId);
    emit(db, 'payout.succeeded', 'payout', payoutId, { amount: payout.amount_minor, providerTxnId });
    return { finalized: true };
  })();
}

/** Permanent failure: release the reservation so the amount becomes payable again. */
function failPayout(db, payoutId, reason) {
  return db.transaction(() => {
    const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
    if (!payout) throw new Error(`payout ${payoutId} not found`);
    if (payout.status === 'FAILED') return { alreadyFailed: true };
    if (payout.status !== 'PROCESSING' && payout.status !== 'PENDING' && payout.status !== 'VERIFY') {
      throw new Error(`cannot fail payout ${payoutId} in state ${payout.status}`);
    }
    db.prepare(
      'UPDATE instructor_balances SET reserved_minor = reserved_minor - ?, updated_at = ? WHERE instructor_id = ?',
    ).run(payout.amount_minor, nowIso(), payout.instructor_id);
    db.prepare(
      "UPDATE payouts SET status = 'FAILED', failure_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ).run(reason || 'provider failure', nowIso(), nowIso(), payoutId);
    emit(db, 'payout.failed', 'payout', payoutId, { amount: payout.amount_minor, reason });
    return { failed: true };
  })();
}

/**
 * ReconcilePayout (§7.3 + §13.2). Resolves uncertain payouts using the
 * ORIGINAL idempotency key. Never creates a second payment intent.
 *  - VERIFY: ask provider for status; UNKNOWN -> retry later with backoff.
 *  - stale PROCESSING (worker died mid-call): replay create with the same key.
 */
async function reconcilePayout(db, payoutId, provider, { staleProcessingSec = 30, maxVerifyAttempts = 6, enqueue } = {}) {
  const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
  if (!payout) return { skipped: 'not_found' };
  if (payout.status === 'SUCCEEDED' || payout.status === 'FAILED') return { alreadyTerminal: payout.status };
  const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(payout.instructor_id);

  if (payout.status === 'VERIFY') {
    const st = provider.getPayoutStatus(payout.idempotency_key);
    if (st.status === 'SUCCESS') {
      finalizeSuccess(db, payoutId, st.providerTxnId);
      emit(db, 'payout.reconciled', 'payout', payoutId, { outcome: 'SUCCEEDED' });
      return { reconciled: 'SUCCEEDED' };
    }
    if (st.status === 'FAILED') {
      failPayout(db, payoutId, 'provider reported failure during reconciliation');
      emit(db, 'payout.reconciled', 'payout', payoutId, { outcome: 'FAILED' });
      return { reconciled: 'FAILED' };
    }
    // UNKNOWN: keep the reservation, retry with backoff.
    if (payout.attempt_count < maxVerifyAttempts && enqueue) {
      const backoff = Math.min(60, 2 ** payout.attempt_count);
      enqueue('reconcile_payout', { payoutId }, { delaySec: backoff, key: `reconcile_${payoutId}` });
      return { stillUncertain: true, nextRetryInSec: backoff };
    }
    emit(db, 'payout.alert', 'payout', payoutId, { message: 'uncertain beyond retry budget — operator review required' });
    return { alertRaised: true };
  }

  if (payout.status === 'PROCESSING') {
    const ageSec = (Date.now() - new Date(payout.updated_at).getTime()) / 1000;
    if (ageSec < staleProcessingSec) return { skipped: 'still_fresh' };
    // Crash repair: replay with the SAME idempotency key — the provider's
    // idempotent store guarantees at most one money movement per key.
    const st = provider.getPayoutStatus(payout.idempotency_key);
    if (st.status === 'SUCCESS') {
      finalizeSuccess(db, payoutId, st.providerTxnId);
      emit(db, 'payout.reconciled', 'payout', payoutId, { outcome: 'SUCCEEDED', via: 'crash_repair' });
      return { reconciled: 'SUCCEEDED' };
    }
    if (st.status === 'FAILED') {
      failPayout(db, payoutId, 'provider reported failure (stale processing)');
      return { reconciled: 'FAILED' };
    }
    try {
      const result = await provider.createPayout(
        payout.idempotency_key, instructor.provider_account_id, payout.amount_minor, payout.currency,
      );
      finalizeSuccess(db, payoutId, result.providerTxnId);
      return { reconciled: 'SUCCEEDED' };
    } catch (err) {
      if (err.name === 'ProviderTimeoutError') {
        db.prepare("UPDATE payouts SET status = 'VERIFY', updated_at = ? WHERE id = ?").run(nowIso(), payoutId);
        if (enqueue) enqueue('reconcile_payout', { payoutId }, { delaySec: 2, key: `reconcile_${payoutId}` });
        return { movedTo: 'VERIFY' };
      }
      if (err.name === 'ProviderPermanentFailureError') {
        failPayout(db, payoutId, err.message);
        return { reconciled: 'FAILED' };
      }
      throw err;
    }
  }

  return { skipped: `unexpected_status_${payout.status}` };
}

/* ------------------------------------------------------------------ */
/* Commands (§7.2): safe to re-run, never call the provider directly   */
/* ------------------------------------------------------------------ */

/** `php artisan revenue:payouts` analogue. */
function revenuePayoutsCommand(db, { enqueue, instructorId = null, asOf = new Date() } = {}) {
  if (instructorId) recognizeForInstructor(db, instructorId, asOf);
  else recognizeAll(db, asOf);

  const balances = db.prepare(
    `SELECT b.instructor_id, (b.earned_minor - b.paid_minor - b.reserved_minor) AS available
       FROM instructor_balances b
       JOIN instructors i ON i.id = b.instructor_id
      WHERE i.status = 'active'`,
  ).all();

  const eligible = balances.filter(
    (b) => b.available > 0 && (instructorId == null || b.instructor_id === instructorId),
  );
  let dispatched = 0;
  for (const b of eligible) {
    if (activePayoutFor(db, b.instructor_id)) continue;
    if (enqueue) {
      enqueue('prepare_instructor_payout', { instructorId: b.instructor_id }, { key: `prep_${b.instructor_id}` });
      dispatched++;
    }
  }
  return { dispatched, recognized: true };
}

/** `reconcile` sweep: VERIFY payouts + stale PROCESSING payouts. */
function reconcileCommand(db, { enqueue, staleProcessingSec = 30 } = {}) {
  const targets = db.prepare(
    `SELECT id FROM payouts
      WHERE status = 'VERIFY'
         OR (status = 'PROCESSING' AND updated_at <= datetime('now', ?))`,
  ).all(`-${Math.floor(staleProcessingSec)} seconds`);
  for (const t of targets) {
    if (enqueue) enqueue('reconcile_payout', { payoutId: t.id }, { key: `reconcile_${t.id}` });
  }
  return { dispatched: targets.length };
}

module.exports = {
  subscribe,
  recognizeForInstructor, recognizeAll, earnedFor, allocationBase,
  refundSubscription,
  prepareInstructorPayout, processInstructorPayout, finalizeSuccess, failPayout,
  reconcilePayout, revenuePayoutsCommand, reconcileCommand, activePayoutFor,
  ACTIVE_PAYOUT_STATES,
};
