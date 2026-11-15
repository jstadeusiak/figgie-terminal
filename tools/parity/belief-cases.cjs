'use strict';

/*
 * Parity cases for the belief model's building blocks: its constants and
 * exported helpers, opponent knowledge, and goal calibration. The engine
 * itself is exercised in `engine-cases.cjs`.
 */

const assert = require('node:assert/strict');
const {
  SUIT_IDS,
  clone,
  sum,
  outcome,
  seededRandom,
  integerBelow,
  pickFrom,
  chance,
  rows,
  sale,
  allHands,
  tableSnapshot,
  netHistory,
  randomEvidence,
  malformedEvidence,
} = require('./inputs.cjs');

// ── Cases: module surface and belief helpers ─────────────────────────────

function surfaceCase() {
  return {
    name: 'module surface and constants',
    run: (release) => ({
      exports: Object.fromEntries(
        ['Belief', 'Journal', 'Training', 'Pnl', 'Bonus', 'GoalSignal'].map((name) => [
          name,
          Object.keys(release[name]),
        ]),
      ),
      suits: release.Belief.IDS,
      decks: release.Belief.DECKS,
      styleNames: release.Belief.STYLE_NAMES,
      defaultPrior: release.Belief.DEFAULT_PRIOR,
      defaultSignals: release.Belief.DEFAULT_SIGNALS,
      fits: release.ModelFit,
    }),
  };
}

function hashCase() {
  const texts = [
    '',
    'a',
    'Bot-A',
    '["You",[3,3,2,2]]|12,10,10,8',
    '3,3,2,2|0,0,0,0;1,0,0,0|7',
    '♠♥',
    42,
  ];
  return {
    name: 'hash',
    run: (release) => texts.map((text) => release.Belief.hash(text)),
  };
}

function privateBeliefCase() {
  const hands = [...allHands(10), ...allHands(8)];
  return {
    name: 'privateBelief for every dealt hand',
    run: (release) => hands.map((hand) => release.Belief.privateBelief(hand)),
  };
}

function physicalCase() {
  const fourPlayers = tableSnapshot({
    hand: [3, 3, 2, 2],
    trades: [sale(1, 2, 'h', 6), sale(0, 3, 's', 4), sale(3, 1, 'h', 7), sale(1, 0, 'd', 5)],
  });
  const fivePlayers = tableSnapshot({
    hand: [2, 2, 2, 2],
    players: 5,
    trades: [sale(4, 0, 'c', 3)],
  });
  const corruptions = {
    valid: () => {},
    'no held': (snapshot) => delete snapshot.held,
    'three players': (snapshot) => snapshot.players.pop(),
    'short hand': (snapshot) => snapshot.startingHand[0]--,
    'fractional hand': (snapshot) => (snapshot.startingHand = [3.5, 2.5, 2, 2]),
    'negative hand': (snapshot) => (snapshot.startingHand = [-1, 5, 3, 3]),
    'oversized suit': (snapshot) => (snapshot.startingHand = [13, -3, 0, 0]),
    'unknown suit': (snapshot) => (snapshot.trades[0].suit = 'x'),
    'unknown seller': (snapshot) => (snapshot.trades[0].s = 'Nobody'),
    'unknown buyer': (snapshot) => (snapshot.trades[0].b = 'Nobody'),
    'self trade': (snapshot) => (snapshot.trades[0].b = snapshot.trades[0].s),
    'sold more than dealt': (snapshot) => {
      snapshot.startingHand = [0, 4, 3, 3];
      delete snapshot.held;
    },
    'held contradicts flow': (snapshot) => snapshot.held[1]++,
  };
  return {
    name: 'physical',
    check(output) {
      const messages = new Set(output.map((result) => result.threw));
      assert.equal(messages.size, 5, 'a valid deal and each of the four rejections');
    },
    run: (release) =>
      [fourPlayers, fivePlayers].flatMap((snapshot) =>
        Object.values(corruptions).map((corrupt) => {
          const corrupted = clone(snapshot);
          corrupt(corrupted);
          return outcome(() => release.Belief.physical(corrupted));
        }),
      ),
  };
}

