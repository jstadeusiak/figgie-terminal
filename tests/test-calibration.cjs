const assert = require('node:assert/strict');
const J = require('../extension/journal.js');
const { BeliefEngine } = require('../extension/belief.js');
const { setup } = require('./figgie-fixture.cjs');
const dom = setup();
const raw = dom.window.FiggieAdapter.read(dom.window.document);
const copy = (x) => JSON.parse(JSON.stringify(x));
const s = copy({ ...raw, refs: undefined });
dom.window.close();
const first = new J.RoundJournal('one', 'base');
const second = new J.RoundJournal('two', 'base');
for (const j of [first, second]) {
  j.command('command_attempt', { id: 1, command: { kind: 'bid', suit: 's', price: 2 } }, 1000);
  j.command('command_submitted', { id: 1 }, 1100);
  j.command('order_outcome', { id: 1, state: 'confirmed' }, 1200);
}
assert.equal(new Set([...first.events, ...second.events].map((e) => e.id)).size, 6);
assert(first.events.every((e) => e.commandId === 1 && e.id.startsWith('one:')));
function quote() {
  const j = new J.RoundJournal('round', 'base');
  j.observe(s, 1000);
  j.command('command_attempt', { id: 1, command: { kind: 'bid', suit: 's', price: 2 } }, 1050);
  const own = copy(s);
  own.markets[0].buyer = s.self;
  own.signature = 'own bid';
  j.observe(own, 1100);
  j.trackActualTopQuotes({ actualBook: { s: { bid: { pFill: 0.1 } } } }, 1110);
  return { j, own };
}
function filled(own) {
  const next = copy(own);
  const seller = own.players[1].name;
  next.trades.push({ b: s.self, s: seller, suit: 's', p: 2 });
  next.held[0]++;
  next.cash -= 2;
  next.markets[0].held++;
  next.net[0][0]++;
  next.net[1][0]--;
  next.signature = 'filled';
  for (const m of next.markets) {
    m.bid = null;
    m.ask = null;
    m.buyer = null;
    m.seller = null;
  }
  return next;
}
let { j, own } = quote();
j.observe(filled(own), 1300);
let o = j.events.find((e) => e.kind === 'fill_outcome');
assert(o.filled && !o.censored, 'initial placement cannot censor its fast fill');
({ j, own } = quote());
j.command('command_attempt', { id: 2, command: { kind: 'cancel-bid', suit: 's', price: 2 } }, 1200);
j.observe(filled(own), 1300);
o = j.events.find((e) => e.kind === 'fill_outcome');
assert(o.filled && !o.censored, 'a known fill wins a cancellation race');
({ j, own } = quote());
j.command('command_attempt', { id: 2, command: { kind: 'cancel-bid', suit: 's', price: 2 } }, 1200);
const cleared = copy(own);
cleared.markets[0].bid = null;
cleared.markets[0].buyer = null;
cleared.signature = 'cancel';
j.observe(cleared, 1300);
assert(
  j.events.find((e) => e.kind === 'fill_outcome').censored,
  'actual later cancellation remains censored',
);
({ j, own } = quote());
j.gap('fault', 'source missing', 1300);
j.observe(filled(own), 1400);
assert.equal(j.events.filter((e) => e.kind === 'fill_outcome').length, 1);
assert(
  j.events.find((e) => e.kind === 'fill_outcome').censored,
  'a coverage gap closes the opportunity',
);
({ j, own } = quote());
for (let at = 2000; at <= 10000; at += 1000) j.observe(own, at);
j.observe(filled(own), 11120);
assert(
  j.events.find((e) => e.kind === 'fill_outcome').censored,
  'a fill observed beyond the ten-second boundary is not a scored success',
);
({ j, own } = quote());
j.observe(filled(own), 1300);
const legacy = copy(j.events);
legacy.find((e) => e.kind === 'fill_outcome').censored = true;
assert(J.scoredFillOutcomes(legacy)[0].legacyRecovered);
const outcome = legacy.find((e) => e.kind === 'fill_outcome');
legacy.push({ kind: 'coverage', seq: outcome.seq - 0.5, status: 'paused' });
assert(J.scoredFillOutcomes(legacy)[0].censored, 'legacy recovery requires uninterrupted coverage');
const engine = new BeliefEngine();
const m = engine.infer({ ...s, context: { botDifficulty: 'Medium' } });
assert.equal(m.behavior.blend, 0.55);
assert.equal(engine.infer({ ...s, context: { botDifficulty: 'Easy' } }).behavior.blend, 0.35);
assert.equal(
  engine.infer({ ...s, context: {} }, [], { metrics: { rounds: 100 } }).behavior.blend,
  0.35,
  'a round count alone cannot promote an unvalidated group',
);
console.log(
  'Unique command-event IDs; fast fills; cancellation races; gaps; horizon censoring; conservative legacy recovery; difficulty-scoped model fit: passed.',
);

// A revealed result may precede the ended DOM snapshot; never score forecasts
// observed after that result, even when the last phase still says live.
for (const known of [
  { kind: 'settlement_pending', result: { goal: 's' } },
  { kind: 'state', status: 'live', roundResult: { goal: 's' } },
  { kind: 'checkpoint', snapshot: { status: 'live', roundResult: { goal: 's' } } },
]) {
  const before = { kind: 'prediction', seq: 2 };
  const after = { kind: 'prediction', seq: 4 };
  assert.deepEqual(
    J.livePredictions([
      { kind: 'round_start', snapshot: { status: 'live' } },
      before,
      known,
      after,
    ]),
    [before],
  );
}
