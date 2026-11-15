const assert = require('node:assert/strict');
const { scoreRound, auditRound } = require('../extension/bonus-score.js');
const clone = (x) => JSON.parse(JSON.stringify(x));
function fixture(initial, trades = [], predictAt = null) {
  const n = initial.length;
  const names = Array.from({ length: n }, (_, i) => (i ? 'Bot-' + i : 'You'));
  const size = 40 / n;
  const total = initial.reduce((a, b) => a + b);
  const bonus = 200 - 10 * total;
  const startingHand = [initial[0], size - initial[0] - 2, 1, 1];
  const counts = initial.slice();
  const net = names.map(() => [0, 0, 0, 0]);
  const cash = names.map(() => 0);
  const events = [];
  const snapshot = (status, used) => ({
    status,
    self: names[0],
    startingHand: startingHand.slice(),
    held: startingHand.map((v, i) => v + net[0][i]),
    players: names.map((name, i) => ({ name, cards: size + net[i].reduce((a, b) => a + b) })),
    trades: used.map((t) => ({ ...t })),
  });
  const append = (e) =>
    events.push({ ...e, roundId: 'test', seq: events.length + 1, at: events.length * 1000 });
  const predict = (k) => {
    if (predictAt && !predictAt.includes(k)) return;
    const max = Math.max(...counts);
    const ties = counts.filter((v) => v === max).length;
    const lead = counts[0] === max;
    const scenario = {
      suit: 's',
      bonus: lead ? bonus / ties : 0,
      leaderProbability: Number(lead),
      soloProbability: Number(lead && ties === 1),
      tieProbability: Number(lead && ties > 1),
      noBonusProbability: Number(!lead),
    };
    append({ kind: 'prediction', tradeCount: k, goalScenarios: [scenario] });
  };
  append({ kind: 'round_start', snapshot: snapshot('live', []) });
  predict(0);
  trades = trades.map(([a, b, p = 5, suit = 's']) => ({ s: names[a], b: names[b], suit, p }));
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const a = names.indexOf(t.s);
    const b = names.indexOf(t.b);
    const k = ['s', 'c', 'd', 'h'].indexOf(t.suit);
    net[a][k]--;
    net[b][k]++;
    cash[a] += t.p;
    cash[b] -= t.p;
    if (k === 0) {
      counts[a]--;
      counts[b]++;
    }
    append({ kind: 'fill', index: i, trade: t, recovered: false });
    append({ kind: 'state', status: 'live', held: snapshot('live', []).held });
    predict(i + 1);
  }
  const previous = snapshot('ended', trades);
  const max = Math.max(...counts);
  const ties = counts.filter((v) => v === max).length;
  const profits = Object.fromEntries(
    names.map((name, i) => [
      name,
      cash[i] - 200 / n + 10 * counts[i] + (counts[i] === max ? bonus / ties : 0),
    ]),
  );
  const revealed = {
    goal: 's',
    profits,
    settledProfit: profits.You,
    verified: true,
    source: 'official-round-rankings',
  };
  append({ kind: 'state', status: 'ended', held: previous.held });
  append({ kind: 'reveal', ...revealed });
  return { id: 'test', previous, revealed, events };
}
let tests = 0;
function test(name, fn) {
  fn();
  tests++;
  console.log('ok', name);
}
function perfect(j) {
  const s = scoreRound(j);
  assert.ok(s, JSON.stringify(auditRound(j)));
  assert.equal(s.bonusMae, 0);
  assert.equal(s.bonusBias, 0);
  assert.equal(s.bonusMse, 0);
  assert.equal(s.bonusRmse, 0);
  assert.equal(s.categoryBrier, 0);
  assert.equal(s.leaderBrier, 0);
  return s;
}
function frozen(x) {
  Object.freeze(x);
  for (const v of Object.values(x)) if (v && typeof v === 'object') frozen(v);
  return x;
}
function renumber(j) {
  j.events.forEach((e, i) => (e.seq = i + 1));
  return j;
}
test('solo, tie, no-bonus and five-player official settlements', () => {
  for (const h of [
    [5, 1, 1, 1],
    [4, 4, 0, 0],
    [2, 3, 2, 1],
    [5, 5, 0, 0],
    [3, 2, 1, 1, 1],
  ])
    perfect(fixture(h));
});
test('subsequent sales and purchases are labeled at the forecast inventory', () => {
  assert.equal(perfect(fixture([5, 3, 0, 0], [[0, 1]])).checkpoints, 2);
  assert.equal(perfect(fixture([3, 4, 1, 0], [[1, 0]])).checkpoints, 2);
});
test('bias and MAE use stored forecasts; category Brier is multiclass', () => {
  const j = fixture([4, 4, 0, 0]);
  const p = j.events.find((e) => e.kind === 'prediction').goalScenarios[0];
  p.bonus = 80;
  p.soloProbability = 0.5;
  p.tieProbability = 0.5;
  const s = scoreRound(j);
  assert.equal(s.bonusMae, 20);
  assert.equal(s.bonusBias, 20);
  assert.equal(s.bonusMse, 400);
  assert.equal(s.bonusRmse, 20);
  assert.equal(s.categoryBrier, 0.5);
});
test('MSE averages squared checkpoint errors and RMSE is its square root', () => {
  const j = fixture([5, 3, 0, 0], [[0, 1]]);
  const points = j.events.filter((e) => e.kind === 'prediction');
  points[0].goalScenarios[0].bonus -= 10;
  points[1].goalScenarios[0].bonus += 20;
  const score = scoreRound(j);
  assert.equal(score.checkpoints, 2);
  assert.equal(score.bonusBias, 5);
  assert.equal(score.bonusMae, 15);
  assert.equal(score.bonusMse, 250);
  assert.equal(score.bonusRmse, Math.sqrt(250));
});
test('older bonus-only forecasts retain MAE but do not invent category labels', () => {
  const j = fixture([4, 4, 0, 0]);
  const p = j.events.find((e) => e.kind === 'prediction').goalScenarios[0];
  delete p.soloProbability;
  delete p.tieProbability;
  delete p.noBonusProbability;
  assert.equal(scoreRound(j).categoryBrier, null);
  assert.equal(scoreRound(j).categoryCheckpoints, 0);
});
test('ambiguous earlier truth rejected; later identifiable truth retained', () => {
  const trades = Array.from({ length: 4 }, () => [0, 1]);
  const j = fixture([4, 4, 0, 0], trades, [0]);
  assert.equal(scoreRound(j), null);
  assert.match(auditRound(j).reason, /ambiguous/);
  const later = scoreRound(fixture([4, 4, 0, 0], trades, [0, 4]));
  assert.equal(later.bonusMae, 0);
  assert.equal(later.checkpoints, 1);
  assert.equal(later.ambiguousCheckpoints, 1);
  assert.equal(later.candidateAllocations, 2);
});
test('unverified, partial, nonzero-sum and impossible official results rejected', () => {
  for (const alter of [
    (j) => (j.revealed.verified = false),
    (j) => (j.revealed.source = 'user-confirmed'),
    (j) => delete j.revealed.profits['Bot-1'],
    (j) => j.revealed.profits['Bot-1']++,
    (j) => {
      j.revealed.profits.You++;
      j.revealed.profits['Bot-1']--;
      j.revealed.settledProfit++;
    },
  ]) {
    const j = fixture([4, 4, 0, 0]);
    alter(j);
    assert.equal(scoreRound(j), null);
  }
});
test('recovered or truncated histories rejected', () => {
  for (const alter of [
    (j) => (j.events.find((e) => e.kind === 'fill').recovered = true),
    (j) =>
      j.events.find((e) => e.kind === 'round_start').snapshot.trades.push(j.previous.trades[0]),
    (j) =>
      j.events.splice(
        j.events.findIndex((e) => e.kind === 'fill'),
        1,
      ),
    (j) => (j.events.find((e) => e.kind === 'fill').index = 2),
  ]) {
    const j = fixture([4, 3, 1, 0], [[0, 1]]);
    alter(j);
    assert.equal(scoreRound(j), null);
  }
});
test('malformed price, trade identity, inventory, state and history rejected', () => {
  for (const alter of [
    (j) => (j.previous.trades[0].p = NaN),
    (j) => (j.previous.trades[0].b = 'Unknown'),
    (j) => j.previous.held[0]++,
    (j) => j.previous.players[1].cards++,
    (j) => j.events.find((e) => e.kind === 'state').held[0]++,
    (j) => (j.events.find((e) => e.kind === 'fill').trade = { ...j.previous.trades[0], p: 7 }),
  ]) {
    const j = fixture([4, 3, 1, 0], [[0, 1]]);
    alter(j);
    assert.equal(scoreRound(j), null);
  }
});
test('stale, ended and post-reveal predictions excluded', () => {
  const j = fixture([4, 3, 1, 0], [[0, 1]]);
  const p = clone(j.events.find((e) => e.kind === 'prediction'));
  j.events.push(p);
  const first = j.events.find((e) => e.kind === 'prediction');
  first.tradeCount = 99;
  renumber(j);
  assert.equal(scoreRound(j).checkpoints, 1);
  assert.equal(scoreRound(j).excludedCheckpoints, 2);
});
test('early result metadata excludes forecasts before reveal event arrives', () => {
  const j = fixture([4, 4, 0, 0]);
  j.events[0].snapshot.roundResult = { goal: 's' };
  assert.equal(scoreRound(j), null);
});
test('malformed scenarios and missing fields do not throw', () => {
  for (const value of [null, {}, 'bad', [null]]) {
    const j = fixture([4, 4, 0, 0]);
    j.events.find((e) => e.kind === 'prediction').goalScenarios = value;
    assert.equal(scoreRound(j), null);
  }
  for (const j of [
    null,
    {},
    { previous: {} },
    { previous: { status: 'ended' }, revealed: { goal: 's' } },
  ])
    assert.equal(scoreRound(j), null);
});
test('invalid category probabilities are omitted from category score', () => {
  const j = fixture([4, 4, 0, 0]);
  j.events.find((e) => e.kind === 'prediction').goalScenarios[0].soloProbability = 2;
  assert.equal(scoreRound(j).categoryBrier, null);
});
test('inputs remain unchanged and deeply frozen inputs work', () => {
  const j = fixture([4, 3, 1, 0], [[0, 1]]);
  const before = JSON.stringify(j);
  perfect(frozen(j));
  assert.equal(JSON.stringify(j), before);
});
test('offline goal-column labels use the exact live prefix and default stays compact', () => {
  const j = fixture([5, 3, 0, 0], [[0, 1]]);
  const before = JSON.stringify(j);
  assert.equal(auditRound(j).labels, undefined);
  const a = auditRound(j, { includeLabels: true });
  assert.deepEqual(
    a.labels.map((p) => p.candidates[0].counts),
    [
      [5, 3, 0, 0],
      [4, 4, 0, 0],
    ],
  );
  assert.ok(a.labels.every((p) => p.candidates[0].bonusPool === 120));
  assert.equal(JSON.stringify(j), before);
});
test('offline labels retain every feasible allocation and do not require stored forecasts', () => {
  const j = fixture(
    [4, 4, 0, 0],
    Array.from({ length: 4 }, () => [0, 1]),
    [0],
  );
  delete j.events.find((e) => e.kind === 'prediction').goalScenarios;
  const a = auditRound(j, { includeLabels: true });
  assert.equal(a.score, null);
  assert.equal(a.labels[0].candidates.length, 2);
  assert.ok(a.labels[0].candidates.every((c) => c.counts[0] === 4));
  j.events.find((e) => e.kind === 'fill').recovered = true;
  assert.equal(auditRound(j, { includeLabels: true }).labels, undefined);
});
console.log(tests + ' bonus-score tests passed');