function askConstraintsCase() {
  const snapshot = tableSnapshot({
    hand: [3, 3, 2, 2],
    trades: [sale(1, 2, 's', 6), sale(1, 3, 's', 4), sale(2, 1, 'c', 7)],
  });
  const names = snapshot.players.map((player) => player.name);
  const nets = netHistory(snapshot);
  const ask = (seat, suit, epoch, changes = {}) => ({
    kind: 'quote',
    direction: 'sell',
    actor: names[seat],
    suit,
    epoch,
    price: 6,
    net: clone(nets[epoch] || nets[0]),
    ...changes,
  });
  const events = [
    ask(1, 's', 0),
    ask(1, 's', 2),
    ask(1, 's', 3),
    ask(2, 's', 3),
    ask(2, 'c', 1),
    ask(3, 'h', 3),
    ask(3, 'd', 2),
    // Your own asks, and events that are not live asks, say nothing here.
    ask(0, 'c', 0),
    ask(1, 'x', 0),
    ask(1, 'd', 0, { actor: 'Nobody' }),
    ask(1, 'd', 0, { recovered: true }),
    ask(1, 'd', 0, { direction: 'buy' }),
    ask(1, 'd', 0, { kind: 'take' }),
    // Asks whose epoch, price or recorded flow cannot be trusted are rejected.
    ask(1, 'd', 4),
    ask(1, 'd', -1),
    ask(1, 'd', 1.5),
    ask(1, 'd', 0, { price: 0 }),
    ask(1, 'd', 0, { price: 2.5 }),
    ask(1, 'd', 0, { net: null }),
    ask(1, 'd', 0, { net: [[0, 0, 0, 0]] }),
    ask(1, 'd', 1, { net: clone(nets[2]) }),
    ask(1, 'd', 1, { net: names.map(() => [0, 0, 0]) }),
    ask(1, 'd', 1, { net: names.map(() => null) }),
    ask(1, 'd', 1, { net: names.map(() => [0.5, 0, 0, 0]) }),
  ];
  // After nine executed sales of one suit, an ask proves a tenth card: a
  // whole hand. After ten, it would need an eleventh: more than a hand holds.
  const heavySeller = tableSnapshot({
    hand: [0, 4, 3, 3],
    trades: Array.from({ length: 10 }, () => sale(1, 2, 's', 5)),
  });
  const heavyFlow = netHistory(heavySeller);
  const tenthAsk = { ...ask(1, 's', 0), epoch: 9, net: heavyFlow[9] };
  const eleventhAsk = { ...ask(1, 's', 0), epoch: 10, net: heavyFlow[10] };
  return {
    name: 'askInventoryConstraints',
    check(output) {
      assert.equal(output.diagnostic.qualifiedAsks, 7);
      assert.equal(output.diagnostic.rejectedAsks, 11);
      assert.deepEqual(
        [output.heavy.qualifiedAsks, output.heavy.rejectedAsks, output.heavyState.minimum[1][0]],
        [1, 1, 10],
      );
    },
    run(release) {
      const { physical, askInventoryConstraints } = release.Belief;
      const state = physical(clone(snapshot));
      const diagnostic = askInventoryConstraints(clone(snapshot), state, clone(events));
      const heavyState = physical(clone(heavySeller));
      const heavyAsks = clone([tenthAsk, eleventhAsk]);
      const heavy = askInventoryConstraints(clone(heavySeller), heavyState, heavyAsks);
      return { diagnostic, state, heavy, heavyState };
    },
  };
}

function allocationCase() {
  // Cards left in each suit, the least each hidden hand holds, and the hand size.
  const problems = [
    { remaining: [9, 7, 8, 6], lower: rows('0000 0000 0000'), size: 10 },
    { remaining: [9, 7, 8, 6], lower: rows('2001 0300 0000'), size: 10 },
    { remaining: [6, 9, 7, 8], lower: rows('3000 0041 1111'), size: 10 },
    { remaining: [10, 8, 8, 6], lower: rows('0000 1020 0000 0400'), size: 8 },
    { remaining: [10, 8, 6, 8], lower: rows('8000 2600 0000 0000'), size: 8 },
    { remaining: [9, 7, 8, 6], lower: rows('9100 1000 0000'), size: 10 },
    { remaining: [9, 7, 8, 6], lower: rows('0007 0000 0000'), size: 10 },
  ];
  return {
    name: 'allocationDP',
    check(output) {
      assert.ok(output[1].mass > 0 && output[1].strata.length > 1);
      assert.equal(output[5].mass, 0, 'bounds that exceed the suit leave no allocation');
    },
    run(release) {
      return problems.map(({ remaining, lower, size }, index) => {
        const plan = release.Belief.allocationDP(remaining, lower, size);
        const random = seededRandom(100 + index);
        const strata = plan.strata();
        return {
          mass: plan.mass,
          states: plan.states,
          strata,
          free: outcome(() => Array.from({ length: 12 }, () => plan.sample(random))),
          anchored: strata.slice(0, 6).map((stratum) => plan.sample(random, stratum)),
        };
      });
    },
  };
}

