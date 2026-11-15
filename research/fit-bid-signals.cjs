#!/usr/bin/env node
'use strict';
// Small, predeclared residual test. This file never edits the production model.
const fs = require('node:fs');
const path = require('node:path');
const A = require('./audit-bid-signals.cjs');
const { OUT, sha, stable, metric } = A;
const FEATURE_FILE = path.join(__dirname, 'candidates/bid-signals.js');
const PROTOCOL_SHA = 'e6169e04f8400ad604a06a1cfe3f507ce86fc8e025ff1617312041fef795377a';
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const read = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f)));
const write = (f, v) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(v, null, 2) + '\n');
function protocol() {
  const b = fs.readFileSync(path.join(OUT, 'protocol.json'));
  if (sha(b) !== PROTOCOL_SHA) throw Error('Frozen fit protocol changed');
  return JSON.parse(b);
}
function centered(values) {
  if (
    !Array.isArray(values) ||
    values.length !== 4 ||
    values.some(
      (x) =>
        !Array.isArray(x) || x.length !== 2 || x.some((v) => !Number.isFinite(v) || v < 0 || v > 1),
    )
  )
    throw Error('Invalid bounded bid features');
  const means = [0, 1].map((k) => mean(values.map((x) => x[k])));
  return values.map((x) => x.map((v, k) => v - means[k]));
}
function tilt(p, values, beta, strength = 1) {
  if (strength === 0 || beta.every((b) => b === 0)) return p.slice();
  const x = centered(values);
  const w = p.map(
    (v, i) =>
      v *
      Math.exp(Math.max(-0.35, Math.min(0.35, strength * (beta[0] * x[i][0] + beta[1] * x[i][1])))),
  );
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / total);
}
function inScope(round) {
  return round.players === 4 && round.difficulty === 'Medium';
}
function extract(partition) {
  const p = protocol();
  const { manifest, manifestSha256, by } = A.dataset();
  A.checkPartition(partition, manifestSha256);
  const featureSourceSha256 = sha(fs.readFileSync(FEATURE_FILE));
  const contract = read('feature-contract.json');
  if (contract.sourceSha256 !== featureSourceSha256 || contract.version !== p.features.version)
    throw Error('Feature source not frozen/changed');
  const { Tracker } = require(FEATURE_FILE);
  const Journal = require('../tools/simulation/fast-load.cjs').load('0.12.0').Journal;
  const baselineFile = 'baseline-' + partition + '.json';
  const baselineBytes = fs.readFileSync(path.join(OUT, baselineFile));
  const baseline = JSON.parse(baselineBytes);
  if (
    baseline.manifestSha256 !== manifestSha256 ||
    stable(baseline.baseline) !== stable(manifest.baseline)
  )
    throw Error('Baseline mismatch');
  const rows = [];
  for (const r of baseline.rounds) {
    const source = by.get(r.id);
    const tracker = new Tracker({ self: source.metadata.self });
    let cursor = 0;
    const points = r.points.map((point) => {
      while (cursor < source.events.length && source.events[cursor].seq < point.seq)
        tracker.push(source.events[cursor++]);
      if (source.events[cursor - 1]?.seq !== point.prefixLastSeq)
        throw Error('Feature prefix differs from cached baseline');
      assertPrefixScope(source, point, Journal);
      const f = tracker.features();
      if (f.version !== p.features.version || stable(f.suits) !== stable(['s', 'c', 'd', 'h']))
        throw Error('Feature schema mismatch');
      centered(f.values);
      return { ...point, values: f.values, diagnostics: f.diagnostics };
    });
    rows.push({ ...r, players: source.metadata.snapshot.players.length, points });
  }
  const result = {
    schema: 1,
    partition,
    manifestSha256,
    protocolSha256: PROTOCOL_SHA,
    featureSourceSha256,
    featureContractSha256: sha(fs.readFileSync(path.join(OUT, 'feature-contract.json'))),
    baselineSha256: sha(baselineBytes),
    runnerSha256: sha(fs.readFileSync(__filename)),
    rounds: rows,
  };
  write('features-' + partition + '.json', result);
  return {
    partition,
    rounds: rows.length,
    checkpoints: rows.reduce((n, r) => n + r.points.length, 0),
    featureSourceSha256,
  };
}
function assertPrefixScope(source, point, Journal) {
  const raw = Journal.replay(source.events.filter((e) => e.seq < point.seq));
  const actual = {
    players: raw?.players?.length,
    difficulty: raw?.context?.botDifficulty || 'unknown',
  };
  const declared = {
    players: source.metadata.snapshot?.players?.length,
    difficulty: source.metadata.snapshot?.context?.botDifficulty || 'unknown',
  };
  if (stable(actual) !== stable(declared))
    throw Error(
      'Forecast-time scope differs from cohort metadata at ' + source.id + ':' + point.seq,
    );
  return actual;
}
function objective(rounds, beta) {
  const scoped = rounds.filter(inScope);
  if (!scoped.length) throw Error('No training rounds in declared scope');
  let loss = 0;
  let gradient = [0, 0];
  for (const r of scoped) {
    const weight = 1 / scoped.length / r.points.length;
    const goal = ['s', 'c', 'd', 'h'].indexOf(r.goal);
    for (const point of r.points) {
      const x = centered(point.values);
      const q = tilt(point.probabilities, point.values, beta);
      const raw = x.map((a) => a[0] * beta[0] + a[1] * beta[1]);
      loss += weight * metric(q, r.goal).logLoss;
      if (q[goal] <= 1e-12) continue; // The common scorer's clipped loss is constant here.
      for (let k = 0; k < 2; k++) {
        const derivative = x.map((a, i) => (Math.abs(raw[i]) < 0.35 ? a[k] : 0));
        gradient[k] +=
          weight * (q.reduce((n, v, i) => n + v * derivative[i], 0) - derivative[goal]);
      }
    }
  }
  loss += 0.5 * 0.05 * (beta[0] ** 2 + beta[1] ** 2);
  gradient = gradient.map((v, k) => v + 0.05 * beta[k]);
  return { loss, gradient, trainingRounds: scoped.length };
}
function fit(rounds) {
  let beta = [0, 0];
  let current = objective(rounds, beta);
  let iterations = 0;
  let reason = 'iteration limit';
  for (; iterations < 2000; iterations++) {
    const projected = beta.map((b, k) => Math.max(0, Math.min(0.5, b - current.gradient[k])));
    if (Math.max(...projected.map((b, k) => Math.abs(b - beta[k]))) < 1e-10) {
      reason = 'projected gradient tolerance';
      break;
    }
    let accepted = null;
    for (let step = 8; step >= 1e-10; step *= 0.5) {
      const trial = beta.map((b, k) => Math.max(0, Math.min(0.5, b - step * current.gradient[k])));
      const next = objective(rounds, trial);
      const dot = current.gradient.reduce((n, g, k) => n + g * (trial[k] - beta[k]), 0);
      if (next.loss <= current.loss + 0.0001 * dot) {
        accepted = { beta: trial, state: next };
        break;
      }
    }
    if (!accepted) {
      reason = 'backtracking tolerance';
      break;
    }
    beta = accepted.beta;
    current = accepted.state;
  }
  return {
    beta,
    iterations,
    reason,
    objective: current.loss,
    gradient: current.gradient,
    trainingRounds: current.trainingRounds,
  };
}
function score(rounds, beta, strength) {
  const rows = rounds.map((r) => {
    const points = r.points.map((point) => ({
      seq: point.seq,
      ...metric(
        inScope(r) ? tilt(point.probabilities, point.values, beta, strength) : point.probabilities,
        r.goal,
      ),
    }));
    return {
      id: r.id,
      goal: r.goal,
      inScope: inScope(r),
      checkpoints: points.length,
      brier: mean(points.map((p) => p.brier)),
      logLoss: mean(points.map((p) => p.logLoss)),
      finalBrier: points.at(-1).brier,
      finalLogLoss: points.at(-1).logLoss,
    };
  });
  return {
    rounds: rows.length,
    scopedRounds: rows.filter((r) => r.inScope).length,
    brier: mean(rows.map((r) => r.brier)),
    logLoss: mean(rows.map((r) => r.logLoss)),
    finalBrier: mean(rows.map((r) => r.finalBrier)),
    finalLogLoss: mean(rows.map((r) => r.finalLogLoss)),
    perRound: rows,
  };
}
function featureData(partition) {
  const data = read('features-' + partition + '.json');
  if (
    data.protocolSha256 !== PROTOCOL_SHA ||
    data.manifestSha256 !== sha(fs.readFileSync(path.join(OUT, 'manifest.json'))) ||
    data.featureSourceSha256 !== sha(fs.readFileSync(FEATURE_FILE)) ||
    data.featureContractSha256 !== sha(fs.readFileSync(path.join(OUT, 'feature-contract.json'))) ||
    data.baselineSha256 !== sha(fs.readFileSync(path.join(OUT, 'baseline-' + partition + '.json')))
  )
    throw Error('Feature cache changed/stale');
  return data;
}
function select() {
  protocol();
  const train = featureData('train');
  const validation = featureData('validation');
  const fitted = fit(train.rounds);
  const candidates = [0, 0.5, 1].map((strength) => ({
    strength,
    training: score(train.rounds, fitted.beta, strength),
    validation: score(validation.rounds, fitted.beta, strength),
  }));
  const baseline = candidates[0].validation;
  const eligible = candidates.filter(
    (c) =>
      c.strength > 0 &&
      fitted.beta.some((b) => Math.abs(b * c.strength) > 1e-12) &&
      c.validation.brier < baseline.brier - 1e-12 &&
      c.validation.logLoss < baseline.logLoss - 1e-12,
  );
  eligible.sort(
    (a, b) =>
      a.validation.brier - b.validation.brier ||
      a.validation.logLoss - b.validation.logLoss ||
      a.strength - b.strength,
  );
  const selected = eligible[0] || candidates[0];
  const result = {
    schema: 1,
    createdAt: new Date().toISOString(),
    manifestSha256: train.manifestSha256,
    protocolSha256: PROTOCOL_SHA,
    featureSourceSha256: train.featureSourceSha256,
    runnerSha256: sha(fs.readFileSync(__filename)),
    featureTrainSha256: sha(fs.readFileSync(path.join(OUT, 'features-train.json'))),
    featureValidationSha256: sha(fs.readFileSync(path.join(OUT, 'features-validation.json'))),
    numericalTieTolerance: 1e-12,
    fitted,
    candidates,
    selectedStrength: selected.strength,
    selectedBeta: fitted.beta.map((v) => v * selected.strength),
    decision: selected.strength
      ? 'Validation candidate eligible; root must lock before opening test. No production change.'
      : 'Keep v0.12; test and diagnostic remain closed.',
  };
  write('selection.json', result);
  return {
    ...result,
    candidates: candidates.map((c) => ({
      strength: c.strength,
      training: { ...c.training, perRound: undefined },
      validation: { ...c.validation, perRound: undefined },
    })),
  };
}
function pairedAudit(base, candidate) {
  const diffs = base.perRound.map((b, i) => {
    const c = candidate.perRound[i];
    if (c.id !== b.id) throw Error('Round pairing mismatch');
    return { id: b.id, brier: c.brier - b.brier, logLoss: c.logLoss - b.logLoss };
  });
  let randomState = 0x29b1d;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const metrics = {};
  for (const key of ['brier', 'logLoss']) {
    const values = diffs.map((x) => x[key]);
    const boot = [];
    for (let i = 0; i < 5000; i++)
      boot.push(mean(values.map(() => values[Math.floor(random() * values.length)])));
    boot.sort((a, b) => a - b);
    metrics[key] = {
      difference: mean(values),
      improvedRounds: values.filter((v) => v < 0).length,
      worsenedRounds: values.filter((v) => v > 0).length,
      maxWorsening: Math.max(...values),
      bootstrap95: [boot[125], boot[4874]],
      leaveOneOut: diffs.map((r, i) => ({
        omitted: r.id,
        difference: mean(values.filter((_, j) => j !== i)),
      })),
    };
  }
  return {
    metrics,
    perRound: diffs,
    note: 'Paired round bootstrap is descriptive: only eight test rounds, repeated opponents, and all data previously seen. It is not a prospective confidence guarantee.',
  };
}
function evaluateLocked(partition) {
  protocol();
  const manifestSha256 = sha(fs.readFileSync(path.join(OUT, 'manifest.json')));
  A.checkPartition(partition, manifestSha256);
  const lock = read('candidate-lock.json');
  if (
    lock.protocolSha256 !== PROTOCOL_SHA ||
    lock.featureSourceSha256 !== sha(fs.readFileSync(FEATURE_FILE)) ||
    lock.selectionSha256 !== sha(fs.readFileSync(path.join(OUT, 'selection.json'))) ||
    read('selection.json').runnerSha256 !== sha(fs.readFileSync(__filename))
  )
    throw Error('Candidate source/protocol/selection/runner changed after lock');
  const data = featureData(partition);
  const baseline = score(data.rounds, [0, 0], 0);
  const candidate = score(data.rounds, lock.beta, 1);
  const result = {
    schema: 1,
    partition,
    manifestSha256,
    protocolSha256: PROTOCOL_SHA,
    lockSha256: sha(fs.readFileSync(path.join(OUT, 'candidate-lock.json'))),
    featureDataSha256: sha(fs.readFileSync(path.join(OUT, 'features-' + partition + '.json'))),
    runnerSha256: sha(fs.readFileSync(__filename)),
    numericalTieTolerance: 1e-12,
    baseline,
    candidate,
    bothScoresImprove:
      candidate.brier < baseline.brier - 1e-12 && candidate.logLoss < baseline.logLoss - 1e-12,
    paired: pairedAudit(baseline, candidate),
  };
  write('evaluation-' + partition + '.json', result);
  return {
    ...result,
    baseline: { ...baseline, perRound: undefined },
    candidate: { ...candidate, perRound: undefined },
    paired: { ...result.paired, perRound: undefined },
  };
}
if (require.main === module) {
  try {
    const [cmd, part] = process.argv.slice(2);
    console.log(
      JSON.stringify(
        cmd === 'extract'
          ? extract(part)
          : cmd === 'select'
            ? select()
            : cmd === 'evaluate'
              ? evaluateLocked(part)
              : (() => {
                  throw Error(
                    'Usage: fit-bid-signals.cjs extract PARTITION | select | evaluate test|diagnostic',
                  );
                })(),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
module.exports = {
  centered,
  tilt,
  objective,
  fit,
  score,
  pairedAudit,
  extract,
  select,
  evaluateLocked,
  assertPrefixScope,
};
