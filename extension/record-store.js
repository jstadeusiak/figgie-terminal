/*
 * Local recording store. Persists recorded rounds, their events, the learning
 * state, and rating observations in the extension-origin IndexedDB, and exports
 * them as NDJSON. No remote endpoint and no cookies/localStorage.
 */
(function (scope) {
  'use strict';

  const DATABASE_NAME = 'figgie-terminal-recordings';
  const DATABASE_VERSION = 2;

  // Object stores. Every record is keyed by its `id`.
  const ROUNDS = 'rounds';
  const EVENTS = 'events';
  const LEARNING = 'learning';
  const RATINGS = 'ratings';
  const KEYED_BY_ID = { keyPath: 'id' };

  // Indexes, each named after the record field it covers.
  const ROUND_BASE = 'base';
  const EVENT_ROUND_ID = 'roundId';

  // The learning store holds a single record.
  const LEARNING_ID = 'global';

  const FLUSH_DELAY_MS = 200;

  // Stamped on every export. Must match manifest.json and the belief model.
  const EXTENSION_VERSION = '0.13.3';
  const MODEL_VERSION = '0.13.3';

  // Chunk sizes are counted in UTF-16 code units, like String.length.
  const MAX_EXPORT_CHUNK_SIZE = 256 * 1024;
  const FIRST_HIGH_SURROGATE = 0xd800;
  const LAST_HIGH_SURROGATE = 0xdbff;

  class RecordStore {
    constructor() {
      this.db = null;
      this.pending = [];
      this.timer = null;
      this.error = null;
      this.saved = 0;
      // `opening` and `flushing` hold the promise of an open or a flush while
      // it is in progress.
    }

    async open() {
      if (this.db) return this.db;
      if (this.opening) return this.opening;
      this.opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => upgradeSchema(request);
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          reject(
            Error('Close older Figgie extension views to finish the recording database upgrade.'),
          );
        };
        request.onsuccess = () => {
          this.db = request.result;
          // Another extension view needs to upgrade the database: release this
          // connection so it can, and reopen on the next use.
          this.db.onversionchange = () => {
            this.db.close();
            this.db = null;
          };
          resolve(this.db);
        };
      });
      try {
        return await this.opening;
      } finally {
        this.opening = null;
      }
    }

    async get(storeName, key) {
      const db = await this.open();
      return requestResult(db.transaction(storeName).objectStore(storeName).get(key));
    }

    async all(storeName) {
      const db = await this.open();
      return requestResult(db.transaction(storeName).objectStore(storeName).getAll());
    }

    async roundsForBase(base) {
      const db = await this.open();
      const byBase = db.transaction(ROUNDS).objectStore(ROUNDS).index(ROUND_BASE);
      return requestResult(byBase.getAll(base));
    }

    async events(roundId) {
      const db = await this.open();
      const byRound = db.transaction(EVENTS).objectStore(EVENTS).index(EVENT_ROUND_ID);
      const events = await requestResult(byRound.getAll(roundId));
      return events.sort((a, b) => a.seq - b.seq);
    }

    queue(round, events, learning) {
      this.pending.push({
        round,
        events,
        // Copied now, because the caller goes on updating its learning state.
        learning: learning ? JSON.parse(JSON.stringify(learning)) : null,
      });
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          // A failed flush keeps its batch and reports through status().
          this.flush().catch(() => {});
        }, FLUSH_DELAY_MS);
      }
    }

    async flush() {
      if (this.flushing) {
        await this.flushing;
        return this.flush();
      }
      if (!this.pending.length) return;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const batch = this.pending.splice(0);
      const latest = latestRecords(batch);
      this.flushing = (async () => {
        try {
          const db = await this.open();
          await writeBatch(db, batch, latest);
          this.saved += countEvents(batch);
          this.error = null;
        } catch (error) {
          // Put the batch back in front so the next flush retries it in order.
          this.pending.unshift(...batch);
          this.error = error.message || 'Local recording storage failed';
          throw error;
        } finally {
          this.flushing = null;
        }
      })();
      return this.flushing;
    }

    async saveLearning(value) {
      const db = await this.open();
      const transaction = db.transaction(LEARNING, 'readwrite');
      transaction.objectStore(LEARNING).put(learningRecord(value));
      await transactionDone(transaction);
    }

    async ratingObservations() {
      return (await this.all(RATINGS)).sort((a, b) => a.at - b.at);
    }

    // The first observation saved under an id is kept; a repeat never rewrites it.
    async saveRatingObservation(event) {
      const db = await this.open();
      const transaction = db.transaction(RATINGS, 'readwrite');
      const ratings = transaction.objectStore(RATINGS);
      let inserted = false;
      const existing = ratings.get(event.id);
      existing.onsuccess = () => {
        if (!existing.result) {
          ratings.add(event);
          inserted = true;
        }
      };
      await transactionDone(transaction, 'Rating recording transaction aborted');
      return { inserted };
    }

    status() {
      return {
        persistedEvents: this.saved,
        pendingEvents: countEvents(this.pending),
        error: this.error,
      };
    }

    // Yields the export as NDJSON text in chunks no longer than `chunkSize`.
    // The background test harness applies this method to its own in-memory
    // store, so it may only rely on flush, all, events, and ratingObservations.
    async *exportChunks(roundId, chunkSize = MAX_EXPORT_CHUNK_SIZE) {
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 2 || chunkSize > MAX_EXPORT_CHUNK_SIZE) {
        throw Error('Invalid export chunk size');
      }
      await this.flush();
      const rounds = await this.all(ROUNDS);
      const selected = roundId ? rounds.filter((round) => round.id === roundId) : rounds;
      const ratings = await this.ratingObservations();
      if (roundId && !selected.length) throw Error('Recorded round not found');

      let buffer = '';
      for await (const row of exportRows(this, selected, ratings)) {
        buffer += JSON.stringify(row) + '\n';
        while (buffer.length >= chunkSize) {
          const end = chunkEnd(buffer, chunkSize);
          yield buffer.slice(0, end);
          buffer = buffer.slice(end);
        }
      }
      if (buffer) yield buffer;
    }

    async export(roundId) {
      const parts = [];
      for await (const part of this.exportChunks(roundId)) parts.push(part);
      return parts.join('');
    }
  }

  // Adds whatever an older database is missing. Existing stores and their
  // records are left in place, so recordings from earlier versions keep loading.
  function upgradeSchema(request) {
    const db = request.result;
    const hasStore = (name) => db.objectStoreNames.contains(name);
    const rounds = hasStore(ROUNDS)
      ? request.transaction.objectStore(ROUNDS)
      : db.createObjectStore(ROUNDS, KEYED_BY_ID);
    if (!rounds.indexNames.contains(ROUND_BASE)) rounds.createIndex(ROUND_BASE, ROUND_BASE);
    if (!hasStore(EVENTS)) {
      db.createObjectStore(EVENTS, KEYED_BY_ID).createIndex(EVENT_ROUND_ID, EVENT_ROUND_ID);
    }
    if (!hasStore(LEARNING)) db.createObjectStore(LEARNING, KEYED_BY_ID);
    if (!hasStore(RATINGS)) db.createObjectStore(RATINGS, KEYED_BY_ID);
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Settles when the transaction commits or raises an error. An abort is
  // reported only when the caller passes `abortMessage`, which also stands in
  // for the error when the abort carries none.
  function transactionDone(transaction, abortMessage) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      if (abortMessage) {
        transaction.onabort = () => reject(transaction.error || Error(abortMessage));
      }
    });
  }

  function learningRecord(learning) {
    return { ...learning, id: LEARNING_ID };
  }

  function countEvents(batch) {
    return batch.reduce((count, item) => count + item.events.length, 0);
  }

  // A batch often carries several versions of the same round and of the
  // learning state. Only the newest of each needs to be written.
  function latestRecords(batch) {
    const rounds = new Map();
    let learning = null;
    for (const item of batch) {
      rounds.set(item.round.id, item.round);
      if (item.learning) learning = item.learning;
    }
    return { rounds, learning };
  }

  // Writes the whole batch in one transaction, so it is stored completely or
  // not at all.
  function writeBatch(db, batch, latest) {
    const transaction = db.transaction([ROUNDS, EVENTS, LEARNING], 'readwrite');
    const rounds = transaction.objectStore(ROUNDS);
    const events = transaction.objectStore(EVENTS);
    for (const round of latest.rounds.values()) rounds.put(round);
    for (const item of batch) {
      for (const event of item.events) events.put(event);
    }
    if (latest.learning) transaction.objectStore(LEARNING).put(learningRecord(latest.learning));
    return transactionDone(transaction, 'Recording transaction aborted');
  }

  async function* exportRows(store, rounds, ratings) {
    yield {
      kind: 'recording_export',
      schema: 1,
      version: EXTENSION_VERSION,
      modelVersion: MODEL_VERSION,
      exportedAt: Date.now(),
      timeBasis: 'Local observation time; recovered execution times are unknown',
      rounds: rounds.length,
      ratingScope:
        'All visible-profile rating observations; interval context may span multiple rounds',
    };
    for (const round of rounds) {
      yield { kind: 'round_metadata', ...round };
      // The metadata records the last event it covers. Events stored after it
      // was read are left out, so each round is exported as a consistent prefix.
      const coversEvent = (event) => !Number.isSafeInteger(round.seq) || event.seq <= round.seq;
      for (const event of await store.events(round.id)) {
        if (coversEvent(event)) yield event;
      }
    }
    for (const rating of ratings) yield rating;
  }

  // Each chunk is encoded on its own, so a chunk must not end between the two
  // halves of a UTF-16 surrogate pair.
  function chunkEnd(buffer, chunkSize) {
    const lastCode = buffer.charCodeAt(chunkSize - 1);
    const splitsPair = lastCode >= FIRST_HIGH_SURROGATE && lastCode <= LAST_HIGH_SURROGATE;
    return splitsPair ? chunkSize - 1 : chunkSize;
  }

  scope.FiggieRecordStore = RecordStore;
  if (typeof module !== 'undefined') module.exports = { RecordStore };
})(globalThis);