function inventoryWeightsCase() {
  const random = seededRandom(31);
  const problems = [];
  for (const players of [4, 5]) {
    for (let variant = 0; variant < 8; variant++) {
      const worldCount = variant === 0 ? 3 : 40 + integerBelow(random, 60);
      const goals = variant === 1 ? [2] : [0, 1, 2, 3];
      const worlds = Array.from({ length: worldCount }, () => ({
        goal: pickFrom(random, goals),
        initial: Array.from({ length: players }, () => SUIT_IDS.map(() => integerBelow(random, 6))),
        referenceEssMultiplier: chance(random, 0.2) ? undefined : 0.5 + random(),
      }));
      const rawWeights = worlds.map(() => (chance(random, 0.1) ? 0 : random() ** 3));
      const net = Array.from({ length: players }, () =>
        SUIT_IDS.map(() => integerBelow(random, 7) - 3),
      );
      problems.push([
        worlds,
        rawWeights.map((weight) => weight / sum(rawWeights)),
        net,
        pickFrom(random, [0.8, 0.8, 0, 2.5, 0.05]),
        pickFrom(random, [64, 64, 0, 5, 1000, undefined]),
        chance(random, 0.5),
      ]);
    }
  }
  // Many worlds of one goal and a strong tilt: the default guard of 64
  // effective worlds is what limits the calibration.
  const crowded = Array.from({ length: 600 }, () => ({
    goal: 3,
    initial: Array.from({ length: 4 }, () => SUIT_IDS.map(() => integerBelow(random, 6))),
  }));
  const evenWeights = crowded.map(() => 1 / crowded.length);
  problems.push([crowded, evenWeights, rows('0000 0003 0002 0001'), 2.5]);
  // Worlds of a goal that has no weight at all keep none.
  const oneWorldPerGoal = [0, 1, 2, 3].map((goal) => ({
    goal,
    initial: rows('3322 4231 2323 3232'),
  }));
  problems.push([oneWorldPerGoal, [0.5, 0.5, 0, 0], rows('0000 1001 0010 0100'), 0.8]);
  return {
    name: 'inventoryWeights',
    check(output) {
      const guarded = output.at(-2).goals[3];
      assert.deepEqual(Array.from(output.at(-1).weights.slice(2)), [0, 0]);
      assert.ok(guarded.effectiveBefore > 64 && Math.abs(guarded.effectiveAfter - 64) < 1e-6);
      const blends = output.flatMap((result) => result.goals.map((goal) => goal.calibrationBlend));
      assert.ok(
        blends.some((blend) => blend > 0 && blend < 1),
        'the effective-size guard binds',
      );
      assert.ok(blends.includes(1), 'and sometimes does not');
    },
    run: (release) => problems.map((problem) => release.Belief.inventoryWeights(...clone(problem))),
  };
}

function chooseEvidenceCase() {
  const snapshot = tableSnapshot({
    hand: [3, 3, 2, 2],
    trades: [sale(1, 2, 'h', 6), sale(3, 1, 's', 4)],
  });
  const random = seededRandom(47);
  const eventLists = [
    [],
    malformedEvidence(snapshot),
    randomEvidence(random, snapshot, 30),
    randomEvidence(random, snapshot, 260),
    [...randomEvidence(random, snapshot, 120), ...malformedEvidence(snapshot)],
  ];
  return {
    name: 'chooseEvidence',
    run(release) {
      const { chooseEvidence } = release.Belief;
      return eventLists.flatMap((events) => [
        chooseEvidence(clone(events), 'You'),
        chooseEvidence(clone(events), 'You', { recentOnly: true }),
        chooseEvidence(clone(events), 'Bot-B', { recentOnly: false }),
      ]);
    },
  };
}

