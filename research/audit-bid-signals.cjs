#!/usr/bin/env node
'use strict';
// Frozen retrospective cohort and causal baseline cache for a small residual test.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Registry = require('../tools/model-registry.cjs');
const Loader = require('../tools/simulation/fast-load.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/bid-signal-review-2026-10-29');
const OLD = path.join(ROOT, 'outputs/opponent-learning-review-2026-10-28');
const IDS = ['s', 'c', 'd', 'h'];
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const copy = (v) => JSON.parse(JSON.stringify(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function write(file, value) {
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(value, null, 2) + '\n');
}
function read(file) {
  return JSON.parse(fs.readFileSync(path.join(OUT, file)));
}
function eligibility(round, Journal) {
  const m = round.metadata;
  const es = round.events;
  if (Journal.isPractice(m, es)) return 'practice/exposed hands';
  if (
    !m.revealed?.verified ||
    m.revealed.source !== 'official-round-rankings' ||
    !IDS.includes(m.revealed.goal)
  )
    return 'no verified official goal';
  if (m.snapshot?.status !== 'ended') return 'not completed';
  if (!es.length || es.some((e, i) => e.seq !== i + 1) || m.seq !== es.at(-1).seq)
    return 'incomplete immutable event sequence';
  if (!Journal.livePredictions(es).length) return 'no live pre-reveal checkpoints';
  return null;
}
function verifyMetadata(files) {
  const by = new Map();
  let duplicateEvents = 0;
  const eventIds = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.roundId) {
        const k = r.roundId + ':' + r.seq;
        if (eventIds.has(k)) duplicateEvents++;
        eventIds.add(k);
      }
      if (r.kind !== 'round_metadata') continue;
      if (!by.has(r.id)) by.set(r.id, []);
      const rows = by.get(r.id);
      for (const old of rows) {
        if (old.revealed?.verified && r.revealed?.verified && old.revealed.goal !== r.revealed.goal)
          throw Error('Conflicting verified goal: ' + r.id);
        if (old.updatedAt === r.updatedAt && old.metadataSha256 !== sha(stable(r)))
          throw Error('Conflicting same-time metadata: ' + r.id);
      }
      rows.push({
        source: file,
        updatedAt: r.updatedAt,
        seq: r.seq,
        metadataSha256: sha(stable(r)),
        revealed: r.revealed || null,
        practice: r.practice === true,
        version: r.version,
      });
    }
  }
  return { duplicateEvents, rounds: Object.fromEntries(by) };
}
function prepare(files) {
  if (!files?.length)
    throw Error(
      'Usage: node research/audit-bid-signals.cjs prepare RECORDING.ndjson [RECORDING.ndjson ...]',
    );
  fs.mkdirSync(OUT, { recursive: true });
  const data = Registry.readDataset(files);
  const release = Loader.load('0.12.0');
  if (fs.existsSync(path.join(OUT, 'manifest.json'))) {
    const existing = read('manifest.json');
    if (existing.datasetSha256 !== data.datasetSha256)
      throw Error('Frozen cohort changed; use a new review folder');
    return {
      reused: true,
      counts: existing.counts,
      manifestSha256: sha(fs.readFileSync(path.join(OUT, 'manifest.json'))),
    };
  }
  const provenance = verifyMetadata(files);
  const priorBytes = fs.readFileSync(path.join(OLD, 'manifest.json'));
  const prior = JSON.parse(priorBytes);
  const diagnostics = new Set(prior.partitions.diagnostic);
  const selected = [];
  const excluded = [];
  for (const r of data.rounds) {
    const m = r.metadata;
    const reason = eligibility(r, release.Journal);
    const predictions = release.Journal.livePredictions(r.events);
    const at = r.events.find((e) => e.kind === 'round_start')?.at ?? r.events[0]?.at;
    const descriptor = {
      id: r.id,
      at,
      version: m.version,
      difficulty: m.snapshot?.context?.botDifficulty || 'unknown',
      players: m.snapshot?.players?.length,
      events: r.events.length,
      checkpoints: predictions.map((p) => p.seq),
      oldPartitions: Object.keys(prior.partitions).filter((k) =>
        prior.partitions[k].includes(r.id),
      ),
      sources: [...new Set(provenance.rounds[r.id].map((x) => x.source))],
    };
    if (reason) excluded.push({ ...descriptor, reason });
    else selected.push(descriptor);
  }
  selected.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const ordinary = selected.filter((r) => !diagnostics.has(r.id));
  const ntrain = Math.floor(ordinary.length * 0.6);
  const nvalidation = Math.floor(ordinary.length * 0.2);
  const partitions = {
    train: ordinary.slice(0, ntrain).map((r) => r.id),
    validation: ordinary.slice(ntrain, ntrain + nvalidation).map((r) => r.id),
    test: ordinary.slice(ntrain + nvalidation).map((r) => r.id),
    diagnostic: selected.filter((r) => diagnostics.has(r.id)).map((r) => r.id),
  };
  const labelProvenance = {
    schema: 1,
    previousManifestSha256: sha(priorBytes),
    oldDiagnosticIds: [...diagnostics],
    sourceMetadata: provenance.rounds,
    note: 'Retained outcomes and original partition history for scorer/provenance only. Neither this file nor ending metadata is passed to feature extraction or model inference.',
  };
  write('label-provenance.json', labelProvenance);
  const manifest = {
    schema: 1,
    frozenAt: new Date().toISOString(),
    scope:
      'Retrospective, previously seen recorded rounds. Chronological split is frozen before candidate features or scores. It is not a new prospective holdout.',
    method:
      'Verified canonical merge by round ID and immutable event sequence; conflicting duplicate event bytes or verified labels fail. Latest consistent metadata wins. Raw sources are retained in place and hashed, avoiding another large duplicate export.',
    datasetSha256: data.datasetSha256,
    sources: data.sources,
    merge: {
      duplicateEvents: provenance.duplicateEvents,
      eventConflicts: 0,
      verifiedLabelConflicts: 0,
      missingMetadata: data.missingMetadata,
    },
    previousManifest: {
      path: path.join(OLD, 'manifest.json'),
      sha256: sha(priorBytes),
      partitions: prior.partitions,
    },
    labelProvenanceSha256: sha(fs.readFileSync(path.join(OUT, 'label-provenance.json'))),
    baseline: {
      version: release.entry.version,
      bundleSha256: release.entry.bundleSha256,
      options: { samples: 512, skipPricing: true },
    },
    scoring: {
      primary:
        'Equal-round mean multiclass Brier; average all saved consistent live checkpoints within each round first.',
      secondary:
        'Equal-round mean log loss, final checkpoint scores and descriptive paired round changes. Suit/round checkpoints are not independent samples.',
      checkpointRule:
        'Use source events with seq strictly less than the saved prediction; exclude practice and revealed/nonlive states. Learned priors are the latest learning_prior within that prefix. Goal labels are scorer-only.',
      privacy:
        'blindSnapshot allowlist strips other hands/results. Features must read only public event fields from the same prefix. No whole-round aggregates or future resets/fills may be used.',
    },
    counts: {
      inputRounds: data.rounds.length,
      completeOfficialNonpractice: selected.length,
      excluded: excluded.length,
      eligibleCheckpoints: selected.reduce((n, r) => n + r.checkpoints.length, 0),
      partitions: Object.fromEntries(Object.entries(partitions).map(([k, ids]) => [k, ids.length])),
    },
    partitions,
    selected,
    excluded,
  };
  write('manifest.json', manifest);
  return {
    counts: manifest.counts,
    duplicateEvents: provenance.duplicateEvents,
    manifestSha256: sha(fs.readFileSync(path.join(OUT, 'manifest.json'))),
    datasetSha256: data.datasetSha256,
  };
}
function dataset() {
  const bytes = fs.readFileSync(path.join(OUT, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  const data = Registry.readDataset(manifest.sources.map((s) => s.path));
  if (
    data.datasetSha256 !== manifest.datasetSha256 ||
    stable(data.sources) !== stable(manifest.sources)
  )
    throw Error('Frozen input data changed');
  return { manifest, manifestSha256: sha(bytes), by: new Map(data.rounds.map((r) => [r.id, r])) };
}
function checkPartition(partition, manifestSha256) {
  if (!['train', 'validation', 'test', 'diagnostic'].includes(partition))
    throw Error('Unknown partition');
  if (partition === 'test' || partition === 'diagnostic') {
    const file = path.join(OUT, 'candidate-lock.json');
    if (!fs.existsSync(file))
      throw Error('Test/diagnostic remain closed until a candidate is selected and locked');
    const lock = JSON.parse(fs.readFileSync(file));
    if (lock.locked !== true || lock.manifestSha256 !== manifestSha256)
      throw Error('Invalid candidate lock');
  }
}
function metric(probabilities, goal) {
  if (
    !Array.isArray(probabilities) ||
    probabilities.length !== 4 ||
    probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1) ||
    Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-8
  )
    throw Error('Invalid goal probabilities');
  const g = IDS.indexOf(goal);
  if (g < 0) throw Error('Invalid goal label');
  return {
    brier: probabilities.reduce((n, p, i) => n + (p - Number(i === g)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-12, probabilities[g])),
  };
}
function canonicalProbabilities(raw) {
  // Preserve the archived prediction, correcting only ordinary floating point
  // roundoff (for example a mathematically certain suit at 1+6e-15).
  if (
    !Array.isArray(raw) ||
    raw.length !== 4 ||
    raw.some((p) => !Number.isFinite(p) || p < -1e-12 || p > 1 + 1e-12) ||
    Math.abs(raw.reduce((a, b) => a + b, 0) - 1) > 1e-8
  )
    throw Error('Invalid raw goal probabilities');
  const p = raw.map((v) => Math.max(0, Math.min(1, v)));
  const total = p.reduce((a, b) => a + b, 0);
  return p.map((v) => v / total);
}
function summarize(rounds) {
  return {
    rounds: rounds.length,
    checkpoints: rounds.reduce((n, r) => n + r.points.length, 0),
    brier: mean(
      rounds.map((r) => mean(r.points.map((p) => metric(p.probabilities, r.goal).brier))),
    ),
    logLoss: mean(
      rounds.map((r) => mean(r.points.map((p) => metric(p.probabilities, r.goal).logLoss))),
    ),
  };
}
function cacheBaseline(partition) {
  const { manifest, manifestSha256, by } = dataset();
  checkPartition(partition, manifestSha256);
  const release = Loader.load(manifest.baseline.version);
  if (release.entry.bundleSha256 !== manifest.baseline.bundleSha256)
    throw Error('Baseline archive changed');
  const file = 'baseline-' + partition + '.json';
  if (fs.existsSync(path.join(OUT, file))) {
    const old = read(file);
    if (old.manifestSha256 !== manifestSha256 || stable(old.baseline) !== stable(manifest.baseline))
      throw Error('Stale baseline cache');
    if (
      old.scriptSha256 === sha(fs.readFileSync(__filename)) &&
      old.loaderSha256 ===
        sha(fs.readFileSync(path.join(__dirname, '../tools/simulation/fast-load.cjs')))
    )
      return { reused: true, partition, summary: old.summary };
    // Preserve the prior cache for provenance, then recompute after any runner or
    // loader change instead of silently attributing old results to new code.
    const archived = file.replace(
      '.json',
      '.superseded-' + old.scriptSha256.slice(0, 12) + '.json',
    );
    if (!fs.existsSync(path.join(OUT, archived)))
      fs.copyFileSync(path.join(OUT, file), path.join(OUT, archived));
  }
  const rounds = [];
  const checkpointExclusions = [];
  for (const id of manifest.partitions[partition]) {
    const { metadata: m, events } = by.get(id);
    const engine = new release.Belief.BeliefEngine(manifest.baseline.options);
    const points = [];
    for (const e of release.Journal.livePredictions(events)) {
      const prefix = events.filter((x) => x.seq < e.seq);
      const raw = release.Journal.replay(prefix);
      if (!raw || raw.status !== 'live' || raw.trades.length !== e.tradeCount) {
        checkpointExclusions.push({
          id,
          seq: e.seq,
          reason: 'Inconsistent live source/history checkpoint',
        });
        continue;
      }
      const snapshot = release.Training.blindSnapshot(raw);
      const prior = copy(prefix.findLast((x) => x.kind === 'learning_prior')?.learning || {});
      const journal = release.Journal.restore(
        { id: m.id, base: m.base, snapshot, observedAt: e.at, rates: e.rates },
        prefix,
      );
      const model = engine.infer(snapshot, journal.evidence, prior);
      const rawProbabilities = Array.from(model.bySuit, (s) => s.probability);
      const probabilities = canonicalProbabilities(rawProbabilities);
      try {
        metric(probabilities, m.revealed.goal);
      } catch (error) {
        throw Error(
          error.message + ' at ' + id + ':' + e.seq + ' vector=' + JSON.stringify(probabilities),
        );
      }
      points.push({
        seq: e.seq,
        at: e.at,
        tradeCount: e.tradeCount,
        probabilities,
        snapshotSha256: sha(stable(snapshot)),
        prefixLastSeq: prefix.at(-1)?.seq,
        computeMs: model.computeMs,
      });
    }
    if (!points.length) throw Error('No usable checkpoint in frozen eligible round ' + id);
    rounds.push({
      id,
      goal: m.revealed.goal,
      difficulty: m.snapshot?.context?.botDifficulty || 'unknown',
      points,
    });
    process.stderr.write(
      `Baseline ${partition} ${rounds.length}/${manifest.partitions[partition].length}\n`,
    );
  }
  const result = {
    schema: 1,
    createdAt: new Date().toISOString(),
    partition,
    manifestSha256,
    datasetSha256: manifest.datasetSha256,
    baseline: manifest.baseline,
    probabilityNormalization:
      'Only machine-roundoff correction: reject values outside [-1e-12,1+1e-12] or sum error above1e-8, clamp to[0,1], normalize. Shared baseline/candidate scorer preserves structural zeros.',
    scriptSha256: sha(fs.readFileSync(__filename)),
    loaderSha256: sha(fs.readFileSync(path.join(__dirname, '../tools/simulation/fast-load.cjs'))),
    checkpointExclusions,
    summary: summarize(rounds),
    rounds,
  };
  write(file, result);
  return {
    partition,
    file: path.join(OUT, file),
    summary: result.summary,
    excludedCheckpoints: checkpointExclusions.length,
  };
}
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const partition = args[0];
    const result =
      command === 'prepare'
        ? prepare(args)
        : command === 'baseline'
          ? cacheBaseline(partition)
          : (() => {
              throw Error(
                'Usage: audit-bid-signals.cjs prepare | baseline train|validation|test|diagnostic',
              );
            })();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
module.exports = {
  prepare,
  dataset,
  cacheBaseline,
  checkPartition,
  eligibility,
  verifyMetadata,
  metric,
  canonicalProbabilities,
  summarize,
  sha,
  stable,
  OUT,
};
