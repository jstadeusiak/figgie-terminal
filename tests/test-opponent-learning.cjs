'use strict';
const assert = require('node:assert/strict');
const B = require('../extension/belief.js');
const T = require('../extension/training.js');
const IDS = ['s', 'c', 'd', 'h'];
const names = ['You', 'A', 'B', 'C'];
const copy = (x) => JSON.parse(JSON.stringify(x));
const close = (a, b, eps = 1e-10) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const same = (a, b, eps = 1e-10) => a.forEach((v, i) => close(v, b[i], eps));
function snapshot(trades = [], players = names) {
  return {
    roundKey: 'public-learning-test',
    self: players[0],
    players: players.map((name) => ({ name, cash: 350 })),
    trades,
    startingHand: [3, 2, 2, 3],
    held: [3, 2, 2, 3],
    context: { botDifficulty: 'Medium' },
    markets: [],
  };
}
function knowledge(s, events = [], options = {}) {
  const k = new B.OpponentKnowledge(options);
  k.prepare(s, events);
  return k;
}
function event(k, extra = {}) {
  return {
    kind: 'take',
    actor: names[1],
    suit: 'h',
    direction: 'buy',
    price: 8,
    epoch: k.trades.length,
    net: copy(k.nets.at(-1)),
    sourceSeq: 100,
    at: 1000,
    ...extra,
  };
}
function revealTrades(hands, actors = hands.map((_, p) => p)) {
  const trades = [];
  for (const p of actors) {
    const other = (p + 1) % hands.length;
    for (let s = 0; s < 4; s++)
      for (let i = 0; i < hands[p][s]; i++)
        trades.push({ s: names[p], b: names[other], suit: IDS[s], p: 3 });
    for (let s = 0; s < 4; s++)
      for (let i = 0; i < hands[p][s]; i++)
        trades.push({ s: names[other], b: names[p], suit: IDS[s], p: 3 });
  }
  return trades;
}

// Opening goal marginals are exact, even though bonus allocations are sampled.
for (const [hand, players] of [
  [[6, 2, 1, 1], names],
  [
    [2, 2, 2, 2],
    [...names, 'D'],
  ],
]) {
  const k = knowledge(snapshot([], players));
  const p = k.posterior(hand, 1, k.prefix()).pool;
  same(p.probabilities, B.privateBelief(hand).goals);
  for (let i = 0; i < p.packed.length; i++)
    for (let j = 0; j < players.length; j++)
      assert(((p.packed[i] >>> (4 * j)) & 15) <= 40 / players.length);
}

// Partial public floors are integrated exactly too, independently of the
// conditional bonus sample budget. Compare the separate suit-allocation DP.
for (const n of [4, 5]) {
  const people = n === 4 ? names : [...names, 'D'];
  const hand = n === 4 ? [2, 2, 3, 3] : [2, 2, 2, 2];
  const trades = [];
  for (const [p, s, count] of [
    [1, 3, 3],
    [2, 2, 2],
    [3, 0, 2],
  ])
    for (let i = 0; i < count; i++) trades.push({ s: people[p], b: people[0], suit: IDS[s], p: 3 });
  const s = snapshot(trades, people);
  s.startingHand = hand;
  s.held = hand.map((v, j) => v + trades.filter((t) => t.suit === IDS[j]).length);
  const independent = new B.BeliefEngine({ samples: 8 });
  independent.build(s);
  const exact = [0, 0, 0, 0];
  for (const c of independent.pool.configurations) exact[c.goal] += c.probability;
  for (const samples of [8, 24, 128]) {
    const k = knowledge(s, [], { samples });
    same(k.posterior(hand, 0, k.prefix()).pool.probabilities, exact);
  }
}

