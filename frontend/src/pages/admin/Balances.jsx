import React, { useEffect, useState } from 'react';
import { api, money, dt } from '../../api.js';

export default function Balances() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/api/admin/balances').then(setRows).catch(console.error); }, []);

  if (!rows) return <div className="page-loading">Loading…</div>;
  return (
    <div>
      <h1>Instructor balances</h1>
      <p className="muted">
        Transactional balance snapshot backed by allocation and payout records (§11.1). Balances are
        refreshed by a recognition sweep on render.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Instructor</th><th>Currency</th><th>Earned</th><th>Reserved</th>
              <th>Paid</th><th>Available</th><th>Last payout</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.display_name}</strong><div className="muted small"><code>{r.provider_account_id}</code></div></td>
                <td>{r.currency}</td>
                <td>{money(r.earned_minor, r.currency)}</td>
                <td>{money(r.reserved_minor, r.currency)}</td>
                <td>{money(r.paid_minor, r.currency)}</td>
                <td className="strong">{money(r.available_minor, r.currency)}</td>
                <td>
                  {r.last_payout ? (
                    <>
                      <span className={`badge ${r.last_payout.status === 'SUCCEEDED' ? 'ok' : r.last_payout.status === 'FAILED' ? 'bad' : 'warn'}`}>
                        {r.last_payout.status}
                      </span>{' '}
                      {money(r.last_payout.amount_minor)} <span className="muted small">{dt(r.last_payout.completed_at || r.last_payout.created_at)}</span>
                    </>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
