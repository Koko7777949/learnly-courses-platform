'use strict';
/**
 * Behavioral tests (§10.2): double-run safety, retry safety,
 * timeout-after-success safety, failure release, refund policy,
 * concurrency, and balance invariants.
 */
const test = require('node:test');
const assert = require('node:assert');
const ledger = require('../src/ledger');
const { makeProvider } = require('../src/provider');
const { tempDb, makeFixture, setScenario, fakeQueue } = require('./helpers');

function setup(scenario = 'success') {
  const db = tempDb();
  const fx = makeFixture(db);
  setScenario(db, scenario);
  const provider = makeProvider(db, { latencyMs: 0 });
  const q = fakeQueue();
  return { db, fx, provider, q };
}

function subscribe3MonthsAgo(db, fx, daysAgo = 90) {
  const starts = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return ledger.subscribe(db, { userId: fx.studentId, planId: fx.planId, startsAt: starts });
}

test('checkout: allocation sums exactly to distributable', () => {
  const { db, fx } = setup();
  const { subscriptionId } = ledger.subscribe(db, { userId: fx.studentId, planId: fx.planId });
  const pay = db.prepare('SELECT * FROM subscription_payments WHERE subscription_id = ?').get(subscriptionId);
  assert.equal(pay.gross_minor, 10000);
  assert.equal(pay.platform_fee_minor, 1000);
  assert.equal(pay.distributable_minor, 9000);
  const allocs = db.prepare('SELECT * FROM revenue_allocations WHERE payment_id = ?').all(pay.id);
  assert.equal(allocs.length, 3);
  const sum = allocs.reduce((s, a) => s + a.allocated_minor, 0);
  assert.equal(sum, 9000); // invariant: Σ allocated == distributable exactly
});

test('checkout: idempotency key replay returns same subscription', () => {
  const { db, fx } = setup();
  const a = ledger.subscribe(db, { userId: fx.studentId, planId: fx.planId, requestIdempotencyKey: 'k1' });
  const b = ledger.subscribe(db, { userId: fx.studentId, planId: fx.planId, requestIdempotencyKey: 'k1' });
  assert.equal(a.subscriptionId, b.subscriptionId);
  assert.ok(b.idempotentReplay);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 1);
});

test('recognition: mid-term posts only the earned delta', () => {
  const { db, fx } = setup();
  subscribe3MonthsAgo(db, fx, 45); // halfway through a 3-month (~90d) term
  const [i1] = fx.instructors;
  const posted = ledger.recognizeForInstructor(db, i1);
  const alloc = db.prepare('SELECT * FROM revenue_allocations WHERE instructor_id = ?').get(i1);
  assert.ok(posted > 0);
  assert.equal(alloc.recognized_minor, posted);
  assert.ok(alloc.recognized_minor > 0 && alloc.recognized_minor < alloc.allocated_minor);
  // second run at same instant posts nothing
  assert.equal(ledger.recognizeForInstructor(db, i1), 0);
});

test('payout: full happy path reserves then settles; balance math holds', () => {
  const { db, fx, provider, q } = setup();
  subscribe3MonthsAgo(db, fx, 120); // term fully elapsed -> everything earned
  const [i1] = fx.instructors;

  const prep = ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue });
  assert.ok(prep.payoutId, 'expected a payout');
  let bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(i1);
  assert.equal(bal.reserved_minor, prep.amount);
  assert.equal(bal.earned_minor - bal.paid_minor - bal.reserved_minor, 0);

  return ledger.processInstructorPayout(db, prep.payoutId, provider).then((r) => {
    assert.equal(r.finalized, 'SUCCEEDED');
    bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(i1);
    assert.equal(bal.reserved_minor, 0);
    assert.equal(bal.paid_minor, prep.amount);
    assert.equal(bal.earned_minor, bal.paid_minor);
    const txns = db.prepare('SELECT COUNT(*) AS n FROM provider_transactions').get().n;
    assert.equal(txns, 1);
  });
});

