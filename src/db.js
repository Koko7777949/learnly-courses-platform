'use strict';
/**
 * Database layer — better-sqlite3.
 *
 * Maps §4 of the Engineering Documentation Pack (MySQL/InnoDB) onto SQLite.
 * Engineering notes on the mapping:
 *  - BIGINT UNSIGNED minor units -> SQLite INTEGER (64-bit). All arithmetic in
 *    the app is integer-only anyway.
 *  - SELECT ... FOR UPDATE row locking -> SQLite serializes writers; every
 *    balance-changing operation runs inside a BEGIN IMMEDIATE transaction and
 *    the unique constraints + payout state checks remain the authoritative
 *    correctness boundary (exactly the role the PDF assigns to DB locks).
 *  - DATETIME(6) UTC -> TEXT ISO-8601 strings, normalized to UTC by the app.
 */
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('student','instructor','admin')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instructors (
  id                  INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL UNIQUE REFERENCES users(id),
  display_name        TEXT NOT NULL,
  title               TEXT,
  bio                 TEXT,
  avatar              TEXT,
  provider_account_id TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id             INTEGER PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  tagline        TEXT,
  description    TEXT,
  level          TEXT,
  category       TEXT,
  image          TEXT,
  accent         TEXT DEFAULT '#a435f0',
  students_count INTEGER NOT NULL DEFAULT 0,
  last_updated   TEXT,
  language       TEXT NOT NULL DEFAULT 'English',
  what_you_learn TEXT NOT NULL DEFAULT '[]',
  requirements   TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS course_instructors (
  course_id     INTEGER NOT NULL REFERENCES courses(id),
  instructor_id INTEGER NOT NULL REFERENCES instructors(id),
  weight        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (course_id, instructor_id)
);

CREATE TABLE IF NOT EXISTS lessons (
  id           INTEGER PRIMARY KEY,
  course_id    INTEGER NOT NULL REFERENCES courses(id),
  position     INTEGER NOT NULL,
  section      TEXT NOT NULL DEFAULT 'Course content',
  title        TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS plans (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT,
  term_months      INTEGER NOT NULL,
  price_minor      INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  platform_fee_bps INTEGER NOT NULL CHECK (platform_fee_bps BETWEEN 0 AND 10000),
  active           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS plan_courses (
  plan_id   INTEGER NOT NULL REFERENCES plans(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  PRIMARY KEY (plan_id, course_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  plan_id             INTEGER NOT NULL REFERENCES plans(id),
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  gross_minor         INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','refunded','expired')),
  provider_payment_id TEXT UNIQUE,
  created_at          TEXT NOT NULL
);

-- Immutable-ish snapshot of instructors participating in a subscription.
CREATE TABLE IF NOT EXISTS subscription_participants (
  id            INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  instructor_id INTEGER NOT NULL REFERENCES instructors(id),
  weight        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (subscription_id, instructor_id)
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id                      INTEGER PRIMARY KEY,
  subscription_id         INTEGER NOT NULL UNIQUE REFERENCES subscriptions(id),
  provider_payment_id     TEXT NOT NULL UNIQUE,
  request_idempotency_key TEXT NOT NULL UNIQUE,
  gross_minor             INTEGER NOT NULL,
  platform_fee_minor      INTEGER NOT NULL,
  distributable_minor     INTEGER NOT NULL,
  currency                TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'paid',
  paid_at                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_allocations (
  id              INTEGER PRIMARY KEY,
  payment_id      INTEGER NOT NULL REFERENCES subscription_payments(id),
  instructor_id   INTEGER NOT NULL REFERENCES instructors(id),
  allocated_minor INTEGER NOT NULL,
  recognized_minor INTEGER NOT NULL DEFAULT 0,
  paid_minor      INTEGER NOT NULL DEFAULT 0,
  refunded_minor  INTEGER NOT NULL DEFAULT 0,
  term_start_at   TEXT NOT NULL,
  term_end_at     TEXT NOT NULL,
  UNIQUE (payment_id, instructor_id)
);
CREATE INDEX IF NOT EXISTS idx_alloc_instructor ON revenue_allocations (instructor_id, recognized_minor, paid_minor);

CREATE TABLE IF NOT EXISTS refunds (
  id             INTEGER PRIMARY KEY,
  payment_id     INTEGER NOT NULL REFERENCES subscription_payments(id),
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  provider_ref   TEXT NOT NULL UNIQUE,
  refund_minor   INTEGER NOT NULL,          -- returned to the customer (gross terms)
  clawback_minor INTEGER NOT NULL,          -- applied against unearned instructor allocations
  status         TEXT NOT NULL DEFAULT 'processed',
  reason         TEXT,
  processed_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refund_allocations (
  id            INTEGER PRIMARY KEY,
  refund_id     INTEGER NOT NULL REFERENCES refunds(id),
  allocation_id INTEGER NOT NULL REFERENCES revenue_allocations(id),
  amount_minor  INTEGER NOT NULL,
  UNIQUE (refund_id, allocation_id)
);
CREATE INDEX IF NOT EXISTS idx_refalloc_allocation ON refund_allocations (allocation_id);

CREATE TABLE IF NOT EXISTS instructor_balances (
  instructor_id  INTEGER PRIMARY KEY REFERENCES instructors(id),
  earned_minor   INTEGER NOT NULL DEFAULT 0,
  paid_minor     INTEGER NOT NULL DEFAULT 0,
  reserved_minor INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'USD',
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id                      INTEGER PRIMARY KEY,
  instructor_id           INTEGER NOT NULL REFERENCES instructors(id),
  amount_minor            INTEGER NOT NULL,
  currency                TEXT NOT NULL,
  idempotency_key         TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','VERIFY','SUCCEEDED','FAILED')),
  provider_transaction_id TEXT UNIQUE,
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  failure_reason          TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  completed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_payouts_instructor ON payouts (instructor_id, status, id);

CREATE TABLE IF NOT EXISTS payout_items (
  id            INTEGER PRIMARY KEY,
  payout_id     INTEGER NOT NULL REFERENCES payouts(id),
  allocation_id INTEGER NOT NULL REFERENCES revenue_allocations(id),
  amount_minor  INTEGER NOT NULL,
  UNIQUE (payout_id, allocation_id)
);
CREATE INDEX IF NOT EXISTS idx_payout_items_allocation ON payout_items (allocation_id);

-- Durable job queue (the "Redis queue" of this exercise).
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  key          TEXT,                      -- ShouldBeUnique analogue; NULL allowed
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  error        TEXT,
  available_at TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_queueable ON jobs (status, available_at);
-- Uniqueness only while a job is active (queued/running) — done jobs keep their history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_key ON jobs (key) WHERE status IN ('queued','running');

-- The mock provider's own durable store: what it actually did per idempotency key.
CREATE TABLE IF NOT EXISTS provider_transactions (
  idempotency_key     TEXT PRIMARY KEY,
  provider_account_id TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
  provider_txn_id     TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

-- Structured operational event log (§13.1).
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (name, id);

-- Runtime configuration (mock provider scenario, scheduler toggles).
CREATE TABLE IF NOT EXISTS provider_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY,
  course_id  INTEGER NOT NULL REFERENCES courses(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_course ON reviews (course_id, id DESC);
`;

function open(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

let _db = null;
function getDb() {
  if (!_db) {
    const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'lms.sqlite');
    require('fs').mkdirSync(path.dirname(file), { recursive: true });
    _db = open(file);
  }
  return _db;
}

const nowIso = () => new Date().toISOString();

function emit(db, name, entityType, entityId, payload) {
  db.prepare(
    'INSERT INTO events (name, entity_type, entity_id, payload, created_at) VALUES (?,?,?,?,?)',
  ).run(name, entityType, entityId, JSON.stringify(payload || {}), nowIso());
}

module.exports = { open, getDb, nowIso, emit };
