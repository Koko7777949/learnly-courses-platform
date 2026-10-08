import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Routes, Route, Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Catalog from './pages/Catalog.jsx';
import CourseDetail from './pages/CourseDetail.jsx';
import Plans from './pages/Plans.jsx';
import AuthPage from './pages/AuthPage.jsx';
import Checkout from './pages/Checkout.jsx';
import MyLearning from './pages/MyLearning.jsx';
import SearchPage from './pages/Search.jsx';
import InstructorDashboard from './pages/InstructorDashboard.jsx';
import AdminLayout from './pages/admin/AdminLayout.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function Spinner() {
  return <div className="page-loading">Loading…</div>;
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const { user: u } = await api.get('/api/auth/me');
      setUser(u);
    } catch { setUser(null); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    navigate('/');
  };

  if (user === undefined) return <Spinner />;

  return (
    <AuthCtx.Provider value={{ user, setUser, refresh }}>
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-mark">▲</span>learnly</Link>
        <nav className="nav">
          <NavLink to="/plans">Plans</NavLink>
          {user?.role === 'student' && <NavLink to="/learn">My learning</NavLink>}
          {user?.role === 'instructor' && <NavLink to="/instructor">Instructor</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin">Ops console</NavLink>}
        </nav>
        <form className="searchbox" onSubmit={(e) => { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(q)}`); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for anything" aria-label="Search courses" />
        </form>
        <div className="auth-zone">
          {user ? (
            <>
              <span className="whoami">{user.name} <em>· {user.role}</em></span>
              <button className="btn ghost sm" onClick={logout}>Sign out</button>
            </>
          ) : (
            <>
              <Link className="btn ghost sm" to="/auth">Log in</Link>
              <Link className="btn primary sm" to="/auth">Sign up</Link>
            </>
          )}
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Catalog />} />
          <Route path="/courses/:slug" element={<CourseDetail />} />
          <Route path="/plans" element={<Plans />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/checkout/:planId" element={<Checkout />} />
          <Route path="/learn" element={<MyLearning />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/instructor" element={<InstructorDashboard />} />
          <Route path="/admin/*" element={<AdminLayout />} />
          <Route path="*" element={<div className="container pad">Page not found. <Link to="/">Back to catalog</Link></div>} />
        </Routes>
      </main>

      <footer className="footer">
        <span><b>learnly</b> · online courses platform</span>
        <span className="footer-note">
          Prepaid subscriptions · straight-line revenue recognition · exact integer allocation · failure-safe payouts
        </span>
      </footer>
    </AuthCtx.Provider>
  );
}
