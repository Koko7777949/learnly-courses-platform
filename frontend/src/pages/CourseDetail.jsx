import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money } from '../api.js';
import { Stars, fmtCount } from '../ui.jsx';
import { useAuth } from '../App.jsx';

export default function CourseDetail() {
  const { slug } = useParams();
  const { user } = useAuth();
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const [openLesson, setOpenLesson] = useState(null);

  useEffect(() => {
    api.get(`/api/courses/${slug}`).then(setC).catch((e) => setErr(e.message));
  }, [slug]);

  if (err) return <div className="container pad"><div className="alert bad">{err}</div></div>;
  if (!c) return <div className="page-loading">Loading…</div>;

  const totalMin = c.sections.reduce((a, s) => a + s.lessons.reduce((x, l) => x + l.duration_min, 0), 0);

  return (
    <div>
      {/* dark banner */}
      <div className="course-banner">
        <div className="container" style={{ paddingBottom: 0 }}>
          <div className="crumbs">
            <Link to="/">Home</Link> › <Link to="/">{c.category}</Link> › <span>{c.title}</span>
          </div>
          <h1>{c.title}</h1>
          <p className="tagline">{c.tagline}</p>
          <div className="course-banner-meta">
            <span><b style={{ color: '#e59819' }}>{(c.rating_avg || 0).toFixed(1)}</b> <Stars value={c.rating_avg} /> <span>({fmtCount(c.rating_count)} ratings)</span></span>
            <span><b>{fmtCount(c.students_count)}</b> learners</span>
            <span>Created by {c.instructors.map((i) => i.display_name).join(', ')}</span>
            <span>Last updated {c.last_updated}</span>
            <span>🌐 {c.language}</span>
          </div>
        </div>
      </div>

      <div className="container">
        <div className="course-layout">
          {/* left column */}
          <div>
            <div className="learn-box">
              <h2>What you’ll learn</h2>
              <ul className="learn-grid">
                {c.what_you_learn.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>

            <h2>Course content</h2>
            <div className="muted small" style={{ marginBottom: '0.6rem' }}>
              {c.sections.length} sections · {c.sections.reduce((a, s) => a + s.lessons.length, 0)} lessons · {Math.round(totalMin / 60)}h {totalMin % 60}m total
            </div>
            <div className="curriculum">
              {c.sections.map((s, i) => (
                <details key={s.title} open={i === 0}>
                  <summary>
                    <span>{s.title}</span>
                    <small>{s.lessons.length} lessons · {s.lessons.reduce((a, l) => a + l.duration_min, 0)}m</small>
                  </summary>
                  {s.lessons.map((l) => (
                    <div className="lesson-line" key={l.id}>
                      {c.hasAccess || l.position === 1 ? (
                        <button onClick={() => setOpenLesson(l.id)}>▶ {l.title}</button>
                      ) : (
                        <span>🔒 {l.title}</span>
                      )}
                      <span className="lesson-dur">{l.duration_min}m</span>
                    </div>
                  ))}
                </details>
              ))}
            </div>

            <h2>Requirements</h2>
            <ul className="muted">
              {c.requirements.map((r, i) => <li key={i}>{r}</li>)}
            </ul>

            <h2>Description</h2>
            <p className="muted">{c.description}</p>

            <h2>Instructors</h2>
            {c.instructors.map((i) => (
              <div className="instructor-card" key={i.id} style={{ marginBottom: '0.8rem' }}>
                <img src={i.avatar} alt={i.display_name} loading="lazy" />
                <div>
                  <h3 style={{ margin: 0 }}>{i.display_name}</h3>
                  <div className="instructor-title">{i.title}</div>
                  <div className="instructor-stats">
                    <span>⭐ {(c.rating_avg || 0).toFixed(1)} instructor rating</span>
                    <span>💬 {fmtCount(i.total_reviews)} reviews</span>
                    <span>🎓 {fmtCount(i.total_students)} students</span>
                    <span>📚 {i.weight > 1 ? `Lead instructor (weight ${i.weight})` : 'Instructor'}</span>
                  </div>
                  <p className="muted small" style={{ margin: 0 }}>{i.bio}</p>
                </div>
              </div>
            ))}

            <h2>Reviews</h2>
            <div className="review-summary">
              <div className="review-avg">
                <div className="num">{(c.rating_avg || 0).toFixed(1)}</div>
                <Stars value={c.rating_avg} />
                <div className="muted small">Course rating</div>
              </div>
              <div style={{ flex: 1 }}>
                {[5, 4, 3, 2, 1].map((r) => {
                  const bar = c.rating_bars.find((b) => b.rating === r);
                  const pct = c.rating_count ? Math.round(((bar?.n || 0) / c.rating_count) * 100) : 0;
                  return (
                    <div className="bar-row" key={r}>
                      <span>{r}★</span>
                      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                      <span className="muted">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              {c.reviews.map((r) => (
                <div className="review-item" key={r.id}>
                  <div className="review-head">
                    <b>{r.reviewer_name}</b>
                    <Stars value={r.rating} />
                    <span className="review-date">{new Date(r.created_at).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
                  </div>
                  <div className="strong small" style={{ margin: '0.2rem 0' }}>{r.title}</div>
                  <p className="muted small" style={{ margin: 0 }}>{r.body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* sticky buy card */}
          <aside>
            <div className="buy-card">
              <img src={c.image} alt={c.title} />
              <div className="buy-card-body">
                {c.hasAccess ? (
                  <>
                    <div className="ok-note">✓ Included in your active subscription</div>
                    <Link className="btn primary block" to="/learn">Continue learning →</Link>
                  </>
                ) : (
                  <>
                    <div className="buy-price">Included in plans</div>
                    <div className="buy-note">Prepaid terms · unused-time refund guarantee</div>
                    {c.plans.map((p) => (
                      <div className="plan-row" key={p.id}>
                        <div>
                          <strong>{p.name}</strong>
                          <div className="muted small">{p.term_months} month{p.term_months > 1 ? 's' : ''}</div>
                        </div>
                        <div className="plan-row-right">
                          <span className="price">{money(p.price_minor)}</span>
                          <Link className="btn primary sm" to={user ? `/checkout/${p.id}` : '/auth'}>
                            {user ? 'Subscribe' : 'Sign in'}
                          </Link>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                <ul className="includes-list">
                  <li>{Math.round(totalMin / 60)}h {totalMin % 60}m on-demand video</li>
                  <li>{c.sections.reduce((a, s) => a + s.lessons.length, 0)} lessons in {c.sections.length} sections</li>
                  <li>Hands-on exercises with model solutions</li>
                  <li>Access on any device, for the full term</li>
                  <li>Certificate of completion</li>
                </ul>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {openLesson && <LessonModal id={openLesson} onClose={() => setOpenLesson(null)} />}
    </div>
  );
}

function LessonModal({ id, onClose }) {
  const [lesson, setLesson] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get(`/api/lessons/${id}`).then(setLesson).catch((e) => setErr(e.message));
  }, [id]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {err && <div className="alert bad">{err}</div>}
        {lesson && (
          <>
            <h3>{lesson.title}</h3>
            <div className="muted small">{lesson.section} · Lesson {lesson.position} · {lesson.duration_min} min</div>
            <div className="video-stub">▶ Video player placeholder</div>
            <p>{lesson.content}</p>
          </>
        )}
        <button className="btn ghost sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