function eventLogsCase() {
  const snapshot = tableSnapshot({
    hand: [3, 3, 2, 2],
    trades: [sale(1, 2, 'h', 6), sale(3, 1, 's', 4), sale(2, 0, 'c', 9)],
  });
  const names = snapshot.players.map((player) => player.name);
  const events = [
    ...randomEvidence(seededRandom(53), snapshot, 60),
    ...malformedEvidence(snapshot),
  ];
  const hands = rows('3322 0055 1441 0406');
  // With nine spades in hand and no trades yet, nobody else is expected to
  // hold even one: the estimated lead is as large as it can be.
  const dominantHand = [9, 1, 0, 0];
  const spadeBid = {
    kind: 'take',
    actor: names[1],
    suit: 's',
    direction: 'buy',
    price: 7,
    epoch: 0,
    net: names.map(() => [0, 0, 0, 0]),
    anchor: 5,
  };
  return {
    name: 'eventLogs',
    run(release) {
      const { eventLogs, OpponentKnowledge } = release.Belief;
      const knowledge = new OpponentKnowledge({ samples: 16 });
      knowledge.prepare(clone(snapshot), clone(events));
      // Without opponent knowledge a reservation comes from the private hand alone.
      const contexts = [{}, { names }, { names, knowledge }];
      const logs = contexts.map((context) =>
        events.map((event, index) => {
          const actor = Math.max(0, names.indexOf(event.actor));
          return eventLogs(hands[index % hands.length], actor, clone(event), context);
        }),
      );
      const dominant = contexts.map((context) => eventLogs(dominantHand, 1, spadeBid, context));
      return { logs, dominant };
    },
  };
}

function opponentKnowledgeCase() {
  const tables = [
    tableSnapshot({
      hand: [3, 3, 2, 2],
      trades: [
        sale(1, 2, 'h', 6),
        sale(3, 1, 's', 4),
        sale(2, 0, 'c', 9),
        sale(1, 3, 'h', 5),
        sale(0, 2, 'd', 7),
      ],
    }),
    tableSnapshot({
      hand: [2, 2, 2, 2],
      players: 5,
      trades: [sale(4, 1, 'd', 3), sale(2, 4, 's', 8)],
    }),
    tableSnapshot({ hand: [3, 3, 2, 2], trades: [sale(1, 2, 'h', 6)], roundKey: 'cut-short' }),
  ];
  const evidence = tables.map((snapshot, index) => [
    ...randomEvidence(seededRandom(61 + index), snapshot, 50),
    ...malformedEvidence(snapshot),
  ]);
  // A trade the table cannot place ends the public history there.
  tables[2].trades.push({ b: 'Nobody', s: 'Bot-A', suit: 'h', p: 3 }, tables[2].trades[0]);
  // The sample count is clamped to [8, 128]; a small cache evicts entries.
  const options = [{ samples: 12 }, { samples: 200, maxEntries: 5 }, { samples: 2 }];
  const handsBySize = { 10: allHands(10), 8: allHands(8) };

  function exercise(release, tableIndex) {
    const snapshot = tables[tableIndex];
    const events = evidence[tableIndex];
    const names = snapshot.players.map((player) => player.name);
    const random = seededRandom(59 + tableIndex);
    const knowledge = new release.Belief.OpponentKnowledge(options[tableIndex]);
    const beforePrepare = { samples: knowledge.samples, summary: knowledge.summary() };
    knowledge.prepare(clone(snapshot), clone(events));
    const prefixes = [knowledge.prefix(), ...events.map((event) => knowledge.prefix(event))];
    const hands = handsBySize[40 / names.length];
    const values = [];
    for (let draw = 0; draw < 120; draw++) {
      const hand = pickFrom(random, hands);
      const actor = integerBelow(random, names.length);
      const event = chance(random, 0.7) ? pickFrom(random, events) : null;
      const valueOptions = chance(random, 0.5)
        ? {}
        : {
            prefix: chance(random, 0.5) ? knowledge.prefix() : undefined,
            suit: integerBelow(random, 5) - 1,
            buy: chance(random, 0.5),
            counterparty: pickFrom(random, [undefined, -1, 0, 1, 2]),
          };
      // Asked twice: the second answer comes from the cache and must not differ.
      for (const _attempt of chance(random, 0.3) ? [1, 2] : [1]) {
        values.push(outcome(() => knowledge.value(hand, actor, event, valueOptions)));
      }
    }
    const result = {
      beforePrepare,
      prefixes,
      values,
      ordering: events
        .slice(0, 25)
        .map((event, index) => knowledge.before(event, events[(index * 7 + 3) % events.length])),
      sameNets: [snapshot.net, null, [[0, 0, 0, 0]], names.map(() => [0, 0, 0])].map((net) =>
        knowledge.sameNet(net, knowledge.nets.at(-1)),
      ),
      shares: rows('3310 2310 4110').map((counts) => knowledge.share(counts, 0, 120)),
      stats: clone(knowledge.stats),
      summary: knowledge.summary(),
    };
    // A new round starts a new cache namespace.
    knowledge.prepare({ ...clone(snapshot), roundKey: 'next-round' }, []);
    return { ...result, cachedAfterNewRound: knowledge.cache.size };
  }

  return {
    name: 'OpponentKnowledge',
    check(output) {
      assert.ok(output[0].values.some((result) => result.value?.knownCounterparty));
      assert.ok(output[0].values.some((result) => result.value === null));
      assert.deepEqual(
        output.map((result) => result.beforePrepare.samples),
        [12, 128, 8],
      );
      assert.equal(output[1].summary.cachedHands, 5, 'the small cache is full');
      assert.equal(output[0].cachedAfterNewRound, 0);
    },
    run: (release) => tables.map((_table, index) => exercise(release, index)),
  };
}

