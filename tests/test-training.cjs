const assert = require('node:assert/strict');
const B = require('../extension/belief.js');
const T = require('../extension/training.js');
const near = (a, b, t = 1e-11) => assert(Math.abs(a - b) < t, `${a} != ${b}`);
const sum = (a) => a.reduce((a, b) => a + b, 0);
const clone = (x) => JSON.parse(JSON.stringify(x));
function fixture(n = 4) {
  const names = Array.from({ length: n }, (_, i) => (i ? 'Bot-' + i : 'You'));
  const hands =
    n === 4
      ? [
          [3, 3, 2, 2],
          [3, 3, 2, 2],
          [3, 2, 3, 2],
          [3, 2, 3, 2],
        ]
      : [
          [3, 2, 2, 1],
          [3, 2, 2, 1],
          [2, 2, 2, 2],
          [2, 2, 2, 2],
          [2, 2, 2, 2],
        ];
  const map = Object.fromEntries(names.map((name, i) => [name, hands[i]]));
  return {
    status: 'live',
    self: 'You',
    cash: 250,
    startingHand: hands[0].slice(),
    held: hands[0].slice(),
    players: names.map((name) => ({
      name,
      cash: 250,
      color: 'blue',
      cards: 40 / n,
      observedNet: [0, 0, 0, 0],
    })),
    net: names.map(() => [0, 0, 0, 0]),
    trades: [],
    context: { botDifficulty: 'Medium', learningMode: true },
    roundKey: 'test-training',
    timer: '3:00',
    round: 1,
    room: 'Practice',
    signature: 'raw signature with training truth',
    markets: B.IDS.map((id) => ({
      id,
      bid: 4,
      ask: 7,
      buyer: names[1],
      seller: names[1],
      canBuy: true,
      canSell: true,
      canBid: true,
      canOffer: true,
      canRaiseBid: true,
      canLowerAsk: true,
      fills: [],
    })),
    training: {
      enabled: true,
      handsVisible: true,
      valid: true,
      hands: clone(map),
      startingHands: clone(map),
      deckTotals: [12, 10, 10, 8],
    },
  };
}
function trade(s, suit, buyer, seller, price) {
  const index = B.IDS.indexOf(suit);
  const a = s.players.findIndex((p) => p.name === buyer);
  const b = s.players.findIndex((p) => p.name === seller);
  s.trades.push({ suit, b: buyer, s: seller, p: price });
  s.training.hands[buyer][index]++;
  s.training.hands[seller][index]--;
  s.net[a][index]++;
  s.net[b][index]--;
  s.players[a].cash -= price;
  s.players[b].cash += price;
  s.held = s.training.hands[s.self].slice();
  s.cash = s.players.find((p) => p.name === s.self).cash;
  s.markets.find((m) => m.id === suit).fills.push(s.trades.at(-1));
}
function freeze(x) {
  if (x && typeof x === 'object') {
    Object.freeze(x);
    Object.values(x).forEach(freeze);
  }
  return x;
}
for (const n of [4, 5]) {
  const s = fixture(n);
  const blind = new B.BeliefEngine({ skipPricing: true }).infer(T.blindSnapshot(s));
  const before = JSON.stringify(s);
  const modelBefore = JSON.stringify(blind);
  const a = T.analyze(freeze(s), freeze(blind));
  assert(a.available);
  assert.equal(a.exactGoal, 'c');
  assert.deepEqual(a.exactProbabilities, [0, 1, 0, 0]);
  near(sum(a.players.map((p) => p.settlement.total)), 200);
  near(sum(a.players.map((p) => p.roundPnl)), 0);
  assert.equal(a.asOfTradeCount, 0);
  assert.equal(a.roundKey, s.roundKey);
  assert.equal(a.noFutureTrades, true);
  assert.equal(Object.keys(a.knownHandSets).length, 2 ** (n - 1));
  assert(!Object.hasOwn(a.knownHandSets, 0));
  for (const [mask, k] of Object.entries(a.knownHandSets)) {
    assert(Number(mask) & 1);
    assert(k.knownPlayers.includes('You'));
    near(sum(k.probabilities), 1);
  }
  for (const p of a.players) {
    const subset = T.knownHandProbabilities({ [p.name]: p.startingHand }, { playerCount: n });
    assert(subset.available);
    subset.probabilities.forEach((v, i) => near(v, B.privateBelief(p.startingHand).goals[i]));
    p.handOdds.forEach((v, i) => near(v, subset.probabilities[i]));
  }
  const all = T.knownHandProbabilities(s.training.startingHands, { playerCount: n });
  assert.deepEqual(all.probabilities, [0, 1, 0, 0]);
  const two = Object.fromEntries(Object.entries(s.training.startingHands).slice(0, 2));
  const forward = T.knownHandProbabilities(two, { playerCount: n });
  const reverse = T.knownHandProbabilities(Object.fromEntries(Object.entries(two).reverse()), {
    playerCount: n,
  });
  forward.probabilities.forEach((v, i) => near(v, reverse.probabilities[i]));
  assert.equal(JSON.stringify(s), before);
  assert.equal(JSON.stringify(blind), modelBefore);
}
// Every legal deck placement must identify the opposite suit of the12-card suit.
for (const n of [4, 5])
  for (const deck of B.DECKS) {
    const s = fixture(n);
    const remaining = deck.deck.slice();
    const hands = s.players.map(() => [0, 0, 0, 0]);
    let suit = 0;
    for (const hand of hands)
      for (let card = 0; card < 40 / n; card++) {
        while (!remaining[suit]) suit++;
        hand[suit]++;
        remaining[suit]--;
      }
    const initial = Object.fromEntries(s.players.map((p, i) => [p.name, hands[i]]));
    s.training.startingHands = clone(initial);
    s.training.hands = clone(initial);
    s.training.deckTotals = deck.deck.slice();
    s.startingHand = hands[0].slice();
    s.held = hands[0].slice();
    const result = T.analyze(s);
    assert(result.available);
    assert.equal(result.exactGoal, B.IDS[deck.goal]);
    assert.deepEqual(
      result.exactProbabilities,
      T.knownHandProbabilities(initial, { playerCount: n }).probabilities,
    );
    near(sum(result.players.map((p) => p.settlement.total)), 200);
  }
