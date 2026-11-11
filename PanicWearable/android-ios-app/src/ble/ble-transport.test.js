import assert from 'node:assert/strict';
import test from 'node:test';
import { BLE_SERVICE_UUID, CLOCK_UUID, MEASUREMENT_UUID } from '../protocol.js';
import { BleTransport, STALE_AFTER_MS } from './ble-transport.js';
import { HISTORY_IDENTITY_UUID } from './history-protocol.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));

function packet(sequence, uptime, { flags = 0x07, state = 0, version = 1 } = {}) {
  const view = new DataView(new ArrayBuffer(20));
  view.setUint8(0, version);
  view.setUint8(1, flags);
  view.setUint16(2, sequence, true);
  view.setUint32(4, uptime, true);
  view.setUint16(8, 725, true);
  view.setUint16(10, 145, true);
  view.setUint16(12, 2100, true);
  view.setUint8(18, state);
  return view;
}

function fixture() {
  let now = 0;
  const device = { deviceId: 'watch', name: 'StressMonitor' };
  const calls = { connect: [], notify: [], clock: [], disconnect: [], select: 0 };
  const samples = [];
  const legacy = [], history = [];
  const client = {
    async initialize() {},
    async isEnabled() { return true; },
    async requestDevice({ services }) {
      assert.deepEqual(services, [BLE_SERVICE_UUID]);
      calls.select += 1;
      return device;
    },
    async connect(id, disconnect) { calls.connect.push({ id, disconnect }); },
    async startNotifications(id, service, characteristic, notify) {
      assert.equal(service, BLE_SERVICE_UUID);
      assert.equal(characteristic, MEASUREMENT_UUID);
      calls.notify.push({ id, notify });
    },
    async stopNotifications() {},
    async disconnect(id) { calls.disconnect.push(id); },
    async write(id, service, characteristic, value) {
      assert.equal(service, BLE_SERVICE_UUID);
      assert.equal(characteristic, CLOCK_UUID);
      calls.clock.push({ id, value });
    },
  };
  const transport = new BleTransport(client, {
    onChange() {},
    onMeasurement: (sample) => samples.push(sample),
    onLegacyMeasurement: (sample) => legacy.push(sample),
    onHistory: (access) => history.push(access),
    now: () => now,
  });
  return {
    client, transport, calls, samples, legacy, history,
    notify: (value) => calls.notify.at(-1).notify(value),
    drop: () => calls.connect.at(-1).disconnect(),
    advance: async (ms) => {
      now += ms;
      transport.tick();
      await drain();
    },
  };
}

test('history-capable watch live packets never enter the legacy database path, even while probing', async () => {
  const f = fixture();
  let finish;
  f.client.read = (id, service, uuid) => {
    assert.equal(uuid, HISTORY_IDENTITY_UUID);
    return new Promise((resolve) => { finish = resolve; });
  };
  await f.transport.connect();
  f.notify(packet(1, 1000));
  assert.equal(f.samples.length, 1);
  assert.equal(f.legacy.length, 0);
  const id = new DataView(new ArrayBuffer(20));
  id.setUint8(0, 1); id.setUint8(2, 4); id.setUint8(10, 7);
  finish(id);
  await drain();
  f.notify(packet(2, 2000));
  assert.equal(f.transport.state.historyMode, 'watch');
  assert.equal(f.history[0].hasGeneration, true);
  assert.equal(f.samples.length, 2);
  assert.equal(f.legacy.length, 0);
});

test('a transient or malformed feature probe never grants permission to record overlapping live data', async () => {
  const f = fixture();
  f.client.read = async () => { throw new DOMException('Disconnected during read', 'NotFoundError'); };
  await f.transport.connect();
  f.notify(packet(1, 1000));
  await drain();
  assert.equal(f.transport.state.historyMode, 'checking');
  assert.equal(f.legacy.length, 0);
  f.client.read = async () => new DataView(new ArrayBuffer(20));
  await f.advance(5000);
  f.notify(packet(2, 2000));
  assert.equal(f.transport.state.historyMode, 'checking');
  assert.equal(f.legacy.length, 0);
});

test('verified absent history capability releases live samples once for legacy watches, excluding demo', async () => {
  const f = fixture();
  let rejectProbe;
  f.client.read = () => new Promise((_, reject) => { rejectProbe = reject; });
  await f.transport.connect();
  f.notify(packet(1, 1000));
  f.notify(packet(2, 2000, { flags: 0x27 }));
  assert.equal(f.legacy.length, 0);
  rejectProbe(Object.assign(new Error('Missing characteristic'), { historyMissing: true }));
  await drain();
  f.notify(packet(3, 3000));
  assert.equal(f.transport.state.historyMode, 'legacy');
  assert.deepEqual(f.legacy.map(({ packetCount }) => packetCount), [1, 3]);
});

test('connection subscribes to firmware notifications and sends an 8-byte clock write', async () => {
  const { transport, calls, notify, samples } = fixture();
  const before = Math.floor(Date.now() / 1000);
  await transport.connect();
  assert.equal(transport.state.status, 'awaiting');
  assert.equal(transport.state.measurement, null);
  assert.equal(transport.state.clock.status, 'sent');
  assert.equal(calls.clock.length, 1);
  const clock = calls.clock[0].value;
  assert.equal(clock.byteLength, 8);
  assert.equal(clock.getUint16(0, true), 1);
  assert.ok(clock.getUint32(2, true) >= before && clock.getUint32(2, true) <= Math.floor(Date.now() / 1000));
  assert.equal(clock.getInt16(6, true), -new Date().getTimezoneOffset() || 0);
  notify(packet(1, 1000));
  assert.equal(transport.state.status, 'live');
  assert.equal(samples[0].heartRate, 72.5);
  assert.equal(samples[0].respirationRate, 14.5);
  notify(packet(2, 2000, { flags: 0x20 }));
  assert.equal(samples[1].heartRate, null);
  assert.equal(samples[1].respirationRate, null);
  assert.equal(samples[1].demo, true);
});

