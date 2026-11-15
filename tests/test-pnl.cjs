const assert = require('node:assert/strict');
const P = require('../extension/pnl.js');
const base = {
  roundKey: 'test|1',
  self: 'You',
  players: [{ name: 'You' }, { name: 'A' }, { name: 'B' }, { name: 'C' }],
  status: 'live',
  timer: '0:01',
  cash: 300,
  held: [3, 2, 3, 2],
  startingHand: [3, 2, 3, 2],
  trades: [],
};
let a = P.observe({}, { ...base, cash: 312, antePending: true }, 0);
assert.equal(a.bankCandidate, undefined, 'ante animation is excluded');
P.observe(a, base, 1000);
P.observe(a, base, 2100);
assert.equal(a.openingBank, 350);
let s = {
  ...base,
  cash: 220,
  held: [5, 2, 3, 2],
  trades: [
    { b: 'You', s: 'A', suit: 's', p: 80 },
    { b: 'B', s: 'You', suit: 'c', p: 10 },
    { b: 'You', s: 'A', suit: 's', p: 10 },
  ],
};
let p = P.summary(s, { expectedPayout: 150 }, a);
assert.equal(p.netCash, -80);
assert.equal(p.ante, 50);
assert.equal(p.estimatedPnl, 20);
assert.equal(p.spent, 90);
assert.equal(p.received, 10);
let ended = { ...s, status: 'ended', cash: 370 };
P.observe(a, ended, 3000);
assert.equal(P.summary(ended, null, a).actualPnl, null, 'wait for settled bank');
P.observe(a, { ...ended, cash: 390 }, 4000);
P.observe(a, ended, 5000);
P.observe(a, ended, 7000);
p = P.summary(ended, null, a);
assert.equal(p.actualPnl, 20);
assert.equal(p.actualPayout, 150);
// Winning the most goal cards can still lose money after purchase costs + ante.
let costly = {
  ...base,
  status: 'ended',
  held: [5, 2, 3, 2],
  trades: [{ b: 'You', s: 'A', suit: 's', p: 130 }],
};
let result = {
  goal: 's',
  finalHands: { You: [5, 2, 3, 2], A: [2, 2, 2, 2], B: [2, 2, 2, 2], C: [1, 2, 2, 2] },
};
p = P.summary(costly, null, {}, result);
assert.equal(p.actualPayout, 150);
assert.equal(p.actualPnl, -30);
const tie = { ...base, status: 'ended', held: [3, 2, 3, 2] };
const tied = {
  goal: 's',
  finalHands: { You: [3, 0, 0, 0], A: [3, 0, 0, 0], B: [1, 0, 0, 0], C: [1, 0, 0, 0] },
};
assert.equal(
  P.summary(tie, null, {}, tied).actualPnl,
  40,
  '8 goal cards: 30 base + 60 split bonus − 50 ante',
);
const five = { ...base, players: [...base.players, { name: 'D' }] };
assert.equal(P.summary(five, { expectedPayout: 40 }).estimatedPnl, 0, 'five-player ante is 40');
assert.equal(
  P.summary(
    {
      ...ended,
      roundResult: {
        verified: true,
        source: 'official-round-rankings',
        settledProfit: 20,
        settledBank: 370,
      },
    },
    null,
    {},
  ).actualPnl,
  20,
  'official result is exact without a live anchor',
);
assert.equal(
  P.summary({ ...ended, cash: 600 }, null, { ...a, endCash: 600 }).actualPnl,
  null,
  'unreconciled bank cannot become final P&L',
);
// Reconstruct settlement from a synthetic exported event stream.
const trade = { b: 'You', s: 'A', suit: 's', p: 21 };
const snapshot = {
  ...base,
  status: 'ended',
  timer: '0:00',
  cash: 319,
  held: [4, 2, 3, 2],
  trades: [trade],
};
const events = [
  { kind: 'round_start', at: 1000, snapshot: base },
  { kind: 'clock', at: 2100, status: 'live', timer: '3:59' },
  { kind: 'fill', at: 2200, index: 0, trade },
  { kind: 'state', at: 2200, status: 'live', timer: '3:58', cash: 279, held: [4, 2, 3, 2] },
  { kind: 'state', at: 3000, status: 'ended', timer: '0:00', cash: 319, held: [4, 2, 3, 2] },
  { kind: 'clock', at: 6500, status: 'ended', timer: '0:00' },
];
const before = JSON.stringify(events);
const restored = P.restore(events, snapshot, 6500);
const historic = P.summary(snapshot, null, restored);
assert.equal(restored.openingBank, 350);
assert.equal(historic.actualPnl, -31);
assert.equal(historic.actualPayout, 40);
assert.equal(JSON.stringify(events), before, 'restoring accounting never changes source events');
console.log(
  JSON.stringify(
    {
      anteAnimation: 'ignored',
      cashFlow: 'reconciled',
      ante: '4 and 5 players',
      winnerOverpay: 'loss preserved',
      bonusTie: 'split correctly',
      settlement: 'waits for stable bank',
      recordingRestore: 'synthetic settled loss and payout preserved',
    },
    null,
    2,
  ),
);
