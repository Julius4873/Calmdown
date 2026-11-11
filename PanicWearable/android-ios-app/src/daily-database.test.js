import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { DailyDatabase } from './daily-database.js';

const base = Date.parse('2026-11-07T10:00:00Z');
const sample = (offset, extra = {}) => ({ receivedAt: base + offset, heartRate: 60, respirationRate: null, demo: false, ...extra });

function fixture(t, extra = {}) {
  const factory = new IDBFactory();
  const options = { indexedDB: factory, keyRange: IDBKeyRange, name: 'test-daily', ...extra };
  const database = new DailyDatabase(options);
  t.after(() => database.close());
  return { database, options };
}

test('database stores minute buckets and exact daily statistics rather than mean-of-means', async (t) => {
  const { database } = fixture(t);
  for (const [offset, heartRate] of [[0, 60], [1000, 60], [2000, 120], [60_000, 160]]) {
    await database.record(sample(offset, { heartRate }), 'Europe/Berlin');
  }
  const { summary, minutes } = await database.getDay('2026-11-07');
  assert.equal(minutes.length, 2);
  assert.equal(summary.samples, 4);
  assert.deepEqual(summary.metrics.heartRate, { count: 4, sum: 400, max: 160 });
  assert.equal(summary.metrics.heartRate.sum / summary.metrics.heartRate.count, 100);
  assert.deepEqual(minutes.map(({ metrics }) => metrics.heartRate.count), [3, 1]);
  assert.equal((await database.listDays('2026-11')).length, 1);
  assert.equal((await database.listDays('2026-10')).length, 0);
});

test('demo packets, missing metrics and reconnect duplicate packets never inflate daily data', async (t) => {
  const { database } = fixture(t);
  assert.equal(await database.record(sample(0, { demo: true, spo2: 99, stressIndex: 80 })), false);
  assert.equal(await database.record(sample(0, { heartRate: null, spo2: 98, stressScore: 22 })), false);
  assert.equal(await database.countDays(), 0);
  await database.record(sample(0, { packetCount: 7, uptimeMs: 7000, stressIndex: 22, spo2: 98 }), 'Europe/Berlin');
  assert.equal(await database.record(sample(1000, { packetCount: 7, uptimeMs: 7000, spo2: 99 }), 'Europe/Berlin'), false);
  await database.record(sample(2000, { packetCount: 8, uptimeMs: 8000, heartRate: null, respirationRate: 15 }), 'Europe/Berlin');
  const { summary } = await database.getDay('2026-11-07');
  assert.equal(summary.samples, 2);
  assert.equal(summary.metrics.heartRate.count, 1);
  assert.deepEqual(Object.keys(summary.metrics).sort(), ['heartRate', 'respirationRate']);
});

test('legacy measurements are projected out of daily views and exports without rewriting old values', async (t) => {
  const { database } = fixture(t);
  const connection = await database.open();
  const stats = (value) => ({ count: 1, sum: value, max: value });
  const minute = Math.floor(base / 60_000);
  const transaction = connection.transaction(['days', 'minutes'], 'readwrite');
  const saved = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  const mixed = {
    day: '2026-11-07', month: '2026-11', firstAt: base, lastAt: base, samples: 1,
    metrics: { heartRate: stats(60), stressIndex: stats(20), spo2: stats(98) },
  };
  const legacyOnly = {
    ...mixed, day: '2026-11-08', firstAt: base + 86_400_000, lastAt: base + 86_400_000,
    metrics: { spo2: stats(97) },
  };
  for (const [summary, bucket] of [[mixed, minute], [legacyOnly, minute + 1440]]) {
    transaction.objectStore('days').put(summary);
    transaction.objectStore('minutes').put({ ...summary, minute: bucket, timeZone: 'Europe/Berlin', offsetMinutes: 60 });
  }
  await saved;

  await database.record(sample(1000, { heartRate: 80, respirationRate: 16, spo2: 100 }), 'Europe/Berlin');
  const { summary, minutes } = await database.getDay(mixed.day);
  assert.deepEqual(summary.metrics, {
    heartRate: { count: 2, sum: 140, max: 80 }, respirationRate: stats(16),
  });
  assert.deepEqual(minutes[0].metrics, summary.metrics);
  assert.deepEqual(await database.getDay(legacyOnly.day), { summary: null, minutes: [] });
  assert.deepEqual((await database.listDays('2026-11')).map(({ day }) => day), [mixed.day]);
  assert.equal((await database.recent(base)).length, 1);
  const exported = await database.export();
  assert.equal(exported.days.length, 1);
  assert.equal(exported.minutes.length, 1);
  assert.doesNotMatch(JSON.stringify(exported), /spo2|stressIndex/i);

  const check = connection.transaction(['days', 'minutes'], 'readonly');
  const get = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const [stored, storedDay, storedLegacy] = await Promise.all([
    get(check.objectStore('minutes').get([mixed.day, minute])),
    get(check.objectStore('days').get(mixed.day)),
    get(check.objectStore('days').get(legacyOnly.day)),
  ]);
  for (const row of [stored, storedDay]) {
    assert.deepEqual(row.metrics.spo2, stats(98));
    assert.deepEqual(row.metrics.stressIndex, stats(20));
  }
  assert.deepEqual(storedLegacy, legacyOnly);
});

