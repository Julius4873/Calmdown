import { BLE_SERVICE_UUID, CLOCK_UUID, MEASUREMENT_UUID, decodeMeasurement, encodeClock } from '../protocol.js';
import { decodeHistoryIdentity, HISTORY_IDENTITY_UUID } from './history-protocol.js';

export const STALE_AFTER_MS = 4_000;
const RECONNECT_AFTER_MS = 10_000;
const RETRY_DELAYS = [1_000, 2_500, 5_000];
const REQUEST_TIMEOUT = { timeout: 4_000 };

// The plugin serializes GATT calls, but its callbacks can arrive while a call is
// still pending. Each callback belongs to one link and is discarded on detach.
export class BleTransport {
  #device = null;
  #link = null;
  #closing = null;
  #busy = false;
  #active = true;
  #wanted = false;
  #autoReconnect = true;
  #retryAt = null;
  #attempt = 0;
  #status = 'idle';
  #error = null;
  #lastDiagnostic = null;

  constructor(client, {
    onChange, onMeasurement, onLegacyMeasurement = () => {}, onHistory = () => {},
    recordEnabled = () => true, now = () => performance.now(),
  }) {
    this.client = client;
    this.onChange = onChange;
    this.onMeasurement = onMeasurement;
    this.onLegacyMeasurement = onLegacyMeasurement;
    this.onHistory = onHistory;
    this.recordEnabled = recordEnabled;
    this.now = now;
  }

