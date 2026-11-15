// Verify the shipping engine against the offline audit's reconstructed labels.
const fs = require('node:fs');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
const source = 'outputs/model-review-v07/recordings-combined.ndjson';
const rows = fs.readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse);
const audit = JSON.parse(fs.readFileSync('outputs/model-review-v07/bonus-variants.json'));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => sum(a) / a.length;
const rounds = [];
let maxCandidateDifference = 0;
for (const r of audit.report) {
  const meta = rows.find((e) => e.kind === 'round_metadata' && e.id === r.id);
  const events = rows.filter((e) => e.roundId === r.id).sort((a, b) => a.seq - b.seq);
  const engine = new B.BeliefEngine({ skipPricing: true });
  const points = [];
  for (const p of r.points) {
    const prefix = events.filter((e) => e.seq < p.seq);
    const snapshot = J.replay(prefix);
    const journal = J.restore({ ...meta, snapshot, revealed: null }, prefix);
    const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
    const m = engine.infer(snapshot, journal.evidence, prior);
    const v = m.bySuit[B.IDS.indexOf(r.goal)];
    const category = ['solo', 'tie', 'none'].map((k) => Number(p.truth.category === k));
    const ps = [
      v.conditionalSoloProbability,
      v.conditionalTieProbability,
      v.conditionalNoBonusProbability,
    ];
    const item = {
      seq: p.seq,
      oldBonus: p.current.bonus,
      bonus: v.conditionalBonus,
      truth: p.truth.bonus,
      oldError: Math.abs(p.current.bonus - p.truth.bonus),
      error: Math.abs(v.conditionalBonus - p.truth.bonus),
      bias: v.conditionalBonus - p.truth.bonus,
      leaderBrier: (v.conditionalLeaderProbability - Number(p.truth.category !== 'none')) ** 2,
      categoryBrier: sum(ps.map((q, i) => (q - category[i]) ** 2)),
      calibrationActive: m.inventoryCalibration.active,
      askFallback: m.inventoryEvidence.fallback,
    };
    points.push(item);
    if (r.difficulty === 'Medium')
      maxCandidateDifference = Math.max(
        maxCandidateDifference,
        Math.abs(v.conditionalBonus - p.askGuarded.bonus),
      );
  }
  rounds.push({ id: r.id, difficulty: r.difficulty, at: r.at, points });
}
function metrics(rs) {
  return {
    rounds: rs.length,
    checkpoints: sum(rs.map((r) => r.points.length)),
    ...Object.fromEntries(
      ['oldError', 'error', 'bias', 'leaderBrier', 'categoryBrier'].map((k) => [
        k,
        mean(rs.map((r) => mean(r.points.map((p) => p[k])))),
      ]),
    ),
  };
}
const medium = rounds.filter((r) => r.difficulty === 'Medium');
const result = {
  source,
  modelVersion: B.VERSION,
  method:
    'Shipping v0.7 inference at each pre-reveal checkpoint; same settlement labels as bonus audit; equal round weight.',
  maxMediumCandidateBonusDifference: maxCandidateDifference,
  all: metrics(rounds),
  medium: metrics(medium),
  latestFourMedium: metrics(medium.slice(-4)),
  askFallbacks: rounds.flatMap((r) => r.points).filter((p) => p.askFallback).length,
  rounds,
};
fs.writeFileSync(
  'outputs/model-review-v07/bonus-production-check.json',
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify({ ...result, rounds: undefined }, null, 2));
if (maxCandidateDifference > 1e-8) process.exitCode = 2;
