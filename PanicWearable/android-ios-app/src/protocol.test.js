import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLE_SERVICE_UUID,
  CLOCK_UUID,
  MEASUREMENT_UUID,
  decodeMeasurement,
  encodeClock,
} from './protocol.js';

function makeMeasurement({
  flags = 0b0010_0111,
  packetCount = 0x1234,
  uptimeMs = 0x12345678,
  heartRate = 723,
  respirationRate = 165,
  adc = 4095,
  ir = 0xabcd,
  red = 0x9876,
  state = 3,
} = {}) {
  const buffer = new ArrayBuffer(20);
  const view = new DataView(buffer);
  view.setUint8(0, 1);
  view.setUint8(1, flags);
  view.setUint16(2, packetCount, true);
  view.setUint32(4, uptimeMs, true);
  view.setUint16(8, heartRate, true);
  view.setUint16(10, respirationRate, true);
  view.setUint16(12, adc, true);
  view.setUint16(14, ir, true);
  view.setUint16(16, red, true);
  view.setUint8(18, state);
  view.setUint8(19, 0);
  return view;
}

test('uses the StressMonitor BLE service and characteristic UUIDs', () => {
  assert.equal(BLE_SERVICE_UUID, '89e10001-3b55-4a92-9b4d-173a6a0d8200');
  assert.equal(MEASUREMENT_UUID, '89e10002-3b55-4a92-9b4d-173a6a0d8200');
  assert.equal(CLOCK_UUID, '89e10003-3b55-4a92-9b4d-173a6a0d8200');
});

test('decodes the 20-byte little-endian measurement packet', () => {
  const measurement = decodeMeasurement(makeMeasurement());

  assert.equal(measurement.valid, true);
  assert.equal(measurement.heartRate, 72.3);
  assert.equal(measurement.respirationRate, 16.5);
  assert.equal(measurement.maxFresh, true);
  assert.equal(measurement.warning, false);
  assert.equal(measurement.breathAssist, false);
  assert.equal(measurement.demo, true);
  assert.equal(measurement.packetCount, 0x1234);
  assert.equal(measurement.uptimeMs, 0x12345678);
  assert.equal(measurement.adc, 4095);
  assert.equal(measurement.ir, 0xabcd);
  assert.equal(measurement.red, 0x9876);
  assert.equal(measurement.state, 3);
});

test('reports individual values missing when the presence flag or sentinel says so', () => {
  const measurement = decodeMeasurement(makeMeasurement({
    flags: 1 << 1,
    heartRate: 0xffff,
    respirationRate: 180,
  }));

  assert.equal(measurement.valid, false);
  assert.equal(measurement.heartRate, null);
  assert.equal(measurement.respirationRate, null);
});

test('rejects malformed or unsupported measurement packets', () => {
  assert.throws(
    () => decodeMeasurement(new DataView(new Uint8Array(19).buffer)),
    /muss 20 Bytes lang sein/,
  );
  const unsupportedVersion = makeMeasurement();
  unsupportedVersion.setUint8(0, 2);
  assert.throws(() => decodeMeasurement(unsupportedVersion), /Protokollversion/);
  assert.throws(
    () => decodeMeasurement(makeMeasurement({ flags: 0b0100_0000 })),
    /Statusbits/,
  );
  assert.throws(
    () => decodeMeasurement(makeMeasurement({ adc: 4096 })),
    /ADC-Wert/,
  );
  assert.throws(
    () => decodeMeasurement(makeMeasurement({ state: 4 })),
    /Messzustand/,
  );

  const reservedByte = makeMeasurement();
  reservedByte.setUint8(19, 1);
  assert.throws(() => decodeMeasurement(reservedByte), /Reserviertes Byte/);
});

test('encodes current Unix seconds and local UTC offset in eight little-endian bytes', () => {
  const date = new Date(Date.UTC(2026, 10, 6, 12, 0, 0));
  const payload = encodeClock(date);
  const bytes = new Uint8Array(payload.buffer);

  assert.equal(bytes.length, 8);
  assert.deepEqual([...bytes.slice(0, 2)], [1, 0]);
  assert.equal(payload.getUint32(2, true), date.getTime() / 1000);
  assert.equal(payload.getInt16(6, true), -date.getTimezoneOffset());
});

test('rejects unsupported clock dates', () => {
  assert.throws(() => encodeClock(new Date(Number.NaN)), /Ungültige Uhrzeit/);
  assert.throws(() => encodeClock(new Date(Date.UTC(1999, 0, 1))), /zwischen 2000 und 2099/);
  assert.throws(() => encodeClock(new Date(Date.UTC(2100, 0, 1))), /zwischen 2000 und 2099/);
});
