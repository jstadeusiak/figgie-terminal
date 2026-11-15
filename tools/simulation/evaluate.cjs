'use strict';

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { runRound, settlement, SUITS } = require('./simulator.cjs');
const ROOT = path.resolve(__dirname, '../../extension');

function loadEngine(filename, fitFilename) {
  // Browser scripts also publish globals. Isolate them so requiring the frozen
  // fit cannot accidentally make the candidate consume v0.10's fit table.
  const execute = (file, scope, dependency) => {
    const module = { exports: {} };
    const resolved = path.join(ROOT, file);
    vm.compileFunction(
      fs.readFileSync(resolved, 'utf8'),
      ['module', 'require', 'globalThis', 'performance'],
      { filename: resolved },
    )(module, dependency, scope, performance);
    return module.exports;
  };
  const fit = execute(fitFilename, {});
  const localRequire = createRequire(path.join(ROOT, filename));
  return execute(filename, { FiggieModelFit: fit }, (request) =>
    request === './model-fit.js' || request === './model-fit-v0.10.js'
      ? fit
      : localRequire(request),
  );
}
function selectModels(options = {}) {
  function select(role, version) {
    const engineOptions = { skipPricing: true };
    let Belief;
    let Journal;
    let metadata;
    let sourceFiles;
    if (version !== undefined) {
      const release = require('../model-registry.cjs').load(version);
      ({ Belief, Journal } = release);
      metadata = {
        kind: 'archive',
        version: release.entry.version,
        bundleSha256: release.entry.bundleSha256,
        files: release.entry.files,
      };
      sourceFiles = Object.keys(release.entry.files).map((file) =>
        path.resolve(__dirname, '../../models', version, file),
      );
      sourceFiles.push(path.resolve(__dirname, '../model-registry.cjs'));
      // An archived release defines its own model defaults. Only deliberate CLI
      // sampling overrides are forwarded; never enable a newer algorithm here.
      if (options.samples !== undefined) engineOptions.samples = options.samples;
      if (options.opponentSamples !== undefined)
        engineOptions.opponentSamples = options.opponentSamples;
    } else {
      const old = role === 'baseline';
      const belief = old ? 'belief-v0.10.js' : 'belief.js';
      const fit = old ? 'model-fit-v0.10.js' : 'model-fit.js';
      const journal = old ? 'journal-v0.10.js' : 'journal.js';
      Belief = loadEngine(belief, fit);
      Journal = require(path.join(ROOT, journal));
      engineOptions.samples = options.samples ?? 128;
      if (!old)
        Object.assign(engineOptions, {
          opponentLearning: true,
          opponentSamples: options.opponentSamples ?? 12,
        });
      metadata = {
        kind: old ? 'frozen-runtime' : 'current-runtime',
        version: Belief.VERSION,
        bundleSha256: null,
      };
      sourceFiles = [belief, fit, journal, 'pnl.js'].map((file) => path.join(ROOT, file));
    }
    const probe = new Belief.BeliefEngine(engineOptions);
    metadata.engineOptions = { ...engineOptions };
    metadata.effectiveSettings = {
      samples: probe.samples ?? null,
      opponentLearning: probe.opponentLearning ?? false,
      opponentSamples: probe.knowledge?.samples ?? null,
    };
    return { Belief, Journal, metadata, sourceFiles, engineOptions };
  }
  return {
    baseline: select('baseline', options.baselineVersion),
    candidate: select('candidate', options.candidateVersion),
  };
}
function sourceHashes(selected) {
  const paths = [
    ...new Set([
      ...Object.values(selected).flatMap((model) => model.sourceFiles),
      ...['simulator.cjs', 'policies.cjs', 'evaluate.cjs', 'cli.cjs'].map((name) =>
        path.join(__dirname, name),
      ),
    ]),
  ];
  return Object.fromEntries(
    paths.map((file) => [
      path.relative(path.resolve(__dirname, '../..'), file),
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    ]),
  );
}

