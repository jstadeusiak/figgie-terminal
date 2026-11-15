const assert = require('node:assert/strict');
const B = require('../extension/belief.js');
const Old = require('../extension/belief-v0.6.js');
const near = (a, b, t = 1e-9) => assert(Math.abs(a - b) < t, `${a} != ${b}`);
const sum = (a) => a.reduce((a, b) => a + b, 0);
function snapshot(hand = [4, 2, 3, 1], n = 4, difficulty = 'Medium') {
  const names = Array.from({ length: n }, (_, i) => (i ? 'Bot-' + i : 'You'));
  return {
    self: 'You',
    status: 'live',
    roundKey: 'v07-test',
    cash: 300,
    startingHand: hand,
    held: hand.slice(),
    players: names.map((name) => ({ name, cash: 300 })),
    trades: [],
    context: { botDifficulty: difficulty },
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
function trade(s, suit, buyer, seller) {
  s.trades.push({ suit, b: buyer, s: seller, p: 3 });
  const i = B.IDS.indexOf(suit);
  if (buyer === s.self) s.held[i]++;
  if (seller === s.self) s.held[i]--;
  s.net = B.physical(s).net;
}
function ask(s, actor = 'Bot-1', suit = 's') {
  return {
    kind: 'quote',
    direction: 'sell',
    actor,
    suit,
    price: 4,
    epoch: s.trades.length,
    net: B.physical(s).net,
    recovered: false,
  };
}
const s = snapshot();
const q = ask(s);
const engine = new B.BeliefEngine({ skipPricing: true });
const m = engine.infer(s, [q]);
assert.equal(engine.state.minimum[1][0], 1);
assert(engine.latest.worlds.every((w) => w.initial[1][0] >= 1));
assert.equal(m.inventoryEvidence.qualifiedAsks, 1);
for (const invalid of [
  { ...q, recovered: true },
  { ...q, epoch: 1 },
  { ...q, price: 0 },
  { ...q, net: q.net.map((r, i) => r.map((v, j) => (i === 1 && j === 0 ? 1 : v))) },
]) {
  const e = new B.BeliefEngine({ skipPricing: true });
  e.infer(s, [invalid]);
  assert.equal(
    e.state.minimum[1][0],
    0,
    'untrusted or misaligned quote must not constrain holdings',
  );
}
const later = snapshot();
trade(later, 's', 'You', 'Bot-1');
trade(later, 's', 'You', 'Bot-1');
const historical = ask(later);
trade(later, 'c', 'Bot-2', 'You');
const laterEngine = new B.BeliefEngine({ skipPricing: true });
laterEngine.infer(later, [historical]);
assert.equal(
  laterEngine.state.minimum[1][0],
  3,
  'historical asks retain information after later trades',
);
const conflict = snapshot([10, 0, 0, 0]);
const conflictEngine = new B.BeliefEngine({ skipPricing: true });
const fallback = conflictEngine.infer(
  conflict,
  ['Bot-1', 'Bot-2', 'Bot-3'].map((name) => ask(conflict, name)),
);
assert(fallback.inventoryEvidence.fallback);
assert(conflictEngine.state.minimum.slice(1).every((row) => row[0] === 0));
near(sum(fallback.bySuit.map((s) => s.probability)), 1);
// Explicit legacy sampling preserves the historical starting-deal contract.
// The current default sampler remains covered by all calibration checks below.
const before = new B.BeliefEngine({
  skipPricing: true,
  goalStratified: false,
  referenceEss: false,
}).infer(s);
const oldBefore = new Old.BeliefEngine({ skipPricing: true }).infer(s);
before.bySuit.forEach((x, i) => {
  near(x.probability, oldBefore.bySuit[i].probability);
  near(x.holding, oldBefore.bySuit[i].holding);
});
trade(s, 's', 'Bot-1', 'You');
const modern = new B.BeliefEngine();
const oldEngine = new Old.BeliefEngine();
const newModel = modern.infer(s);
const old = oldEngine.infer(s);
assert(newModel.inventoryCalibration.active);
newModel.bySuit.forEach((x, i) => {
  near(x.probability, old.bySuit[i].probability);
  near(
    x.conditionalSoloProbability + x.conditionalTieProbability + x.conditionalNoBonusProbability,
    1,
  );
  assert(x.conditionalPayout + 1e-9 >= x.conditionalPayoutFloor);
  for (const p of Object.values(x.counterparties)) {
    if (p.buy !== null) near(p.buy, p.buyBase + p.buyBonus);
    near(p.sell, p.sellBase + p.sellBonus);
  }
  for (const p of Object.values(newModel.resting[B.IDS[i]])) {
    near(p.ev, p.pFill * p.conditionalEdge);
    near(p.conditionalEdge, p.conditionalBaseEdge + p.conditionalBonusEdge);
  }
});
assert(
  Math.abs(newModel.bySuit[0].conditionalBonus - old.bySuit[0].conditionalBonus) > 0.1,
  'opponent accumulation should affect the hidden inventory estimate',
);
// Reweighting must preserve each goal marginal, even under extreme concentration.
const adjusted = B.inventoryWeights(
  oldEngine.latest.worlds,
  oldEngine.latest.weights,
  B.physical(s).net,
  50,
  64,
);
for (let g = 0; g < 4; g++) {
  near(
    sum(adjusted.weights.filter((_, i) => oldEngine.latest.worlds[i].goal === g)),
    old.bySuit[g].probability,
  );
  const d = adjusted.goals[g];
  if (d.probability) assert(d.effectiveAfter + 1e-7 >= Math.min(64, d.effectiveBefore));
}
assert(adjusted.weights.every((v) => Number.isFinite(v) && v >= 0));
for (const other of [
  snapshot([4, 2, 3, 1], 4, 'Easy'),
  snapshot([2, 2, 2, 2], 5, 'Medium'),
  snapshot([4, 2, 3, 1], 4, ''),
]) {
  if (!other.context.botDifficulty) delete other.context.botDifficulty;
  trade(other, 's', 'Bot-1', 'You');
  assert.equal(
    new B.BeliefEngine({ skipPricing: true }).infer(other).inventoryCalibration.active,
    false,
  );
}
const human = snapshot();
human.players[1].name = 'Alice';
assert.equal(
  new B.BeliefEngine({ skipPricing: true }).infer(human).inventoryCalibration.active,
  false,
);
assert.equal(
  new B.BeliefEngine({ skipPricing: true }).infer(s, [], { forceBaseline: true })
    .inventoryCalibration.active,
  false,
);
console.log(
  'v0.7 inventory: aligned historical asks, invalid evidence rejection, conflict fallback, preserved goal marginals, unchanged opening values, coherent bonus/trade pricing, ESS guard and 4-player Medium-only scope passed.',
);
