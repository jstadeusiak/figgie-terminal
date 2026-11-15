'use strict';
const assert = require('node:assert/strict');
const B = require('../extension/belief.js');
const { Belief: V11 } = require('../tools/model-registry.cjs').load('0.11.0');
const A = require('../research/audit-sim-structure.cjs');
const close = (a, b, tolerance = 1e-9) => assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const sum = (a) => a.reduce((a, b) => a + b, 0);
const states = [
  A.frame([3, 3, 2, 2]),
  A.frame(
    [2, 2, 2, 4],
    [
      [2, 1, 3],
      [3, 1, 3],
    ],
    0,
    'Medium',
  ),
];
// Production can remain on0.11 while the immutable0.12 release is tested in a
// separate staging tree. Version0.12 must actually enable the selected defaults.
if (B.VERSION === '0.12.0') {
  const defaults = new B.BeliefEngine({ skipPricing: true });
  assert.equal(defaults.goalStratified, true);
  assert.equal(defaults.referenceEss, true);
  assert.equal(defaults.samples, 512);
  assert.equal(defaults.knowledge.samples, 12);
  for (const snapshot of states) {
    const explicit = new B.BeliefEngine({
      skipPricing: true,
      goalStratified: true,
      referenceEss: true,
      samples: 512,
      opponentSamples: 12,
    }).infer(snapshot);
    assert.deepEqual(
      defaults.infer(snapshot).bySuit,
      explicit.bySuit,
      '0.12 defaults must equal the selected explicit candidate',
    );
  }
}
const elapsed = [];
for (const snapshot of states) {
  const before = new V11.BeliefEngine({ skipPricing: true }).infer(snapshot);
  const unchanged = new B.BeliefEngine({
    skipPricing: true,
    goalStratified: false,
    referenceEss: false,
    goalCalibration: false,
  }).infer(snapshot);
  assert.equal(
    JSON.stringify(unchanged.bySuit),
    JSON.stringify(before.bySuit),
    'explicit legacy sampling retains archived0.11 predictions',
  );
  for (const samples of [128, 512]) {
    const engine = new B.BeliefEngine({
      goalStratified: true,
      referenceEss: false,
      skipPricing: true,
      samples,
    });
    const model = engine.infer(snapshot, [], { forceBaseline: true });
    const exact = A.exactPhysical(engine);
    elapsed.push({ samples, ms: model.computeMs });
    close(model.expectedPayout, exact.expectedPayout);
    for (let s = 0; s < 4; s++) {
      close(model.bySuit[s].conditionalBonus, exact.bySuit[s].conditionalBonus);
      close(model.baseline.probabilities[s], before.baseline.probabilities[s]);
      for (let a = 1; a < 4; a++)
        close(
          model.bySuit[s].counterparties[snapshot.players[a].name].sell,
          exact.bySuit[s].sell[a],
        );
    }
    const grouped = new Map();
    for (const world of engine.pool.worlds) {
      assert(world.base > 0);
      assert.equal(world.initial[0].join(','), snapshot.startingHand.join(','));
      world.initial.forEach((hand, a) => {
        assert.equal(sum(hand), 10);
        hand.forEach((v, s) => assert(v >= engine.state.minimum[a][s]));
      });
      const deck = [0, 1, 2, 3].map((s) => sum(world.initial.map((r) => r[s])));
      const key = deck.join(',');
      assert.deepEqual(
        deck.slice().sort((a, b) => a - b),
        [8, 10, 10, 12],
      );
      assert.equal(world.goal, deck.indexOf(12) ^ 1);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(world);
    }
    for (const config of engine.pool.configurations) {
      const worlds = grouped.get(config.deck.join(','));
      assert.equal(worlds.length, samples, 'four-player world budget is unchanged');
      close(sum(worlds.map((w) => w.base)), config.probability);
      const strata = new Map();
      for (const w of worlds) {
        const key = w.initial.map((r) => r[w.goal]).join(',');
        strata.set(key, (strata.get(key) || 0) + w.base);
      }
      const exactRows = A.marginal(config, engine.state, config.goal);
      assert.equal(strata.size, exactRows.length, 'all feasible goal allocations retain support');
      for (const row of exactRows)
        close(strata.get(row.counts.join(',')), config.probability * row.probability);
    }
    const calibrated = engine.infer(snapshot);
    const fit = calibrated.inventoryCalibration;
    if (fit.active) {
      const intended = A.exactCalibratedBonus(
        engine,
        fit.strength,
        fit.goals.map((r) => r.calibrationBlend),
      );
      calibrated.bySuit.forEach((s, i) => close(s.conditionalBonus, intended[i]));
      fit.goals.forEach((g) => {
        close(g.probability, calibrated.bySuit['scdh'.indexOf(g.suit)].probability);
        assert(g.effectiveAfter >= Math.min(64, g.effectiveBefore) - 1e-8);
      });
    }
    const replay = new B.BeliefEngine({
      goalStratified: true,
      referenceEss: false,
      skipPricing: true,
      samples,
    }).infer(snapshot);
    assert.deepEqual(calibrated.bySuit, replay.bySuit, 'candidate replay is deterministic');
  }
}
// Public live asks establish each peer has at least one card. With the buy
// availability denominator fixed to one, physical one-card buy values are exact.
const askState = A.frame([3, 3, 2, 2]);
const asks = askState.players.slice(1).flatMap((p) =>
  'scdh'.split('').map((suit) => ({
    kind: 'quote',
    actor: p.name,
    suit,
    direction: 'sell',
    price: 7,
    epoch: 0,
    net: askState.net,
    at: 100,
    sourceSeq: 1,
  })),
);
const asking = new B.BeliefEngine({ goalStratified: true, referenceEss: false, skipPricing: true });
const asked = asking.infer(askState, asks, { forceBaseline: true });
const askExact = A.exactPhysical(asking);
asked.bySuit.forEach((s, i) =>
  askState.players.slice(1).forEach((p, j) => {
    close(s.counterparties[p.name].hasCardProbability, 1);
    close(s.counterparties[p.name].buy, askExact.bySuit[i].buy[j + 1]);
  }),
);
// Five-player defaults still fit every goal-count stratum into the existing
// 384-world-per-deck budget and preserve every physical constraint.
const five = A.frame([2, 2, 2, 2]);
five.players.push({ name: 'Bot-D', cash: 350 });
five.net.push([0, 0, 0, 0]);
const fiveEngine = new B.BeliefEngine({
  goalStratified: true,
  referenceEss: false,
  skipPricing: true,
});
const fiveModel = fiveEngine.infer(five, [], { forceBaseline: true });
assert.equal(fiveModel.stateCount, fiveEngine.pool.configurations.length * 384);
fiveModel.baseline.probabilities.forEach((p) => close(p, 0.25));
fiveEngine.pool.worlds.forEach((w) => w.initial.forEach((hand) => assert.equal(sum(hand), 8)));
// Independently integrate p², q² and pq under the original proposal: N equal
// draws per legal deck. This is not the unequal stratified-world ESS formula.
function exactReferenceMoments(engine, samples, strength) {
  const rows = [[], [], [], []];
  for (const c of engine.pool.configurations)
    for (const r of A.marginal(c, engine.state, c.goal)) {
      const score =
        strength *
        sum(r.counts.slice(1).map((v, a) => v * Math.max(0, engine.state.net[a + 1][c.goal])));
      rows[c.goal].push({
        mass: c.probability * r.probability,
        second: (c.probability ** 2 * r.probability) / samples,
        score,
      });
    }
  return rows.map((list) => {
    const mass = sum(list.map((r) => r.mass));
    const maximum = Math.max(...list.map((r) => r.score));
    const z = sum(list.map((r) => r.mass * Math.exp(r.score - maximum)));
    const p2 = sum(list.map((r) => r.second / mass ** 2));
    const q2 = sum(list.map((r) => (r.second * Math.exp(2 * (r.score - maximum))) / z ** 2));
    const pq = sum(list.map((r) => (r.second * Math.exp(r.score - maximum)) / (mass * z)));
    const target = Math.min(64, 1 / p2);
    const a = q2 + p2 - 2 * pq;
    const b = 2 * (pq - p2);
    const c = p2 - 1 / target;
    const blend =
      1 / q2 >= target
        ? 1
        : Math.max(0, Math.min(1, (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)));
    return {
      p2,
      q2,
      pq,
      blend,
      after2: (1 - blend) ** 2 * p2 + blend ** 2 * q2 + 2 * blend * (1 - blend) * pq,
    };
  });
}
for (const samples of [128, 512]) {
  const s = states[1];
  const engine = new B.BeliefEngine({
    goalStratified: true,
    referenceEss: true,
    samples,
    skipPricing: true,
  });
  const model = engine.infer(s);
  const moments = exactReferenceMoments(engine, samples, 0.8);
  model.inventoryCalibration.goals.forEach((g, i) => {
    close(g.effectiveBefore, 1 / moments[i].p2, 1e-7);
    close(g.effectiveAfter, 1 / moments[i].after2, 1e-7);
    close(g.calibrationBlend, moments[i].blend);
  });
  if (samples === 128)
    assert(model.inventoryCalibration.goals[3].calibrationBlend < 1, 'binding guard is exercised');
  const plain = new B.BeliefEngine({
    goalStratified: true,
    referenceEss: false,
    samples,
    skipPricing: true,
  }).infer(s);
  close(sum(model.bySuit.map((s) => s.probability)), 1);
  model.bySuit.forEach((s, i) => close(s.probability, plain.bySuit[i].probability));
}
console.log(
  JSON.stringify(
    {
      version: B.VERSION,
      promotedDefaults:
        B.VERSION === '0.12.0'
          ? 'selected flags and512/12 budgets verified'
          : 'promotion assertion reserved for0.12 staging',
      legacyCompatibility: 'explicit flags are bit-identical to archived0.11',
      mass: 'exact goal-allocation support and weights',
      budget: '512/deck four-player and384/deck five-player',
      physicalPayout: 'exact bonus and sell values; exact buy when availability is known',
      inventoryCalibration: 'exact .8 tilt at actual ESS guard blend; goal masses unchanged',
      referenceEss: 'p², q², pq and binding guard match independent original-proposal enumeration',
      replay: 'deterministic',
      elapsed,
    },
    null,
    2,
  ),
);
