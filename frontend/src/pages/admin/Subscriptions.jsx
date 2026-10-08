import React, { useEffect, useState } from 'react';
import { api, money, dateOnly } from '../../api.js';

export default function Subscriptions() {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api.get('/api/admin/subscriptions').then(setRows).catch(console.error);
  useEffect(() => { load(); }, []);

  const refund = async (id) => {
    const reason = window.prompt('Refund reason:', 'admin action');
    if (reason === null) return;
    try {
      const r = await api.post(`/api/admin/subscriptions/${id}/refund`, { reason });
      setMsg(`Refund #${r.refundId}: ${money(r.refundMinor)} to customer · ${money(r.clawback)} taken from unearned instructor allocations (cap ${money(r.unearnedCap)}).`);
      load();
    } catch (e) { setMsg(`Error: ${e.message}`); }
  };

  if (!rows) return <div className="page-loading">Loading…</div>;
  return (
    <div>
      <h1>Subscriptions & refunds</h1>
      <p className="muted">
        Mid-term refunds return only the customer's still-unearned portion. Earned instructor revenue
        is never clawed back — the refund is applied against remaining unearned allocations.
      </p>
      {msg && <div className="alert info">{msg}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Student</th><th>Plan</th><th>Term</th>
              <th>Gross</th><th>Distributable</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.student_name}</td>
                <td>{s.plan_name}</td>
                <td className="small">{dateOnly(s.starts_at)} → {dateOnly(s.ends_at)}</td>
                <td>{money(s.payment_gross, s.currency)}</td>
                <td>{money(s.distributable_minor, s.currency)}</td>
                <td><span className={`badge ${s.status === 'active' ? 'ok' : s.status === 'refunded' ? 'warn' : 'muted'}`}>{s.status}</span></td>
                <td>{s.status === 'active' && <button className="btn ghost sm" onClick={() => refund(s.id)}>Refund unused time</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
