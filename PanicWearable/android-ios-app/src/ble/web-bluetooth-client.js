const POLL_INTERVAL_MS = 1_000;
const CONNECT_TIMEOUT_MS = 25_000;
const GATT_TIMEOUT_MS = 20_000;

// Bluefy provides Web Bluetooth directly. Listen on the characteristic itself
// instead of routing through the Capacitor web plugin's UUID-derived event keys.
export class WebBluetoothClient {
  #devices = new Map();
  #link = null;
  #diagnostic = { step: 'Noch nicht verbunden', error: null };

  constructor(bluetooth, {
    startTimer = (callback, delay) => setInterval(callback, delay),
    stopTimer = (timer) => clearInterval(timer),
    startTimeout = (callback, delay) => setTimeout(callback, delay),
    stopTimeout = (timer) => clearTimeout(timer),
  } = {}) {
    this.bluetooth = bluetooth;
    this.startTimer = startTimer;
    this.stopTimer = stopTimer;
    this.startTimeout = startTimeout;
    this.stopTimeout = stopTimeout;
  }

  get deliveryMode() {
    return this.#link?.polling ? 'read' : this.#link?.subscribed ? 'notifications' : null;
  }

  get diagnostic() {
    return this.#diagnostic;
  }

  get operationPending() {
    return Boolean(this.#link?.pending);
  }

  get requiresUserGesture() {
    return true;
  }

  async requestDevice({ services }) {
    this.#diagnostic = { step: 'Geräteauswahl in Bluefy', error: null };
    try {
      if (typeof this.bluetooth?.requestDevice !== 'function') throw new Error('Web Bluetooth ist in diesem Browser nicht verfügbar.');
      const device = await this.bluetooth.requestDevice({
        filters: [{ services }],
        optionalServices: services,
      });
      this.#devices.set(device.id, device);
      return { deviceId: device.id, name: device.name || 'StressMonitor' };
    } catch (error) {
      this.#report('Geräteauswahl in Bluefy', error);
      throw error;
    }
  }

  async connect(deviceId, onDisconnect) {
    const device = this.#devices.get(deviceId);
    if (!device?.gatt) {
      const error = new Error('Das ausgewählte Gerät bietet keinen GATT-Zugriff.');
      this.#report('Verbindung zur Uhr', error);
      throw error;
    }
    const link = {
      device, onDisconnect, server: null, services: new Map(), characteristics: new Map(),
      queue: Promise.resolve(), timer: null, measurement: null, handler: null,
      subscribed: false, polling: false, reading: false, pending: 0,
    };
    this.#link = link;
    link.disconnected = () => this.#lost(link);
    device.addEventListener('gattserverdisconnected', link.disconnected);
    try {
      link.server = await this.#timed(link, 'Verbindung zur Uhr', () => device.gatt.connect(), { timeout: CONNECT_TIMEOUT_MS });
      if (!this.#current(link)) return;
      // Some Web Bluetooth bridges update device.gatt without returning it.
      link.server ??= device.gatt;
    } catch (error) {
      if (this.#current(link)) {
        this.#dispose(link);
        device.gatt.disconnect();
      }
      throw error;
    }
  }

  async startNotifications(deviceId, service, characteristic, callback) {
    const link = this.#getLink(deviceId);
    await this.#enqueue(link, async () => {
      const measurement = await this.#characteristic(link, service, characteristic);
      link.measurement = measurement;
      link.callback = (value) => {
        if (this.#current(link)) callback(asDataView(value));
      };
      link.handler = (event) => {
        if (!this.#current(link)) return;
        link.callback?.(event.target?.value ?? measurement.value);
      };
      measurement.addEventListener('characteristicvaluechanged', link.handler);
      // The watch publishes the same current packet through READ and NOTIFY.
      // READ-first avoids an optional iOS notification startup promise blocking
      // all measurements. A read can itself emit characteristicvaluechanged.
      if (typeof measurement.readValue === 'function') {
        link.polling = true;
        await this.#read(link);
        if (!this.#current(link)) return;
        link.timer = this.startTimer(() => this.#poll(link), POLL_INTERVAL_MS);
      } else {
        await this.#timed(link, 'Benachrichtigungen aktivieren', () => measurement.startNotifications());
        link.subscribed = true;
      }
    });
  }

  async stopNotifications(deviceId) {
    const link = this.#link;
    if (!link || link.device.id !== deviceId) return;
    this.#stopDelivery(link);
    // Disconnect immediately afterwards. Removing the listener and timer here
    // avoids waiting for another GATT request while the browser is suspending.
  }

  async disconnect(deviceId) {
    const link = this.#link;
    if (!link || link.device.id !== deviceId) return;
    this.#dispose(link);
    link.device.gatt.disconnect();
  }

  async write(deviceId, service, characteristic, value) {
    const link = this.#getLink(deviceId);
    await this.#enqueue(link, async () => {
      const target = await this.#characteristic(link, service, characteristic, false);
      const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const step = characteristic === HISTORY_CONTROL_UUID ? 'Uhrspeicher steuern' : 'Uhrzeit senden';
      if (typeof target.writeValueWithResponse === 'function') {
        try {
          await this.#timed(link, step, () => target.writeValueWithResponse(data), { critical: false });
          return;
        } catch (error) {
          if (!this.#current(link) || error.name !== 'NotSupportedError') throw error;
        }
      }
      if (typeof target.writeValue !== 'function') throw new Error('Die Uhrzeit kann in diesem Browser nicht geschrieben werden.');
      await this.#timed(link, step, () => target.writeValue(data), { critical: false });
    });
  }

  async read(deviceId, service, characteristic, { optional = false } = {}) {
    const link = this.#getLink(deviceId);
    return this.#enqueue(link, async () => {
      const target = await this.#characteristic(link, service, characteristic, false, optional);
      return asDataView(await this.#timed(link, 'Uhrspeicher lesen', () => target.readValue(), { critical: false }));
    });
  }

  #current(link) {
    return this.#link === link;
  }

  #getLink(deviceId) {
    if (this.#link?.device.id !== deviceId) throw new Error('Keine Bluetooth-Verbindung.');
    return this.#link;
  }

  #enqueue(link, operation) {
    const task = link.queue.then(() => {
      if (!this.#current(link)) throw new Error('Die Bluetooth-Verbindung wurde unterbrochen.');
      return operation();
    });
    link.queue = task.catch(() => {});
    return task;
  }

  async #characteristic(link, serviceId, characteristicId, critical = true, optional = false) {
    if (!link.services.has(serviceId)) {
      const service = await this.#timed(link, 'StressMonitor-Dienst suchen', () => link.server.getPrimaryService(serviceId), { critical });
      link.services.set(serviceId, service);
    }
    const key = serviceId + '/' + characteristicId;
    if (!link.characteristics.has(key)) {
      const step = critical ? 'Messwertzugriff öffnen' : optional ? 'Uhrspeicher prüfen' : 'Bluetooth-Merkmal öffnen';
      try {
        const characteristic = await this.#timed(link, step, () => link.services.get(serviceId).getCharacteristic(characteristicId), { critical, optional });
        link.characteristics.set(key, characteristic);
      } catch (error) {
        if (!optional || !missingHistoryCharacteristic(error)) throw error;
        const missing = new Error('Uhrspeicher-Merkmal fehlt.');
        missing.historyMissing = true;
        throw missing;
      }
    }
    return link.characteristics.get(key);
  }

