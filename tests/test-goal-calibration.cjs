'use strict';
// Production-default regression against the immutable 0.12 world distribution.
// Uses synthetic public fixtures only; never opens recorded validation/test metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const Registry = require('../tools/model-registry.cjs');
const { loadCurrent } = require('../research/compare-recorded-candidate.cjs');
const { frame } = require('../research/audit-sim-structure.cjs');
const old = Registry.load('0.12.0');
const current = loadCurrent();
const G = require('../extension/goal-signal.js');
const A = require('../research/audit-pp-weight.cjs');
const copy = (x) => JSON.parse(JSON.stringify(x));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const close = (a, b, epsilon = 1e-9) => assert(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
function same(a, b, epsilon = 1e-9) {
  if (typeof a === 'number' && typeof b === 'number') {
    close(a, b, epsilon);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    assert.equal(a, b);
    return;
  }
  assert.deepEqual(Object.keys(a), Object.keys(b));
  for (const k of Object.keys(a)) same(a[k], b[k], epsilon);
}
function comparable(model) {
  const v = copy(model);
  delete v.version;
  delete v.computeMs;
  delete v.behavior.goalCalibration;
  delete v.behavior.validation;
  return v;
}
function run(release, options = {}, snapshot = s, e = events, l = learning) {
  const engine = new release.Belief.BeliefEngine(options);
  return { engine, model: engine.infer(snapshot, e, l) };
}
const s = frame(
  [2, 2, 3, 3],
  [
    [1, 2, 3],
    [3, 1, 2],
  ],
  0,
  'Medium',
);
s.markets[0].buyer = 'You';
s.markets[3].seller = 'You';
s.markets.forEach((m) => {
  m.canBuy = true;
  m.canSell = true;
});
const events = s.players.slice(1).flatMap((p, i) => [
  {
    kind: 'quote',
    actor: p.name,
    suit: 'h',
    direction: 'buy',
    price: 12 + i,
    epoch: 2,
    net: copy(s.net),
    at: 1000 + i,
    sourceSeq: 100 + i,
  },
  {
    kind: 'quote',
    actor: p.name,
    suit: 's',
    direction: 'sell',
    price: 2 + i,
    epoch: 2,
    net: copy(s.net),
    at: 1100 + i,
    sourceSeq: 110 + i,
  },
]);
const learning = {
  rates: {
    bid: { fills: 4, exposure: 90, outbids: 7 },
    ask: { fills: 2, exposure: 70, outbids: 5 },
    resets: 8,
    liveSeconds: 150,
  },
};
assert.equal(current.Belief.VERSION, '0.13.3');
assert(current.hashes['goal-signal.js'], 'production loader resolves its runtime dependency');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');
assert(
  background.indexOf("'goal-signal.js'") < background.indexOf("'belief.js'"),
  'worker imports goal helper before model',
);
const baseline = run(old);
const production = run(current);
const optout = run(current, { goalCalibration: false });
const policy = production.model.behavior.goalCalibration;
assert.equal(policy.kind, 'likelihood-power');
assert.equal(policy.strength, 16);
assert.equal(policy.players, 4);
assert.equal(policy.active, true);
assert.equal(policy.blend, 0.55);
assert.equal(policy.prospectivelyValidated, false);
assert.equal(
  production.model.behavior.validation.goalCalibration.strength,
  16,
  'automatic group fit selected',
);
assert.deepEqual(
  comparable(optout.model),
  comparable(baseline.model),
  'false option is bit-equivalent to archived baseline, excluding version/fit metadata',
);
const target = G.targetProbabilities(
  Array.from(baseline.model.baseline.probabilities),
  Array.from(baseline.model.behavior.probabilities),
  { kind: 'likelihood-power', strength: 16 },
  0.55,
);
const weights = G.reweight(
  Array.from(baseline.engine.latest.worlds),
  baseline.engine.latest.weights,
  target,
);
assert(
  Math.max(...target.map((p, g) => Math.abs(p - baseline.model.bySuit[g].probability))) > 0.01,
  'fixture exercises a material posterior change',
);
same(
  production.model.bySuit.map((v) => v.probability),
  target,
);
same(production.model.scoringProbabilities, target);
same(
  production.model.scoringProbabilities,
  production.model.bySuit.map((v) => v.probability),
);
weights.forEach((w, i) => close(production.engine.latest.weights[i], w, 1e-14));
const H = A.ownership(baseline.engine, baseline.model);
const fast = A.revalue(baseline.model, s, H, baseline.engine.latest.names, target);
same(production.model.bySuit, fast.bySuit);
close(production.model.expectedPayout, fast.expectedPayout);
close(production.model.expectedBonus, fast.expectedBonus);
const names = baseline.engine.latest.names;
const net = baseline.engine.state.net;
const payout = (counts, bonus) => {
  const max = Math.max(...counts);
  const ties = counts.filter((v) => v === max).length;
  return 10 * counts[0] + (counts[0] === max ? bonus / ties : 0);
};
const direct = {
  holding: [0, 0, 0, 0],
  total: 0,
  base: 0,
  peers: names.map(() =>
    Array.from({ length: 4 }, () => ({ mass: 0, buyValue: 0, buyBase: 0, sell: 0 })),
  ),
};
for (let i = 0; i < baseline.engine.latest.worlds.length; i++) {
  const w = baseline.engine.latest.worlds[i];
  const g = w.goal;
  const weight = weights[i];
  const counts = w.initial.map((r, a) => r[g] + net[a][g]);
  const before = payout(counts, w.bonus);
  direct.total += weight * before;
  direct.base += weight * 10 * counts[0];
  direct.holding[g] += weight * before;
  for (let a = 1; a < names.length; a++)
    for (let suit = 0; suit < 4; suit++) {
      const v = direct.peers[a][suit];
      if (w.initial[a][suit] + net[a][suit] > 0) {
        v.mass += weight;
        if (g === suit) {
          const after = counts.slice();
          after[0]++;
          after[a]--;
          v.buyValue += weight * (payout(after, w.bonus) - before);
          v.buyBase += weight * 10;
        }
      }
      if (s.held[suit] > 0 && g === suit) {
        const after = counts.slice();
        after[0]--;
        after[a]++;
        v.sell += weight * (before - payout(after, w.bonus));
      }
    }
}
let directChecks = 2;
close(production.model.expectedPayout, direct.total);
close(production.model.expectedBase, direct.base);
for (let g = 0; g < 4; g++) {
  const before = baseline.model.bySuit[g];
  const after = production.model.bySuit[g];
  close(after.holding, direct.holding[g]);
  close(after.base, 10 * target[g]);
  directChecks++;
  for (const key of [
    'conditionalPayout',
    'conditionalBonus',
    'conditionalLeaderProbability',
    'conditionalSoloProbability',
    'conditionalTieProbability',
    'conditionalNoBonusProbability',
    'conditionalPayoutFloor',
  ])
    close(after[key], before[key]);
  close(production.model.inventoryCalibration.goals[g].probability, after.probability);
  for (let a = 1; a < names.length; a++) {
    const p = after.counterparties[names[a]];
    const v = direct.peers[a][g];
    close(p.hasCardProbability, v.mass);
    close(p.sell, v.sell);
    directChecks += 2;
    if (v.mass) {
      close(p.buy, v.buyValue / v.mass);
      close(p.buyBase, v.buyBase / v.mass);
      directChecks += 2;
    } else assert.equal(p.buy, null);
  }
}
close(
  production.model.expectedBonus,
  production.model.expectedPayout - production.model.expectedBase,
);
// Full resting/fill values must consume the reweighted worlds, not merely the UI odds.
const resting = baseline.engine.resting(
  s,
  baseline.engine.latest.worlds,
  weights,
  baseline.engine.latest.stylesByWorld,
  learning,
);
const actual = baseline.engine.resting(
  s,
  baseline.engine.latest.worlds,
  weights,
  baseline.engine.latest.stylesByWorld,
  learning,
  true,
);
same(production.model.resting, resting);
same(production.model.actualBook, actual);
assert(production.model.actualBook.s.bid);
assert(production.model.actualBook.h.ask);
for (const quote of Object.values(production.model.resting).flatMap(Object.values)) {
  close(quote.ev, quote.pFill * quote.conditionalEdge);
  assert(quote.pFill >= 0 && quote.pFill <= 1);
  close(quote.conditionalEdge, quote.conditionalBaseEdge + quote.conditionalBonusEdge);
  close(sum(quote.counterparties.map((p) => p.probability)), 1);
}
const forced = { ...learning, forceBaseline: true };
const forceOld = run(old, {}, s, events, forced);
const forceNew = run(current, {}, s, events, forced);
assert.deepEqual(copy(forceNew.model.bySuit), copy(forceOld.model.bySuit));
assert.deepEqual(copy(forceNew.model.resting), copy(forceOld.model.resting));
assert.deepEqual(copy(forceNew.model.actualBook), copy(forceOld.model.actualBook));
assert.equal(forceNew.model.behavior.goalCalibration.active, false);
same(forceNew.model.scoringProbabilities, production.model.scoringProbabilities);
const quality = {
  ...learning,
  groupMetrics: { 'bots:Medium': { rounds: 12, opponentBrier: 0.9, baselineBrier: 0.6 } },
};
const guardOld = run(old, {}, s, events, quality);
const guardNew = run(current, {}, s, events, quality);
assert.deepEqual(comparable(guardNew.model), comparable(guardOld.model));
assert.equal(guardNew.model.behavior.goalCalibration.reason, 'quality guard');
const five = frame([2, 2, 2, 2], [], 0, 'Medium');
five.players.push({ name: 'Bot-D', cash: 350 });
five.net.push([0, 0, 0, 0]);
const human = frame([3, 2, 2, 3], [], 0, 'Medium');
const oldName = human.players[1].name;
human.players[1].name = 'Human';
for (const m of human.markets)
  for (const key of ['buyer', 'seller']) if (m[key] === oldName) m[key] = 'Human';
for (const sample of [
  five,
  { ...s, context: { botDifficulty: 'Easy' } },
  { ...s, context: { botDifficulty: 'Hard' } },
  human,
]) {
  const a = run(old, {}, sample, []).model;
  const b = run(current, {}, sample, []).model;
  assert.deepEqual(comparable(b), comparable(a), 'other contexts retain exact archived pricing');
  assert.notEqual(b.behavior.goalCalibration?.active, true);
}
const opening = frame([3, 2, 2, 3], [], 0, 'Medium');
same(
  comparable(run(current, {}, opening, []).model),
  comparable(run(old, {}, opening, []).model),
  1e-8,
);
const journal = new current.Journal.RoundJournal('calibration-test', 'calibration-test');
journal.observe(s, 1000);
journal.prediction(production.model, 2000);
const saved = journal.events.find((e) => e.kind === 'prediction');
assert(saved);
assert.equal(saved.goalCalibration.strength, 16);
assert.equal(saved.goalCalibration.active, true);
assert.equal(saved.modelVersion, '0.13.3');
same(
  saved.probabilities,
  production.model.bySuit.map((v) => v.probability),
);
assert.deepEqual(copy(saved.goalCalibration), copy(policy));
Registry.verify('0.12.0');
console.log(
  JSON.stringify(
    {
      version: current.Belief.VERSION,
      defaultFit: 'automatic Medium4p LR16',
      directWorldChecks: directChecks,
      fastRevalue: 'matches direct production valuation',
      conditionalBonus: 'unchanged',
      scoring: 'same as calibrated displayed odds',
      restingAndActualBook: 'match independently reweighted archived engine',
      optOut: 'bit-equivalent to archived0.12 excluding metadata',
      forceBaseline: 'display and full pricing unchanged',
      qualityGuard: 'retained',
      otherContexts: 'Easy/Hard/humans/5p unchanged',
      journal: 'strength16 and calibrated probabilities recorded',
      dependency: 'production loader and worker import verified',
      archive: 'unchanged',
    },
    null,
    2,
  ),
);
