const assert = require('node:assert/strict');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
const T = require('../extension/training.js');
const Bonus = require('../extension/bonus-score.js');
const { start, db, copy } = require('./background-harness.cjs');
const IDS = ['s', 'c', 'd', 'h'];
const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
const hands = {
  You: [4, 4, 1, 1],
  'Bot-A': [4, 2, 2, 2],
  'Bot-B': [0, 3, 4, 3],
  'Bot-C': [0, 3, 3, 4],
};
function snapshot(round = 1, visible = true) {
  return {
    status: 'live',
    self: 'You',
    room: 'training-test',
    round,
    roundKey: 'training-test|' + round,
    signature: 'frame-' + round,
    analysisRevision: round,
    cash: 350,
    held: [4, 4, 1, 1],
    startingHand: [4, 4, 1, 1],
    players: names.map((name) => ({ name, cards: 10, cash: 350 })),
    trades: [],
    net: names.map(() => [0, 0, 0, 0]),
    timer: '3:00',
    context: { botDifficulty: 'Medium' },
    markets: IDS.map((id) => ({
      id,
      held: id === 's' || id === 'c' ? 4 : 1,
      bid: 2,
      ask: 12,
      buyer: 'You',
      seller: 'Bot-A',
      canBuy: true,
      canSell: true,
      canBid: true,
      canOffer: true,
      canRaiseBid: true,
      canLowerAsk: true,
      fills: [],
    })),
    training: {
      enabled: visible,
      handsVisible: visible,
      valid: true,
      hands: copy(hands),
      startingHands: copy(hands),
      deckTotals: [8, 12, 10, 10],
    },
  };
}
function finish(raw) {
  const ended = copy(raw);
  ended.status = 'ended';
  ended.timer = '0:00';
  ended.signature += 'ended';
  const profits = raw.trades.length
    ? { You: 108, 'Bot-A': -8, 'Bot-B': -50, 'Bot-C': -50 }
    : { You: 50, 'Bot-A': 50, 'Bot-B': -50, 'Bot-C': -50 };
  const banks = Object.fromEntries(names.map((name) => [name, 400 + profits[name]]));
  ended.cash = banks.You;
  ended.players.forEach((p) => (p.cash = banks[p.name]));
  const result = {
    goal: 's',
    source: 'official-round-rankings',
    verified: true,
    profits,
    banks,
    settledProfit: profits.You,
    settledBank: banks.You,
  };
  ended.roundResult = result;
  return { ended, result };
}
const fields = [
  'metrics',
  'groupMetrics',
  'bonusMetrics',
  'bonusGroupMetrics',
  'stylePriors',
  'population',
  'styleCounts',
  'humanStyleCounts',
  'rates',
  'scored',
  'fillScoredRounds',
  'bonusScoredRounds',
];
const statistics = (l) => Object.fromEntries(fields.map((k) => [k, l[k] ?? null]));
(async () => {
  let send = start();
  let seq = 0;
  const record = (kind, data, at) => ({
    type: 'figgie-record',
    batch: [{ kind, ...data, at, stream: 'training', seq: ++seq }],
  });
  const observe = (s, at) => send(record('observe', { snapshot: s }, at));
  await send({ type: 'figgie-record-status' });
  const before = statistics(copy(db.learning.get('global')));
  const s = snapshot();
  let ack = await observe(s, 1000);
  assert(ack.recording.practice);
  assert.equal(ack.recording.revealed, null);
  const id = ack.recording.roundId;
  let response = await send({ type: 'figgie-model', job: { id: 1, snapshot: s } });
  assert(!response.error, response.error);
  const blind = response.model.bySuit.map((v) => v.probability);
  assert(response.model.training.available);
  assert.equal(response.model.training.exactGoal, 's');
  assert(blind.some((v) => v > 0 && v < 1));
  assert.equal(db.rounds.get(id).revealed, null, 'visible training truth never self-reveals');
  const alternative = copy(s);
  alternative.signature = 'private hands changed';
  alternative.training.hands = {
    You: [4, 4, 1, 1],
    'Bot-A': [4, 2, 2, 2],
    'Bot-B': [2, 1, 4, 3],
    'Bot-C': [2, 1, 3, 4],
  };
  alternative.training.startingHands = copy(alternative.training.hands);
  alternative.training.deckTotals = [12, 8, 10, 10];
  alternative.truth = { goal: 'c' };
  alternative.players[1].privateHand = [4, 2, 2, 2];
  await observe(alternative, 1100);
  response = await send({ type: 'figgie-model', job: { id: 2, snapshot: alternative } });
  assert.equal(response.model.training.exactGoal, 'c');
  assert.deepEqual(
    response.model.bySuit.map((v) => v.probability),
    blind,
    'private hands cannot alter blind inference',
  );
  const checkpointAt = 1234;
  await send(
    record(
      'training_prediction',
      {
        data: {
          roundKey: s.roundKey,
          at: checkpointAt,
          tradeCount: 0,
          timer: '3:00',
          userProbabilities: [0.6, 0.2, 0.1, 0.1],
          blindProbabilities: blind,
          modelVersion: response.model.version,
          reason: 'testing',
          afterPeek: false,
        },
      },
      1200,
    ),
  );
  let prediction = [...db.events.values()].find((e) => e.kind === 'training_prediction');
  assert.equal(prediction.checkpointAt, checkpointAt);
  assert.equal(prediction.trainingTruth, undefined);
  assert.equal(prediction.trainingScores, undefined);
  assert.equal(prediction.serverBlindModel.training, undefined);
  assert.equal(prediction.afterPeek, false);
  ack = await send(
    record(
      'training_peek',
      {
        data: {
          roundKey: s.roundKey,
          checkpointAt,
          tradeCount: 0,
          revealedPlayers: ['Bot-A'],
          fullyRevealed: false,
        },
      },
      1250,
    ),
  );
  assert(ack.recording.practicePeeked);
  const peek = [...db.events.values()].find((e) => e.kind === 'training_peek');
  assert.equal(peek.trainingTruth.exactGoal, 'c');
  assert.equal(peek.trainingScores.user.goalProbability, 0.2);
  assert.equal(db.rounds.get(id).revealed, null);
  send = start();
  const hidden = copy(s);
  hidden.training.enabled = false;
  hidden.training.handsVisible = false;
  hidden.signature = 'hands hidden again';
  ack = await observe(hidden, 1300);
  assert(
    ack.recording.practice && ack.recording.practicePeeked,
    'practice and peek are sticky after reload and hiding hands',
  );
  assert.equal(ack.recording.roundKey, s.roundKey);
  await send(record('training_continue', { data: { roundKey: s.roundKey, checkpointAt } }, 1350));
  await send(
    record(
      'training_prediction',
      {
        data: {
          roundKey: s.roundKey,
          at: 1400,
          userProbabilities: [0.25, 0.25, 0.25, 0.25],
          afterPeek: false,
        },
      },
      1400,
    ),
  );
  prediction = [...db.events.values()].filter((e) => e.kind === 'training_prediction').at(-1);
  assert.equal(prediction.afterPeek, true, 'backend preserves peek history');
  const filled = copy(hidden);
  filled.signature = 'one training fill';
  filled.trades = [{ s: 'Bot-A', b: 'You', suit: 's', p: 12 }];
  filled.held[0]++;
  filled.net[0][0]++;
  filled.net[1][0]--;
  filled.players[0].cards++;
  filled.players[1].cards--;
  filled.cash -= 12;
  filled.players[0].cash -= 12;
  filled.players[1].cash += 12;
  filled.markets[0].held++;
  filled.markets[0].fills = copy(filled.trades);
  await observe(filled, 1500);
  response = await send({ type: 'figgie-model', job: { id: 3, snapshot: filled } });
  assert(!response.error, response.error);
  const recordNow = copy(db.rounds.get(id));
  const eventsNow = [...db.events.values()].filter((e) => e.roundId === id);
  const j = J.restore(recordNow, eventsNow);
  const normalLearning = copy(db.learning.get('global'));
  const direct = new B.BeliefEngine().infer(T.blindSnapshot(filled), j.evidence, {
    ...normalLearning,
    rates: normalLearning.rates,
  });
  assert(
    j.rates.liveSeconds > 0 && j.rates.resets > 0,
    'practice public activity remains recorded',
  );
  assert.equal(
    response.model.resting.s.bid.pFill,
    direct.resting.s.bid.pFill,
    'practice local fill rates never enter blind inference',
  );
  const { ended, result } = finish(filled);
  await observe(ended, 1600);
  await send(record('reveal', { result }, 1700));
  assert.deepEqual(
    statistics(db.learning.get('global')),
    before,
    'practice does not update any normal calibration or learned policy',
  );
  assert.equal(
    [...db.events.values()].filter(
      (e) => e.roundId === id && ['round_score', 'bonus_score'].includes(e.kind),
    ).length,
    0,
  );
  assert.equal(
    J.scoreRound(
      J.restore(
        db.rounds.get(id),
        [...db.events.values()].filter((e) => e.roundId === id),
      ),
    ),
    null,
  );
  assert.equal(
    Bonus.scoreRound({
      ...db.rounds.get(id),
      events: [...db.events.values()].filter((e) => e.roundId === id),
    }),
    null,
  );
  assert.equal(
    J.scoredFillOutcomes([...db.events.values()].filter((e) => e.roundId === id)).length,
    0,
  );
  assert.equal(
    J.livePredictions([...db.events.values()].filter((e) => e.roundId === id)).length,
    0,
  );
  let archived = await send({ type: 'figgie-rounds' });
  assert(archived.rounds.find((r) => r.id === id).practice);
  const exported = await send({ type: 'figgie-export', roundId: id });
  assert(
    exported.text.includes('training_prediction') &&
      exported.text.includes('training_peek') &&
      exported.text.includes('training_continue'),
  );
  // Calibration migration also excludes practice records, even legacy marked ids.
  const old = copy(db.learning.get('global'));
  delete old.calibrationVersion;
  old.scored = [id];
  old.metrics.rounds = 99;
  db.learning.set('global', old);
  send = start();
  await send({ type: 'figgie-record-status' });
  assert.equal(db.learning.get('global').metrics.rounds, 0);
  assert.equal(db.learning.get('global').metrics.fillScored, 0);
  assert(!db.learning.get('global').scored.includes(id));
  assert.deepEqual(db.learning.get('global').population, before.population);
  assert.deepEqual(db.learning.get('global').rates, before.rates);
  // A later normal round starts clean; ended-only reveal data is not practice.
  const normal = snapshot(2, false);
  ack = await observe(normal, 2000);
  assert.equal(ack.recording.practice, false);
  assert.equal(ack.recording.practicePeeked, false);
  const normalId = ack.recording.roundId;
  assert.notEqual(normalId, id);
  await send({ type: 'figgie-model', job: { id: 4, snapshot: normal } });
  await send(record('training_peek', { data: { roundKey: s.roundKey, checkpointAt } }, 2100));
  assert.equal(
    db.rounds.get(normalId).practice,
    false,
    'stale prior-round training command cannot contaminate the new round',
  );
  const normalEnd = finish(normal);
  normalEnd.ended.training.enabled = true;
  normalEnd.ended.training.handsVisible = true;
  await observe(normalEnd.ended, 2200);
  await send(record('reveal', { result: normalEnd.result }, 2300));
  assert.equal(db.rounds.get(normalId).practice, false);
  assert.equal(db.learning.get('global').metrics.rounds, 1);
  assert.equal(db.learning.get('global').bonusMetrics.rounds, 1);
  assert(db.learning.get('global').scored.includes(normalId));
  // Recovery can derive the sticky label from events even if metadata is old.
  const legacy = copy(db.rounds.get(id));
  delete legacy.practice;
  delete legacy.practicePeeked;
  const restored = J.restore(
    legacy,
    [...db.events.values()].filter((e) => e.roundId === id),
  );
  assert(restored.practice && restored.practicePeeked);
  // A peek must use the UI's frozen inventory, including after fills/restart.
  const checkpointRound = snapshot(3, true);
  await observe(checkpointRound, 3000);
  response = await send({ type: 'figgie-model', job: { id: 5, snapshot: checkpointRound } });
  const frozenBlind = response.model.bySuit.map((v) => v.probability);
  await send(
    record(
      'training_prediction',
      {
        data: {
          roundKey: checkpointRound.roundKey,
          at: 3100,
          tradeCount: 0,
          userProbabilities: [0.6, 0.2, 0.1, 0.1],
          blindProbabilities: frozenBlind,
        },
      },
      3100,
    ),
  );
  const later = copy(checkpointRound);
  later.signature = 'training advanced';
  later.trades = [{ b: 'You', s: 'Bot-A', suit: 's', p: 12 }];
  later.held[0]++;
  later.net[0][0]++;
  later.net[1][0]--;
  later.players[0].cards++;
  later.players[1].cards--;
  later.cash -= 12;
  later.players[0].cash -= 12;
  later.players[1].cash += 12;
  later.training.hands.You[0]++;
  later.training.hands['Bot-A'][0]--;
  later.markets[0].held++;
  later.markets[0].fills = copy(later.trades);
  await observe(later, 3200);
  send = start();
  await observe(later, 3300);
  await send(
    record(
      'training_peek',
      { data: { roundKey: later.roundKey, checkpointAt: 3100, tradeCount: 0 } },
      3350,
    ),
  );
  const frozenPeek = [...db.events.values()].filter((e) => e.kind === 'training_peek').at(-1);
  assert.equal(frozenPeek.trainingTruth.asOfTradeCount, 0);
  assert.equal(frozenPeek.trainingTruth.players.find((p) => p.name === 'You').currentHand[0], 4);
  assert.equal(
    frozenPeek.trainingTruth.settlement.total,
    100,
    'recorded truth remains at the forecast, not later 170-chip settlement',
  );
  await send(
    record(
      'training_prediction',
      {
        data: {
          roundKey: later.roundKey,
          at: 3400,
          tradeCount: 0,
          userProbabilities: [0.25, 0.25, 0.25, 0.25],
          blindProbabilities: frozenBlind,
        },
      },
      3400,
    ),
  );
  await send(
    record('training_peek', { data: { roundKey: later.roundKey, checkpointAt: 3400 } }, 3450),
  );
  assert.equal(
    [...db.events.values()].filter((e) => e.kind === 'training_peek').at(-1).trainingTruth
      .asOfTradeCount,
    0,
    'lagging UI trade count selects an earlier recorded raw checkpoint',
  );
  await send(
    record(
      'training_prediction',
      {
        data: {
          roundKey: later.roundKey,
          at: 3500,
          tradeCount: 99,
          userProbabilities: [0.25, 0.25, 0.25, 0.25],
        },
      },
      3500,
    ),
  );
  await send(
    record('training_peek', { data: { roundKey: later.roundKey, checkpointAt: 3500 } }, 3550),
  );
  assert.equal(
    [...db.events.values()].filter((e) => e.kind === 'training_peek').at(-1).trainingTruth
      .available,
    false,
    'missing frozen checkpoint never borrows future truth',
  );
  const partial = snapshot(4, true);
  partial.training.valid = false;
  const p = new J.RoundJournal('partial', 'partial');
  p.observe(partial, 1000);
  assert(p.practice, 'partial visible information also excludes a round');
  // Partial source exposure can precede a complete visible-hands snapshot.
  const quoted = snapshot(8, true);
  quoted.analysisRevision = 80;
  quoted.markets[0].ask = 7;
  quoted.signature = 'quote7';
  await observe(quoted, 3600);
  await send({ type: 'figgie-model', job: { id: 8, snapshot: quoted } });
  const newerQuote = copy(quoted);
  newerQuote.analysisRevision = 81;
  newerQuote.markets[0].ask = 8;
  newerQuote.signature = 'quote8';
  await observe(newerQuote, 3700);
  await send(
    record(
      'training_prediction',
      {
        data: {
          roundKey: quoted.roundKey,
          at: 3750,
          tradeCount: 0,
          sourceRevision: 80,
          userProbabilities: [0.25, 0.25, 0.25, 0.25],
          blindProbabilities: frozenBlind,
        },
      },
      3750,
    ),
  );
  await send(
    record('training_peek', { data: { roundKey: quoted.roundKey, checkpointAt: 3750 } }, 3760),
  );
  const quotePeek = [...db.events.values()].filter((e) => e.kind === 'training_peek').at(-1);
  assert.equal(
    quotePeek.trainingTruth.bySuit[0].buyEdge,
    63,
    'source revision preserves ask7 instead of later ask8 at the same trade count',
  );
  await send(
    record(
      'training_prediction',
      {
        data: {
          roundKey: quoted.roundKey,
          at: 3770,
          tradeCount: 0,
          sourceRevision: 999,
          userProbabilities: [0.25, 0.25, 0.25, 0.25],
        },
      },
      3770,
    ),
  );
  await send(
    record('training_peek', { data: { roundKey: quoted.roundKey, checkpointAt: 3770 } }, 3780),
  );
  assert.equal(
    [...db.events.values()].filter((e) => e.kind === 'training_peek').at(-1).trainingTruth
      .available,
    false,
    'missing exact revision does not borrow another quote frame',
  );
  const partialSource = snapshot(5, false);
  ack = await observe(partialSource, 4000);
  const partialId = ack.recording.roundId;
  assert.equal(ack.recording.practice, false);
  await send(record('training_exposure', { data: { source: 'partial-visible-hands' } }, 4050));
  assert.equal(
    db.rounds.get(partialId).practice,
    false,
    'unbound exposure cannot taint an arbitrary round',
  );
  ack = await send(
    record(
      'training_exposure',
      { data: { roundKey: partialSource.roundKey, source: 'partial-visible-hands' } },
      4100,
    ),
  );
  assert(ack.recording.practice, 'bound partial exposure marks even a concealed last valid frame');
  send = start();
  ack = await observe(partialSource, 4200);
  assert(ack.recording.practice, 'partial exposure remains durable');
  const firstComplete = snapshot(6, false);
  firstComplete.context.learningExposure = true;
  ack = await observe(firstComplete, 4300);
  assert(ack.recording.practice, 'pending exposure on first valid frame is isolated');
  const onlyEnd = snapshot(7, false);
  onlyEnd.status = 'ended';
  onlyEnd.context.learningExposure = true;
  const endJournal = new J.RoundJournal('ended-only', 'end');
  endJournal.observe(onlyEnd, 1000);
  assert(!endJournal.practice, 'an ended-only exposure tag does not mark normal play');
  const resetRound = snapshot(9, true);
  ack = await observe(resetRound, 5000);
  const firstSegment = ack.recording.roundId;
  await send(
    record('training_peek', { data: { roundKey: resetRound.roundKey, checkpointAt: 5000 } }, 5050),
  );
  const expanded = copy(resetRound);
  expanded.signature = 'before history reset';
  expanded.trades = [{ b: 'You', s: 'Bot-A', suit: 's', p: 12 }];
  expanded.held[0]++;
  expanded.net[0][0]++;
  expanded.net[1][0]--;
  expanded.training.hands.You[0]++;
  expanded.training.hands['Bot-A'][0]--;
  await observe(expanded, 5100);
  const reset = copy(resetRound);
  reset.training.enabled = false;
  reset.training.handsVisible = false;
  reset.signature = 'history reset';
  ack = await observe(reset, 5200);
  assert.notEqual(ack.recording.roundId, firstSegment);
  assert(
    ack.recording.practice && ack.recording.practicePeeked,
    'same-round history reset inherits prior exposure without tainting next rounds',
  );
  console.log(
    'Training isolation: blind inputs, durable practice/peek, truth separated until peek, no normal goal/style/fill/bonus learning, migration exclusion, normal next-round scoring: passed.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
