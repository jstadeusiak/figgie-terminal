'use strict';
// Independent metamorphic checks of observation-time features; no goal labels.
const assert = require('node:assert/strict');
const { Tracker } = require('../research/candidates/bid-signals.js');
const suits = ['s', 'c', 'd', 'h'];
const players = ['Me', 'A', 'B', 'C'];
function events(points) {
  return points.map((p, i) => {
    const [at, kind = 'state', owner = 'A', bid = 10] = p;
    if (kind === 'round_start')
      return {
        kind,
        at,
        seq: i + 1,
        roundId: 'r',
        snapshot: {
          self: 'Me',
          players: players.map((name) => ({ name })),
          status: 'live',
          antePending: false,
          timer: 'x',
          trades: [],
          markets: suits.map((id) => ({
            id,
            bid: id === 'h' ? bid : null,
            buyer: id === 'h' ? owner : null,
          })),
        },
      };
    if (kind === 'coverage')
      return { kind, at, seq: i + 1, roundId: 'r', status: 'live', reason: 'lost connection' };
    return {
      kind,
      at,
      seq: i + 1,
      roundId: 'r',
      status: 'live',
      antePending: false,
      timer: String(at),
      book: suits.map((id) => [id, id === 'h' ? bid : null, null, id === 'h' ? owner : null, null]),
    };
  });
}
const summarize = (es) => new Tracker({ self: 'Me' }).pushAll(es).features();
const dwell = (es) => summarize(es).values[3][0];
const near = (a, b) => assert(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
let failures = [];
function test(name, fn) {
  try {
    fn();
    console.log('ok', name);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log('FAIL', name, e.message);
  }
}
test('standalone explicit gap bars following dwell interval', () => {
  near(dwell(events([[0, 'round_start'], [1000], [1500, 'coverage'], [2000]])), 1 / 30);
});
test('backward source never overlaps previously accrued dwell', () => {
  assert(dwell(events([[0, 'round_start'], [1000], [900], [1500]])) <= 0.15 / 3 + 1e-12);
});
test('same visible duration is invariant to higher source poll frequency', () => {
  const coarse = events([[0, 'round_start'], [1000], [2000]]);
  const fine = events([
    [0, 'round_start'],
    ...[
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700,
      1800, 1900, 2000,
    ].map((at) => [at]),
  ]);
  near(dwell(coarse), dwell(fine));
});
test('unknown owners and own quotes are zero regardless of duration', () => {
  for (const owner of ['Me', 'Unknown'])
    assert.deepEqual(
      summarize(
        events([
          [0, 'round_start', owner],
          [1000, 'state', owner],
          [2000, 'state', owner],
        ]),
      ).values,
      suits.map(() => [0, 0]),
    );
});
test('non-source prediction/outcome/commands cannot renew duration', () => {
  const es = events([[0, 'round_start'], [1000]]);
  const expected = summarize(es);
  for (const kind of ['prediction', 'round_pnl', 'reveal', 'command_attempt', 'fill_outcome'])
    es.push({ kind, at: 90000, seq: es.length + 1, roundId: 'r', goal: 'h', held: [0, 0, 0, 40] });
  assert.deepEqual(summarize(es), expected);
});
test('hidden and future labels in allowed source payloads do not affect values', () => {
  const es = events([[0, 'round_start'], [1000], [2000]]);
  const copy = structuredClone(es);
  for (const e of copy) {
    e.goal = 'h';
    e.training = { opponentHands: [[0, 0, 0, 10]] };
    e.finalProfit = 100;
    if (e.snapshot) {
      e.snapshot.roundResult = { goal: 'h' };
      e.snapshot.goal = 'h';
      e.snapshot.players.forEach((p) => (p.hand = [10, 0, 0, 0]));
    }
  }
  assert.deepEqual(summarize(copy), summarize(es));
});
test('opponent name bijection leaves suit features invariant', () => {
  const es = events([[0, 'round_start'], [1000], [2000]]);
  const rename = { Me: 'Self', A: 'Crab', B: 'Fox', C: 'Antelope' };
  const copy = JSON.parse(JSON.stringify(es), (_, v) =>
    typeof v === 'string' && rename[v] ? rename[v] : v,
  );
  assert.deepEqual(
    new Tracker({ self: 'Self' }).pushAll(copy).features().values,
    summarize(es).values,
  );
});
test('prefix replay is independent of future extension and preview calls', () => {
  const es = events([[0, 'round_start'], [1000], [2000], [3000, 'state', 'B', 20]]);
  const tracker = new Tracker({ self: 'Me' }).pushAll(es.slice(0, 3));
  const frozen = structuredClone(tracker.features());
  tracker.features();
  tracker.pushAll(es.slice(3));
  assert.deepEqual(frozen, summarize(es.slice(0, 3)));
});
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else console.log('All independent bid-signal causality controls passed.');
