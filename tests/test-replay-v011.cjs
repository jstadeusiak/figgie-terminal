'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { start, copy } = require('./background-harness.cjs');
const J = require('../extension/journal.js');
const manifest = require('../extension/manifest.json');
const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
const IDS = ['s', 'c', 'd', 'h'];
const hand = [3, 3, 2, 2];
function frame(revision, trades = [], book = {}) {
  const net = names.map(() => [0, 0, 0, 0]);
  const cash = names.map(() => 350);
  for (const t of trades) {
    const s = IDS.indexOf(t.suit);
    const a = names.indexOf(t.s);
    const b = names.indexOf(t.b);
    net[a][s]--;
    net[b][s]++;
    cash[a] += t.p;
    cash[b] -= t.p;
  }
  const held = hand.map((v, s) => v + net[0][s]);
  const markets = IDS.map((id, s) => ({
    id,
    held: held[s],
    bid: null,
    ask: null,
    buyer: null,
    seller: null,
    canBuy: true,
    canSell: held[s] > 0,
    canBid: true,
    canOffer: held[s] > 0,
    canRaiseBid: true,
    canLowerAsk: held[s] > 0,
    fills: trades.filter((t) => t.suit === id),
    ...book[id],
  }));
  return {
    status: 'live',
    self: 'You',
    room: 'replay-regression',
    round: 1,
    roundKey: 'replay-regression|1',
    analysisRevision: revision,
    recordingRequired: true,
    signature: JSON.stringify([revision, trades, book]),
    cash: cash[0],
    startingHand: hand,
    held,
    net,
    players: names.map((name, p) => ({
      name,
      cash: cash[p],
      cards: 10 + net[p].reduce((a, b) => a + b, 0),
    })),
    trades: copy(trades),
    markets,
    timer: '2:00',
    context: { botDifficulty: 'Medium' },
  };
}
async function main() {
  let now = 100000;
  let send = start({ now: () => now });
  let seq = 0;
  const observe = async (s, at) => {
    now = at;
    const r = await send({
      type: 'figgie-record',
      batch: [{ kind: 'observe', stream: 'replay-regression', seq: ++seq, at: now, snapshot: s }],
    });
    assert(!r.error, r.error);
    return r;
  };
  const infer = async (s) => {
    const r = await send({ type: 'figgie-model', job: { id: s.analysisRevision, snapshot: s } });
    assert(!r.error, r.error);
    assert.equal(r.model.version, manifest.version);
    assert.equal(r.model.behavior.opponentLearning.samplesPerDeck, 12);
    return r;
  };
  const opening = frame(1, [], { h: { ask: 5, seller: 'Bot-A', bid: 2, buyer: 'Bot-C' } });
  await observe(opening, 100000);
  await infer(opening);
  await observe(frame(2, [], { h: { ask: 6, seller: 'Bot-A', bid: 3, buyer: 'Bot-C' } }), 100500);
  const trades = [{ s: 'Bot-A', b: 'Bot-B', suit: 'h', p: 6 }];
  await observe(frame(3, trades, { c: { ask: 4, seller: 'Bot-A' } }), 101000);
  await observe(
    frame(4, trades, {
      h: { ask: 8, seller: 'You', bid: 7, buyer: 'Bot-A' },
      c: { ask: 4, seller: 'Bot-A' },
    }),
    101500,
  );
  trades.push({ s: 'You', b: 'Bot-A', suit: 'h', p: 8 });
  await observe(frame(5, trades, { c: { ask: 4, seller: 'Bot-A' } }), 102000);
  trades.push({ s: 'Bot-A', b: 'Bot-C', suit: 'c', p: 4 });
  await observe(
    frame(6, trades, { s: { ask: 7, seller: 'Bot-C' }, h: { bid: 9, buyer: 'Bot-A' } }),
    102500,
  );
  trades.push({ s: 'Bot-C', b: 'You', suit: 's', p: 7 });
  const active = frame(7, trades, {
    h: { bid: 9, buyer: 'Bot-A' },
    d: { ask: 5, seller: 'Bot-B' },
  });
  await observe(active, 103000);
  const checkpoint = frame(8, trades, {
    h: { bid: 10, buyer: 'Bot-A' },
    d: { ask: 5, seller: 'Bot-B' },
  });
  await observe(checkpoint, 116000);
  const live = await infer(checkpoint);
  send = start({ now: () => now });
  await observe(checkpoint, 116000);
  const resumed = await infer(checkpoint);
  assert.deepEqual(
    copy(resumed.model.bySuit),
    copy(live.model.bySuit),
    'restarted worker preserves all suit probabilities and transfer valuations',
  );
  assert.deepEqual(
    copy(resumed.model.resting),
    copy(live.model.resting),
    'restarted worker preserves resting order valuation without additional exposure time',
  );
  const final = frame(9, trades, {
    h: { bid: 11, buyer: 'Bot-A', ask: 15, seller: 'Bot-C' },
    c: { ask: 7, seller: 'Bot-B' },
  });
  await observe(final, 132000);
  await infer(final);
  const exported = await send({ type: 'figgie-export', roundId: 'all' });
  assert(!exported.error, exported.error);
  const rows = exported.text.trim().split('\n').map(JSON.parse);
  const metadata = rows.find((r) => r.kind === 'round_metadata');
  const events = rows.filter((r) => r.roundId === metadata.id);
  const predictions = events.filter((e) => e.kind === 'prediction');
  assert.equal(metadata.version, manifest.version);
  assert.equal(predictions.length, 3);
  assert(predictions.every((e) => e.modelVersion === manifest.version));
  assert(predictions.some((e) => e.tradeCount === 4));
  const restored = J.restore(metadata, events);
  assert(
    restored.evidence.some(
      (e) => e.kind === 'take' && e.counterpartyKnownBeforeAction && e.counterparty === 'You',
    ),
    'fixture exercises named-counterparty public learning',
  );
  assert(
    restored.evidence.some((e) => e.passive === true),
    'fixture contains automatic passive fills',
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figgie-replay-v011-'));
  const file = path.join(directory, 'recording.ndjson');
  try {
    fs.writeFileSync(file, exported.text);
    if (process.env.FIGGIE_REPLAY_FIXTURE)
      fs.writeFileSync(process.env.FIGGIE_REPLAY_FIXTURE, exported.text);
    const processResult = spawnSync(
      process.execPath,
      [path.resolve('extension/replay.cjs'), file],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(processResult.status, 0, processResult.stderr || processResult.stdout);
    const report = JSON.parse(processResult.stdout);
    assert.equal(report.rounds.length, 1);
    assert.equal(report.rounds[0].predictionsChecked, predictions.length);
    assert.equal(report.rounds[0].maxProbabilityReplayError, 0);
    console.log(
      JSON.stringify(
        {
          version: manifest.version,
          exportedEvents: events.length,
          predictionsChecked: predictions.length,
          maxProbabilityReplayError: report.rounds[0].maxProbabilityReplayError,
          workerRestart: 'same probabilities and valuations',
          evidence: 'named active and automatic passive trades',
        },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
