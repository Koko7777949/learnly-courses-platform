'use strict';
/**
 * HTTP layer — Express. Thin controller layer over the ledger engine.
 * All money-moving behavior lives in src/ledger.js; this file only maps
 * HTTP <-> domain calls and enforces auth/roles.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const { getDb, nowIso, emit } = require('../src/db');
const ledger = require('../src/ledger');
const { makeProvider } = require('../src/provider');
const { enqueue, makeWorker } = require('../src/queue');
const auth = require('../src/auth');
const { earnedFor } = require('../src/ledger');

const db = getDb();
const provider = makeProvider(db);
const app = express();
app.use(compression());
app.use(express.json({ limit: '200kb' }));
app.use(auth.authMiddleware(db));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: String(err && err.message || err) });
  });
};

/* ---------------- queue wiring ---------------- */
const handlers = {
  prepare_instructor_payout: async ({ instructorId }) =>
    ledger.prepareInstructorPayout(db, instructorId, { enqueue: enq }),
  process_instructor_payout: async ({ payoutId }) =>
    ledger.processInstructorPayout(db, payoutId, provider, { enqueue: enq }),
  reconcile_payout: async ({ payoutId }) =>
    ledger.reconcilePayout(db, payoutId, provider, { enqueue: enq, staleProcessingSec: 20 }),
};
function enq(type, payload, opts) { return enqueue(db, type, payload, opts); }
const worker = makeWorker(db, handlers);

