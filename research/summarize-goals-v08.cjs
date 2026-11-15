const fs = require('fs');
const dir = 'outputs/model-review-v08';
const train = require('../' + dir + '/goal-train.json');
const holdout = require('../' + dir + '/goal-validate.json');
const old = require('../' + dir + '/goal-old.json');
const selection = require('../' + dir + '/goal-selection.json');
const rs = [...train.rounds, ...holdout.rounds];
const ids = ['s', 'c', 'd', 'h'];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const metrics = (rounds, method) => ({
  brier: mean(rounds.map((r) => mean(r.points.map((p) => p.scores[method].brier)))),
  logLoss: mean(rounds.map((r) => mean(r.points.map((p) => p.scores[method].logLoss)))),
  finalCorrect: rounds.filter((r) => r.points.at(-1).scores[method].top === ids.indexOf(r.goal))
    .length,
});
const final = rs.map((r) => {
  let p = r.points.at(-1);
  return {
    id: r.id,
    goal: r.goal,
    probability: p.scores.current.goalP,
    maximum: p.scores.current.maxP,
    rank: 1 + p.p.current.filter((x) => x > p.scores.current.goalP).length,
    physicalActualGoalP: p.scores.cards.goalP,
    candidateActualGoalP: p.scores.recent24.goalP,
    signalTotalVariation: p.p.current.reduce((s, v, i) => s + Math.abs(v - p.p.cards[i]), 0) / 2,
  };
});
const points = rs.flatMap((r) => r.points);
const calibration = [
  [0.25, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 1.01],
].map(([lo, hi]) => {
  let bin = final.filter((x) => x.maximum >= lo && x.maximum < hi);
  return {
    from: lo,
    to: hi,
    n: bin.length,
    predicted: bin.length ? mean(bin.map((x) => x.maximum)) : null,
    observed: bin.length ? bin.filter((x) => x.rank === 1).length / bin.length : null,
  };
});
const report = {
  sourceSha: train.sourceSha,
  data: {
    newOfficialLabeledRounds: 20,
    newCheckpoints: points.length,
    newRecordedVersion: '0.7.0',
    training: 14,
    chronologicalValidation: 6,
    oldRounds: 34,
    oldCheckpoints: old.all.checkpoints,
  },
  methodology:
    'Live pre-reveal prediction prefixes only; original saved learning priors; equal weight per round, equal weight per checkpoint within each round; new20 v7 forecasts are prospectively recorded. Candidate is offline chronological validation, not a prospectively recorded result. One candidate chosen from two on first14 before examining final6. All performance metrics are forecast scores, not measured profit.',
  selection,
  new20: Object.fromEntries(
    ['saved', 'cards', 'current', 'v6', 'recent24'].map((k) => [k, metrics(rs, k)]),
  ),
  training14: train.all,
  holdout6: holdout.all,
  old34: old.all,
  candidateChanges: {
    training: train.candidateChanges.recent24,
    holdout: holdout.candidateChanges.recent24,
    old: old.candidateChanges.recent24,
  },
  verification: {
    maxSavedReplayDifference: Math.max(train.maxSavedError, holdout.maxSavedError),
    askConstraintFallbacks: points.filter((p) => p.fallback).length,
    actualGoalExcludedByPhysical: points.filter(
      (p) => p.p.cards[ids.indexOf(rs.find((r) => r.points.includes(p)).goal)] === 0,
    ).length,
    finalChosenEvidenceCounts: [...new Set(rs.map((r) => r.points.at(-1).observations))],
  },
  diagnosis: {
    finalWinnerCorrect: final.filter((x) => x.rank === 1).length,
    finalWinnerExpected: final.reduce((s, x) => s + x.maximum, 0),
    finalTopTwoCorrect: final.filter((x) => x.rank <= 2).length,
    over50ConfidenceRounds: final.filter((x) => x.maximum > 0.5).length,
    over50Correct: final.filter((x) => x.maximum > 0.5 && x.rank === 1).length,
    meanFinalSignalTotalVariation: mean(final.map((x) => x.signalTotalVariation)),
    lowProbabilityActualGoals: final.filter((x) => x.probability < 0.15),
    calibrationBins: calibration,
    notes: [
      'Physical cards/asks baseline remains the main driver. Opponent signals shift only about 1.59 percentage points of total probability mass at the final checkpoint on average.',
      'All20 final checkpoints already reached the72-opponent-event budget. Permanently keeping eight opening observations per opponent displaces current trading evidence late in a round.',
      'The recent24 change improves probability scores without flipping any final highest-probability suit; it cannot be claimed to have prevented recorded losses.',
      'No universal sharpening, cap increase or new opponent-price model is recommended from this small sample. The internal opponent reservation model still relies on its starting-hand private belief and rough bonus competition.',
    ],
    recommendedChange:
      'Keep24 evidence episodes per opponent, selected as most recent24 instead of opening8 plus recent16, only for four-player Medium bots. Preserve event deduplication, own-action exclusion, physical constraints, prices, temperature, weights and cap.',
  },
};
fs.writeFileSync(dir + '/goal-summary.json', JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      file: dir + '/goal-summary.json',
      new20: report.new20,
      verification: report.verification,
      calibration,
    },
    null,
    2,
  ),
);
