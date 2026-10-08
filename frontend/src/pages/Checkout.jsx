import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money } from '../api.js';
import { useAuth } from '../App.jsx';

export default function Checkout() {
  const { planId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState(null);
  const [card, setCard] = useState({ number: '4242 4242 4242 4242', name: user?.name || '', expiry: '12/28', cvc: '123' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const idemKey = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    if (!user) navigate('/auth', { state: { from: `/checkout/${planId}` } });
  }, [user, navigate, planId]);

  useEffect(() => { api.get('/api/plans').then(setPlans).catch(console.error); }, []);
  const plan = plans?.find((p) => p.id === Number(planId));

  const pay = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.post('/api/checkout', { plan_id: Number(planId), idempotency_key: idemKey });
      navigate('/learn?welcome=1');
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };

  if (!plans) return <div className="page-loading">Loading…</div>;
  if (!plan) return <div className="container pad"><div className="alert bad">Plan not found.</div></div>;

  const fee = Math.round((plan.price_minor * plan.platform_fee_bps) / 10000);

  return (
    <div className="container pad narrow">
      <h1>Checkout</h1>
      <div className="checkout-card">
        <div className="checkout-summary">
          <div className="plan-row">
            <div><strong>{plan.name}</strong><div className="muted">{plan.term_months} month term · {plan.course_count} courses</div></div>
            <span className="price">{money(plan.price_minor)}</span>
          </div>
          <div className="muted small split-note">
            Of your payment, {money(fee)} is the platform fee and {money(plan.price_minor - fee)} becomes instructor revenue
            distributed over the term (weighted largest-remainder allocation, exact to the cent).
          </div>
        </div>

        <form onSubmit={pay}>
          <label>Card number<input value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} required /></label>
          <label>Name on card<input value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} required /></label>
          <div className="row">
            <label>Expiry<input value={card.expiry} onChange={(e) => setCard({ ...card, expiry: e.target.value })} required /></label>
            <label>CVC<input value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} required /></label>
          </div>
          <div className="muted small">Mock payment — no real charge. A stable request idempotency key prevents double-billing on retry.</div>
          {err && <div className="alert bad">{err}</div>}
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Processing…' : `Pay ${money(plan.price_minor)} and start term`}
          </button>
        </form>
      </div>
      <p className="muted small">Prefer to look around first? <Link to="/plans">Back to plans</Link></p>
    </div>
  );
}
