import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, dt, dateOnly, PAYOUT_STATUS_CLASS } from '../api.js';
import { useAuth } from '../App.jsx';

function StatCard({ label, value, sub, tone }) {
  return (
    <div className={`stat-card ${tone || ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export default function InstructorDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (user?.role !== 'instructor') return;
    api.get('/api/instructor/dashboard').then(setData).catch((e) => setErr(e.message));
  }, [user]);

  if (user?.role !== 'instructor') {
    return <div className="container pad"><div className="alert bad">This area is for instructors. <Link to="/">Back home</Link></div></div>;
  }
  if (err) return <div className="container pad"><div className="alert bad">{err}</div></div>;
  if (!data) return <div className="page-loading">Loading dashboard…</div>;

  const b = data.balance;
  return (
    <div className="container pad">
      <h1>Instructor · {data.instructor.display_name}</h1>
      <p className="muted">
        Provider account <code>{data.instructor.provider_account_id}</code>. Revenue is recognized
        daily across each subscription term and paid out via the failure-safe payout engine.
      </p>

      <div className="grid stats">
        <StatCard label="Recognized (earned)" value={money(b.earned_minor, b.currency)} tone="tint" sub="Straight-line over each term" />
        <StatCard label="Paid out" value={money(b.paid_minor, b.currency)} tone="ok" sub="Settled payouts to date" />
        <StatCard label="Reserved" value={money(b.reserved_minor, b.currency)} tone="warn" sub="Held by non-terminal payouts" />
        <StatCard label="Available" value={money(b.available_minor, b.currency)} tone="accent" sub="Earned − paid − reserved" />
      </div>

      <h2>Payout history</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>Amount</th><th>Status</th><th>Idempotency key</th><th>Provider txn</th><th>Attempts</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {data.payouts.length === 0 && <tr><td colSpan="7" className="muted">No payouts yet.</td></tr>}
            {data.payouts.map((p) => (
              <tr key={p.id}>
                <td>#{p.id}</td>
                <td>{money(p.amount_minor, p.currency)}</td>
                <td><span className={`badge ${PAYOUT_STATUS_CLASS[p.status]}`}>{p.status}</span></td>
                <td><code className="small">{p.idempotency_key}</code></td>
                <td>{p.provider_transaction_id ? <code className="small">{p.provider_transaction_id}</code> : '—'}</td>
                <td>{p.attempt_count}</td>
                <td>{dt(p.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Revenue allocations</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Student / plan</th><th>Term</th><th>Allocated</th><th>Recognized</th><th>Paid</th><th>Refunded</th><th>Earned now</th></tr>
          </thead>
          <tbody>
            {data.allocations.length === 0 && <tr><td colSpan="7" className="muted">No allocations yet.</td></tr>}
            {data.allocations.map((a) => (
              <tr key={a.id}>
                <td>{a.student_name} · <span className="muted">{a.plan_name}</span></td>
                <td>{dateOnly(a.term_start_at)} → {dateOnly(a.term_end_at)}</td>
                <td>{money(a.allocated_minor)}</td>
                <td>{money(a.recognized_minor)}</td>
                <td>{money(a.paid_minor)}</td>
                <td>{a.refunded_minor ? money(a.refunded_minor) : '—'}</td>
                <td className="muted">{money(a.earned_now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>My courses</h2>
      <div className="course-instructors">
        {data.courses.map((c) => (
          <span key={c.id} className="chip">{c.title} · weight {c.weight}</span>
        ))}
      </div>
    </div>
  );
}