test('invalid, duplicate and older packets cannot keep the displayed sample fresh', async () => {
  const { transport, notify, samples, advance } = fixture();
  await transport.connect();
  notify(packet(7, 7000));
  await advance(STALE_AFTER_MS - 1);
  notify(packet(7, 7000));
  notify(packet(6, 6000));
  notify(packet(8, 8000, { version: 2 }));
  await advance(1);
  assert.equal(samples.length, 1);
  assert.equal(transport.state.invalidPackets, 1);
  assert.equal(transport.state.status, 'stale');
  assert.equal(transport.state.measurement, null);
  notify(packet(8, 8000));
  assert.equal(samples.length, 2);
  assert.equal(transport.state.status, 'live');
});

test('both firmware counters can wrap without a stale reading or duplicated sample', async () => {
  const { transport, notify, samples } = fixture();
  await transport.connect();
  notify(packet(65535, 0xfffffff0));
  notify(packet(0, 984));
  notify(packet(65535, 0xfffffff0));
  assert.deepEqual(samples.map(({ packetCount }) => packetCount), [65535, 0]);
});

test('manual disconnect invalidates late GATT callbacks and cancels retry', async () => {
  const { transport, notify, drop, samples, calls, advance } = fixture();
  await transport.connect();
  transport.disconnect();
  notify(packet(1, 1000));
  drop();
  await advance(50_000);
  assert.equal(samples.length, 0);
  assert.equal(transport.state.status, 'idle');
  assert.equal(calls.connect.length, 1);
  assert.deepEqual(calls.disconnect, ['watch']);
});

test('disconnect during open closes the pending link before a new selection', async () => {
  const { transport, client, calls } = fixture();
  let resume;
  client.connect = () => new Promise((resolve) => { resume = resolve; });
  const opening = transport.connect();
  await drain();
  assert.equal(transport.state.status, 'connecting');
  transport.disconnect();
  await transport.connect();
  resume();
  await opening;
  await drain();
  assert.equal(calls.select, 1);
  assert.equal(calls.notify.length, 0);
  assert.deepEqual(calls.disconnect, ['watch']);
  assert.equal(transport.state.status, 'idle');
});

test('drop retries the same device three times with backoff, then allows a fresh selection', async () => {
  const { transport, client, drop, calls, advance } = fixture();
  await transport.connect();
  const connect = client.connect;
  client.connect = async (...args) => {
    await connect(...args);
    throw new Error('timed out');
  };
  drop();
  await drain();
  assert.equal(transport.state.attempt, 1);
  await advance(999);
  assert.equal(calls.connect.length, 1);
  await advance(1);
  assert.equal(transport.state.attempt, 2);
  await advance(2500);
  assert.equal(transport.state.attempt, 3);
  await advance(5000);
  assert.equal(transport.state.status, 'disconnected');
  await advance(60_000);
  assert.equal(calls.select, 1);
  assert.equal(calls.connect.length, 4);
  client.connect = connect;
  await transport.connect();
  assert.equal(transport.state.status, 'awaiting');
  assert.equal(calls.select, 2);
});

test('a silent connection is re-opened, while disabling recovery leaves stale status visible', async () => {
  const { transport, calls, advance } = fixture();
  await transport.connect();
  transport.setAutoReconnect(false);
  await advance(10_000);
  assert.equal(transport.state.status, 'stale');
  assert.equal(calls.connect.length, 1);
  transport.setAutoReconnect(true);
  await advance(1);
  assert.equal(transport.state.status, 'reconnecting');
  await advance(1000);
  assert.equal(transport.state.status, 'awaiting');
  assert.equal(calls.connect.length, 2);
});

test('leaving the foreground detaches notifications and resume resubscribes and syncs', async () => {
  const { transport, notify, calls, samples, advance } = fixture();
  await transport.connect();
  notify(packet(1, 1000));
  const oldNotify = calls.notify[0].notify;
  transport.setActive(false);
  oldNotify(packet(2, 2000));
  await advance(10_000);
  assert.equal(transport.state.status, 'paused');
  assert.equal(transport.state.measurement, null);
  assert.equal(samples.length, 1);
  assert.equal(calls.connect.length, 1);
  transport.setActive(true);
  await drain();
  assert.equal(transport.state.status, 'awaiting');
  assert.equal(calls.select, 1);
  assert.equal(calls.clock.length, 2);
  oldNotify(packet(3, 3000));
  notify(packet(30, 30000));
  assert.deepEqual(samples.map(({ packetCount }) => packetCount), [1, 30]);
});

test('iOS permission prompts may suspend the app before the device is selected', async () => {
  const { transport, client, calls } = fixture();
  let finishPermission;
  client.initialize = () => new Promise((resolve) => { finishPermission = resolve; });
  const connecting = transport.connect();
  transport.setActive(false);
  assert.equal(transport.state.status, 'paused');
  transport.setActive(true);
  finishPermission();
  await connecting;
  assert.equal(calls.select, 1);
  assert.equal(transport.state.status, 'awaiting');
});
