import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, money, dateOnly } from '../api.js';
import { useAuth } from '../App.jsx';

function LessonViewer({ lessonId, onClose }) {
  const [lesson, setLesson] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setLesson(null); setErr(null);
    api.get(`/api/lessons/${lessonId}`).then(setLesson).catch((e) => setErr(e.message));
  }, [lessonId]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {err && <div className="alert bad">{err}</div>}
        {lesson && (
          <>
            <h3>{lesson.title}</h3>
            <div className="muted small">Lesson {lesson.position} · {lesson.duration_min} min</div>
            <div className="video-stub">▶ Video player placeholder</div>
            <p>{lesson.content}</p>
          </>
        )}
        <button className="btn ghost sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export default function MyLearning() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [subs, setSubs] = useState(null);
  const [courses, setCourses] = useState(null);
  const [openLesson, setOpenLesson] = useState(null);
  const [err, setErr] = useState(null);

  const load = () => {
    api.get('/api/my/subscriptions').then(setSubs).catch((e) => setErr(e.message));
    api.get('/api/my/courses').then(setCourses).catch((e) => setErr(e.message));
  };
  useEffect(() => {
    if (!user) navigate('/auth');
    else load();
  }, [user]); // eslint-disable-line

  const refund = async (id) => {
    if (!window.confirm('Request a mid-term refund? You receive the unused portion of your term back.')) return;
    try { await api.post(`/api/my/subscriptions/${id}/refund`); load(); }
    catch (e) { setErr(e.message); }
  };

  if (!user) return null;
  return (
    <div className="container pad">
      <h1>My learning</h1>
      {err && <div className="alert bad">{err}</div>}

      <h2>My subscriptions</h2>
      {!subs && <div className="page-loading">Loading…</div>}
      {subs && subs.length === 0 && (
        <p className="muted">No subscriptions yet — <Link to="/plans">pick a plan</Link>.</p>
      )}
      <div className="table-wrap">
        {subs && subs.length > 0 && (
          <table>
            <thead><tr><th>Plan</th><th>Term</th><th>Paid</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id}>
                  <td>{s.plan_name}</td>
                  <td>{dateOnly(s.starts_at)} → {dateOnly(s.ends_at)}</td>
                  <td>{money(s.gross_minor, s.currency)}</td>
                  <td>
                    <span className={`badge ${s.isCurrent ? 'ok' : s.status === 'refunded' ? 'warn' : 'muted'}`}>
                      {s.status}{s.isCurrent ? ` · ${s.remainingDays}d left` : ''}
                    </span>
                  </td>
                  <td>
                    {s.isCurrent && (
                      <button className="btn ghost sm" onClick={() => refund(s.id)}>Request refund</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>My courses</h2>
      {!courses && <div className="page-loading">Loading…</div>}
      {courses && courses.length === 0 && (
        <p className="muted">Active subscriptions appear here with their included courses.</p>
      )}
      <div className="grid courses">
        {courses?.map((c) => (
          <div key={c.id} className="course-card" style={{ borderTopColor: c.accent }}>
            <h3>{c.title}</h3>
            <p className="tagline">{c.tagline}</p>
            <Link to={`/courses/${c.slug}`} className="btn ghost sm">Course page</Link>
            <button className="btn primary sm" onClick={() => setOpenLesson({ courseId: c.id })}>Open first lesson</button>
          </div>
        ))}
      </div>

      {openLesson && (
        <FirstLesson courseId={openLesson.courseId} onClose={() => setOpenLesson(null)} />
      )}
    </div>
  );
}

function FirstLesson({ courseId, onClose }) {
  const [lessonId, setLessonId] = useState(null);
  useEffect(() => {
    api.get(`/api/my/courses`).then((rows) => {
      const c = rows.find((r) => r.id === courseId);
      if (c) api.get(`/api/courses/${c.slug}`).then((full) => setLessonId(full.lessons[0]?.id));
    });
  }, [courseId]);
  if (!lessonId) return null;
  return <LessonViewer lessonId={lessonId} onClose={onClose} />;
}
