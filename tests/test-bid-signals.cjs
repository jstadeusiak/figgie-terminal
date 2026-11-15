'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Signals = require('../research/candidates/bid-signals.js');
const J = require('../extension/journal.js');
const { Tracker } = Signals;
const SUITS = ['s', 'c', 'd', 'h'];
const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
function harness() {
  let seq = 0;
  const events = [];
  const add = (kind, at, data = {}) => {
    const e = { kind, at, seq: ++seq, roundId: 'test', ...data };
    events.push(e);
    return e;
  };
  const source = (at, options = {}) =>
    add('state', at, {
      status: 'live',
      antePending: false,
      timer: String(60000 - at),
      book: SUITS.map((s) => [
        s,
        ...(options.quotes?.[s]
          ? [options.quotes[s][1], null, options.quotes[s][0], null]
          : [null, null, null, null]),
      ]),
      ...options,
    });
  const quote = (at, suit = 'h', owner = 'Bot-A', price = 10, epoch = 0, extra = {}) =>
    add('quote', at, { side: 'bid', suit, owner, price, epoch, recovered: false, ...extra });
  const reset = (at, epoch, owner = 'Bot-A') => {
    add('fill', at, { index: epoch - 1, recovered: false });
    add('book_reset', at, { cause: 'fill', from: epoch - 1, to: epoch });
    source(at);
  };
  const start = (at = 0, quotes = { h: ['Bot-A', 10] }, antePending = false) =>
    add('round_start', at, {
      snapshot: {
        self: 'You',
        players: names.map((name) => ({ name })),
        status: 'live',
        antePending,
        timer: '60',
        trades: [],
        markets: SUITS.map((id) => ({
          id,
          bid: quotes[id]?.[1] ?? null,
          buyer: quotes[id]?.[0] ?? null,
        })),
      },
    });
  return { events, add, source, quote, reset, start };
}
const feature = (events) => new Tracker({ self: 'You' }).pushAll(events).features();
const near = (a, b, msg) => assert(Math.abs(a - b) < 1e-12, msg || `${a} != ${b}`);
const value = (events, suit = 'h', column = 0) =>
  feature(events).values[SUITS.indexOf(suit)][column];
const results = [];
function test(name, fn) {
  fn();
  results.push(name);
}