function errorMetric() {
  return { n: 0, abs: 0, square: 0, signed: 0 };
}
function addError(metric, predicted, actual) {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return;
  const difference = predicted - actual;
  metric.n++;
  metric.abs += Math.abs(difference);
  metric.square += difference * difference;
  metric.signed += difference;
}
function summarize(metric) {
  return {
    n: metric.n,
    mae: metric.n ? metric.abs / metric.n : null,
    rmse: metric.n ? Math.sqrt(metric.square / metric.n) : null,
    bias: metric.n ? metric.signed / metric.n : null,
  };
}
function accumulator() {
  return {
    checkpoints: 0,
    brier: 0,
    logLoss: 0,
    topCorrect: 0,
    leaderBrier: 0,
    leaderCheckpoints: 0,
    derivedBonusCheckpoints: 0,
    conditionalBonus: errorMetric(),
    expectedBonus: errorMetric(),
    expectedPayout: errorMetric(),
    oneCardValue: errorMetric(),
    executableQuoteEV: errorMetric(),
    timings: [],
  };
}
function merge(into, from) {
  for (const key of [
    'checkpoints',
    'brier',
    'logLoss',
    'topCorrect',
    'leaderBrier',
    'leaderCheckpoints',
    'derivedBonusCheckpoints',
  ])
    into[key] += from[key];
  for (const key of [
    'conditionalBonus',
    'expectedBonus',
    'expectedPayout',
    'oneCardValue',
    'executableQuoteEV',
  ]) {
    for (const field of ['n', 'abs', 'square', 'signed']) into[key][field] += from[key][field];
  }
  into.timings.push(...from.timings);
}
function report(a) {
  const times = a.timings.slice().sort((x, y) => x - y);
  const n = a.checkpoints;
  return {
    checkpoints: n,
    goalBrier: n ? a.brier / n : null,
    goalLogLoss: n ? a.logLoss / n : null,
    topGoalAccuracy: n ? a.topCorrect / n : null,
    conditionalLeaderBrier: a.leaderCheckpoints ? a.leaderBrier / a.leaderCheckpoints : null,
    conditionalLeaderCheckpoints: a.leaderCheckpoints,
    conditionalBonus: {
      ...summarize(a.conditionalBonus),
      derivedFromHoldingCheckpoints: a.derivedBonusCheckpoints,
    },
    expectedBonus: summarize(a.expectedBonus),
    expectedPayout: summarize(a.expectedPayout),
    oneCardValue: summarize(a.oneCardValue),
    executableQuoteEV: summarize(a.executableQuoteEV),
    computeMs: {
      mean: times.length ? times.reduce((x, y) => x + y, 0) / times.length : null,
      p95: times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] ?? null,
      max: times.at(-1) ?? null,
    },
  };
}

