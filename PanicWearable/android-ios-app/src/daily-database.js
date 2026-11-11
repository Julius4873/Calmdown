import { historyContribution, mergeAggregate, sampleContribution, supportedAggregate } from './daily-data.js';

const DATABASE_NAME = 'calmdown-daily-v1';

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Speichern abgebrochen.'));
    transaction.onerror = () => {};
  });
}

export class DailyDatabase {
  #db = null;
  #opening = null;
  #writes = Promise.resolve();
  #lastPacket = null;

  constructor({
    indexedDB = globalThis.indexedDB,
    keyRange = globalThis.IDBKeyRange,
    name = DATABASE_NAME,
    onChange = () => {},
    onError = () => {},
  } = {}) {
    this.factory = indexedDB;
    this.keyRange = keyRange;
    this.name = name;
    this.onChange = onChange;
    this.onError = onError;
    this.issue = null;
  }

  open() {
    if (this.#db) return Promise.resolve(this.#db);
    if (this.#opening) return this.#opening;
    this.#opening = new Promise((resolve, reject) => {
      if (!this.factory || !this.keyRange) {
        reject(new Error('Dieser Browser stellt keine lokale Datenbank bereit.'));
        return;
      }
      let finished = false;
      const request = this.factory.open(this.name, 3);
      const timer = setTimeout(() => {
        finished = true;
        reject(new Error('Die lokale Datenbank antwortet nicht. Schließe andere Calmdown-Tabs und versuche es erneut.'));
      }, 10_000);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (event.oldVersion < 1) {
          const minutes = database.createObjectStore('minutes', { keyPath: ['day', 'minute'] });
          minutes.createIndex('day', 'day');
          minutes.createIndex('minute', 'minute');
          const days = database.createObjectStore('days', { keyPath: 'day' });
          days.createIndex('month', 'month');
        }
        if (event.oldVersion < 2) database.createObjectStore('watchSync', { keyPath: 'source' });
        if (event.oldVersion < 3) {
          // Rebuild the derived day index from the retained minute aggregates.
          const transaction = request.transaction;
          const days = transaction.objectStore('days');
          days.clear();
          const summaries = new Map();
          const cursor = transaction.objectStore('minutes').openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) {
              for (const summary of summaries.values()) days.put(summary);
              return;
            }
            const minute = supportedAggregate(entry.value);
            if (minute) {
              const { day, month, firstAt, lastAt, samples, metrics } = minute;
              summaries.set(day, mergeAggregate(summaries.get(day), { day, month, firstAt, lastAt, samples, metrics }));
            }
            entry.continue();
          };
        }
      };
      request.onblocked = () => {
        finished = true;
        clearTimeout(timer);
        reject(new Error('Schließe andere Calmdown-Tabs, damit die Datenbank geöffnet werden kann.'));
      };
      request.onerror = () => {
        finished = true;
        clearTimeout(timer);
        reject(request.error);
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (finished) {
          request.result.close();
          return;
        }
        finished = true;
        const connection = request.result;
        this.#db = connection;
        connection.onversionchange = () => {
          connection.close();
          if (this.#db !== connection) return;
          this.#db = null;
          this.#opening = null;
          this.#failed(new Error('Die Datenbank wurde in einem anderen Tab aktualisiert. Öffne Calmdown erneut.'));
        };
        resolve(this.#db);
      };
    }).catch((error) => {
      this.#opening = null;
      this.#failed(error);
      throw error;
    });
    return this.#opening;
  }

  #failed(error) {
    this.issue = error;
    this.onError(error);
  }

  #enqueue(operation) {
    const task = this.#writes.then(operation);
    this.#writes = task.catch(() => {});
    return task.catch((error) => {
      this.#failed(error);
      throw error;
    });
  }

  record(sample, timeZone) {
    const contribution = sampleContribution(sample, timeZone);
    if (!contribution || this.issue) return Promise.resolve(false);
    return this.#enqueue(async () => {
      if (this.issue) return false;
      const identity = Number.isInteger(sample.packetCount) && Number.isInteger(sample.uptimeMs)
        ? sample.packetCount + '/' + sample.uptimeMs : null;
      if (identity && this.#lastPacket?.identity === identity
        && Math.abs(sample.receivedAt - this.#lastPacket.at) < 30_000) return false;
      const db = await this.open();
      const transaction = db.transaction(['minutes', 'days'], 'readwrite');
      const done = committed(transaction);
      this.#aggregate(transaction, contribution);
      await done;
      this.#lastPacket = { identity, at: sample.receivedAt };
      this.onChange({ type: 'record', day: contribution.day });
      return true;
    });
  }

  #aggregate(transaction, contribution) {
    const minutes = transaction.objectStore('minutes');
    const days = transaction.objectStore('days');
    const minuteRequest = minutes.get([contribution.day, contribution.minute]);
    minuteRequest.onsuccess = () => minutes.put(mergeAggregate(minuteRequest.result, contribution));
    const dayRequest = days.get(contribution.day);
    dayRequest.onsuccess = () => {
      const { day, month, firstAt, lastAt, samples, metrics } = contribution;
      days.put(mergeAggregate(dayRequest.result, { day, month, firstAt, lastAt, samples, metrics }));
    };
  }

  async watchCursor(source) {
    await this.#writes;
    const db = await this.open();
    const cursor = await result(db.transaction('watchSync', 'readonly').objectStore('watchSync').get(source));
    return cursor?.sequence ?? 0;
  }

  commitWatchRecord(source, record) {
    const contribution = historyContribution(record);
    return this.#enqueue(async () => {
      if (this.issue) throw this.issue;
      const db = await this.open();
      const stores = ['minutes', 'days', 'watchSync'];
      let transaction;
      try {
        transaction = db.transaction(stores, 'readwrite', { durability: 'strict' });
      } catch (error) {
        if (error?.name !== 'TypeError') throw error;
        transaction = db.transaction(stores, 'readwrite');
      }
      const done = committed(transaction);
      const cursors = transaction.objectStore('watchSync');
      const cursor = cursors.get(source);
      let imported = false;
      cursor.onsuccess = () => {
        if ((cursor.result?.sequence ?? 0) >= record.sequence) return;
        this.#aggregate(transaction, contribution);
        cursors.put({ source, sequence: record.sequence });
        imported = true;
      };
      await done; // The caller must not ACK a successful put request alone.
      if (imported) this.onChange({ type: 'record', day: contribution.day });
      return imported;
    });
  }

  async listDays(month) {
    await this.#writes;
    const db = await this.open();
    const transaction = db.transaction('days', 'readonly');
    const request = month
      ? transaction.objectStore('days').index('month').getAll(this.keyRange.only(month))
      : transaction.objectStore('days').getAll();
    return (await result(request)).map(supportedAggregate).filter(Boolean);
  }

  async getDay(day) {
    await this.#writes;
    const db = await this.open();
    const transaction = db.transaction(['days', 'minutes'], 'readonly');
    const [summary, minutes] = await Promise.all([
      result(transaction.objectStore('days').get(day)),
      result(transaction.objectStore('minutes').index('day').getAll(this.keyRange.only(day))),
    ]);
    const supportedMinutes = minutes.map(supportedAggregate).filter(Boolean);
    supportedMinutes.sort((left, right) => left.minute - right.minute);
    return { summary: supportedAggregate(summary), minutes: supportedMinutes };
  }

  async countDays() {
    await this.#writes;
    const db = await this.open();
    return result(db.transaction('days', 'readonly').objectStore('days').count());
  }

  async recent(since) {
    await this.#writes;
    const db = await this.open();
    const transaction = db.transaction('minutes', 'readonly');
    const minutes = await result(transaction.objectStore('minutes').index('minute').getAll(this.keyRange.lowerBound(Math.floor(since / 60_000))));
    return minutes.map(supportedAggregate).filter(Boolean);
  }

  async export() {
    await this.#writes;
    const db = await this.open();
    const transaction = db.transaction(['days', 'minutes'], 'readonly');
    const [days, minutes] = await Promise.all([
      result(transaction.objectStore('days').getAll()),
      result(transaction.objectStore('minutes').getAll()),
    ]);
    return {
      version: 1, aggregation: 'minute',
      days: days.map(supportedAggregate).filter(Boolean),
      minutes: minutes.map(supportedAggregate).filter(Boolean),
    };
  }

  deleteDay(day) {
    return this.#enqueue(async () => {
      const db = await this.open();
      const transaction = db.transaction(['days', 'minutes'], 'readwrite');
      const done = committed(transaction);
      transaction.objectStore('days').delete(day);
      const cursorRequest = transaction.objectStore('minutes').index('day').openCursor(this.keyRange.only(day));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      await done;
      this.#lastPacket = null;
      this.issue = null;
      this.onChange({ type: 'delete', day });
    });
  }

  clear() {
    return this.#enqueue(async () => {
      const db = await this.open();
      // Keep committed watch cursors as tombstones so erased app history does
      // not reappear the next time the same ring is synced.
      const transaction = db.transaction(['days', 'minutes'], 'readwrite');
      const done = committed(transaction);
      transaction.objectStore('days').clear();
      transaction.objectStore('minutes').clear();
      await done;
      this.#lastPacket = null;
      this.issue = null;
      this.onChange({ type: 'clear' });
    });
  }

  retry() {
    this.issue = null;
    return this.open();
  }

  close() {
    this.#db?.close();
    this.#db = null;
    this.#opening = null;
  }
}
