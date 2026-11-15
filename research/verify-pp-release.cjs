#!/usr/bin/env node
'use strict';
// Independent direct-archive parity check after the frozen experiment is complete.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const R = require('../tools/model-registry.cjs');
const Quotes = require('./audit-recorded-quote-values.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/pp-weight-review-2026-10-30');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const copy = (x) => JSON.parse(JSON.stringify(x));
const IDS = ['s', 'c', 'd', 'h'];
const protocol = JSON.parse(fs.readFileSync(path.join(OUT, 'protocol.json')));
const cohortBytes = fs.readFileSync(path.join(OUT, 'cohort.json'));
const source = fs.readFileSync(path.join(OUT, 'recordings.ndjson'));
const testBytes = fs.readFileSync(path.join(OUT, 'test.json'));
const test = JSON.parse(testBytes);
const release = R.load('0.13.0');
const old = R.load(protocol.baseline);
const J = old.Journal;
assert.equal(sha(cohortBytes), protocol.cohortSha256);
assert.equal(sha(source), protocol.sourceSha256);
assert.equal(test.protocolSha256, sha(fs.readFileSync(path.join(OUT, 'protocol.json'))));
assert.equal(test.cohortSha256, sha(cohortBytes));
const data = R.readDataset([path.join(OUT, 'recordings.ndjson')]);
const roundMap = new Map(data.rounds.map((r) => [r.id, r]));
const errors = { probability: 0, inventory: 0, conditionalBonus: 0, quote: 0 };
const checks = { probability: 0, inventory: 0, conditionalBonus: 0, quote: 0 };
function check(kind, actual, expected, context, tolerance = 1e-8) {
  assert.equal(actual === null, expected === null, context);
  if (actual === null) return;
  assert(Number.isFinite(actual) && Number.isFinite(expected), context);
  const delta = Math.abs(actual - expected);
  errors[kind] = Math.max(errors[kind], delta);
  checks[kind]++;
  assert(delta <= tolerance, `${context}: ${actual} versus ${expected}`);
}
const rounds = [];
let checkpointCount = 0;
let quoteCount = 0;
for (const [roundIndex, frozen] of test.rounds.entries()) {
  const { metadata: m, events } = roundMap.get(frozen.id);
  const predictions = new Map(J.livePredictions(events).map((p) => [p.seq, p]));
  const values = new Map(frozen.valuePoints.map((p) => [p.seq, p]));
  const engine = new release.Belief.BeliefEngine({ samples: 512, skipPricing: true });
  const rows = [];
  for (const point of frozen.points) {
    const pred = predictions.get(point.seq);
    assert(pred, 'Missing frozen prediction');
    const prefix = events.filter((e) => e.seq < pred.seq);
    const replayed = J.replay(prefix);
    const last = prefix.at(-1);
    const exact =
      last?.kind === 'training_source' &&
      last.at === pred.at &&
      last.snapshot?.roundKey === replayed.roundKey &&
      last.snapshot?.trades?.length === pred.tradeCount;
    const snapshot = release.Training.blindSnapshot(exact ? last.snapshot : replayed);
    assert.equal(exact, point.exactSource);
    assert.equal(snapshot.status, 'live');
    assert.equal(snapshot.trades.length, pred.tradeCount);
    const prior = copy(prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {});
    const journal = release.Journal.restore(
      { id: m.id, base: m.base, snapshot: replayed, observedAt: pred.at, rates: pred.rates },
      prefix,
    );
    const start = performance.now();
    const model = engine.infer(snapshot, journal.evidence, prior);
    const elapsedMs = performance.now() - start;
    assert.equal(model.version, '0.13.0');
    assert.equal(model.behavior.goalCalibration.kind, 'likelihood-power');
    assert.equal(model.behavior.goalCalibration.strength, 16);
    assert.equal(model.behavior.goalCalibration.active, true);
    for (let s = 0; s < 4; s++) {
      check(
        'probability',
        model.bySuit[s].probability,
        point.models.lr16.probabilities[s],
        `${m.id}:${pred.seq}:P${s}`,
        1e-10,
      );
      check(
        'probability',
        model.scoringProbabilities[s],
        model.bySuit[s].probability,
        `${m.id}:${pred.seq}:scoring${s}`,
        1e-10,
      );
    }
    // These expected values were frozen before the deployed archive was built.
    const vp = values.get(pred.seq);
    for (const [field, name] of [
      ['expectedBase', 'base'],
      ['expectedBonus', 'bonus'],
      ['expectedPayout', 'total'],
    ])
      check('inventory', model[field], vp.predictions.lr16[name], `${m.id}:${pred.seq}:${name}`);
    const goal = IDS.indexOf(frozen.goal);
    check(
      'conditionalBonus',
      model.bySuit[goal].conditionalBonus,
      vp.predictions.lr16.conditionalBonus,
      `${m.id}:${pred.seq}:conditionalBonus`,
    );
    const executable = Quotes.executableQuotes(snapshot);
    assert.equal(executable.length, vp.quotes.length);
    const key = (q) => [q.suit, q.side, q.peer, q.price].join('|');
    const expectedQuotes = new Map(vp.quotes.map((q) => [key(q), q]));
    for (const quote of executable) {
      const frozenQuote = expectedQuotes.get(key(quote));
      assert(frozenQuote, 'Named executable quote changed');
      const expected = frozenQuote.predictions.lr16;
      const v = model.bySuit[IDS.indexOf(quote.suit)].counterparties[quote.peer];
      const total = v?.[quote.side];
      const base = v?.[quote.side + 'Base'];
      if (expected === null) {
        assert(!Number.isFinite(total) || !Number.isFinite(base));
        continue;
      }
      for (const [field, value] of Object.entries({
        total,
        base,
        bonus: total - base,
        edge: quote.side === 'buy' ? total - quote.price : quote.price - total,
      }))
        check('quote', value, expected[field], `${m.id}:${pred.seq}:${key(quote)}:${field}`);
      quoteCount++;
    }
    checkpointCount++;
    rows.push({
      seq: pred.seq,
      tradeCount: pred.tradeCount,
      exactSource: exact,
      elapsedMs,
      quotes: executable.length,
    });
  }
  rounds.push({ id: m.id, checkpoints: rows });
  process.stderr.write(`Release parity ${roundIndex + 1}/${test.rounds.length} ${m.id}\n`);
}
assert.equal(checkpointCount, 120, 'Frozen test checkpoint count changed');
const report = {
  createdAt: new Date().toISOString(),
  passed: true,
  scope:
    'Direct archived0.13 inference versus frozen lr16 fast-transform predictions on all120already-opened test checkpoints. Historicalprefix, exactsourcefallback, prior and512samplingbudget match the experiment. Outcome labels are used only after inference for field identification, never as forecast inputs.',
  release: {
    version: release.entry.version,
    bundleSha256: release.entry.bundleSha256,
    files: release.entry.files,
  },
  testSha256: sha(testBytes),
  protocolSha256: sha(fs.readFileSync(path.join(OUT, 'protocol.json'))),
  sourceSha256: sha(source),
  scriptSha256: sha(fs.readFileSync(__filename)),
  rounds: rounds.length,
  checkpoints: checkpointCount,
  namedQuotes: quoteCount,
  checks,
  maxAbsoluteErrors: errors,
  tolerance: { probability: 1e-10, chipValues: 1e-8 },
  details: rounds,
};
fs.writeFileSync(path.join(OUT, 'release-parity.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      ...report,
      details: undefined,
      release: { version: release.entry.version, bundleSha256: release.entry.bundleSha256 },
    },
    null,
    2,
  ),
);
