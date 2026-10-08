'use strict';
/** Shared test fixture: temp DB + minimal catalog + three instructors. */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { open, nowIso } = require('../src/db');
const { hashPassword } = require('../src/auth');

function tempDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lms-test-')), 'test.sqlite');
  return open(file);
}

function makeFixture(db) {
  const now = nowIso();
  const pw = hashPassword('x'.repeat(10));
  const insUser = db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,?)');
  const studentId = Number(insUser.run('Student', 'student@test', pw, 'student', now).lastInsertRowid);
  const u1 = Number(insUser.run('I1', 'i1@test', pw, 'instructor', now).lastInsertRowid);
  const u2 = Number(insUser.run('I2', 'i2@test', pw, 'instructor', now).lastInsertRowid);
  const u3 = Number(insUser.run('I3', 'i3@test', pw, 'instructor', now).lastInsertRowid);

  const insInstr = db.prepare("INSERT INTO instructors (user_id, display_name, provider_account_id, status, created_at) VALUES (?,?,?, 'active', ?)");
  const i1 = Number(insInstr.run(u1, 'Instructor One', 'acct_1', now).lastInsertRowid);
  const i2 = Number(insInstr.run(u2, 'Instructor Two', 'acct_2', now).lastInsertRowid);
  const i3 = Number(insInstr.run(u3, 'Instructor Three', 'acct_3', now).lastInsertRowid);

  const c1 = Number(db.prepare("INSERT INTO courses (slug, title, created_at) VALUES ('c1','Course 1',?)").run(now).lastInsertRowid);
  const insCI = db.prepare('INSERT INTO course_instructors (course_id, instructor_id, weight) VALUES (?,?,?)');
  insCI.run(c1, i1, 1); insCI.run(c1, i2, 1); insCI.run(c1, i3, 1);

  // $100.00, 3-month term, 10% fee -> distributable 9000
  const planId = Number(db.prepare(
    "INSERT INTO plans (code, name, term_months, price_minor, currency, platform_fee_bps, active) VALUES ('p','Plan',3,10000,'USD',1000,1)",
  ).run().lastInsertRowid);
  db.prepare('INSERT INTO plan_courses (plan_id, course_id) VALUES (?,?)').run(planId, c1);

  return { studentId, instructors: [i1, i2, i3], planId, courseId: c1 };
}

/** Deterministic scenario override via provider_config. */
function setScenario(db, scenario) {
  db.prepare("INSERT INTO provider_config (key, value) VALUES ('scenario', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(scenario);
}

/** Fake enqueue capturing dispatched jobs; honors unique-key dedup like the real queue. */
function fakeQueue() {
  const jobs = [];
  const enqueue = (type, payload, opts = {}) => {
    if (opts.key && jobs.some((j) => j.key === opts.key)) return { deduplicated: true };
    jobs.push({ type, payload, key: opts.key || null });
    return { id: jobs.length };
  };
  return { jobs, enqueue };
}

module.exports = { tempDb, makeFixture, setScenario, fakeQueue };
