export const BLE_SERVICE_UUID = '89e10001-3b55-4a92-9b4d-173a6a0d8200';
export const MEASUREMENT_UUID = '89e10002-3b55-4a92-9b4d-173a6a0d8200';
export const CLOCK_UUID = '89e10003-3b55-4a92-9b4d-173a6a0d8200';

const MEASUREMENT_LENGTH = 20;
const MAX_ADC_VALUE = 4095;
const MISSING_VALUE = 0xffff;
const KNOWN_FLAGS = 0b0011_1111;

export function decodeMeasurement(dataView) {
  if (dataView.byteLength !== MEASUREMENT_LENGTH) {
    throw new RangeError(`Messwertpaket muss ${MEASUREMENT_LENGTH} Bytes lang sein (erhalten: ${dataView.byteLength}).`);
  }
  if (dataView.getUint8(0) !== 1) {
    throw new RangeError(`Unbekannte Protokollversion: ${dataView.getUint8(0)}.`);
  }

  const flags = dataView.getUint8(1);
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new RangeError(`Unbekannte Statusbits: 0x${flags.toString(16)}.`);
  }

  const adc = dataView.getUint16(12, true);
  if (adc > MAX_ADC_VALUE) {
    throw new RangeError(`Ungültiger ADC-Wert: ${adc}.`);
  }

  const state = dataView.getUint8(18);
  if (state > 3) {
    throw new RangeError(`Unbekannter Messzustand: ${state}.`);
  }
  if (dataView.getUint8(19) !== 0) {
    throw new RangeError(`Reserviertes Byte muss 0 sein (erhalten: ${dataView.getUint8(19)}).`);
  }

  const heartRateRaw = dataView.getUint16(8, true);
  const respirationRateRaw = dataView.getUint16(10, true);
  const heartRatePresent = (flags & (1 << 1)) !== 0;
  const respirationRatePresent = (flags & (1 << 2)) !== 0;
  const heartRate = heartRatePresent && heartRateRaw !== MISSING_VALUE
    ? heartRateRaw / 10
    : null;
  const respirationRate = respirationRatePresent && respirationRateRaw !== MISSING_VALUE
    ? respirationRateRaw / 10
    : null;

  return {
    valid: heartRate !== null || respirationRate !== null,
    heartRate,
    respirationRate,
    maxFresh: (flags & (1 << 0)) !== 0,
    warning: (flags & (1 << 3)) !== 0,
    demo: (flags & (1 << 5)) !== 0,
    packetCount: dataView.getUint16(2, true),
    uptimeMs: dataView.getUint32(4, true),
    adc,
    ir: dataView.getUint16(14, true),
    red: dataView.getUint16(16, true),
    state,
    receivedAt: Date.now(),
  };
}

export function encodeClock(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('Ungültige Uhrzeit.');
  }

  const unixSeconds = Math.floor(date.getTime() / 1000);
  const utcYear = date.getUTCFullYear();
  const utcOffsetMinutes = -date.getTimezoneOffset();
  if (utcYear < 2000 || utcYear > 2099) {
    throw new RangeError('Die Uhrzeit muss zwischen 2000 und 2099 liegen.');
  }
  if (unixSeconds < 0 || unixSeconds > 0xffff_ffff) {
    throw new RangeError('Unix-Zeit liegt außerhalb des unterstützten Bereichs.');
  }
  if (utcOffsetMinutes < -720 || utcOffsetMinutes > 840) {
    throw new RangeError(`UTC-Abweichung liegt außerhalb des unterstützten Bereichs: ${utcOffsetMinutes} Minuten.`);
  }

  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setUint8(0, 1);
  view.setUint8(1, 0);
  view.setUint32(2, unixSeconds, true);
  view.setInt16(6, utcOffsetMinutes, true);
  return view;
}
