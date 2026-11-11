import assert from 'node:assert/strict';
import test from 'node:test';
import { average, History, readHistory } from './history.js';

const base = 1_800_000_000_000;
const sample = (offset, options = {}) => ({
  receivedAt: base + offset,
  heartRate: 72, respirationRate: 14, warning: false, state: 0, demo: false,
  ...options,
});
const drain = () => new Promise((resolve) => setImmediate(resolve));
const journal = (options = {}) => new History({
  raw: null, onChange() {}, onError() {}, async persist() {}, ...options,
});

test('history keeps real sessions and single transitions into device events', async () => {
  let disk;
  const history = journal({ async persist(snapshot) { disk = snapshot; } });
  history.record(sample(0, { heartRate: null, respirationRate: null }), 0);
  history.record(sample(1000), 1000);
  history.record(sample(2000, { state: 2, heartRate: 110 }), 2000);
  history.record(sample(3000, { warning: true, heartRate: 112 }), 3000);
  history.record(sample(4000, { state: 3, heartRate: 106 }), 4000);
  history.record(sample(5000, { demo: true, warning: true, heartRate: 130 }), 5000);
  history.record(sample(6000), 6000);
  history.finish();
  await drain();

  const [second, first] = readHistory(disk);
  assert.equal(first.startedAt, base + 1000);
  assert.equal(first.endedAt, base + 4000);
  assert.equal(first.warnings, 1);
  assert.equal(average(first.heart), 100);
  assert.deepEqual(first.events, [{ at: base + 2000, kind: 'warning' }]);
  assert.equal(second.startedAt, base + 6000);
  assert.equal(second.warnings, 0);
  assert.equal(history.activeId, null);
});

test('legacy exercise events remain in stored sessions and are omitted from standard export', () => {
  const events = [{ at: base, kind: 'warning' }, { at: base + 1000, kind: 'assist' }];
  const history = journal({ raw: JSON.stringify({
    version: 1,
    sessions: [{ id: 'old', startedAt: base, endedAt: base + 1000, points: [], events }],
  }) });
  assert.deepEqual(history.sessions[0].events, events);
  assert.deepEqual(JSON.parse(history.export()).sessions[0].events, [events[0]]);
  assert.deepEqual(history.sessions[0].events, events);
});

test('history bounds session and graph growth', () => {
  const history = journal();
  for (let index = 0; index < 184; index++) {
    history.record(sample(index * 5000), index * 5000);
  }
  assert.equal(history.sessions[0].points.length, 180);
  assert.equal(history.sessions[0].points[0].at, base + 20000);
  history.finish();
  for (let index = 1; index <= 41; index++) {
    history.record(sample(index * 1_000_000), index * 1_000_000);
    history.finish();
  }
  assert.equal(history.sessions.length, 40);
  assert.equal(history.sessions[0].startedAt, base + 41_000_000);
  assert.equal(history.sessions.at(-1).startedAt, base + 2_000_000);
});

test('corrupt history is preserved until explicit reset and inaccessible storage is never overwritten', async () => {
  const saves = [];
  const persist = async (snapshot) => { saves.push(snapshot); };
  const history = journal({ raw: '{invalid', persist });
  assert.equal(history.issue, 'corrupt');
  assert.equal(history.recoveryBackup, '{invalid');
  history.record(sample(0), 0);
  assert.equal(await history.clear(), false);
  assert.deepEqual(saves, []);
  assert.equal(await history.resetCorruptHistory(), true);
  assert.equal(history.issue, null);
  assert.deepEqual(readHistory(saves[0]), []);
  history.record(sample(0), 0);
  await drain();
  assert.equal(readHistory(saves[1]).length, 1);

  const unavailable = journal({ raw: undefined, persist });
  assert.equal(unavailable.issue, 'unavailable');
  assert.equal(await unavailable.resetCorruptHistory(), false);
  assert.equal(saves.length, 2);
});

test('deletion is serialized after pending saves and is reflected in export', async () => {
  const saves = [];
  let resume;
  const history = journal({
    async persist(snapshot) {
      saves.push(snapshot);
      if (saves.length === 1) await new Promise((resolve) => { resume = resolve; });
    },
  });
  history.record(sample(0), 0);
  const removing = history.remove(history.activeId);
  await drain();
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(history.export()).sessions, []);
  resume();
  await removing;
  assert.equal(saves.length, 2);
  assert.deepEqual(readHistory(saves.at(-1)), []);
});