// How opponent knowledge reads the public history: which event was visible
// before which, and where a trade the table cannot place ends the history.
function opponentHistoryCase() {
  // Events with every combination of a known time and a known sequence.
  const moments = [
    { epoch: 0, at: 90, sourceSeq: 4 },
    { epoch: 1, at: 100, sourceSeq: 5 },
    { epoch: 1, at: 100, sourceSeq: 6 },
    { epoch: 1, at: 200, sourceSeq: 3 },
    { epoch: 1, at: 300 },
    { epoch: 1, sourceSeq: 9 },
    { epoch: 1 },
    { epoch: 1, at: 400, sourceSeq: 10, passive: true },
    { epoch: 1, at: 500, sourceSeq: 11, recovered: true },
  ];
  const placed = sale(1, 2, 'h', 6);
  const unplaceable = [{ suit: 'x' }, { s: 'Nobody' }, { b: 'Nobody' }];
  return {
    name: 'OpponentKnowledge: public history',
    check(output) {
      assert.ok(output.ordering.includes(true) && output.ordering.includes(false));
      assert.deepEqual(
        output.histories.map((history) => [history.nets.length, history.current]),
        unplaceable.map(() => [2, null]),
      );
    },
    run(release) {
      const knowledge = new release.Belief.OpponentKnowledge();
      const ordering = moments.flatMap((a) => moments.map((b) => knowledge.before(a, b)));
      const histories = unplaceable.map((change) => {
        const snapshot = tableSnapshot({ hand: [3, 3, 2, 2], trades: [placed, placed] });
        Object.assign(snapshot.trades[1], change);
        knowledge.prepare(snapshot, []);
        return { nets: knowledge.nets, floors: knowledge.floors, current: knowledge.prefix() };
      });
      return { ordering, histories };
    },
  };
}

// ── Cases: goal calibration ──────────────────────────────────────────────

