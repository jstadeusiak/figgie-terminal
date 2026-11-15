#!/usr/bin/env node
'use strict';
// Offline, descriptive rating reconstruction. Never used by the live trading model.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const Registry = require(ROOT + '/tools/model-registry.cjs');
const Ratings = require(ROOT + '/extension/ratings.js');
const Journal = require(ROOT + '/extension/journal.js');
const Bonus = require(ROOT + '/extension/bonus-score.js');
const [sourceList, out] = process.argv.slice(2);
if (!sourceList || !out)
  throw Error('Usage: node research/rating-reverse-engineering.cjs INPUT_FILES.json OUTPUT.json');
const files = JSON.parse(fs.readFileSync(sourceList));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const dataset = Registry.readDataset(files);
const roundMap = new Map(dataset.rounds.map((r) => [r.id, r]));
const observations = new Map();
for (const file of files)
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.kind !== 'rating_observation') continue;
    const prior = observations.get(e.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(e))
      throw Error('Conflicting rating observation: ' + e.id);
    if (Ratings.validate(e)) observations.set(e.id, e);
  }
const obs = [...observations.values()].sort((a, b) => a.at - b.at);
const intervals = Ratings.intervals(
  obs,
  dataset.rounds.map((r) => r.metadata),
);
const startRows = new Map(obs.map((o) => [o.at, o]));
function exactOpeningPnl(round) {
  const m = round.metadata;
  const s = m.snapshot;
  const g = 'scdh'.indexOf(m.revealed?.goal);
  const audit = Bonus.auditRound({ ...m, events: round.events }, { includeLabels: true });
  const opening = audit.labels?.find((x) => x.tradeCount === 0);
  if (!opening)
    return {
      value: null,
      range: null,
      reason: audit.reason || 'No identifiable opening inventory checkpoint',
    };
  const values = opening.candidates.map((c) => {
    const k = opening.selfIndex;
    const max = Math.max(...c.counts);
    const ties = c.counts.filter((v) => v === max).length;
    return (
      10 * c.counts[k] + (c.counts[k] === max ? c.bonusPool / ties : 0) - 200 / s.players.length
    );
  });
  const low = Math.min(...values);
  const high = Math.max(...values);
  return {
    value: Math.abs(high - low) < 1e-8 ? low : null,
    range: [low, high],
    candidateColumns: values.length,
  };
}
function features(interval, round) {
  const m = round.metadata;
  const s = m.snapshot;
  const g = 'scdh'.indexOf(m.revealed?.goal);
  const opening = Journal.livePredictions(round.events).find((x) => x.tradeCount === 0);
  const hand = s.startingHand;
  const benchmark = exactOpeningPnl(round);
  const pnl = interval.round.profit;
  const initial = round.events.find((e) => e.kind === 'round_start')?.snapshot;
  if (
    !initial ||
    initial.trades.length !== 0 ||
    JSON.stringify(initial.startingHand) !== JSON.stringify(hand) ||
    JSON.stringify(initial.held) !== JSON.stringify(hand)
  )
    throw Error('Missing independently recorded pre-trade hand: ' + round.id);
  return {
    id: round.id,
    endedAt: m.accounting.endedAt,
    observedAt: interval.to,
    ratingBefore: interval.ratingBefore,
    ratingAfter: interval.ratingAfter,
    ratingDelta: interval.delta,
    lifetimeBefore: startRows.get(interval.from)?.stats?.lifetimeRounds ?? null,
    profit: pnl,
    goal: m.revealed.goal,
    startingHand: hand,
    startingGoal: hand[g],
    startingOpposite: hand[g ^ 1],
    startingGoalProbability: opening?.baseline?.[g] ?? null,
    openingConditionalPnl: opening?.goalScenarios?.[g]?.pnl ?? null,
    openingExpectedPnl: opening?.roundPnl?.estimatedPnl ?? null,
    openingPredictionVersion: opening?.modelVersion ?? null,
    actualDealPnl: benchmark.value,
    actualDealPnlRange: benchmark.range,
    overActualDeal: benchmark.value === null ? null : pnl - benchmark.value,
    overGoalCardEndowment: pnl - (10 * hand[g] - 200 / s.players.length),
    overOpeningConditional:
      opening?.goalScenarios?.[g]?.pnl == null ? null : pnl - opening.goalScenarios[g].pnl,
    difficulty: s.context?.botDifficulty ?? null,
    players: s.players.length,
    opponents: s.players.map((p) => p.name).filter((n) => n !== s.self),
    officialProfitRank: 1 + Object.values(m.revealed.profits || {}).filter((x) => x > pnl).length,
    practice: Journal.isPractice(m, round.events),
    complete: round.events.every((e, i) => e.seq === i + 1),
    attribution: interval.reason,
  };
}
const officialPairs = intervals
  .filter((x) => x.attribution === 'single-round-candidate')
  .map((i) => features(i, roundMap.get(i.roundId)));
