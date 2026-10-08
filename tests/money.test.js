'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { platformFee, allocate, earnedToDate, toMinor } = require('../src/money');

test('money: minor unit parsing', () => {
  assert.equal(toMinor('129.95'), 12995);
  assert.equal(toMinor('10'), 1000);
  assert.equal(toMinor('0.05'), 5);
});

test('platform fee: round half up, basis points', () => {
  // 10000 * 1000 / 10000 = exactly 1000
  assert.deepEqual(platformFee(10000, 1000), { fee: 1000, distributable: 9000 });
  // 12995 * 1500 / 10000 = 1949.25 -> round half up = 1949
  assert.equal(platformFee(12995, 1500).fee, 1949);
  // 1 * 5000 / 10000 = 0.5 -> 1 (half up)
  assert.equal(platformFee(1, 5000).fee, 1);
});

test('allocation: equal split of 10000 over 3 sums exactly, deterministic tie-break', () => {
  const shares = allocate(10000, [
    { instructor_id: 12, weight: 1 },
    { instructor_id: 10, weight: 1 },
    { instructor_id: 11, weight: 1 },
  ]);
  let sum = 0;
  for (const v of shares.values()) sum += v;
  assert.equal(sum, 10000);
  // leftover cent goes to lowest instructor id (10)
  assert.equal(shares.get(10), 3334);
  assert.equal(shares.get(11), 3333);
  assert.equal(shares.get(12), 3333);
});

test('allocation: weighted split is exact', () => {
  const shares = allocate(10000, [
    { instructor_id: 1, weight: 2 },
    { instructor_id: 2, weight: 1 },
  ]);
  assert.equal(shares.get(1) + shares.get(2), 10000);
  // 2/3 of 10000 = 6666.67 -> 6667 to weight 2 (largest remainder), 3333 other
  assert.equal(shares.get(1), 6667);
  assert.equal(shares.get(2), 3333);
});

test('allocation: single participant gets everything', () => {
  const shares = allocate(12345, [{ instructor_id: 7, weight: 3 }]);
  assert.equal(shares.get(7), 12345);
});

test('recognition: boundaries of the term', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-31T00:00:00Z'); // 30-day term
  const alloc = 9000;

  // before term
  assert.equal(earnedToDate(alloc, start, end, new Date('2025-12-31T23:59:59Z')), 0);
  // at start
  assert.equal(earnedToDate(alloc, start, end, new Date('2026-01-01T12:00:00Z')), 0);
  // after 1 day
  assert.equal(earnedToDate(alloc, start, end, new Date('2026-01-02T00:00:00Z')), 300);
  // mid term: 15 days elapsed -> 4500
  assert.equal(earnedToDate(alloc, start, end, new Date('2026-01-16T00:00:00Z')), 4500);
  // final day boundary: exactly at end -> full amount
  assert.equal(earnedToDate(alloc, start, end, new Date('2026-01-31T00:00:00Z')), 9000);
  // after expiry clamps to full
  assert.equal(earnedToDate(alloc, start, end, new Date('2027-01-01T00:00:00Z')), 9000);
});

test('recognition: floor keeps integer cents', () => {
  const start = new Date('2026-03-01T00:00:00Z');
  const end = new Date('2026-03-04T00:00:00Z'); // 3 days
  // 100 / 3 = 33.33 -> 33 per day
  assert.equal(earnedToDate(100, start, end, new Date('2026-03-02T00:00:00Z')), 33);
  assert.equal(earnedToDate(100, start, end, new Date('2026-03-03T00:00:00Z')), 66);
  assert.equal(earnedToDate(100, start, end, new Date('2026-03-04T00:00:00Z')), 100);
});
