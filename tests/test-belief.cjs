const assert = require('node:assert/strict');
const { setup, names, boxes, cards, text, icon } = require('./figgie-fixture.cjs');
const { inferFiggie } = require('./reference-model.js');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
const dom = setup();
const fixture = dom.window.FiggieAdapter.read(dom.window.document);
const copy = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'refs' ? undefined : v)));
function snapshot(hand = [3, 2, 2, 3], trades = [], n = 4) {
  const people = n === 4 ? names : ['Alice', 'B', 'C', 'D', 'E'];
  const s = {
    ...copy(fixture),
    self: people[0],
    roundKey: 'test:' + hand + ':' + n,
    startingHand: hand,
    held: hand.slice(),
    trades,
    players: people.map((name) => ({ name, cash: 300 })),
    context: { botDifficulty: 'Medium' },
  };
  s.net = B.physical(s).net;
  s.held = hand.map((v, i) => v + s.net[0][i]);
  s.markets = ['s', 'c', 'd', 'h'].map((id, i) => ({
    id,
    held: s.held[i],
    bid: 3,
    ask: 6,
    buyer: people[2],
    seller: people[1],
    canBuy: true,
    canSell: s.held[i] > 0,
    canBid: true,
    canOffer: s.held[i] > 0,
    canRaiseBid: true,
    canLowerAsk: s.held[i] > 0,
    fills: trades.filter((t) => t.suit === id),
  }));
  s.signature = JSON.stringify([
    hand,
    trades,
    s.markets.map((m) => [m.bid, m.ask, m.buyer, m.seller]),
  ]);
  return s;
}
function normalized(ps) {
  assert(ps.every((p) => p >= 0 && p <= 1));
  assert(Math.abs(ps.reduce((a, b) => a + b, 0) - 1) < 1e-9);
}
const cases = [
  snapshot(),
  snapshot([0, 2, 4, 4]),
  snapshot([5, 0, 0, 5]),
  snapshot(
    [3, 2, 2, 3],
    [
      { suit: 's', s: names[2], b: names[3], p: 4 },
      { suit: 's', s: names[2], b: names[3], p: 5 },
      { suit: 'd', s: names[3], b: names[1], p: 2 },
    ],
  ),
];
let worst = 0;
for (const s of cases) {
  const engine = new B.BeliefEngine();
  const t = performance.now();
  const m = engine.infer(s);
  const exact = inferFiggie(s.markets, {
    hand: s.startingHand,
    players: s.players.map((p) => p.name),
  });
  worst = Math.max(worst, m.computeMs);
  normalized(m.bySuit.map((v) => v.probability));
  m.baseline.probabilities.forEach((p, i) =>
    assert(
      Math.abs(p - exact.bySuit[i].probability) < 1e-9,
      'exact DP must agree with independent enumeration',
    ),
  );
  for (const w of engine.pool.worlds) {
    assert.equal(w.initial.length, s.players.length);
    const totals = [0, 1, 2, 3].map((s) => w.initial.reduce((v, row) => v + row[s], 0));
    assert.deepEqual(
      totals.slice().sort((a, b) => a - b),
      [8, 10, 10, 12],
    );
    assert.equal(w.goal, totals.indexOf(12) ^ 1);
    for (let actor = 0; actor < s.players.length; actor++) {
      assert.equal(
        w.initial[actor].reduce((a, b) => a + b, 0),
        40 / s.players.length,
      );
      w.initial[actor].forEach((v, i) => assert(v >= engine.state.minimum[actor][i]));
    }
  }
  assert(Math.abs(m.expectedPayout - m.expectedBase - m.expectedBonus) < 1e-9);
  for (const market of Object.values(m.resting))
    for (const r of Object.values(market)) {
      assert(r.pFill >= 0 && r.pFill <= 1);
      assert(Math.abs(r.ev - r.pFill * r.conditionalEdge) < 1e-9);
      assert(Math.abs(r.counterparties.reduce((v, p) => v + p.probability, 0) - 1) < 1e-8);
    }
}
const s = snapshot();
const engine = new B.BeliefEngine();
const baseline = engine.infer(s);
const event = {
  kind: 'take',
  actor: names[2],
  direction: 'buy',
  suit: 'c',
  price: 12,
  epoch: 0,
  at: 10,
  net: s.net,
  anchor: 5,
};
const aware = engine.infer(s, [event]);
assert(
  aware.bySuit[1].probability > baseline.bySuit[1].probability,
  'rational-looking purchase should shift beliefs conservatively',
);
assert(aware.behavior.provisional);
assert.equal(aware.behavior.blend, 0.55);
assert.equal(aware.behavior.validation.holdoutRounds, 8);
const self = engine.infer(s, [{ ...event, actor: s.self }]);
self.bySuit.forEach((v, i) =>
  assert(
    Math.abs(v.probability - baseline.bySuit[i].probability) < 1e-12,
    'own choices cannot confirm themselves',
  ),
);
const pennies = Array.from({ length: 20 }, (_, i) => ({
  ...event,
  kind: 'quote',
  price: i + 1,
  at: i,
}));
const many = engine.infer(s, pennies);
const last = engine.infer(s, [pennies.at(-1)]);
many.bySuit.forEach((v, i) =>
  assert(
    Math.abs(v.probability - last.bySuit[i].probability) < 1e-12,
    'repeated pennies count as one evolving episode',
  ),
);
const disabled = engine.infer(s, [event], { forceBaseline: true });
disabled.bySuit.forEach((v, i) =>
  assert(Math.abs(v.probability - baseline.bySuit[i].probability) < 1e-9),
);
const high = copy(s);
high.markets[0].bid = 8;
const better = engine.infer(high, [event]);
assert(
  better.resting.s.bid.pFill > aware.resting.s.bid.pFill,
  'higher bid increases modeled seller willingness',
);
const poor = snapshot();
poor.players.slice(1).forEach((p) => (p.cash = 0));
assert.equal(engine.infer(poor).resting.s.ask.pFill, 0);
const five = snapshot([2, 2, 2, 2], [], 5);
const fiveEngine = new B.BeliefEngine();
const fiveModel = fiveEngine.infer(five);
fiveModel.baseline.probabilities.forEach((p) => assert(Math.abs(p - 0.25) < 1e-9));
normalized(fiveModel.bySuit.map((v) => v.probability));
// Journal replay, censored observations, durable metadata restoration and scoring.
const raw = [];
const j = new J.RoundJournal('test-round', 'base', (e) => raw.push(copy(e)));
j.observe(s, 1000);
const noPennies = copy(s);
noPennies.markets[1].bid = 4;
noPennies.signature = 'bid4';
j.observe(noPennies, 1500);
const inferred = engine.infer(noPennies, j.evidence);
j.prediction(inferred, 1600);
const restored = J.restore(
  {
    id: j.id,
    base: j.base,
    seq: j.seq,
    snapshot: j.previous,
    observedAt: j.at,
    rates: j.rates,
    cursors: { a: 2 },
  },
  raw,
);
const replayed = J.replay(raw);
assert.deepEqual(
  replayed.markets.map((m) => [m.bid, m.ask, m.buyer, m.seller]),
  j.previous.markets.map((m) => [m.bid, m.ask, m.buyer, m.seller]),
);
const replayModel = new B.BeliefEngine().infer(replayed, restored.evidence);
inferred.bySuit.forEach((v, i) =>
  assert(
    Math.abs(v.probability - replayModel.bySuit[i].probability) < 1e-12,
    'replay reproduces posterior',
  ),
);
assert.equal(J.scoreRound(j), null);
j.reveal({ goal: 'c', source: 'test-reveal' }, 2000);
const score = J.scoreRound(j);
assert.equal(score.checkpoints, 1);
assert(Number.isFinite(score.opponentBrier));
const count = j.predictions.length;
j.prediction(inferred, 20000);
assert.equal(j.predictions.length, count, 'never score predictions after reveal');
assert.equal(j.reveal({ goal: 's' }, 21000), false, 'reveal only counted once');
const recovered = new J.RoundJournal('recovered', 'b');
recovered.observe(cases[3], 9000);
assert(
  recovered.events
    .filter((e) => e.kind === 'fill')
    .every((e) => e.recovered && !e.executionTimeKnown),
);
assert.equal(
  recovered.rates.resets,
  0,
  'historical timestamps are not fabricated for hazard training',
);
// End-of-round hands are only read after an explicit end marker.
const doc = dom.window.document;
const final = [
  [3, 4, 4, 0],
  [3, 2, 1, 3],
  [3, 2, 3, 2],
  [3, 2, 2, 3],
];
for (let i = 1; i < 4; i++) {
  const card = [...doc.querySelectorAll('header')].find((n) =>
    n.textContent.startsWith(names[i]),
  ).parentElement;
  card.querySelector('svg[id^=purple_cards_]').remove();
  const group = doc.createElement('div');
  group.innerHTML = final[i]
    .map((n, s) => `<div>${text(n)}${icon(cards[s] + '_card_final', '0 0 60 90')}</div>`)
    .join('');
  card.append(group);
}
assert.equal(
  dom.window.FiggieAdapter.readSettlement(doc, fixture),
  null,
  'do not read unrevealed hands',
);
const ended = doc.createElement('div');
ended.dir = 'auto';
ended.textContent = 'Round Ended';
doc.getElementById('root').append(ended);
const result = dom.window.FiggieAdapter.readSettlement(doc, fixture);
assert.equal(result.goal, 'c');
assert.deepEqual(Array.from(result.deckTotals), [12, 10, 10, 8]);
const times = [];
for (let i = 0; i < 8; i++) {
  const t = performance.now();
  engine.infer(s, [event]);
  times.push(performance.now() - t);
}
dom.window.close();
console.log(
  JSON.stringify(
    {
      exactBaseline: 'matches independent four-player enumeration',
      physicalConservation: 'passed',
      selfEcho: 'excluded',
      pennyDoubleCounting: 'excluded',
      behaviorEvidence: 'direction and normalization passed',
      fillAdjustedEV: 'probability and conditional payoff consistent',
      selection: 'price and affordability sensitive',
      fivePlayers: 'exact physical odds + sampled payoffs',
      replay: 'posterior reproduced',
      calibration: 'pre-reveal only; one result per round',
      recoveredHistory: 'no fake timing',
      settlement: 'explicit reveal only',
      cachedMs: times.map((v) => +v.toFixed(1)),
      coldWorstMs: +worst.toFixed(1),
    },
    null,
    2,
  ),
);
