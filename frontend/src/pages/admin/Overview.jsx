import React, { useEffect, useState } from 'react';
import { api, money } from '../../api.js';

function Card({ label, value, tone }) {
  return (
    <div className={`stat-card ${tone || ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export default function Overview() {
  const [t, setT] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api.get('/api/admin/totals').then(setT).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  const runPayouts = async () => {
    setMsg('Running revenue:payouts…');
    const r = await api.post('/api/admin/payouts/run');
    setMsg(`revenue:payouts dispatched ${r.dispatched} payout job(s). Recognition sweep completed.`);
    setTimeout(load, 1500);
  };
  const runReconcile = async () => {
    setMsg('Running reconciliation sweep…');
    const r = await api.post('/api/admin/reconcile/run');
    setMsg(`Reconciliation dispatched ${r.dispatched} job(s).`);
    setTimeout(load, 1500);
  };

  if (!t) return <div className="page-loading">Loading…</div>;
  return (
    <div>
      <h1>Overview</h1>
      <div className="grid stats">
        <Card label="Gross collected" value={money(t.gross_collected)} tone="tint" />
        <Card label="Platform fees" value={money(t.platform_fees)} />
        <Card label="Distributable to instructors" value={money(t.distributable)} tone="accent" />
        <Card label="Recognized (earned)" value={money(t.recognized)} tone="tint" />
        <Card label="Paid out" value={money(t.paid_out)} tone="ok" />
        <Card label="Reserved (in flight)" value={money(t.reserved)} tone="warn" />
        <Card label="Refunded to customers" value={money(t.refunded_to_customers)} tone="warn" />
        <Card label="Active subscriptions" value={t.active_subscriptions} />
        <Card label="Payouts ✓" value={t.payouts_succeeded} tone="ok" />
        <Card label="Payouts ✗" value={t.payouts_failed} tone="bad" />
        <Card label="Payouts uncertain" value={t.payouts_uncertain} tone="warn" />
      </div>

      <div className="ops-actions">
        <button className="btn primary" onClick={runPayouts}>▶ Run revenue:payouts</button>
        <button className="btn ghost" onClick={runReconcile}>⟳ Run reconciliation</button>
        {msg && <span className="muted small">{msg}</span>}
      </div>

      <p className="muted small">
        Invariant check: for every instructor, earned − paid − reserved = available; for every payment,
        Σ allocations = distributable = gross − fee, exactly.
      </p>
    </div>
  );
}
