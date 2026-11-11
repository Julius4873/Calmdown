import assert from 'node:assert/strict';
import test from 'node:test';
import { BLE_SERVICE_UUID, CLOCK_UUID, MEASUREMENT_UUID } from '../protocol.js';
import { BleTransport } from './ble-transport.js';
import { WebBluetoothClient } from './web-bluetooth-client.js';
import { HISTORY_IDENTITY_UUID } from './history-protocol.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));

function packet(sequence) {
  const value = new DataView(new ArrayBuffer(20));
  value.setUint8(0, 1);
  value.setUint8(1, 7);
  value.setUint16(2, sequence, true);
  value.setUint32(4, sequence * 1000, true);
  value.setUint16(8, 720, true);
  value.setUint16(10, 150, true);
  value.setUint16(12, 2048, true);
  return value;
}

class Events {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
  }
  emit(name) {
    for (const callback of this.listeners.get(name) ?? []) callback({ target: this });
  }
}

function fixture() {
  let now = 0;
  let timer = null;
  const timeouts = new Map();
  const calls = { reads: 0, connects: 0, disconnects: 0, writes: [], notifications: 0 };
  const measurement = new Events();
  measurement.uuid = MEASUREMENT_UUID.toUpperCase();
  measurement.value = packet(1);
  measurement.startNotifications = async () => { calls.notifications += 1; };
  measurement.readValue = async () => {
    calls.reads += 1;
    // READ can emit this same event, as documented by Web Bluetooth.
    measurement.emit('characteristicvaluechanged');
    return measurement.value;
  };
  const clock = {
    uuid: CLOCK_UUID.toUpperCase(),
    async writeValue(value) { calls.writes.push([...value]); },
  };
  const service = {
    uuid: BLE_SERVICE_UUID.toUpperCase(),
    async getCharacteristic(uuid) {
      if (uuid === HISTORY_IDENTITY_UUID) throw new DOMException('Characteristic not found', 'NotFoundError');
      assert.ok([MEASUREMENT_UUID, CLOCK_UUID].includes(uuid));
      return uuid === MEASUREMENT_UUID ? measurement : clock;
    },
  };
  const device = new Events();
  device.id = 'ios-watch';
  device.name = 'StressMonitor';
  device.gatt = {
    async connect() { calls.connects += 1; return device.gatt; },
    disconnect() { calls.disconnects += 1; device.emit('gattserverdisconnected'); },
    async getPrimaryService(uuid) { assert.equal(uuid, BLE_SERVICE_UUID); return service; },
  };
  // Deliberately no getAvailability(), service.device or modern write method.
  const bluetooth = {
    async requestDevice(options) {
      assert.deepEqual(options.filters, [{ services: [BLE_SERVICE_UUID] }]);
      assert.deepEqual(options.optionalServices, [BLE_SERVICE_UUID]);
      return device;
    },
  };
  const client = new WebBluetoothClient(bluetooth, {
    startTimer(callback, delay) { assert.equal(delay, 1000); timer = callback; return callback; },
    stopTimer(handle) { if (timer === handle) timer = null; },
    startTimeout(callback, delay) {
      const handle = {};
      timeouts.set(handle, { callback, at: now + delay });
      return handle;
    },
    stopTimeout(handle) { timeouts.delete(handle); },
  });
  const samples = [];
  const transport = new BleTransport(client, {
    now: () => now, onChange() {}, onMeasurement: (sample) => samples.push(sample),
  });
  return {
    client, transport, samples, calls, measurement, clock, device, service, bluetooth,
    async advance(ms) {
      now += ms;
      for (const [handle, timeout] of [...timeouts]) {
        if (timeout.at <= now) {
          timeouts.delete(handle);
          timeout.callback();
        }
      }
      timer?.();
      await drain();
      transport.tick();
      await drain();
    },
    get hasTimer() { return timer !== null; },
  };
}

