import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { CourseCard } from '../ui.jsx';

export default function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const [rows, setRows] = useState(null);

  useEffect(() => {
    setRows(null);
    api.get(`/api/search?q=${encodeURIComponent(q)}`).then(setRows).catch(console.error);
  }, [q]);

  return (
    <div className="container pad">
      <h1>Results for “{q}”</h1>
      {!rows && <div className="page-loading">Searching…</div>}
      {rows && rows.length === 0 && <p className="muted">No courses match. Try “react”, “sql”, “system design”…</p>}
      <div className="grid courses">
        {rows?.map((c) => <CourseCard key={c.id} c={{ ...c, instructors: [] }} />)}
      </div>
    </div>
  );
}
