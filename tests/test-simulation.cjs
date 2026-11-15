'use strict';
const assert = require('node:assert/strict');
const {
  Environment,
  SUITS,
  DECKS,
  settlement,
  runRound,
} = require('../tools/simulation/simulator.cjs');
const { createPolicy, privateOdds } = require('../tools/simulation/policies.cjs');
const {
  transferValue,
  loadEngine,
  selectModels,
  evaluate,
  score,
  accumulator,
  report,
} = require('../tools/simulation/evaluate.cjs');
const { parse } = require('../tools/simulation/cli.cjs');
const registry = require('../tools/model-registry.cjs');
const J = require('../extension/journal.js');
const B = require('../extension/belief.js');
const sum = (a) => a.reduce((x, y) => x + y, 0);
let tests = 0;
function test(name, fn) {
  fn();
  tests++;
  console.log('ok', name);
}
function near(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9, `${message || ''}: ${actual} != ${expected}`);
}
function unchanged(env, action) {
  const before = JSON.stringify(env.truth());
  const revision = env.revision;
  const result = action();
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(env.truth()), before);
  assert.equal(env.revision, revision);
  return result;
}

test('legal uniformly enumerated decks, 4/5-player deal sizes and ante', () => {
  assert.equal(DECKS.length, 12);
  assert.equal(new Set(DECKS.map((d) => d.counts.join())).size, 12);
  for (const deck of DECKS) {
    assert.deepEqual(
      deck.counts.slice().sort((a, b) => a - b),
      [8, 10, 10, 12],
    );
    assert.equal(deck.goal, deck.counts.indexOf(12) ^ 1);
    assert([8, 10].includes(deck.counts[deck.goal]));
  }
  for (const players of [4, 5])
    for (let seed = 0; seed < 20; seed++) {
      const env = new Environment({ players, seed });
      const truth = env.truth();
      assert.deepEqual(truth.hands.map(sum), Array(players).fill(40 / players));
      assert.deepEqual(
        SUITS.map((_, s) => sum(truth.hands.map((h) => h[s]))),
        truth.deck,
      );
      near(sum(truth.cash), 350 * players - 200);
      assert.throws(() => env.result(), /not revealed/);
    }
});

test('one-card execution at resting price clears quotes in all suits', () => {
  const env = new Environment({ seed: 1101 });
  const truth = env.truth();
  const s = truth.hands[1].findIndex((n) => n > 0);
  const other = (s + 1) % 4;
  assert.equal(env.act(2, { kind: 'quote', side: 'bid', suit: SUITS[other], price: 1 }).ok, true);
  assert.equal(env.act(1, { kind: 'quote', side: 'ask', suit: SUITS[s], price: 3 }).ok, true);
  const result = env.act(0, { kind: 'quote', side: 'bid', suit: SUITS[s], price: 7 });
  assert.deepEqual(result.trade, { b: 'You', s: 'Bot-Sim-1', suit: SUITS[s], p: 3 });
  assert.equal(env.truth().hands[0][s], truth.hands[0][s] + 1);
  assert.equal(env.truth().hands[1][s], truth.hands[1][s] - 1);
  assert.equal(env.truth().cash[0], truth.cash[0] - 3);
  assert.equal(env.truth().cash[1], truth.cash[1] + 3);
  assert(env.view().markets.every((m) => m.bid === null && m.ask === null));
});

test('invalid prices, cash, inventory, owner, actor and self-trades are rejected atomically', () => {
  const env = new Environment({ seed: 2 });
  const s = env.truth().hands[0].findIndex((n) => n > 0);
  for (const price of [0, -1, 1.5, Infinity, NaN])
    unchanged(env, () => env.act(0, { kind: 'quote', side: 'bid', suit: SUITS[s], price }));
  unchanged(env, () => env.act(0, { kind: 'quote', side: 'bid', suit: SUITS[s], price: 10000 }));
  unchanged(env, () => env.act(9, { kind: 'quote', side: 'bid', suit: SUITS[s], price: 1 }));
  unchanged(env, () => env.act(0, { kind: 'take', side: 'buy', suit: 'z' }));
  env.act(0, { kind: 'quote', side: 'ask', suit: SUITS[s], price: 2 });
  assert.equal(
    unchanged(env, () => env.act(0, { kind: 'take', side: 'buy', suit: SUITS[s] })).reason,
    'self-trade',
  );
  unchanged(env, () => env.act(1, { kind: 'cancel', side: 'ask', suit: SUITS[s] }));
  assert.equal(env.act(0, { kind: 'cancel', side: 'ask', suit: SUITS[s] }).ok, true);
  while (env.truth().hands[0][s]) {
    env.act(0, { kind: 'quote', side: 'ask', suit: SUITS[s], price: 1 });
    assert.equal(env.act(1, { kind: 'take', side: 'buy', suit: SUITS[s] }).ok, true);
  }
  assert.equal(
    unchanged(env, () => env.act(0, { kind: 'quote', side: 'ask', suit: SUITS[s], price: 1 }))
      .reason,
    'no-inventory',
  );
  env.finish();
  unchanged(env, () => env.act(0, { kind: 'quote', side: 'bid', suit: SUITS[s], price: 1 }));
});

