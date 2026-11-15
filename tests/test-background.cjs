const assert = require('node:assert/strict');
const { setup } = require('./figgie-fixture.cjs');
const { start, db, control, copy } = require('./background-harness.cjs');
(async () => {
  const dom = setup();
  const raw = dom.window.FiggieAdapter.read(dom.window.document);
  const snapshot = copy({
    ...raw,
    refs: undefined,
    observedAt: Date.now(),
    context: { botDifficulty: 'Medium' },
  });
  dom.window.close();
  let send = start();
  let seq = 0;
  const packet = (s) => ({
    type: 'figgie-record',
    batch: [{ kind: 'observe', stream: 'test-stream', seq: ++seq, at: Date.now(), snapshot: s }],
  });
  const first = packet(snapshot);
  const ack = await send(first);
  assert(ack.recording.events > 0);
  assert(db.events.size > 0, 'ack must follow durable commit');
  const count = db.events.size;
  await send(first);
  assert.equal(db.events.size, count, 'duplicate delivery is idempotent');
  const result = await send({ type: 'figgie-model', job: { id: 1, snapshot } });
  assert.equal(result.model.version, require('../extension/belief.js').VERSION);
  assert.equal(result.model.mode, 'Opponent');
  assert.equal(
    result.model.behavior.signals.temperature,
    0.6,
    'Medium bots use the promoted active policy',
  );
  assert.equal(
    result.model.behavior.candidateSignals,
    undefined,
    'there is no live shadow candidate',
  );
  assert.equal(result.model.behavior.candidateProbabilities, undefined);
  for (const kind of ['command_attempt', 'command_submitted', 'order_outcome'])
    await send({
      type: 'figgie-record',
      batch: [
        {
          kind,
          stream: 'test-stream',
          seq: ++seq,
          at: Date.now(),
          data: {
            id: 1,
            command: { kind: 'bid', suit: 's', price: 2 },
            decision: { modelVersion: '0.4.0', estimatedGain: 0.5 },
          },
        },
      ],
    });
  const commandEvents = [...db.events.values()].filter((e) => e.commandId === 1);
  assert.equal(commandEvents.length, 3);
  assert.equal(new Set(commandEvents.map((e) => e.id)).size, 3);
  assert(commandEvents.every((e) => e.id.startsWith(e.roundId + ':')));
  const changed = copy(snapshot);
  changed.markets[1].bid = 12;
  changed.markets[1].buyer = 'Bot-Moth';
  changed.signature = 'quote12';
  changed.analysisRevision = 2;
  await send(packet(changed));
  const next = await send({ type: 'figgie-model', job: { id: 2, snapshot: changed } });
  assert.notDeepEqual(
    next.model.bySuit.map((s) => s.probability),
    result.model.bySuit.map((s) => s.probability),
  );
  const before = next.model.bySuit.map((s) => s.probability);
  await send({ type: 'figgie-record-status' });
  send = start();
  await send({ ...packet(changed), batch: [{ ...packet(changed).batch[0], stream: 'reloaded' }] });
  const after = await send({ type: 'figgie-model', job: { id: 3, snapshot: changed } });
  after.model.bySuit.forEach((s, i) =>
    assert(
      Math.abs(s.probability - before[i]) < 1e-12,
      'background restart restores evidence, not just snapshots',
    ),
  );
  control.fail = true;
  const changedAgain = copy(changed);
  changedAgain.markets[1].bid = 13;
  changedAgain.signature = 'quote13';
  const pending = packet(changedAgain);
  const failed = await send(pending);
  assert(failed.error);
  control.fail = false;
  const retried = await send(pending);
  assert(!retried.error);
  const quotes = [...db.events.values()].filter(
    (e) => e.kind === 'quote' && e.suit === 'c' && e.side === 'bid' && e.price === 13,
  );
  assert.equal(quotes.length, 1, 'retry cannot duplicate evidence');
  assert(
    (await send({ type: 'figgie-reveal', result: { goal: 's', source: 'test' } })).error,
    'live rounds cannot be labeled',
  );
  const ended = copy(changedAgain);
  ended.status = 'ended';
  ended.signature = 'ended';
  await send(packet(ended));
  const archive = await send({ type: 'figgie-rounds' });
  assert.equal(archive.rounds.length, 1);
  assert(archive.rounds[0].ended);
  const recordedId = archive.rounds[0].id;
  send = start();
  const revealed = await send({
    type: 'figgie-reveal',
    roundId: recordedId,
    result: { goal: 's', source: 'test', verified: true },
  });
  assert.equal(revealed.metrics.rounds, 1);
  await send({
    type: 'figgie-reveal',
    roundId: recordedId,
    result: { goal: 's', source: 'test', verified: true },
  });
  assert.equal(
    db.learning.get('global').metrics.rounds,
    1,
    'archived result cannot be scored twice',
  );
  assert.equal(
    db.learning.get('global').groupMetrics['bots:Medium'].rounds,
    1,
    'active group model scored and persisted once',
  );
  assert(Number.isFinite(db.learning.get('global').groupMetrics['bots:Medium'].opponentBrier));
  assert.equal(
    db.learning.get('global').signalMetrics?.['bots:Medium'],
    undefined,
    'active policy does not manufacture a shadow comparison',
  );
  const prediction = [...db.events.values()].find((e) => e.kind === 'prediction');
  assert(prediction.inventoryEvidence, 'inventory evidence diagnostics persist with forecasts');
  assert(
    prediction.inventoryCalibration,
    'inventory calibration diagnostics persist with forecasts',
  );
  assert.equal(prediction.signals.temperature, 0.6, 'the recorded policy matches the live model');
  assert.equal(prediction.candidateProbabilities, undefined);
  assert.equal(
    [...db.events.values()].filter((e) => e.kind === 'round_score').length,
    1,
    'repeat reveal cannot append another score',
  );
  const exported = await send({ type: 'figgie-export', roundId: 'all' });
  assert(exported.text.includes('prediction'));
  assert(exported.text.includes('reveal'));
  assert(exported.text.includes('quote'));
  assert(
    (
      await send(
        { type: 'figgie-record-status' },
        { id: 'wrong', tab: { id: 6, url: 'https://www.figgie.com/play/' } },
      )
    ).rejected,
  );
  const old = copy(db.learning.get('global'));
  const population = copy(old.population);
  delete old.calibrationVersion;
  old.metrics.rounds = 99;
  db.learning.set('global', old);
  send = start();
  const migrated = await send({ type: 'figgie-record-status' });
  assert.equal(
    migrated.metrics.rounds,
    1,
    'old aggregate metrics are rebuilt from live pre-reveal evidence',
  );
  assert.equal(db.learning.get('global').calibrationVersion, 2);
  assert.deepEqual(
    db.learning.get('global').population,
    population,
    'migration preserves policy learning',
  );
  console.log(
    JSON.stringify(
      {
        recordingAck: 'after commit',
        redelivery: 'idempotent',
        workerRestart: 'posterior restored',
        storageFailure: 'surfaced and retried without duplicate evidence',
        reveals: 'atomically scored once',
        export: 'events + predictions + results',
        scope: 'sender checked',
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
