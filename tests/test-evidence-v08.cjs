// Isolate the v0.8 evidence-window contract from newer valuation and samplers.
const assert = require('node:assert/strict');
const B = require('../extension/belief.js');
const Old = require('../extension/belief-v0.7.js');
function event(actor, i, extra = {}) {
  return {
    kind: 'quote',
    direction: 'buy',
    actor,
    suit: 's',
    price: i + 1,
    epoch: i,
    at: i,
    ...extra,
  };
}
const stream = ['Bot-1', 'Bot-2', 'Bot-3', 'You'].flatMap((name) =>
  Array.from({ length: 40 }, (_, i) => event(name, i)),
);
const selected = B.chooseEvidence(stream, 'You', { recentOnly: true });
assert.equal(selected.length, 72);
assert(selected.every((e) => e.actor !== 'You' && e.epoch >= 16));
for (const actor of ['Bot-1', 'Bot-2', 'Bot-3'])
  assert.deepEqual(
    selected.filter((e) => e.actor === actor).map((e) => e.epoch),
    Array.from({ length: 24 }, (_, i) => i + 16),
  );
assert.deepEqual(
  B.chooseEvidence(stream, 'You'),
  Old.chooseEvidence(stream, 'You'),
  'default retains original selection',
);
for (let n = 0; n <= 24; n++) {
  const opening = Array.from({ length: n }, (_, i) => event('Bot-1', i));
  assert.deepEqual(
    B.chooseEvidence(opening, 'You', { recentOnly: true }),
    Old.chooseEvidence(opening, 'You'),
    'opening evidence unchanged through24 episodes',
  );
}
for (const recentOnly of [false, true]) {
  const pennies = [
    event('Bot-1', 0, { price: 2 }),
    event('Bot-1', 0, { price: 3 }),
    event('Bot-1', 0, { price: 1 }),
    event('Bot-2', 0, { direction: 'sell', price: 9 }),
    event('Bot-2', 0, { direction: 'sell', price: 7 }),
    event('Bot-2', 0, { direction: 'sell', price: 8 }),
  ];
  const dedup = B.chooseEvidence(pennies, 'You', { recentOnly });
  assert.equal(dedup.length, 2);
  assert.deepEqual(
    dedup.map((e) => e.price),
    [3, 7],
  );
  const take = event('Bot-1', 0, { kind: 'take', price: 4 });
  assert.deepEqual(
    B.chooseEvidence(
      [...pennies.slice(0, 3), event('Bot-1', 0, { kind: 'consent' }), take],
      'You',
      { recentOnly },
    ),
    [take],
  );
}
function fixture(n = 4, difficulty = 'Medium', human = false) {
  const names = Array.from({ length: n }, (_, i) =>
    i ? (human && i === 1 ? 'Alice' : 'Bot-' + i) : 'You',
  );
  const hand = n === 4 ? [4, 2, 3, 1] : [2, 2, 2, 2];
  const s = {
    self: 'You',
    status: 'live',
    roundKey: 'evidence-v08',
    cash: 300,
    startingHand: hand,
    held: hand.slice(),
    players: names.map((name) => ({ name, cash: 300 })),
    trades: [],
    context: difficulty ? { botDifficulty: difficulty } : {},
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
  const events = [];
  for (let i = 0; i < 40; i++) {
    s.trades.push({ suit: 'c', b: names[i % 2 ? 1 : 2], s: names[i % 2 ? 2 : 1], p: 3 });
    events.push(event(names[1], i + 1, { net: B.physical(s).net }));
  }
  return { s, events };
}
const scopes = [
  { n: 4, d: 'Medium', recent: true },
  { n: 4, d: 'Easy', recent: false },
  { n: 4, d: '', recent: false },
  { n: 4, d: 'Medium', human: true, recent: false },
  { n: 5, d: 'Medium', recent: false },
];
for (const x of scopes) {
  const { s, events } = fixture(x.n, x.d, x.human);
  const engine = new B.BeliefEngine({
    skipPricing: true,
    opponentLearning: false,
    goalStratified: false,
    referenceEss: false,
  });
  engine.infer(s, events);
  const used = [...engine.eventLogCache.keys()].map((k) => JSON.parse(k)[4]).sort((a, b) => a - b);
  const expected = B.chooseEvidence(events, 'You', { recentOnly: x.recent })
    .map((e) => e.price)
    .sort((a, b) => a - b);
  assert.deepEqual(used, expected, JSON.stringify(x) + ' production context gate');
  if (!x.recent) {
    const prior = new Old.BeliefEngine({ skipPricing: true }).infer(s, events);
    const actual = engine.infer(s, events);
    actual.scoringProbabilities.forEach((p, i) =>
      assert(Math.abs(p - prior.scoringProbabilities[i]) < 1e-12, 'unsupported contexts unchanged'),
    );
  }
}
const { s, events } = fixture();
const q = {
  kind: 'quote',
  direction: 'sell',
  actor: 'Bot-1',
  suit: 'h',
  price: 4,
  epoch: 0,
  at: 0,
  net: s.players.map(() => [0, 0, 0, 0]),
  recovered: false,
};
assert(
  !B.chooseEvidence([q, ...events], 'You', { recentOnly: true }).includes(q),
  'old ask expires only from behavior window',
);
const engine = new B.BeliefEngine({
  skipPricing: true,
  opponentLearning: false,
  goalStratified: false,
  referenceEss: false,
});
const m = engine.infer(s, [q, ...events]);
assert.equal(m.inventoryEvidence.qualifiedAsks, 1);
assert.equal(
  engine.state.minimum[1][3],
  1,
  'historical ask continues to constrain physical inventory',
);
assert(engine.latest.worlds.every((w) => w.initial[1][3] >= 1));
const opening = fixture().s;
opening.trades = [];
const modern = new B.BeliefEngine({
  skipPricing: true,
  opponentLearning: false,
  goalStratified: false,
  referenceEss: false,
}).infer(opening);
const old = new Old.BeliefEngine({ skipPricing: true }).infer(opening);
modern.scoringProbabilities.forEach((p, i) =>
  assert(Math.abs(p - old.scoringProbabilities[i]) < 1e-12, 'opening goal values unchanged'),
);
console.log(
  'PASS v0.8 evidence: latest24 per opponent, stale opening removed, self excluded, quote pennies deduplicated, take precedence, first24 unchanged, four-player Medium-only runtime gate, unsupported contexts unchanged, all-history physical asks preserved, opening probabilities unchanged.',
);