  async #read(link) {
    link.reading = true;
    try {
      const value = await this.#timed(link, 'Messwerte direkt lesen', () => link.measurement.readValue());
      if (this.#current(link)) link.callback?.(value);
    } finally {
      link.reading = false;
    }
  }

  #poll(link) {
    if (!this.#current(link) || !link.callback || link.reading) return;
    // Queue reads with clock writes and service discovery. The transport's
    // freshness watchdog still rejects repeated packets and recovers a dead link.
    link.reading = true;
    void this.#enqueue(link, () => this.#read(link))
      .catch(() => {})
      .finally(() => { link.reading = false; });
  }

  async #timed(link, step, operation, { timeout = GATT_TIMEOUT_MS, critical = true, optional = false } = {}) {
    let timer;
    link.pending += 1;
    this.#report(step);
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (!this.#current(link)) throw new Error('Die Bluetooth-Verbindung wurde unterbrochen.');
          return operation();
        }),
        new Promise((_, reject) => {
          timer = this.startTimeout(() => {
            const error = new Error(`Keine Antwort nach ${timeout / 1000} Sekunden. Uhr in der Nähe halten und Bluefy geöffnet lassen.`);
            error.name = 'TimeoutError';
            if (critical && this.#current(link)) {
              this.#report(step, error);
              this.#lost(link, error);
              link.device.gatt.disconnect();
            }
            reject(error);
          }, timeout);
        }),
      ]);
    } catch (error) {
      if (this.#current(link) && !(optional && missingHistoryCharacteristic(error))) this.#report(step, error);
      throw error;
    } finally {
      this.stopTimeout(timer);
      link.pending -= 1;
    }
  }

  #report(step, error) {
    this.#diagnostic = {
      step,
      error: error ? `${step} · ${error.name || 'Fehler'}: ${String(error.message || error).slice(0, 240)}` : this.#diagnostic.error,
    };
  }

  #stopDelivery(link) {
    if (link.timer !== null) this.stopTimer(link.timer);
    link.timer = null;
    if (link.handler) link.measurement.removeEventListener('characteristicvaluechanged', link.handler);
    link.handler = null;
    link.callback = null;
  }

  #dispose(link) {
    if (!this.#current(link)) return;
    this.#stopDelivery(link);
    link.device.removeEventListener('gattserverdisconnected', link.disconnected);
    this.#link = null;
    this.#report('Verbindung beendet');
  }

  #lost(link, error) {
    if (!this.#current(link)) return;
    if (!error) {
      error = new Error('Die Uhr oder der Browser hat die Verbindung getrennt.');
      error.name = 'NetworkError';
    }
    this.#report(this.#diagnostic.step, error);
    this.#dispose(link);
    link.onDisconnect(link.device.id);
  }
}

function asDataView(value) {
  if (typeof value?.getUint8 === 'function') return value;
  if (ArrayBuffer.isView(value)) return new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new DataView(value);
  // Let the shared protocol decoder count malformed deliveries.
  return value;
}
import { HISTORY_CONTROL_UUID, missingHistoryCharacteristic } from './history-protocol.js';

