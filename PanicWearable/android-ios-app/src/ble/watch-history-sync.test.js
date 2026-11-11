import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { DailyDatabase } from '../daily-database.js';
import {
  crc32, decodeHistoryRecord, HISTORY_ACK, HISTORY_REQUEST, HISTORY_CONTROL_UUID, HISTORY_PART_A_UUID,
  HISTORY_PART_B_UUID, HISTORY_STATUS_UUID,
} from './history-protocol.js';
import { WatchHistorySync } from './watch-history-sync.js';

const base = Date.parse('2026-11-06T23:10:00Z') / 1000;
const source = '0102030405060000:0500000000000000';
const drain = () => new Promise((resolve) => setImmediate(resolve));

function wire(sequence, epoch = base, offset = 60) {
  const bytes = new Uint8Array(36);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint32(2, sequence, true);
  view.setUint32(6, epoch, true);
  view.setInt16(10, offset, true);
  view.setUint8(12, 3); view.setUint8(13, 3); view.setUint8(14, 2);
  view.setUint32(16, 2100, true); view.setUint32(20, 300, true);
  view.setUint16(24, 800, true); view.setUint16(26, 160, true);
  view.setUint32(28, epoch + 20, true);
  view.setUint32(32, crc32(bytes.subarray(0, 32)), true);
  const tail = new Uint8Array(20);
  new DataView(tail.buffer).setUint32(0, sequence, true);
  tail.set(bytes.subarray(20), 4);
  return [new DataView(bytes.buffer, 0, 20), new DataView(tail.buffer)];
}

function watch(sequences, { refuseAck = false, corrupt = false } = {}) {
  const operations = [];
  let requested = 0;
  let alive = true;
  const access = {
    source, hasGeneration: true, active: () => alive,
    async read(uuid) {
      if (uuid === HISTORY_STATUS_UUID) {
        const status = new DataView(new ArrayBuffer(20));
        status.setUint8(0, 1); status.setUint8(1, sequences[0] > 1 ? 7 : 3);
        status.setUint32(2, sequences[0], true);
        status.setUint32(6, sequences.at(-1), true);
        status.setUint16(10, sequences.length, true);
        status.setUint16(12, 100, true);
        status.setUint32(14, requested, true);
        return status;
      }
      const sequence = sequences.find((value) => value >= requested);
      const parts = wire(sequence);
      if (uuid === HISTORY_PART_A_UUID) return parts[0];
      assert.equal(uuid, HISTORY_PART_B_UUID);
      if (corrupt) parts[1].setUint8(6, parts[1].getUint8(6) ^ 1);
      return parts[1];
    },
    async write(uuid, value) {
      assert.equal(uuid, HISTORY_CONTROL_UUID);
      const op = value.getUint8(1), sequence = value.getUint32(2, true);
      operations.push([op, sequence]);
      if (op === HISTORY_ACK && refuseAck) throw new Error('Simulated link loss after durable commit');
      requested = op === HISTORY_ACK ? sequence + 1 : sequence;
    },
  };
  return { access, operations, disconnect() { alive = false; } };
}

function controller(database) {
  return new WatchHistorySync({ database, enabled: () => true, onChange() {}, delay: async () => {} });
}

function fixture(t) {
  const options = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange };
  const database = new DailyDatabase(options);
  t.after(() => database.close());
  return { database, options };
}

test('a valid fragmented record retains the original timestamp, offset and metric sums', () => {
  const record = decodeHistoryRecord(...wire(8));
  assert.equal(record.sequence, 8);
  assert.equal(record.firstAt, base * 1000);
  assert.equal(record.lastAt, (base + 20) * 1000);
  assert.equal(record.offsetMinutes, 60);
  assert.deepEqual(record.metrics.heartRate, { count: 3, sum: 210, max: 80 });
  assert.deepEqual(record.metrics.respirationRate, { count: 2, sum: 30, max: 16 });
  assert.equal(decodeHistoryRecord(wire(8)[0], wire(9)[1]), null);
  assert.throws(() => decodeHistoryRecord(...wire(8, 1)), /Ungültige Messminute/);
});

test('ACK is held until durable commit resolves and never sent on transaction rejection', async () => {
  let finish;
  const database = {
    async watchCursor() { return 0; },
    commitWatchRecord() { return new Promise((resolve) => { finish = resolve; }); },
  };
  const connected = watch([1]);
  const sync = controller(database);
  const running = sync.setAccess(connected.access);
  await drain();
  assert.deepEqual(connected.operations, [[HISTORY_REQUEST, 1]]);
  finish(true);
  await running;
  assert.deepEqual(connected.operations, [[HISTORY_REQUEST, 1], [HISTORY_ACK, 1]]);

  database.commitWatchRecord = async () => { throw new Error('IndexedDB transaction aborted'); };
  const failed = watch([1]);
  await sync.setAccess(failed.access);
  assert.deepEqual(failed.operations, [[HISTORY_REQUEST, 1]]);
  assert.equal(sync.state.phase, 'error');
});

