#!/usr/bin/env node
'use strict';
/* Independent aggregation of batch outputs. Does not fit or run model policies. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const stratum = (r) => JSON.stringify(r.stratum || {});
const at = (o, keys) => keys.reduce((x, k) => x?.[k], o);
function equalStratum(rows, value) {
  const groups = new Map();
  for (const r of rows) {
    const v = value(r);
    if (!Number.isFinite(v)) continue;
    const key = stratum(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return {
    mean: mean([...groups.values()].map(mean)),
    strata: groups.size,
    rounds: [...groups.values()].reduce((n, g) => n + g.length, 0),
    perStratum: Object.fromEntries(
      [...groups].map(([k, g]) => [k, { rounds: g.length, mean: mean(g) }]),
    ),
  };
}
function pairedBootstrap(rows, base, candidate, iterations = 2000) {
  const groups = new Map();
  for (const r of rows) {
    const a = base(r);
    const b = candidate(r);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const k = stratum(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ seed: r.seed, delta: b - a });
  }
  // Batch manifests have distinct seeds per game. Repeated seeds need a larger
  // shared-cluster bootstrap, not this within-stratum independent-round form.
  const seeds = [...groups.values()].flat().map((r) => r.seed);
  if (new Set(seeds).size !== seeds.length)
    throw Error('Repeated seed across rows: cluster shared seeds before aggregation');
  let state = 0x5a17;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const estimates = [];
  for (let i = 0; i < iterations; i++)
    estimates.push(
      mean(
        [...groups.values()].map((g) =>
          mean(g.map(() => g[Math.floor(random() * g.length)].delta)),
        ),
      ),
    );
  const adequate = groups.size > 0 && [...groups.values()].every((g) => g.length >= 2);
  const d = seeds.length
    ? mean([...groups.values()].map((g) => mean(g.map((r) => r.delta))))
    : null;
  estimates.sort((a, b) => a - b);
  return {
    rounds: seeds.length,
    strata: groups.size,
    meanDifference: d,
    minimumStratumSize: groups.size ? Math.min(...[...groups.values()].map((g) => g.length)) : 0,
    bootstrap95: adequate
      ? [
          estimates[Math.floor(iterations * 0.025)],
          estimates[Math.min(iterations - 1, Math.floor(iterations * 0.975))],
        ]
      : null,
    method:
      'Paired round bootstrap within strata; strata receive equal weight. Seed overlap is rejected. Synthetic sampling uncertainty only; fewer than two rounds in any stratum yields no interval.',
  };
}
const FIELDS = {
  goalBrier: ['values', 'goalBrier', 'mean'],
  goalLogLoss: ['values', 'goalLogLoss', 'mean'],
  conditionalBonusMse: ['errors', 'conditionalBonus', 'mse'],
  expectedPayoutMse: ['errors', 'expectedPayout', 'mse'],
  expectedBonusMse: ['errors', 'expectedBonus', 'mse'],
  transferValueMse: ['errors', 'transferValue', 'mse'],
  quoteEdgeMse: ['errors', 'quoteEdge', 'mse'],
  bestEdgeMse: ['errors', 'bestEdge', 'mse'],
};
function readBatch(folder) {
  const bytes = fs.readFileSync(path.join(folder, 'rounds.ndjson'));
  const run = fs.readFileSync(path.join(folder, 'run.json'));
  return {
    folder: path.resolve(folder),
    rows: bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    metadata: JSON.parse(run),
    roundsSha256: sha(bytes),
    runSha256: sha(run),
  };
}
function joinRounds(a, b, baseline, candidate) {
  const key = (r) => r.game + '|' + r.seed;
  const map = new Map();
  for (const r of b) {
    if (map.has(key(r))) throw Error('Duplicate candidate game/seed');
    map.set(key(r), r);
  }
  const result = [];
  const seen = new Set();
  for (const r of a) {
    if (seen.has(key(r))) throw Error('Duplicate baseline game/seed');
    seen.add(key(r));
    const other = map.get(key(r));
    if (!other || !r.models[baseline] || !other.models[candidate]) continue;
    if (stratum(r) !== stratum(other) || r.goal !== other.goal || r.trades !== other.trades)
      throw Error('Paired public path metadata mismatch');
    result.push({
      ...r,
      models: { baseline: r.models[baseline], candidate: other.models[candidate] },
    });
  }
  return result;
}
function auditPair(
  baselineFolder,
  candidateFolder,
  baseline = '0.10.0@Medium',
  candidate = '0.11.0@Medium',
) {
  const first = readBatch(baselineFolder);
  const second = readBatch(candidateFolder);
  if (
    first.metadata.manifestSha256 !== second.metadata.manifestSha256 ||
    JSON.stringify(first.metadata.generators) !== JSON.stringify(second.metadata.generators)
  )
    throw Error('Cannot pair different simulation manifests/generators');
  const rows = joinRounds(first.rows, second.rows, baseline, candidate);
  const results = {};
  const metadata = { baseline: first.metadata, candidate: second.metadata };
  for (const [name, keys] of Object.entries(FIELDS)) {
    const a = (r) => at(r.models.baseline?.overall, keys);
    const b = (r) => at(r.models.candidate?.overall, keys);
    const old = equalStratum(rows, a);
    const next = equalStratum(rows, b);
    results[name] = { baseline: old, candidate: next, paired: pairedBootstrap(rows, a, b) };
    if (name.endsWith('Mse')) {
      results[name].baseline.rmse = old.mean === null ? null : Math.sqrt(old.mean);
      results[name].candidate.rmse = next.mean === null ? null : Math.sqrt(next.mean);
    }
  }
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    sources: {
      baseline: {
        folder: first.folder,
        roundsSha256: first.roundsSha256,
        runSha256: first.runSha256,
      },
      candidate: {
        folder: second.folder,
        roundsSha256: second.roundsSha256,
        runSha256: second.runSha256,
      },
      auditorSha256: sha(fs.readFileSync(__filename)),
    },
    metadata,
    baseline,
    candidate,
    coverage: {
      baselineRounds: first.rows.length,
      candidateRounds: second.rows.length,
      pairedRounds: rows.length,
    },
    results,
    interpretation: {
      properScores:
        'Brier/log loss score probabilities. Squared error scores conditional mean payout/value forecasts; RMSE is sqrt(equal-stratum mean per-round MSE), never mean per-round RMSE. MAE targets conditional medians and is secondary for expected-value models.',
      quoteEdges:
        'Subtracting the same visible price cancels in prediction error. quoteEdge MSE is named-transfer value MSE on executable quotes, not fill-adjusted EV validation.',
      selection:
        'bestEdge compares model-selected opportunities and is descriptive; it is not the same fixed forecast target across models. A realized losing positive-edge quote is not proof of negative conditional EV.',
      conditionalBonus:
        'Scoring after conditioning on the actual goal separates the bonus-allocation model from goal probability errors. Expected payout adds goal uncertainty back.',
      independence:
        'Checkpoints, suits, counterparties and directions within one round are correlated; intervals resample rounds, not individual transfers.',
      scope:
        'Synthetic policies are fixed, model-independent generators. These scores do not validate native bots or demonstrate better realized strategy P&L.',
    },
  };
}
function diagnoseHistorical(folder) {
  const source = readBatch(folder);
  const rows = source.rows;
  const models = Object.keys(rows[0]?.models || {});
  if (
    rows.length !== 200 ||
    source.metadata.partition !== 'train' ||
    source.metadata.samples !== 128
  )
    throw Error('Expected completed 200-game,128-sample historical training audit');
  function compact(model, bucket = 'overall', balanced = false) {
    const result = {};
    for (const [name, keys] of Object.entries(FIELDS)) {
      const value = (r) => at(r.models[model]?.[bucket], keys);
      const valid = rows.filter((r) => Number.isFinite(value(r)));
      const v = balanced ? equalStratum(valid, value).mean : mean(valid.map(value));
      result[name] = {
        rounds: valid.length,
        value: v,
        ...(name.endsWith('Mse') ? { rmse: v === null ? null : Math.sqrt(v) } : {}),
      };
    }
    return result;
  }
  const table = Object.fromEntries(models.map((m) => [m, compact(m, 'overall', true)]));
  const focus = {};
  for (const context of ['Simulated', 'Medium']) {
    const model = '0.11.0@' + context;
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r.models[model])))];
    const buckets = keys.filter((k) =>
      /^(stage|goalSupply|initialEntropy|players|policies|regime):/.test(k),
    );
    focus[context] = {
      buckets: Object.fromEntries(
        buckets.map((k) => [
          k,
          {
            current: compact(model, k),
            previous: compact('0.10.0@' + context, k),
            physical: compact('physical@' + context, k),
          },
        ]),
      ),
      goalCalibration: Object.fromEntries(
        keys
          .filter((k) => k.startsWith('probability:'))
          .sort()
          .map((k) => {
            const es = rows.map((r) => r.models[model]?.[k]?.errors.goal).filter(Boolean);
            return [
              k,
              {
                rounds: es.length,
                observations: es.reduce((n, e) => n + e.observations, 0),
                predicted: mean(es.map((e) => e.predicted)),
                observed: mean(es.map((e) => e.actual)),
              },
            ];
          }),
      ),
      errorComponents: {},
    };
    for (const key of [
      'transferBase',
      'transferBonus',
      'contestTransferValue',
      'contestTransferBonus',
      'positiveBestEdge',
      'positiveContestBestEdge',
      'bonusDependentBestEdge',
    ]) {
      const es = rows.map((r) => r.models[model]?.overall.errors[key]).filter(Boolean);
      const mse = mean(es.map((e) => e.mse));
      focus[context].errorComponents[key] = {
        rounds: es.length,
        observations: es.reduce((n, e) => n + e.observations, 0),
        predicted: mean(es.map((e) => e.predicted)),
        actual: mean(es.map((e) => e.actual)),
        bias: mean(es.map((e) => e.bias)),
        mse,
        rmse: mse === null ? null : Math.sqrt(mse),
      };
    }
  }
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    scope:
      'Completed first200 synthetic TRAIN games at128 samples. Exploratory historical comparison, not final production-budget holdout.',
    source: {
      folder: source.folder,
      roundsSha256: source.roundsSha256,
      runSha256: source.runSha256,
      auditorSha256: sha(fs.readFileSync(__filename)),
    },
    metadata: source.metadata,
    overallEqualStratum: table,
    focus,
    limitations: [
      'Historical archive subset0.3,0.6,0.7,0.8,0.10,0.11 plus physical reference; aliases and exact provenance retained in metadata.',
      '128-sample discovery uses a different computational budget from production512; do not use it alone for release promotion.',
      'Overall model table equally weights12 strata; diagnostic buckets and calibration bins equally weight contributing games. A game can contribute to many buckets.',
      'Large realized error in an uncertain bucket includes outcome variance; it does not on its own establish forecast bias or miscalibration.',
      'Multiple diagnostic buckets are exploratory and are not independent confirmations. No hidden-truth bucket is an input to model decisions.',
    ],
  };
}
function audit(folder, baseline, candidate) {
  return auditPair(folder, folder, baseline, candidate);
}
module.exports = {
  equalStratum,
  pairedBootstrap,
  audit,
  auditPair,
  joinRounds,
  diagnoseHistorical,
};
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let result;
    let out;
    if (args[0] === '--historical') {
      result = diagnoseHistorical(path.resolve(args[1]));
      out = args[2];
    } else if (args[0] === '--pair') {
      const [, a, b, base, next, file] = args;
      result = auditPair(path.resolve(a), path.resolve(b), base, next);
      out = file;
    } else {
      const [folder, base, next, file] = args;
      if (!folder)
        throw Error(
          'Usage: audit-simulation-scores.cjs FOLDER BASELINE_ID CANDIDATE_ID OUTPUT.json or --pair BASE_FOLDER CAND_FOLDER BASE_ID CAND_ID OUTPUT.json',
        );
      result = audit(path.resolve(folder), base, next);
      out = file;
    }
    if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    else console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
