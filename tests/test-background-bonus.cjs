const assert = require('node:assert/strict');
const J = require('../extension/journal.js');
const { start, db, control, copy } = require('./background-harness.cjs');
const IDS = ['s', 'c', 'd', 'h'];
function seed(
  id,
  { difficulty = 'Medium', counts = [4, 4, 0, 0], forecast = 80, categories = true } = {},
) {
  const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
  const hand = [counts[0], 8 - counts[0], 1, 1];
  const total = counts.reduce((a, b) => a + b);
  const bonus = 200 - 10 * total;
  const max = Math.max(...counts);
  const ties = counts.filter((c) => c === max).length;
  const profits = Object.fromEntries(
    names.map((name, i) => [name, -50 + 10 * counts[i] + (counts[i] === max ? bonus / ties : 0)]),
  );
  const banks = Object.fromEntries(names.map((name) => [name, 400 + profits[name]]));
  const result = {
    goal: 's',
    source: 'official-round-rankings',
    verified: true,
    profits,
    banks,
    settledProfit: profits.You,
    settledBank: banks.You,
  };
  const snapshot = {
    status: 'live',
    self: 'You',
    room: id,
    round: 1,
    roundKey: id,
    signature: id + 'live',
    cash: 350,
    held: hand,
    startingHand: hand,
    players: names.map((name) => ({ name, cards: 10, cash: 350 })),
    trades: [],
    net: names.map(() => [0, 0, 0, 0]),
    timer: '3:00',
    context: { botDifficulty: difficulty },
    markets: IDS.map((id) => ({ id, bid: null, ask: null, buyer: null, seller: null })),
  };
  const base = JSON.stringify([snapshot.self, snapshot.room, snapshot.round, names, hand]);
  const journal = new J.RoundJournal(id, base);
  journal.observe(snapshot, 1000);
  const scenario = {
    suit: 's',
    bonus: forecast,
    ...(categories
      ? { soloProbability: 0.5, tieProbability: 0.5, noBonusProbability: 0, leaderProbability: 1 }
      : {}),
  };
  journal.append(
    'prediction',
    {
      tradeCount: 0,
      probabilities: [0.25, 0.25, 0.25, 0.25],
      baseline: [0.25, 0.25, 0.25, 0.25],
      behavior: [0.25, 0.25, 0.25, 0.25],
      modelVersion: '0.7.0',
      goalScenarios: [scenario],
    },
    2000,
  );
  const ended = copy(snapshot);
  ended.status = 'ended';
  ended.signature = id + 'ended';
  ended.timer = '0:00';
  ended.cash = banks.You;
  ended.roundResult = result;
  ended.players.forEach((p) => (p.cash = banks[p.name]));
  journal.observe(ended, 3000);
  const record = {
    id,
    base,
    seq: journal.seq,
    self: 'You',
    snapshot: ended,
    rates: journal.rates,
    accounting: journal.accounting,
    revealed: null,
    observedAt: 3000,
    updatedAt: Date.now(),
    version: '0.7.0',
  };
  db.rounds.set(id, copy(record));
  journal.events.forEach((e) => db.events.set(e.id, copy(e)));
  return { record, result, ended, live: copy(snapshot) };
}
const reveal = (id, result) => ({ type: 'figgie-reveal', roundId: id, result });
const events = (kind, id) =>
  [...db.events.values()].filter((e) => e.kind === kind && (!id || e.roundId === id));
