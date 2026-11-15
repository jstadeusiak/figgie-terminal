const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const R = require('../extension/ratings.js');
const source = fs.readFileSync('extension/ratings.js', 'utf8');
const row = (name, value) =>
  `<div style="display:flex"><div dir="auto">${name}:</div><div><div dir="auto">${value}</div></div></div>`;
const html =
  '<title>Setup</title><div id="root"><input value="Trader">' +
  row('Current Match Rating', '2,253') +
  row('Lifetime Rounds Played', '87') +
  row('Lifetime Earnings', '−101') +
  row('Total Trades Made', '982') +
  row('Lifetime Goal Suit Wins', '—') +
  '</div><div id="figgie-recordings-panel"></div>';
const dom = new JSDOM(html, { runScripts: 'outside-only' });
const w = dom.window;
const baseline = R.read(w.document, 1000);
assert.equal(baseline.rating, 2253);
assert.equal(baseline.stats.lifetimeProfit, -101);
assert.equal(baseline.stats.goalWins, undefined);
assert(R.read(w.document, Date.now()), 'real epoch milliseconds are accepted');
assert.equal(
  R.validate({ ...baseline, stats: { ...baseline.stats, totalTrades: Infinity } }),
  null,
);
assert.equal(R.validate({ ...baseline, stats: {} }), null);
assert.equal(R.validate({ ...baseline, self: '' }), null);
assert.equal(R.validate({ ...baseline, rating: '2253' }), null);
const a = { ...baseline, id: 'a' };
const b = {
  ...baseline,
  id: 'b',
  at: 3000,
  rating: 2240,
  stats: { ...baseline.stats, lifetimeRounds: 88, lifetimeProfit: -162 },
};
const round = {
  id: 'r',
  self: 'Trader',
  revealed: { verified: true, settledProfit: -61, goal: 's' },
  accounting: { endedAt: 2000 },
  snapshot: { context: { botDifficulty: 'Hard' } },
};
let interval = R.intervals([a, b], [round])[0];
assert.equal(interval.delta, -13);
assert.equal(interval.attribution, 'single-round-candidate');
assert.equal(interval.roundId, 'r');
assert.equal(R.intervals([a, b], [])[0].attribution, 'interval-only');
assert.equal(
  R.intervals([a, b], [round, { ...round, id: 'other' }])[0].attribution,
  'interval-only',
);
assert.equal(
  R.intervals([a, { ...b, stats: { ...b.stats, lifetimeProfit: -160 } }], [round])[0].attribution,
  'interval-only',
);
assert.equal(
  R.intervals([a, { ...b, stats: { ...b.stats, lifetimeRounds: 89 } }], [round])[0].attribution,
  'interval-only',
);
assert.equal(R.intervals([a, { ...b, self: 'Another' }], [round]).length, 0);
assert.equal(R.intervals([a, { ...a, id: 'dup', at: 1100 }, b], [round]).length, 1);
// Runtime makes no game DOM queries, and preserves a failed durable write for retry.
const callbacks = [];
const timers = [];
const timeouts = new Map();
let scans = 0;
let now = 10000;
let nextTimer = 0;
w.Date.now = () => now;
w.setInterval = (fn) => {
  timers.push(fn);
};
w.chrome = {
  runtime: {
    sendMessage(message, callback) {
      callbacks.push({ message, callback });
    },
  },
};
w.setTimeout = (fn) => {
  const id = ++nextTimer;
  timeouts.set(id, fn);
  return id;
};
w.clearTimeout = (id) => timeouts.delete(id);
const original = w.document.getElementById.bind(w.document);
w.document.getElementById = (...args) => {
  scans++;
  return original(...args);
};
w.eval(source);
assert.equal(callbacks.length, 1);
const id = callbacks[0].message.observation.id;
callbacks.shift().callback({ ok: false });
now += 3001;
timers[0]();
assert.equal(callbacks[0].message.observation.id, id, 'retry retains event id');
callbacks.shift().callback({ ok: true, id });
assert(original('figgie-rating-status').textContent.includes('2253 saved at 87'));
timers[0]();
assert.equal(callbacks.length, 0, 'unchanged snapshot is not re-saved');
original('root').querySelector(
  '[dir="auto"]',
).parentElement.lastElementChild.firstElementChild.textContent = '2254';
timers[0]();
const lost = callbacks.shift();
assert.equal(lost.message.observation.rating, 2254);
[...timeouts.values()][0]();
now += 3001;
timers[0]();
const retried = callbacks.shift();
assert.equal(retried.message.observation.id, lost.message.observation.id);
lost.callback({ ok: true, id: lost.message.observation.id });
assert(
  original('figgie-rating-status').textContent.includes('Saving'),
  'late ACK cannot release a retried observation',
);
retried.callback({ ok: true, id: retried.message.observation.id });
assert(original('figgie-rating-status').textContent.includes('2254 saved'));
w.document.title = 'Game';
scans = 0;
for (let i = 0; i < 60; i++) timers[0]();
assert.equal(scans, 0, 'no rating DOM work during games');
w.close();
console.log(
  'PASS ratings: observed DOM rows, missing values, bounded numeric validation, corroborated single-round attribution, ambiguous intervals, idempotent retries, no active-game DOM work.',
);
