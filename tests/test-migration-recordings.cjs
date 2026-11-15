const assert = require('node:assert/strict');
const { start, db, copy } = require('./background-harness.cjs');
const base = {
  self: 'You',
  status: 'live',
  timer: '3:59',
  cash: 300,
  held: [3, 2, 3, 2],
  startingHand: [3, 2, 3, 2],
  trades: [],
  markets: [],
  context: { botDifficulty: 'Hard' },
  players: [
    { name: 'You', cash: 300 },
    { name: 'Bot-Fox', cash: 300 },
    { name: 'Bot-Owl', cash: 300 },
    { name: 'Bot-Hare', cash: 300 },
  ],
};
function addRound(id, practice = false) {
  let seq = 0;
  const append = (kind, data, at) => {
    const event = { ...data, kind, at, seq: ++seq, roundId: id, id: id + ':' + seq };
    db.events.set(event.id, copy(event));
  };
  const prediction = { probabilities: [0.4, 0.2, 0.2, 0.2], baseline: [0.25, 0.25, 0.25, 0.25] };
  append('round_start', { snapshot: base }, 1000);
  append('prediction', prediction, 2000);
  append('fill_prediction', { key: 'recovered', pFill: 0.25, expiresAt: 13000 }, 3000);
  append('fill_outcome', { key: 'recovered', pFill: 0.25, filled: true, censored: true }, 4000);
  append('fill_prediction', { key: 'gap', pFill: 0.5, expiresAt: 15000 }, 5000);
  append('coverage', { status: 'live', reason: 'Observation gap' }, 6000);
  append('fill_outcome', { key: 'gap', pFill: 0.5, filled: true, censored: true }, 7000);
  append('reveal', { goal: 's' }, 8000);
  append('prediction', prediction, 8100);
  append('clock', { status: 'ended', timer: '0:00' }, 8200);
  append('prediction', prediction, 8300);
  db.rounds.set(id, {
    id,
    seq,
    practice,
    observedAt: 8300,
    snapshot: { ...copy(base), status: 'ended' },
    revealed: { goal: 's' },
  });
}
addRound('legacy-normal');
addRound('legacy-practice', true);
const old = {
  id: 'global',
  version: '0.5.0',
  scored: [...db.rounds.keys()],
  metrics: { rounds: 2 },
  population: { bots: [0.4, 0.6], mixed: [0.6, 0.4] },
  stylePriors: { Opponent: [0.3, 0.7] },
  rates: {
    bid: { fills: 5, exposure: 10, outbids: 2 },
    ask: { fills: 4, exposure: 8, outbids: 1 },
    resets: 3,
    liveSeconds: 25,
  },
};
db.learning.set('global', copy(old));
(async () => {
  const before = JSON.stringify({
    population: old.population,
    styles: old.stylePriors,
    rates: old.rates,
  });
  const rawEvents = JSON.stringify([...db.events]);
  const send = start();
  const result = await send({ type: 'figgie-record-status' });
  assert(!result.error, result.error);
  const learned = db.learning.get('global');
  assert.equal(learned.metrics.rounds, 1, 'practice rounds are excluded');
  assert(Math.abs(learned.metrics.opponentBrier - 0.48) < 1e-12);
  assert.equal(learned.metrics.baselineBrier, 0.75);
  assert.equal(learned.metrics.fillScored, 1, 'coverage gaps stay censored');
  assert.equal(learned.metrics.fillBrier, 0.5625);
  assert.equal(learned.calibrationAudit.recoveredKnownFills, 1);
  assert.equal(
    learned.calibrationAudit.excludedPostEndCheckpoints,
    2,
    'predictions after reveal or round end are excluded',
  );
  assert.deepEqual(learned.scored, ['legacy-normal']);
  assert.equal(learned.groupMetrics['bots:Hard'].rounds, 1);
  assert.equal(
    JSON.stringify({
      population: learned.population,
      styles: learned.stylePriors,
      rates: learned.rates,
    }),
    before,
  );
  assert.equal(
    JSON.stringify([...db.events]),
    rawEvents,
    'migration leaves raw recordings unchanged',
  );
  const once = JSON.stringify(learned);
  await send({ type: 'figgie-record-status' });
  assert.equal(JSON.stringify(db.learning.get('global')), once);
  console.log(
    JSON.stringify(
      {
        scoredRounds: 1,
        recoveredFills: 1,
        excludedPostRevealOrEnd: 2,
        coverageGaps: 'excluded',
        practice: 'excluded',
        policyPriors: 'preserved',
        hazardRates: 'preserved',
        migration: 'idempotent',
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
