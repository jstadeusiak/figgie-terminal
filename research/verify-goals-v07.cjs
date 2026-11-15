const fs = require('fs');
const B7 = require('../extension/belief.js');
const B6 = require('../extension/belief-v0.6.js');
const J = require('../extension/journal.js');
const dir = 'outputs/model-review-v07';
const rows = fs
  .readFileSync(dir + '/recordings-combined.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const old = JSON.parse(fs.readFileSync(dir + '/goal-asks-check.json', 'utf8'));
const ids = ['s', 'c', 'd', 'h'];
const by = new Map();
for (const e of rows)
  if (e.roundId) {
    if (!by.has(e.roundId)) by.set(e.roundId, []);
    by.get(e.roundId).push(e);
  }
const ms = rows
  .filter(
    (e) =>
      e.kind === 'round_metadata' && e.revealed?.goal && e.id !== 'round-1793144490477-e7c5a184',
  )
  .sort((a, b) => by.get(a.id)[0].at - by.get(b.id)[0].at);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const score = (p, g) => ({
  brier: sum(p.map((v, i) => (v - Number(i === g)) ** 2)),
  logLoss: -Math.log(Math.max(1e-9, p[g])),
  top: p.indexOf(Math.max(...p)),
  goalP: p[g],
});
let results = [];
let maxCandidateDifference = 0;
let maxV6Difference = 0;
let allAsks = new Map();
let rejectedCheckpointCount = 0;
for (const m of ms) {
  const es = by.get(m.id).sort((a, b) => a.seq - b.seq);
  const live = J.livePredictions(es);
  const g = ids.indexOf(m.revealed.goal);
  const e6 = new B6.BeliefEngine({ skipPricing: true });
  const e7 = new B7.BeliefEngine({ skipPricing: true });
  const ref = old.rounds.find((r) => r.id === m.id);
  const points = [];
  for (const event of live) {
    const prefix = es.filter((e) => e.seq < event.seq);
    const snapshot = J.replay(prefix);
    const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
    const journal = J.restore({ ...m, snapshot, revealed: null }, prefix);
    const v6 = e6.infer(snapshot, journal.evidence, prior);
    const v7 = e7.infer(snapshot, journal.evidence, prior);
    const p6 = v6.scoringProbabilities;
    const p7 = v7.scoringProbabilities;
    const candidate = ref?.points.find((p) => p.seq === event.seq);
    const delta = candidate?.p ? Math.max(...p7.map((v, i) => Math.abs(v - candidate.p[i]))) : null;
    if (delta !== null) maxCandidateDifference = Math.max(maxCandidateDifference, delta);
    if (candidate)
      maxV6Difference = Math.max(
        maxV6Difference,
        Math.abs(score(p6, g).brier - candidate.current.brier),
      );
    if (v7.inventoryEvidence.rejectedAsks) rejectedCheckpointCount++;
    for (const q of journal.evidence) {
      if (q.kind !== 'quote' || q.direction !== 'sell' || q.recovered || q.actor === snapshot.self)
        continue;
      allAsks.set(
        m.id + '|' + q.at + '|' + q.epoch + '|' + q.actor + '|' + q.suit + '|' + q.price,
        q,
      );
    }
    points.push({
      seq: event.seq,
      tradeCount: snapshot.trades.length,
      timer: snapshot.timer,
      v6: score(p6, g),
      v7: score(p7, g),
      p6,
      p7,
      inventoryEvidence: v7.inventoryEvidence,
      actualGoalExcluded: p7[g] === 0,
      candidateDifference: delta,
    });
  }
  results.push({
    id: m.id,
    goal: m.revealed.goal,
    difficulty: m.snapshot.context?.botDifficulty,
    points,
  });
  console.log('Verified', results.length, ms.length, m.id);
}
const aggregate = (rs) => ({
  rounds: rs.length,
  checkpoints: sum(rs.map((r) => r.points.length)),
  v6: {
    brier: mean(rs.map((r) => mean(r.points.map((p) => p.v6.brier)))),
    logLoss: mean(rs.map((r) => mean(r.points.map((p) => p.v6.logLoss)))),
    finalCorrect: sum(rs.map((r) => Number(r.points.at(-1).v6.top === ids.indexOf(r.goal)))),
  },
  v7: {
    brier: mean(rs.map((r) => mean(r.points.map((p) => p.v7.brier)))),
    logLoss: mean(rs.map((r) => mean(r.points.map((p) => p.v7.logLoss)))),
    finalCorrect: sum(rs.map((r) => Number(r.points.at(-1).v7.top === ids.indexOf(r.goal)))),
  },
  improvedRounds: rs.filter((r) => mean(r.points.map((p) => p.v7.brier - p.v6.brier)) < 0).length,
  worsenedRounds: rs.filter((r) => mean(r.points.map((p) => p.v7.brier - p.v6.brier)) > 0).length,
  fallbacks: sum(rs.map((r) => r.points.filter((p) => p.inventoryEvidence.fallback).length)),
  actualGoalsExcluded: sum(rs.map((r) => r.points.filter((p) => p.actualGoalExcluded).length)),
});
const output = {
  input: dir + '/recordings-combined.ndjson',
  versions: [B6.VERSION, B7.VERSION],
  notes: [
    'Pre-reveal prefixes and original saved priors; equal round weighting. All comparisons are retrospective.',
    'Production v7 strict quote qualification and conditional inventory calibration enabled. Goal marginals should match the exploratory ask-only candidate.',
  ],
  all: aggregate(results),
  earlier: aggregate(results.slice(0, -9)),
  latest9: aggregate(results.slice(-9)),
  newest: aggregate(results.slice(-1)),
  maxCandidateDifference,
  maxV6BrierDifference: maxV6Difference,
  uniqueEligibleAskObservations: allAsks.size,
  rejectedCheckpointCount,
  totalQualifiedAskReferences: sum(
    results.flatMap((r) => r.points.map((p) => p.inventoryEvidence.qualifiedAsks)),
  ),
  totalRejectedAskReferences: sum(
    results.flatMap((r) => r.points.map((p) => p.inventoryEvidence.rejectedAsks)),
  ),
  rounds: results,
};
fs.writeFileSync(dir + '/goal-production-check.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ ...output, rounds: undefined }, null, 2));
