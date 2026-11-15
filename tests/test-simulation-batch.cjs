'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createManifest,
  runBatch,
  combineRound,
  combinedReport,
  observeMetrics,
} = require('../tools/simulation/batch.cjs');
const { Environment, SUITS, runRound } = require('../tools/simulation/simulator.cjs');
const Registry = require('../tools/model-registry.cjs');
const { loadEngine } = require('../tools/simulation/evaluate.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgie-batch-test-'));
try {
  const m = createManifest(dir);
  assert.equal(m.games.length, 1200);
  assert.equal(new Set(m.games.map((g) => g.seed)).size, 1200);
  for (const [partition, count] of Object.entries({ train: 600, validation: 200, test: 400 })) {
    const games = m.games.filter((g) => g.partition === partition);
    assert.equal(games.length, count);
    const strata = {};
    for (const g of games) {
      const key = [g.players, g.heterogeneous, g.name].join('|');
      strata[key] = (strata[key] || 0) + 1;
    }
    assert.equal(Object.keys(strata).length, 12);
    assert(Math.max(...Object.values(strata)) - Math.min(...Object.values(strata)) <= 1);
  }
  assert(m.games.every((g) => g.seed < 910001 || g.seed > 910030));
  assert.deepEqual(createManifest(dir), m);
  assert.throws(() => runBatch({ out: dir, partition: 'test', limit: 1 }), /Test remains closed/);
  const group = { errors: {}, values: {} };
  combineRound(group, {
    errors: { value: { observations: 1, predicted: 10, actual: 0, bias: 10, mse: 100, mae: 10 } },
    values: {},
  });
  combineRound(group, {
    errors: { value: { observations: 100, predicted: 0, actual: 0, bias: 0, mse: 0, mae: 0 } },
    values: {},
  });
  const result = combinedReport(group).errors.value;
  assert.equal(result.rounds, 2);
  assert.equal(result.observations, 101);
  assert.equal(result.mse, 50);
  assert.equal(result.rmse, Math.sqrt(50));
  const env = new Environment({ seed: 600001 });
  const truth = env.truth();
  const s = truth.hands[1].findIndex((v) => v > 0);
  env.act(1, { kind: 'quote', suit: SUITS[s], side: 'ask', price: 2 });
  const snapshot = env.view();
  const goal = SUITS.indexOf(truth.goal);
  const bySuit = SUITS.map((_, i) => ({
    probability: Number(i === goal),
    conditionalBonus: 0,
    conditionalLeaderProbability: 0,
    counterparties: Object.fromEntries(
      truth.names.slice(1).map((name) => [name, { buy: 20, sell: 10, buyBase: 3, sellBase: 3 }]),
    ),
  }));
  const groups = {};
  const point = observeMetrics(
    { bySuit, expectedPayout: 0, expectedBonus: 0, computeMs: 1 },
    {},
    snapshot,
    truth,
    ['overall'],
    groups,
  );
  assert.equal(point.best.direction, 'buy');
  assert.equal(point.best.edge, 18);
  assert.equal(point.best.baseEdge, 1);
  assert.equal(point.best.bonusEdge, 17);
  assert.equal(groups.overall.errors.bestEdge.n, 1);
  assert.equal(groups.overall.values.positiveBestBonusEdgeFraction.sum, 17 / 18);
  const release = Registry.load('0.11.0');
  const current = loadEngine('belief.js', 'model-fit.js');
  for (const [Belief, extra] of [
    [release.Belief, {}],
    [current, { goalStratified: true }],
    [current, { goalStratified: true, referenceEss: true }],
  ]) {
    const opts = { samples: 32, skipPricing: true, ...extra };
    const shared = new Belief.BeliefEngine(opts);
    const separate = Object.fromEntries(
      ['Simulated', 'Medium'].map((c) => [c, new Belief.BeliefEngine(opts)]),
    );
    const journal = new release.Journal.RoundJournal('reuse', 'reuse');
    const projection = (m) =>
      JSON.parse(
        JSON.stringify({
          bySuit: m.bySuit,
          expectedPayout: m.expectedPayout,
          expectedBonus: m.expectedBonus,
          styles: m.behavior.styles,
        }),
      );
    runRound({
      seed: 600013,
      steps: 120,
      onSnapshot(snapshot, truth, frame) {
        journal.observe(snapshot, frame.at);
        if (![0, 60, 120].includes(frame.step)) return;
        for (const context of ['Simulated', 'Medium']) {
          const input = { ...snapshot, context: { ...snapshot.context, botDifficulty: context } };
          assert.deepEqual(
            projection(shared.infer(input, journal.evidence)),
            projection(separate[context].infer(input, journal.evidence)),
            'context reuse must preserve probabilities, all counterparty values and style posteriors',
          );
        }
      },
    });
  }
  console.log(
    'PASS batch manifest: 1200 unique balanced seeds, immutable split, unopened test guard, equal-round MSE and selected-edge decomposition.',
  );
  console.log(
    'PASS context-engine reuse matches independent engines for archived baseline and both candidate variants.',
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