function transferValue(truth, actor, other, suit, direction) {
  const hands = truth.hands.map((row) => row.slice());
  const before = settlement(hands, truth.goal).payouts[actor];
  const seller = direction === 'buy' ? other : actor;
  const buyer = direction === 'buy' ? actor : other;
  if (hands[seller][suit] < 1) return null;
  hands[seller][suit]--;
  hands[buyer][suit]++;
  const after = settlement(hands, truth.goal).payouts[actor];
  return direction === 'buy' ? after - before : before - after;
}
function score(model, snapshot, truth, metric) {
  const goal = SUITS.indexOf(truth.goal);
  const probabilities = model.bySuit.map((s) => s.probability);
  if (
    probabilities.length !== 4 ||
    probabilities.some((p) => !Number.isFinite(p) || p < -1e-9 || p > 1 + 1e-9) ||
    Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-6
  )
    throw Error('Model returned invalid goal probabilities');
  const actor = truth.names.indexOf(snapshot.self);
  const actual = settlement(truth.hands, goal);
  metric.checkpoints++;
  metric.brier += probabilities.reduce((v, p, s) => v + (p - Number(s === goal)) ** 2, 0);
  metric.logLoss -= Math.log(Math.max(1e-12, probabilities[goal]));
  metric.topCorrect += Number(probabilities.indexOf(Math.max(...probabilities)) === goal);
  const scenario = model.bySuit[goal];
  if (Number.isFinite(scenario.conditionalLeaderProbability)) {
    metric.leaderBrier +=
      (scenario.conditionalLeaderProbability - Number(actual.bonuses[actor] > 0)) ** 2;
    metric.leaderCheckpoints++;
  }
  let bonus = scenario.conditionalBonus;
  if (!Number.isFinite(bonus) && scenario.probability > 0 && Number.isFinite(scenario.holding)) {
    bonus = Math.max(0, scenario.holding / scenario.probability - 10 * snapshot.held[goal]);
    metric.derivedBonusCheckpoints++;
  }
  addError(metric.conditionalBonus, bonus, actual.bonuses[actor]);
  addError(metric.expectedBonus, model.expectedBonus, actual.bonuses[actor]);
  addError(metric.expectedPayout, model.expectedPayout, actual.payouts[actor]);
  for (let suit = 0; suit < 4; suit++) {
    const row = model.bySuit[suit];
    const market = snapshot.markets[suit];
    for (const [name, values] of Object.entries(row.counterparties || {})) {
      const other = truth.names.indexOf(name);
      for (const side of ['buy', 'sell']) {
        if (!Number.isFinite(values[side])) continue;
        const value = transferValue(truth, actor, other, suit, side);
        if (value === null) continue;
        addError(metric.oneCardValue, values[side], value);
        const selected =
          side === 'buy'
            ? market.seller === name && market.canBuy
            : market.buyer === name && market.canSell;
        if (selected) {
          const price = market[side === 'buy' ? 'ask' : 'bid'];
          addError(
            metric.executableQuoteEV,
            side === 'buy' ? values.buy - price : price - values.sell,
            side === 'buy' ? value - price : price - value,
          );
        }
      }
    }
  }
  if (Number.isFinite(model.computeMs)) metric.timings.push(model.computeMs);
}