test('payout: running the pipeline twice never double-pays (§10.2 #1, #2)', async () => {
  const { db, fx, provider, q } = setup();
  subscribe3MonthsAgo(db, fx, 120);
  const [i1] = fx.instructors;

  const r1 = ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue });
  assert.ok(r1.payoutId);
  // Second preparation while one is active -> no-op
  const r2 = ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue });
  assert.equal(r2.skipped, 'active_payout_exists');

  await ledger.processInstructorPayout(db, r1.payoutId, provider);
  // Processing the same payout again is an idempotent no-op
  const again = await ledger.processInstructorPayout(db, r1.payoutId, provider);
  assert.equal(again.finalized, 'SUCCEEDED');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payouts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_transactions').get().n, 1);
  const allocs = db.prepare('SELECT * FROM revenue_allocations WHERE instructor_id = ?').all(i1);
  for (const a of allocs) assert.equal(a.paid_minor, a.recognized_minor);
});

test('payout: timeout-after-success goes to VERIFY, reconciliation finalizes exactly once (§10.2 #3)', async () => {
  const { db, fx, provider, q } = setup('timeout_after_success');
  subscribe3MonthsAgo(db, fx, 120);
  const [i1] = fx.instructors;

  const prep = ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue });
  const r = await ledger.processInstructorPayout(db, prep.payoutId, provider, { enqueue: q.enqueue });
  assert.equal(r.finalized, 'VERIFY');
  let payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(prep.payoutId);
  assert.equal(payout.status, 'VERIFY');
  // reservation stays held while uncertain
  const bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(i1);
  assert.equal(bal.reserved_minor, prep.amount);

  // reconciliation discovers the provider-side success via the same key
  const rec = await ledger.reconcilePayout(db, prep.payoutId, provider);
  assert.equal(rec.reconciled, 'SUCCEEDED');
  payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(prep.payoutId);
  assert.equal(payout.status, 'SUCCEEDED');
  assert.ok(payout.provider_transaction_id);

  // exactly one provider transaction for the key — no second payment
  const key = payout.idempotency_key;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_transactions WHERE idempotency_key = ?').get(key).n, 1);
});

test('payout: crash after provider success is repaired by replay (§10.2 #4)', async () => {
  const { db, fx, provider, q } = setup('success');
  subscribe3MonthsAgo(db, fx, 120);
  const [i1] = fx.instructors;

  const prep = ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue });
  const payoutBefore = db.prepare('SELECT * FROM payouts WHERE id = ?').get(prep.payoutId);
  // simulate: worker marked PROCESSING, provider moved money, worker died before finalizing
  db.prepare("UPDATE payouts SET status = 'PROCESSING', updated_at = datetime('now','-2 minutes') WHERE id = ?").run(prep.payoutId);
  await provider.createPayout(payoutBefore.idempotency_key, 'acct_1', payoutBefore.amount_minor, 'USD');

  const rec = await ledger.reconcilePayout(db, prep.payoutId, provider, { staleProcessingSec: 30 });
  assert.equal(rec.reconciled, 'SUCCEEDED');
  // replay reused the same key -> still exactly one provider transaction
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_transactions').get().n, 1);
});

test('payout: permanent failure releases reservation; later run pays again (§10.2 #6)', async () => {
  const { db, fx, provider, q } = setup('permanent_failure');
  subscribe3MonthsAgo(db, fx, 120);
  const [i1] = fx.instructors;

  const prep = ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue });
  const r = await ledger.processInstructorPayout(db, prep.payoutId, provider);
  assert.equal(r.finalized, 'FAILED');
  let bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(i1);
  assert.equal(bal.reserved_minor, 0, 'reservation released');
  assert.equal(bal.earned_minor - bal.paid_minor - bal.reserved_minor, bal.earned_minor, 'earnings payable again');

  // provider recovers -> a NEW payout intent settles the same earnings
  setScenario(db, 'success');
  const prep2 = ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue });
  assert.ok(prep2.payoutId && prep2.payoutId !== prep.payoutId);
  await ledger.processInstructorPayout(db, prep2.payoutId, provider);
  bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(i1);
  assert.equal(bal.paid_minor, bal.earned_minor);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE status = 'FAILED'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE status = 'SUCCEEDED'").get().n, 1);
});

test('payouts: two concurrent claims for one instructor cannot double-reserve (§10.2 #5)', async () => {
  const { db, fx, provider, q } = setup();
  subscribe3MonthsAgo(db, fx, 120);
  const [i1] = fx.instructors;

  // Two workers race for the same balance.
  const results = await Promise.all([
    Promise.resolve().then(() => ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue })),
    Promise.resolve().then(() => ledger.prepareInstructorPayout(db, i1, { enqueue: q.enqueue })),
  ]);
  const claimed = results.filter((r) => r.payoutId);
  assert.equal(claimed.length, 1, 'exactly one claim wins');
  const bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(i1);
  assert.equal(bal.reserved_minor, claimed[0].amount, 'reserved exactly once');
});