const pairs = officialPairs.filter(
  (p) => !p.practice && p.complete && p.players === 4 && p.difficulty === 'Medium',
);
const bankOnly = [];
for (const i of intervals.filter(
  (i) => i.roundCount === 1 && i.attribution !== 'single-round-candidate',
)) {
  const possible = dataset.rounds.filter(
    (r) =>
      r.metadata.self === i.self &&
      r.metadata.snapshot.status === 'ended' &&
      r.metadata.accounting?.endedAt > i.from &&
      r.metadata.accounting.endedAt <= i.to,
  );
  if (possible.length !== 1) continue;
  const r = possible[0];
  const p = r.events.findLast((e) => e.kind === 'round_pnl')?.pnl;
  if (
    !p ||
    p.source !== 'Settled bank − pre-ante opening bank' ||
    p.settlementPending ||
    !Number.isFinite(p.actualPnl) ||
    Math.abs(p.actualPnl - i.statDeltas.lifetimeProfit) > 1e-8
  )
    continue;
  bankOnly.push({
    id: r.id,
    observedAt: i.to,
    ratingBefore: i.ratingBefore,
    ratingAfter: i.ratingAfter,
    ratingDelta: i.delta,
    profit: p.actualPnl,
    source: p.source,
    officialGoal: r.metadata.revealed?.goal ?? null,
    startingHand: r.metadata.snapshot.startingHand,
    endingHand: r.metadata.snapshot.held,
    practice: Journal.isPractice(r.metadata, r.events),
    reason:
      'One ended recording, count +1, stable settled bank and lifetime earnings corroborate profit; no official goal recorded. Excluded hand-adjusted fitting.',
  });
}
const models = [
  { id: 'mean-delta', features: [] },
  { id: 'profit', features: ['profit'] },
  { id: 'goal-endowment-adjusted', features: ['overGoalCardEndowment'] },
  { id: 'profit-and-starting-goal', features: ['profit', 'startingGoal'] },
  { id: 'profit-goal-and-opposite', features: ['profit', 'startingGoal', 'startingOpposite'] },
  { id: 'profit-and-rating', features: ['profit', 'ratingBefore'] },
  { id: 'profit-goal-and-rating', features: ['profit', 'startingGoal', 'ratingBefore'] },
  { id: 'actual-deal-adjusted', features: ['overActualDeal'] },
  { id: 'model-conditional-deal-adjusted', features: ['overOpeningConditional'] },
  { id: 'profit-and-opening-model-EV', features: ['profit', 'openingExpectedPnl'] },
];
function solve(A, b) {
  const a = A.map((r, i) => r.concat(b[i]));
  for (let k = 0; k < b.length; k++) {
    let pivot = k;
    for (let i = k + 1; i < b.length; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    if (Math.abs(a[pivot][k]) < 1e-10) return null;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    let d = a[k][k];
    for (let j = k; j <= b.length; j++) a[k][j] /= d;
    for (let i = 0; i < b.length; i++)
      if (i !== k) {
        d = a[i][k];
        for (let j = k; j <= b.length; j++) a[i][j] -= d * a[k][j];
      }
  }
  return a.map((r) => r.at(-1));
}
function fit(rows, names) {
  if (rows.length < names.length + 2) return null;
  const mus = names.map((k) => mean(rows.map((r) => r[k])));
  const sd = names.map((k, j) => Math.sqrt(mean(rows.map((r) => (r[k] - mus[j]) ** 2))));
  if (sd.some((s) => s < 1e-8)) return null;
  const xs = rows.map((r) => [1, ...names.map((k, j) => (r[k] - mus[j]) / sd[j])]);
  const p = names.length + 1;
  const A = Array.from({ length: p }, () => Array(p).fill(0));
  const b = Array(p).fill(0);
  for (let i = 0; i < rows.length; i++)
    for (let j = 0; j < p; j++) {
      b[j] += xs[i][j] * rows[i].ratingDelta;
      for (let k = 0; k < p; k++) A[j][k] += xs[i][j] * xs[i][k];
    }
  const z = solve(A, b);
  if (!z) return null;
  const coeff = z.slice(1).map((c, j) => c / sd[j]);
  const intercept = z[0] - sum(coeff.map((c, j) => c * mus[j]));
  return {
    n: rows.length,
    intercept,
    coefficients: Object.fromEntries(names.map((k, j) => [k, coeff[j]])),
    predict: (r) => intercept + sum(names.map((k, j) => coeff[j] * r[k])),
  };
}
const plain = (f) => (f ? { n: f.n, intercept: f.intercept, coefficients: f.coefficients } : null);
function metrics(rows) {
  if (!rows.length) return null;
  let errors = rows.map((r) => r.predicted - r.actual);
  return {
    n: rows.length,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((x) => x * x))),
    bias: mean(errors),
    signCorrect: rows.filter((r) => Math.sign(r.predicted) === Math.sign(r.actual)).length,
  };
}
const boundary = Date.parse('2026-10-29T23:25:05Z');
const results = models.map((m) => {
  const eligible = pairs.filter((r) => m.features.every((k) => Number.isFinite(r[k])));
  const train = eligible.filter((r) => r.observedAt < boundary);
  const test = eligible.filter((r) => r.observedAt >= boundary);
  const f = fit(train, m.features);
  const testPredictions = f
    ? test.map((r) => ({ id: r.id, actual: r.ratingDelta, predicted: f.predict(r) }))
    : [];
  const full = fit(eligible, m.features);
  const loo = [];
  const rolling = [];
  for (let i = 0; i < eligible.length; i++) {
    let ff = fit(
      eligible.filter((_, j) => j !== i),
      m.features,
    );
    if (ff)
      loo.push({
        id: eligible[i].id,
        actual: eligible[i].ratingDelta,
        predicted: ff.predict(eligible[i]),
      });
    if (i >= 12) {
      ff = fit(eligible.slice(0, i), m.features);
      if (ff)
        rolling.push({
          id: eligible[i].id,
          actual: eligible[i].ratingDelta,
          predicted: ff.predict(eligible[i]),
        });
    }
  }
  return {
    ...m,
    eligible: eligible.length,
    excludedIds: pairs.filter((r) => !eligible.includes(r)).map((r) => r.id),
    trainFit: plain(f),
    training: f
      ? metrics(train.map((r) => ({ actual: r.ratingDelta, predicted: f.predict(r) })))
      : null,
    test: metrics(testPredictions),
    testPredictions,
    leaveOneOut: metrics(loo),
    rolling: metrics(rolling),
    fullFit: plain(full),
    fullInSample: full
      ? metrics(eligible.map((r) => ({ actual: r.ratingDelta, predicted: full.predict(r) })))
      : null,
  };
});
const rawPairs = [...pairs, ...bankOnly.filter((r) => !r.practice)].sort(
  (a, b) => a.observedAt - b.observedAt,
);
const profitFit = fit(
  rawPairs.filter((r) => r.observedAt < boundary),
  ['profit'],
);
const profitBankTest = profitFit
  ? rawPairs
      .filter((r) => r.observedAt >= boundary)
      .map((r) => ({ id: r.id, actual: r.ratingDelta, predicted: profitFit.predict(r) }))
  : [];
