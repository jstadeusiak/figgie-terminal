#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function gates(summary, id, limits, stability = true) {
  const baseline = summary.models.baseline;
  const candidate = summary.models[id];
  const checks = {};
  function relative(name, b, c, cap) {
    checks[name] = {
      baseline: b,
      candidate: c,
      ratio: b === 0 ? (c === 0 ? 1 : null) : c / b,
      maxRatio: cap,
      pass: Number.isFinite(b) && Number.isFinite(c) && c <= b * cap + 1e-12,
    };
  }
  if (stability) {
    relative(
      'oneSecondTV',
      baseline.oneSecond.totalVariationPpPerMinute,
      candidate.oneSecond.totalVariationPpPerMinute,
      limits.oneSecondTotalVariationRelativeMax,
    );
    relative('oneSecondJumps5', baseline.oneSecond.jumps5, candidate.oneSecond.jumps5, 1);
  }
  relative('clockBrier', baseline.clock.brier, candidate.clock.brier, limits.clockBrierRelativeMax);
  relative(
    'clockLogLoss',
    baseline.clock.logLoss,
    candidate.clock.logLoss,
    limits.clockLogLossRelativeMax,
  );
  for (const [name, table, cap] of [
    [
      'inventoryPayoutMSE',
      summary.values.inventory.total.summary,
      limits.inventoryPayoutMseRelativeMax,
    ],
    ['quoteValueMSE', summary.values.quoteValues.total.summary, limits.quoteValueMseRelativeMax],
    [
      'conditionalBonusMSE',
      summary.values.conditionalBonus.summary,
      limits.conditionalBonusMseRelativeMax,
    ],
  ])
    relative(name, table.baseline.mse, table[id].mse, cap);
  return { pass: Object.values(checks).every((c) => c.pass), checks };
}
function run(protocolPath, resultPath) {
  const protocolBytes = fs.readFileSync(protocolPath);
  const resultBytes = fs.readFileSync(resultPath);
  const protocol = JSON.parse(protocolBytes);
  const result = JSON.parse(resultBytes);
  if (result.protocolSha256 !== sha(protocolBytes)) throw Error('Wrong protocol');
  if (
    JSON.stringify(result.rounds.map((r) => r.id)) !==
    JSON.stringify(protocol.partitions[result.partition])
  )
    throw Error('Incomplete or reordered partition');
  for (const r of result.rounds)
    for (const id of result.modelIds) {
      const s = r.properScores?.[id]?.clockWeighted;
      const v = r.volatility.oneSecond[id];
      if (!s || !(s.seconds > 0) || !Number.isFinite(s.brier) || !Number.isFinite(s.logLoss))
        throw Error('Unscorable official round: ' + r.id);
      if (!(v.durationMinutes > 0) || !Number.isFinite(v.totalVariationPpPerMinute))
        throw Error('Unscorable volatility: ' + r.id);
    }
  const report = {
    createdAt: new Date().toISOString(),
    protocolSha256: sha(protocolBytes),
    resultSha256: sha(resultBytes),
    partition: result.partition,
    scope:
      'Retrospective recorded forecast and volatility gates; runtime, context parity and integration tests are separate release gates.',
    candidates: Object.fromEntries(
      result.modelIds
        .filter((id) => id !== 'baseline')
        .map((id) => [
          id,
          gates(result.summary, id, protocol.gates, result.partition !== 'historicalRegression'),
        ]),
    ),
  };
  if (result.partition === 'development') {
    const passing = Object.keys(report.candidates)
      .filter((id) => report.candidates[id].pass)
      .sort(
        (a, b) =>
          result.summary.models[a].oneSecond.totalVariationPpPerMinute -
            result.summary.models[b].oneSecond.totalVariationPpPerMinute ||
          result.summary.models[a].clock.brier - result.summary.models[b].clock.brier,
      );
    report.selected = passing[0] || null;
    report.frozenBeforeValidation = true;
  }
  const file = path.join(path.dirname(protocolPath), result.partition + '-selection.json');
  if (fs.existsSync(file)) throw Error('Refuse to overwrite selection');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, output: file }, null, 2));
  return report;
}
module.exports = { gates, run };
if (require.main === module) run(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
