'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figgie-registry-test-'));
const runtime = path.join(temp, 'extension');
const copy = (x) => JSON.parse(JSON.stringify(x));
let tests = 0;
function test(name, run) {
  run();
  tests++;
  console.log('ok', name);
}
function write(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
fs.mkdirSync(runtime, { recursive: true });
fs.mkdirSync(path.join(temp, 'tools'));
fs.copyFileSync(
  path.join(__dirname, '../tools/model-registry.cjs'),
  path.join(temp, 'tools/model-registry.cjs'),
);
const R = require(path.join(temp, 'tools/model-registry.cjs'));
for (const name of ['journal.js', 'training.js', 'pnl.js', 'bonus-score.js'])
  fs.copyFileSync(path.join(root, 'models/0.10.0', name), path.join(runtime, name));
function engine(version, derived = false) {
  return `(function(scope){const fit=scope.FiggieModelFit||require('./model-fit.js');class BeliefEngine{infer(s,e,prior){if(s.training||s.roundResult)throw Error('truth reached model');if(prior.magic!==7)throw Error('wrong causal prior');const bySuit=fit.p.map((probability,i)=>({probability,holding:probability*(10*s.held[i]+30)${derived ? '' : ',conditionalPayout:10*s.held[i]+30,conditionalBonus:30'}}));return {bySuit,scoringProbabilities:[.1,.1,.1,.7],computeMs:0};}}scope.FiggieBelief={VERSION:'${version}',BeliefEngine,fit};module.exports=scope.FiggieBelief;})(globalThis);`;
}
write(
  path.join(runtime, 'model-fit.js'),
  `globalThis.FiggieModelFit={p:[.4,.3,.2,.1]};module.exports=globalThis.FiggieModelFit;`,
);
write(path.join(runtime, 'belief.js'), engine('1.0.0'));
R.snapshot('1.0.0');
write(path.join(runtime, 'belief.js'), engine('1.1.0', true));
R.snapshot('1.1.0');
function round(id = 'r') {
  const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
  const hand = [4, 4, 1, 1];
  const live = {
    status: 'live',
    self: 'You',
    cash: 350,
    roundKey: id,
    startingHand: hand,
    held: hand.slice(),
    net: names.map(() => [0, 0, 0, 0]),
    players: names.map((name) => ({ name, cards: 10, cash: 350 })),
    trades: [],
    context: { botDifficulty: 'Medium' },
    markets: ['s', 'c', 'd', 'h'].map((id) => ({
      id,
      bid: null,
      ask: null,
      buyer: null,
      seller: null,
      fills: [],
    })),
  };
  const ended = { ...copy(live), status: 'ended' };
  const revealed = {
    goal: 's',
    verified: true,
    source: 'official-round-rankings',
    profits: { You: 50, 'Bot-A': 50, 'Bot-B': -50, 'Bot-C': -50 },
    settledProfit: 50,
  };
  const events = [
    { kind: 'round_start', snapshot: live },
    { kind: 'learning_prior', learning: { magic: 7 } },
    { kind: 'prediction', tradeCount: 0 },
    { kind: 'checkpoint', snapshot: ended },
    { kind: 'reveal', ...revealed },
    { kind: 'learning_prior', learning: { magic: 999 } },
    { kind: 'prediction', tradeCount: 0, goalScenarios: [{ suit: 's', bonus: 60 }] },
  ];
  events.forEach((e, i) =>
    Object.assign(e, { id: id + ':' + (i + 1), roundId: id, seq: i + 1, at: 1000 + i }),
  );
  return [
    {
      kind: 'round_metadata',
      id,
      base: id,
      updatedAt: 10000,
      snapshot: ended,
      revealed,
      practice: false,
    },
    ...events,
  ];
}
function exportRows(name, rows) {
  const file = path.join(temp, name + '.ndjson');
  write(file, rows.map(JSON.stringify).join('\n') + '\n');
  return file;
}
try {
  test('archives isolate model dependencies from process globals and one another', () => {
    const old = global.FiggieModelFit;
    global.FiggieModelFit = { p: [1, 0, 0, 0] };
    try {
      const a = R.load('1.0.0');
      assert.deepEqual(copy(a.Belief.fit.p), [0.4, 0.3, 0.2, 0.1]);
      a.Belief.fit.p[0] = 0.99;
      assert.equal(R.load('1.0.0').Belief.fit.p[0], 0.4);
    } finally {
      if (old === undefined) delete global.FiggieModelFit;
      else global.FiggieModelFit = old;
    }
  });
  test('hash verification and immutable version names reject changed support files', () => {
    const file = path.join(temp, 'models/1.0.0/model-fit.js');
    const before = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// changed');
    assert.throws(() => R.load('1.0.0'), /Archived model changed/);
    fs.writeFileSync(file, before);
    assert.equal(R.verify('1.0.0').length, 1);
    assert.throws(() => R.snapshot('1.0.0'), /immutable/);
  });
  test('an unlisted local dependency cannot bypass the archive manifest', () => {
    write(path.join(runtime, 'belief.js'), engine('1.2.0') + `require('./rogue.js');`);
    R.snapshot('1.2.0');
    write(path.join(temp, 'models/1.2.0/rogue.js'), 'module.exports=1;');
    assert.throws(() => R.load('1.2.0'), /Unverified model dependency/);
  });
  const rows = round();
  const file = exportRows('valid', rows);
  const duplicate = exportRows('duplicate', rows);
  test('deduplication is stable and conflicting events are rejected', () => {
    assert.equal(R.rowsFrom([file, duplicate])[0].events.length, rows.length - 1);
    assert.equal(
      R.readDataset([file]).datasetSha256,
      R.readDataset([duplicate, file]).datasetSha256,
    );
    const bad = copy(rows);
    bad[3].tradeCount = 1;
    assert.throws(
      () => R.rowsFrom([file, exportRows('conflict', bad)]),
      /Conflicting recorded event/,
    );
  });
  test('goal and real conditional bonus scores use only causal live predictions', () => {
    const result = R.compare(['1.0.0', '1.1.0'], [file]);
    assert.equal(result.coverage.sharedCheckpoints, 1);
    assert.equal(result.sources[0].sha256.length, 64);
    assert.equal(result.split.appliedSha256.length, 64);
    assert.equal(result.models[0].bundleSha256.length, 64);
    for (const score of result.summary) {
      assert.equal(score.checkpoints, 1);
      assert(Math.abs(score.brier - 0.5) < 1e-12);
      assert.equal(score.finalCorrect, 1);
      assert.equal(score.bonus.checkpoints, 1);
      assert.equal(score.bonus.mae, 30);
      assert.equal(score.bonus.bias, -30);
      assert.equal(score.bonus.categoryBrier, null);
    }
    assert.match(result.rounds[0].results[1].points[0].bonusForecastSource, /expected holding/);
    assert.equal(result.ev.scored, false);
    assert.equal(result.ev.checkpoints, 0);
  });
  test('practice history excludes a round even after visible hands and metadata flags disappear', () => {
    const practice = round('practice');
    practice.splice(2, 0, { kind: 'practice_mode', practice: true });
    practice.slice(1).forEach((e, i) =>
      Object.assign(e, {
        roundId: 'practice',
        id: 'practice:' + (i + 1),
        seq: i + 1,
        at: 1000 + i,
      }),
    );
    const result = R.compare(['1.0.0', '1.1.0'], [exportRows('practice', practice)]);
    assert.equal(result.coverage.includedRounds, 0);
    assert.equal(result.excluded[0].reason, 'practice');
  });
  test('bonus truth exclusions remain explicit instead of becoming invented scores', () => {
    const invalid = round('invalidBonus');
    delete invalid[0].revealed.profits['Bot-C'];
    const result = R.compare(['1.0.0', '1.1.0'], [exportRows('invalid-bonus', invalid)]);
    assert.equal(result.summary[0].rounds, 1);
    assert.equal(result.summary[0].bonus.rounds, 0);
    assert.equal(result.summary[0].bonus.mae, null);
    assert.match(result.summary[0].bonus.excludedRounds[0].reason, /Complete zero-sum/);
  });
  test('split identities, missing rounds, source digest and actual applied cohort are recorded', () => {
    const splitFile = path.join(temp, 'split.json');
    write(splitFile, { partitions: { test: ['r', 'missing'] }, datasetSha256: 'declared' });
    const result = R.compare(['1.0.0', '1.1.0'], [file], { splitFile, partition: 'test' });
    assert.equal(result.split.sourceSha256.length, 64);
    assert.deepEqual(result.split.missingRoundIds, ['missing']);
    assert.deepEqual(result.split.appliedRoundIds, ['r']);
    assert.equal(result.split.declaredDatasetSha256, 'declared');
    assert.throws(
      () => R.compare(['1.0.0'], [file], { splitFile, partition: 'bad' }),
      /Invalid or missing/,
    );
  });
  test('gapped source history is excluded from both models', () => {
    const missing = round('missingEvent');
    missing.splice(2, 1);
    const result = R.compare(['1.0.0', '1.1.0'], [exportRows('missing-event', missing)]);
    assert.equal(result.coverage.includedRounds, 0);
    assert.equal(result.excluded[0].reason, 'incomplete event sequence');
  });
  console.log(tests + ' model-registry tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
