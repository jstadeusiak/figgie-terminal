const assert = require('assert/strict');
const P = require('../extension/pnl.js');
const B = require('../extension/belief.js');
function snapshot(hand = [3, 2, 2, 3], n = 4) {
  const names =
    n === 4 ? ['You', 'Bot-A', 'Bot-B', 'Bot-C'] : ['You', 'Bot-A', 'Bot-B', 'Bot-C', 'Bot-D'];
  return {
    roundKey: 'test|' + hand,
    startingHand: hand,
    held: hand.slice(),
    self: 'You',
    cash: 300,
    status: 'live',
    timer: '1:00',
    players: names.map((name) => ({ name, cash: 300 })),
    trades: [],
    context: { botDifficulty: 'Medium' },
    markets: B.IDS.map((id) => ({
      id,
      bid: null,
      ask: null,
      buyer: null,
      seller: null,
      fills: [],
    })),
  };
}
for (const s of [
  snapshot(),
  snapshot([0, 2, 4, 4]),
  snapshot([6, 1, 1, 2]),
  snapshot([2, 2, 2, 2], 5),
]) {
  const e = new B.BeliefEngine();
  const m = e.infer(s);
  const p = P.summary(s, m);
  const prob = m.bySuit.reduce((a, v) => a + v.probability, 0);
  assert(Math.abs(prob - 1) < 1e-9);
  assert(
    Math.abs(p.goalScenarios.reduce((a, v) => a + (v.weightedPnl ?? 0), 0) - p.estimatedPnl) < 1e-9,
    'weighted scenario P&L equals total expected net profit',
  );
  for (let i = 0; i < 4; i++) {
    const item = m.bySuit[i];
    if (item.probability === 0) {
      assert.equal(item.conditionalPayout, null);
      continue;
    }
    assert(item.conditionalPayout >= 10 * s.held[i] - 1e-9);
    assert(item.conditionalLeaderProbability >= 0 && item.conditionalLeaderProbability <= 1 + 1e-9);
    if (s.held[i] === 0)
      assert.equal(item.conditionalPayout, 0, 'empty goal holding cannot win a bonus');
  }
  if (s.held[0] === 6) {
    assert(
      m.bySuit[0].conditionalPayout >= 160 - 1e-8 && m.bySuit[0].conditionalPayout <= 180 + 1e-8,
    );
    assert(Math.abs(m.bySuit[0].conditionalLeaderProbability - 1) < 1e-9);
  }
}
let s = snapshot();
s.trades = [
  { suit: 's', b: 'You', s: 'Bot-A', p: 7 },
  { suit: 'c', b: 'Bot-B', s: 'You', p: 4 },
];
s.held = [4, 1, 2, 3];
const model = new B.BeliefEngine().infer(s);
const p = P.summary(s, model);
assert.equal(p.netCash, -3);
assert(p.goalScenarios.every((v) => v.pnl === v.settlement - 53));
assert(
  P.summary(s).goalScenarios.every((v) => v.pnl === null),
  'stale/unavailable estimates are dashes, never invented zeros',
);
// Cached likelihoods must match a fresh engine under the same model policy.
const options = { skipPricing: true, signalPolicy: B.DEFAULT_SIGNALS };
const engine = new B.BeliefEngine(options);
const event = {
  kind: 'take',
  actor: 'Bot-A',
  direction: 'buy',
  suit: 's',
  price: 12,
  epoch: 1,
  at: 1,
  net: [
    [1, -1, 0, 0],
    [-1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 0, 0],
  ],
  anchor: 5,
};
engine.infer(s, [event]);
const repeated = engine.infer(s, [event]);
const uncached = new B.BeliefEngine(options).infer(s, [event]);
repeated.bySuit.forEach((v, i) =>
  assert(Math.abs(v.probability - uncached.bySuit[i].probability) < 1e-12),
);
for (const changed of [
  { ...event, price: 3 },
  { ...event, anchor: 9 },
  {
    ...event,
    net: event.net.map((row, a) => row.map((v, j) => v + (a === 1 && j === 1 ? 1 : 0))),
  },
]) {
  engine.infer(s, [event]);
  const cached = engine.infer(s, [changed]);
  const fresh = new B.BeliefEngine(options).infer(s, [changed]);
  cached.bySuit.forEach((v, k) =>
    assert(Math.abs(v.probability - fresh.bySuit[k].probability) < 1e-12),
  );
  assert.equal(engine.eventLogCache.size, 1, 'cache prunes obsolete episodes');
}
console.log(
  'Scenario P&L: conditional settlement + trading cash − ante; probability-weighted reconciliation; majority bonus, zero holdings, five players, stale states, exact cached/uncached agreement passed.',
);

const med = snapshot();
const medEngine = new B.BeliefEngine({ skipPricing: true });
const trial = medEngine.infer(med, [event]);
assert.equal(trial.behavior.signals.temperature, 0.6);
assert.equal(
  medEngine.infer({ ...med, context: { botDifficulty: 'Easy' } }, [event]).behavior.signals
    .temperature,
  0.3,
);
assert(!('candidateProbabilities' in trial.behavior));
assert(!('referenceProbabilities' in trial.behavior));
const J = require('../extension/journal.js');
const j = new J.RoundJournal('active-only', 'p');
j.observe(med, 1000);
j.prediction(trial, 1100);
j.reveal({ goal: 's' }, 2000);
assert.equal(J.scoreRound(j).signalComparison, null);
assert(!('candidateProbabilities' in j.events.find((e) => e.kind === 'prediction')));
console.log(
  'Active Medium policy .60; Easy unchanged; no parallel shadow forecasts or new shadow recordings.',
);
