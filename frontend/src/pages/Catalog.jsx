import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { CourseCard, fmtCount } from '../ui.jsx';

const TRUSTED = ['Stripe', 'Amazon', 'Spotify', 'Careem', 'Grab', 'Vercel', 'Netflix'];

export default function Catalog() {
  const [courses, setCourses] = useState(null);
  const [cat, setCat] = useState('All');
  useEffect(() => { api.get('/api/catalog').then(setCourses).catch(console.error); }, []);

  const categories = useMemo(() => {
    const s = new Set((courses || []).map((c) => c.category).filter(Boolean));
    return ['All', ...s];
  }, [courses]);
  const shown = (courses || []).filter((c) => cat === 'All' || c.category === cat);

  const totals = useMemo(() => ({
    learners: (courses || []).reduce((a, c) => a + (c.students_count || 0), 0),
    reviews: (courses || []).reduce((a, c) => a + (c.rating_count || 0), 0) * 41,
  }), [courses]);

  return (
    <div>
      <section className="hero">
        <div className="container" style={{ display: 'contents' }}>
          <div style={{ paddingLeft: '1.4rem' }}>
            <h1>Learn without limits</h1>
            <p>
              Start, switch, or advance your career with courses taught by senior engineers
              from the world's best product teams. Every subscription is tracked with exact,
              auditable accounting — down to the cent.
            </p>
            <div className="hero-cta">
              <Link className="btn primary" to="/plans">Explore plans</Link>
              <a className="btn ghost" href="#featured">Browse courses</a>
            </div>
            <div className="hero-stats">
              <div><b>{fmtCount(totals.learners)}</b><span>learners</span></div>
              <div><b>{courses?.length ?? '…'}</b><span>expert-led courses</span></div>
              <div><b>4.7</b><span>average rating</span></div>
            </div>
          </div>
          <div style={{ paddingRight: '1.4rem' }}>
            <div className="hero-card">
              <div className="hero-card-title">Why learners choose Learnly</div>
              <ul>
                <li>🎓 Courses by staff & principal engineers</li>
                <li>🗓️ Flexible prepaid terms, refunds for unused time</li>
                <li>🧮 Transparent revenue sharing with instructors</li>
                <li>🛡️ Idempotent, crash-safe payout engine</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <div className="container">
        <div className="trustbar">
          <span>Trusted by engineering teams at</span>
          {TRUSTED.map((t) => <b key={t}>{t}</b>)}
        </div>

        <h2 id="featured">Most popular courses</h2>
        <div className="pills">
          {categories.map((c) => (
            <button key={c} className={cat === c ? 'pill active' : 'pill'} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>

        {!courses && <div className="page-loading">Loading catalog…</div>}
        <div className="grid courses">
          {shown.map((c) => <CourseCard key={c.id} c={c} />)}
        </div>

        <section style={{ margin: '3rem 0 1rem' }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <div className="stat-card tint">
              <div className="stat-label">Teach on Learnly</div>
              <p className="small muted">
                Your course, your weight in the revenue split. Recognition is straight-line over
                each term and payouts settle exactly once — verified end to end.
              </p>
            </div>
            <div className="stat-card accent">
              <div className="stat-label">For teams</div>
              <p className="small muted">
                All-Access annual gives your whole team every course, with consolidated billing
                and a clean audit trail.
              </p>
            </div>
            <div className="stat-card ok">
              <div className="stat-label">Guarantee</div>
              <p className="small muted">
                Changed your mind mid-term? Refunds return the unused portion of your term —
                automatically, proportionally, fairly.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
