'use strict';
const assert = require('node:assert/strict');
const Registry = require('../tools/model-registry.cjs');
const Fast = require('../tools/simulation/fast-load.cjs');
const { runRound } = require('../tools/simulation/simulator.cjs');
const sentinel = { sentinel: true };
const beforeFit = globalThis.FiggieModelFit;
const beforeBelief = globalThis.FiggieBelief;
globalThis.FiggieModelFit = sentinel;
globalThis.FiggieBelief = sentinel;
try {
  for (const version of ['0.3.0', '0.6.0', '0.7.0', '0.8.0', '0.10.0', '0.11.0']) {
    const slow = Registry.load(version);
    const fast = Fast.load(version);
    const opts = { samples: version === '0.11.0' ? 512 : 32, skipPricing: true };
    const slowEngines = Object.fromEntries(
      ['Simulated', 'Medium'].map((c) => [c, new slow.Belief.BeliefEngine(opts)]),
    );
    const fastEngine = new fast.Belief.BeliefEngine(opts);
    const js = new slow.Journal.RoundJournal('eq', 'eq');
    const jf = new fast.Journal.RoundJournal('eq', 'eq');
    const project = (model) =>
      JSON.parse(
        JSON.stringify({
          bySuit: model.bySuit,
          expectedPayout: model.expectedPayout,
          expectedBonus: model.expectedBonus,
          styles: model.behavior.styles,
        }),
      );
    runRound({
      seed: 600013,
      steps: 120,
      onSnapshot(snapshot, truth, frame) {
        js.observe(snapshot, frame.at);
        jf.observe(snapshot, frame.at);
        if (![0, 60, 120].includes(frame.step)) return;
        assert.deepEqual(JSON.parse(JSON.stringify(js.evidence)), jf.evidence);
        for (const context of ['Simulated', 'Medium']) {
          const input = { ...snapshot, context: { ...snapshot.context, botDifficulty: context } };
          assert.deepEqual(
            project(slowEngines[context].infer(input, js.evidence)),
            project(fastEngine.infer(input, jf.evidence)),
            version + '/' + context,
          );
        }
      },
    });
    assert.equal(globalThis.FiggieModelFit, sentinel);
    assert.equal(globalThis.FiggieBelief, sentinel);
    console.log('ok isolated fast archive equals Registry.load', version);
  }
  assert.throws(() => Fast.load('../0.11.0'));
  console.log(
    'PASS verified fast loader, context reuse and complete price/style equivalence; v0.11 tested at512.',
  );
} finally {
  globalThis.FiggieModelFit = beforeFit;
  globalThis.FiggieBelief = beforeBelief;
}