const data = {
  schema: 1,
  createdAt: new Date().toISOString(),
  scriptSha256: sha(fs.readFileSync(__filename)),
  sources: dataset.sources,
  datasetSha256: dataset.datasetSha256,
  protocol: {
    featureTiming:
      'Goal and opposite counts refer to the actually revealed goal, selected after the round. They are not live predictions of the unknown goal. Every included starting hand agrees with the immutable round_start event before any trades.',
    purpose:
      'Reverse-engineering investigation of observed rating deltas; no formula identified, model fit deployed, or claim of server equivalence.',
    boundary: new Date(boundary).toISOString(),
    split:
      'Train on prior paired observations through 109 lifetime rounds; describe next newly exported clean pairs. Models were listed before fitting; this remains retrospective hypothesis comparison, not an untouched prospective test.',
    candidates: models,
    parameters:
      'OLS with intercept, at most 4 fitted coefficients, unregularized. All formulas and results reported; no chosen production winner.',
    validation:
      'Chronological split, expanding-window one-step prediction after 12 examples, and leave-one-round-out sensitivity. Equal weight per isolated round.',
    unknowns: [
      'Native opponent ratings and their update behavior',
      'Native estimate of hand quality',
      'Newcomer boost magnitude and decay',
      'Server update timing; associations are corroborated candidates',
    ],
    benchmarks:
      'Actual-deal benchmark freezes all starting hands and includes true goal/bonus. It is hindsight endowment, not a counterfactual trading policy. Opening-model forecasts are local surrogate features, not native score estimates.',
  },
  officialFAQ: {
    url: 'https://www.figgie.com/faqs',
    checked: '2026-10-30',
    claim:
      'Variation of Elo combining own-versus-average-opponent rating, expected performance from dealt hand, decaying early-game bump, and profit/loss.',
  },
  coverage: {
    uniqueRatingSnapshots: observations.size,
    allSegments: dataset.rounds.length,
    officialSingleRoundPairs: officialPairs.length,
    cleanOfficialMedium4p: pairs.length,
    bankOnlyPairs: bankOnly.length,
    trainingClean: pairs.filter((r) => r.observedAt < boundary).length,
    newClean: pairs.filter((r) => r.observedAt >= boundary).length,
    latestObservation: obs.at(-1),
  },
  pairs,
  bankOnlyPairs: bankOnly,
  excludedOfficialPairs: officialPairs.filter((r) => !pairs.includes(r)),
  intervals: intervals.filter((i) => i.roundCount),
  results,
  rawProfitSensitivity: {
    pairs: rawPairs.length,
    trainingFit: plain(profitFit),
    test: metrics(profitBankTest),
  },
  limitations: [
    'All clean pairs involve one account against Medium bots; rating and experience move together, so their coefficients cannot identify separate effects.',
    'Hand variables and native opponent ratings are incomplete. Predictive fits are approximations, not a recovered formula.',
    'Rank-based or profit-only Elo is inconsistent with some observed sign changes; exact constants cannot be inferred solely from better fit.',
    'No-goal bank-only rounds retained for profit/rating evidence but excluded from hand features.',
  ],
};
fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify({ officialPairs: pairs.length, newPairs: data.coverage.newClean, out }));