test('Bluefy-style UUIDs and legacy APIs deliver READ data without optional notification startup', async () => {
  const { transport, measurement, samples, calls } = fixture();
  await transport.connect();
  await drain();
  assert.equal(transport.state.status, 'live');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].heartRate, 72);
  assert.equal(transport.state.clock.status, 'sent');
  assert.equal(calls.writes[0].length, 8);
  measurement.value = packet(2);
  measurement.emit('characteristicvaluechanged');
  assert.deepEqual(samples.map(({ packetCount }) => packetCount), [1, 2]);
  assert.equal(transport.state.deliveryMode, 'read');
  assert.equal(calls.notifications, 0);
});

test('iPhone browser device selection runs synchronously within the user tap', async () => {
  const f = fixture();
  const select = f.bluetooth.requestDevice;
  let selected = false;
  f.bluetooth.requestDevice = (options) => {
    selected = true;
    return select(options);
  };
  const connecting = f.transport.connect();
  assert.equal(selected, true);
  await connecting;
  assert.equal(f.transport.state.status, 'live');
});

test('iPhone picker rejection is retained with its original error and stage', async () => {
  const f = fixture();
  f.bluetooth.requestDevice = async () => { throw new DOMException('User gesture required', 'SecurityError'); };
  await f.transport.connect();
  assert.equal(f.transport.state.status, 'disconnected');
  assert.match(f.transport.state.diagnostic.error, /Geräteauswahl in Bluefy.*SecurityError.*User gesture required/);
});

test('browser READ packets keep flowing without the ten-second no-data disconnect', async () => {
  const f = fixture();
  await f.transport.connect();
  for (let second = 1; second <= 15; second++) {
    f.measurement.value = packet(second + 1);
    await f.advance(1000);
  }
  assert.equal(f.transport.state.status, 'live');
  assert.equal(f.transport.state.deliveryMode, 'read');
  assert.equal(f.calls.connects, 1);
  assert.equal(f.calls.disconnects, 0);
  assert.ok(f.calls.reads >= 14);
});

test('unsupported notifications use READ and legacy clock writes without failing the connection', async () => {
  const f = fixture();
  f.measurement.startNotifications = async () => { throw new Error('Notifications not implemented'); };
  f.clock.writeValueWithResponse = async () => { throw new DOMException('Not implemented', 'NotSupportedError'); };
  await f.transport.connect();
  await drain();
  assert.equal(f.transport.state.status, 'live');
  assert.equal(f.transport.state.deliveryMode, 'read');
  assert.equal(f.transport.state.clock.status, 'sent');
  f.measurement.value = packet(2);
  await f.advance(1000);
  assert.equal(f.samples.at(-1).packetCount, 2);
});

test('an iPhone notification startup promise that never resolves cannot block READ or disconnect', async () => {
  const f = fixture();
  f.measurement.startNotifications = () => {
    f.calls.notifications += 1;
    return new Promise(() => {});
  };
  await f.transport.connect();
  f.measurement.value = packet(6);
  await f.advance(5000);
  assert.equal(f.transport.state.status, 'live');
  assert.equal(f.calls.notifications, 0);
  assert.equal(f.calls.disconnects, 0);
  assert.equal(f.samples.at(-1).packetCount, 6);
});

test('iPhone service discovery taking longer than four seconds is allowed to finish', async () => {
  const f = fixture();
  let completeService;
  f.device.gatt.getPrimaryService = () => new Promise((resolve) => { completeService = resolve; });
  const opening = f.transport.connect();
  await drain();
  await f.advance(5000);
  assert.equal(f.calls.disconnects, 0);
  assert.equal(f.transport.state.diagnostic.step, 'StressMonitor-Dienst suchen');
  completeService(f.service);
  await opening;
  await drain();
  assert.equal(f.transport.state.status, 'live');
  assert.equal(f.transport.state.clock.status, 'sent');
});

for (const stage of ['characteristic', 'first read']) {
  test(`iPhone ${stage} taking longer than four seconds is allowed to finish`, async () => {
    const f = fixture();
    let complete;
    if (stage === 'characteristic') {
      const lookup = f.service.getCharacteristic;
      f.service.getCharacteristic = (uuid) => uuid === MEASUREMENT_UUID
        ? new Promise((resolve) => { complete = () => resolve(f.measurement); }) : lookup(uuid);
    } else {
      f.measurement.readValue = () => new Promise((resolve) => { complete = () => resolve(f.measurement.value); });
    }
    const opening = f.transport.connect();
    await drain();
    await f.advance(5000);
    assert.equal(f.calls.disconnects, 0);
    complete();
    await opening;
    await drain();
    assert.equal(f.transport.state.status, 'live');
  });
}