test('exact bonus ties, goal supply and named one-card contest transitions', () => {
  let paid = settlement(
    [
      [4, 0, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    's',
  );
  assert.deepEqual(paid.bonuses, [60, 60, 0, 0]);
  assert.deepEqual(paid.payouts, [100, 100, 0, 0]);
  paid = settlement(
    [
      [5, 0, 0, 0],
      [5, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    's',
  );
  assert.deepEqual(paid.bonuses, [50, 50, 0, 0, 0]);
  near(sum(paid.payouts), 200);
  const truth = {
    goal: 's',
    hands: [
      [4, 0, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  };
  assert.equal(transferValue(truth, 0, 1, 0, 'buy'), 70);
  assert.equal(transferValue(truth, 0, 1, 0, 'sell'), 70);
  assert.equal(transferValue(truth, 0, 2, 0, 'buy'), null);
  assert.equal(transferValue(truth, 0, 1, 1, 'sell'), null);
});

test('policy input is a frozen private/public copy; goal is exposed only after ending', () => {
  const env = new Environment({ seed: 1101 });
  const differentSeed = new Environment({ seed: 99123 });
  assert.equal(
    env.view().roundKey,
    differentSeed.view().roundKey,
    'public round identifiers must not encode the private deal seed',
  );
  assert.equal(
    env.view().signature,
    differentSeed.view().signature,
    'initial revision signatures reveal no seed',
  );
  for (let actor = 0; actor < 4; actor++) {
    const view = env.view(actor);
    const truth = env.truth();
    assert.equal(view.self, env.names[actor]);
    assert.equal(view.players[0].name, view.self);
    assert.deepEqual(view.startingHand, truth.initial[actor]);
    assert.deepEqual(view.held, truth.hands[actor]);
    assert.deepEqual(Object.keys(view.players[1]).sort(), ['cards', 'cash', 'name']);
    for (const key of ['goal', 'deck', 'hands', 'initial', 'truth', 'roundResult'])
      assert.equal(Object.hasOwn(view, key), false);
    assert(Object.isFrozen(view));
    assert(Object.isFrozen(view.startingHand));
    assert(Object.isFrozen(view.players[1]));
    assert.throws(() => {
      view.held[0] = 99;
    }, TypeError);
    const policy = createPolicy('bonus', { seed: actor });
    assert(policy.act(view));
    assert.deepEqual(env.truth(), truth);
  }
  const captured = [];
  const policies = Array.from({ length: 4 }, (_, actor) => ({
    type: 'audit',
    act(view) {
      assert.equal(view.self, env.names[actor]);
      assert.equal(view.roundResult, undefined);
      captured.push(view);
      return { kind: 'wait' };
    },
  }));
  const round = runRound({ seed: 1101, steps: 8, policies });
  assert.equal(captured.length, 8);
  assert(round.trace.slice(0, -1).every((f) => !f.snapshot.roundResult));
  assert.equal(round.trace.at(-1).snapshot.roundResult.goal, round.truthBeforeSettlement.goal);
});

test('independent private prior agrees with exact opening combinatorics, never with a hidden goal', () => {
  const weights = privateOdds([3, 3, 2, 2]);
  near(sum(weights), 1);
  const goals = [0, 0, 0, 0];
  weights.forEach((w, i) => (goals[DECKS[i].goal] += w));
  const expected = B.privateBelief([3, 3, 2, 2]).goals;
  goals.forEach((v, s) => near(v, expected[s]));
  const altered = privateOdds([3, 3, 2, 2]);
  altered[0] = 9;
  assert.notEqual(privateOdds([3, 3, 2, 2])[0], 9);
});

test('seed reproducibility, legal replay, journal compatibility and conservation throughout varied policy rounds', () => {
  const rounds = [];
  for (const players of [4, 5]) {
    const a = runRound({ seed: 1101, players, steps: 160, noise: 0.8, brownian: 0.2 });
    const b = runRound({ seed: 1101, players, steps: 160, noise: 0.8, brownian: 0.2 });
    assert.deepEqual(a, b);
    rounds.push(a);
    assert(a.trace.at(-1).snapshot.trades.length > 10, 'policies actually create trades');
    const journal = new J.RoundJournal('sim-test', 'sim-test');
    for (const frame of a.trace) {
      journal.observe(frame.snapshot, frame.at);
      B.physical(frame.snapshot);
      assert.equal(sum(frame.snapshot.players.map((p) => p.cards)), 40);
      near(
        sum(frame.snapshot.players.map((p) => p.cash)),
        350 * players - (frame.snapshot.status === 'ended' ? 0 : 200),
      );
      assert(frame.snapshot.players.every((p) => p.cards >= 0 && p.cash >= 0));
    }
    const truth = a.truthBeforeSettlement;
    const hands = truth.initial.map((h) => h.slice());
    const cash = Array(players).fill(350 - 200 / players);
    for (const trade of a.trace.at(-1).snapshot.trades) {
      const s = SUITS.indexOf(trade.suit);
      const seller = truth.names.indexOf(trade.s);
      const buyer = truth.names.indexOf(trade.b);
      assert.notEqual(seller, buyer);
      assert(hands[seller][s] > 0);
      assert(cash[buyer] >= trade.p);
      assert(Number.isSafeInteger(trade.p) && trade.p > 0);
      hands[seller][s]--;
      hands[buyer][s]++;
      cash[seller] += trade.p;
      cash[buyer] -= trade.p;
    }
    assert.deepEqual(hands, truth.hands);
    assert.deepEqual(cash, truth.cash);
    near(sum(Object.values(a.result.profits)), 0);
    assert.equal(
      journal.events.filter((e) => e.kind === 'fill').length,
      a.trace.at(-1).snapshot.trades.length,
    );
    assert(journal.events.filter((e) => e.kind === 'fill').every((e) => !e.recovered));
  }
  assert.notDeepEqual(rounds[0].result, runRound({ seed: 1102, steps: 160 }).result);
});

test('settlement is idempotent', () => {
  const env = new Environment({ seed: 42 });
  const first = env.finish();
  const balance = env.truth().cash;
  assert.deepEqual(env.finish(), first);
  assert.deepEqual(env.truth().cash, balance);
});

test('scoring separates exact goal, conditional bonus, named transfer and observed quote outcomes', () => {
  const env = new Environment({ seed: 1101 });
  const truth = env.truth();
  const g = SUITS.indexOf(truth.goal);
  const suit = truth.hands[1].findIndex((v) => v > 0);
  env.act(1, { kind: 'quote', side: 'ask', suit: SUITS[suit], price: 2 });
  const snapshot = env.view();
  const actual = settlement(truth.hands, truth.goal);
  const bySuit = SUITS.map((_, s) => ({
    probability: Number(s === g),
    conditionalBonus: actual.bonuses[0],
    conditionalLeaderProbability: Number(actual.bonuses[0] > 0),
    counterparties: Object.fromEntries(
      truth.names.slice(1).map((name, p) => [
        name,
        {
          buy: transferValue(truth, 0, p + 1, s, 'buy'),
          sell: transferValue(truth, 0, p + 1, s, 'sell'),
        },
      ]),
    ),
  }));
  const a = accumulator();
  score(
    { bySuit, expectedBonus: actual.bonuses[0], expectedPayout: actual.payouts[0], computeMs: 1 },
    snapshot,
    truth,
    a,
  );
  const r = report(a);
  assert.equal(r.goalBrier, 0);
  assert.equal(r.goalLogLoss, 0);
  assert.equal(r.conditionalLeaderBrier, 0);
  for (const key of [
    'conditionalBonus',
    'expectedBonus',
    'expectedPayout',
    'oneCardValue',
    'executableQuoteEV',
  ]) {
    assert(r[key].n > 0);
    assert.equal(r[key].mae, 0);
  }
});

test('frozen and current model loading cannot overwrite or inherit process-global fit tables', () => {
  const previous = globalThis.FiggieModelFit;
  const sentinel = { wrongTable: true };
  globalThis.FiggieModelFit = sentinel;
  try {
    const frozen = loadEngine('belief-v0.10.js', 'model-fit-v0.10.js');
    const current = loadEngine('belief.js', 'model-fit.js');
    assert.equal(typeof frozen.BeliefEngine, 'function');
    assert.equal(typeof current.BeliefEngine, 'function');
    assert.equal(globalThis.FiggieModelFit, sentinel);
  } finally {
    globalThis.FiggieModelFit = previous;
  }
});

test('archive version flags preserve archived defaults and allow only explicit sample overrides', () => {
  const options = parse(['--baseline-version', '0.10.0', '--candidate-version', '0.11.0']);
  assert.deepEqual(options, { baselineVersion: '0.10.0', candidateVersion: '0.11.0' });
  const selected = selectModels(options);
  for (const role of ['baseline', 'candidate']) {
    assert.deepEqual(selected[role].engineOptions, { skipPricing: true });
    assert.equal(selected[role].metadata.effectiveSettings.samples, 512);
    assert.equal(
      selected[role].metadata.bundleSha256,
      registry.verify(options[`${role}Version`])[0].bundleSha256,
    );
  }
  assert.equal(selected.baseline.metadata.effectiveSettings.opponentLearning, false);
  assert.equal(selected.candidate.metadata.effectiveSettings.opponentLearning, true);
  assert.equal(selected.candidate.metadata.effectiveSettings.opponentSamples, 12);
  const overridden = selectModels({ ...options, samples: 32, opponentSamples: 8 });
  assert.deepEqual(overridden.candidate.engineOptions, {
    skipPricing: true,
    samples: 32,
    opponentSamples: 8,
  });
  assert.equal(overridden.candidate.metadata.effectiveSettings.opponentSamples, 8);
  assert.equal(overridden.baseline.metadata.effectiveSettings.samples, 32);
  const defaults = selectModels();
  assert.equal(defaults.baseline.metadata.effectiveSettings.samples, 128);
  assert.deepEqual(defaults.candidate.engineOptions, {
    skipPricing: true,
    samples: 128,
    opponentLearning: true,
    opponentSamples: 12,
  });
  assert.throws(() => parse(['--candidate-version', '../0.11.0']), /major.minor.patch/);
  assert.throws(() => selectModels({ candidateVersion: '99.0.0' }), /Unknown model/);
});

test('paired replay of the same immutable model is identical and reports verified bundle provenance', () => {
  const r = evaluate({
    games: 1,
    steps: 8,
    checkpoints: 2,
    samples: 16,
    baselineVersion: '0.10.0',
    candidateVersion: '0.10.0',
  });
  const withoutTiming = ({ computeMs, ...scores }) => scores;
  assert.deepEqual(withoutTiming(r.models.baseline), withoutTiming(r.models.candidate));
  assert(Object.values(r.differences).every((value) => value === 0));
  assert.equal(r.modelSelection.baseline.resultKey, 'baseline');
  assert.equal(r.modelSelection.baseline.bundleSha256, r.modelSelection.candidate.bundleSha256);
  assert.equal(
    r.sources['models/0.10.0/belief.js'],
    registry.verify('0.10.0')[0].files['belief.js'],
  );
  assert.equal(
    r.sources['extension/belief.js'],
    undefined,
    'a mutable current engine is not attributed to an archive comparison',
  );
});

test('older archives derive conditional bonus without fabricating missing leadership forecasts', () => {
  const r = evaluate({
    games: 1,
    steps: 4,
    checkpoints: 2,
    samples: 8,
    baselineVersion: '0.3.0',
    candidateVersion: '0.10.0',
  });
  assert.equal(r.models.baseline.conditionalBonus.n, 2);
  assert.equal(r.models.baseline.conditionalBonus.derivedFromHoldingCheckpoints, 2);
  assert.equal(r.models.baseline.conditionalLeaderBrier, null);
  assert.equal(r.models.baseline.conditionalLeaderCheckpoints, 0);
  assert(Number.isFinite(r.models.baseline.conditionalBonus.mae));
  assert(Number.isFinite(r.models.baseline.oneCardValue.mae));
});

console.log(`${tests} simulation tests passed`);
