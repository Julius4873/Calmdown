import {
  decodeHistoryRecord, decodeHistoryStatus, historyCommand, HISTORY_ACK, HISTORY_REQUEST,
  HISTORY_CONTROL_UUID, HISTORY_PART_A_UUID, HISTORY_PART_B_UUID, HISTORY_STATUS_UUID,
} from './history-protocol.js';

const BATCH_SIZE = 24;
const POLL_MS = 10_000;
const STEP_MS = 80;

export class WatchHistorySync {
  #access = null;
  #running = null;
  #nextAt = 0;

  constructor({ database, enabled, onChange, now = () => performance.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.database = database;
    this.enabled = enabled;
    this.onChange = onChange;
    this.now = now;
    this.delay = delay;
    this.state = { phase: 'idle', status: null, imported: 0 };
  }

  setAccess(access) {
    this.#access = access;
    this.#running = null;
    this.#nextAt = 0;
    this.#update({ phase: access ? 'checking' : 'idle', status: null, imported: 0, error: null });
    return this.tick();
  }

  tick() {
    const access = this.#access;
    if (!access?.active() || this.#running || !this.enabled() || this.now() < this.#nextAt) return;
    this.#running = access;
    return this.#sync(access).finally(() => {
      if (this.#running === access) this.#running = null;
    });
  }

  #update(next) {
    this.state = { ...this.state, ...next };
    this.onChange(this.state);
  }

  #current(access) {
    return this.#access === access && access.active() && this.enabled();
  }

  async #sync(access) {
    let retry = POLL_MS;
    try {
      const status = decodeHistoryStatus(await access.read(HISTORY_STATUS_UUID));
      if (!this.#current(access)) return;
      this.#update({ status, error: null });
      if (!status.ready || !access.hasGeneration) {
        this.#update({ phase: 'unavailable' });
        return;
      }
      const cursor = await this.database.watchCursor(access.source);
      if (!this.#current(access)) return;
      if (!status.count || cursor >= status.newest) {
        this.#update({ phase: 'ready' });
        return;
      }
      let requested = Math.max(cursor + 1, status.oldest);
      this.#update({ phase: 'syncing' });
      await access.write(HISTORY_CONTROL_UUID, historyCommand(HISTORY_REQUEST, requested));
      for (let i = 0; i < BATCH_SIZE && requested <= status.newest; i++) {
        const record = await this.#record(access, requested);
        if (!this.#current(access)) return;
        if (!record || record.sequence > status.newest) {
          // The ring moved while we were reading. Re-read its bounds.
          retry = 500;
          return;
        }
        const imported = await this.database.commitWatchRecord(access.source, record);
        if (!this.#current(access)) return;
        // This ACK is only emitted after IndexedDB's strict transaction has
        // completed, or a prior committed cursor proves it was already saved.
        await access.write(HISTORY_CONTROL_UUID, historyCommand(HISTORY_ACK, record.sequence));
        if (!this.#current(access)) return;
        if (imported) this.#update({ imported: this.state.imported + 1 });
        requested = record.sequence + 1;
      }
      if (requested <= status.newest) retry = 500; // Yield to live BLE/UI traffic between batches.
      else this.#update({ phase: 'ready' });
    } catch (error) {
      if (this.#current(access)) this.#update({ phase: 'error', error: String(error?.message || error).slice(0, 200) });
    } finally {
      if (this.#access === access) this.#nextAt = this.now() + retry;
    }
  }

  async #record(access, requested) {
    for (let attempt = 0; attempt < 7; attempt++) {
      await this.delay(STEP_MS);
      if (!this.#current(access)) return null;
      const status = decodeHistoryStatus(await access.read(HISTORY_STATUS_UUID));
      if (!this.#current(access) || !status.ready || status.newest < requested) return null;
      if (status.requested !== requested) continue;
      const a = await access.read(HISTORY_PART_A_UUID);
      if (!this.#current(access)) return null;
      const b = await access.read(HISTORY_PART_B_UUID);
      const record = decodeHistoryRecord(a, b);
      if (record && record.sequence >= requested && record.sequence >= status.oldest && record.sequence <= status.newest) return record;
    }
    throw new Error('Die angeforderte Messminute ist noch nicht lesbar. Der Abgleich wird erneut versucht.');
  }
}
