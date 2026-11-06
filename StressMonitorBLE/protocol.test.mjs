import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeMeasurement,encodeClock} from './phone-protocol.mjs';
// Feste Referenzbytes, nicht vom zu testenden Decoder erzeugt.
const packet=Uint8Array.from([1,7,52,18,120,86,52,18,213,2,123,0,0,8,48,117,16,39,0,0]);
test('Messwerte, Skalierung und Little Endian',()=>{
  assert.deepEqual(decodeMeasurement(packet),{sequence:4660,uptimeMs:305419896,pulse:72.5,breathing:12.3,adc:2048,infrared:30000,red:10000,sensorFresh:true,warning:false,guide:false,demo:false,phase:0});
});
test('DataView mit Byte-Offset',()=>{
  const padded=new Uint8Array(24); padded.set(packet,2);
  assert.equal(decodeMeasurement(new DataView(padded.buffer,2,20)).pulse,72.5);
});
test('Fehlende Messwerte bleiben null',()=>{
  const p=packet.slice(); p[1]=0; assert.equal(decodeMeasurement(p).pulse,null);
  p[1]=7; p[8]=p[9]=255; assert.equal(decodeMeasurement(p).pulse,null);
});
test('Warnung, Atemhilfe und Demo',()=>{
  const p=packet.slice(); p[1]=8|32; p[18]=2;
  assert.equal(decodeMeasurement(p).warning,true); assert.equal(decodeMeasurement(p).demo,true);
  p[1]=16; p[18]=3; assert.equal(decodeMeasurement(p).guide,true);
});
test('Falsche Laenge und Version',()=>{
  assert.throws(()=>decodeMeasurement(new Uint8Array(19)));
  const p=packet.slice(); p[0]=2; assert.throws(()=>decodeMeasurement(p));
});
test('UTC-Uhrpaket und negative Zeitzone',()=>{
  assert.deepEqual([...encodeClock(new Date('2000-01-01T00:00:00Z'),-60)],[1,0,128,67,109,56,196,255]);
});
test('Uhrzeitgrenzen',()=>{
  assert.throws(()=>encodeClock(new Date('1999-12-31T23:59:59Z'),60));
  assert.throws(()=>encodeClock(new Date('2100-01-01T00:00:00Z'),60));
  assert.throws(()=>encodeClock(new Date('invalid'),60));
  assert.throws(()=>encodeClock(new Date(),841));
  assert.throws(()=>encodeClock(new Date(),-721));
  assert.throws(()=>encodeClock(new Date(),60.5));
  assert.equal(encodeClock(new Date('2099-12-31T23:59:59Z'),840).length,8);
});
