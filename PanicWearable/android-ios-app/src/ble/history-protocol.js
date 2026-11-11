export const HISTORY_IDENTITY_UUID = '89e10004-3b55-4a92-9b4d-173a6a0d8200';
export const HISTORY_STATUS_UUID = '89e10005-3b55-4a92-9b4d-173a6a0d8200';
export const HISTORY_CONTROL_UUID = '89e10006-3b55-4a92-9b4d-173a6a0d8200';
export const HISTORY_PART_A_UUID = '89e10007-3b55-4a92-9b4d-173a6a0d8200';
export const HISTORY_PART_B_UUID = '89e10008-3b55-4a92-9b4d-173a6a0d8200';
export const HISTORY_REQUEST = 1;
export const HISTORY_ACK = 2;

export function missingHistoryCharacteristic(error) {
  return error?.name === 'NotFoundError'
    || /characteristic.*(?:not found|does not exist)|no characteristic matching/i.test(String(error?.message || error));
}

function frame(view) {
  if (view?.byteLength !== 20 || typeof view.getUint8 !== 'function') throw new Error('Uhrspeicher-Paket hat eine falsche Länge.');
  return view;
}

function hex(view, offset) {
  return Array.from({ length: 8 }, (_, i) => view.getUint8(offset + i).toString(16).padStart(2, '0')).join('');
}

export function decodeHistoryIdentity(value) {
  const view = frame(value);
  if (view.getUint8(0) !== 1 || view.getUint8(1) || view.getUint16(18, true)) throw new Error('Unbekannte Uhrspeicher-Version.');
  const device = hex(view, 2);
  const generation = hex(view, 10);
  if (/^0+$/.test(device)) throw new Error('Uhrspeicher ohne Gerätekennung.');
  return { source: device + ':' + generation, hasGeneration: !/^0+$/.test(generation) };
}

export function decodeHistoryStatus(value) {
  const view = frame(value);
  const flags = view.getUint8(1);
  const oldest = view.getUint32(2, true), newest = view.getUint32(6, true);
  const count = view.getUint16(10, true), capacity = view.getUint16(12, true);
  if (view.getUint8(0) !== 1 || flags & ~31 || view.getUint8(19) || count > capacity
    || (count ? !oldest || newest < oldest || count > newest - oldest + 1 : oldest || newest)) {
    throw new Error('Ungültiger Zustand des Uhrspeichers.');
  }
  return {
    ready: Boolean(flags & 1), clockValid: Boolean(flags & 2), overflow: Boolean(flags & 4),
    fault: Boolean(flags & 8), gap: Boolean(flags & 16),
    oldest, newest, count, capacity, requested: view.getUint32(14, true), errorCode: view.getUint8(18),
  };
}

export function historyCommand(op, sequence) {
  if (![HISTORY_REQUEST, HISTORY_ACK].includes(op) || !Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) {
    throw new RangeError('Ungültiger Uhrspeicher-Befehl.');
  }
  const view = new DataView(new ArrayBuffer(6));
  view.setUint8(0, 1); view.setUint8(1, op); view.setUint32(2, sequence, true);
  return view;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

export function decodeHistoryRecord(a, b) {
  const head = frame(a), tail = frame(b);
  const sequence = head.getUint32(2, true);
  if (!sequence || sequence !== tail.getUint32(0, true)) return null;
  const bytes = new Uint8Array(36);
  bytes.set(new Uint8Array(head.buffer, head.byteOffset, 20));
  bytes.set(new Uint8Array(tail.buffer, tail.byteOffset + 4, 16), 20);
  const view = new DataView(bytes.buffer);
  if (crc32(bytes.subarray(0, 32)) !== view.getUint32(32, true)) return null;
  const first = view.getUint32(6, true), last = view.getUint32(28, true), offsetMinutes = view.getInt16(10, true);
  const samples = view.getUint8(12), pulse = view.getUint8(13), breathing = view.getUint8(14);
  const flags = view.getUint8(1);
  if (view.getUint8(0) !== 1 || flags & ~1 || view.getUint8(15) || !samples || samples > 120
    || pulse + breathing < samples || first < 946684800 || last > 4102444799 || last < first
    || Math.floor(first / 60) !== Math.floor(last / 60) || offsetMinutes < -720 || offsetMinutes > 840) {
    throw new Error('Ungültige Messminute im Uhrspeicher.');
  }
  const metrics = {};
  for (const [key, count, sum, max] of [
    ['heartRate', pulse, view.getUint32(16, true), view.getUint16(24, true)],
    ['respirationRate', breathing, view.getUint32(20, true), view.getUint16(26, true)],
  ]) {
    if (count > samples || max === 0xffff || sum < max || sum > max * count || (!count && (sum || max))) {
      throw new Error('Ungültiger Messwert im Uhrspeicher.');
    }
    if (count) metrics[key] = { count, sum: sum / 10, max: max / 10 };
  }
  return { sequence, firstAt: first * 1000, lastAt: last * 1000, offsetMinutes, samples, metrics, partial: Boolean(flags & 1) };
}
