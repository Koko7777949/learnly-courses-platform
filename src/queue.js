'use strict';
/**
 * Durable job queue — the stand-in for Laravel queues + Redis (§7.2/§12.2).
 *
 * Jobs live in the `jobs` table BEFORE any side effect they protect (durable
 * intent). A job's optional unique `key` is the ShouldBeUnique analogue:
 * while a job with that key is queued/running, enqueueing the same key is a
 * no-op. Handlers are registered per job type; failures re-queue with a
 * capped attempt count.
 */
const { nowIso } = require('./db');

function enqueue(db, type, payload = {}, { key = null, delaySec = 0 } = {}) {
  const available = new Date(Date.now() + delaySec * 1000).toISOString();
  if (key) {
    const existing = db.prepare(
      "SELECT id FROM jobs WHERE key = ? AND status IN ('queued','running')",
    ).get(key);
    if (existing) return { deduplicated: true, id: existing.id };
  }
  const row = db.prepare(
    `INSERT INTO jobs (type, key, payload, status, attempts, max_attempts, available_at, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, 5, ?, ?, ?)`,
  ).run(type, key, JSON.stringify(payload), available, nowIso(), nowIso());
  return { id: Number(row.lastInsertRowid) };
}

function makeWorker(db, handlers, { pollMs = 250 } = {}) {
  let timer = null;
  let draining = false;

  async function claimAndRun() {
    if (draining) return;
    draining = true;
    try {
      const job = db.prepare(
        `SELECT * FROM jobs WHERE status = 'queued' AND available_at <= ? ORDER BY id LIMIT 1`,
      ).get(new Date().toISOString());
      if (!job) return;

      db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(nowIso(), job.id);
      const handler = handlers[job.type];
      try {
        if (!handler) throw new Error(`no handler for job type ${job.type}`);
        await handler(JSON.parse(job.payload || '{}'));
        db.prepare("UPDATE jobs SET status = 'done', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ?")
          .run(nowIso(), job.id);
      } catch (err) {
        const attempts = job.attempts + 1;
        if (attempts >= job.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?")
            .run(attempts, String(err && err.message || err), nowIso(), job.id);
        } else {
          const backoff = Math.min(30, 2 ** attempts);
          db.prepare(
            `UPDATE jobs SET status = 'queued', attempts = ?, error = ?, available_at = ?, updated_at = ? WHERE id = ?`,
          ).run(attempts, String(err && err.message || err), new Date(Date.now() + backoff * 1000).toISOString(), nowIso(), job.id);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { claimAndRun().catch(() => {}); }, pollMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    drain: claimAndRun,
  };
}

module.exports = { enqueue, makeWorker };
