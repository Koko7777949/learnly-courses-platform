import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, dt, PAYOUT_STATUS_CLASS } from '../../api.js';

const STATUSES = ['ALL', 'PENDING', 'PROCESSING', 'VERIFY', 'SUCCEEDED', 'FAILED'];

export default function Payouts() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = () => {
    const q = new URLSearchParams();
    if (status !== 'ALL') q.set('status', status);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api.get(`/api/admin/payouts?${q}`).then(setRows).catch(console.error);
  };
  useEffect(load, [status, from, to]);

  if (!rows) return <div className="page-loading">Loading…</div>;
  return (
    <div>
      <h1>Payout history</h1>
      <div className="filters">
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Instructor</th><th>Amount</th><th>Status</th>
              <th>Idempotency key</th><th>Provider txn</th><th>Attempts</th><th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="8" className="muted">No payouts match the filter.</td></tr>}
            {rows.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/admin/payouts/${p.id}`}>#{p.id}</Link></td>
                <td>{p.display_name}</td>
                <td>{money(p.amount_minor, p.currency)}</td>
                <td><span className={`badge ${PAYOUT_STATUS_CLASS[p.status]}`}>{p.status}</span></td>
                <td><code className="small">{p.idempotency_key}</code></td>
                <td>{p.provider_transaction_id ? <code className="small">{p.provider_transaction_id}</code> : '—'}</td>
                <td>{p.attempt_count}</td>
                <td className="muted small">{dt(p.completed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
