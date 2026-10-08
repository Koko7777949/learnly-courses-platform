'use strict';
/**
 * Seed: realistic catalog + reviews + financial history.
 *
 * Creates a marketplace-style catalog (course art, outcomes, curriculum
 * sections, instructor profiles, student reviews), then replays a believable
 * financial past: backdated subscriptions, a mid-term refund, a recognition
 * sweep 30 days ago, a successful payout cycle (payout history), and an
 * unpaid backdated subscription so the ops console has live work on boot.
 */
const path = require('path');
const fs = require('fs');
const { open, nowIso, emit } = require('../src/db');
const { hashPassword } = require('../src/auth');
const ledger = require('../src/ledger');
const { makeProvider } = require('../src/provider');
const { enqueue, makeWorker } = require('../src/queue');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'lms.sqlite');

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function seed(db) {
  const now = nowIso();
  const pw = hashPassword('password123');

  /* ---------- people ---------- */
  const insUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,?)',
  );
  insUser.run('Platform Admin', 'admin@platform.test', pw, 'admin', now);
  const linaUid = Number(insUser.run('Lina Ortiz', 'lina@platform.test', pw, 'instructor', now).lastInsertRowid);
  const omarUid = Number(insUser.run('Omar Haddad', 'omar@platform.test', pw, 'instructor', now).lastInsertRowid);
  const mayaUid = Number(insUser.run('Maya Chen', 'maya@platform.test', pw, 'instructor', now).lastInsertRowid);
  const saraUid = Number(insUser.run('Sara Mahmoud', 'sara@student.test', pw, 'student', now).lastInsertRowid);
  const tariqUid = Number(insUser.run('Tariq Nabil', 'tariq@student.test', pw, 'student', now).lastInsertRowid);
  const monaUid = Number(insUser.run('Mona Adel', 'mona@student.test', pw, 'student', now).lastInsertRowid);

  const reviewers = ['Karim Samir', 'Nour Hassan', 'Ali Farid', 'Yasmin Khaled', 'Hoda Mansour', 'Mostafa Zaki', 'Layla Adel', 'Omar Fathy']
    .map((n, i) => Number(insUser.run(n, `reviewer${i}@student.test`, pw, 'student', now).lastInsertRowid));

  const insInstr = db.prepare(
    `INSERT INTO instructors (user_id, display_name, title, bio, avatar, provider_account_id, status, created_at)
     VALUES (?,?,?,?,?,?,'active',?)`,
  );
  const lina = Number(insInstr.run(linaUid, 'Lina Ortiz',
    'Staff Frontend Engineer · previously Stripe & Vercel',
    'Lina has spent 11 years building design systems and payment UIs used by millions of people. She teaches React the way product teams actually use it: components first, hooks with discipline, and shipping as a habit.',
    '/instructors/lina.jpg', 'acct_lina_001', now).lastInsertRowid);
  const omar = Number(insInstr.run(omarUid, 'Omar Haddad',
    'Principal Backend Engineer · previously Amazon & Careem',
    'Omar designs APIs and distributed systems that survive real traffic. His courses focus on the unglamorous skills that separate senior engineers: transactions, queues, idempotency and graceful failure.',
    '/instructors/omar.jpg', 'acct_omar_002', now).lastInsertRowid);
  const maya = Number(insInstr.run(mayaUid, 'Maya Chen',
    'Senior Data Engineer · previously Spotify & Grab',
    'Maya has modeled data for products with hundreds of millions of users. She makes SQL intuitive: query plans you can read, indexes you can justify, and schemas your future self will thank you for.',
    '/instructors/maya.jpg', 'acct_maya_003', now).lastInsertRowid);

  /* ---------- catalog ---------- */
  const insCourse = db.prepare(
    `INSERT INTO courses (slug, title, tagline, description, level, category, image, accent,
       students_count, last_updated, what_you_learn, requirements, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const J = (v) => JSON.stringify(v);
  const courses = [
    ['modern-react', 'Modern React from Zero', 'Components, hooks and real app architecture — build and ship a complete React project.',
      'The most practical React course on Learnly. You will think in components, master hooks, route and load data like a production app, and finish by deploying a complete project with a code review from Lina.',
      'Beginner', 'Web Development', '/courses/react.jpg', '#6d28d9', 12842, '2026-08-14',
      J(['Think in components and compose UIs with confidence', 'Master useState, useEffect and custom hooks', 'Route, load and cache data like a production app', 'Structure state so it never fights you', 'Ship and deploy a complete React project']),
      J(['Basic JavaScript (variables, functions, arrays)', 'A code editor and Node.js installed'])],
    ['node-apis', 'Production Node.js APIs', 'Express, persistence, queues and observability — APIs that survive real traffic.',
      'Design REST APIs the way senior backend teams do: layered architecture, transactions and consistency, background jobs with retries, structured logging, and failure drills that build real confidence.',
      'Intermediate', 'Backend', '/courses/node.jpg', '#059669', 9310, '2026-07-02',
      J(['Design layered, testable Express services', 'Use transactions so data never lies', 'Add queues, retries and idempotency safely', 'Instrument APIs with structured logs', 'Run failure drills like a production team']),
      J(['Comfortable with JavaScript', 'Basic HTTP/REST concepts'])],
    ['sql-mastery', 'SQL & Data Modeling Mastery', 'From query plans to indexes to schema design — SQL that scales with your product.',
      'Deep, practical SQL. Read query plans like a story, choose indexes you can defend in review, make normalization trade-offs on purpose, and migrate schemas without fear.',
      'Intermediate', 'Data & Databases', '/courses/sql.jpg', '#b45309', 15477, '2026-09-01',
      J(['Read and reason about query plans', 'Choose indexes you can defend in review', 'Make normalization trade-offs on purpose', 'Migrate production schemas safely', 'Write analytics queries without melting the DB']),
      J(['Any programming experience', 'No prior SQL required'])],
    ['fullstack-capstone', 'Full-Stack Capstone', 'One product, end to end — schema, API, UI, billing, deploys — with two senior instructors.',
      'A guided capstone: build a billing-backed SaaS feature end to end. Schema and migrations, API and background jobs, a polished frontend, then deploy and run a blameless postmortem. Co-taught with reviews from both instructors.',
      'Advanced', 'Web Development', '/courses/capstone.jpg', '#7c3aed', 4216, '2026-09-20',
      J(['Turn a product spec into a working schema', 'Integrate billing without corrupting money data', 'Build API + background jobs that stay consistent', 'Polish a frontend to portfolio quality', 'Deploy, observe and run a postmortem']),
      J(['One of: Modern React or Production Node.js APIs', 'Git basics'])],
    ['system-design', 'System Design Interviews', 'Capacity math, storage, queues, caching and idempotency — the patterns interviewers ask for.',
      'The systems you get asked about, taught from first principles: estimate capacity honestly, pick storage for the workload, design queues and idempotent writes, and walk through full mock interviews with model answers.',
      'Advanced', 'Computer Science', '/courses/sysdesign.jpg', '#db2777', 8731, '2026-06-11',
      J(['Do capacity estimation without hand-waving', 'Choose storage and caching layers on purpose', 'Design idempotent, queue-based writes', 'Structure a 45-minute interview answer', 'Critique real architectures out loud']),
      J(['2+ years building software', 'Familiarity with one backend language'])],
    ['ts-deep-dive', 'TypeScript Deep Dive', 'Generics, conditional types, narrowing and declaration files — make the compiler work for you.',
      'Types that document and protect. You will narrow with confidence, write generics that read like prose, model APIs with conditional and mapped types, and ship type-safe boundaries across your whole app.',
      'Intermediate', 'Web Development', '/courses/ts.jpg', '#0891b2', 11095, '2026-08-28',
      J(['Narrow types until illegal states vanish', 'Write generics that read like prose', 'Model APIs with conditional and mapped types', 'Maintain declaration files without pain', 'Enforce type-safe API boundaries']),
      J(['Comfortable with JavaScript', 'Some TypeScript exposure helps'])],
  ];
  const courseIds = courses.map((c) => Number(insCourse.run(...c, now).lastInsertRowid));
  const [react, node, sql, capstone, sysdesign, ts] = courseIds;

  const insCI = db.prepare('INSERT INTO course_instructors (course_id, instructor_id, weight) VALUES (?,?,?)');
  insCI.run(react, lina, 1);
  insCI.run(node, omar, 1);
  insCI.run(sql, maya, 1);
  insCI.run(capstone, lina, 1); insCI.run(capstone, omar, 1);
  insCI.run(sysdesign, omar, 2); insCI.run(sysdesign, maya, 1);
  insCI.run(ts, maya, 1);

  /* ---------- curriculum with sections ---------- */
  const lessonDefs = {
    [react]: [
      ['Getting started', ['Thinking in components', 'Your first component tree']],
      ['Core React', ['State, props and data flow', 'Hooks in practice']],
      ['Building the app', ['Routing and data loading']],
      ['Shipping', ['Shipping the project']],
    ],
    [node]: [
      ['Foundations', ['Layered API architecture']],
      ['Consistency', ['Transactions and consistency']],
      ['Background work', ['Queues and retries']],
      ['Operating', ['Observability and logs', 'Failure drills']],
    ],
    [sql]: [
      ['Reading the engine', ['Query plans explained', 'Indexing strategy']],
      ['Design', ['Normalization in the real world', 'Schema migrations safely']],
      ['Scale', ['Analytics queries']],
    ],
    [capstone]: [
      ['Spec & schema', ['Product spec and schema']],
      ['Money', ['Billing integration']],
      ['Build', ['API + background jobs', 'Frontend and polish']],
      ['Launch', ['Deploy and postmortem']],
    ],
    [sysdesign]: [
      ['Estimation', ['Capacity estimation']],
      ['Building blocks', ['Storage choices', 'Queues and idempotency', 'Caching layers']],
      ['Practice', ['Full mock interview']],
    ],
    [ts]: [
      ['Thinking in types', ['Advanced narrowing']],
      ['The hard parts', ['Generics that read well', 'Conditional and mapped types']],
      ['At scale', ['Declaration files', 'Type-safe API boundaries']],
    ],
  };
  const insLesson = db.prepare(
    'INSERT INTO lessons (course_id, position, section, title, content, duration_min) VALUES (?,?,?,?,?,?)',
  );
  for (const [cid, sections] of Object.entries(lessonDefs)) {
    let pos = 0;
    for (const [section, titles] of sections) {
      for (const t of titles) {
        pos += 1;
        insLesson.run(Number(cid), pos, section, t,
          `Video walkthrough, annotated code samples and a hands-on exercise with a model solution. Topic: ${t.toLowerCase()}.`,
          12 + ((pos * 7) % 26));
      }
    }
  }

  /* ---------- plans ---------- */
  const insPlan = db.prepare(
    `INSERT INTO plans (code, name, description, term_months, price_minor, currency, platform_fee_bps, active)
     VALUES (?,?,?,?,?,'USD',?,1)`,
  );
  const starter = Number(insPlan.run('starter', 'Starter', 'The Starter bundle — 2 courses for one month.', 1, 2900, 1500).lastInsertRowid);
  const pro = Number(insPlan.run('pro', 'Pro', 'The Pro bundle — 4 courses for six months. Most popular.', 6, 14900, 1200).lastInsertRowid);
  const annual = Number(insPlan.run('annual', 'All-Access', 'Every course on Learnly for a full year.', 12, 24900, 1000).lastInsertRowid);

  const insPC = db.prepare('INSERT INTO plan_courses (plan_id, course_id) VALUES (?,?)');
  for (const c of [react, sql]) insPC.run(starter, c);
  for (const c of [react, node, sql, capstone]) insPC.run(pro, c);
  for (const c of courseIds) insPC.run(annual, c);

  /* ---------- reviews ---------- */
  const reviewDefs = [
    [react, 0, 5, 'Finally a React course that feels like a real job', 'No toy examples. By week two I was structuring a real app the way we do at work. The deployment lesson alone is worth it.'],
    [react, 1, 5, 'Best explanation of hooks I have found', 'I watched three other courses and hooks never clicked. Here they did, in one module.'],
    [react, 2, 4, 'Great, would love more testing content', 'Excellent pacing and exercises. I would add a module on testing, but that is my only note.'],
    [node, 3, 5, 'Changed how I design APIs', 'The transactions module should be mandatory for every backend dev. Failure drills were intense and amazing.'],
    [node, 4, 5, 'Queues finally make sense', 'Retries and idempotency explained with real consequences, not theory.'],
    [sql, 5, 5, 'I can read query plans now', 'Feels like a superpower. Our slow queries at work are getting fixed one by one.'],
    [sql, 0, 4, 'Dense but worth it', 'Harder than I expected — in a good way. The migrations module saved us during a real incident.'],
    [capstone, 1, 5, 'Like a real team, but guided', 'Two instructors reviewing your capstone is the closest thing to a senior mentor I have found online.'],
    [sysdesign, 2, 5, 'Passed my interviews', 'Used the capacity-estimation framework in two onsites. Both passed. Enough said.'],
    [sysdesign, 3, 4, 'Rigorous and practical', 'The mock interview module is brutal and exactly what you need.'],
    [ts, 4, 5, 'The compiler is now my friend', 'Generics stopped being scary around module two. Highly recommended.'],
    [ts, 5, 5, 'Type-safe boundaries changed our codebase', 'We applied the last module at work the same week. Fewer bugs, calmer reviews.'],
  ];
  const insReview = db.prepare(
    'INSERT INTO reviews (course_id, user_id, rating, title, body, created_at) VALUES (?,?,?,?,?,?)',
  );
  reviewDefs.forEach(([cid, uIdx, rating, title, body], i) => {
    insReview.run(cid, reviewers[uIdx], rating, title, body, daysAgoIso(3 + i * 9));
  });

  db.prepare("INSERT INTO provider_config (key, value) VALUES ('scenario', 'success')").run();

  /* ---------- financial history ---------- */
  const subAnnualSara = ledger.subscribe(db, { userId: saraUid, planId: annual, startsAt: daysAgoIso(100) });
  const subProTariq = ledger.subscribe(db, { userId: tariqUid, planId: pro, startsAt: daysAgoIso(40) });
  const subStarterMona = ledger.subscribe(db, { userId: monaUid, planId: starter, startsAt: daysAgoIso(10) });
  ledger.subscribe(db, { userId: monaUid, planId: pro, startsAt: daysAgoIso(210) });

  ledger.refundSubscription(db, subStarterMona.subscriptionId, 'demo: changed mind mid-term');

  ledger.recognizeAll(db, new Date(daysAgoIso(30)));
  const provider = makeProvider(db, { latencyMs: 0 });
  const enq = (type, payload, opts) => enqueue(db, type, payload, opts);
  const handlers = {
    prepare_instructor_payout: async ({ instructorId }) =>
      ledger.prepareInstructorPayout(db, instructorId, { enqueue: enq }),
    process_instructor_payout: async ({ payoutId }) =>
      ledger.processInstructorPayout(db, payoutId, provider, { enqueue: enq }),
    reconcile_payout: async ({ payoutId }) =>
      ledger.reconcilePayout(db, payoutId, provider, { enqueue: enq }),
  };
  const worker = makeWorker(db, handlers);
  ledger.revenuePayoutsCommand(db, { enqueue: enq });
  for (let i = 0; i < 50; i++) {
    const left = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get().n;
    if (left === 0) break;
    await worker.drain();
  }

  ledger.recognizeAll(db, new Date());

  // Unpaid backdated subscription so the ops console has live work at boot.
  ledger.subscribe(db, { userId: tariqUid, planId: annual, startsAt: daysAgoIso(60) });
  ledger.recognizeAll(db, new Date());

  emit(db, 'seed.completed', null, null, { subscriptions: 5, reviews: reviewDefs.length, note: 'demo data generated' });
  console.log('Seed complete (marketplace catalog + financial history).');
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = open(DB_FILE);
  seed(db)
    .then(() => { db.close(); })
    .catch((err) => { console.error(err); db.close(); process.exit(1); });
}

module.exports = { seed };
