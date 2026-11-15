'use strict';
const assert = require('node:assert/strict');
const A = require('../research/audit-bid-signals.cjs');
const F = require('../research/fit-bid-signals.cjs');
assert.deepEqual(A.canonicalProbabilities([0, 0, 0, 1 + 6e-15]), [0, 0, 0, 1]);
assert.throws(() => A.canonicalProbabilities([-0.01, 0.2, 0.3, 0.51]), /Invalid/);
assert.throws(() => A.metric([-0.1, 0.5, 0.3, 0.3], 's'), /Invalid/);
const p = [0.1, 0.2, 0.3, 0.4];
const x = [
  [1, 0.5],
  [0, 0],
  [0.3, 0.2],
  [0.1, 0.5],
];
assert.deepEqual(F.tilt(p, x, [0.4, 0.2], 0), p);
assert.deepEqual(F.tilt(p, x, [0, 0], 1), p);
assert.equal(F.tilt([0, 0.2, 0.3, 0.5], x, [0.5, 0.5])[0], 0);
assert.deepEqual(
  F.tilt(
    p,
    Array.from({ length: 4 }, () => [0.2, 0.2]),
    [0.5, 0.5],
  ),
  p,
);
assert.throws(
  () =>
    F.centered([
      [2, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
  /bounded/,
);
const round = (id, n, values, goal = 's') => ({
  id,
  players: 4,
  difficulty: 'Medium',
  goal,
  points: Array.from({ length: n }, (_, seq) => ({
    seq,
    probabilities: [0.25, 0.25, 0.25, 0.25],
    values,
  })),
});
const rows = [
  round('a', 1, [
    [0.8, 0.5],
    [0, 0.1],
    [0.1, 0.1],
    [0, 0],
  ]),
  round('b', 7, [
    [0.5, 0.6],
    [0.3, 0.1],
    [0, 0.2],
    [0.1, 0],
  ]),
];
const beta = [0.2, 0.1];
const state = F.objective(rows, beta);
const eps = 1e-6;
for (let k = 0; k < 2; k++) {
  const a = beta.slice();
  const b = beta.slice();
  a[k] += eps;
  b[k] -= eps;
  assert(
    Math.abs(
      (F.objective(rows, a).loss - F.objective(rows, b).loss) / (2 * eps) - state.gradient[k],
    ) < 1e-7,
  );
}
const repeated = rows.map((r) => ({ ...r, points: [...r.points, ...r.points, ...r.points] }));
assert(Math.abs(F.objective(rows, beta).loss - F.objective(repeated, beta).loss) < 1e-12);
assert.deepEqual(F.fit(rows), F.fit(rows));
assert(F.fit(rows).beta.every((b) => b >= 0 && b <= 0.5));
assert(F.fit(rows).objective <= F.objective(rows, [0, 0]).loss);
const easy = { ...rows[0], difficulty: 'Easy' };
assert.deepEqual(F.score([easy], [0.5, 0.5], 1), F.score([easy], [0.5, 0.5], 0));
const scopeSource = {
  id: 'scope',
  events: [{ seq: 1 }],
  metadata: { snapshot: { players: [1, 2, 3, 4], context: { botDifficulty: 'Medium' } } },
};
assert.throws(
  () =>
    F.assertPrefixScope(
      scopeSource,
      { seq: 2 },
      { replay: () => ({ players: [1, 2, 3, 4], context: { botDifficulty: 'Hard' } }) },
    ),
  /scope differs/,
);
const base = F.score(rows, [0, 0], 0);
const candidate = F.score(rows, [0.2, 0.1], 1);
assert(F.pairedAudit(base, candidate).metrics.brier.difference < 0);
console.log(
  'Bid-signal fit tests passed: proper equal-round weighting, roundoff/structural zeros, identity, scope, analytic gradient, bounded deterministic fit and paired audit.',
);
