import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

const DEMO = [
  { label: 'Student', email: 'sara@student.test' },
  { label: 'Instructor (Lina)', email: 'lina@platform.test' },
  { label: 'Instructor (Omar)', email: 'omar@platform.test' },
  { label: 'Instructor (Maya)', email: 'maya@platform.test' },
  { label: 'Ops admin', email: 'admin@platform.test' },
];

export default function AuthPage() {
  const { refresh } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const dest = location.state?.from || '/';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
      const body = mode === 'login' ? { email: form.email, password: form.password } : form;
      const { user } = await api.post(endpoint, body);
      await refresh();
      navigate(user.role === 'admin' ? '/admin' : dest);
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="container pad narrow">
      <div className="auth-card">
        <div className="tabs">
          <button className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => setMode('login')}>Sign in</button>
          <button className={mode === 'signup' ? 'tab active' : 'tab'} onClick={() => setMode('signup')}>Create account</button>
        </div>

        <form onSubmit={submit}>
          {mode === 'signup' && (
            <label>Full name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
          )}
          <label>Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </label>
          <label>Password{mode === 'signup' ? ' (min 8 chars)' : ''}
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={mode === 'signup' ? 8 : 1} />
          </label>
          {err && <div className="alert bad">{err}</div>}
          <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>

        <div className="demo-accounts">
          <div className="muted small">Demo accounts (password: <code>password123</code>)</div>
          {DEMO.map((d) => (
            <button key={d.email} className="btn ghost sm" onClick={() => setForm({ ...form, email: d.email, password: 'password123' })}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