function evaluate(options = {}) {
  const games = options.games ?? 20;
  const players = options.players ?? 4;
  const seed = options.seed ?? 1101;
  const checkpoints = options.checkpoints ?? 5;
  const steps = options.steps ?? 240;
  if (!Number.isInteger(games) || games < 1 || !Number.isInteger(checkpoints) || checkpoints < 2)
    throw Error('games >= 1 and checkpoints >= 2 must be integers');
  const checkpointSteps = new Set(
    Array.from({ length: Math.min(checkpoints, steps + 1) }, (_, i) =>
      Math.round((i * steps) / (Math.min(checkpoints, steps + 1) - 1)),
    ),
  );
  const selected = selectModels(options);
  const baselineKey = options.baselineVersion === undefined ? 'frozenV010' : 'baseline';
  const sources = sourceHashes(selected);
  const totals = { [baselineKey]: accumulator(), candidate: accumulator() };
  const rounds = [];
  const policyPnl = {};
  const started = performance.now();
  for (let game = 0; game < games; game++) {
    const gameSeed = seed + game;
    const oldJournal = new selected.baseline.Journal.RoundJournal(
      `sim-${gameSeed}`,
      `sim-${gameSeed}`,
    );
    const newJournal = new selected.candidate.Journal.RoundJournal(
      `sim-${gameSeed}`,
      `sim-${gameSeed}`,
    );
    const oldEngine = new selected.baseline.Belief.BeliefEngine(selected.baseline.engineOptions);
    const newEngine = new selected.candidate.Belief.BeliefEngine(selected.candidate.engineOptions);
    const perRound = { [baselineKey]: accumulator(), candidate: accumulator() };
    const round = runRound({
      ...options,
      players,
      seed: gameSeed,
      steps,
      onSnapshot(snapshot, truth, frame) {
        oldJournal.observe(snapshot, frame.at);
        newJournal.observe(snapshot, frame.at);
        if (!checkpointSteps.has(frame.step)) return;
        score(
          oldEngine.infer(snapshot, oldJournal.evidence),
          snapshot,
          truth,
          perRound[baselineKey],
        );
        score(newEngine.infer(snapshot, newJournal.evidence), snapshot, truth, perRound.candidate);
      },
    });
    for (const key of Object.keys(totals)) merge(totals[key], perRound[key]);
    round.policyTypes.forEach((type, p) => {
      if (!policyPnl[type]) policyPnl[type] = { rounds: 0, total: 0, profitable: 0 };
      const pnl = round.result.profits[round.truthBeforeSettlement.names[p]];
      const row = policyPnl[type];
      row.rounds++;
      row.total += pnl;
      row.profitable += Number(pnl > 0);
    });
    rounds.push({
      seed: gameSeed,
      goal: round.result.goal,
      trades: round.trace.at(-1).snapshot.trades.length,
      policies: round.policyTypes,
      pnl: round.result.profits,
      scores: Object.fromEntries(Object.entries(perRound).map(([k, a]) => [k, report(a)])),
    });
    options.onProgress?.({ game: game + 1, games, trades: rounds.at(-1).trades });
  }
  const models = Object.fromEntries(Object.entries(totals).map(([k, a]) => [k, report(a)]));
  const difference = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a - b : null);
  const differences = {
    candidateMinusBaselineBrier: difference(
      models.candidate.goalBrier,
      models[baselineKey].goalBrier,
    ),
    candidateMinusBaselineLogLoss: difference(
      models.candidate.goalLogLoss,
      models[baselineKey].goalLogLoss,
    ),
    candidateMinusBaselineConditionalBonusMae: difference(
      models.candidate.conditionalBonus.mae,
      models[baselineKey].conditionalBonus.mae,
    ),
    candidateMinusBaselineOneCardMae: difference(
      models.candidate.oneCardValue.mae,
      models[baselineKey].oneCardValue.mae,
    ),
  };
  if (baselineKey === 'frozenV010')
    Object.assign(
      differences,
      Object.fromEntries(
        Object.entries(differences).map(([key, value]) => [
          key.replace('Baseline', 'Frozen'),
          value,
        ]),
      ),
    );
  return {
    schema: 2,
    config: {
      games,
      players,
      seed,
      steps,
      checkpoints: checkpointSteps.size,
      samples:
        options.samples ??
        (options.baselineVersion === undefined && options.candidateVersion === undefined
          ? 128
          : null),
      opponentSamples:
        options.opponentSamples ?? (options.candidateVersion === undefined ? 12 : null),
      noise: options.noise ?? 1,
      brownian: options.brownian ?? 0,
      difficulty: options.difficulty ?? 'medium',
      heterogeneous: options.heterogeneous !== false,
    },
    modelSelection: {
      baseline: { ...selected.baseline.metadata, resultKey: baselineKey },
      candidate: { ...selected.candidate.metadata, resultKey: 'candidate' },
    },
    interpretation: {
      scope:
        'Synthetic-policy stress test. This is not validation against native Figgie bot behavior or human play.',
      forecasts:
        'Both models see identical causal public paths. Hidden deal/goal information enters scoring only.',
      probabilities:
        'Multiclass Brier is sum of four squared errors; lower Brier and natural-log loss are better.',
      bonus:
        'conditionalBonus and conditionalLeaderBrier condition on the actual goal suit at each checkpoint; expectedBonus and expectedPayout also include goal uncertainty. Older conditional bonus forecasts are derived from expected holding divided by goal probability when necessary; unsupported leadership/transfer fields are omitted, never treated as zero.',
      transfers:
        'oneCardValue scores legal hypothetical named transfers against exact settlement change for the realized hidden deal. executableQuoteEV limits this to visible actionable quotes. These are noisy realized-outcome errors, not proof a positive-EV decision was wrong.',
      pnl: 'PnL belongs to fixed independent policies. Neither model placed these trades, so this is not a causal comparison of model trading profit.',
      prices:
        'Bounded mean-reverting quote noise with optional Brownian persistence; not GBM fair values. Finite card supplies and fixed terminal payouts do not follow an unbounded lognormal process.',
      fit: 'No fitting or seed selection is performed. Defaults 1101–1120 are fixed synthetic validation seeds.',
    },
    sources,
    elapsedMs: performance.now() - started,
    models,
    differences,
    policyPnl: Object.fromEntries(
      Object.entries(policyPnl).map(([k, v]) => [
        k,
        {
          observations: v.rounds,
          mean: v.total / v.rounds,
          profitableFraction: v.profitable / v.rounds,
        },
      ]),
    ),
    rounds,
  };
}

module.exports = { evaluate, transferValue, score, accumulator, report, loadEngine, selectModels };
