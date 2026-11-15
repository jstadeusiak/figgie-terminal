/* Chronological new-round goal audit. Holdout mode runs only a locked candidate. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
const dir = 'outputs/model-review-v08';
const IDS = ['s', 'c', 'd', 'h'];
const mode = process.argv[2] || 'train';
const sourceFile = 'research/goal-source-v08.cjs';
const sourcePath = path.resolve('extension/belief-v0.7.js');
if (!fs.existsSync(sourceFile)) {
  const fit = require('../extension/model-fit.js');
  const src = fs
    .readFileSync(sourcePath, 'utf8')
    .replace(/const MODEL_FITS=.*?;\n/, `const MODEL_FITS=${JSON.stringify(fit)};\n`);
  fs.writeFileSync(sourceFile, src);
}
const source = fs.readFileSync(sourceFile, 'utf8');
const sourceSha = crypto.createHash('sha256').update(source).digest('hex');
function load(changes = []) {
  let src = source;
  for (const [a, b] of changes) {
    if (!src.includes(a)) throw Error('Missing transformation ' + a);
    src = src.replace(a, b);
  }
  const ctx = { module: { exports: {} }, require: createRequire(sourcePath), performance };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx, { filename: sourcePath });
  return ctx.module.exports;
}
const current = load();
const recent = load([
  ['first=sorted.slice(0,8),recent=sorted.slice(-16)', 'first=[],recent=sorted.slice(-24)'],
]);
const v6 = require('../extension/belief-v0.6.js');
const J = require('../extension/journal.js');
const data = fs
  .readFileSync(dir + '/recordings-combined.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const newIds = new Set(JSON.parse(fs.readFileSync(dir + '/sources.json', 'utf8')).newRoundIds);
const by = new Map();
for (const e of data)
  if (e.roundId) {
    if (!by.has(e.roundId)) by.set(e.roundId, []);
    by.get(e.roundId).push(e);
  }
const all = data
  .filter(
    (m) =>
      m.kind === 'round_metadata' && m.revealed?.goal && m.id !== 'round-1793144490477-e7c5a184',
  )
  .sort((a, b) => by.get(a.id)[0].at - by.get(b.id)[0].at);
const newRounds = all.filter((m) => newIds.has(m.id));
const training = newRounds.slice(0, 14);
const holdout = newRounds.slice(14);
const oldRounds = all.filter((m) => !newIds.has(m.id));
const selection =
  mode === 'train' ? null : JSON.parse(fs.readFileSync(dir + '/goal-selection.json', 'utf8'));
const candidateNames =
  mode === 'train'
    ? ['recent24', 'cap8']
    : [selection.candidate].filter((x) => x && x !== 'current');
const variants = ['current', 'v6', ...candidateNames];
const metas =
  mode === 'train' ? training : mode === 'validate' ? holdout : mode === 'old' ? oldRounds : [];
if (!metas.length) throw Error('No selected rounds for ' + mode);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const metric = (p, g) => ({
  brier: sum(p.map((v, i) => (v - Number(i === g)) ** 2)),
  logLoss: -Math.log(Math.max(1e-9, p[g])),
  goalP: p[g],
  top: p.indexOf(Math.max(...p)),
  maxP: Math.max(...p),
});
let results = [];
let maxSavedError = 0;
for (const m of metas) {
  const es = by.get(m.id).sort((a, b) => a.seq - b.seq);
  const predictions = J.livePredictions(es);
  const g = IDS.indexOf(m.revealed.goal);
  const engines = {
    current: new current.BeliefEngine({ skipPricing: true }),
    v6: new v6.BeliefEngine({ skipPricing: true }),
    recent24: new (m.snapshot.players.length === 4 &&
    m.snapshot.context?.botDifficulty === 'Medium' &&
    m.snapshot.players.every((p) => p.name === m.snapshot.self || /^Bot-/.test(p.name))
      ? recent
      : current
    ).BeliefEngine({ skipPricing: true }),
    cap8: new current.BeliefEngine({
      skipPricing: true,
      signalPolicy: { temperature: 0.6, quote: 0.2, consent: 0.12, cap: 8 },
    }),
  };
  const points = [];
  for (const e of predictions) {
    const prefix = es.filter((x) => x.seq < e.seq);
    const snapshot = J.replay(prefix);
    const prior = prefix.findLast((x) => x.kind === 'learning_prior')?.learning || {};
    const journal = J.restore({ ...m, snapshot, revealed: null }, prefix);
    const timer = String(snapshot.timer);
    const parts = timer.split(':').map(Number);
    const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : null;
    const phase =
      seconds === null ? 'unknown' : seconds > 160 ? 'early' : seconds > 80 ? 'middle' : 'late';
    const point = {
      seq: e.seq,
      at: e.at,
      timer,
      phase,
      tradeCount: e.tradeCount,
      p: { saved: e.probabilities, cards: e.baseline },
      scores: { saved: metric(e.probabilities, g), cards: metric(e.baseline, g) },
    };
    for (const v of variants) {
      const model = engines[v].infer(snapshot, journal.evidence, prior);
      const p = model.scoringProbabilities;
      point.p[v] = p;
      point.scores[v] = metric(p, g);
      if (v === 'current') {
        point.raw = model.behavior.probabilities;
        point.qualifiedAsks = model.inventoryEvidence.qualifiedAsks;
        point.fallback = model.inventoryEvidence.fallback;
        point.observations = model.behavior.observations;
        point.blend = model.behavior.blend;
        point.fullEvidence = journal.evidence.length;
        maxSavedError = Math.max(
          maxSavedError,
          ...p.map((x, i) => Math.abs(x - e.probabilities[i])),
        );
      }
    }
    points.push(point);
  }
  results.push({
    id: m.id,
    at: es[0].at,
    goal: m.revealed.goal,
    hand: m.snapshot.startingHand,
    difficulty: m.snapshot.context?.botDifficulty,
    versions: [...new Set(predictions.map((p) => p.modelVersion))],
    points,
  });
  console.log(mode, results.length, metas.length, m.id, points.length);
}
const methods = ['saved', 'cards', ...variants];
function aggregate(rs, phase) {
  const selected = rs
    .map((r) => ({ ...r, points: r.points.filter((p) => !phase || p.phase === phase) }))
    .filter((r) => r.points.length);
  return {
    rounds: selected.length,
    checkpoints: sum(selected.map((r) => r.points.length)),
    methods: Object.fromEntries(
      methods.map((v) => [
        v,
        {
          brier: mean(selected.map((r) => mean(r.points.map((p) => p.scores[v].brier)))),
          logLoss: mean(selected.map((r) => mean(r.points.map((p) => p.scores[v].logLoss)))),
          finalCorrect: sum(
            selected.map((r) => Number(r.points.at(-1).scores[v].top === IDS.indexOf(r.goal))),
          ),
          meanActualGoalP: mean(selected.map((r) => mean(r.points.map((p) => p.scores[v].goalP)))),
        },
      ]),
    ),
  };
}
const changes = Object.fromEntries(
  candidateNames.map((v) => [
    v,
    {
      improved: results.filter(
        (r) => mean(r.points.map((p) => p.scores[v].brier - p.scores.current.brier)) < 0,
      ).length,
      worsened: results.filter(
        (r) => mean(r.points.map((p) => p.scores[v].brier - p.scores.current.brier)) > 0,
      ).length,
      flips: results
        .filter((r) => r.points.at(-1).scores[v].top !== r.points.at(-1).scores.current.top)
        .map((r) => ({
          id: r.id,
          goal: r.goal,
          from: IDS[r.points.at(-1).scores.current.top],
          to: IDS[r.points.at(-1).scores[v].top],
        })),
    },
  ]),
);
const output = {
  mode,
  sourceSha,
  note: 'Original pre-reveal prefixes and recorded priors, equal round weighting. New14 training/new6 chronological holdout; holdout only tested after candidate selection file exists.',
  trainingIds: training.map((m) => m.id),
  holdoutIds: holdout.map((m) => m.id),
  selectedCandidate: selection || null,
  maxSavedError,
  all: aggregate(results),
  byPhase: Object.fromEntries(['early', 'middle', 'late'].map((p) => [p, aggregate(results, p)])),
  candidateChanges: changes,
  rounds: results,
};
fs.writeFileSync(dir + '/goal-' + mode + '.json', JSON.stringify(output, null, 2));
console.log(
  JSON.stringify(
    { ...output, rounds: undefined, trainingIds: undefined, holdoutIds: undefined },
    null,
    2,
  ),
);
