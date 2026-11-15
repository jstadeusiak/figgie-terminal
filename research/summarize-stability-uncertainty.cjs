#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
function random(seed) {
  return () => {
    seed += 0x6d2b79f5;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function paired(rows, seed, repetitions = 10000) {
  rows = rows.filter((r) => Number.isFinite(r.baseline) && Number.isFinite(r.candidate));
  if (!rows.length) return { rounds: 0 };
  const rng = random(seed);
  const deltas = [];
  const ratios = [];
  for (let k = 0; k < repetitions; k++) {
    let b = 0;
    let c = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[Math.floor(rng() * rows.length)];
      b += r.baseline;
      c += r.candidate;
    }
    deltas.push((c - b) / rows.length);
    if (b > 0) ratios.push(c / b);
  }
  deltas.sort((a, b) => a - b);
  ratios.sort((a, b) => a - b);
  const interval = (a) =>
    a.length
      ? [a[Math.floor(0.025 * a.length)], a[Math.min(a.length - 1, Math.floor(0.975 * a.length))]]
      : null;
  const baseline = mean(rows.map((r) => r.baseline));
  const candidate = mean(rows.map((r) => r.candidate));
  return {
    rounds: rows.length,
    baseline,
    candidate,
    delta: candidate - baseline,
    ratio: baseline > 0 ? candidate / baseline : null,
    improvedRounds: rows.filter((r) => r.candidate < r.baseline - 1e-12).length,
    worseRounds: rows.filter((r) => r.candidate > r.baseline + 1e-12).length,
    unchangedRounds: rows.filter((r) => Math.abs(r.candidate - r.baseline) <= 1e-12).length,
    bootstrapDelta95: interval(deltas),
    bootstrapRatio95: interval(ratios),
    repetitions,
    seed,
  };
}
function run(file, candidate = 'tail8') {
  const bytes = fs.readFileSync(file);
  const result = JSON.parse(bytes);
  const comparisons = {};
  const seed = 20261030;
  for (const [i, metric] of ['brier', 'logLoss'].entries())
    comparisons[metric] = paired(
      result.rounds
        .filter((r) => r.properScores)
        .map((r) => ({
          id: r.id,
          baseline: r.properScores.baseline.clockWeighted[metric],
          candidate: r.properScores[candidate].clockWeighted[metric],
        })),
      seed + i,
    );
  comparisons.oneSecondTV = paired(
    result.rounds.map((r) => ({
      id: r.id,
      baseline: r.volatility.oneSecond.baseline.totalVariationPpPerMinute,
      candidate: r.volatility.oneSecond[candidate].totalVariationPpPerMinute,
    })),
    seed + 2,
  );
  comparisons.jumps5 = paired(
    result.rounds.map((r) => ({
      id: r.id,
      baseline: r.volatility.oneSecond.baseline.jumps5,
      candidate: r.volatility.oneSecond[candidate].jumps5,
    })),
    seed + 3,
  );
  for (const [i, [name, table]] of [
    ['inventoryMSE', result.summary.values.inventory.total],
    ['quoteMSE', result.summary.values.quoteValues.total],
    ['conditionalBonusMSE', result.summary.values.conditionalBonus],
  ].entries())
    comparisons[name] = paired(
      table.perRound.map((r) => ({
        id: r.roundId,
        baseline: r.metrics.baseline.mse,
        candidate: r.metrics[candidate].mse,
      })),
      seed + 4 + i,
    );
  const report = {
    partition: result.partition,
    candidate,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    comparisons,
    method:
      'Paired nonparametric bootstrap resampling complete rounds; each pair retains both model forecasts. Percentile95 intervals,10000 fixed-seed replicates. Lower errors/variation are better.',
    limitations: [
      'All partitions are retrospective and previously examined. These intervals do not create a prospective holdout or prove calibration.',
      'Between-round dependence, opponent regime shifts and selection effects are not corrected by this bootstrap.',
      'Value scores include only common identified labels; their round counts can differ from goal scores.',
    ],
  };
  const out = path.join(
    path.dirname(file),
    result.partition + '-uncertainty-' + candidate + '.json',
  );
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, comparisons }, null, 2));
  return report;
}
module.exports = { run, paired };
if (require.main === module) run(path.resolve(process.argv[2]), process.argv[3]);
