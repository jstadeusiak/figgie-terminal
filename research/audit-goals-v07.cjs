/* Offline audit: original pre-reveal information only; all comparisons are retrospective. */
const fs = require('fs');
const path = require('path');
const B = require('../extension/belief-v0.6.js');
const J = require('../extension/journal.js');
const input = process.argv[2] || 'outputs/trading-review-2026-10-27/recordings-combined.ndjson';
const outDir = path.resolve('outputs/model-review-v07');
fs.mkdirSync(outDir, { recursive: true });
const rows = fs.readFileSync(input, 'utf8').trim().split('\n').map(JSON.parse);
const IDS = ['s', 'c', 'd', 'h'];
const exclude = 'round-1793144490477-e7c5a184';
const byRound = new Map();
for (const e of rows)
  if (e.roundId) {
    if (!byRound.has(e.roundId)) byRound.set(e.roundId, []);
    byRound.get(e.roundId).push(e);
  }
const metas = rows
  .filter((m) => m.kind === 'round_metadata' && m.revealed?.goal && m.id !== exclude)
  .sort((a, b) => (byRound.get(a.id)?.[0]?.at || 0) - (byRound.get(b.id)?.[0]?.at || 0));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const metric = (p, g) => ({
  brier: sum(p.map((v, i) => (v - Number(i === g)) ** 2)),
  logLoss: -Math.log(Math.max(1e-9, p[g])),
  goalProbability: p[g],
  correct: IDS.indexOf(IDS[p.indexOf(Math.max(...p))]) === g,
  topProbability: Math.max(...p),
});
if (process.argv.includes('--asks')) {
  const vm = require('vm');
  const { createRequire } = require('module');
  const filename = path.resolve('extension/belief-v0.6.js');
  const source = fs.readFileSync(filename, 'utf8');
  const modified = source.replace(
    ' if(hand.some((v,s)=>v<minimum[0][s]))',
    ' if(snapshot.askMinimum)for(let p=1;p<n;p++)for(let s=0;s<4;s++)minimum[p][s]=Math.max(minimum[p][s],snapshot.askMinimum[p][s]);\n if(hand.some((v,s)=>v<minimum[0][s]))',
  );
  const context = { module: { exports: {} }, require: createRequire(filename), performance };
  context.globalThis = context;
  vm.runInNewContext(modified, context, { filename });
  const Hard = context.module.exports;
  const existing = JSON.parse(fs.readFileSync(path.join(outDir, 'goal-checkpoints.json'), 'utf8'));
  const ref = new Map(existing.rounds.map((r) => [r.id, r]));
  let checks = [];
  for (const m of metas) {
    const es = byRound.get(m.id).sort((a, b) => a.seq - b.seq);
    const live = J.livePredictions(es);
    const g = IDS.indexOf(m.revealed.goal);
    const engine = new Hard.BeliefEngine({ skipPricing: true });
    const points = [];
    for (const e of live) {
      const prefix = es.filter((v) => v.seq < e.seq);
      const snapshot = J.replay(prefix);
      const prior = prefix.findLast((v) => v.kind === 'learning_prior')?.learning || {};
      const journal = J.restore({ ...m, snapshot, revealed: null }, prefix);
      const minimum = snapshot.players.map(() => [0, 0, 0, 0]);
      let asks = 0;
      for (const q of journal.evidence) {
        if (q.kind !== 'quote' || q.direction !== 'sell' || q.recovered || !q.net) continue;
        const actor = snapshot.players.findIndex((p) => p.name === q.actor);
        const s = IDS.indexOf(q.suit);
        if (actor < 1 || s < 0 || !Number.isInteger(q.net[actor]?.[s])) continue;
        minimum[actor][s] = Math.max(minimum[actor][s], 1 - q.net[actor][s]);
        asks++;
      }
      const original = ref.get(m.id)?.checkpoints.find((p) => p.seq === e.seq);
      if (!original) continue;
      let model;
      let error;
      try {
        model = engine.infer({ ...snapshot, askMinimum: minimum }, journal.evidence, prior);
      } catch (err) {
        error = err.message;
      }
      points.push({
        seq: e.seq,
        tradeCount: e.tradeCount,
        asks,
        minimum,
        error,
        p: model?.scoringProbabilities,
        current: original.scores.current,
        hard: model ? metric(model.scoringProbabilities, g) : null,
        excludesGoal: model ? model.scoringProbabilities[g] === 0 : false,
      });
    }
    checks.push({
      id: m.id,
      difficulty: m.snapshot.context?.botDifficulty,
      goal: m.revealed.goal,
      points,
    });
    console.log('ASKS', checks.length, metas.length, m.id);
  }
  const agg = (rs) => ({
    rounds: rs.length,
    failures: sum(rs.map((r) => r.points.filter((p) => p.error).length)),
    excludedGoal: sum(rs.map((r) => r.points.filter((p) => p.excludesGoal).length)),
    currentBrier: mean(
      rs.map((r) => mean(r.points.filter((p) => p.hard).map((p) => p.current.brier))),
    ),
    hardBrier: mean(rs.map((r) => mean(r.points.filter((p) => p.hard).map((p) => p.hard.brier)))),
    currentLogloss: mean(
      rs.map((r) => mean(r.points.filter((p) => p.hard).map((p) => p.current.logLoss))),
    ),
    hardLogloss: mean(
      rs.map((r) => mean(r.points.filter((p) => p.hard).map((p) => p.hard.logLoss))),
    ),
  });
  const output = {
    note: 'Exploratory all-native-ask ownership constraints; excludes recovered first observations; no production changes. Requires feed semantics and observed hand contradiction validation before use. Failed constraints are reported, not silently treated as wins.',
    all: agg(checks),
    earlier: agg(checks.slice(0, -9)),
    latest9: agg(checks.slice(-9)),
    newest: agg(checks.slice(-1)),
    rounds: checks,
  };
  fs.writeFileSync(path.join(outDir, 'goal-asks-check.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ ...output, rounds: undefined }, null, 2));
  return;
}
const variants = ['current', 'noQuotes', 'noConsent'];
const report = [];
let count = 0;
for (const m of metas) {
  const es = byRound.get(m.id).sort((a, b) => a.seq - b.seq);
  const live = J.livePredictions(es);
  if (!live.length) continue;
  const g = IDS.indexOf(m.revealed.goal);
  const difficulty = m.snapshot.context?.botDifficulty || 'unknown';
  const engines = Object.fromEntries(
    variants.map((v) => [
      v,
      new B.BeliefEngine({
        skipPricing: true,
        ...(v === 'current'
          ? {}
          : {
              signalPolicy: {
                temperature: difficulty === 'Medium' ? 0.6 : 0.3,
                quote: v === 'noQuotes' ? 0 : 0.2,
                consent: v === 'noConsent' ? 0 : 0.12,
                cap: 5,
              },
            }),
      }),
    ]),
  );
  const rr = {
    id: m.id,
    at: es[0].at,
    difficulty,
    players: m.snapshot.players.length,
    goal: m.revealed.goal,
    startingHand: m.snapshot.startingHand,
    versions: [...new Set(live.map((p) => p.modelVersion))],
    checkpoints: [],
  };
  for (let n = 0; n < live.length; n++) {
    const e = live[n];
    const prefix = es.filter((v) => v.seq < e.seq);
    const snapshot = J.replay(prefix);
    if (!snapshot || snapshot.status !== 'live') continue;
    const prior = prefix.findLast((v) => v.kind === 'learning_prior')?.learning || {};
    const journal = J.restore({ ...m, snapshot, revealed: null }, prefix);
    const cp = {
      seq: e.seq,
      at: e.at,
      tradeCount: snapshot.trades.length,
      timer: snapshot.timer,
      phase: n < live.length / 3 ? 'early' : n < (2 * live.length) / 3 ? 'middle' : 'late',
      p: { saved: e.probabilities, cards: e.baseline },
      scores: { saved: metric(e.probabilities, g), cards: metric(e.baseline, g) },
    };
    for (const v of variants) {
      const model = engines[v].infer(snapshot, journal.evidence, prior);
      const p = model.scoringProbabilities;
      cp.p[v] = p;
      cp.scores[v] = { ...metric(p, g), ms: model.computeMs };
      if (v === 'current')
        cp.evidence = {
          observations: model.behavior.observations,
          blend: model.behavior.blend,
          baseline: model.baseline.probabilities,
          raw: model.behavior.probabilities,
        };
    }
    rr.checkpoints.push(cp);
  }
  report.push(rr);
  console.log('Scored', ++count, metas.length, m.id, rr.checkpoints.length);
  fs.writeFileSync(
    path.join(outDir, 'goal-checkpoints.json'),
    JSON.stringify({ input, variants, rounds: report }, null, 2),
  );
}
const methods = ['saved', 'cards', ...variants];
function aggregate(rr, phase) {
  const usable = rr
    .map((r) => ({ ...r, checkpoints: r.checkpoints.filter((p) => !phase || p.phase === phase) }))
    .filter((r) => r.checkpoints.length);
  return {
    rounds: usable.length,
    checkpoints: sum(usable.map((r) => r.checkpoints.length)),
    methods: Object.fromEntries(
      methods.map((v) => [
        v,
        {
          brier: mean(usable.map((r) => mean(r.checkpoints.map((p) => p.scores[v].brier)))),
          logLoss: mean(usable.map((r) => mean(r.checkpoints.map((p) => p.scores[v].logLoss)))),
          finalAccuracy: mean(usable.map((r) => Number(r.checkpoints.at(-1).scores[v].correct))),
          meanGoalP: mean(
            usable.map((r) => mean(r.checkpoints.map((p) => p.scores[v].goalProbability))),
          ),
        },
      ]),
    ),
  };
}
function calibration(rr, method) {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: i / 10,
    to: (i + 1) / 10,
    weight: 0,
    predicted: 0,
    actual: 0,
    observations: 0,
    roundIds: new Set(),
  }));
  for (const r of rr) {
    const g = IDS.indexOf(r.goal);
    const w = 1 / r.checkpoints.length;
    for (const cp of r.checkpoints)
      cp.p[method].forEach((p, i) => {
        const b = bins[Math.min(9, Math.floor(p * 10))];
        b.weight += w;
        b.predicted += w * p;
        b.actual += w * Number(i === g);
        b.observations++;
        b.roundIds.add(r.id);
      });
  }
  return bins.map((b) => ({
    ...b,
    roundIds: undefined,
    rounds: b.roundIds.size,
    predicted: b.weight ? b.predicted / b.weight : null,
    actual: b.weight ? b.actual / b.weight : null,
  }));
}
const heldout = report.slice(-Math.max(3, Math.ceil(report.length * 0.25)));
const train = report.slice(0, report.length - heldout.length);
const result = {
  input,
  notes: [
    'All candidate replay comparisons are retrospective. Old rounds were used in previous tuning; the chronological split is a sensitivity check, not an untouched prospective trial.',
    'Each round has equal weight; checkpoints are correlated and not independent games. Early/middle/late are thirds of that round’s recorded live checkpoints, not exact elapsed-time bins.',
    'Goal labels are used only for scoring; replay consumes events strictly before each live prediction and its recorded learning prior.',
  ],
  all: aggregate(report),
  chronologicalEarlier: aggregate(train),
  chronologicalLatest: aggregate(heldout),
  heldoutIds: heldout.map((r) => r.id),
  byDifficulty: Object.fromEntries(
    [...new Set(report.map((r) => r.difficulty))].map((g) => [
      g,
      aggregate(report.filter((r) => r.difficulty === g)),
    ]),
  ),
  byPhase: Object.fromEntries(['early', 'middle', 'late'].map((p) => [p, aggregate(report, p)])),
  calibration: Object.fromEntries(
    ['saved', 'cards', 'current'].map((v) => [v, calibration(report, v)]),
  ),
  finalMisses: report
    .filter((r) => !r.checkpoints.at(-1).scores.current.correct)
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      hand: r.startingHand,
      timer: r.checkpoints.at(-1).timer,
      p: r.checkpoints.at(-1).p,
      deltaBrier: mean(r.checkpoints.map((p) => p.scores.current.brier - p.scores.cards.brier)),
    })),
  rounds: report.map((r) => ({
    id: r.id,
    goal: r.goal,
    difficulty: r.difficulty,
    summary: aggregate([r]),
    final: r.checkpoints.at(-1),
  })),
};
fs.writeFileSync(path.join(outDir, 'goal-summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, calibration: undefined, rounds: undefined }, null, 2));
