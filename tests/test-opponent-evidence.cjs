/* Named, causal trade evidence; raw records remain replayable without new fields. */
'use strict';
const assert = require('node:assert/strict');
const J = require('../extension/journal.js');
const B = require('../extension/belief.js');
const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
const IDS = ['s', 'c', 'd', 'h'];
const copy = (x) => JSON.parse(JSON.stringify(x));
function snapshot(trades = [], quotes = {}) {
  const net = names.map(() => [0, 0, 0, 0]);
  const cash = names.map(() => 300);
  for (const t of trades) {
    const a = names.indexOf(t.s);
    const b = names.indexOf(t.b);
    const s = IDS.indexOf(t.suit);
    net[a][s]--;
    net[b][s]++;
    cash[a] += t.p;
    cash[b] -= t.p;
  }
  const hand = [3, 3, 2, 2];
  const held = hand.map((v, s) => v + net[0][s]);
  const markets = IDS.map((id, s) => ({
    id,
    bid: null,
    ask: null,
    buyer: null,
    seller: null,
    held: held[s],
    canBuy: true,
    canSell: held[s] > 0,
    canBid: true,
    canOffer: held[s] > 0,
    canRaiseBid: true,
    canLowerAsk: held[s] > 0,
    fills: trades.filter((t) => t.suit === id),
    ...(quotes[id] || {}),
  }));
  return {
    self: names[0],
    status: 'live',
    round: 1,
    roundKey: 'evidence',
    room: 'fixture',
    timer: '2:00',
    cash: cash[0],
    startingHand: hand,
    held,
    trades: copy(trades),
    players: names.map((name, p) => ({
      name,
      cash: cash[p],
      cards: 10 + net[p].reduce((a, b) => a + b, 0),
    })),
    markets,
    net,
    context: { botDifficulty: 'Medium' },
    signature: JSON.stringify([trades, markets]),
  };
}
const trades = [];
const j = new J.RoundJournal('causal', 'base');
j.observe(snapshot([], { c: { ask: 4, seller: 'Bot-A', bid: 2, buyer: 'Bot-B' } }), 1000);
j.command('command_attempt', { id: 7, command: { kind: 'buy', suit: 'c', price: 4 } }, 1100);
trades.push({ b: 'You', s: 'Bot-A', suit: 'c', p: 4 });
j.observe(snapshot(trades), 1200);
const fill = j.events.find((e) => e.kind === 'fill');
const pair = j.evidence.filter((e) => e.sourceSeq === fill.seq);
assert.equal(pair.length, 2, 'both participants are represented');
const take = pair.find((e) => e.kind === 'take');
const passive = pair.find((e) => e.kind === 'consent');
assert.equal(take.actor, 'You');
assert.equal(take.counterparty, 'Bot-A');
assert.equal(take.counterpartyKnownBeforeAction, true);
assert.equal(take.passive, false);
assert.equal(passive.actor, 'Bot-A');
assert.equal(passive.counterparty, 'You');
assert.equal(passive.counterpartyKnownBeforeAction, false);
assert.equal(passive.passive, true);
for (const e of pair) {
  assert.equal(e.epoch, 0);
  assert.deepEqual(
    e.net,
    names.map(() => [0, 0, 0, 0]),
  );
  assert.equal(e.at, 1200);
  assert.equal(e.sourceSeq, fill.seq);
}
assert.equal(j.previous.net[1][1], -1, 'transfer is applied after evidence prefix');
const selected = B.chooseEvidence(j.evidence, 'You', { recentOnly: true });
assert(!selected.some((e) => e.actor === 'You'), 'our own choices never vote for our hypothesis');
assert.equal(
  selected.filter(
    (e) => e.actor === 'Bot-A' && e.suit === 'c' && e.direction === 'sell' && e.epoch === 0,
  ).length,
  1,
  'passive fill and quoted offer are one episode',
);
const selectedPassive = selected.find((e) => e.actor === 'Bot-A' && e.suit === 'c');
const originalQuote = j.events.find(
  (e) => e.kind === 'quote' && e.owner === 'Bot-A' && e.suit === 'c',
);
assert.equal(
  selectedPassive.kind,
  'quote',
  'automatic fill does not replace the original price-setting decision',
);
assert.equal(
  selectedPassive.sourceSeq,
  originalQuote.seq,
  'passive action retains knowledge available when the quote was posted',
);
const fallback = B.chooseEvidence(pair, 'You');
assert.equal(fallback.length, 1);
assert.equal(fallback[0].kind, 'consent');
assert.equal(
  fallback[0].counterpartyKnownBeforeAction,
  false,
  'missing passive quote does not grant foreknowledge of its eventual filler',
);
assert(
  j.evidence.filter((e) => e.kind === 'quote').every((e) => e.counterparty === undefined),
  'a quote does not invent a future filler',
);
const bidJournal = new J.RoundJournal('bid', 'bid');
bidJournal.observe(snapshot([], { h: { bid: 5, buyer: 'Bot-A' } }), 2000);
bidJournal.observe(snapshot([{ b: 'Bot-A', s: 'Bot-C', suit: 'h', p: 5 }]), 2100);
const bidFill = bidJournal.events.find((e) => e.kind === 'fill');
const bidPair = bidJournal.evidence.filter((e) => e.sourceSeq === bidFill.seq);
assert.equal(bidFill.classification, 'bid-hit');
assert.deepEqual(
  bidPair.map((e) => [
    e.actor,
    e.direction,
    e.kind,
    e.counterparty,
    e.counterpartyKnownBeforeAction,
  ]),
  [
    ['Bot-A', 'buy', 'consent', 'Bot-C', false],
    ['Bot-C', 'sell', 'take', 'Bot-A', true],
  ],
);
const bidSelected = B.chooseEvidence(bidJournal.evidence, 'You');
assert.equal(
  bidSelected.filter((e) => e.actor === 'Bot-A').length,
  1,
  'filled passive bid is represented once',
);
// Two batched fills share an observation time but retain separate causal epochs.
trades.push(
  { b: 'Bot-B', s: 'Bot-C', suit: 's', p: 5 },
  { b: 'Bot-A', s: 'Bot-B', suit: 's', p: 6 },
);
j.observe(snapshot(trades), 1300);
const later = j.events.filter((e) => e.kind === 'fill').slice(1);
const firstEvidence = j.evidence.filter((e) => e.sourceSeq === later[0].seq);
const secondEvidence = j.evidence.filter((e) => e.sourceSeq === later[1].seq);
assert(
  firstEvidence.every(
    (e) =>
      e.kind === 'consent' &&
      e.counterpartyKnownBeforeAction === false &&
      e.passive === null &&
      e.recovered,
  ),
  'unknown initiator is not fabricated',
);
assert.equal(firstEvidence[0].epoch, 1);
assert.equal(firstEvidence[0].net[2][0], 0);
assert.equal(secondEvidence[0].epoch, 2);
assert.equal(secondEvidence[0].net[2][0], 1);
assert.equal(secondEvidence[0].net[3][0], -1);
assert(later[0].seq < later[1].seq, 'source sequence resolves equal observation timestamps');
assert.deepEqual(
  pair[0].net,
  names.map(() => [0, 0, 0, 0]),
  'future observations cannot mutate historical knowledge',
);
const restored = J.restore(
  { id: j.id, base: j.base, snapshot: j.previous, observedAt: j.at },
  copy(j.events),
);
assert.deepEqual(restored.evidence, j.evidence, 'live and recovered evidence match exactly');
// Old raw fills have no new evidence metadata. Derivation preserves identity and uncertainty.
const legacy = [
  {
    kind: 'fill',
    seq: 1,
    at: 1,
    index: 0,
    trade: { suit: 'h', b: 'Bot-A', s: 'Bot-C', p: 3 },
    initiator: 'Bot-C',
    netBefore: names.map(() => [0, 0, 0, 0]),
  },
];
const old = J.restore({ id: 'old', base: 'old', snapshot: snapshot(), observedAt: 1 }, legacy);
assert.equal(old.evidence.find((e) => e.actor === 'Bot-C').counterparty, 'Bot-A');
assert.equal(old.evidence.find((e) => e.actor === 'Bot-A').passive, true);
const sparse = J.restore({ id: 'sparse', base: 'sparse', snapshot: snapshot(), observedAt: 1 }, [
  { ...legacy[0], initiator: null, netBefore: undefined },
]);
assert.equal(sparse.evidence.length, 2, 'incomplete old synthetic records remain readable');
assert(sparse.evidence.every((e) => e.net === undefined && !e.counterpartyKnownBeforeAction));
// Card conservation remembers deepest historical deficits, not just final flow or gross sales.
const flow = [
  { s: 'Bot-A', b: 'Bot-B', suit: 's', p: 3 },
  { s: 'Bot-A', b: 'Bot-B', suit: 's', p: 3 },
  { s: 'Bot-A', b: 'Bot-B', suit: 's', p: 3 },
  { s: 'Bot-B', b: 'Bot-A', suit: 's', p: 3 },
  { s: 'Bot-B', b: 'Bot-A', suit: 's', p: 3 },
  { s: 'Bot-B', b: 'Bot-A', suit: 's', p: 3 },
];
const physical = B.physical(snapshot(flow));
assert.equal(physical.net[1][0], 0);
assert.equal(physical.minimum[1][0], 3);
assert.equal(
  physical.minimum[2][0],
  0,
  'reselling acquired cards does not fabricate an original holding',
);
console.log(
  'PASS opponent evidence: named peers, passive uncertainty, pre-fill epochs/nets, same-time sequence ordering, quote/fill deduplication, own-choice exclusion, historical restoration, and resale conservation.',
);