function goalSignalCases() {
  const structural = [
    [0.25, 0.25, 0.25, 0.25],
    [0.4, 0.3, 0.2, 0.1],
    [0.5, 0.5, 0, 0],
    [1, 0, 0, 0],
    [0.7, 0.1, 0.1, 0.1],
    [0.97, 0.01, 0.01, 0.01],
  ];
  const behavior = [
    [0.25, 0.25, 0.25, 0.25],
    [0.1, 0.2, 0.3, 0.4],
    [0.9, 0.1, 0, 0],
    [1, 0, 0, 0],
    [0.999997, 0.000001, 0.000001, 0.000001],
    [0.6, 0, 0.2, 0.2],
  ];
  const policies = [
    { kind: 'likelihood-power', strength: 16 },
    { kind: 'likelihood-power', strength: 1 },
    { kind: 'likelihood-power', strength: 0 },
    { kind: 'likelihood-power', strength: 0.5 },
    { kind: 'likelihood-power', strength: 400 },
    { kind: 'additive', strength: 3 },
    { kind: 'additive', strength: 0 },
    { kind: 'raw' },
    { kind: 'raw', strength: 7 },
    { kind: 'unknown', strength: 1 },
    { kind: 'likelihood-power', strength: -1 },
    { kind: 'likelihood-power', strength: Infinity },
    // Finite, but large enough to overflow a logit.
    { kind: 'likelihood-power', strength: 1e308 },
    { kind: 'likelihood-power' },
    null,
  ];
  const blends = [0, 0.55, 1, -0.1, 1.1, NaN];
  const invalidVectors = [
    [0.5, 0.5, 0],
    [0.5, 0.6, 0, 0],
    [0.5, 0.5, 0.1, -0.1],
    [0.5, 0.5, NaN, 0],
    'vector',
    // Just outside and just inside the tolerance on the sum.
    [0.25, 0.25, 0.25, 0.25 + 2e-8],
    [0.25, 0.25, 0.25, 0.25 + 5e-9],
  ];
  const goals = [0, 0, 1, 1, 2, 2, 2, 0];
  const worlds = goals.map((goal) => ({ goal }));
  const weights = [0.1, 0.2, 0.05, 0.15, 0.2, 0.1, 0.1, 0.1];
  const target = [0.25, 0.25, 0.5, 0];
  const withFirstWeight = (weight) => [weight, ...weights.slice(1)];
  // Arguments of GoalSignal.reweight: worlds, weights, target probabilities.
  const reweights = [
    [worlds, weights, target],
    [worlds, weights, [0.3, 0.3, 0.4, 0]],
    [worlds, Float64Array.from(weights), [1, 0, 0, 0]],
    // Division before multiplication keeps a tiny goal mass from overflowing.
    [
      [{ goal: 3 }, { goal: 0 }],
      [1e-300, 1 - 1e-300],
      [0.5, 0, 0, 0.5],
    ],
    [
      [{ goal: 3 }, { goal: 0 }],
      [1, 0],
      [0, 0, 0, 1],
    ],
    [worlds, weights, [0.25, 0.25, 0.25, 0.25]],
    [worlds, weights.slice(1), target],
    [null, weights, target],
    [worlds, null, target],
    [worlds, weights, [0.5, 0.5, 0.5, 0]],
    [worlds, weights.map((weight) => weight / 2), target],
    [goals.map(() => ({ goal: 4 })), weights, target],
    [goals.map(() => ({ goal: 1.5 })), weights, target],
    [worlds, withFirstWeight(-0.1), target],
    [worlds, withFirstWeight(NaN), target],
  ];
  return [
    {
      name: 'goal signal: target probabilities and reweighting',
      check(output) {
        const messages = new Set(output.targets.map((result) => result.threw));
        assert.equal(messages.size, 7, 'a result and each of the six reachable rejections');
        assert.equal(output.reweighted.filter((result) => result.value).length, 5);
      },
      run(release) {
        const { targetProbabilities, reweight } = release.GoalSignal;
        const targets = [];
        for (const physical of structural) {
          for (const raw of behavior) {
            for (const policy of policies) {
              for (const blend of blends) {
                targets.push(outcome(() => targetProbabilities(physical, raw, policy, blend)));
              }
            }
          }
        }
        const invalid = invalidVectors.flatMap((vector) => [
          outcome(() => targetProbabilities(vector, behavior[0], policies[0], 0.55)),
          outcome(() => targetProbabilities(structural[0], vector, policies[0], 0.55)),
          outcome(() => reweight(worlds, weights, vector)),
        ]);
        const reweighted = reweights.map((reweightArguments) =>
          outcome(() => reweight(...reweightArguments)),
        );
        return { targets, invalid, reweighted };
      },
    },
  ];
}

// Cheapest first.
function beliefCases() {
  return [
    surfaceCase(),
    hashCase(),
    privateBeliefCase(),
    physicalCase(),
    askConstraintsCase(),
    allocationCase(),
    inventoryWeightsCase(),
    chooseEvidenceCase(),
    eventLogsCase(),
    opponentKnowledgeCase(),
    opponentHistoryCase(),
    ...goalSignalCases(),
  ];
}

module.exports = { beliefCases };