test('refund: only unearned revenue is affected; recognized revenue is never clawed back (§10.2 #7)', () => {
  const { db, fx } = setup();
  const { subscriptionId } = subscribe3MonthsAgo(db, fx, 45); // ~half elapsed
  ledger.recognizeAll(db);
  const before = db.prepare('SELECT instructor_id, recognized_minor FROM revenue_allocations ORDER BY instructor_id').all();

  const result = ledger.refundSubscription(db, subscriptionId, 'test');
  assert.ok(result.refundMinor > 0);
  assert.ok(result.clawback > 0);
  assert.ok(result.clawback <= result.unearnedCap);

  // recognized amounts unchanged — no clawback
  const after = db.prepare('SELECT instructor_id, recognized_minor FROM revenue_allocations ORDER BY instructor_id').all();
  assert.deepEqual(after, before);

  // refunded_minor was applied against unearned only
  const allocs = db.prepare('SELECT * FROM revenue_allocations').all();
  for (const a of allocs) {
    assert.ok(a.refunded_minor >= 0);
    assert.ok(a.allocated_minor - a.refunded_minor >= a.recognized_minor,
      'post-refund base must still cover what was recognized');
  }

  // future recognition continues from the reduced base without going backwards
  const [i1] = fx.instructors;
  const bal = db.prepare('SELECT earned_minor FROM instructor_balances WHERE instructor_id = ?').get(i1);
  ledger.recognizeForInstructor(db, i1);
  const bal2 = db.prepare('SELECT earned_minor FROM instructor_balances WHERE instructor_id = ?').get(i1);
  assert.ok(bal2.earned_minor >= bal.earned_minor, 'recognition never decreases after a refund');
});

test('refund: cap — refund larger than unearned never touches instructors beyond the cap', () => {
  const { db, fx } = setup();
  const { subscriptionId } = subscribe3MonthsAgo(db, fx, 85); // nearly fully earned
  ledger.recognizeAll(db);
  const cap = db.prepare(
    'SELECT SUM(allocated_minor - recognized_minor) AS v FROM revenue_allocations',
  ).get().v;
  const result = ledger.refundSubscription(db, subscriptionId, 'late refund');
  assert.ok(result.clawback <= cap, 'clawback capped at unearned');
});

test('command: revenuePayoutsCommand dispatches one job per eligible instructor, idempotently', () => {
  const { db, fx, q } = setup();
  subscribe3MonthsAgo(db, fx, 120);
  ledger.revenuePayoutsCommand(db, { enqueue: q.enqueue });
  const n1 = q.jobs.length;
  assert.equal(n1, fx.instructors.length);
  // running again with jobs still queued dedupes via unique job keys
  ledger.revenuePayoutsCommand(db, { enqueue: q.enqueue });
  assert.equal(q.jobs.length, n1, 'no duplicate dispatch while queued');
});

test('invariant: balances always equal earned - paid - reserved from source rows', async () => {
  const { db, fx, provider, q } = setup();
  subscribe3MonthsAgo(db, fx, 30);
  subscribe3MonthsAgo(db, fx, 120);
  ledger.recognizeAll(db);
  for (const i of fx.instructors) {
    const prep = ledger.prepareInstructorPayout(db, i, { enqueue: q.enqueue });
    if (prep.payoutId) await ledger.processInstructorPayout(db, prep.payoutId, provider);
    const bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(i);
    const fromAllocs = db.prepare(
      'SELECT SUM(recognized_minor) AS r, SUM(paid_minor) AS p FROM revenue_allocations WHERE instructor_id = ?',
    ).get(i);
    const reserved = db.prepare(
      `SELECT COALESCE(SUM(pi.amount_minor),0) AS v FROM payout_items pi
        JOIN payouts p ON p.id = pi.payout_id
        JOIN revenue_allocations ra ON ra.id = pi.allocation_id
       WHERE ra.instructor_id = ? AND p.status IN ('PENDING','PROCESSING','VERIFY')`,
    ).get(i).v;
    assert.equal(bal.earned_minor, fromAllocs.r || 0);
    assert.equal(bal.paid_minor, fromAllocs.p || 0);
    assert.equal(bal.reserved_minor, reserved);
  }
});