(async () => {
  let send = start();
  const first = seed('bonus-first');
  // A user-saved goal can score its probability, but cannot invent bonus truth.
  let response = await send(
    reveal(first.record.id, { goal: 's', source: 'user-confirmed', verified: false }),
  );
  assert(!response.error);
  assert.equal(db.learning.get('global').metrics.rounds, 1);
  assert.equal(db.learning.get('global').bonusMetrics, undefined);
  const population = copy(db.learning.get('global').population);
  const stale = copy(first.result);
  stale.settledBank++;
  response = await send(reveal(first.record.id, stale));
  assert.match(response.error, /does not match/);
  assert.equal(events('bonus_score').length, 0);
  send = start();
  response = await send(reveal(first.record.id, first.result));
  assert(!response.error, response.error);
  let learned = db.learning.get('global');
  assert.equal(learned.bonusMetrics.rounds, 1);
  assert.equal(learned.bonusMetrics.bonusMae, 20);
  assert.equal(learned.bonusMetrics.bonusBias, 20);
  assert.equal(learned.bonusMetrics.mseRounds, 1);
  assert.equal(learned.bonusMetrics.bonusMse, 400);
  assert.equal(learned.bonusMetrics.bonusRmse, 20);
  assert.equal(learned.bonusMetrics.categoryBrier, 0.5);
  assert.equal(learned.bonusMetrics.categoryRounds, 1);
  assert.equal(learned.bonusMetrics.leaderBrier, 0);
  assert.equal(learned.bonusGroupMetrics['bots:Medium'].rounds, 1);
  assert.equal(events('reveal_verified').length, 1);
  assert.equal(db.rounds.get(first.record.id).revealed.verified, true);
  assert.equal(learned.metrics.rounds, 1, 'verification upgrade does not rescore goal');
  assert.deepEqual(
    learned.population,
    population,
    'bonus scoring does not change style parameters',
  );
  await send(reveal(first.record.id, first.result));
  send = start();
  await send(reveal(first.record.id, first.result));
  assert.equal(events('bonus_score').length, 1);
  assert.equal(
    db.learning.get('global').bonusMetrics.rounds,
    1,
    'persisted round id survives worker restart',
  );
  const conflict = copy(first.result);
  conflict.goal = 'c';
  assert((await send(reveal(first.record.id, conflict))).error);
  const wrongProfit = copy(first.result);
  wrongProfit.profits.You++;
  wrongProfit.profits['Bot-A']--;
  assert((await send(reveal(first.record.id, wrongProfit))).error);
  assert.equal(events('bonus_score').length, 1);
  // Simulate upgrading stored metrics which predate MSE collection. Their
  // historical rounds must not enter the new squared-error denominator.
  learned = copy(db.learning.get('global'));
  for (const metric of [learned.bonusMetrics, ...Object.values(learned.bonusGroupMetrics)])
    for (const key of ['mseRounds', 'bonusMse', 'bonusRmse']) delete metric[key];
  db.learning.set('global', learned);
  send = start();
  // Available category/leader metrics have their own round denominators.
  const second = seed('bonus-second', { counts: [2, 3, 2, 1], forecast: 10, categories: false });
  response = await send(reveal(second.record.id, second.result));
  assert(!response.error, response.error);
  learned = db.learning.get('global');
  assert.equal(learned.bonusMetrics.rounds, 2);
  assert.equal(learned.bonusMetrics.bonusMae, 15);
  assert.equal(learned.bonusMetrics.bonusBias, 15);
  assert.equal(learned.bonusMetrics.mseRounds, 1);
  assert.equal(learned.bonusMetrics.bonusMse, 100);
  assert.equal(learned.bonusMetrics.bonusRmse, 10);
  assert.equal(learned.bonusMetrics.categoryRounds, 1);
  assert.equal(learned.bonusMetrics.categoryBrier, 0.5);
  assert.equal(learned.bonusMetrics.leaderRounds, 1);
  assert.equal(learned.bonusMetrics.leaderBrier, 0);
  assert.equal(learned.bonusGroupMetrics['bots:Medium'].rounds, 2);
  const third = seed('bonus-easy', { difficulty: 'Easy', forecast: 60 });
  response = await send(reveal(third.record.id, third.result));
  assert(!response.error, response.error);
  learned = db.learning.get('global');
  assert.equal(learned.bonusMetrics.rounds, 3);
  assert.equal(learned.bonusMetrics.bonusMae, 10);
  assert.equal(learned.bonusMetrics.mseRounds, 2);
  assert.equal(learned.bonusMetrics.bonusMse, 50);
  assert.equal(learned.bonusMetrics.bonusRmse, Math.sqrt(50));
  assert.equal(learned.bonusMetrics.categoryRounds, 2);
  assert.equal(learned.bonusGroupMetrics['bots:Easy'].rounds, 1);
  assert.equal(learned.bonusGroupMetrics['bots:Medium'].rounds, 2);
  // New scoring never scans old rounds during worker startup/status checks.
  const untouched = seed('bonus-not-backfilled');
  const stored = copy(db.rounds.get(untouched.record.id));
  stored.revealed = untouched.result;
  db.rounds.set(stored.id, stored);
  send = start();
  await send({ type: 'figgie-record-status' });
  assert.equal(db.learning.get('global').bonusMetrics.rounds, 3);
  assert.equal(events('bonus_score', stored.id).length, 0);
  // Invalid official accounting cannot become a bonus label even if banks match.
  const bad = seed('bonus-invalid');
  bad.result.profits['Bot-A']++;
  bad.ended.roundResult = bad.result;
  const badRecord = db.rounds.get(bad.record.id);
  badRecord.snapshot.roundResult = bad.result;
  db.rounds.set(bad.record.id, badRecord);
  await send(reveal(bad.record.id, bad.result));
  assert.equal(events('bonus_score', bad.record.id).length, 0);
  assert.equal(db.learning.get('global').bonusMetrics.rounds, 3);
  // A failed commit retries the same queued score, not a second calculation.
  const retry = seed('bonus-retry');
  await send({
    type: 'figgie-record',
    batch: [{ kind: 'observe', snapshot: retry.ended, at: 4000 }],
  });
  const packet = {
    type: 'figgie-record',
    batch: [{ kind: 'reveal', result: retry.result, at: 5000, stream: 'bonus-retry', seq: 1 }],
  };
  control.fail = true;
  assert((await send(packet)).error);
  assert.equal(events('bonus_score', retry.record.id).length, 0);
  control.fail = false;
  response = await send(packet);
  assert(!response.error, response.error);
  assert.equal(events('bonus_score', retry.record.id).length, 1);
  assert.equal(db.learning.get('global').bonusMetrics.rounds, 4);
  // Native capture sends reveal before the final ended observation. Acknowledging
  // the pending result must not block that later observation, even across restart.
  const native = seed('bonus-native-order');
  db.rounds.delete(native.record.id);
  for (const [id, e] of db.events) if (e.roundId === native.record.id) db.events.delete(id);
  response = await send({
    type: 'figgie-record',
    batch: [{ kind: 'observe', snapshot: native.live, at: 6000 }],
  });
  assert(!response.error, response.error);
  const nativeId = response.recording.roundId;
  await send({ type: 'figgie-model', job: { id: 80, snapshot: native.live } });
  response = await send({
    type: 'figgie-record',
    batch: [{ kind: 'reveal', result: native.result, at: 7000, stream: 'native', seq: 1 }],
  });
  assert(!response.error, response.error);
  assert.equal(events('bonus_score', nativeId).length, 0);
  assert(db.rounds.get(nativeId).pendingSettlement, 'pending official observation is durable');
  send = start();
  response = await send({
    type: 'figgie-record',
    batch: [{ kind: 'observe', snapshot: native.ended, at: 8000, stream: 'native', seq: 2 }],
  });
  assert(!response.error, response.error);
  assert.equal(
    events('bonus_score', nativeId).length,
    1,
    'matching ended observation settles deferred official result',
  );
  assert.equal(db.rounds.get(nativeId).pendingSettlement, null);
  const displayed = await send({ type: 'figgie-model', job: { id: 81, snapshot: native.ended } });
  assert(!displayed.error, displayed.error);
  assert.deepEqual(
    displayed.model.bonusMetrics,
    db.learning.get('global').bonusGroupMetrics['bots:Medium'],
    'separate calibration metrics reach the UI model',
  );
  // A queued recording batch can already contain the next round. Settle the
  // previous round at its matching observation/reveal, before ensure switches it.
  for (const revealFirst of [true, false]) {
    const queued = seed('bonus-batch-' + revealFirst);
    db.rounds.delete(queued.record.id);
    for (const [id, e] of db.events) if (e.roundId === queued.record.id) db.events.delete(id);
    response = await send({
      type: 'figgie-record',
      batch: [{ kind: 'observe', snapshot: queued.live, at: 9000 }],
    });
    const oldId = response.recording.roundId;
    await send({ type: 'figgie-model', job: { id: 90, snapshot: queued.live } });
    const next = copy(queued.live);
    next.round = 2;
    next.roundKey += 'next';
    next.signature += 'next';
    const observation = { kind: 'observe', snapshot: queued.ended, at: 10000 };
    const revelation = { kind: 'reveal', result: queued.result, at: 10000 };
    response = await send({
      type: 'figgie-record',
      batch: [
        ...(revealFirst ? [revelation, observation] : [observation, revelation]),
        { kind: 'observe', snapshot: next, at: 11000 },
      ],
    });
    assert(!response.error, response.error);
    assert.notEqual(response.recording.roundId, oldId);
    assert.equal(
      events('bonus_score', oldId).length,
      1,
      'old round settles before next round in same batch',
    );
    assert.equal(db.rounds.get(oldId).pendingSettlement, null);
    assert.equal(db.rounds.get(oldId).revealed.goal, 's');
  }
  assert.equal(db.rounds.get(retry.record.id).version, require('../extension/belief.js').VERSION);
  console.log(
    JSON.stringify(
      {
        bonusScore: 'official reconciled settlement only',
        verificationUpgrade: 'same goal, no repeated goal learning',
        repeatAndRestart: 'one durable bonus score per round',
        metrics: 'separate global/group averages and nullable denominators',
        startup: 'no historical bonus rescore',
        nativeOrder: 'reveal waits durably for ended snapshot',
        batchRollover: 'previous result scores before next round in either order',
        ui: 'bonus metrics on model',
        failure: 'atomic retry without duplicate score',
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  control.fail = false;
  console.error(error);
  process.exitCode = 1;
});
