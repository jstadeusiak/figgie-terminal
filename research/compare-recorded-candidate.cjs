#!/usr/bin/env node
'use strict';
/* Fixed historical regression corpus. These rounds are already seen, not a new holdout. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Registry = require('../tools/model-registry.cjs');
const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'extension');
const REVIEW = path.join(ROOT, 'outputs/opponent-learning-review-2026-10-28');
const OUT = path.join(ROOT, 'outputs/simulation-audit-2026-10-28');
const IDS = ['s', 'c', 'd', 'h'];
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const copy = (v) => JSON.parse(JSON.stringify(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function loadCurrent(folder = RUNTIME) {
  const context = vm.createContext({
    console,
    performance,
    Date,
    setTimeout,
    clearTimeout,
    crypto: crypto.webcrypto,
  });
  const cache = new Map();
  const hashes = {};
  function requireLocal(name, from = folder) {
    if (!name.startsWith('./') && !name.startsWith('../'))
      throw Error('Unexpected dependency ' + name);
    const file = path.resolve(from, name);
    if (!file.startsWith(folder + path.sep)) throw Error('Dependency escapes candidate');
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    hashes[path.relative(folder, file)] = sha(source);
    const module = { exports: {} };
    cache.set(file, module);
    const run = new vm.Script('(function(exports,require,module){\n' + source + '\n})', {
      filename: file,
    }).runInContext(context);
    run(module.exports, (dep) => requireLocal(dep, path.dirname(file)), module);
    return module.exports;
  }
  const Belief = requireLocal('./belief.js');
  const Journal = requireLocal('./journal.js');
  const Training = requireLocal('./training.js');
  const Pnl = requireLocal('./pnl.js');
  const Bonus = requireLocal('./bonus-score.js');
  return { Belief, Journal, Training, Pnl, Bonus, hashes, folder };
}
function metric(p, g) {
  if (
    p.length !== 4 ||
    p.some((v) => !Number.isFinite(v) || v < -1e-9) ||
    Math.abs(p.reduce((a, b) => a + b, 0) - 1) > 1e-6
  )
    throw Error('Invalid probability vector');
  return {
    brier: p.reduce((a, v, i) => a + (v - Number(i === g)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-12, p[g])),
    actualGoalP: p[g],
    top: p.indexOf(Math.max(...p)),
  };
}
function scoreRound(release, truthScorer, m, events, options = {}) {
  const engine = new release.Belief.BeliefEngine({ skipPricing: true, ...options });
  const predictions = truthScorer.Journal.livePredictions(events);
  const points = [];
  const replacements = new Map();
  const g = IDS.indexOf(m.revealed.goal);
  for (const prediction of predictions) {
    const prefix = events.filter((e) => e.seq < prediction.seq);
    const snapshot = release.Training.blindSnapshot(truthScorer.Journal.replay(prefix));
    if (snapshot.status !== 'live' || snapshot.trades.length !== prediction.tradeCount)
      throw Error('Inconsistent live checkpoint ' + m.id + ':' + prediction.seq);
    const prior = copy(prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {});
    const journal = release.Journal.restore(
      { id: m.id, base: m.base, snapshot, observedAt: prediction.at, rates: prediction.rates },
      prefix,
    );
    const start = performance.now();
    const model = engine.infer(snapshot, journal.evidence, prior);
    const elapsedMs = performance.now() - start;
    const p = Array.from(model.bySuit, (s) => s.probability);
    const scenarios = release.Pnl.summary(snapshot, model).goalScenarios;
    points.push({
      seq: prediction.seq,
      tradeCount: prediction.tradeCount,
      probabilities: p,
      goalScenarios: copy(scenarios),
      ...metric(p, g),
      elapsedMs,
    });
    replacements.set(prediction.seq, scenarios);
  }
  const bonus = truthScorer.Bonus.auditRound({
    ...m,
    events: events.map((e) =>
      e.kind === 'prediction' ? { ...e, goalScenarios: replacements.get(e.seq) || null } : e,
    ),
  });
  return {
    id: m.id,
    goal: m.revealed.goal,
    difficulty: m.snapshot.context?.botDifficulty || 'unknown',
    points,
    bonus,
    brier: mean(points.map((p) => p.brier)),
    logLoss: mean(points.map((p) => p.logLoss)),
    finalCorrect: points.at(-1)?.top === g,
  };
}
function aggregate(rounds) {
  const bonus = rounds.map((r) => r.bonus.score).filter(Boolean);
  const times = rounds.flatMap((r) => r.points.map((p) => p.elapsedMs)).sort((a, b) => a - b);
  return {
    rounds: rounds.length,
    checkpoints: rounds.reduce((n, r) => n + r.points.length, 0),
    brier: mean(rounds.map((r) => r.brier)),
    logLoss: mean(rounds.map((r) => r.logLoss)),
    finalCorrect: rounds.filter((r) => r.finalCorrect).length,
    bonus: {
      rounds: bonus.length,
      checkpoints: bonus.reduce((n, b) => n + b.checkpoints, 0),
      mae: mean(bonus.map((b) => b.bonusMae)),
      bias: mean(bonus.map((b) => b.bonusBias)),
      mse: mean(bonus.map((b) => b.bonusMse).filter(Number.isFinite)),
      rmse: bonus.some((b) => Number.isFinite(b.bonusMse))
        ? Math.sqrt(mean(bonus.map((b) => b.bonusMse).filter(Number.isFinite)))
        : null,
      categoryBrier: mean(bonus.map((b) => b.categoryBrier).filter(Number.isFinite)),
      leaderBrier: mean(bonus.map((b) => b.leaderBrier).filter(Number.isFinite)),
    },
    computeMs: {
      median: times[Math.floor(times.length * 0.5)] ?? null,
      p95: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] ?? null,
      max: times.at(-1) ?? null,
    },
  };
}
function run(options = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const baseline = Registry.load('0.11.0');
  const scorer = loadCurrent();
  const truthScorer = { ...baseline, Bonus: scorer.Bonus };
  const manifestBytes = fs.readFileSync(path.join(REVIEW, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const data = fs.readFileSync(path.join(REVIEW, 'recordings-combined.ndjson'));
  if (sha(data) !== manifest.datasetSha256) throw Error('Historical corpus hash changed');
  let ids = Object.values(manifest.partitions).flat();
  if (options.limit) ids = ids.slice(0, options.limit);
  const wanted = new Set(ids);
  const rounds = new Map();
  for (const line of data.toString('utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    const id = row.kind === 'round_metadata' ? row.id : row.roundId;
    if (!wanted.has(id)) continue;
    if (!rounds.has(id)) rounds.set(id, { events: [] });
    if (row.kind === 'round_metadata') rounds.get(id).metadata = row;
    else rounds.get(id).events.push(row);
  }
  const cacheFile = path.join(OUT, 'recorded-v011-baseline.json');
  const key = {
    datasetSha256: manifest.datasetSha256,
    bundleSha256: baseline.entry.bundleSha256,
    options: { skipPricing: true },
  };
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile)) : null;
  let baselineRows =
    cache &&
    cache.schema === 2 &&
    JSON.stringify(cache.key) === JSON.stringify(key) &&
    cache.rounds.every((r) => r.points.every((p) => Array.isArray(p.goalScenarios)))
      ? cache.rounds
      : [];
  let candidate = options.baselineOnly
    ? null
    : options.candidateVersion
      ? Registry.load(options.candidateVersion)
      : loadCurrent(options.candidateFolder || RUNTIME);
  let candidateRows = [];
  for (const [i, id] of ids.entries()) {
    const { metadata: m, events } = rounds.get(id) || {};
    if (
      !m ||
      baseline.Journal.isPractice(m, events) ||
      m.revealed?.verified !== true ||
      m.revealed.source !== 'official-round-rankings' ||
      m.snapshot.status !== 'ended' ||
      events.some((e, i) => e.seq !== i + 1)
    )
      throw Error('Locked corpus entry no longer eligible ' + id);
    if (!baselineRows.some((r) => r.id === id))
      baselineRows.push(scoreRound(baseline, truthScorer, m, events));
    if (candidate)
      candidateRows.push(
        scoreRound(candidate, truthScorer, m, events, options.candidateOptions || {}),
      );
    process.stderr.write(`Recorded regression ${i + 1}/${ids.length} ${id}\n`);
  }
  for (const r of baselineRows) {
    const source = rounds.get(r.id);
    if (!source) continue;
    const map = new Map(r.points.map((p) => [p.seq, p.goalScenarios]));
    r.bonus = scorer.Bonus.auditRound({
      ...source.metadata,
      events: source.events.map((e) =>
        e.kind === 'prediction' ? { ...e, goalScenarios: map.get(e.seq) || null } : e,
      ),
    });
  }
  fs.writeFileSync(
    cacheFile,
    JSON.stringify(
      {
        schema: 2,
        key,
        scorerSha256: scorer.hashes['bonus-score.js'],
        createdAt: new Date().toISOString(),
        rounds: baselineRows,
      },
      null,
      2,
    ) + '\n',
  );
  baselineRows = ids.map((id) => baselineRows.find((r) => r.id === id));
  if (options.baselineOnly)
    return { baselineCache: cacheFile, key, summary: aggregate(baselineRows) };
  const source = candidate.entry
    ? {
        kind: 'archive',
        version: candidate.entry.version,
        bundleSha256: candidate.entry.bundleSha256,
        files: candidate.entry.files,
      }
    : { kind: 'current', version: candidate.Belief.VERSION, files: candidate.hashes };
  const splitSummaries = Object.fromEntries(
    Object.entries(manifest.partitions).map(([name, set]) => [
      name,
      {
        baseline: aggregate(baselineRows.filter((r) => set.includes(r.id))),
        candidate: aggregate(candidateRows.filter((r) => set.includes(r.id))),
      },
    ]),
  );
  const result = {
    schema: 1,
    createdAt: new Date().toISOString(),
    scope:
      'Already-seen historical regression corpus. Original split names retained for traceability only; none is a new holdout. No strategy profit or counterfactual EV claim.',
    datasetSha256: manifest.datasetSha256,
    manifestSha256: sha(manifestBytes),
    baseline: { version: '0.11.0', bundleSha256: baseline.entry.bundleSha256 },
    candidate: source,
    candidateOptions: options.candidateOptions || {},
    scorer: {
      sha256: scorer.hashes['bonus-score.js'],
      scope:
        'Common scorer for both models; original label rules, extended squared-error statistics. Cached forecasts are rescored on every run.',
    },
    timingScope: 'Replay execution times, not controlled or end-to-end UI latency benchmarks.',
    summary: { baseline: aggregate(baselineRows), candidate: aggregate(candidateRows) },
    originalPartitions: splitSummaries,
    rounds: ids.map((id, i) => ({
      id,
      baseline: baselineRows[i],
      candidate: candidateRows[i],
      brierChange: candidateRows[i].brier - baselineRows[i].brier,
      logLossChange: candidateRows[i].logLoss - baselineRows[i].logLoss,
    })),
  };
  const file = options.out || path.join(OUT, 'recorded-current-regression.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return { ...result, output: file, rounds: undefined };
}
module.exports = { run, loadCurrent, scoreRound, aggregate };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--baseline-only') options.baselineOnly = true;
      else if (key === '--candidate-version') options.candidateVersion = args[++i];
      else if (key === '--candidate-folder') options.candidateFolder = path.resolve(args[++i]);
      else if (key === '--candidate-options')
        options.candidateOptions = JSON.parse(fs.readFileSync(args[++i]));
      else if (key === '--out') options.out = path.resolve(args[++i]);
      else if (key === '--limit') options.limit = Number(args[++i]);
      else throw Error('Unknown argument ' + key);
    }
    console.log(JSON.stringify(run(options), null, 2));
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