/* ---------------- public catalog ---------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/plans', wrap((_req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY term_months').all();
  const coursesBy = {};
  for (const r of db.prepare(
    `SELECT pc.plan_id, c.title FROM plan_courses pc JOIN courses c ON c.id = pc.course_id ORDER BY c.title`,
  ).all()) (coursesBy[r.plan_id] ||= []).push(r.title);
  res.json(plans.map((p) => ({
    ...p,
    course_count: (coursesBy[p.id] || []).length,
    course_titles: coursesBy[p.id] || [],
  })));
}));

app.get('/api/catalog', wrap((_req, res) => {
  const courses = db.prepare('SELECT * FROM courses ORDER BY students_count DESC').all();
  const cis = db.prepare(
    `SELECT ci.course_id, i.id AS instructor_id, i.display_name, ci.weight
       FROM course_instructors ci JOIN instructors i ON i.id = ci.instructor_id`,
  ).all();
  const byCourse = {};
  for (const ci of cis) (byCourse[ci.course_id] ||= []).push(ci);
  const ratings = Object.fromEntries(db.prepare(
    'SELECT course_id, ROUND(AVG(rating),1) AS avg, COUNT(*) AS n FROM reviews GROUP BY course_id',
  ).all().map((r) => [r.course_id, r]));
  const lessonCounts = Object.fromEntries(
    db.prepare('SELECT course_id, COUNT(*) AS n FROM lessons GROUP BY course_id').all().map((r) => [r.course_id, r.n]),
  );
  const totalMin = Object.fromEntries(
    db.prepare('SELECT course_id, SUM(duration_min) AS m FROM lessons GROUP BY course_id').all().map((r) => [r.course_id, r.m]),
  );
  const fromPrice = Object.fromEntries(db.prepare(
    `SELECT pc.course_id, MIN(p.price_minor) AS m FROM plan_courses pc
       JOIN plans p ON p.id = pc.plan_id WHERE p.active = 1 GROUP BY pc.course_id`,
  ).all().map((r) => [r.course_id, r.m]));
  res.json(courses.map((c) => ({
    ...c,
    what_you_learn: JSON.parse(c.what_you_learn || '[]'),
    instructors: byCourse[c.id] || [],
    rating_avg: ratings[c.id]?.avg ?? 0,
    rating_count: ratings[c.id]?.n ?? 0,
    lesson_count: lessonCounts[c.id] || 0,
    total_minutes: totalMin[c.id] || 0,
    from_minor: fromPrice[c.id] || null,
  })));
}));

app.get('/api/search', wrap((req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const rows = db.prepare(
    `SELECT DISTINCT c.*
       FROM courses c
       LEFT JOIN course_instructors ci ON ci.course_id = c.id
       LEFT JOIN instructors i ON i.id = ci.instructor_id
      WHERE lower(c.title) LIKE ? OR lower(c.tagline) LIKE ? OR lower(c.category) LIKE ?
         OR lower(i.display_name) LIKE ?
      ORDER BY c.students_count DESC`,
  ).all(q, q, q, q);
  res.json(rows);
}));

app.get('/api/courses/:slug', wrap((req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(req.params.slug);
  if (!course) return res.status(404).json({ error: 'course not found' });
  const instructors = db.prepare(
    `SELECT i.*, ci.weight FROM course_instructors ci
       JOIN instructors i ON i.id = ci.instructor_id WHERE ci.course_id = ?`,
  ).all(course.id).map((i) => {
    const stats = db.prepare(
      `SELECT COALESCE(SUM(c2.students_count),0) AS students,
              (SELECT COUNT(*) FROM reviews r JOIN course_instructors ci2 ON ci2.course_id = r.course_id
                WHERE ci2.instructor_id = ?) AS reviews
         FROM course_instructors ci3 JOIN courses c2 ON c2.id = ci3.course_id
        WHERE ci3.instructor_id = ?`,
    ).get(i.id, i.id);
    return { ...i, total_students: stats.students, total_reviews: stats.reviews };
  });
  const lessons = db.prepare('SELECT id, position, section, title, duration_min FROM lessons WHERE course_id = ? ORDER BY position').all(course.id);
  const sections = [];
  for (const l of lessons) {
    const s = sections.find((x) => x.title === l.section);
    if (s) s.lessons.push(l); else sections.push({ title: l.section, lessons: [l] });
  }
  const rating = db.prepare('SELECT ROUND(AVG(rating),1) AS avg, COUNT(*) AS n FROM reviews WHERE course_id = ?').get(course.id);
  const bars = db.prepare('SELECT rating, COUNT(*) AS n FROM reviews WHERE course_id = ? GROUP BY rating ORDER BY rating DESC').all(course.id);
  const reviews = db.prepare(
    `SELECT r.*, u.name AS reviewer_name FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.course_id = ? ORDER BY r.id DESC LIMIT 30`,
  ).all(course.id);
  const inPlans = db.prepare(
    `SELECT p.id, p.code, p.name, p.price_minor, p.term_months FROM plan_courses pc JOIN plans p ON p.id = pc.plan_id
      WHERE pc.course_id = ? AND p.active = 1 ORDER BY p.term_months`,
  ).all(course.id);
  let hasAccess = false;
  if (req.user) {
    hasAccess = !!db.prepare(
      `SELECT 1 FROM subscriptions s JOIN plan_courses pc ON pc.plan_id = s.plan_id
        WHERE s.user_id = ? AND s.status = 'active' AND s.ends_at > ? AND pc.course_id = ? LIMIT 1`,
    ).get(req.user.id, nowIso(), course.id);
  }
  res.json({
    ...course,
    what_you_learn: JSON.parse(course.what_you_learn || '[]'),
    requirements: JSON.parse(course.requirements || '[]'),
    instructors, sections, reviews,
    rating_avg: rating.avg ?? 0, rating_count: rating.n ?? 0, rating_bars: bars,
    plans: inPlans, hasAccess,
  });
}));

/* ---------------- auth ---------------- */
const setCookie = (res, token) => {
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
};

app.post('/api/auth/signup', wrap((req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) {
    return res.status(422).json({ error: 'name, email and a password of 8+ characters are required' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'email already registered' });
  }
  const id = Number(db.prepare(
    'INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,?)',
  ).run(name, email, auth.hashPassword(password), 'student', nowIso()).lastInsertRowid);
  const { token, user } = auth.login(db, email, password);
  setCookie(res, token);
  res.json({ user });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const result = auth.login(db, email || '', password || '');
  if (!result) return res.status(401).json({ error: 'invalid credentials' });
  setCookie(res, result.token);
  res.json({ user: result.user });
}));

app.post('/api/auth/logout', wrap((req, res) => {
  const token = auth.parseCookies(req.headers.cookie).session;
  auth.logout(db, token);
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
}));

