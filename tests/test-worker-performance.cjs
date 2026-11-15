const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const folder = path.resolve('extension');
const copy = (x) => JSON.parse(JSON.stringify(x));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
function snapshot(revision = 1) {
  return {
    status: 'live',
    self: 'You',
    cash: 250,
    startingHand: [3, 3, 2, 2],
    held: [3, 3, 2, 2],
    players: names.map((name) => ({ name, cash: 250, cards: 10 })),
    net: names.map(() => [0, 0, 0, 0]),
    trades: [],
    roundKey: 'perf|1',
    round: 1,
    room: 'perf',
    timer: '3:00',
    signature: 'quote' + revision,
    analysisRevision: revision,
    recordingRequired: true,
    context: { botDifficulty: 'Hard' },
    markets: ['s', 'c', 'd', 'h'].map((id, i) => ({
      id,
      held: [3, 3, 2, 2][i],
      bid: revision + i,
      ask: revision + i + 5,
      buyer: names[1],
      seller: names[2],
      canBuy: true,
      canSell: true,
      canBid: true,
      canOffer: true,
      canRaiseBid: true,
      canLowerAsk: true,
      fills: [],
    })),
  };
}
function worker(source = folder, options = {}) {
  const db = options.db || {
    rounds: new Map(),
    events: new Map(),
    learning: new Map(),
    ratings: new Map(),
  };
  const control = { hold: false, fail: false, delay: 0, release: null };
  let instance;
  class Store {
    constructor() {
      instance = this;
      this.pending = [];
      this.saved = 0;
      this.error = null;
    }
    async get(kind, key) {
      return db[kind].has(key) ? copy(db[kind].get(key)) : undefined;
    }
    async all(kind) {
      return [...db[kind].values()].map(copy);
    }
    async events(id) {
      return [...db.events.values()]
        .filter((e) => e.roundId === id)
        .sort((a, b) => a.seq - b.seq)
        .map(copy);
    }
    async saveLearning(x) {
      db.learning.set('global', copy(x));
    }
    queue(round, events, learning) {
      this.pending.push(copy({ round, events, learning }));
    }
    async flush() {
      if (this.flushing) {
        await this.flushing;
        return this.flush();
      }
      if (!this.pending.length) return;
      const batch = this.pending.splice(0);
      this.flushing = (async () => {
        await Promise.resolve();
        try {
          if (control.hold) await new Promise((r) => (control.release = r));
          if (control.delay) await pause(control.delay);
          if (control.fail) throw Error('Simulated storage failure');
          for (const item of batch) {
            db.rounds.set(item.round.id, item.round);
            for (const e of item.events) db.events.set(e.id, e);
            if (item.learning) db.learning.set('global', item.learning);
            this.saved += item.events.length;
          }
          this.error = null;
        } catch (e) {
          this.pending.unshift(...batch);
          this.error = e.message;
          throw e;
        } finally {
          this.flushing = null;
        }
      })();
      return this.flushing;
    }
    async saveRatingObservation(event) {
      if (control.fail) throw Error('Simulated rating failure');
      const inserted = !db.ratings.has(event.id);
      if (inserted) db.ratings.set(event.id, copy(event));
      return { inserted };
    }
    async ratingObservations() {
      return [...db.ratings.values()].map(copy).sort((a, b) => a.at - b.at);
    }
    status() {
      return {
        persistedEvents: this.saved,
        pendingEvents: this.pending.reduce((a, b) => a + b.events.length, 0),
        error: this.error,
      };
    }
  }
  let listener;
  const context = {
    console,
    performance,
    crypto: require('node:crypto').webcrypto,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        id: 'perf',
        onMessage: {
          addListener(f) {
            listener = f;
          },
        },
      },
    },
  };
  vm.createContext(context);
  context.importScripts = (...files) =>
    files.forEach((file) => {
      if (file === 'record-store.js') context.FiggieRecordStore = Store;
      else
        vm.runInContext(fs.readFileSync(path.join(source, file), 'utf8'), context, {
          filename: file,
        });
    });
  vm.runInContext(fs.readFileSync(path.join(source, 'background.js'), 'utf8'), context);
  const send = (message) =>
    new Promise((resolve) => {
      assert(
        listener(
          message,
          { id: 'perf', tab: { id: 7, url: 'https://www.figgie.com/play/' } },
          resolve,
        ),
      );
    });
  let seq = 0;
  const item = (s) => ({
    kind: 'observe',
    stream: options.stream || 'perf',
    seq: ++seq,
    at: 1000 + 100 * s.analysisRevision,
    snapshot: copy(s),
  });
  const record = (s) => send({ type: 'figgie-record', batch: [item(s)] });
  const model = (s) =>
    send({ type: 'figgie-model', job: { id: s.analysisRevision, snapshot: copy(s) } });
  return { db, control, send, item, record, model, store: () => instance, context };
}
function modelNumbers(model) {
  const result = copy({
    bySuit: model.bySuit,
    expectedPayout: model.expectedPayout,
    expectedBase: model.expectedBase,
    expectedBonus: model.expectedBonus,
    resting: model.resting,
    actualBook: model.actualBook,
    baseline: model.baseline,
    behavior: model.behavior,
    inventoryCalibration: model.inventoryCalibration,
  });
  // Cache residency and cumulative build diagnostics depend on which earlier
  // revisions this worker evaluated. Keep all prices, probabilities, posterior
  // styles, method settings and sample budgets in the exact comparison.
  if (result.behavior.opponentLearning)
    for (const key of ['builds', 'cacheHits', 'cachedHands', 'exactPublicTables', 'minEffective'])
      delete result.behavior.opponentLearning[key];
  return result;
}
async function timedBarrier(source) {
  const w = worker(source);
  const s = snapshot(1);
  await w.record(s);
  await w.model(s);
  w.control.delay = 180;
  const next = snapshot(2);
  const started = performance.now();
  const record = w.record(next);
  const model = await w.model(next);
  const ms = performance.now() - started;
  assert(!model.error, model.error);
  await record;
  return ms;
}
async function queueTests() {
  const w = worker();
  const s = snapshot();
  await w.record(s);
  await w.model(s);
  w.control.hold = true;
  let committed = false;
  const second = snapshot(2);
  const packet = { type: 'figgie-record', batch: [w.item(second)] };
  const ack = w.send(packet).then((r) => {
    committed = true;
    return r;
  });
  await pause(10);
  const started = performance.now();
  const response = await Promise.race([
    w.model(second),
    pause(600).then(() => {
      throw Error('Inference blocked on a storage commit');
    }),
  ]);
  assert(!response.error, response.error);
  assert(!committed, 'record ACK cannot precede storage commit');
  const latency = performance.now() - started;
  w.control.hold = false;
  w.control.release();
  assert(!(await ack).error);
  const events = w.db.events.size;
  await w.send(packet);
  assert.equal(w.db.events.size, events, 'overlapping-prefix retry remains idempotent');
  const third = snapshot(3);
  const fourth = snapshot(4);
  let resolved = false;
  const pending = w.model(third).then((r) => {
    resolved = true;
    return r;
  });
  await pause(10);
  assert(!resolved, 'model must wait for its evidence');
  const batch = w.send({ type: 'figgie-record', batch: [w.item(third), w.item(fourth)] });
  const exact = await pending;
  assert.equal(exact.recording.observedRevision, 3);
  await batch;
  const reference = worker();
  for (const frame of [s, second, third]) await reference.record(frame);
  const direct = await reference.model(third);
  assert.deepEqual(
    modelNumbers(exact.model),
    modelNumbers(direct.model),
    'model uses exact checkpoint, not later quote evidence in its batch',
  );
  const stale = await w.model(third);
  assert(stale.superseded && !stale.model, 'older snapshots cannot consume future evidence');
  const other = snapshot(5);
  other.round = 2;
  other.roundKey = 'perf|2';
  let changedRoundResolved = false;
  const nextRound = w.model(other).then((r) => {
    changedRoundResolved = true;
    return r;
  });
  await pause(10);
  assert(!changedRoundResolved, 'a prior round never satisfies the revision barrier');
  await w.record(other);
  assert(!(await nextRound).error);
  const lateOld = await w.send(packet);
  assert.equal(
    lateOld.recording.roundKey,
    other.roundKey,
    'late overlapping old-round prefix cannot switch session backward',
  );
  assert(!(await w.model(other)).error);
  w.control.fail = true;
  const failure = snapshot(6);
  failure.round = 2;
  failure.roundKey = 'perf|2';
  const failedPacket = { type: 'figgie-record', batch: [w.item(failure)] };
  assert((await w.send(failedPacket)).error);
  const before = w.db.events.size;
  w.control.fail = false;
  assert(!(await w.send(failedPacket)).error);
  assert(w.db.events.size > before);
  const once = w.db.events.size;
  await w.send(failedPacket);
  assert.equal(w.db.events.size, once);
  const missing = { ...failure, analysisRevision: 99, signature: 'missing' };
  const timeout = await w.model(missing);
  assert(timeout.error && !timeout.model, 'a missing source returns a bounded error');
  const restored = worker(folder, { db: w.db });
  await restored.record(failure);
  const recovered = await restored.model(failure);
  const live = await w.model(failure);
  assert.deepEqual(
    modelNumbers(recovered.model),
    modelNumbers(live.model),
    'worker recovery preserves exact posterior and price values',
  );
  return {
    blockedCommitModelMs: +latency.toFixed(2),
    ack: 'only after durable commit',
    barrier: 'exact round/revision, ordered inside batch, bounded timeout',
    recovery: 'same goal/bonus/resting values',
    duplicateRetries: 'idempotent',
  };
}
async function storeTests() {
  const { RecordStore } = require('../extension/record-store.js');
  const store = new RecordStore();
  const counts = { rounds: 0, events: 0, learning: 0 };
  const records = { rounds: new Map(), events: new Map(), learning: new Map() };
  let fail = false;
  store.db = {
    transaction() {
      const operations = [];
      const tx = {
        objectStore(name) {
          return {
            put(value) {
              counts[name]++;
              operations.push([name, copy(value)]);
            },
          };
        },
      };
      queueMicrotask(() => {
        if (fail) {
          tx.error = Error('Aborted test transaction');
          tx.onabort();
        } else {
          for (const [name, value] of operations) records[name].set(value.id, value);
          tx.oncomplete();
        }
      });
      return tx;
    },
  };
  for (let i = 1; i <= 16; i++)
    store.queue(
      { id: 'round', seq: i, snapshot: { large: 'x'.repeat(20000) } },
      [{ id: 'round:' + i, seq: i }],
      { count: i },
    );
  await store.flush();
  assert.equal(counts.rounds, 1);
  assert.equal(counts.events, 16);
  assert.equal(counts.learning, 1);
  assert.equal(records.rounds.get('round').seq, 16);
  assert.equal(records.learning.get('global').count, 16);
  assert.equal(store.timer, null, 'manual flush clears scheduled no-op flush');
  fail = true;
  store.queue({ id: 'round', seq: 17 }, [{ id: 'round:17', seq: 17 }]);
  await assert.rejects(store.flush());
  assert.equal(store.status().pendingEvents, 1);
  fail = false;
  store.queue({ id: 'round', seq: 18 }, [{ id: 'round:18', seq: 18 }]);
  await store.flush();
  assert.equal(records.rounds.get('round').seq, 18);
  assert.equal(records.events.size, 18);
  return {
    batchItems: 16,
    metadataWrites: 1,
    eventWrites: 16,
    learningWrites: 1,
    retry: 'all events restored atomically',
  };
}
async function migrationTests() {
  const { RecordStore } = require('../extension/record-store.js');
  const tables = new Map();
  const stats = { opens: 0, created: [], indexes: [] };
  const control = { fail: false };
  for (const name of ['rounds', 'events', 'learning'])
    tables.set(name, {
      rows: new Map(),
      indexes: new Map(name === 'events' ? [['roundId', 'roundId']] : []),
    });
  tables.get('rounds').rows.set('old', {
    id: 'old',
    base: 'matching',
    snapshot: { status: 'ended' },
    preserved: true,
  });
  tables.get('rounds').rows.set('other', { id: 'other', base: 'other' });
  tables.get('events').rows.set('old:1', { id: 'old:1', roundId: 'old', seq: 1, kind: 'original' });
  tables.get('learning').rows.set('global', { id: 'global', preserved: true });
  function objectStore(name, operations) {
    const table = tables.get(name);
    const request = (fn) => {
      const r = {};
      queueMicrotask(() => {
        r.result = fn();
        r.onsuccess?.();
      });
      return r;
    };
    return {
      indexNames: { contains: (key) => table.indexes.has(key) },
      createIndex(key, field) {
        table.indexes.set(key, field);
        stats.indexes.push(name + '.' + key);
      },
      get: (key) => request(() => copy(table.rows.get(key) || null)),
      getAll: () => request(() => [...table.rows.values()].map(copy)),
      index: (key) => ({
        getAll: (value) =>
          request(() =>
            [...table.rows.values()].filter((x) => x[table.indexes.get(key)] === value).map(copy),
          ),
      }),
      put: (value) => operations.push([table, copy(value), false]),
      add: (value) => operations.push([table, copy(value), true]),
    };
  }
  const db = {
    objectStoreNames: { contains: (name) => tables.has(name) },
    createObjectStore(name) {
      assert(!tables.has(name));
      tables.set(name, { rows: new Map(), indexes: new Map() });
      stats.created.push(name);
      return objectStore(name, []);
    },
    close() {},
    transaction(names, mode) {
      const abort = mode === 'readwrite' && control.fail;
      if (abort) control.fail = false;
      const operations = [];
      const tx = { objectStore: (name) => objectStore(name, operations) };
      setTimeout(() => {
        if (abort) {
          tx.error = Error('Simulated rating abort');
          tx.onabort?.();
          return;
        }
        for (const [table, value, add] of operations) {
          assert(!add || !table.rows.has(value.id));
          table.rows.set(value.id, value);
        }
        tx.oncomplete?.();
      }, 0);
      return tx;
    },
  };
  const previous = global.indexedDB;
  global.indexedDB = {
    open(name, version) {
      assert.equal(version, 2);
      stats.opens++;
      const r = { result: db, transaction: { objectStore: (name) => objectStore(name, []) } };
      queueMicrotask(() => {
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  try {
    const store = new RecordStore();
    await Promise.all([store.open(), store.open()]);
    assert.equal(stats.opens, 1, 'concurrent requests share a single database open');
    assert.deepEqual(stats.created, ['ratings']);
    assert.deepEqual(stats.indexes, ['rounds.base']);
    assert(tables.get('rounds').rows.get('old').preserved);
    assert(tables.get('learning').rows.get('global').preserved);
    assert.equal((await store.roundsForBase('matching')).length, 1);
    assert.equal((await store.events('old'))[0].kind, 'original');
    const event = { id: 'rating-1', kind: 'rating_observation', at: 1, name: 'You', rating: 2253 };
    assert((await store.saveRatingObservation(event)).inserted);
    assert(!(await store.saveRatingObservation({ ...event, rating: 999 })).inserted);
    assert.equal(
      (await store.ratingObservations())[0].rating,
      2253,
      'duplicate id cannot rewrite observed history',
    );
    control.fail = true;
    await assert.rejects(store.saveRatingObservation({ ...event, id: 'rating-2', at: 2 }));
    assert.equal((await store.ratingObservations()).length, 1);
    assert((await store.saveRatingObservation({ ...event, id: 'rating-2', at: 2 })).inserted);
    const exported = (await store.export('old')).trim().split('\n').map(JSON.parse);
    assert(exported.some((x) => x.kind === 'original'));
    assert.equal(exported.filter((x) => x.kind === 'rating_observation').length, 2);
    assert(exported[0].ratingScope.includes('All visible-profile'));
  } finally {
    global.indexedDB = previous;
  }
  return {
    upgrade: 'existing rounds/events/learning preserved',
    lookup: 'indexed round base',
    rating: 'durable insert, deduplication, aborted-write retry, export context',
  };
}
async function contextRecoveryTests() {
  const w = worker();
  const s = snapshot();
  s.context.botDifficulty = 'Medium';
  await w.record(s);
  let model = await w.model(s);
  assert.equal(model.model.behavior.group, 'bots:Medium');
  const restored = worker(folder, { db: w.db, stream: 'reconnect' });
  const unknown = snapshot(2);
  unknown.context.botDifficulty = null;
  await restored.record(unknown);
  model = await restored.model(unknown);
  assert.equal(
    model.model.behavior.group,
    'bots:Medium',
    'unknown difficulty on reconnect retains the recorded policy context',
  );
  assert.equal(model.model.behavior.signals.temperature, 0.6);
  const known = snapshot(3);
  known.context.botDifficulty = 'Hard';
  await restored.record(known);
  model = await restored.model(known);
  assert.equal(
    model.model.behavior.group,
    'bots:Hard',
    'a genuine new difficulty still replaces the remembered setting',
  );
  return {
    unknownDifficulty: 'remembered across worker restart',
    knownDifficulty: 'explicit new value accepted',
  };
}
async function ratingMessageTests() {
  const w = worker();
  const observation = {
    id: '10000000-0000-4000-8000-000000000001',
    schema: 1,
    self: 'You',
    at: Date.now(),
    source: 'visible-statistics',
    rating: 2253,
    stats: {
      lifetimeRounds: 87,
      lifetimeWins: 31,
      lifetimeProfit: 42,
      roundsEasy: 20,
      roundsMedium: 66,
      roundsHard: 1,
      totalTrades: 400,
      winLossRatio: 0.7,
    },
  };
  assert.deepEqual(copy(await w.send({ type: 'figgie-rating-observation', observation })), {
    ok: true,
    id: observation.id,
  });
  await w.send({ type: 'figgie-rating-observation', observation: { ...observation, rating: 999 } });
  let records = await w.send({ type: 'figgie-ratings' });
  assert(records.ok);
  assert.equal(records.observations.length, 1);
  assert.equal(records.observations[0].rating, 2253);
  assert.equal(records.observations[0].kind, 'rating_observation');
  assert.equal(w.db.rounds.size, 0, 'profile-only capture creates no fictional round');
  assert.equal(w.db.learning.size, 0, 'rating observations cannot contaminate model calibration');
  for (const bad of [
    { ...observation, rating: NaN },
    { ...observation, self: '' },
    { ...observation, source: 'private-api' },
    { ...observation, at: NaN },
  ])
    assert((await w.send({ type: 'figgie-rating-observation', observation: bad })).error);
  const restored = worker(folder, { db: w.db });
  assert.equal((await restored.send({ type: 'figgie-ratings' })).observations.length, 1);
  w.control.fail = true;
  const next = {
    ...observation,
    id: '10000000-0000-4000-8000-000000000002',
    at: observation.at + 1000,
  };
  assert((await w.send({ type: 'figgie-rating-observation', observation: next })).error);
  w.control.fail = false;
  assert((await w.send({ type: 'figgie-rating-observation', observation: next })).ok);
  assert.equal(w.db.ratings.size, 2);
  return {
    profileOnly: 'independent durable namespace',
    validation: 'visible source, identity, finite data',
    recovery: 'dedup + failure retry + worker restart',
    learning: 'unchanged',
  };
}
function journalTests() {
  const J = require('../extension/journal.js');
  const j = new J.RoundJournal('j', 'j');
  const s = snapshot();
  j.observe(s, 1000);
  const ended = { ...s, status: 'ended', timer: '0:00', signature: 'ended' };
  j.observe(ended, 1100);
  const before = j.seq;
  for (let i = 1; i <= 120; i++) j.observe({ ...ended, analysisRevision: 2 + i }, 1100 + 1000 * i);
  assert.equal(
    j.seq,
    before,
    'unchanged ended heartbeats do not duplicate source-change/checkpoint events',
  );
  assert(j.dirty, 'accounting/revision metadata still persists');
  assert.equal(j.previous.analysisRevision, 122);
  assert.equal(j.accounting.endObservedAt, 121100);
  j.observe(ended, 125000);
  assert(j.events.at(-1).kind === 'coverage', 'a true observation gap is still recorded');
  j.observe({ ...ended, status: 'paused', signature: 'paused' }, 125100);
  assert(j.events.some((e) => e.kind === 'coverage' && e.status === 'paused'));
  j.observe({ ...ended, roundResult: { goal: 'c' } }, 125200);
  assert.equal(
    j.events.filter((e) => e.kind === 'checkpoint').at(-1).snapshot.roundResult.goal,
    'c',
    'new settlement information remains checkpointed',
  );
  return {
    unchangedEndedFrames: 120,
    addedEvents: 0,
    settlement: 'accounting + source changes preserved',
  };
}
async function main() {
  const result = {
    queue: await queueTests(),
    storage: await storeTests(),
    migration: await migrationTests(),
    ratingMessages: await ratingMessageTests(),
    contextRecovery: await contextRecoveryTests(),
    journal: journalTests(),
  };
  if (process.env.FIGGIE_WORKER_BASELINE) {
    result.slowDiskMs = {
      before: +(await timedBarrier(process.env.FIGGIE_WORKER_BASELINE)).toFixed(2),
      after: +(await timedBarrier(folder)).toFixed(2),
    };
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