test('daily persistence survives closing and reopening and exports original minute data', async (t) => {
  const { database, options } = fixture(t);
  await database.record(sample(0), 'Europe/Berlin');
  database.close();
  const reopened = new DailyDatabase(options);
  t.after(() => reopened.close());
  assert.equal((await reopened.getDay('2026-11-07')).summary.samples, 1);
  const exported = await reopened.export();
  assert.equal(exported.aggregation, 'minute');
  assert.equal(exported.days.length, 1);
  assert.equal(exported.minutes[0].timeZone, 'Europe/Berlin');
  assert.equal(exported.minutes[0].offsetMinutes, 60);
});

test('concurrent writers update a minute atomically without losing counts', async (t) => {
  const { database, options } = fixture(t);
  const second = new DailyDatabase(options);
  t.after(() => second.close());
  await Promise.all([
    database.record(sample(0, { heartRate: 60 }), 'Europe/Berlin'),
    second.record(sample(1000, { heartRate: 80 }), 'Europe/Berlin'),
    database.record(sample(2000, { heartRate: 100 }), 'Europe/Berlin'),
  ]);
  const { summary } = await database.getDay('2026-11-07');
  assert.deepEqual(summary.metrics.heartRate, { count: 3, sum: 240, max: 100 });
});

test('local midnight and the two fall DST minutes remain retrievable under their original days', async (t) => {
  const { database } = fixture(t);
  for (const date of ['2026-11-06T22:59:00Z', '2026-11-06T23:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
    await database.record(sample(0, { receivedAt: Date.parse(date) }), 'Europe/Berlin');
  }
  assert.equal((await database.getDay('2026-11-06')).summary.samples, 1);
  assert.equal((await database.getDay('2026-11-07')).summary.samples, 1);
  const repeated = await database.getDay('2026-10-25');
  assert.equal(repeated.minutes.length, 2);
  assert.deepEqual(repeated.minutes.map(({ offsetMinutes }) => offsetMinutes), [120, 60]);
  assert.equal((await database.listDays()).length, 3);
});

test('deleting a day removes only its data and clearing removes all daily stores', async (t) => {
  const { database } = fixture(t);
  await database.record(sample(0), 'Europe/Berlin');
  await database.record(sample(86_400_000), 'Europe/Berlin');
  await database.deleteDay('2026-11-07');
  assert.deepEqual(await database.getDay('2026-11-07'), { summary: null, minutes: [] });
  assert.equal((await database.getDay('2026-11-08')).summary.samples, 1);
  await database.clear();
  assert.equal(await database.countDays(), 0);
  assert.deepEqual((await database.export()).minutes, []);
});

test('an aborted database write leaves both stores unchanged and reports a retryable error', async (t) => {
  let reported;
  const { database } = fixture(t, { onError: (error) => { reported = error; } });
  const connection = await database.open();
  const original = connection.transaction.bind(connection);
  connection.transaction = (...args) => {
    const transaction = original(...args);
    if (args[1] === 'readwrite') queueMicrotask(() => transaction.abort());
    return transaction;
  };
  await assert.rejects(database.record(sample(0), 'Europe/Berlin'));
  assert.ok(reported);
  assert.equal(await database.countDays(), 0);
  assert.deepEqual((await database.export()).minutes, []);
  connection.transaction = original;
  await database.retry();
  await database.record(sample(0), 'Europe/Berlin');
  assert.equal(await database.countDays(), 1);
});

test('unavailable IndexedDB reports a clear error without blocking live-only operation', async () => {
  const database = new DailyDatabase({ indexedDB: null, keyRange: null });
  await assert.rejects(database.open(), /keine lokale Datenbank/);
  assert.ok(database.issue);
  assert.equal(await database.record(sample(0)), false);
});
