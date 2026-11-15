const assert = require('node:assert/strict');
const B = require('../extension/belief.js');
const Old = require('../extension/belief-v0.5.js');
const near = (a, b, tolerance = 1e-9) => assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function snapshot(hand, n = 4) {
  const names = Array.from({ length: n }, (_, i) => (i ? 'Bot-' + i : 'You'));
  return {
    self: 'You',
    status: 'live',
    timer: '1:00',
    cash: 300,
    roundKey: 'inventory-test',
    startingHand: hand,
    held: hand.slice(),
    players: names.map((name) => ({ name, cash: 300 })),
    trades: [],
    context: { botDifficulty: 'Medium' },
    markets: B.IDS.map((id) => ({
      id,
      bid: 2,
      ask: 9,
      buyer: names[2],
      seller: names[1],
      canBid: true,
      canOffer: true,
      canRaiseBid: true,
      canLowerAsk: true,
      fills: [],
    })),
  };
}

// Independently enumerate a tiny labeled-card deal, rather than deriving the
// expected distribution from the DP or its sampler implementation.
const remaining = [3, 2, 2, 2];
const lower = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];
const counts = new Map();
let assignments = 0;
let valid = 0;
const cards = remaining.flatMap((n, s) => Array(n).fill(s));
const hands = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
const sizes = [0, 0, 0];
function enumerate(i) {
  if (i === cards.length) {
    assignments++;
    if (hands.some((h, p) => h.some((v, s) => v < lower[p][s]))) return;
    valid++;
    const key = hands.flat().join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
    return;
  }
  for (let p = 0; p < 3; p++) {
    if (sizes[p] === 3) continue;
    sizes[p]++;
    hands[p][cards[i]]++;
    enumerate(i + 1);
    hands[p][cards[i]]--;
    sizes[p]--;
  }
}
enumerate(0);
const dp = B.allocationDP(remaining, lower, 3);
near(dp.mass, valid / assignments);
let seed = 111;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const observed = new Map();
const draws = 60000;
for (let i = 0; i < draws; i++) {
  const h = dp.sample(random);
  const key = h.flat().join(',');
  assert(counts.has(key), 'sample must satisfy every hard constraint');
  observed.set(key, (observed.get(key) || 0) + 1);
}
let totalVariation = 0;
for (const [key, n] of counts)
  totalVariation += Math.abs(n / valid - (observed.get(key) || 0) / draws) / 2;
assert(
  totalVariation < 0.035,
  'sampled hidden deals should match independently enumerated random deals',
);

// Split leadership into sole, tied and no bonus. These cases form a partition,
// while the floor uses rules, not Monte Carlo support or a confidence interval.
for (const hand of [
  [4, 2, 3, 1],
  [5, 2, 2, 1],
  [6, 2, 1, 1],
  [0, 2, 4, 4],
  [2, 2, 2, 2],
]) {
  const s = snapshot(hand, hand.reduce((a, b) => a + b, 0) === 8 ? 5 : 4);
  const engine = new B.BeliefEngine({ signalPolicy: B.DEFAULT_SIGNALS });
  const m = engine.infer(s);
  const legacy = new B.BeliefEngine({
    signalPolicy: B.DEFAULT_SIGNALS,
    goalStratified: false,
    referenceEss: false,
  }).infer(s);
  const old = new Old.BeliefEngine({ signalPolicy: B.DEFAULT_SIGNALS }).infer(s);
  for (let i = 0; i < 4; i++) {
    const item = m.bySuit[i];
    near(item.probability, old.bySuit[i].probability, 1e-12);
    near(legacy.bySuit[i].holding, old.bySuit[i].holding);
    near(item.base, 10 * item.probability);
    if (!item.probability) continue;
    near(
      item.conditionalSoloProbability +
        item.conditionalTieProbability +
        item.conditionalNoBonusProbability,
      1,
    );
    near(
      item.conditionalLeaderProbability,
      item.conditionalSoloProbability + item.conditionalTieProbability,
    );
    near(item.conditionalBasePayout, 10 * s.held[i]);
    assert(item.conditionalPayout + 1e-9 >= item.conditionalPayoutFloor);
    assert(item.conditionalPayoutFloor >= item.conditionalBasePayout);
    if (s.held[i] === 0) {
      near(item.conditionalNoBonusProbability, 1);
      near(item.conditionalPayoutFloor, 0);
    }
    if (s.held[i] === 5) {
      near(item.conditionalNoBonusProbability, 0);
      assert(item.conditionalPayoutFloor >= 100);
    }
    if (s.held[i] === 6) {
      near(item.conditionalSoloProbability, 1);
      assert(item.conditionalPayoutFloor >= 160);
    }
    for (const value of Object.values(item.counterparties)) {
      if (value.buy !== null) {
        near(value.buy, value.buyBase + value.buyBonus);
        assert(value.buyBase >= 0 && value.buyBase <= 10 + 1e-9);
        assert(value.buyBonus >= -1e-9);
      }
      near(value.sell, value.sellBase + value.sellBonus);
      assert(value.sellBonus >= -1e-9);
    }
    for (const quote of Object.values(m.resting[B.IDS[i]])) {
      near(quote.conditionalEdge, quote.conditionalBaseEdge + quote.conditionalBonusEdge);
      near(quote.ev, quote.pFill * quote.conditionalEdge);
    }
  }
}

// A seller's ability to deliver a card changes the probability conditional on
// that execution. The decomposition must use that posterior, not raw 10P(goal).
const s = snapshot([4, 2, 3, 1]);
const engine = new B.BeliefEngine();
const m = engine.infer(s);
let mass = 0;
let goalMass = 0;
engine.latest.worlds.forEach((w, i) => {
  if (w.initial[1][0] > 0) {
    mass += engine.latest.weights[i];
    if (w.goal === 0) goalMass += engine.latest.weights[i];
  }
});
near(m.bySuit[0].buyBase, (10 * goalMass) / mass);
near(m.bySuit[0].sellBase, 10 * m.bySuit[0].probability);
console.log(
  JSON.stringify(
    {
      independentDealEnumeration: { valid, assignments, totalVariation },
      leadershipPartition: 'sole/tie/no bonus passed',
      hardPayoutFloor: 'zero/five/six cards passed',
      valueDecomposition: 'current immediate and fill-conditional posted trades reconcile',
      historicalProbabilityAndValue: 'legacy sampler unchanged at matched signal policy',
    },
    null,
    2,
  ),
);
