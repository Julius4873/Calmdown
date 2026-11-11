import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregatePoint, calendarMonth, localMinute, mergeAggregate, moveMonth, sampleContribution } from './daily-data.js';

test('local midnight determines the saved day rather than the UTC date', () => {
  assert.equal(localMinute(Date.parse('2026-11-06T22:59:59Z'), 'Europe/Berlin').day, '2026-11-06');
  assert.equal(localMinute(Date.parse('2026-11-06T23:00:00Z'), 'Europe/Berlin').day, '2026-11-07');
  assert.equal(localMinute(Date.parse('2026-11-06T23:00:00Z'), 'America/New_York').day, '2026-11-06');
});

test('DST repeated minutes have distinct UTC keys and their original offsets', () => {
  const early = localMinute(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Berlin');
  const late = localMinute(Date.parse('2026-10-25T01:30:00Z'), 'Europe/Berlin');
  assert.equal(early.day, late.day);
  assert.equal(late.minute - early.minute, 60);
  assert.equal(early.offsetMinutes, 120);
  assert.equal(late.offsetMinutes, 60);
});

test('the skipped spring hour does not create invented buckets or a different day', () => {
  const before = localMinute(Date.parse('2026-03-29T00:59:00Z'), 'Europe/Berlin');
  const after = localMinute(Date.parse('2026-03-29T01:00:00Z'), 'Europe/Berlin');
  assert.equal(before.day, after.day);
  assert.equal(after.minute - before.minute, 1);
  assert.equal(before.offsetMinutes, 60);
  assert.equal(after.offsetMinutes, 120);
});

test('only pulse and respiration enter aggregates and demo values are always excluded', () => {
  const source = { receivedAt: Date.parse('2026-11-07T10:00Z'), heartRate: 72, respirationRate: 15, stressScore: 30, spo2: 98 };
  const value = sampleContribution(source, 'Europe/Berlin');
  assert.deepEqual(value.metrics, {
    heartRate: { count: 1, sum: 72, max: 72 },
    respirationRate: { count: 1, sum: 15, max: 15 },
  });
  assert.equal(sampleContribution({ ...source, demo: true }), null);
  assert.equal(sampleContribution({ receivedAt: source.receivedAt, heartRate: null, spo2: 101, stressIndex: -1 }), null);
  assert.equal(sampleContribution({ receivedAt: NaN, heartRate: 72 }), null);
});

test('metric sums and counts preserve weighted average and maxima', () => {
  const source = { receivedAt: Date.parse('2026-11-07T10:00Z'), heartRate: 60 };
  const first = sampleContribution(source, 'Europe/Berlin');
  const second = sampleContribution({ ...source, receivedAt: source.receivedAt + 1000, heartRate: 120, respirationRate: 16 }, 'Europe/Berlin');
  const merged = mergeAggregate(first, second);
  assert.equal(merged.metrics.heartRate.sum / merged.metrics.heartRate.count, 90);
  assert.equal(merged.metrics.heartRate.max, 120);
  assert.equal(merged.metrics.respirationRate.count, 1);
  const point = aggregatePoint(merged);
  assert.equal(point.heartRate, 90);
  assert.equal(point.respirationRate, 16);
  assert.ok(point.at <= merged.lastAt);
});

test('calendar uses Monday-first weeks, real month lengths and stable year changes', () => {
  const leap = calendarMonth('2024-02');
  assert.equal(leap.filter(Boolean).length, 29);
  assert.deepEqual(leap.slice(0, 4), [null, null, null, '2024-02-01']);
  const november = calendarMonth('2026-11');
  assert.equal(november[6], '2026-11-01');
  assert.equal(november.filter(Boolean).length, 30);
  assert.equal(november.length % 7, 0);
  assert.equal(moveMonth('2026-12', 1), '2027-01');
  assert.equal(moveMonth('2026-01', -1), '2025-12');
  assert.throws(() => calendarMonth('2026-13'));
});