test('a slow iPhone GATT connection can finish after the previous seven-second deadline', async () => {
  const f = fixture();
  let complete;
  f.device.gatt.connect = () => new Promise((resolve) => { complete = () => resolve(f.device.gatt); });
  const opening = f.transport.connect();
  await drain();
  await f.advance(8000);
  assert.equal(f.calls.disconnects, 0);
  complete();
  await opening;
  assert.equal(f.transport.state.status, 'live');
});

test('a genuinely hung GATT connection is bounded and reports its timeout once', async () => {
  const f = fixture();
  f.device.gatt.connect = () => new Promise(() => {});
  const opening = f.transport.connect();
  await drain();
  await f.advance(25_000);
  await opening;
  assert.equal(f.calls.disconnects, 1);
  assert.match(f.transport.state.diagnostic.error, /Verbindung zur Uhr.*TimeoutError.*25 Sekunden/);
});

test('a slow optional clock write does not provoke the no-data watchdog', async () => {
  const f = fixture();
  let finishClock;
  f.clock.writeValue = () => new Promise((resolve) => { finishClock = resolve; });
  await f.transport.connect();
  await drain();
  await f.advance(12_000);
  assert.equal(f.transport.state.status, 'stale');
  assert.equal(f.calls.disconnects, 0);
  assert.equal(f.transport.state.diagnostic.step, 'Uhrzeit senden');
  f.measurement.value = packet(14);
  finishClock();
  await drain();
  await f.advance(1000);
  assert.equal(f.transport.state.status, 'live');
  assert.equal(f.transport.state.clock.status, 'sent');
  assert.equal(f.calls.disconnects, 0);
});

test('a clock timeout reports its stage and permits measurement reads to continue', async () => {
  const f = fixture();
  f.clock.writeValue = () => new Promise(() => {});
  await f.transport.connect();
  await drain();
  f.measurement.value = packet(21);
  await f.advance(20_000);
  assert.equal(f.transport.state.clock.status, 'failed');
  assert.equal(f.transport.state.status, 'live');
  assert.equal(f.calls.disconnects, 0);
  assert.match(f.transport.state.diagnostic.error, /Uhrzeit senden.*TimeoutError.*20 Sekunden/);
});

test('bridge discovery failures retain the actionable stage and underlying error on screen', async () => {
  const f = fixture();
  f.device.gatt.getPrimaryService = async () => { throw new DOMException('Service not found', 'NotFoundError'); };
  await f.transport.connect();
  assert.equal(f.transport.state.status, 'disconnected');
  assert.match(f.transport.state.diagnostic.error, /StressMonitor-Dienst suchen.*NotFoundError.*Service not found/);
});

test('polling repeated READ values cannot make stale firmware measurements look fresh', async () => {
  const f = fixture();
  await f.transport.connect();
  await f.advance(4000);
  assert.equal(f.transport.state.status, 'stale');
  assert.equal(f.transport.state.measurement, null);
  assert.equal(f.samples.length, 1);
});

test('disconnect cancels polling and queued characteristic callbacks from the old link', async () => {
  const f = fixture();
  await f.transport.connect();
  const oldCallback = [...f.measurement.listeners.get('characteristicvaluechanged')][0];
  f.transport.disconnect();
  await drain();
  assert.equal(f.hasTimer, false);
  assert.equal(f.calls.disconnects, 1);
  f.measurement.value = packet(2);
  oldCallback({ target: f.measurement });
  await f.advance(20_000);
  assert.equal(f.samples.length, 1);
  assert.equal(f.transport.state.status, 'idle');
});

test('typed-array payloads retain their byte offset when decoded', async () => {
  const f = fixture();
  const bytes = new Uint8Array(30);
  bytes.set(new Uint8Array(packet(4).buffer), 5);
  f.measurement.value = bytes.subarray(5, 25);
  await f.transport.connect();
  assert.equal(f.samples[0].packetCount, 4);
  assert.equal(f.samples[0].heartRate, 72);
});