app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));

/* ---------------- student ---------------- */
app.post('/api/checkout', auth.requireAuth, wrap((req, res) => {
  const { plan_id, idempotency_key } = req.body || {};
  const result = ledger.subscribe(db, { userId: req.user.id, planId: Number(plan_id), requestIdempotencyKey: idempotency_key });
  res.json(result);
}));

app.get('/api/my/subscriptions', auth.requireAuth, wrap((req, res) => {
  const rows = db.prepare(
    `SELECT s.*, p.name AS plan_name, p.term_months
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = ? ORDER BY s.id DESC`,
  ).all(req.user.id);
  const now = new Date();
  res.json(rows.map((s) => ({
    ...s,
    isCurrent: s.status === 'active' && new Date(s.ends_at) > now,
    remainingDays: Math.max(0, Math.ceil((new Date(s.ends_at) - now) / 86400000)),
  })));
}));

app.get('/api/my/courses', auth.requireAuth, wrap((req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT c.*, s.id AS subscription_id, s.ends_at
       FROM subscriptions s
       JOIN plan_courses pc ON pc.plan_id = s.plan_id
       JOIN courses c ON c.id = pc.course_id
      WHERE s.user_id = ? AND s.status = 'active' AND s.ends_at > ?
      ORDER BY c.title`,
  ).all(req.user.id, nowIso());
  res.json(rows);
}));

app.get('/api/lessons/:id', auth.requireAuth, wrap((req, res) => {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
  if (!lesson) return res.status(404).json({ error: 'lesson not found' });
  const access = db.prepare(
    `SELECT 1 FROM subscriptions s JOIN plan_courses pc ON pc.plan_id = s.plan_id
      WHERE s.user_id = ? AND s.status = 'active' AND s.ends_at > ? AND pc.course_id = ? LIMIT 1`,
  ).get(req.user.id, nowIso(), lesson.course_id);
  if (!access) return res.status(402).json({ error: 'an active subscription covering this course is required' });
  res.json(lesson);
}));

app.post('/api/my/subscriptions/:id/refund', auth.requireAuth, wrap((req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!sub || sub.user_id !== req.user.id) return res.status(404).json({ error: 'subscription not found' });
  const result = ledger.refundSubscription(db, Number(req.params.id), 'student request');
  res.json(result);
}));

/* ---------------- instructor dashboard ---------------- */
function instructorForUser(userId) {
  return db.prepare('SELECT * FROM instructors WHERE user_id = ?').get(userId);
}

app.get('/api/instructor/dashboard', auth.requireAuth, wrap((req, res) => {
  const inst = instructorForUser(req.user.id);
  if (!inst) return res.status(403).json({ error: 'not an instructor' });
  ledger.recognizeForInstructor(db, inst.id); // keep dashboard live
  const bal = db.prepare('SELECT * FROM instructor_balances WHERE instructor_id = ?').get(inst.id)
    || { earned_minor: 0, paid_minor: 0, reserved_minor: 0, currency: 'USD' };
  const available = bal.earned_minor - bal.paid_minor - bal.reserved_minor;
  const allocations = db.prepare(
    `SELECT ra.*, sp.weight, s.id AS subscription_id, u.name AS student_name, pl.name AS plan_name
       FROM revenue_allocations ra
       JOIN subscription_payments sp2 ON sp2.id = ra.payment_id
       JOIN subscriptions s ON s.id = sp2.subscription_id
       JOIN users u ON u.id = s.user_id
       JOIN plans pl ON pl.id = s.plan_id
       LEFT JOIN subscription_participants sp ON sp.subscription_id = s.id AND sp.instructor_id = ra.instructor_id
      WHERE ra.instructor_id = ? ORDER BY s.id DESC`,
  ).all(inst.id).map((a) => ({ ...a, earned_now: earnedFor(db, a, new Date()) }));
  const payouts = db.prepare('SELECT * FROM payouts WHERE instructor_id = ? ORDER BY id DESC LIMIT 25').all(inst.id);
  const courses = db.prepare(
    `SELECT c.*, ci.weight FROM course_instructors ci JOIN courses c ON c.id = ci.course_id
      WHERE ci.instructor_id = ? ORDER BY c.title`,
  ).all(inst.id);
  res.json({ instructor: inst, balance: { ...bal, available_minor: available }, allocations, payouts, courses });
}));

/* ---------------- admin / ops (Filament analogue, §11) ---------------- */
const admin = auth.requireRole('admin');

app.get('/api/admin/balances', admin, wrap((_req, res) => {
  ledger.recognizeAll(db);
  const rows = db.prepare(
    `SELECT i.id, i.display_name, i.provider_account_id, i.status,
            b.earned_minor, b.paid_minor, b.reserved_minor, b.currency,
            (b.earned_minor - b.paid_minor - b.reserved_minor) AS available_minor
       FROM instructors i LEFT JOIN instructor_balances b ON b.instructor_id = i.id
      ORDER BY i.id`,
  ).all();
  const last = db.prepare(
    `SELECT p.instructor_id, p.id AS payout_id, p.status, p.amount_minor, p.completed_at, p.created_at
       FROM payouts p JOIN (SELECT instructor_id, MAX(id) AS mid FROM payouts GROUP BY instructor_id) m
         ON m.instructor_id = p.instructor_id AND m.mid = p.id`,
  ).all();
  const lastBy = Object.fromEntries(last.map((l) => [l.instructor_id, l]));
  res.json(rows.map((r) => ({
    ...r,
    earned_minor: r.earned_minor || 0, paid_minor: r.paid_minor || 0, reserved_minor: r.reserved_minor || 0,
    available_minor: r.available_minor || 0, currency: r.currency || 'USD',
    last_payout: lastBy[r.id] || null,
  })));
}));

app.get('/api/admin/payouts', admin, wrap((req, res) => {
  const { status, from, to, instructor_id } = req.query;
  const where = []; const params = [];
  if (status && status !== 'ALL') { where.push('p.status = ?'); params.push(status); }
  if (from) { where.push('p.created_at >= ?'); params.push(from); }
  if (to) { where.push('p.created_at <= ?'); params.push(to + 'T23:59:59.999Z'); }
  if (instructor_id) { where.push('p.instructor_id = ?'); params.push(Number(instructor_id)); }
  const sql = `SELECT p.*, i.display_name FROM payouts p JOIN instructors i ON i.id = p.instructor_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 200`;
  res.json(db.prepare(sql).all(...params));
}));

app.get('/api/admin/payouts/:id', admin, wrap((req, res) => {
  const payout = db.prepare(
    'SELECT p.*, i.display_name FROM payouts p JOIN instructors i ON i.id = p.instructor_id WHERE p.id = ?',
  ).get(req.params.id);
  if (!payout) return res.status(404).json({ error: 'payout not found' });
  const items = db.prepare(
    `SELECT pi.*, ra.allocated_minor, ra.recognized_minor, ra.paid_minor, ra.refunded_minor,
            ra.term_start_at, ra.term_end_at, sp2.subscription_id, u.name AS student_name, pl.name AS plan_name
       FROM payout_items pi
       JOIN revenue_allocations ra ON ra.id = pi.allocation_id
       JOIN subscription_payments sp2 ON sp2.id = ra.payment_id
       JOIN subscriptions s ON s.id = sp2.subscription_id
       JOIN users u ON u.id = s.user_id
       JOIN plans pl ON pl.id = s.plan_id
      WHERE pi.payout_id = ?`,
  ).all(payout.id);
  res.json({ payout, items });
}));

app.get('/api/admin/subscriptions', admin, wrap((_req, res) => {
  res.json(db.prepare(
    `SELECT s.*, u.name AS student_name, p.name AS plan_name,
            sp.gross_minor AS payment_gross, sp.distributable_minor
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN plans p ON p.id = s.plan_id
       LEFT JOIN subscription_payments sp ON sp.subscription_id = s.id
      ORDER BY s.id DESC`,
  ).all());
}));

app.post('/api/admin/subscriptions/:id/refund', admin, wrap((req, res) => {
  const result = ledger.refundSubscription(db, Number(req.params.id), req.body?.reason || 'admin action');
  res.json(result);
}));

app.post('/api/admin/payouts/run', admin, wrap((req, res) => {
  const result = ledger.revenuePayoutsCommand(db, { enqueue: enq, instructorId: req.body?.instructor_id || null });
  res.json(result);
}));

app.post('/api/admin/reconcile/run', admin, wrap((_req, res) => {
  res.json(ledger.reconcileCommand(db, { enqueue: enq, staleProcessingSec: 5 }));
}));

app.get('/api/admin/events', admin, wrap((req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 60);
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit));
}));

app.get('/api/admin/provider', admin, wrap((_req, res) => {
  const scenario = db.prepare("SELECT value FROM provider_config WHERE key = 'scenario'").get()?.value || 'success';
  const overrides = db.prepare("SELECT key, value FROM provider_config WHERE key LIKE 'scenario_override:%'").all()
    .map((r) => ({ account: r.key.replace('scenario_override:', ''), scenario: r.value }));
  res.json({ scenario, overrides });
}));

app.post('/api/admin/provider', admin, wrap((req, res) => {
  const { scenario, account, remove_override } = req.body || {};
  const valid = ['success', 'permanent_failure', 'timeout_after_success'];
  if (account) {
    if (remove_override) {
      db.prepare('DELETE FROM provider_config WHERE key = ?').run(`scenario_override:${account}`);
    } else {
      if (!valid.includes(scenario)) return res.status(422).json({ error: 'invalid scenario' });
      db.prepare('INSERT INTO provider_config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(`scenario_override:${account}`, scenario);
    }
  } else if (scenario) {
    if (!valid.includes(scenario)) return res.status(422).json({ error: 'invalid scenario' });
    db.prepare('INSERT INTO provider_config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('scenario', scenario);
    emit(db, 'provider.scenario_changed', null, null, { scenario });
  }
  res.json({ ok: true });
}));

app.get('/api/admin/jobs', admin, wrap((_req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 100').all());
}));

app.get('/api/admin/totals', admin, wrap((_req, res) => {
  const t = (sql) => db.prepare(sql).get().v || 0;
  res.json({
    gross_collected: t('SELECT SUM(gross_minor) AS v FROM subscription_payments'),
    platform_fees: t('SELECT SUM(platform_fee_minor) AS v FROM subscription_payments'),
    distributable: t('SELECT SUM(distributable_minor) AS v FROM subscription_payments'),
    recognized: t('SELECT SUM(earned_minor) AS v FROM instructor_balances'),
    paid_out: t('SELECT SUM(paid_minor) AS v FROM instructor_balances'),
    reserved: t('SELECT SUM(reserved_minor) AS v FROM instructor_balances'),
    refunded_to_customers: t('SELECT SUM(refund_minor) AS v FROM refunds'),
    active_subscriptions: t("SELECT COUNT(*) AS v FROM subscriptions WHERE status='active' AND ends_at > datetime('now')"),
    payouts_succeeded: t("SELECT COUNT(*) AS v FROM payouts WHERE status='SUCCEEDED'"),
    payouts_failed: t("SELECT COUNT(*) AS v FROM payouts WHERE status='FAILED'"),
    payouts_uncertain: t("SELECT COUNT(*) AS v FROM payouts WHERE status IN ('VERIFY','PROCESSING','PENDING')"),
  });
}));

/* ---------------- static SPA (cached, compressed) ---------------- */
const dist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(dist, { maxAge: '1d', immutable: true }));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  const index = path.join(dist, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(503).send('Frontend not built yet. Run: npm run build');
});

const PORT = Number(process.env.PORT || 4000);
if (require.main === module) {
  worker.start();
  // Light-touch scheduler: reconciliation sweep every 5 minutes (§13.2).
  const sweep = setInterval(() => {
    try { ledger.reconcileCommand(db, { enqueue: enq, staleProcessingSec: 60 }); } catch { /* ignore */ }
  }, 5 * 60 * 1000);
  sweep.unref();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LMS Revenue Ledger listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { app, db, worker, enq };
