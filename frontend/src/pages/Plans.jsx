import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api.js';
import { useAuth } from '../App.jsx';

export default function Plans() {
  const { user } = useAuth();
  const [plans, setPlans] = useState(null);
  useEffect(() => { api.get('/api/plans').then(setPlans).catch(console.error); }, []);

  return (
    <div className="container pad">
      <div style={{ textAlign: 'center', maxWidth: 640, margin: '0 auto' }}>
        <h1>Choose the plan that moves you forward</h1>
        <p className="muted">
          Prepaid terms with a simple promise: if you stop mid-term, we refund the unused time.
          No clawbacks, no small print.
        </p>
      </div>

      <div className="grid plans">
        {plans?.map((p) => (
          <div key={p.id} className={p.code === 'pro' ? 'plan-card popular' : 'plan-card'}>
            {p.code === 'pro' && <div className="plan-ribbon">Most popular</div>}
            <h3>{p.name}</h3>
            <div className="plan-price">{money(p.price_minor)} <small>/ {p.term_months} month{p.term_months > 1 ? 's' : ''}</small></div>
            <div className="muted small">≈ {money(Math.round(p.price_minor / p.term_months))} per month · {p.course_count} course{p.course_count !== 1 ? 's' : ''}</div>
            <ul className="plan-feats">
              <li>Full access to: {p.course_titles.join(', ')}</li>
              <li>Exercises with model solutions</li>
              <li>Certificates of completion</li>
              <li>Unused-time refund guarantee</li>
            </ul>
            <Link className={p.code === 'pro' ? 'btn primary block' : 'btn ghost block'} to={user ? `/checkout/${p.id}` : '/auth'}>
              {user ? `Get ${p.name}` : 'Sign in to subscribe'}
            </Link>
          </div>
        ))}
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: '1.6rem' }}>
        Every payment is split exactly to the cent between the platform and your instructors,
        and recognized daily across your term.
      </p>
    </div>
  );
}
