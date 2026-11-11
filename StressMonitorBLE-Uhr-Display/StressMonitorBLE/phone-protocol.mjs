// Unabhaengiger Decoder fuer die spaetere Handy-App (Little Endian).
export const SERVICE = '89e10001-3b55-4a92-9b4d-173a6a0d8200';
export const MEASUREMENTS = '89e10002-3b55-4a92-9b4d-173a6a0d8200';
export const CLOCK = '89e10003-3b55-4a92-9b4d-173a6a0d8200';
export function decodeMeasurement(bytes) {
  const v = bytes instanceof DataView ? bytes :
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength !== 20 || v.getUint8(0) !== 1) throw new Error('Unbekanntes Messpaket');
  const flags = v.getUint8(1);
  const rate = (at, mask) => (flags & mask) && v.getUint16(at,true) !== 65535 ? v.getUint16(at,true)/10 : null;
  return {
    sequence:v.getUint16(2,true), uptimeMs:v.getUint32(4,true),
    pulse:rate(8,2), breathing:rate(10,4), adc:v.getUint16(12,true),
    infrared:v.getUint16(14,true), red:v.getUint16(16,true),
    sensorFresh:!!(flags&1), warning:!!(flags&8), guide:!!(flags&16),
    demo:!!(flags&32), phase:v.getUint8(18)
  };
}
export function encodeClock(date=new Date(), offsetMinutes=-date.getTimezoneOffset()) {
  const epoch=Math.floor(date.getTime()/1000);
  if (!Number.isInteger(epoch) || epoch<946684800 || epoch>4102444799 ||
      !Number.isInteger(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840)
    throw new Error('Ungueltige Uhrzeit');
  const bytes=new Uint8Array(8), v=new DataView(bytes.buffer);
  v.setUint8(0,1); v.setUint32(2,epoch,true); v.setInt16(6,offsetMinutes,true);
  return bytes;
}
