/* Offline coaching audit. Keeps one complete export per recording ID; never
   treats later revealed outcomes as information available at decision time. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const J = require('../extension/journal.js');
const P = require('../extension/pnl.js');
const B = require('../extension/belief.js');
const [outputDirectory, ...inputs] = process.argv.slice(2);
if (!outputDirectory || !inputs.length)
  throw Error(
    'Usage: node research/review-trading.cjs OUTPUT_DIRECTORY RECORDING.ndjson [RECORDING.ndjson ...]',
  );
const out = path.resolve(outputDirectory);
const files = inputs.map((file) => path.resolve(file));
fs.mkdirSync(out, { recursive: true });
const selected = new Map();
const sources = [];
for (const file of files) {
  const data = fs.readFileSync(file, 'utf8');
  const rows = data.trim().split('\n').map(JSON.parse);
  const header = rows.find((e) => e.kind === 'recording_export');
  const metas = rows.filter((e) => e.kind === 'round_metadata');
  const exportedAt = header?.exportedAt || 0;
  sources.push({
    file,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    bytes: Buffer.byteLength(data),
    rounds: metas.length,
    exportedAt,
  });
  for (const m of metas) {
    const events = rows.filter((e) => e.roundId === m.id).sort((a, b) => a.seq - b.seq);
    const candidate = { m, events, file, exportedAt };
    const old = selected.get(m.id);
    if (
      !old ||
      m.updatedAt > old.m.updatedAt ||
      (m.updatedAt === old.m.updatedAt && exportedAt > old.exportedAt)
    )
      selected.set(m.id, candidate);
  }
}
const rounds = [...selected.values()].sort((a, b) => a.events[0].at - b.events[0].at);
const ids = ['s', 'c', 'd', 'h'];
const test = 'round-1793144490477-e7c5a184';
fs.writeFileSync(
  out + '/recordings-combined.ndjson',
  [
    JSON.stringify({
      kind: 'analysis_export',
      schema: 1,
      rounds: rounds.length,
      deduplication:
        'Newest metadata, then export time, per round ID; complete event sequences retained from chosen export',
    }),
    ...rounds.flatMap((r) => [JSON.stringify(r.m), ...r.events.map((e) => JSON.stringify(e))]),
  ].join('\n') + '\n',
);
fs.writeFileSync(
  out + '/sources.json',
  JSON.stringify(
    {
      sources,
      selected: rounds.map((r) => ({
        id: r.m.id,
        file: r.file,
        updatedAt: r.m.updatedAt,
        events: r.events.length,
      })),
    },
    null,
    2,
  ),
);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
const reports = rounds.map(({ m, events, file }) => {
  const s = m.snapshot;
  const j = J.restore(m, events);
  const pnl = P.summary(s, null, j.accounting, m.revealed);
  const ps = J.livePredictions(events);
  const initial = B.privateBelief(s.startingHand).goals;
  const rank = ids.map((id, i) => ({ id, p: initial[i] })).sort((a, b) => b.p - a.p);
  const goal = m.revealed?.goal;
  const g = ids.indexOf(goal);
  const last = ps.at(-1);
  const ownTrades = s.trades
    .map((t, index) => ({ ...t, index }))
    .filter((t) => t.b === s.self || t.s === s.self)
    .map((t) => {
      const fill = events.find((e) => e.kind === 'fill' && e.index === t.index);
      const prediction = fill ? ps.filter((e) => e.seq < fill.seq).at(-1) : null;
      return {
        ...t,
        side: t.b === s.self ? 'buy' : 'sell',
        at: fill?.at,
        classification: fill?.classification,
        goalProbabilityBefore: prediction?.probabilities[ids.indexOf(t.suit)],
        predictionAgeMs: prediction ? fill.at - prediction.at : null,
      };
    });
  const commands = events.filter((e) => e.kind === 'command_attempt' && e.decision);
  const neg = commands.filter(
    (e) =>
      Number.isFinite(e.decision.conditionalGain ?? e.decision.estimatedGain) &&
      (e.decision.conditionalGain ?? e.decision.estimatedGain) < 0,
  );
  const scenario = last?.goalScenarios?.find((v) => v.suit === goal);
  const cases = last?.goalScenarios;
  let stock = [...s.startingHand];
  let cash = 0;
  let maxSpend = 0;
  let minBaseCase = Infinity;
  for (const t of s.trades) {
    const i = ids.indexOf(t.suit);
    if (t.b === s.self) {
      stock[i]++;
      cash -= t.p;
    }
    if (t.s === s.self) {
      stock[i]--;
      cash += t.p;
    }
    maxSpend = Math.max(maxSpend, -cash);
    minBaseCase = Math.min(minBaseCase, cash - pnl.ante + 10 * Math.min(...stock));
  }
  return {
    id: m.id,
    round: s.round,
    at: events[0].at,
    time: new Date(events[0].at).toLocaleTimeString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
    }),
    source: file,
    status: s.status,
    test: m.id === test,
    difficulty: s.context?.botDifficulty,
    players: s.players.map((p) => p.name),
    startingHand: s.startingHand,
    endingHand: s.held,
    net: s.net,
    goal,
    initial,
    initialTop: rank[0],
    initialTop2: rank[0].p + rank[1].p,
    infoGroup:
      rank[0].p >= 0.6
        ? 'strong'
        : rank[0].p >= 0.45
          ? 'tilted'
          : rank[0].p <= 0.3
            ? 'flat'
            : 'moderate',
    pnl,
    ownTrades,
    decisionCount: commands.length,
    negativeDecisionCount: neg.length,
    initialGoalProbability: g >= 0 ? initial[g] : null,
    finalGoalProbability: g >= 0 ? last?.probabilities[g] : null,
    finalTop: last ? ids[last.probabilities.indexOf(Math.max(...last.probabilities))] : null,
    finalPredictedPnl: last?.roundPnl?.estimatedPnl,
    finalGoalScenario: scenario,
    finalPredictionTradeCount: last?.tradeCount,
    totalTrades: s.trades.length,
    finalPrediction: last
      ? {
          at: last.at,
          probabilities: last.probabilities,
          baseline: last.baseline,
          tradeCount: last.tradeCount,
          goalScenarios: cases,
        }
      : null,
    maxNetSpend: maxSpend,
    worstBasePnlDuring: minBaseCase,
    sequenceGaps: events
      .slice(1)
      .reduce((n, e, i) => n + Math.max(0, e.seq - events[i].seq - 1), 0),
    models: [...new Set(ps.map((p) => p.modelVersion))],
  };
});
const complete = reports.filter((r) => !r.test && r.pnl.actualPnl !== null);
const labeled = complete.filter((r) => r.goal);
const agg = (rs) => ({
  rounds: rs.length,
  pnl: sum(rs.map((r) => r.pnl.actualPnl)),
  mean: avg(rs.map((r) => r.pnl.actualPnl)),
  wins: rs.filter((r) => r.pnl.actualPnl > 0).length,
  losses: rs.filter((r) => r.pnl.actualPnl < 0).length,
  ownTrades: sum(rs.map((r) => r.ownTrades.length)),
  spent: sum(rs.map((r) => r.pnl.spent)),
  received: sum(rs.map((r) => r.pnl.received)),
  settlement: sum(rs.map((r) => r.pnl.actualPayout)),
  ante: sum(rs.map((r) => r.pnl.ante)),
  meanInitialTop: avg(rs.map((r) => r.initialTop.p)),
});
const summary = {
  recordingSegments: reports.length,
  excludedAgentTests: reports.filter((r) => r.test).length,
  incomplete: reports.filter((r) => !r.test && r.pnl.actualPnl === null).map((r) => r.id),
  unlabeled: complete.filter((r) => !r.goal).map((r) => r.id),
  all: agg(complete),
  old: agg(complete.filter((r) => r.at < 1793160000000)),
  latest: agg(complete.filter((r) => r.at >= 1793160000000)),
  lastSeven: agg(complete.slice(-7)),
  byInfo: Object.fromEntries(
    ['strong', 'tilted', 'moderate', 'flat'].map((g) => [
      g,
      agg(complete.filter((r) => r.infoGroup === g)),
    ]),
  ),
  byDifficulty: Object.fromEntries(
    ['Easy', 'Medium'].map((g) => [g, agg(complete.filter((r) => r.difficulty === g))]),
  ),
  zeroGoalAtEnd: agg(labeled.filter((r) => r.endingHand[ids.indexOf(r.goal)] === 0)),
  bonusErrors: labeled
    .filter((r) => r.finalPredictionTradeCount === r.totalTrades && r.finalGoalScenario)
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      estimatedPayout: r.finalGoalScenario.settlement,
      actualPayout: r.pnl.actualPayout,
      conditionalLeaderProbability: r.finalGoalScenario.leaderProbability,
      estimatedPnl: r.finalGoalScenario.pnl,
      actualPnl: r.pnl.actualPnl,
    })),
};
fs.writeFileSync(out + '/analysis.json', JSON.stringify({ summary, reports }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    complete.map((r) => ({
      id: r.id,
      time: r.time,
      info: r.infoGroup,
      hand: r.startingHand,
      top: r.initialTop,
      pnl: r.pnl.actualPnl,
      goal: r.goal,
      held: r.endingHand,
      netCash: r.pnl.netCash,
      spent: r.pnl.spent,
      received: r.pnl.received,
      settlement: r.pnl.actualPayout,
      bySuit: r.pnl.bySuit,
      finalTop: r.finalTop,
      finalGoalP: r.finalGoalProbability,
      negative: [r.negativeDecisionCount, r.decisionCount],
    })),
    null,
    2,
  ),
);
