import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money, dt, dateOnly, PAYOUT_STATUS_CLASS } from '../../api.js';

export default function PayoutDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get(`/api/admin/payouts/${id}`).then(setData).catch((e) => setErr(e.message));
  }, [id]);

  if (err) return <div className="alert bad">{err}</div>;
  if (!data) return <div className="page-loading">Loading…</div>;
  const { payout: p, items } = data;

  return (
    <div>
      <Link to="/admin/payouts" className="muted small">← back to payout history</Link>
      <h1>Payout #{p.id} — {p.display_name}</h1>
      <div className="grid stats">
        <div className="stat-card"><div className="stat-label">Amount</div><div className="stat-value">{money(p.amount_minor, p.currency)}</div></div>
        <div className="stat-card"><div className="stat-label">Status</div><div className="stat-value"><span className={`badge ${PAYOUT_STATUS_CLASS[p.status]}`}>{p.status}</span></div></div>
        <div className="stat-card"><div className="stat-label">Attempts</div><div className="stat-value">{p.attempt_count}</div></div>
        <div className="stat-card"><div className="stat-label">Completed</div><div className="stat-value small">{dt(p.completed_at)}</div></div>
      </div>

      <dl className="kv">
        <dt>Idempotency key (stable across retries)</dt><dd><code>{p.idempotency_key}</code></dd>
        <dt>Provider transaction</dt><dd>{p.provider_transaction_id ? <code>{p.provider_transaction_id}</code> : '— (not settled by provider)'}</dd>
        <dt>Created</dt><dd>{dt(p.created_at)}</dd>
        {p.failure_reason && <><dt>Failure reason</dt><dd className="bad">{p.failure_reason}</dd></>}
      </dl>

      <h2>Payout items → revenue allocations</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source subscription</th><th>Term</th><th>Item amount</th>
              <th>Allocated</th><th>Recognized</th><th>Paid</th><th>Refunded</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>{it.student_name} · <span className="muted">{it.plan_name}</span></td>
                <td className="small">{dateOnly(it.term_start_at)} → {dateOnly(it.term_end_at)}</td>
                <td className="strong">{money(it.amount_minor)}</td>
                <td>{money(it.allocated_minor)}</td>
                <td>{money(it.recognized_minor)}</td>
                <td>{money(it.paid_minor)}</td>
                <td>{it.refunded_minor ? money(it.refunded_minor) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