// Selling and subsequently rebuying a starting hand leaves a persistent public
// lower bound. It must match independent exact known-hand enumeration.
const hands = [
  [2, 2, 3, 3],
  [2, 2, 2, 4],
  [3, 3, 3, 1],
  [3, 3, 4, 0],
];
const one = knowledge(snapshot(revealTrades(hands, [2])));
const onePrefix = one.prefix();
assert.deepEqual(onePrefix.lower[2], hands[2]);
assert(onePrefix.net.every((r) => r.every((v) => v === 0)));
same(
  one.posterior(hands[0], 0, onePrefix).pool.probabilities,
  T.knownHandProbabilities({ You: hands[0], B: hands[2] }).probabilities,
);
assert(
  one.posterior([0, 0, 0, 10], 2, onePrefix) === null,
  'impossible candidate starting hand must be rejected',
);

// Fully public counts make actual peer lead and tie transfers exact. No peer
// identity would mean averaging only counterparties with cards to sell.
const full = knowledge(snapshot(revealTrades(hands)));
const prefix = full.prefix();
same(full.posterior(hands[0], 0, prefix).pool.probabilities, [0, 0, 0, 1]);
const value = (actor, buy, counterparty) =>
  full.value(hands[actor], actor, null, { prefix, suit: 3, buy, counterparty });
close(value(0, true, 1).total, 130); // 3 vs 4 becomes 4 vs 3: take the entire bonus.
close(value(0, true, 2).total, 70); // 3 vs 4 becomes 4 vs 4: take half the bonus.
close(value(0, true, -1).total, 100); // Only A and B have hearts available.
close(value(1, false, 0).total, 130); // Giving the nearest rival a card reverses lead.
close(value(1, false, 2).total, 70); // Selling elsewhere creates a tie with You.
close(value(0, false, 1).total, 10);
assert(value(0, true, 1).knownCounterparty);
assert(!value(0, true, -1).knownCounterparty);

// Causal cut: neither later fills nor later same-epoch asks inform an earlier
// choice. An ask itself is evidence of ownership only for subsequent choices.
const empty = knowledge(snapshot());
const past = event(empty, { epoch: 0, sourceSeq: 10 });
const futureTrades = Array.from({ length: 3 }, () => ({ s: 'B', b: 'C', suit: 'h', p: 3 }));
const future = knowledge(snapshot(futureTrades));
const earlyAsk = {
  ...past,
  kind: 'quote',
  actor: 'B',
  suit: 'd',
  direction: 'sell',
  sourceSeq: 9,
  at: 900,
};
const lateAsk = { ...past, kind: 'quote', actor: 'C', suit: 'c', direction: 'sell', sourceSeq: 11 };
const coObservedAsk = {
  ...past,
  kind: 'quote',
  actor: 'C',
  suit: 's',
  direction: 'sell',
  sourceSeq: 8,
};
future.prepare(snapshot(futureTrades), [lateAsk, earlyAsk, coObservedAsk]);
assert.equal(future.prefix(past).lower[2][2], 1);
assert.equal(future.prefix(past).lower[3][1], 0);
assert.equal(future.prefix(past).lower[2][3], 0);
assert.equal(
  future.prefix(past).lower[3][0],
  0,
  'same-observation append order cannot establish quote chronology',
);
assert.equal(future.before(coObservedAsk, past), false);
assert.equal(future.before(past, coObservedAsk), false);
const earlyOnly = knowledge(snapshot(), [earlyAsk]);
same(
  future.value(hands[1], 1, past).probabilities,
  earlyOnly.value(hands[1], 1, past).probabilities,
);
const later = event(future, { sourceSeq: 30 });
assert.equal(future.prefix(later).lower[2][3], 3);
const passive = { ...past, passive: true, sourceSeq: 12 };
assert.equal(
  future.prefix(passive).lower[2][2],
  0,
  'uncaptured resting decision must not use later same-epoch asks',
);
const recovered = { ...past, recovered: true, sourceSeq: 12 };
assert.equal(future.prefix(recovered).lower[2][2], 0);
assert.equal(future.prefix(earlyAsk).lower[2][2], 0, 'quote cannot inform itself');