test('disconnection before ACK resumes from the durable cursor after app restart without adding a duplicate', async (t) => {
  const { database, options } = fixture(t);
  const interrupted = watch([1, 2], { refuseAck: true });
  await controller(database).setAccess(interrupted.access);
  assert.equal(await database.watchCursor(source), 1);
  database.close();

  const restarted = new DailyDatabase(options);
  t.after(() => restarted.close());
  const current = watch([1, 2]);
  await controller(restarted).setAccess(current.access);
  assert.deepEqual(current.operations, [[HISTORY_REQUEST, 2], [HISTORY_ACK, 2]]);
  const stored = await restarted.getDay('2026-11-07');
  assert.equal(stored.summary.samples, 6);
  assert.equal(stored.minutes.length, 1);
  assert.equal(stored.minutes[0].firstAt, base * 1000);
  assert.equal(stored.minutes[0].offsetMinutes, 60);
  assert.equal((await restarted.getDay('2026-11-06')).summary, null);
  assert.equal(await restarted.watchCursor(source), 2);
});

test('repeated import and a deleted calendar day retain the cursor without recreating erased measurements', async (t) => {
  const { database } = fixture(t);
  const record = decodeHistoryRecord(...wire(5));
  assert.equal(await database.commitWatchRecord(source, record), true);
  assert.equal(await database.commitWatchRecord(source, record), false);
  assert.equal((await database.getDay('2026-11-07')).summary.samples, 3);
  await database.deleteDay('2026-11-07');
  await database.clear();
  const same = watch([5]);
  await controller(database).setAccess(same.access);
  assert.deepEqual(same.operations, []);
  assert.equal(await database.watchCursor(source), 5);
  assert.equal(await database.countDays(), 0);
});

test('CRC failures and torn fragments are never acknowledged', async (t) => {
  const { database } = fixture(t);
  const broken = watch([1], { corrupt: true });
  const sync = controller(database);
  await sync.setAccess(broken.access);
  assert.equal(sync.state.phase, 'error');
  assert.deepEqual(broken.operations, [[HISTORY_REQUEST, 1]]);
  assert.equal(await database.watchCursor(source), 0);
  assert.equal(await database.countDays(), 0);
});

test('ring overflow starts at the oldest retained sequence and imports only actual records', async (t) => {
  const { database } = fixture(t);
  const overflow = watch([193, 195]);
  const sync = controller(database);
  await sync.setAccess(overflow.access);
  assert.deepEqual(overflow.operations, [[HISTORY_REQUEST, 193], [HISTORY_ACK, 193], [HISTORY_ACK, 195]]);
  assert.equal(sync.state.status.overflow, true);
  assert.equal((await database.getDay('2026-11-07')).summary.samples, 6);
});

test('an actual aborted IndexedDB import leaves daily totals and durable cursor unchanged', async (t) => {
  const { database } = fixture(t);
  const connection = await database.open();
  const transaction = connection.transaction.bind(connection);
  let strict = false;
  connection.transaction = (...args) => {
    const tx = transaction(...args);
    if (args[1] === 'readwrite' && args[0].includes('watchSync')) {
      strict = args[2]?.durability === 'strict';
      queueMicrotask(() => tx.abort());
    }
    return tx;
  };
  const connected = watch([1]);
  await controller(database).setAccess(connected.access);
  assert.equal(strict, true);
  assert.deepEqual(connected.operations, [[HISTORY_REQUEST, 1]]);
  assert.equal(await database.watchCursor(source), 0);
  assert.equal(await database.countDays(), 0);
});

test('opening v2 adds the watch cursor store without deleting existing v1 measurements', async (t) => {
  const { database, options } = fixture(t);
  const opened = options.indexedDB.open('calmdown-daily-v1', 1);
  const legacy = await new Promise((resolve, reject) => {
    opened.onerror = () => reject(opened.error);
    opened.onupgradeneeded = () => {
      const db = opened.result;
      const minutes = db.createObjectStore('minutes', { keyPath: ['day', 'minute'] });
      minutes.createIndex('day', 'day'); minutes.createIndex('minute', 'minute');
      db.createObjectStore('days', { keyPath: 'day' }).createIndex('month', 'month');
      opened.transaction.objectStore('days').put({
        day: '2026-11-05', month: '2026-11', samples: 1,
        metrics: { heartRate: { count: 1, sum: 75, max: 75 } },
      });
    };
    opened.onsuccess = () => resolve(opened.result);
  });
  legacy.close();
  assert.equal((await database.getDay('2026-11-05')).summary.metrics.heartRate.max, 75);
  assert.equal(await database.watchCursor(source), 0);
  await database.commitWatchRecord(source, decodeHistoryRecord(...wire(1)));
  assert.equal(await database.countDays(), 2);
});
