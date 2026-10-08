# Architecture — Instructor Revenue Ledger on a Node.js stack

This document maps the Engineering Documentation Pack (Laravel 11 / Livewire /
Filament / Pest / MySQL) onto this implementation (Express / React / SQLite /
node:test) and records the correctness properties, exactly as the pack
requires.

## 1. Stack mapping

| Pack | This project | Notes |
| --- | --- | --- |
| Laravel models + migrations (`database/migrations`) | `src/db.js` (SQLite schema) | Same tables, same unique constraints. `BIGINT UNSIGNED` minor units → SQLite 64-bit INTEGER. `DATETIME(6)` UTC → ISO-8601 TEXT, normalized by the app. |
| `SELECT ... FOR UPDATE` (InnoDB row locks) | `BEGIN IMMEDIATE` transactions (SQLite writer serialization) | SQLite admits one writer at a time; the unique constraints and payout-state checks remain the authoritative correctness boundary — the same role the pack assigns to DB locks. |
| Laravel queues (Redis, `ShouldBeUnique`, `WithoutOverlapping`) | `src/queue.js` — durable `jobs` table + worker loop | Unique job key enforced by a partial unique index on `(key) WHERE status IN ('queued','running')`. Retries with capped attempts and exponential backoff. |
| Artisan `revenue:payouts` + scheduler | `ledger.revenuePayoutsCommand` + admin **Run revenue:payouts** button + 5-minute reconciliation sweep | Command dispatches jobs only; it never calls the provider. |
| Filament read-only screens (§11) | React **Ops console** (`frontend/src/pages/admin/*`) | Balances table, payout history + filters, payout detail with items→allocations, event log. No "pay now"/"edit amount" actions exist anywhere in the UI. |
| Pest | `node:test` suite (`tests/`) | 20 tests covering the §10 matrix. |
| PHP enums / services (`Domain/Revenue/...`) | `src/money.js`, `src/ledger.js`, `src/provider.js` | Pure functions + transaction-scoped services, no framework magic. |

## 2. Monetary model (§3)

- All amounts are integer minor units; arithmetic uses BigInt internally and
  floors with integer division — **no floating-point money math anywhere**.
- `platform_fee = round_half_up(G × F / 10_000)` (basis points). The fee rate
  is read from the plan at payment time and both `platform_fee_minor` and
  `distributable_minor` are stored on the payment row, so history is
  reproducible without config replay.
- **Weighted largest-remainder allocation**: base share `floor(D·w/W)`,
  leftover cents awarded one-by-one to the largest fractional remainders,
  ties broken by ascending instructor id. Invariant:
  `Σ allocated_minor == distributable_minor` exactly (tested).

## 3. Domain model (§4)

Same entity graph as the pack:

```
users ─1:1─ instructors ─1:1─ instructor_balances
plans ─< subscriptions ─< subscription_participants (snapshot, weighted)
subscriptions ─1:1─ subscription_payments ─< revenue_allocations ─< refund_allocations >─ refunds
instructors ─< payouts ─< payout_items >─ revenue_allocations
```

Key uniqueness constraints (all present in `src/db.js`):
`subscription_payments.request_idempotency_key UNIQUE`,
`revenue_allocations UNIQUE(payment_id, instructor_id)`,
`payouts.idempotency_key UNIQUE`, `payout_items UNIQUE(payout_id, allocation_id)`,
`refund_allocations UNIQUE(refund_id, allocation_id)`,
`provider_transactions.idempotency_key PRIMARY KEY`.

The **allocation snapshot is created in the same transaction as the payment**,
from the plan→course→instructor graph at that instant; later catalog changes
cannot rewrite it. `allocated_minor` is never mutated afterwards —
`recognized_minor`, `paid_minor`, `refunded_minor` are progress markers.

## 4. Revenue recognition (§5)

`earned_to_date = floor(base × clamp(elapsed_days, 0, term_days) / term_days)`
over the half-open UTC term `[starts_at, ends_at)`, where
`base = allocated_minor − refunded_minor`. No row-per-day accruals:
recognition posts only the **delta** (`earned_to_date − recognized_minor`),
and only positive deltas — `max(0, …)` makes clawback impossible by
construction. At term end the full base is earned; post-expiry clamps.

## 5. Refunds (§6)

Mid-term refund policy, exactly as the pack chooses:

1. Customer receives the pro-rated unused-time share of the gross payment.
2. Instructor-side pool = the distributable share of that refund, **capped at
   Σ remaining-unearned per allocation**. Excess is a platform-side policy
   item (recorded in the `refund.processed` event payload) and is never taken
   from instructors.
