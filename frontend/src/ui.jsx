import React from 'react';
import { Link } from 'react-router-dom';
import { money } from './api.js';

export function fmtCount(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

export function Stars({ value }) {
  const v = Math.max(0, Math.min(5, Number(value) || 0));
  const full = Math.round(v);
  return (
    <span className="stars" aria-label={`${v} out of 5 stars`}>
      {'★'.repeat(full)}{'☆'.repeat(5 - full)}
    </span>
  );
}

export function CourseCard({ c }) {
  return (
    <Link className="course-card" to={`/courses/${c.slug}`}>
      <img src={c.image} alt={c.title} loading="lazy" />
      <div className="course-card-body">
        <div className="course-cat">{c.category || 'Course'}</div>
        <h3>{c.title}</h3>
        <div className="course-instructor">{(c.instructors || []).map((i) => i.display_name).join(', ')}</div>
        <div className="rating-line">
          <span className="rating-num">{(c.rating_avg || 0).toFixed(1)}</span>
          <Stars value={c.rating_avg} />
          <span className="rating-count">({fmtCount(c.rating_count)})</span>
        </div>
        <div className="course-meta">
          <span>{c.lesson_count} lessons</span>
          <span>{Math.round((c.total_minutes || 0) / 60)}h {c.total_minutes % 60}m</span>
          <span>{fmtCount(c.students_count)} learners</span>
        </div>
        <div className="course-foot">
          <span className="price">{c.from_minor ? `From ${money(c.from_minor)}` : 'All-Access'}</span>
          <span className="price-note">with a plan · {c.level}</span>
        </div>
      </div>
    </Link>
  );
}
