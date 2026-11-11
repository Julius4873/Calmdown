export const DAILY_METRICS = [
  { key: 'heartRate', label: 'Puls', unit: 'bpm', min: 50, max: 110, color: '#ac4c3d' },
  { key: 'respirationRate', label: 'Atmung', unit: '/min', min: 8, max: 28, color: '#27766a' },
];

const formatters = new Map();

export function localMinute(at, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!Number.isFinite(at) || Number.isNaN(new Date(at).getTime())) throw new RangeError('Ungültige Messzeit.');
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(at)
    .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  const day = parts.year + '-' + parts.month + '-' + parts.day;
  const minute = Math.floor(at / 60_000);
  const wallMinute = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return { day, month: day.slice(0, 7), minute, timeZone, offsetMinutes: (wallMinute - minute * 60_000) / 60_000 };
}

function validRate(value) {
  return Number.isFinite(value) && value >= 0 && value < 6553.5;
}

export function sampleContribution(sample, timeZone) {
  if (sample.demo || !Number.isFinite(sample.receivedAt) || Number.isNaN(new Date(sample.receivedAt).getTime())) return null;
  const metrics = {};
  for (const { key } of DAILY_METRICS) {
    const value = sample[key];
    if (validRate(value)) metrics[key] = { count: 1, sum: value, max: value };
  }
  if (!Object.keys(metrics).length) return null;
  const local = localMinute(sample.receivedAt, timeZone);
  return { ...local, firstAt: sample.receivedAt, lastAt: sample.receivedAt, samples: 1, metrics };
}

export function mergeAggregate(previous, next) {
  // Keep older metric fields intact in storage. Only current metrics receive
  // new values, and read/export paths project the supported fields.
  const metrics = { ...previous?.metrics };
  for (const { key } of DAILY_METRICS) {
    const value = next.metrics[key];
    if (!value) continue;
    const old = metrics[key] ?? { count: 0, sum: 0, max: -Infinity };
    const previousMax = Number.isFinite(old.max) ? old.max : -Infinity;
    metrics[key] = { count: old.count + value.count, sum: old.sum + value.sum, max: Math.max(previousMax, value.max) };
  }
  return {
    ...previous, ...next,
    firstAt: Math.min(previous?.firstAt ?? next.firstAt, next.firstAt),
    lastAt: Math.max(previous?.lastAt ?? next.lastAt, next.lastAt),
    samples: (previous?.samples ?? 0) + next.samples,
    metrics,
  };
}

export function supportedAggregate(record) {
  if (!record) return null;
  const metrics = {};
  for (const { key } of DAILY_METRICS) {
    const metric = record.metrics?.[key];
    if (metric?.count > 0) {
      metrics[key] = { count: metric.count, sum: metric.sum, max: metric.max };
    }
  }
  if (!Object.keys(metrics).length) return null;
  const { day, month, firstAt, lastAt, samples, minute, timeZone, offsetMinutes } = record;
  const summary = { day, month, firstAt, lastAt, samples, metrics };
  return Number.isFinite(minute) ? { ...summary, minute, timeZone, offsetMinutes } : summary;
}

export function aggregatePoint(bucket) {
  const point = { at: Math.min(bucket.minute * 60_000 + 30_000, bucket.lastAt), timeZone: bucket.timeZone, offsetMinutes: bucket.offsetMinutes, aggregated: true };
  for (const { key } of DAILY_METRICS) {
    const metric = bucket.metrics[key];
    point[key] = metric?.count ? metric.sum / metric.count : null;
  }
  return point;
}

export function historyContribution(record) {
  const { firstAt, lastAt, offsetMinutes, samples, metrics } = record;
  const day = new Date(firstAt + offsetMinutes * 60_000).toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7), minute: Math.floor(firstAt / 60_000),
    firstAt, lastAt, offsetMinutes, timeZone: null, samples, metrics };
}

export function calendarMonth(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new RangeError('Ungültiger Monat.');
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const first = new Date(Date.UTC(year, index, 1, 12));
  const offset = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, index + 1, 0, 12)).getUTCDate();
  const cells = Array(offset).fill(null);
  for (let day = 1; day <= count; day++) cells.push(month + '-' + String(day).padStart(2, '0'));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function moveMonth(month, delta) {
  calendarMonth(month);
  const [year, index] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, index - 1 + delta, 1, 12));
  return String(date.getUTCFullYear()).padStart(4, '0') + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
}

export function dayDate(day) {
  return new Date(day + 'T12:00:00Z');
}
