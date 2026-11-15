'use strict';
const assert = require('node:assert/strict');
const { equalStratum, pairedBootstrap } = require('../research/audit-simulation-scores.cjs');
const { Environment } = require('../tools/simulation/simulator.cjs');
const near = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
// Bernoulli payout: an accurate mean has lower MSE but higher MAE than the median.
const errors = (p) => ({
  mse: 0.9 * p * p + 0.1 * (100 - p) ** 2,
  mae: 0.9 * Math.abs(p) + 0.1 * Math.abs(100 - p),
});
assert(errors(10).mse < errors(0).mse);
assert(errors(10).mae > errors(0).mae);
// Quote price cancels; realized-edge error is not a distinct fill/EV measure.
for (const price of [1, 7, 30])
  for (const sign of [1, -1])
    near((sign * (12 - price) - sign * (40 - price)) ** 2, (12 - 40) ** 2);
const rows = [
  { seed: 1, stratum: { regime: 'a' }, old: 2, next: 1 },
  { seed: 2, stratum: { regime: 'a' }, old: 4, next: 3 },
  { seed: 3, stratum: { regime: 'b' }, old: 10, next: 9 },
];
near(equalStratum(rows, (r) => r.old).mean, 6.5);
assert.equal(
  pairedBootstrap(
    rows,
    (r) => r.old,
    (r) => r.next,
    100,
  ).bootstrap95,
  null,
);
const result = pairedBootstrap(
  [...rows, { seed: 4, stratum: { regime: 'b' }, old: 12, next: 11 }],
  (r) => r.old,
  (r) => r.next,
  100,
);
near(result.meanDifference, -1);
assert.deepEqual(result.bootstrap95, [-1, -1]);
assert.throws(
  () =>
    pairedBootstrap(
      [...rows, rows[0]],
      (r) => r.old,
      (r) => r.next,
    ),
  /Repeated seed/,
);
const seed = 123456789;
const env = new Environment({ seed });
for (let actor = 0; actor < 4; actor++) {
  const view = env.view(actor);
  assert(!String(view.roundKey).includes(String(seed)));
  assert(!String(view.signature).includes(String(seed)));
  assert(!('seed' in view));
  assert(!('goal' in view));
}
console.log(
  'Independent scoring audit: proper-mean loss, price cancellation, equal-stratum weighting, paired round bootstrap, duplicate-seed rejection and opaque simulation identity pass.',
);
const { resolve } = require('../research/audit-simulation-fills.cjs');
const q = {
  frame: 0,
  at: 0,
  epoch: 0,
  suit: 's',
  suitIndex: 0,
  side: 'bid',
  owner: 'You',
  price: 5,
  truth: {
    names: ['You', 'A', 'B', 'C'],
    goal: 's',
    hands: [
      [4, 0, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  },
};
const snap = (trades = [], buyer = 'You', status = 'live') => ({
  status,
  trades,
  markets: [{ bid: 5, buyer }],
});
const later = (at, snapshot, actor = 'A') => ({
  trace: [
    { step: 0, at: 0, snapshot: snap() },
    { step: 1, at, snapshot },
  ],
  actions: [{ actor }],
});
let outcome = resolve(q, later(1000, snap([{ b: 'You', s: 'A', suit: 's', p: 5 }])));
assert(outcome.filled);
near(outcome.realizedPayoff, 65);
outcome = resolve(q, later(11000, snap([{ b: 'You', s: 'A', suit: 's', p: 5 }])));
assert(!outcome.filled);
assert.equal(outcome.reason, '10-second horizon');
outcome = resolve(q, later(1000, snap([{ b: 'B', s: 'A', suit: 's', p: 5 }])));
assert(!outcome.censored);
assert.equal(outcome.reason, 'other trade reset');
outcome = resolve(q, later(1000, snap([], 'A'), 'You'));
assert(outcome.censored);
assert.equal(outcome.reason, 'own replacement/cancel');
outcome = resolve(q, later(1000, snap([], 'A'), 'A'));
assert(!outcome.censored);
assert.equal(outcome.reason, 'lost top of book');
outcome = resolve(q, later(1000, snap([], 'You', 'ended')));
assert(outcome.censored);
assert.equal(outcome.reason, 'round ended');
console.log(
  'Actual-quote observation audit: fill payoff, horizon, other reset, own amendment, outbid and end censoring pass.',
);
const { joinRounds } = require('../research/audit-simulation-scores.cjs');
const a = [
  {
    game: 'g',
    seed: 1,
    goal: 's',
    trades: 5,
    stratum: { players: 4 },
    models: { old: { overall: {} } },
  },
];
const b = [{ ...a[0], models: { next: { overall: {} } } }];
assert.equal(joinRounds(a, b, 'old', 'next').length, 1);
assert.throws(() => joinRounds(a, [...b, b[0]], 'old', 'next'), /Duplicate/);
assert.throws(
  () => joinRounds(a, [{ ...b[0], trades: 6 }], 'old', 'next'),
  /path metadata mismatch/,
);
// If reset is the target fill itself, treating it as a separate competing
// hazard double counts one event. This is a mathematical sanity check, not a
// calibrated correction for synthetic or native rates.
const rate = 0.1;
const horizon = 10;
const disjoint = 1 - Math.exp(-rate * horizon);
const doubleCounted = 0.5 * (1 - Math.exp(-2 * rate * horizon));
assert(disjoint > doubleCounted);
near(disjoint, 0.6321205588285577);
near(doubleCounted, 0.43233235838169365);
console.log('Cross-run pairing and disjoint competing-hazard sanity checks pass.');
const {
  truthValue,
  executableQuotes,
  bestScores,
} = require('../research/audit-recorded-quote-values.cjs');
const goalLabel = {
  goal: 's',
  names: ['You', 'A', 'B', 'C'],
  selfIndex: 0,
  candidates: [{ counts: [4, 4, 0, 0], bonusPool: 120 }],
};
let v = truthValue(goalLabel, { suit: 's', side: 'buy', peer: 'A' });
assert(v.identified);
near(v.total, 70);
near(v.bonus, 60);
v = truthValue(goalLabel, { suit: 's', side: 'sell', peer: 'A' });
near(v.total, 70);
assert.equal(
  truthValue(
    {
      ...goalLabel,
      candidates: [...goalLabel.candidates, { counts: [4, 3, 1, 0], bonusPool: 120 }],
    },
    { suit: 's', side: 'buy', peer: 'A' },
  ).identified,
  false,
);
assert.equal(truthValue(goalLabel, { suit: 's', side: 'buy', peer: 'B' }).identified, false);
assert.equal(truthValue(goalLabel, { suit: 'h', side: 'buy', peer: 'A' }).total, 0);
assert.equal(
  executableQuotes({
    self: 'You',
    players: [{ name: 'You' }, { name: 'A' }],
    markets: [{ id: 's', canBuy: true, ask: 5, seller: 'A', canSell: false, bid: 6, buyer: 'A' }],
  }).length,
  1,
);
const selected = bestScores(
  [
    {
      quotes: [
        {
          roundId: 'g',
          side: 'buy',
          price: 1,
          truth: { identified: false },
          predictions: { m: { edge: 10 } },
        },
        {
          roundId: 'g',
          side: 'buy',
          price: 1,
          truth: { identified: true, total: 3 },
          predictions: { m: { edge: 5 } },
        },
      ],
    },
  ],
  'm',
);
assert.equal(selected.positiveSelections, 1);
assert.equal(selected.identified, 0);
assert.equal(selected.unidentified, 1);
console.log(
  'Offline recorded-transfer labels: exact bonus swing, ambiguity/illegality exclusion, DOM actionability, and no truth-based best-quote selection pass.',
);
