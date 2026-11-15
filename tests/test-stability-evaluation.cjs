'use strict';
const assert = require('node:assert/strict');
const { regularGrid, volatility, scores } = require('../research/audit-stability-candidate.cjs');
// A ten-second recording outage must neither invent forecast movement nor
// dilute the movement rate, including the last good tick before the outage.
const points = [
  { at: 0, seq: 1, models: { baseline: [1, 0, 0, 0] }, coverageGap: false },
  { at: 1000, seq: 2, models: { baseline: [0, 1, 0, 0] }, coverageGap: false },
  { at: 11000, seq: 4, models: { baseline: [0, 0, 1, 0] }, coverageGap: true },
  { at: 12000, seq: 5, models: { baseline: [0, 0, 0, 1] }, coverageGap: false },
];
for (const p of [points, regularGrid(points, 1000)]) {
  const v = volatility(p, ['baseline']).baseline;
  assert.equal(v.totalVariationPp, 200);
  assert.equal(v.durationMinutes, 2 / 60);
}
// The grid carries the last available forecast, never the next observation.
const causal = regularGrid(
  [points[0], { ...points[1], at: 1500 }, { ...points[2], at: 3000, coverageGap: false }],
  1000,
);
assert.deepEqual(causal[1].models.baseline, points[0].models.baseline);
assert.deepEqual(causal[2].models.baseline, points[1].models.baseline);
// Only the two observed seconds contribute to time-weighted goal accuracy.
const scored = scores(
  points,
  [
    { seq: 3, at: 10500, kind: 'coverage', status: 'waiting' },
    { seq: 6, at: 12000, kind: 'clock', status: 'live', timer: '0:01' },
  ],
  's',
  ['baseline'],
).baseline.clockWeighted;
assert.equal(scored.seconds, 2);
assert.equal(scored.brier, 1);
assert.equal(scored.correct, 0.5);
console.log('Causal carry-forward, coverage gaps and clock-weighted scores pass');
