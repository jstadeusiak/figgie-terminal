const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { setup } = require('./figgie-fixture.cjs');
const copy = (x) => JSON.parse(JSON.stringify(x));
const db = { rounds: new Map(), events: new Map(), learning: new Map() };
const control = { fail: false };
class MemoryStore {
  constructor() {
    this.pending = [];
    this.saved = 0;
    this.error = null;
  }
  async get(store, key) {
    return db[store].get(key) && copy(db[store].get(key));
  }
  async all(store) {
    return [...db[store].values()].map(copy);
  }
  async events(id) {
    return [...db.events.values()]
      .filter((e) => e.roundId === id)
      .sort((a, b) => a.seq - b.seq)
      .map(copy);
  }
  async saveLearning(value) {
    if (control.fail) throw Error('Simulated quota error');
    db.learning.set('global', copy(value));
  }
  queue(round, events, learning) {
    this.pending.push(copy({ round, events, learning }));
  }
  async flush() {
    if (control.fail) {
      this.error = 'Simulated quota error';
      throw Error(this.error);
    }
    for (const x of this.pending) {
      db.rounds.set(x.round.id, x.round);
      for (const e of x.events) db.events.set(e.id, e);
      if (x.learning) db.learning.set('global', x.learning);
      this.saved += x.events.length;
    }
    this.pending = [];
    this.error = null;
  }
  status() {
    return {
      persistedEvents: this.saved,
      pendingEvents: this.pending.reduce((v, x) => v + x.events.length, 0),
      error: this.error,
    };
  }
  async export(id) {
    await this.flush();
    const rounds = (await this.all('rounds')).filter((r) => !id || r.id === id);
    return (
      await Promise.all(
        rounds.map(async (r) =>
          [
            JSON.stringify({ kind: 'round_metadata', ...r }),
            ...(await this.events(r.id)).map((e) => JSON.stringify(e)),
          ].join('\n'),
        ),
      )
    ).join('\n');
  }
  async ratingObservations() {
    return [];
  }
  exportChunks(...args) {
    return require('../extension/record-store.js').RecordStore.prototype.exportChunks.apply(
      this,
      args,
    );
  }
}
function start(options = {}) {
  let listener;
  const c = {
    console,
    performance,
    crypto: require('node:crypto').webcrypto,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        id: 'test',
        onMessage: {
          addListener(f) {
            listener = f;
          },
        },
      },
    },
  };
  if (options.now)
    c.Date = class extends Date {
      static now() {
        return options.now();
      }
    };
  vm.createContext(c);
  c.importScripts = (...files) => {
    for (const file of files) {
      if (file === 'record-store.js') c.FiggieRecordStore = MemoryStore;
      else vm.runInContext(fs.readFileSync('extension/' + file, 'utf8'), c);
    }
  };
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), c);
  return (m, sender = { id: 'test', tab: { id: 6, url: 'https://www.figgie.com/play/' } }) =>
    new Promise((resolve) => {
      const accepted = listener(m, sender, resolve);
      if (!accepted) resolve({ rejected: true });
    });
}

module.exports = { start, db, control, copy };
