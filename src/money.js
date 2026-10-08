'use strict';
/**
 * Monetary model — all money is integer minor units (cents).
 *
 * Mirrors §3 of the Engineering Documentation Pack:
 *  - Never do floating point money math.
 *  - Platform fee uses basis points with round-half-up.
 *  - Weighted largest-remainder allocation so shares sum EXACTLY to the
 *    distributable amount. Ties on fractional remainder break by ascending
 *    instructor id (deterministic).
 *
 * We use BigInt internally to be safe against overflow on G*F products, then
 * down-cast to Number (safe: all values << 2^53) at the boundary.
 */

function toMinor(str) {
  // "129.95" -> 12995
  const s = String(str).trim();
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [whole, frac = ''] = body.split('.');
  const cents = (frac + '00').slice(0, 2);
  const v = BigInt(whole || '0') * 100n + BigInt(cents);
  return Number(neg ? -v : v);
}

function fmt(minor, currency = 'USD') {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const sym = currency === 'USD' ? '$' : currency + ' ';
  return `${sign}${sym}${whole.toLocaleString('en-US')}.${cents}`;
}

function roundHalfUpDiv(num, den) {
  // floor((num/den) + 0.5) using integer math => (2*num + den) / (2*den) floor
  num = BigInt(num); den = BigInt(den);
  return Number((2n * num + den) / (2n * den));
}

function floorDiv(num, den) {
  num = BigInt(num); den = BigInt(den);
  const q = num / den;
  return Number(q); // BigInt division truncates toward zero; num>=0 here
}

/**
 * Platform fee (§3.2).
 * platform_fee = round_half_up(G * F / 10_000); distributable = G - fee.
 */
function platformFee(grossMinor, feeBps) {
  const fee = roundHalfUpDiv(BigInt(grossMinor) * BigInt(feeBps), 10000n);
  return { fee, distributable: grossMinor - fee };
}

/**
 * Weighted largest-remainder allocation (§3.3).
 *
 * @param {number} distributable  integer minor units to split
 * @param {Array<{instructor_id:number, weight:number}>} participants
 * @returns {Map<number, number>} instructor_id -> allocated minor units
 *
 * Invariant: sum(allocated) === distributable exactly.
 */
function allocate(distributable, participants) {
  const D = BigInt(distributable);
  const W = participants.reduce((a, p) => a + BigInt(p.weight), 0n);
  if (W === 0n) throw new Error('total weight must be positive');
  if (participants.length === 0) return new Map();

  const rows = participants.map((p) => {
    const num = D * BigInt(p.weight);
    return {
      instructor_id: p.instructor_id,
      base: Number(num / W),
      remainder: Number(num % W),
    };
  });

  let leftover = Number(D - rows.reduce((a, r) => a + BigInt(r.base), 0n));

  // largest remainder first; tie -> ascending instructor id
  const order = [...rows].sort(
    (a, b) => b.remainder - a.remainder || a.instructor_id - b.instructor_id,
  );
  const out = new Map();
  for (const r of rows) out.set(r.instructor_id, r.base);
  for (let i = 0; i < leftover; i++) {
    const pick = order[i % order.length];
    out.set(pick.instructor_id, out.get(pick.instructor_id) + 1);
  }
  return out;
}

/**
 * Earned-to-date (§5.1). Straight-line daily recognition over [start, end).
 * Deterministic for a frozen `now` and stored term boundaries.
 */
function daysBetween(a, b) {
  const MS = 86400000;
  const au = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bu = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((bu - au) / MS);
}

function earnedToDate(allocatedMinor, termStart, termEnd, now) {
  const termDays = daysBetween(termStart, termEnd);
  if (termDays <= 0) return allocatedMinor; // degenerate term -> fully earned
  const elapsed = daysBetween(termStart, now);
  const clamped = Math.max(0, Math.min(elapsed, termDays));
  return floorDiv(BigInt(allocatedMinor) * BigInt(clamped), BigInt(termDays));
}

module.exports = { toMinor, fmt, platformFee, allocate, earnedToDate, roundHalfUpDiv, floorDiv, daysBetween };