3. The pool is distributed across allocations by largest remainder weighted
   by each allocation's remaining-unearned amount, so every share ≤ that
   allocation's unearned amount — recognized revenue is untouched and
   `allocated − refunded ≥ recognized` continues to hold (tested).

## 6. Payout state machine (§7)

```
              ┌────────────┐  claim (tx)   ┌─────────┐
eligible ───▶ │  (prepare) │ ────────────▶ │ PENDING │
balance       └────────────┘  reserve amt  └────┬────┘
                                                │ begin (tx, durable)
                                                ▼
        success  ┌─────────────┐  timeout  ┌────────────┐
      ┌─────────▶│  SUCCEEDED  │◀──────────│ PROCESSING │──┐
      │          └─────────────┘  reconcile└─────┬──────┘  │
      │                                          │         │ provider call
      │          ┌─────────────┐  perm. failure  │         │ (outside any
      │          │   FAILED    │◀────────────────┘         │  transaction)
      │          └─────────────┘                           │
      │                                                    ▼
      │          reconcile finds SUCCESS        ┌────────────────┐
      └────────────────────────────────────────│     VERIFY     │
                                                │ (reservation   │
                                    UNKNOWN ──▶ │  stays held,   │
                                    retry w/    │  backoff retry)│
                                    backoff     └────────────────┘
```

Properties enforced:

- **Durable intent before the remote call.** `PROCESSING` is committed in its
  own transaction before `provider.createPayout` runs; the provider is never
  called inside a DB transaction.
- **One active payout per instructor** (`activePayoutFor` guard + `PENDING/
  PROCESSING/VERIFY` state checks), so concurrency cannot double-reserve a
  balance (tested with racing claims).
- **Stable idempotency key** `po_<instructor>_<payoutId>` minted once at
  claim time; every retry/replay/reconciliation for that intent reuses it.
- **Failure semantics.** `PERMANENT_FAILURE` → `FAILED`, reservation released,
  amount payable again via a *new* payout intent. Timeout → `VERIFY`;
  reconciliation resolves it with a provider status lookup **by the original
  key** — never a second payment intent. Stale `PROCESSING` (worker died
  mid-call) is repaired by replaying `createPayout` with the same key against
  the provider's idempotent store.

## 7. Mock provider (§8)

`src/provider.js` implements the pack's contract (`createPayout`,
`getPayoutStatus`) and keeps its **own durable transaction store**
(`provider_transactions`, keyed by idempotency key). Scenarios, switchable at
runtime from the Ops console (globally or per provider account):

| Scenario | Provider side effect | Caller sees | Local response |
| --- | --- | --- | --- |
| `success` | money moved, SUCCESS stored | success | `SUCCEEDED`, reserved → paid |
| `permanent_failure` | nothing moved, FAILED stored | failure | `FAILED`, reservation released |
| `timeout_after_success` | money moved, SUCCESS stored | timeout | `VERIFY`, reconcile later |

Because the provider store is idempotent per key, replays can never move
money twice — the invariant `≤ 1 provider transaction per idempotency key`
is asserted in tests and shown in the console.

## 8. Balance snapshot & invariants (§9, §11)

`instructor_balances` is a performance snapshot maintained transactionally
alongside every allocation/payout mutation; the source of truth is the
allocation + payout-item rows. The test suite asserts
`earned − paid − reserved = available` and that the snapshot equals the
source rows after each lifecycle stage. Financial rows are never deleted;
state moves forward through explicit transitions, and the `events` table
records the structured log (§13.1 event names).

## 9. Concurrency model in SQLite

The pack layers Redis/distributed locks over MySQL row locks. In this
single-process build:

1. better-sqlite3 is synchronous — statements and transactions cannot
   interleave mid-transaction, giving the serialization the pack wants from
   `FOR UPDATE`.
2. The claim transaction re-checks state (`activePayoutFor`, available
   balance, per-allocation reserved sums) so any future multi-process port
   stays correct.
3. Unique constraints (`payouts.idempotency_key`,
   `payout_items(payout_id, allocation_id)`, job keys) are the final guard —
   the "authoritative correctness boundary" the pack insists on.

Porting to MySQL later means: swap the schema types per §4.3, add
`SELECT ... FOR UPDATE` on the balance row inside the claim transaction, and
move the queue to Redis. No domain-logic changes are required.

## 10. Non-goals (kept from the pack)

No full double-entry GL, no tax/VAT/chargebacks/FX, no manual payout editing
from the UI, single currency (USD).