const s = fixture();
const a = T.analyze(s);
assert.equal(a.settlement.total, 80);
assert.equal(a.settlement.bonus, 50);
assert.deepEqual(a.settlement.leaders, ['You', 'Bot-1']);
const club = a.bySuit[1];
assert.equal(club.buy, 60);
assert.equal(club.sell, 60);
assert.equal(club.buyEdge, 53);
assert.equal(club.sellEdge, -56);
assert.equal(club.counterparties['Bot-1'].buyBonus, 50);
assert.equal(a.bySuit[0].buy, 0);
assert.equal(a.bySuit[0].buyEdge, -7);
assert.equal(a.bySuit[0].sellEdge, 4);
trade(s, 'c', 'You', 'Bot-1', 7);
const after = T.analyze(s);
assert(after.available);
near(after.roundPnl.settleNowPnl - a.roundPnl.settleNowPnl, club.buyEdge);
assert.equal(after.roundPnl.netCash, -7);
assert.equal(after.roundPnl.ante, 50);
assert.equal(after.roundPnl.settlement, 140);
assert.equal(after.roundPnl.settleNowPnl, 83);
assert.deepEqual(
  after.players.map((p) => p.handOdds),
  a.players.map((p) => p.handOdds),
  'private odds use starting, not current hands',
);
near(sum(after.players.map((p) => p.roundPnl)), 0);
const sold = fixture();
trade(sold, 'c', 'Bot-1', 'You', 4);
near(T.analyze(sold).roundPnl.settleNowPnl - a.roundPnl.settleNowPnl, club.sellEdge);
const goal8 = fixture();
goal8.training.startingHands = {
  You: [3, 2, 3, 2],
  'Bot-1': [3, 2, 2, 3],
  'Bot-2': [3, 2, 3, 2],
  'Bot-3': [3, 2, 2, 3],
};
goal8.training.hands = clone(goal8.training.startingHands);
goal8.startingHand = goal8.training.startingHands.You.slice();
goal8.held = goal8.startingHand.slice();
goal8.training.deckTotals = [12, 8, 10, 10];
const eight = T.analyze(goal8);
assert(eight.available);
assert.equal(eight.settlement.bonusPool, 120);
assert.equal(eight.bySuit[1].buy, 100);
near(sum(eight.players.map((p) => p.settlement.total)), 200);
const zero = fixture();
for (let i = 0; i < 2; i++) trade(zero, 'h', 'Bot-2', 'Bot-1', 1);
assert.equal(T.analyze(zero).bySuit[3].counterparties['Bot-1'].buy, null);
for (let i = 0; i < 2; i++) trade(zero, 'h', 'Bot-2', 'You', 1);
assert.equal(T.analyze(zero).bySuit[3].counterparties['Bot-1'].sell, null);
for (const change of [
  (s) => delete s.training,
  (s) => (s.training.enabled = false),
  (s) => (s.training.enabled = 'true'),
  (s) => (s.training.handsVisible = false),
  (s) => (s.training.valid = false),
  (s) => delete s.training.hands['Bot-3'],
  (s) => s.training.hands['Bot-1'][0]++,
  (s) => (s.training.deckTotals = [10, 10, 10, 10]),
  (s) => s.held[0]++,
  (s) => (s.status = 'ended'),
  (s) => s.trades.push({ suit: 's', b: 'Unknown', s: 'Bot-1', p: 1 }),
]) {
  const x = fixture();
  change(x);
  assert.equal(T.analyze(x).available, false);
}
const paused = fixture();
paused.status = 'paused';
assert(T.analyze(paused).available);
const ended = fixture();
delete ended.training;
ended.status = 'ended';
ended.roundResult = { goal: 'c', finalHands: fixture().training.hands };
assert.equal(T.analyze(ended).available, false);
assert.equal(T.knownHandProbabilities({}).available, false);
assert.equal(T.knownHandProbabilities({ A: [1, 2, 3] }).available, false);
assert.equal(T.knownHandProbabilities({ A: [10, 0, 0, 0], B: [10, 0, 0, 0] }).available, false);
assert.equal(T.knownHandProbabilities({ A: [3, 3, 2, 2] }, { playerCount: 6 }).available, false);
const clean = fixture();
const tampered = clone(clean);
tampered.training.hands['Bot-1'] = [10, 0, 0, 0];
tampered.training.exactGoal = 'h';
tampered.truth = { goal: 'h' };
tampered.revealed = { goal: 'd' };
tampered.finalHands = { You: [0, 0, 10, 0] };
tampered.deckTotals = [8, 10, 10, 12];
tampered.roundResult = { goal: 'h' };
tampered.context.secretGoal = 'd';
tampered.context.trainingTruth = { goal: 's' };
tampered.players[1].hand = [0, 0, 10, 0];
tampered.markets[0].exactValue = 999;
tampered.signature = 'leaked different truth';
const blind1 = T.blindSnapshot(clean);
const blind2 = T.blindSnapshot(tampered);
assert.deepEqual(blind1, blind2);
assert.equal(blind1.context.learningMode, true);
for (const key of [
  'training',
  'truth',
  'revealed',
  'finalHands',
  'deckTotals',
  'roundResult',
  'refs',
])
  assert(!Object.hasOwn(blind2, key));
