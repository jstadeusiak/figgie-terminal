const fs = require('node:fs');
const J = require('../extension/journal.js');
const dir = 'outputs/model-review-v08';
const rows = fs
  .readFileSync(dir + '/recordings-combined.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const sources = JSON.parse(fs.readFileSync(dir + '/sources.json'));
const newIds = new Set(sources.newRoundIds);
const by = new Map();
for (const e of rows)
  if (newIds.has(e.roundId)) {
    if (!by.has(e.roundId)) by.set(e.roundId, []);
    by.get(e.roundId).push(e);
  }
const sum = (a) => a.reduce((a, b) => a + b, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const rounds = [];
for (const m of rows.filter((e) => e.kind === 'round_metadata' && newIds.has(e.id))) {
  const events = (by.get(m.id) || []).sort((a, b) => a.seq - b.seq);
  const predictions = new Map(
    events.filter((e) => e.kind === 'fill_prediction').map((e) => [e.key, e]),
  );
  const outcomes = J.scoredFillOutcomes(events);
  const valid = outcomes
    .filter((e) => !e.censored && predictions.has(e.key) && Number.isFinite(e.pFill))
    .map((e) => ({
      ...e,
      side: predictions.get(e.key).side,
      suit: predictions.get(e.key).suit,
      price: predictions.get(e.key).price,
      epoch: predictions.get(e.key).epoch,
    }));
  rounds.push({
    id: m.id,
    status: m.snapshot.status,
    predictions: predictions.size,
    censored: outcomes.filter((e) => e.censored).length,
    outcomes: valid,
  });
}
function score(xs) {
  return {
    opportunities: xs.length,
    fills: xs.filter((e) => e.filled).length,
    meanPredicted: mean(xs.map((e) => e.pFill)),
    observed: mean(xs.map((e) => Number(e.filled))),
    brier: mean(xs.map((e) => (e.pFill - Number(e.filled)) ** 2)),
  };
}
const all = rounds.flatMap((r) => r.outcomes);
const report = {
  scope:
    'New round IDs only; actual observed top quotes, not hypothetical +1/-1 quotes. Censored or unresolved quotes excluded. Informative censoring can affect interpretation.',
  rounds: rounds.length,
  completedRounds: rounds.filter((r) => r.status === 'ended').length,
  all: score(all),
  bySide: Object.fromEntries(
    ['bid', 'ask'].map((side) => [side, score(all.filter((e) => e.side === side))]),
  ),
  bins: [
    [0, 0.05],
    [0.05, 0.1],
    [0.1, 0.2],
    [0.2, 0.4],
    [0.4, 1.01],
  ].map(([lo, hi]) => ({ lo, hi, ...score(all.filter((e) => e.pFill >= lo && e.pFill < hi)) })),
  roundDetails: rounds,
};
fs.writeFileSync(dir + '/fill-calibration.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, roundDetails: undefined }, null, 2));
