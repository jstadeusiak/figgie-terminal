const fs = require('fs');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
const dir = 'outputs/model-review-recent-2026-10-27';
const rows = fs
  .readFileSync(dir + '/recordings.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const ids = ['s', 'c', 'd', 'h'];
const policies = {
  current: { temperature: 0.3, quote: 0.2, consent: 0.12, cap: 5 },
  stronger: { temperature: 0.6, quote: 0.2, consent: 0.12, cap: 5 },
  tradeFocused: { temperature: 0.6, quote: 0.1, consent: 0.08, cap: 5 },
  tradeFocusedStrong: { temperature: 1, quote: 0.1, consent: 0.08, cap: 5 },
  quotesStronger: { temperature: 0.6, quote: 0.4, consent: 0.12, cap: 5 },
};
const metas = rows.filter(
  (r) =>
    r.kind === 'round_metadata' &&
    r.revealed &&
    r.snapshot.context?.botDifficulty === 'Medium' &&
    r.id !== 'round-1793144490477-e7c5a184',
);
const byRound = new Map(metas.map((m) => [m.id, []]));
for (const r of rows) if (byRound.has(r.roundId)) byRound.get(r.roundId).push(r);
const results = [];
for (const m of metas) {
  const es = byRound.get(m.id).sort((a, b) => a.seq - b.seq);
  const live = J.livePredictions(es);
  const goal = ids.indexOf(m.revealed.goal);
  const engines = Object.fromEntries(
    Object.entries(policies).map(([k, v]) => [
      k,
      new B.BeliefEngine({ signalPolicy: v, skipPricing: true }),
    ]),
  );
  const scores = Object.fromEntries(Object.keys(policies).map((k) => [k, []]));
  for (const event of live) {
    const prefix = es.filter((e) => e.seq < event.seq);
    const snapshot = J.replay(prefix);
    if (!snapshot) continue;
    const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
    const journal = J.restore({ ...m, snapshot }, prefix);
    for (const [key, engine] of Object.entries(engines)) {
      const model = engine.infer(snapshot, journal.evidence, prior);
      const p = model.scoringProbabilities;
      scores[key].push({
        brier: p.reduce((a, v, i) => a + (v - (i === goal ? 1 : 0)) ** 2, 0),
        logLoss: -Math.log(Math.max(1e-9, p[goal])),
        goalProbability: p[goal],
        computeMs: model.computeMs,
      });
    }
  }
  const avg = (a) => a.reduce((a, b) => a + b, 0) / a.length;
  results.push({
    id: m.id,
    round: m.snapshot.round,
    goal: m.revealed.goal,
    split: results.length < 11 ? 'earlier11' : results.length < 19 ? 'later8' : 'new4',
    checkpoints: live.length,
    scores: Object.fromEntries(
      Object.entries(scores).map(([key, list]) => [
        key,
        {
          brier: avg(list.map((v) => v.brier)),
          logLoss: avg(list.map((v) => v.logLoss)),
          lastGoalProbability: list.at(-1)?.goalProbability,
          meanMs: avg(list.map((v) => v.computeMs)),
        },
      ]),
    ),
  });
  console.log('Round', results.length, m.id, live.length);
}
const aggregate = (rr) =>
  Object.fromEntries(
    Object.keys(policies).map((key) => [
      key,
      Object.fromEntries(
        ['brier', 'logLoss', 'meanMs'].map((metric) => [
          metric,
          rr.reduce((a, r) => a + r.scores[key][metric], 0) / rr.length,
        ]),
      ),
    ]),
  );
const out = {
  policies,
  rounds: results.length,
  splits: Object.fromEntries(
    ['earlier11', 'later8', 'new4'].map((split) => [
      split,
      aggregate(results.filter((r) => r.split === split)),
    ]),
  ),
  all: aggregate(results),
  results,
};
fs.writeFileSync(dir + '/signal-comparison.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, results: undefined }, null, 2));
