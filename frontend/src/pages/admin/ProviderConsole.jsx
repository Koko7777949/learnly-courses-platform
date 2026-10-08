import React, { useEffect, useState } from 'react';
import { api, dt, money, PAYOUT_STATUS_CLASS } from '../../api.js';

const SCENARIOS = [
  { id: 'success', label: 'SUCCESS', desc: 'Money moves, caller sees success.' },
  { id: 'permanent_failure', label: 'PERMANENT_FAILURE', desc: 'Nothing moves, caller sees failure. Reservation is released.' },
  { id: 'timeout_after_success', label: 'TIMEOUT_AFTER_SUCCESS', desc: 'Money moves, caller gets a timeout. Payout → VERIFY until reconciliation.' },
];

function Badge({ name }) {
  const cls = PAYOUT_STATUS_CLASS[name] || (name === 'done' ? 'ok' : name === 'failed' ? 'bad' : name === 'running' ? 'info' : 'muted');
  return <span className={`badge ${cls}`}>{name}</span>;
}

export default function ProviderConsole() {
  const [cfg, setCfg] = useState(null);
  const [events, setEvents] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [msg, setMsg] = useState('');

  const load = () => {
    api.get('/api/admin/provider').then(setCfg).catch(console.error);
    api.get('/api/admin/events?limit=40').then(setEvents).catch(console.error);
    api.get('/api/admin/jobs').then(setJobs).catch(console.error);
  };
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);

  const setScenario = async (scenario) => {
    await api.post('/api/admin/provider', { scenario });
    setMsg(`Global provider scenario set to ${scenario}.`);
    load();
  };

  if (!cfg) return <div className="page-loading">Loading…</div>;
  return (
    <div>
      <h1>Mock provider & queue</h1>
      <p className="muted">
        The provider is modeled as an unreliable distributed system (§8): it keeps its own durable
        transaction store keyed by idempotency key and can move money even when the caller times out.
      </p>

      <h2>Provider scenario</h2>
      <div className="scenario-grid">
        {SCENARIOS.map((s) => (
          <button key={s.id}
            className={`scenario-card ${cfg.scenario === s.id ? 'active' : ''}`}
            onClick={() => setScenario(s.id)}>
            <div className="strong">{s.label}</div>
            <div className="muted small">{s.desc}</div>
            {cfg.scenario === s.id && <div className="ok-note small">● active</div>}
          </button>
        ))}
      </div>
      {msg && <div className="alert info">{msg}</div>}

      <div className="two-col">
        <section>
          <h2>Event log</h2>
          <div className="event-log">
            {(events || []).map((e) => (
              <div key={e.id} className="event-row">
                <span className="event-name">{e.name}</span>
                <span className="muted small">{e.entity_type ? `${e.entity_type}#${e.entity_id}` : ''}</span>
                <span className="event-payload small">{JSON.stringify(JSON.parse(e.payload))}</span>
                <span className="muted small">{dt(e.created_at)}</span>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h2>Job queue</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Type</th><th>Status</th><th>Attempts</th><th>Updated</th></tr></thead>
              <tbody>
                {(jobs || []).slice(0, 20).map((j) => (
                  <tr key={j.id}>
                    <td>{j.id}</td>
                    <td className="small">{j.type}</td>
                    <td><Badge name={j.status} /></td>
                    <td>{j.attempts}</td>
                    <td className="muted small">{dt(j.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
