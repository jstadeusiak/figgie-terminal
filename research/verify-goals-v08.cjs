const fs = require('fs');
const crypto = require('crypto');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
const dir = 'outputs/model-review-v08';
const references = ['goal-old.json', 'goal-train.json', 'goal-validate.json'].flatMap(
  (f) => JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')).rounds,
);
const rows = fs
  .readFileSync(dir + '/recordings-combined.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const ids = ['s', 'c', 'd', 'h'];
const by = new Map();
const newIds = new Set(JSON.parse(fs.readFileSync(dir + '/sources.json', 'utf8')).newRoundIds);
for (const e of rows)
  if (e.roundId) {
    if (!by.has(e.roundId)) by.set(e.roundId, []);
    by.get(e.roundId).push(e);
  }
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const score = (p, g) => ({
  brier: sum(p.map((v, i) => (v - Number(g === i)) ** 2)),
  logLoss: -Math.log(Math.max(1e-9, p[g])),
  top: p.indexOf(Math.max(...p)),
});
let rounds = [];
let maxCandidateDifference = 0;
let maxNewSavedDifference = 0;
for (const ref of references) {
  const m = rows.find((e) => e.kind === 'round_metadata' && e.id === ref.id);
  const es = by.get(ref.id).sort((a, b) => a.seq - b.seq);
  const engine = new B.BeliefEngine({ skipPricing: true });
  const points = [];
  const g = ids.indexOf(m.revealed.goal);
  for (const e of J.livePredictions(es)) {
    const prefix = es.filter((x) => x.seq < e.seq);
    const snapshot = J.replay(prefix);
    const prior = prefix.findLast((x) => x.kind === 'learning_prior')?.learning || {};
    const journal = J.restore({ ...m, snapshot, revealed: null }, prefix);
    const model = engine.infer(snapshot, journal.evidence, prior);
    const p = model.scoringProbabilities;
    const expected = ref.points.find((x) => x.seq === e.seq);
    if (!expected) throw Error('Missing reference checkpoint ' + m.id + ' ' + e.seq);
    const difference = Math.max(...p.map((x, i) => Math.abs(x - expected.p.recent24[i])));
    maxCandidateDifference = Math.max(maxCandidateDifference, difference);
    if (newIds.has(m.id))
      maxNewSavedDifference = Math.max(
        maxNewSavedDifference,
        ...p.map((x, i) => Math.abs(x - expected.p.saved[i])),
      );
    points.push({
      seq: e.seq,
      p,
      score: score(p, g),
      oldScore: expected.scores.current,
      candidateDifference: difference,
      inventoryEvidence: model.inventoryEvidence,
      actualGoalExcluded: model.baseline.probabilities[g] === 0,
    });
  }
  rounds.push({
    id: m.id,
    new: newIds.has(m.id),
    goal: m.revealed.goal,
    difficulty: m.snapshot.context?.botDifficulty,
    points,
  });
  console.log(rounds.length, references.length, m.id, points.length);
}
function aggregate(rs) {
  return {
    rounds: rs.length,
    checkpoints: sum(rs.map((r) => r.points.length)),
    previous: {
      brier: mean(rs.map((r) => mean(r.points.map((p) => p.oldScore.brier)))),
      logLoss: mean(rs.map((r) => mean(r.points.map((p) => p.oldScore.logLoss)))),
    },
    production: {
      brier: mean(rs.map((r) => mean(r.points.map((p) => p.score.brier)))),
      logLoss: mean(rs.map((r) => mean(r.points.map((p) => p.score.logLoss)))),
      finalCorrect: sum(rs.map((r) => Number(r.points.at(-1).score.top === ids.indexOf(r.goal)))),
    },
    improved: rs.filter((r) => mean(r.points.map((p) => p.score.brier - p.oldScore.brier)) < -1e-12)
      .length,
    worsened: rs.filter((r) => mean(r.points.map((p) => p.score.brier - p.oldScore.brier)) > 1e-12)
      .length,
    finalRankingFlips: rs.filter((r) => r.points.at(-1).score.top !== r.points.at(-1).oldScore.top)
      .length,
  };
}
const ps = rounds.flatMap((r) => r.points);
const output = {
  modelVersion: B.VERSION,
  productionSha: crypto
    .createHash('sha256')
    .update(fs.readFileSync('extension/belief.js'))
    .digest('hex'),
  notes: [
    'Production compared to candidate locked after training14 and evaluated on latest6, plus old34. Original pre-reveal event prefixes and saved priors; equal round weighting.',
    'Saved v7 forecasts intentionally differ from v8; candidate parity is the integration assertion.',
  ],
  all: aggregate(rounds),
  new20: aggregate(rounds.filter((r) => r.new)),
  old34: aggregate(rounds.filter((r) => !r.new)),
  maxCandidateDifference,
  maxNewSavedDifference,
  qualifiedAskReferences: sum(ps.map((p) => p.inventoryEvidence.qualifiedAsks)),
  rejectedAskReferences: sum(ps.map((p) => p.inventoryEvidence.rejectedAsks)),
  fallbacks: ps.filter((p) => p.inventoryEvidence.fallback).length,
  actualGoalsExcluded: ps.filter((p) => p.actualGoalExcluded).length,
  rounds,
};
fs.writeFileSync(dir + '/goal-production-check.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ ...output, rounds: undefined }, null, 2));
if (
  maxCandidateDifference > 1e-10 ||
  ps.length !== 912 ||
  rounds.length !== 54 ||
  output.fallbacks ||
  output.actualGoalsExcluded
)
  process.exitCode = 1;
