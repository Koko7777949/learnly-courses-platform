# Learnly — Online Courses Platform with Instructor Revenue Ledger

A full-stack online courses platform in the style of Udemy / Coursera, whose
financial core implements the **Instructor Revenue Ledger** architecture from
the attached Engineering Documentation Pack — rebuilt on a Node.js stack so it
runs and can be tested end-to-end.

```
Laravel 11 / Filament / MySQL / Pest  (the pack's stack)
        ↓ mapped 1:1 onto
Express / React / SQLite (better-sqlite3) / node:test
```

## The learner experience (Udemy-style)

- **Home**: hero, trust bar, category filters, "most popular" grid with
  thumbnails, star ratings, learner counts and plan pricing.
- **Course pages**: dark banner with breadcrumbs & rating meta, "What you'll
  learn", curriculum accordion with locked/preview lessons, requirements,
  instructor profiles with photos & stats, review summary with histogram and
  written reviews, and a **sticky buy card** listing the plans that include
  the course.
- **Search** ("Search for anything"), plans page with a highlighted
  most-popular tier, mock checkout (idempotent), "My learning" with
  subscription-gated lessons and unused-time refunds.

## The instructor & ops experience

- **Instructor dashboard**: earned / paid / reserved / available, allocation
  history per subscription, payout history with idempotency keys.
- **Ops console** (read-only, per spec): overview with totals + the two
  commands (`Run revenue:payouts`, `Run reconciliation`), balances table,
  payout history with filters + detail (items → source allocations),
  subscriptions & refunds, mock-provider scenario switcher, structured event
  log and durable job queue.

## The financial core (faithful to the pack)

- Integer minor-unit money; platform fee via basis points, round-half-up.
- **Weighted largest-remainder allocation** — Σ allocations = distributable
  exactly; deterministic tie-breaks.
- **Straight-line daily revenue recognition**; payment is cash, not revenue.
- Immutable allocation snapshot at payment time.
- **Unused-time-only refunds** — recognized revenue is never clawed back.
- **Payout state machine** with an explicit `VERIFY` state, durable intent
  before the provider call, stable idempotency keys, provider called outside
  transactions, reconciliation with backoff + crash repair via key replay.
- **Mock provider** with its own durable store and `SUCCESS` /
  `PERMANENT_FAILURE` / `TIMEOUT_AFTER_SUCCESS` scenarios.

## Performance

- `compression()` (gzip/brotli-negotiated) on all responses.
- Static assets served with `Cache-Control: immutable` + hashed filenames.
- Lazy-loaded imagery, `loading="lazy"`, fixed aspect ratios (no CLS).
- SQLite in WAL mode with targeted indexes (allocation/payout/job hot paths).
- Recognition is computed on demand (no row-per-day accruals), balances are a
  transactional snapshot — cheap reads on every screen.

## Quick start

```bash
npm install
npm run seed        # marketplace catalog + reviews + financial history
npm run build       # build the React frontend
npm start           # server + queue worker on http://localhost:4000
npm test            # 20 tests: allocation, recognition, payouts, refunds…
```

### Demo accounts (password: `password123`)

| Role | Email |
| --- | --- |
| Ops admin | `admin@platform.test` |
| Instructor (Lina) | `lina@platform.test` |
| Instructor (Omar) | `omar@platform.test` |
| Instructor (Maya) | `maya@platform.test` |
| Student | `sara@student.test` |

## Layout

```
server/          Express app + routes, seed script
src/money.js     integer minor units, fee, largest-remainder, recognition
src/db.js        SQLite schema (pack §4 mapped to SQLite)
src/ledger.js    checkout snapshot, recognition, refunds, payout state machine
src/provider.js  mock payout provider with its own durable store
src/queue.js     durable job queue + worker (unique-key dedup)
src/auth.js      scrypt sessions
frontend/        React SPA (Udemy-style learner UI + ops console)
tests/           node:test suite (20 tests)
docs/ARCHITECTURE.md
```

## Known simplifications vs. a production deployment

- SQLite instead of MySQL/InnoDB: writer serialization replaces
  `SELECT ... FOR UPDATE`; unique constraints + state checks remain the
  authoritative guard (same role the pack assigns to DB locks).
- Single-process queue instead of Redis; job semantics preserved.
- Single currency (USD), no tax/chargebacks/FX — same non-goals as the pack.