  get state() {
    return {
      status: this.#status,
      busy: this.#busy,
      deviceName: this.#device?.name || (this.#device && 'StressMonitor'),
      attempt: this.#attempt,
      error: this.#error,
      measurement: this.#status === 'live' ? this.#link?.sample : null,
      clock: this.#link?.clock ?? { status: 'idle' },
      invalidPackets: this.#link?.invalidPackets ?? 0,
      deliveryMode: this.client.deliveryMode ?? (this.#link?.ready ? 'notifications' : null),
      diagnostic: this.client.diagnostic ?? null,
      historyMode: this.#link?.historyMode ?? 'idle',
      canSync: Boolean(this.#active && this.#link?.ready && !this.#busy && this.#link.clock.status !== 'sending'),
    };
  }

  #publish(status = this.#status, error = this.#error) {
    this.#status = status;
    this.#error = error;
    this.onChange(this.state);
  }

  async connect() {
    if (!this.#active || this.#busy || this.#wanted) return;
    this.#wanted = true;
    this.#attempt = 0;
    await this.#run(async () => {
      this.#publish('selecting', null);
      try {
        let device;
        if (this.client.requiresUserGesture) {
          // Invoke Web Bluetooth before any awaited initialization, while the
          // browser still attributes this request to the user's tap.
          device = await this.client.requestDevice({ services: [BLE_SERVICE_UUID] });
        } else {
          await this.client.initialize({ androidNeverForLocation: true });
          if (!this.#wanted) return;
          if (!await this.client.isEnabled()) throw new Error('Bluetooth ist ausgeschaltet.');
          if (!this.#wanted) return;
          device = await this.client.requestDevice({ services: [BLE_SERVICE_UUID] });
        }
        if (!this.#wanted) return;
        this.#device = device;
        if (this.#active) await this.#open('connecting');
        else this.#publish('paused', null);
      } catch (error) {
        if (this.#wanted) this.#fail(error);
      }
    });
  }

  disconnect() {
    this.#wanted = false;
    this.#device = null;
    this.#retryAt = null;
    this.#attempt = 0;
    this.#detach();
    this.#publish('idle', null);
    this.tick();
  }

  setAutoReconnect(enabled) {
    this.#autoReconnect = enabled;
    if (!enabled && this.#retryAt !== null) this.disconnect();
  }

  setActive(active) {
    if (active === this.#active) return;
    this.#active = active;
    if (!active) {
      this.#retryAt = null;
      this.#detach();
      if (this.#device && !this.#autoReconnect) this.disconnect();
      else if (this.#wanted) this.#publish('paused', null);
    } else if (this.#wanted) {
      if (this.#device) {
        this.#attempt = 0;
        this.#retryAt = this.now();
        this.#publish('reconnecting', null);
      } else {
        // The iOS permission prompt can temporarily deactivate the app while
        // the user's original device selection is still in progress.
        this.#publish('selecting', null);
      }
    }
    this.tick();
  }

  tick() {
    if (this.client.diagnostic !== this.#lastDiagnostic) {
      this.#lastDiagnostic = this.client.diagnostic;
      this.#publish();
    }
    if (this.#busy) return;
    if (this.#closing) {
      const closing = this.#closing;
      this.#closing = null;
      void this.#run(() => this.#close(closing));
      return;
    }
    if (!this.#active) return;
    const now = this.now();
    if (this.#retryAt !== null && now >= this.#retryAt) {
      this.#retryAt = null;
      void this.#run(() => this.#open('reconnecting'));
      return;
    }
    if (!this.#link?.ready) return;
    if (this.#link.historyMode === 'checking' && !this.#link.probing && now >= this.#link.probeAt) {
      void this.#probeHistory(this.#link);
    }
    const age = now - this.#link.lastSeen;
    if (age >= RECONNECT_AFTER_MS && this.#autoReconnect && !this.client.operationPending) {
      this.#detach();
      this.#recover('Die Uhr sendet keine aktuellen Pakete.');
    } else if (age >= STALE_AFTER_MS && this.#status !== 'stale') {
      this.#publish('stale', 'Es kommen keine aktuellen Messwerte an.');
    }
    if (this.#link && this.#link.clock.offset !== new Date().getTimezoneOffset()) void this.syncClock();
  }

  async syncClock() {
    const link = this.#link;
    if (!link?.ready || !this.#active || link.clock.status === 'sending') return;
    const date = new Date();
    const offset = date.getTimezoneOffset();
    link.clock = { status: 'sending', offset };
    this.#publish();
    try {
      await this.client.write(link.deviceId, BLE_SERVICE_UUID, CLOCK_UUID, encodeClock(date), REQUEST_TIMEOUT);
      if (this.#link !== link) return;
      link.clock = { status: 'sent', at: date.getTime(), offset };
    } catch {
      if (this.#link !== link) return;
      link.clock = { status: 'failed', offset };
    }
    this.#publish();
  }

  async #run(operation) {
    this.#busy = true;
    this.#publish();
    try {
      await operation();
    } finally {
      this.#busy = false;
      this.#publish();
      this.tick();
    }
  }

  async #open(status) {
    if (!this.#wanted || !this.#device || !this.#active) return;
    const { deviceId } = this.#device;
    const link = {
      deviceId, ready: false, sample: null, lastSeen: this.now(), clock: {}, invalidPackets: 0,
      historyMode: typeof this.client.read === 'function' ? 'checking' : 'legacy',
      pendingSamples: [], probeAt: 0, probing: false,
    };
    this.#link = link;
    this.#publish(status, null);
    try {
      await this.client.connect(deviceId, () => {
        if (this.#link !== link) return;
        this.#detach();
        this.#recover('Die Bluetooth-Verbindung wurde unterbrochen.');
      }, { timeout: 7_000 });
      if (this.#link !== link) return;
      await this.client.startNotifications(
        deviceId, BLE_SERVICE_UUID, MEASUREMENT_UUID, (value) => this.#receive(link, value), REQUEST_TIMEOUT,
      );
      if (this.#link !== link) return;
      link.ready = true;
      link.lastSeen = this.now();
      this.#publish(link.sample ? 'live' : 'awaiting', null);
      void this.syncClock();
      if (link.historyMode === 'checking') void this.#probeHistory(link);
    } catch (error) {
      if (this.#link !== link) return;
      this.#detach();
      if (status === 'reconnecting') this.#recover('Die Uhr war nicht erreichbar.');
      else this.#fail(error);
    }
  }

  #receive(link, value) {
    if (this.#link !== link || !this.#active) return;
    let sample;
    try {
      sample = decodeMeasurement(value);
    } catch {
      link.invalidPackets += 1;
      this.#publish();
      return;
    }
    if (link.sample && !isNewPacket(link.sample, sample)) return;
    link.sample = sample;
    link.lastSeen = this.now();
    this.#attempt = 0;
    this.#publish('live', null);
    this.onMeasurement(sample);
    if (!sample.demo && this.recordEnabled()) {
      if (link.historyMode === 'legacy') this.onLegacyMeasurement(sample);
      else if (link.historyMode === 'checking') {
        link.pendingSamples.push(sample);
        if (link.pendingSamples.length > 64) link.pendingSamples.shift();
      }
    }
  }

  async #probeHistory(link) {
    link.probing = true;
    const active = () => this.#link === link && this.#active;
    const read = (characteristic, options = {}) => {
      if (!active()) throw new Error('Uhrverbindung beendet.');
      return this.client.read(link.deviceId, BLE_SERVICE_UUID, characteristic, { ...REQUEST_TIMEOUT, ...options });
    };
    try {
      let value;
      let missing = false;
      if (typeof this.client.getServices === 'function') {
        const services = await this.client.getServices(link.deviceId);
        if (!active()) return;
        const service = services.find(({ uuid }) => uuid.toLowerCase() === BLE_SERVICE_UUID);
        if (!Array.isArray(service?.characteristics)) throw new Error('Bluetooth-Dienste noch nicht lesbar.');
        missing = !service.characteristics.some(({ uuid }) => uuid.toLowerCase() === HISTORY_IDENTITY_UUID);
      }
      if (!missing) {
        try {
          value = await read(HISTORY_IDENTITY_UUID, { optional: true });
        } catch (error) {
          if (!active() || error?.historyMissing !== true) throw error;
          missing = true;
        }
      }
      if (missing) {
        link.historyMode = 'legacy';
        for (const sample of link.pendingSamples) if (this.recordEnabled()) this.onLegacyMeasurement(sample);
        link.pendingSamples = [];
        this.#publish();
        return;
      }
      const identity = decodeHistoryIdentity(value);
      if (!active()) return;
      link.historyMode = 'watch';
      link.pendingSamples = [];
      this.onHistory({
        ...identity, active, read,
        write: (characteristic, payload) => {
          if (!active()) throw new Error('Uhrverbindung beendet.');
          return this.client.write(link.deviceId, BLE_SERVICE_UUID, characteristic, payload, REQUEST_TIMEOUT);
        },
      });
      this.#publish();
    } catch {
      // A timeout, corrupt identity or transport failure is not evidence of a
      // legacy watch. Keep live display, but never record ambiguous samples.
      link.probeAt = this.now() + 5_000;
    } finally {
      link.probing = false;
    }
  }

  #detach() {
    if (!this.#link) return;
    this.#closing = this.#link;
    this.#link = null;
    this.onHistory(null);
  }

  async #close(link) {
    try {
      await this.client.stopNotifications(link.deviceId, BLE_SERVICE_UUID, MEASUREMENT_UUID);
    } catch {
      // A lost GATT link cannot unsubscribe on the peripheral.
    }
    try {
      await this.client.disconnect(link.deviceId);
    } catch {
      // iOS may already have closed the link.
    }
  }

  #recover(message) {
    if (this.#wanted && this.#active && this.#autoReconnect && this.#attempt < RETRY_DELAYS.length) {
      this.#retryAt = this.now() + RETRY_DELAYS[this.#attempt];
      this.#attempt += 1;
      this.#publish('reconnecting', message);
      this.tick();
      return;
    }
    this.#fail(message);
    this.tick();
  }

  #fail(error) {
    this.#wanted = false;
    this.#device = null;
    this.#retryAt = null;
    this.#publish('disconnected', bluetoothMessage(error));
  }
}

function isNewPacket(previous, next) {
  const uptimeDelta = (next.uptimeMs - previous.uptimeMs) >>> 0;
  const sequenceDelta = (next.packetCount - previous.packetCount) & 0xffff;
  // Unsigned differences allow wraparound and reject duplicates and reordering
  // within one link. A reboot establishes a fresh GATT link.
  return uptimeDelta > 0 && uptimeDelta < 0x80000000 && sequenceDelta > 0 && sequenceDelta < 0x8000;
}

function bluetoothMessage(error) {
  const message = typeof error === 'string' ? error : error?.message || '';
  if (/ausgeschaltet|unterbrochen|nicht erreichbar|keine aktuellen/.test(message)) return message;
  if (/cancel|abort|user gesture/i.test(message)) return 'Die Geräteauswahl wurde beendet.';
  if (/permission|authoriz|denied|not allowed/i.test(message)) {
    return 'Erlaube Calmdown den Bluetooth-Zugriff in den iPhone-Einstellungen.';
  }
  if (/unavailable|not supported|not available/i.test(message)) {
    return 'Bluetooth ist hier nicht verfügbar. Öffne Calmdown in Bluefy oder verwende die installierte App.';
  }
  return 'Verbindung fehlgeschlagen. Prüfe, ob der StressMonitor eingeschaltet, in Reichweite und frei ist.';
}
