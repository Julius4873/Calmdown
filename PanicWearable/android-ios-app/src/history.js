const MAX_SESSIONS = 40;
const MAX_POINTS = 180;
const MAX_EVENTS = 50;
const CHECKPOINT_MS = 10_000;
const POINT_INTERVAL_MS = 5_000;

const eventNames = new Set(['warning', 'assist']);
const isTime = (value) => Number.isFinite(value) && value > 0 && value < 8.64e15;
const isRate = (value) => Number.isFinite(value) && value >= 0 && value < 6553.5;
const cleanRate = (value) => isRate(value) ? value : null;
const emptyStats = () => ({ count: 0, total: 0 });

function cleanStats(value) {
  if (!Number.isSafeInteger(value?.count) || value.count < 1
    || !Number.isFinite(value.total) || !isRate(value.total / value.count)) {
    return emptyStats();
  }
  return { count: value.count, total: value.total };
}

export function readHistory(raw) {
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > 1_000_000) throw new TypeError('Unlesbarer Verlauf.');
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.sessions)) throw new TypeError('Unbekanntes Verlaufsformat.');

  const ids = new Set();
  const sessions = [];
  for (const value of data.sessions.slice(0, MAX_SESSIONS)) {
    if (typeof value?.id !== 'string' || value.id.length > 80 || ids.has(value.id)
      || !isTime(value.startedAt) || !isTime(value.endedAt)
      || !Array.isArray(value.points) || !Array.isArray(value.events)) {
      throw new TypeError('Ungültige Messung im Verlauf.');
    }
    ids.add(value.id);
    sessions.push({
      id: value.id,
      startedAt: value.startedAt,
      endedAt: Math.max(value.startedAt, value.endedAt),
      heart: cleanStats(value.heart),
      breath: cleanStats(value.breath),
      warnings: Number.isSafeInteger(value.warnings) && value.warnings >= 0 ? value.warnings : 0,
      points: Array.isArray(value.points) ? value.points.slice(-MAX_POINTS)
        .filter((point) => isTime(point?.at))
        .map((point) => ({ at: point.at, heartRate: cleanRate(point.heartRate), respirationRate: cleanRate(point.respirationRate) })) : [],
      events: Array.isArray(value.events) ? value.events.slice(-MAX_EVENTS)
        .filter((event) => isTime(event?.at) && eventNames.has(event?.kind))
        .map(({ at, kind }) => ({ at, kind })) : [],
    });
  }
  return sessions;
}

function addRate(stats, value) {
  if (!isRate(value)) return;
  stats.count += 1;
  stats.total += value;
}

export function average(stats) {
  return stats.count ? stats.total / stats.count : null;
}

// Native Preferences survives iOS WebView storage eviction. Keep only a small
// bounded journal, and serialize writes so an older checkpoint cannot win.
export class History {
  #active = null;
  #write = Promise.resolve();
  #lastSaved = 0;
  #lastPoint = 0;
  #previousEvent = null;

  constructor({ raw, persist, onChange, onError }) {
    this.issue = null;
    this.recoveryBackup = null;
    try {
      this.sessions = readHistory(raw);
    } catch {
      this.sessions = [];
      this.issue = typeof raw === 'string' ? 'corrupt' : 'unavailable';
      this.recoveryBackup = typeof raw === 'string' ? raw : null;
    }
    this.persist = persist;
    this.onChange = onChange;
    this.onError = onError;
  }

  get activeId() {
    return this.#active?.id ?? null;
  }

  record(sample, elapsed = performance.now()) {
    if (this.issue) return;
    if (sample.demo) {
      this.finish();
      return;
    }
    const { heartRate, respirationRate, receivedAt } = sample;
    const event = sample.warning || sample.state === 2 ? 'warning' : null;
    if (!this.#active && !isRate(heartRate) && !isRate(respirationRate) && !event) return;

    const starting = this.#active === null;
    if (starting) {
      this.#active = {
        id: globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + '-' + receivedAt,
        startedAt: receivedAt,
        endedAt: receivedAt,
        heart: emptyStats(),
        breath: emptyStats(),
        warnings: 0,
        points: [],
        events: [],
      };
      this.sessions.unshift(this.#active);
      this.sessions.length = Math.min(this.sessions.length, MAX_SESSIONS);
    }
    const session = this.#active;
    session.endedAt = Math.max(session.endedAt, receivedAt);
    addRate(session.heart, heartRate);
    addRate(session.breath, respirationRate);
    const newEvent = event !== null && event !== this.#previousEvent;
    this.#previousEvent = event;
    if (newEvent) {
      session.events.push({ at: receivedAt, kind: event });
      if (session.events.length > MAX_EVENTS) session.events.shift();
      if (event === 'warning') session.warnings += 1;
    }
    if (starting || newEvent || elapsed - this.#lastPoint >= POINT_INTERVAL_MS) {
      session.points.push({ at: receivedAt, heartRate, respirationRate });
      if (session.points.length > MAX_POINTS) session.points.shift();
      this.#lastPoint = elapsed;
    }
    if (starting || newEvent || elapsed - this.#lastSaved >= CHECKPOINT_MS) {
      this.#lastSaved = elapsed;
      void this.#save();
    }
    this.onChange();
  }

  finish() {
    if (!this.#active) return;
    this.#active = null;
    this.#previousEvent = null;
    void this.#save();
    this.onChange();
  }

  remove(id) {
    if (this.issue) return Promise.resolve(false);
    if (id === this.activeId) {
      this.#active = null;
      this.#previousEvent = null;
    }
    this.sessions = this.sessions.filter((session) => session.id !== id);
    this.onChange();
    return this.#save();
  }

  clear() {
    if (this.issue) return Promise.resolve(false);
    this.#active = null;
    this.#previousEvent = null;
    this.sessions = [];
    this.onChange();
    return this.#save();
  }

  export() {
    const sessions = this.sessions.map((session) => ({
      ...session, events: session.events.filter(({ kind }) => kind === 'warning'),
    }));
    return JSON.stringify({ version: 1, sessions }, null, 2);
  }

  async resetCorruptHistory() {
    if (this.issue !== 'corrupt') return false;
    const result = await this.#save();
    if (result === false) return false;
    this.issue = null;
    this.recoveryBackup = null;
    this.onChange();
    return true;
  }

  #save() {
    const snapshot = JSON.stringify({ version: 1, sessions: this.sessions });
    const result = this.#write.then(() => this.persist(snapshot));
    this.#write = result.catch(() => this.onError());
    return result.catch(() => false);
  }
}
