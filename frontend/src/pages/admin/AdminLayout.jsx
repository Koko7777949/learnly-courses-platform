import React, { useEffect } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from '../../App.jsx';
import Overview from './Overview.jsx';
import Balances from './Balances.jsx';
import Payouts from './Payouts.jsx';
import PayoutDetail from './PayoutDetail.jsx';
import Subscriptions from './Subscriptions.jsx';
import ProviderConsole from './ProviderConsole.jsx';

export default function AdminLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (user && user.role !== 'admin') navigate('/');
  }, [user, navigate]);
  if (!user) return <div className="page-loading">Sign in as admin…</div>;
  if (user.role !== 'admin') return null;

  return (
    <div className="admin">
      <aside className="admin-side">
        <div className="admin-side-title">Ops console</div>
        <NavLink to="/admin" end>Overview</NavLink>
        <NavLink to="/admin/balances">Instructor balances</NavLink>
        <NavLink to="/admin/payouts">Payout history</NavLink>
        <NavLink to="/admin/subscriptions">Subscriptions & refunds</NavLink>
        <NavLink to="/admin/provider">Provider & jobs</NavLink>
        <div className="admin-side-note">
          Read-only operational views per spec — payouts are triggered by the
          <code> revenue:payouts</code> command and reconciler only.
        </div>
      </aside>
      <div className="admin-main">
        <Routes>
          <Route index element={<Overview />} />
          <Route path="balances" element={<Balances />} />
          <Route path="payouts" element={<Payouts />} />
          <Route path="payouts/:id" element={<PayoutDetail />} />
          <Route path="subscriptions" element={<Subscriptions />} />
          <Route path="provider" element={<ProviderConsole />} />
        </Routes>
      </div>
    </div>
  );
}