test('dwell is confirmed forward time, capped per actor/epoch', () => {
  const h = harness();
  h.start();
  for (let t = 1000; t <= 14000; t += 1000) h.source(t, { quotes: { h: ['Bot-A', 10] } });
  near(value(h.events), 1 / 3);
  assert.equal(feature(h.events).diagnostics.byActor['Bot-A'][3].measuredEpochs, 1);
});
test('peak changes discard lower-price dwell, never apply new price backward', () => {
  const h = harness();
  h.start();
  h.source(1000, { quotes: { h: ['Bot-A', 10] } });
  near(value(h.events), 0.1 / 3);
  h.quote(2000, 'h', 'Bot-A', 11);
  h.source(2000, { quotes: { h: ['Bot-A', 11] } });
  near(value(h.events), 0);
  h.source(3000, { quotes: { h: ['Bot-A', 11] } });
  near(value(h.events), 0.1 / 3);
  h.quote(4000, 'h', 'Bot-A', 9);
  h.source(4000, { quotes: { h: ['Bot-A', 9] } });
  h.source(5000, { quotes: { h: ['Bot-A', 9] } });
  near(value(h.events), 0.2 / 3);
});
test('own bids and unknown roster owners never contribute', () => {
  for (const owner of ['You', 'Stranger']) {
    const h = harness();
    h.start(0, { h: [owner, 30] });
    h.source(1000, { quotes: { h: [owner, 30] } });
    assert.deepEqual(
      feature(h.events).values,
      SUITS.map(() => [0, 0]),
    );
  }
});
test('manual clears cannot create fast returns', () => {
  const h = harness();
  h.start();
  h.add('book_clear', 1000, { suit: 'h', side: 'bid', cause: 'unknown' });
  h.source(1000);
  h.quote(1500);
  h.source(1500, { quotes: { h: ['Bot-A', 10] } });
  near(value(h.events, 'h', 1), 0);
});
test('qualified return is positive delayed first same-owner return after fill', () => {
  const h = harness();
  h.start();
  h.reset(1000, 1);
  h.quote(1500, 'h', 'Bot-B', 10, 1);
  h.source(1500, { quotes: { h: ['Bot-B', 10] } });
  h.quote(2000, 'h', 'Bot-A', 11, 1);
  h.source(2000, { quotes: { h: ['Bot-A', 11] } });
  near(value(h.events, 'h', 1), 1 / 9);
  h.quote(2200, 'h', 'Bot-A', 12, 1);
  h.source(2200, { quotes: { h: ['Bot-A', 12] } });
  near(value(h.events, 'h', 1), 1 / 9);
});
test('co-observed or recovered first return blocks price-amendment pseudo-speed', () => {
  for (const recovered of [false, true]) {
    const h = harness();
    h.start();
    h.reset(1000, 1);
    h.quote(recovered ? 1500 : 1000, 'h', 'Bot-A', 10, 1, { recovered });
    h.source(recovered ? 1500 : 1000, { quotes: { h: ['Bot-A', 10] } });
    h.quote(1900, 'h', 'Bot-A', 11, 1);
    h.source(1900, { quotes: { h: ['Bot-A', 11] } });
    near(value(h.events, 'h', 1), 0);
  }
});
test('stale snapshot book without explicit return quote is not a rebid', () => {
  const h = harness();
  h.start();
  h.reset(1000, 1);
  h.source(1500, { quotes: { h: ['Bot-A', 10] } });
  near(value(h.events, 'h', 1), 0);
  h.quote(1800, 'h', 'Bot-A', 11, 1);
  h.source(1800, { quotes: { h: ['Bot-A', 11] } });
  near(value(h.events, 'h', 1), 0);
});
test('fast returns cap at three within six qualified resets', () => {
  const h = harness();
  h.start();
  for (let epoch = 1; epoch <= 8; epoch++) {
    h.reset(epoch * 1000, epoch);
    h.quote(epoch * 1000 + 200, 'h', 'Bot-A', 10, epoch);
    h.source(epoch * 1000 + 200, { quotes: { h: ['Bot-A', 10] } });
  }
  near(value(h.events, 'h', 1), 1 / 3);
  assert.equal(feature(h.events).diagnostics.byActor['Bot-A'][3].fastReturns, 6);
});
test('gaps, pauses, ante and reversed clocks break coverage and return chains', () => {
  for (const mode of ['gap', 'pause', 'ante', 'backward', 'explicit']) {
    const h = harness();
    h.start();
    h.reset(1000, 1);
    if (mode === 'gap') {
      h.quote(4000, 'h', 'Bot-A', 10, 1);
      h.source(4000, { quotes: { h: ['Bot-A', 10] } });
    }
    if (mode === 'pause') {
      h.source(1200, { status: 'paused' });
      h.quote(1500, 'h', 'Bot-A', 10, 1);
      h.source(1500, { quotes: { h: ['Bot-A', 10] } });
    }
    if (mode === 'ante') {
      h.source(1200, { antePending: true });
      h.quote(1500, 'h', 'Bot-A', 10, 1);
      h.source(1500, { quotes: { h: ['Bot-A', 10] } });
    }
    if (mode === 'backward') {
      h.source(900);
      h.quote(1500, 'h', 'Bot-A', 10, 1);
      h.source(1500, { quotes: { h: ['Bot-A', 10] } });
    }
    if (mode === 'explicit') {
      h.add('coverage', 1200, { status: 'live', reason: 'lost connection' });
      h.quote(1500, 'h', 'Bot-A', 10, 1);
      h.source(1500, { quotes: { h: ['Bot-A', 10] } });
    }
    near(value(h.events, 'h', 1), 0, mode);
  }
});
test('missing ante state is unknown; later omissions inherit known state', () => {
  const h = harness();
  h.start();
  delete h.events[0].snapshot.antePending;
  h.source(1000, { quotes: { h: ['Bot-A', 10] } });
  delete h.events.at(-1).antePending;
  near(value(h.events), 0);
  h.source(2000, { quotes: { h: ['Bot-A', 10] } });
  near(value(h.events), 0);
  h.source(3000, { quotes: { h: ['Bot-A', 10] } });
  delete h.events.at(-1).antePending;
  near(value(h.events), 0.1 / 3);
});
test('standalone coverage barriers and backward timestamps never double-credit dwell', () => {
  for (const mode of ['gap', 'backward', 'unconfirmed-quote']) {
    const h = harness();
    h.start();
    h.source(1000, { quotes: { h: ['Bot-A', 10] } });
    near(value(h.events), 0.1 / 3);
    if (mode === 'gap') h.add('coverage', 1500, { status: 'live', reason: 'lost connection' });
    if (mode === 'backward') h.source(900, { quotes: { h: ['Bot-A', 10] } });
    if (mode === 'unconfirmed-quote') h.quote(1500, 'h', 'Bot-A', 10);
    h.source(2000, { quotes: { h: ['Bot-A', 10] } });
    near(value(h.events), 0.1 / 3, mode);
    h.source(3000, { quotes: { h: ['Bot-A', 10] } });
    near(value(h.events), 0.2 / 3, mode);
  }
});
test('same-timestamp group uses final status, and preview is nonmutating', () => {
  const h = harness();
  h.start();
  h.quote(1000);
  h.source(1000, { status: 'paused', quotes: { h: ['Bot-A', 10] } });
  near(value(h.events), 0);
  const tracker = new Tracker({ self: 'You' });
  for (const e of h.events) {
    tracker.push(e);
    tracker.features();
    tracker.features();
  }
  assert.deepEqual(tracker.features(), feature(h.events));
});
test('repeated clocks, duplicate seq and non-source predictions do not extend dwell', () => {
  const h = harness();
  h.start();
  h.add('clock', 1000, { status: 'live', timer: '59' });
  near(value(h.events), 0.1 / 3);
  for (let at = 1100; at <= 1900; at += 100) h.add('clock', at, { status: 'live', timer: '59' });
  h.add('prediction', 30000, { probabilities: [0, 0, 0, 1] });
  near(value(h.events), 0.1 / 3);
  const tracker = new Tracker({ self: 'You' }).pushAll(h.events);
  const before = tracker.features();
  tracker.pushAll(h.events);
  assert.deepEqual(tracker.features(), before);
});
test('new round clears history and hidden/source outcomes cannot affect features', () => {
  const h = harness();
  h.start();
  h.source(1000, { quotes: { h: ['Bot-A', 10] } });
  const blinded = feature(h.events);
  const poison = structuredClone(h.events);
  for (const e of poison) {
    e.goal = 'h';
    e.outcome = { winner: 'Bot-A' };
    if (e.snapshot) {
      e.snapshot.held = [0, 0, 0, 10];
      e.snapshot.training = { handsVisible: true, allHands: [[10, 0, 0, 0]] };
      e.snapshot.roundResult = { goal: 'h' };
    }
  }
  assert.deepEqual(feature(poison), blinded);
  h.add('round_start', 2000, {
    roundId: 'new',
    seq: 1,
    snapshot: {
      self: 'You',
      status: 'live',
      antePending: false,
      players: names.map((name) => ({ name })),
      trades: [],
      markets: [],
    },
  });
  assert.deepEqual(
    feature(h.events).values,
    SUITS.map(() => [0, 0]),
  );
});
test('prefix incremental, batched, and full replay agree through real journal', () => {
  const j = new J.RoundJournal('real', 'real');
  const tracker = new Tracker({ self: 'You' });
  let cursor = 0;
  const snapshot = {
    status: 'live',
    self: 'You',
    roundKey: 'round',
    antePending: false,
    timer: '60',
    held: [3, 3, 2, 2],
    net: names.map(() => [0, 0, 0, 0]),
    cash: 300,
    players: names.map((name) => ({ name, cash: 300 })),
    trades: [],
    markets: SUITS.map((id) => ({
      id,
      bid: id === 'h' ? 10 : null,
      buyer: id === 'h' ? 'Bot-A' : null,
      ask: null,
      seller: null,
    })),
    signature: 'a',
  };
  for (let i = 0; i < 8; i++) {
    const s = structuredClone(snapshot);
    s.timer = String(60 - i);
    s.signature = String(i);
    if (i >= 3) {
      s.trades = [{ suit: 'c', b: 'Bot-B', s: 'Bot-C', p: 4 }];
      s.net[1] = [0, 0, 0, 0];
      s.net[2] = [0, 1, 0, 0];
      s.net[3] = [0, -1, 0, 0];
      s.markets[3].bid = i === 3 ? null : 10;
      s.markets[3].buyer = i === 3 ? null : 'Bot-A';
    }
    j.observe(s, 100000 + i * 1000);
    tracker.pushAll(j.events.slice(cursor));
    cursor = j.events.length;
    assert.deepEqual(tracker.features(), feature(j.events));
    const one = new Tracker({ self: 'You' });
    for (const e of j.events) {
      one.push(e);
      one.features();
    }
    assert.deepEqual(one.features(), tracker.features());
  }
  near(tracker.features().values[3][1], 1 / 9);
});
const moduleHash = crypto
  .createHash('sha256')
  .update(fs.readFileSync(require.resolve('../research/candidates/bid-signals.js')))
  .digest('hex');
console.log(
  JSON.stringify(
    { version: Signals.VERSION, moduleHash, passed: results.length, tests: results },
    null,
    2,
  ),
);
