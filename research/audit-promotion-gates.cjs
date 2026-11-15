#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pairedBootstrap, equalStratum } = require('./audit-simulation-scores.cjs');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fields = {
  goalBrier: {
    path: ['values', 'goalBrier', 'mean'],
    threshold: 'goalBrierMaxAbsoluteIncrease',
    relative: false,
  },
  conditionalBonusMse: {
    path: ['errors', 'conditionalBonus', 'mse'],
    threshold: 'conditionalBonusMseMaxRelativeIncrease',
    relative: true,
  },
  transferValueMse: {
    path: ['errors', 'transferValue', 'mse'],
    threshold: 'transferValueMseMaxRelativeIncrease',
    relative: true,
  },
  bestAvailableEdgeMse: {
    path: ['errors', 'bestEdge', 'mse'],
    threshold: 'bestAvailableEdgeMseMaxRelativeIncrease',
    relative: true,
  },
};
const at = (o, keys) => keys.reduce((v, k) => v?.[k], o);
function compare(rows, base, next, bucket = 'overall') {
  const out = {};
  for (const [name, spec] of Object.entries(fields)) {
    const a = (r) => at(r.models[base]?.[bucket], spec.path);
    const b = (r) => at(r.models[next]?.[bucket], spec.path);
    const valid = rows.filter((r) => Number.isFinite(a(r)) && Number.isFinite(b(r)));
    if (rows.some((r) => Number.isFinite(a(r)) !== Number.isFinite(b(r))))
      throw Error('Asymmetric score coverage ' + name);
    const old = mean(valid.map(a));
    const current = mean(valid.map(b));
    const delta = old === null ? null : current - old;
    out[name] = {
      rounds: valid.length,
      baseline: old,
      candidate: current,
      absoluteChange: delta,
      relativeChange: old > 0 ? delta / old : null,
      equalGamePaired: pairedBootstrap(
        valid.map((r) => ({ ...r, stratum: {} })),
        a,
        b,
      ),
      equalStratum: {
        baseline: equalStratum(valid, a).mean,
        candidate: equalStratum(valid, b).mean,
      },
      ...(spec.relative
        ? {
            baselineRmse: old === null ? null : Math.sqrt(old),
            candidateRmse: current === null ? null : Math.sqrt(current),
          }
        : {}),
    };
  }
  return out;
}
function decision(result, gates) {
  return Object.fromEntries(
    Object.entries(fields).map(([name, spec]) => {
      const value = spec.relative ? result[name].relativeChange : result[name].absoluteChange;
      const threshold = gates[spec.threshold];
      if (!Number.isFinite(threshold)) throw Error('Missing frozen gate ' + spec.threshold);
      return [
        name,
        {
          observedIncrease: value,
          maxIncrease: threshold,
          scale: spec.relative ? 'relative' : 'absolute',
          pass: Number.isFinite(value) && value <= threshold,
        },
      ];
    }),
  );
}
function run(folder, candidatePrefix, output) {
  const root = path.resolve(__dirname, '..');
  const review = path.join(root, 'outputs/simulation-review-2026-10-28');
  const gatesBytes = fs.readFileSync(path.join(review, 'promotion-gates.json'));
  const gates = JSON.parse(gatesBytes);
  const manifestBytes = fs.readFileSync(path.join(review, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const runBytes = fs.readFileSync(path.join(folder, 'run.json'));
  const meta = JSON.parse(runBytes);
  const rowsBytes = fs.readFileSync(path.join(folder, 'rounds.ndjson'));
  const rows = rowsBytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  const expected = manifest.games.filter((g) => g.partition === 'test');
  const ids = new Map(expected.map((g) => [g.id, g.seed]));
  const selectionBytes = fs.readFileSync(path.join(review, 'locked-test-selection.json'));
  const selection = JSON.parse(selectionBytes);
  if (
    selection.locked !== true ||
    sha(selectionBytes) !== meta.selectionFileSha256 ||
    selection.promotionGatesSha256 !== sha(gatesBytes) ||
    selection.manifestSha256 !== sha(manifestBytes) ||
    selection.modelSpecSha256 !== meta.modelSpecSha256 ||
    JSON.stringify(selection.modelsProvenance) !== JSON.stringify(meta.modelsProvenance)
  )
    throw Error('Run, immutable selection, gates, or model provenance disagree');
  if (
    meta.partition !== 'test' ||
    rows.length !== 400 ||
    expected.length !== 400 ||
    meta.samples !== gates.testSamples ||
    meta.manifestSha256 !== sha(manifestBytes) ||
    !meta.selectionFileSha256
  )
    throw Error('Expected complete frozen512-sample selected400-game test run');
  if (
    new Set(rows.map((r) => r.game)).size !== 400 ||
    new Set(rows.map((r) => r.seed)).size !== 400 ||
    rows.some((r) => ids.get(r.game) !== r.seed)
  )
    throw Error('Wrong or duplicate held-out games');
  const contexts = {};
  for (const context of gates.contexts) {
    const base = '0.11.0@' + context;
    const next = candidatePrefix + '@' + context;
    if (!meta.modelsProvenance.some((m) => m.id === next))
      throw Error('Candidate not in frozen run');
    const results = compare(rows, base, next);
    const checks = decision(results, gates.gates);
    const strata = [...new Set(rows.map((r) => JSON.stringify(r.stratum)))];
    contexts[context] = {
      weighting:
        'Equal game within each reported subset; overall gates use all eligible test games. Equal-stratum summaries are separate.',
      results,
      checks,
      scoreGatesPass: Object.values(checks).every((x) => x.pass),
      slices: Object.fromEntries(
        strata.map((key) => {
          const selected = rows.filter((r) => JSON.stringify(r.stratum) === key);
          return [key, { games: selected.length, metrics: compare(selected, base, next) }];
        }),
      ),
      players: Object.fromEntries(
        [4, 5].map((n) => {
          const selected = rows.filter((r) => r.stratum.players === n);
          return [n, { games: selected.length, metrics: compare(selected, base, next) }];
        }),
      ),
      stages: Object.fromEntries(
        ['opening', 'middle', 'late'].map((stage) => [
          stage,
          compare(rows, base, next, 'stage:' + stage),
        ]),
      ),
    };
  }
  const report = {
    schema: 1,
    createdAt: new Date().toISOString(),
    purpose: gates.purpose,
    source: {
      folder: path.resolve(folder),
      runSha256: sha(runBytes),
      roundsSha256: sha(rowsBytes),
      manifestSha256: sha(manifestBytes),
      gatesSha256: sha(gatesBytes),
      auditorSha256: sha(fs.readFileSync(__filename)),
      selectionFileSha256: meta.selectionFileSha256,
      modelSpecSha256: meta.modelSpecSha256,
      modelsProvenance: meta.modelsProvenance,
    },
    coverage: {
      games: rows.length,
      partition: 'test',
      configuredSamples: meta.samples,
      contexts: gates.contexts,
    },
    contexts,
    scoreGatesPass: Object.values(contexts).every((c) => c.scoreGatesPass),
    additionalRequirementsNotCertifiedHere: gates.additionalRequirements,
    interpretation: [
      'This is a predeclared engineering no-material-regression gate, not a claim of improved predictive accuracy.',
      'Gates use arithmetic means of per-game metric summaries, separately per context. RMSE derives from mean MSE; no average of RMSE or pooling opportunities.',
      'Best-available-edge scores are static, model-selected opportunities and can have fewer than400 games with quotes. Their target differs when ranking changes.',
      'Paired confidence intervals resample games. Within-game checkpoints and transfers are not independent; synthetic uncertainty is not evidence about native bots.',
      'Stratum/player/stage slices are diagnostic only; there is no new test-driven candidate selection.',
    ],
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  return {
    output,
    scoreGatesPass: report.scoreGatesPass,
    contexts: Object.fromEntries(
      Object.entries(contexts).map(([k, v]) => [k, { results: v.results, checks: v.checks }]),
    ),
  };
}
function selfTest() {
  const row = (seed, old, next) => ({
    seed,
    stratum: { players: 4 },
    models: {
      a: {
        overall: {
          values: { goalBrier: { mean: old } },
          errors: {
            conditionalBonus: { mse: old * 100 },
            transferValue: { mse: old * 100 },
            bestEdge: { mse: old * 100 },
          },
        },
      },
      b: {
        overall: {
          values: { goalBrier: { mean: next } },
          errors: {
            conditionalBonus: { mse: next * 100 },
            transferValue: { mse: next * 100 },
            bestEdge: { mse: next * 100 },
          },
        },
      },
    },
  });
  const c = compare([row(1, 0.5, 0.501), row(2, 0.4, 0.401)], 'a', 'b');
  const g = {
    goalBrierMaxAbsoluteIncrease: 0.002,
    conditionalBonusMseMaxRelativeIncrease: 0.02,
    transferValueMseMaxRelativeIncrease: 0.02,
    bestAvailableEdgeMseMaxRelativeIncrease: 0.02,
  };
  assert(Object.values(decision(c, g)).every((x) => x.pass));
  c.goalBrier.absoluteChange = 0.003;
  assert.equal(decision(c, g).goalBrier.pass, false);
  c.transferValueMse.relativeChange = 0.021;
  assert.equal(decision(c, g).transferValueMse.pass, false);
  assert(Math.abs(c.conditionalBonusMse.baseline - 45) < 1e-12);
  console.log('Independent fixed-gate weighting and threshold tests pass.');
}
module.exports = { run, compare, decision };
if (require.main === module) {
  try {
    const a = process.argv.slice(2);
    if (a[0] === '--self-test') selfTest();
    else {
      if (a.length !== 3)
        throw Error(
          'Usage: audit-promotion-gates.cjs FINAL_TEST_FOLDER CANDIDATE_ID_PREFIX OUTPUT.json',
        );
      console.log(JSON.stringify(run(...a), null, 2));
    }
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
