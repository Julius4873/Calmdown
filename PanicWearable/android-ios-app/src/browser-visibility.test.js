import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_PAUSE_DELAY_MS, watchBrowserVisibility } from './browser-visibility.js';

function fixture() {
  let listener;
  let pending = null;
  const calls = [];
  const document = {
    hidden: false,
    addEventListener(name, callback) { assert.equal(name, 'visibilitychange'); listener = callback; },
    removeEventListener(name, callback) { assert.equal(callback, listener); listener = null; },
  };
  const remove = watchBrowserVisibility(document, {
    onHidden: () => calls.push('recording-paused'),
    onVisible: () => calls.push('visible'),
    onPause: () => calls.push('disconnect'),
  }, {
    schedule(callback, delay) { assert.equal(delay, BROWSER_PAUSE_DELAY_MS); pending = callback; return callback; },
    cancel(handle) { if (handle === pending) pending = null; },
  });
  return {
    calls, remove,
    hidden(value) { document.hidden = value; listener(); },
    elapseDelay() { const callback = pending; pending = null; callback?.(); },
  };
}

test('brief iOS device sheets pause recording without tearing down the selected BLE connection', () => {
  const f = fixture();
  f.hidden(true);
  assert.deepEqual(f.calls, ['recording-paused']);
  f.hidden(false);
  f.elapseDelay();
  assert.deepEqual(f.calls, ['recording-paused', 'visible']);
});

test('genuine backgrounding closes BLE after the grace period and resume is propagated', () => {
  const f = fixture();
  f.hidden(true);
  f.elapseDelay();
  assert.deepEqual(f.calls, ['recording-paused', 'disconnect']);
  f.hidden(false);
  assert.deepEqual(f.calls, ['recording-paused', 'disconnect', 'visible']);
});

test('removing the visibility observer cancels a pending pause', () => {
  const f = fixture();
  f.hidden(true);
  f.remove();
  f.elapseDelay();
  assert.deepEqual(f.calls, ['recording-paused']);
});