assert.equal(blind2.players[1].hand, undefined);
assert.equal(blind2.context.secretGoal, undefined);
const m1 = new B.BeliefEngine({ skipPricing: true }).infer(blind1);
const m2 = new B.BeliefEngine({ skipPricing: true }).infer(blind2);
assert.deepEqual(m1.scoringProbabilities, m2.scoringProbabilities);
assert.equal(m1.expectedPayout, m2.expectedPayout);
assert.equal(T.analyze(clean, m1).probabilityTable.blind.length, 4);
const score = T.scorePrediction([0.1, 0.6, 0.2, 0.1], 'c');
near(score.brier, 0.22);
assert.equal(score.correct, true);
assert.equal(score.goalProbability, 0.6);
assert.equal(T.scorePrediction([0, 1, 0, 0], 'c').brier, 0);
assert.equal(T.scorePrediction([1, 0, 0, 0], 'c').brier, 2);
assert(T.scorePrediction([1, 0, 0, 0], 'c').logLossClipped);
assert.equal(T.scorePrediction([1, 1, 0, 0], 'c').available, false);
assert.equal(T.scorePrediction([0.25, 0.25, 0.25, 0.25], 'x').available, false);
console.log(
  'PASS training analytics: four/five-player exact subset odds, own-hand hypergeometric parity, all-hand goal, subset-mask table, settle-now payout and bonus conservation, exact named-counterparty transfer/price edges, immutable snapshots/models, invalid/incomplete and normal-ended rejection, paused practice, strict blind snapshot isolation, forecast scoring.',
);
