import assert from 'node:assert/strict';
import test from 'node:test';
import { layout } from './view.js';

test('app navigation and home expose measurement views only', () => {
  const navigation = layout.match(/<nav\b[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...navigation.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]), ['overview', 'history', 'device']);
  assert.doesNotMatch(layout, /Atemhilfe|Atemübung|data-(?:view|action)="breathe"|id="breathe"/i);
  assert.match(layout, /Atemzüge pro Minute/);
});

test('day statistics and chart selector offer pulse and respiration only', () => {
  assert.deepEqual([...layout.matchAll(/id="(\w+)-average"/g)].map((match) => match[1]), ['heartRate', 'respirationRate']);
  const selector = layout.match(/<select id="daily-metric">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...selector.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]), ['heartRate', 'respirationRate']);
  assert.doesNotMatch(layout, /Stressindex|SpO[₂2]/i);
});
