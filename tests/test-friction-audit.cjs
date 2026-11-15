'use strict';
const assert = require('assert/strict');
const { reconstruct, analyzeRound, spanCovered } = require('../research/audit-friction.cjs');
const snap = (at, bid, buyer = 'Other', status = 'live') => ({
  kind: 'state',
  seq: at,
  at,
  status,
  antePending: false,
  book: [
    ['s', bid, 8, buyer, 'Seller'],
    ['c', null, null, null, null],
    ['d', null, null, null, null],
    ['h', null, null, null, null],
  ],
});
const events = [
  snap(0, 2),
  snap(1000, 4, 'Me'),
  { kind: 'prediction', at: 3000, seq: 2000 },
  snap(4000, 9),
  snap(5000, 10, 'Other', 'paused'),
  snap(6000, 6),
  snap(7000, 7),
  snap(8000, 7, 'Other', 'ended'),
];
const r = reconstruct(events);
assert.equal(r.coverage.coveredSeconds, 2); // 0..1 and 6..7 only; no fill-forward across missing/paused intervals.
assert.equal(r.coverage.excludedMissingGapSeconds, 3);
assert.equal(spanCovered(r.intervals, 0, 1000), true);
assert.equal(spanCovered(r.intervals, 0, 4000), false);
const a = analyzeRound({ id: 'test', self: 'Me', revealed: { goal: 's', verified: true } }, events);
assert.equal(a.suits[0].book.bid.timeWeightedPrice, 4); // Price at 1s never leaks backwards into 0..1.
assert.equal(a.suits[0].book.spread.timeWeightedPrice, 4);
assert.equal(a.suits[0].book.ownBid.seconds, 0);
assert.equal(a.suits[1].book.bid.timeWeightedPrice, null);
assert.equal(a.suits[1].book.bid.availabilityPct, 0);
const gap = reconstruct([
  snap(0, 2),
  { kind: 'coverage', at: 1000, seq: 1, status: 'live', reason: 'Observation gap', gapSeconds: 5 },
  snap(1000, 4),
  snap(2000, 5),
]);
assert.equal(gap.coverage.coveredSeconds, 1);
const ante = reconstruct([{ ...snap(0, 2), antePending: true }, snap(1000, 4), snap(2000, 5)]);
assert.equal(ante.coverage.excludedAnteSeconds, 1);
assert.equal(ante.coverage.coveredSeconds, 1);
const sameTime = reconstruct([snap(0, 2), { ...snap(0, 3), seq: 1 }, snap(1000, 4)]);
assert.equal(sameTime.intervals[0].book[0][1], 3);
console.log(
  'friction audit: causal price weighting, missing prices, gap/paused/ante exclusions, continuity and co-observation tests passed',
);
