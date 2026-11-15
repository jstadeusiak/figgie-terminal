const fs = require('node:fs');
const J = require('../extension/journal.js');
const P = require('../extension/pnl.js');
const file = 'outputs/model-audit-2026-10-27/recordings.ndjson';
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const rounds = [];
for (const metadata of rows.filter((r) => r.kind === 'round_metadata')) {
  const events = rows.filter((r) => r.roundId === metadata.id).sort((a, b) => a.seq - b.seq);
  rounds.push({ metadata, events });
}
rounds.sort((a, b) => a.events[0].at - b.events[0].at);
const ids = ['s', 'c', 'd', 'h'];
const testIds = new Set(['round-1793144490477-e7c5a184']);
const mean = (a) => (a.length ? a.reduce((a, b) => a + b, 0) / a.length : null);
const brier = (p, g) => p.reduce((n, v, i) => n + (v - (i === g ? 1 : 0)) ** 2, 0);
const loss = (p, g) => -Math.log(Math.max(1e-9, p[g]));
const reports = [];
const fillRecords = [];
const predictionRows = [];
for (const { metadata: m, events } of rounds) {
  const s = m.snapshot;
  const goal = ids.indexOf(m.revealed?.goal);
  const predictions = [];
  const phaseBySeq = [];
  let phase = 'unknown';
  let postEnd = 0;
  const journal = J.restore(m, events);
  const pnl = P.summary(s, null, journal.accounting, m.revealed);
  const group = s.players.map((p) => p.name).join('|');
  const difficulty = s.context?.botDifficulty || 'Unknown';
  for (const e of events) {
    if (['round_start', 'checkpoint'].includes(e.kind)) phase = e.snapshot.status;
    if (['state', 'clock'].includes(e.kind)) phase = e.status;
    if (e.kind === 'prediction') {
      if (phase !== 'live') {
        postEnd++;
        continue;
      }
      if (goal >= 0) {
        const p = { ...e, goal, roundId: m.id, difficulty, group };
        predictions.push(p);
        predictionRows.push(p);
      }
    }
  }
  const fillPredictions = new Map(
    events.filter((e) => e.kind === 'fill_prediction').map((e) => [e.key, e]),
  );
  for (const e of J.scoredFillOutcomes(events)) {
    const pred = fillPredictions.get(e.key);
    if (pred)
      fillRecords.push({
        ...e,
        suit: pred.suit,
        side: pred.side,
        price: pred.price,
        roundId: m.id,
        difficulty,
        group,
        test: testIds.has(m.id),
      });
  }
  const weights = [0, 0.1, 0.35, 0.55, 0.75, 1];
  const scores = {};
  for (const w of weights) {
    const values = predictions.map((p) => {
      const probs = p.baseline.map((v, i) => (1 - w) * v + w * p.behavior[i]);
      return { brier: brier(probs, goal), loss: loss(probs, goal) };
    });
    scores[w] = {
      brier: mean(values.map((v) => v.brier)),
      logLoss: mean(values.map((v) => v.loss)),
    };
  }
  const last = predictions.at(-1);
  const top = (p) => p.indexOf(Math.max(...p));
  reports.push({
    id: m.id,
    at: events[0].at,
    round: s.round,
    group,
    difficulty,
    goal: m.revealed?.goal || null,
    goalSource: m.revealed?.source || null,
    test: testIds.has(m.id),
    predictions: predictions.length,
    postEndExcluded: postEnd,
    scores,
    pnl: pnl.actualPnl,
    netTrading: pnl.netCash,
    spent: pnl.spent,
    received: pnl.received,
    settlement: pnl.actualPayout,
    trades: s.trades.length,
    ownTrades: pnl.bought + pnl.sold,
    finalTopCorrect: last ? top(last.probabilities) === goal : null,
    finalGoalProbability: last?.probabilities[goal],
    baselineFinalGoalProbability: last?.baseline[goal],
    seqGaps: events.slice(1).reduce((n, e, i) => n + (e.seq - events[i].seq - 1), 0),
    coverage: events.filter((e) => e.kind === 'coverage').length,
  });
}
const labeled = reports.filter((r) => r.goal && !r.test);
const latestGroup = labeled.at(-1).group;
const holdout = labeled.filter((r) => r.group === latestGroup);
const train = labeled.filter((r) => r.group !== latestGroup);
const aggregate = (rr) => ({
  rounds: rr.length,
  weights: Object.fromEntries(
    [0, 0.1, 0.35, 0.55, 0.75, 1].map((w) => [
      w,
      {
        brier: mean(rr.map((r) => r.scores[w].brier)),
        logLoss: mean(rr.map((r) => r.scores[w].logLoss)),
      },
    ]),
  ),
  finalTopAccuracy: mean(rr.map((r) => Number(r.finalTopCorrect))),
  pnl: rr.reduce((v, r) => v + (r.pnl || 0), 0),
});
const validFills = fillRecords.filter((e) => !e.censored && !e.test);
const fillSummary = (ff) => ({
  opportunities: ff.length,
  observedFills: ff.filter((e) => e.filled).length,
  meanPredicted: mean(ff.map((e) => e.pFill)),
  actualFrequency: mean(ff.map((e) => +e.filled)),
  brier: mean(ff.map((e) => (e.pFill - (e.filled ? 1 : 0)) ** 2)),
  meanObservedSeconds: mean(ff.map((e) => e.observedSeconds)),
});
const bins = [
  [0, 0.02],
  [0.02, 0.05],
  [0.05, 0.1],
  [0.1, 0.2],
  [0.2, 0.4],
  [0.4, 1.001],
].map(([lo, hi]) => ({
  lo,
  hi,
  ...fillSummary(validFills.filter((e) => e.pFill >= lo && e.pFill < hi)),
}));
const summary = {
  recordedRounds: reports.length,
  labeledRounds: labeled.length,
  testRounds: reports.filter((r) => r.test).length,
  missingGoals: reports.filter((r) => !r.goal).map((r) => ({ id: r.id, round: r.round, at: r.at })),
  all: aggregate(labeled),
  training: aggregate(train),
  holdout: aggregate(holdout),
  byDifficulty: Object.fromEntries(
    [...new Set(labeled.map((r) => r.difficulty))].map((d) => [
      d,
      aggregate(labeled.filter((r) => r.difficulty === d)),
    ]),
  ),
  fills: {
    ...fillSummary(validFills),
    censored: fillRecords.filter((e) => e.censored).length,
    recoveredKnownFills: fillRecords.filter((e) => e.legacyRecovered).length,
    bins,
    bySide: Object.fromEntries(
      ['bid', 'ask'].map((side) => [side, fillSummary(validFills.filter((e) => e.side === side))]),
    ),
    byDifficulty: Object.fromEntries(
      [...new Set(validFills.map((e) => e.difficulty))].map((d) => [
        d,
        fillSummary(validFills.filter((e) => e.difficulty === d)),
      ]),
    ),
  },
  postEndPredictionsExcluded: reports.reduce((v, r) => v + r.postEndExcluded, 0),
  reports,
};
fs.writeFileSync(
  'outputs/model-audit-2026-10-27/audit.json',
  JSON.stringify(summary, null, 2) + '\n',
);
fs.writeFileSync('outputs/model-audit-2026-10-27/fill-outcomes.json', JSON.stringify(fillRecords));
fs.writeFileSync(
  'outputs/model-audit-2026-10-27/live-predictions.json',
  JSON.stringify(predictionRows),
);
console.log(JSON.stringify({ ...summary, reports: undefined }, null, 2));