// Actual visible/hidden hands, viewer identity or a settled goal never enter
// opponent conditional beliefs. Only candidate hand and public data do.
const leaked = snapshot(futureTrades);
leaked.startingHand = [10, 0, 0, 0];
leaked.held = [99, 99, 99, 99];
leaked.goal = 'h';
leaked.training = {
  startingHands: Object.fromEntries(names.map((n, p) => [n, hands[p]])),
  exactGoal: 'h',
};
leaked.players[2].hand = hands[2];
const blind = knowledge(leaked, [lateAsk, earlyAsk]);
same(blind.value(hands[1], 1, past).probabilities, future.value(hands[1], 1, past).probabilities);
close(blind.value(hands[1], 1, past).total, future.value(hands[1], 1, past).total);
// The actual seller is known for a take. Passive fills still use an unknown
// counterparty because the poster could not know the future taker.
const passiveValue = full.value(
  hands[0],
  0,
  event(full, {
    actor: 'You',
    passive: true,
    counterparty: 'A',
    counterpartyKnownBeforeAction: false,
  }),
);
close(passiveValue.total, 100);
close(
  full.value(
    hands[0],
    0,
    event(full, { actor: 'You', counterparty: 'A', counterpartyKnownBeforeAction: true }),
  ).total,
  130,
);

// Reusing a logically identical information set neither resamples nor allocates
// another pool. Private own-hand knowledge dominates own public lower bounds.
const reusable = knowledge(snapshot());
const rp = reusable.prefix();
const p0 = reusable.posterior(hands[0], 0, rp).pool;
const ownFloor = { ...rp, lower: rp.lower.map(copy) };
ownFloor.lower[0] = hands[0];
assert.equal(reusable.posterior(hands[0], 0, ownFloor).pool, p0);
assert.equal(
  reusable.posterior(hands[0], 1, rp).pool,
  p0,
  'equivalent actor hands reuse canonical physical pools',
);
const bounded = knowledge(snapshot(), [], { maxEntries: 2 });
for (const h of [
  [2, 2, 3, 3],
  [3, 2, 3, 2],
  [3, 3, 2, 2],
])
  bounded.posterior(h, 0, bounded.prefix());
assert.equal(bounded.cache.size, 2);

// New behavioral likelihoods cannot alter the exact physical baseline. Repeats
// and a clean engine reproduce the same posterior without a hidden RNG state.
const s = snapshot();
s.markets = IDS.map((id) => ({
  id,
  bid: 3,
  ask: 6,
  buyer: 'A',
  seller: 'B',
  canBid: true,
  canOffer: true,
  canRaiseBid: true,
  canLowerAsk: true,
}));
const e = event(knowledge(s), { counterparty: 'B', counterpartyKnownBeforeAction: true });
const legacy = new B.BeliefEngine({
  samples: 32,
  skipPricing: true,
  opponentLearning: false,
}).infer(s, [e]);
const engine = new B.BeliefEngine({ samples: 32, skipPricing: true, opponentLearning: true });
const first = engine.infer(s, [e]);
const builds = engine.knowledge.stats.builds;
const second = engine.infer(s, [e]);
const clean = new B.BeliefEngine({ samples: 32, skipPricing: true, opponentLearning: true }).infer(
  s,
  [e],
);
same(first.baseline.probabilities, legacy.baseline.probabilities);
same(
  first.bySuit.map((s) => s.probability),
  second.bySuit.map((s) => s.probability),
);
same(
  first.bySuit.map((s) => s.probability),
  clean.bySuit.map((s) => s.probability),
);
assert.equal(engine.knowledge.stats.builds, builds);
const quote = { ...e, kind: 'quote', direction: 'sell', sourceSeq: 1 };
const consent = { ...quote, kind: 'consent', passive: true, sourceSeq: 2 };
assert.equal(
  B.chooseEvidence([quote, consent], 'You')[0],
  quote,
  'captured resting quote keeps its original information cut',
);
console.log(
  JSON.stringify(
    {
      openingGoalMarginals: 'exact 4p/5p',
      publicGoalMarginals: 'match independent allocation DP at every sample budget',
      publicInitialHands: 'matches independent enumeration',
      causality: 'future fills/asks and passive timing excluded',
      hiddenInformation: 'excluded',
      counterpartyTransfers: 'lead/tie and available-peer mixture exact',
      baseline: 'unchanged',
      replay: 'deterministic',
      cache: 'bounded and shared',
    },
    null,
    2,
  ),
);
