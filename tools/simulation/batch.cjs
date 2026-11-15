#!/usr/bin/env node
'use strict';
// Frozen-seed, paired, synthetic discovery audit. Never opens test implicitly.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Registry = require('../model-registry.cjs');
const FastRegistry = require('./fast-load.cjs');
const { runRound, SUITS, settlement } = require('./simulator.cjs');
const { privateOdds } = require('./policies.cjs');
const { DECKS } = require('./simulator.cjs');
const { transferValue, loadEngine } = require('./evaluate.cjs');
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_OUT = path.join(ROOT, 'outputs/simulation-review-2026-10-28');
const VERSIONS = ['0.3.0', '0.6.0', '0.7.0', '0.8.0', '0.10.0', '0.11.0'];
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const generatorHashes = () =>
  Object.fromEntries(
    ['simulator.cjs', 'policies.cjs'].map((name) => [
      name,
      sha(fs.readFileSync(path.join(__dirname, name))),
    ]),
  );
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function createManifest(out = DEFAULT_OUT) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'manifest.json');
  if (fs.existsSync(file)) return read(file);
  const regimes = [
    { name: 'quiet', noise: 0.4, brownian: 0 },
    { name: 'default', noise: 1, brownian: 0 },
    { name: 'volatile', noise: 2, brownian: 0.5 },
  ];
  const strata = [4, 5].flatMap((players) =>
    [false, true].flatMap((heterogeneous) =>
      regimes.map((regime) => ({ players, heterogeneous, ...regime })),
    ),
  );
  const games = [];
  const splitSizes = { train: 600, validation: 200, test: 400 };
  let index = 0;
  for (const [partition, count] of Object.entries(splitSizes))
    for (let i = 0; i < count; i++) {
      const stratum = strata[i % strata.length];
      games.push({
        id: `synthetic-${String(index + 1).padStart(4, '0')}`,
        seed: 600001 + index++,
        partition,
        ...stratum,
      });
    }
  const manifest = {
    schema: 1,
    createdAt: new Date().toISOString(),
    purpose:
      'Synthetic discovery dataset; fixed before any scored output. Test requires frozen model selection.',
    splitSizes,
    strata,
    generatorHashes: generatorHashes(),
    steps: 240,
    checkpoints: [0, 120, 220],
    contexts: ['Simulated', 'Medium'],
    discoverySamples: 128,
    archives: VERSIONS.map((version) => {
      const [e] = Registry.verify(version);
      return { version, bundleSha256: e.bundleSha256 };
    }),
    exclusions: [
      'Seeds 910001–910030 belong to an earlier exploratory preview and are never pooled.',
    ],
    interpretation:
      'Distinct seeds per game. Context Medium selects Medium-fitted forecast settings on synthetic policies, not native Medium bot behavior. Train/validation guide changes; test stays unopened until selection.',
    games,
  };
  write(file, manifest);
  return manifest;
}
function errorAdd(group, key, predicted, actual) {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return;
  const a = (group.errors[key] ||= { n: 0, predicted: 0, actual: 0, bias: 0, mse: 0, mae: 0 });
  a.n++;
  a.predicted += predicted;
  a.actual += actual;
  a.bias += predicted - actual;
  a.mse += (predicted - actual) ** 2;
  a.mae += Math.abs(predicted - actual);
}
function valueAdd(group, key, value) {
  if (!Number.isFinite(value)) return;
  const a = (group.values[key] ||= { n: 0, sum: 0 });
  a.n++;
  a.sum += value;
}
const fresh = () => ({ errors: {}, values: {} });
function normalized(group) {
  return {
    errors: Object.fromEntries(
      Object.entries(group.errors).map(([k, v]) => [
        k,
        {
          observations: v.n,
          ...Object.fromEntries(
            ['predicted', 'actual', 'bias', 'mse', 'mae'].map((field) => [field, v[field] / v.n]),
          ),
        },
      ]),
    ),
    values: Object.fromEntries(
      Object.entries(group.values).map(([k, v]) => [k, { observations: v.n, mean: v.sum / v.n }]),
    ),
  };
}
function combineRound(target, group) {
  for (const [key, value] of Object.entries(group.errors)) {
    const a = (target.errors[key] ||= {
      rounds: 0,
      observations: 0,
      predicted: 0,
      actual: 0,
      bias: 0,
      mse: 0,
      mae: 0,
    });
    a.rounds++;
    a.observations += value.observations;
    for (const field of ['predicted', 'actual', 'bias', 'mse', 'mae']) a[field] += value[field];
  }
  for (const [key, value] of Object.entries(group.values)) {
    const a = (target.values[key] ||= { rounds: 0, observations: 0, sum: 0 });
    a.rounds++;
    a.observations += value.observations;
    a.sum += value.mean;
  }
}
function combinedReport(group) {
  return {
    errors: Object.fromEntries(
      Object.entries(group.errors).map(([k, v]) => [
        k,
        {
          rounds: v.rounds,
          observations: v.observations,
          ...Object.fromEntries(
            ['predicted', 'actual', 'bias', 'mse', 'mae'].map((field) => [
              field,
              v[field] / v.rounds,
            ]),
          ),
          rmse: Math.sqrt(v.mse / v.rounds),
        },
      ]),
    ),
    values: Object.fromEntries(
      Object.entries(group.values).map(([k, v]) => [
        k,
        { rounds: v.rounds, observations: v.observations, mean: v.sum / v.rounds },
      ]),
    ),
  };
}
function initialEntropy(hand) {
  const p = [0, 0, 0, 0];
  privateOdds(hand).forEach((w, d) => (p[DECKS[d].goal] += w));
  return -p.reduce((v, x) => v + (x ? x * Math.log(x) : 0), 0) / Math.log(4);
}
const entropyBin = (h) => (h < 0.65 ? 'low' : h < 0.9 ? 'medium' : 'high');
const probabilityBin = (p) =>
  `${Math.min(9, Math.floor(p * 10)) / 10}-${Math.min(10, Math.floor(p * 10) + 1) / 10}`;
const edgeBin = (x) =>
  x < -5 ? '<-5' : x < 0 ? '-5-0' : x < 2 ? '0-2' : x < 5 ? '2-5' : x < 10 ? '5-10' : '>=10';
function baseForecasts(engine, snapshot, model) {
  const base = SUITS.map(() => ({}));
  const names = snapshot.players.map((p) => p.name);
  for (let s = 0; s < 4; s++)
    for (const name of names.slice(1))
      base[s][name] = { buy: 0, sell: 10 * model.bySuit[s].probability };
  // Older models lack buyBase; recover the identical inventory-conditioned
  // forecast from their final world weights, without consulting hidden truth.
  const latest = engine.latest;
  if (latest)
    latest.worlds.forEach((world, i) => {
      const s = world.goal;
      const weight = latest.weights[i];
      for (let p = 1; p < names.length; p++)
        if (world.initial[p][s] + snapshot.net[p][s] > 0) base[s][names[p]].buy += weight * 10;
    });
  for (let s = 0; s < 4; s++)
    for (const name of names.slice(1)) {
      const cp = model.bySuit[s].counterparties?.[name];
      base[s][name].buy = Number.isFinite(cp?.buyBase)
        ? cp.buyBase
        : latest && cp?.hasCardProbability > 0
          ? base[s][name].buy / cp.hasCardProbability
          : null;
      if (Number.isFinite(cp?.sellBase)) base[s][name].sell = cp.sellBase;
    }
  return base;
}
function observeMetrics(model, engine, snapshot, truth, descriptors, groups) {
  const g = SUITS.indexOf(truth.goal);
  const actual = settlement(truth.hands, g);
  const probabilities = model.bySuit.map((row) => row.probability);
  if (
    probabilities.length !== 4 ||
    probabilities.some((p) => !Number.isFinite(p) || p < -1e-9 || p > 1 + 1e-9) ||
    Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-6
  )
    throw Error('Invalid probability vector');
  const selected = descriptors.map((key) => (groups[key] ||= fresh()));
  const value = (key, x) => selected.forEach((group) => valueAdd(group, key, x));
  const error = (key, p, a) => selected.forEach((group) => errorAdd(group, key, p, a));
  value(
    'goalBrier',
    probabilities.reduce((n, p, s) => n + (p - Number(s === g)) ** 2, 0),
  );
  value('goalLogLoss', -Math.log(Math.max(1e-12, probabilities[g])));
  value('topCorrect', Number(probabilities.indexOf(Math.max(...probabilities)) === g));
  value('computeMs', model.computeMs);
  for (let s = 0; s < 4; s++)
    errorAdd(
      (groups[`probability:${probabilityBin(probabilities[s])}`] ||= fresh()),
      'goal',
      probabilities[s],
      Number(s === g),
    );
  const scenario = model.bySuit[g];
  const bonus = Number.isFinite(scenario.conditionalBonus)
    ? scenario.conditionalBonus
    : scenario.probability > 0
      ? Math.max(0, scenario.holding / scenario.probability - 10 * snapshot.held[g])
      : null;
  error('conditionalBonus', bonus, actual.bonuses[0]);
  error('expectedPayout', model.expectedPayout, actual.payouts[0]);
  error('expectedBonus', model.expectedBonus, actual.bonuses[0]);
  if (Number.isFinite(scenario.conditionalLeaderProbability)) {
    value(
      'conditionalLeaderBrier',
      (scenario.conditionalLeaderProbability - Number(actual.bonuses[0] > 0)) ** 2,
    );
    errorAdd(
      (groups[`leaderProbability:${probabilityBin(scenario.conditionalLeaderProbability)}`] ||=
        fresh()),
      'leader',
      scenario.conditionalLeaderProbability,
      Number(actual.bonuses[0] > 0),
    );
  }
  const bases = baseForecasts(engine, snapshot, model);
  const quotes = [];
  for (let s = 0; s < 4; s++)
    for (const [name, cp] of Object.entries(model.bySuit[s].counterparties || {})) {
      const other = truth.names.indexOf(name);
      const counts = truth.hands.map((row) => row[s]);
      const nearContest = Math.abs(counts[0] - Math.max(...counts.slice(1))) <= 2;
      for (const direction of ['buy', 'sell']) {
        if (!Number.isFinite(cp[direction])) continue;
        const actualValue = transferValue(truth, 0, other, s, direction);
        if (actualValue === null) continue;
        const predictedBase = bases[s][name][direction];
        const actualBase = s === g ? 10 : 0;
        const predictedBonus = Number.isFinite(predictedBase)
          ? cp[direction] - predictedBase
          : null;
        error('transferValue', cp[direction], actualValue);
        error('transferBase', predictedBase, actualBase);
        error('transferBonus', predictedBonus, actualValue - actualBase);
        error(`${direction}Value`, cp[direction], actualValue);
        if (nearContest) {
          error('contestTransferValue', cp[direction], actualValue);
          error('contestTransferBonus', predictedBonus, actualValue - actualBase);
        }
        const m = snapshot.markets[s];
        const executable =
          direction === 'buy' ? m.canBuy && m.seller === name : m.canSell && m.buyer === name;
        if (!executable) continue;
        const price = m[direction === 'buy' ? 'ask' : 'bid'];
        const sign = direction === 'buy' ? 1 : -1;
        const edge = sign * (cp[direction] - price);
        const actualEdge = sign * (actualValue - price);
        const baseEdge = Number.isFinite(predictedBase) ? sign * (predictedBase - price) : null;
        const bonusEdge = Number.isFinite(predictedBonus) ? sign * predictedBonus : null;
        error('quoteEdge', edge, actualEdge);
        quotes.push({
          direction,
          suit: SUITS[s],
          peer: name,
          price,
          edge,
          actualEdge,
          baseEdge,
          bonusEdge,
          predictedValue: cp[direction],
          actualValue,
          nearContest,
          bonusDependent: edge > 0 && Number.isFinite(baseEdge) && baseEdge <= 0,
        });
      }
    }
  quotes.sort((a, b) => b.edge - a.edge);
  const best = quotes[0] || null;
  if (best) {
    error('bestEdge', best.edge, best.actualEdge);
    value('bestPredictedEdge', best.edge);
    value('bestActualEdge', best.actualEdge);
    errorAdd(
      (groups[`bestEdgeBin:${edgeBin(best.edge)}`] ||= fresh()),
      'edge',
      best.edge,
      best.actualEdge,
    );
    if (best.edge > 0) {
      error('positiveBestEdge', best.edge, best.actualEdge);
      value('positiveBestRealizedLosingFraction', Number(best.actualEdge < 0));
      value('positiveBestBonusDependentFraction', Number(best.bonusDependent));
      if (best.edge >= 0.5 && Number.isFinite(best.bonusEdge))
        value('positiveBestBonusEdgeFraction', best.bonusEdge / best.edge);
      if (best.nearContest) {
        error('positiveContestBestEdge', best.edge, best.actualEdge);
        value('positiveContestBestRealizedLosingFraction', Number(best.actualEdge < 0));
      }
      if (best.bonusDependent) error('bonusDependentBestEdge', best.edge, best.actualEdge);
    }
  }
  return {
    probabilities,
    conditionalBonus: bonus,
    actualBonus: actual.bonuses[0],
    expectedPayout: model.expectedPayout,
    actualPayout: actual.payouts[0],
    best,
  };
}
function loadSpecs(versions, contexts, samples, factory, expectedSha) {
  const releases = versions.map((version) => FastRegistry.load(version));
  const latest = FastRegistry.load('0.11.0');
  const specs = [];
  for (const context of contexts)
    for (const release of releases)
      specs.push({
        id: `${release.entry.version}@${context}`,
        context,
        release,
        options: { samples, skipPricing: true },
        learning: {},
      });
  if (factory) {
    const factories = factory.split(',');
    if (factories.some((name) => !['goal-stratified', 'goal-stratified-ref-ess'].includes(name)))
      throw Error('Unknown candidate factory');
    const folder = path.join(ROOT, 'extension');
    const names = ['belief.js', 'journal.js', 'model-fit.js', 'pnl.js'];
    const before = Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(folder, name)))]),
    );
    if (!expectedSha || before['belief.js'] !== expectedSha)
      throw Error('Candidate requires the expected current belief.js SHA-256');
    const Belief = loadEngine('belief.js', 'model-fit.js');
    const Journal = require(path.join(folder, 'journal.js'));
    const after = Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(folder, name)))]),
    );
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error('Candidate sources changed during load');
    for (const name of factories) {
      const release = {
        Belief,
        Journal,
        entry: { version: name, files: before, bundleSha256: sha(JSON.stringify(before)) },
        sourceFolder: folder,
      };
      for (const context of contexts)
        specs.push({
          id: `${name}@${context}`,
          context,
          release,
          options: {
            samples,
            skipPricing: true,
            goalStratified: true,
            ...(name === 'goal-stratified-ref-ess' ? { referenceEss: true } : {}),
          },
          learning: {},
        });
    }
  }
  for (const context of contexts)
    specs.push({
      id: `physical@${context}`,
      context,
      release: latest,
      options: { samples, skipPricing: true, opponentLearning: false },
      learning: { forceBaseline: true },
    });
  return specs;
}
function proveAliases(out = DEFAULT_OUT) {
  const checkpointFile = path.join(out, 'benchmark-first12/checkpoints.ndjson');
  const roundFile = path.join(out, 'benchmark-first12/rounds.ndjson');
  const checkpoints = fs.readFileSync(checkpointFile, 'utf8').trim().split('\n').map(JSON.parse);
  const rounds = fs.readFileSync(roundFile, 'utf8').trim().split('\n').map(JSON.parse);
  const aliases = {
    '0.3.0@Medium': '0.3.0@Simulated',
    '0.7.0@Simulated': '0.10.0@Simulated',
    '0.8.0@Simulated': '0.10.0@Simulated',
    '0.8.0@Medium': '0.10.0@Medium',
    'physical@Medium': 'physical@Simulated',
  };
  const stripTiming = (value) =>
    JSON.stringify(value, (key, item) => (key === 'computeMs' ? undefined : item));
  if (rounds.length !== 12 || checkpoints.length !== 36)
    throw Error('Alias check requires the full first12/36-checkpoint benchmark');
  for (const [alias, target] of Object.entries(aliases)) {
    if (
      checkpoints.some(
        (row) => JSON.stringify(row.models[alias]) !== JSON.stringify(row.models[target]),
      ) ||
      rounds.some((row) => stripTiming(row.models[alias]) !== stripTiming(row.models[target]))
    )
      throw Error(`Observed outputs differ for ${alias} and ${target}`);
  }
  const proof = {
    schema: 1,
    aliases,
    rounds: 12,
    checkpoints: 36,
    checkpointSha256: sha(fs.readFileSync(checkpointFile)),
    roundSha256: sha(fs.readFileSync(roundFile)),
    scope:
      'Discovery speed optimization: exact equality of saved forecasts and all diagnostic aggregates except timing on the first12 training games covering every stratum. Not a universal equivalence proof. Subsequent alias results are copied from the representative, not independently executed.',
  };
  const file = path.join(out, 'discovery-aliases.json');
  if (fs.existsSync(file) && JSON.stringify(read(file)) !== JSON.stringify(proof))
    throw Error('Existing alias proof differs');
  write(file, proof);
  return file;
}
function paired(rows, context, candidate, reference) {
  const fields = {
    goalBrier: ['values', 'goalBrier', 'mean'],
    goalLogLoss: ['values', 'goalLogLoss', 'mean'],
    conditionalBonusMse: ['errors', 'conditionalBonus', 'mse'],
    transferMse: ['errors', 'transferValue', 'mse'],
    bestEdgeMse: ['errors', 'bestEdge', 'mse'],
    bestEdgeBias: ['errors', 'bestEdge', 'bias'],
  };
  const result = {};
  for (const [field, keys] of Object.entries(fields)) {
    const differences = rows
      .map((row) => {
        const a = keys.reduce((o, k) => o?.[k], row.models[`${candidate}@${context}`]?.overall);
        const b = keys.reduce((o, k) => o?.[k], row.models[`${reference}@${context}`]?.overall);
        return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
      })
      .filter(Number.isFinite);
    const m = mean(differences);
    const se =
      differences.length > 1
        ? Math.sqrt(
            differences.reduce((v, d) => v + (d - m) ** 2, 0) /
              (differences.length - 1) /
              differences.length,
          )
        : null;
    result[field] = {
      rounds: differences.length,
      meanDifference: m,
      standardError: se,
      approximate95Interval: se === null ? null : [m - 1.96 * se, m + 1.96 * se],
    };
  }
  return result;
}
function summarize(rows, metadata) {
  const pooled = {};
  for (const row of rows)
    for (const [model, groups] of Object.entries(row.models))
      for (const [key, group] of Object.entries(groups))
        combineRound(((pooled[model] ||= {})[key] ||= fresh()), group);
  const result = Object.fromEntries(
    Object.entries(pooled).map(([model, groups]) => [
      model,
      Object.fromEntries(
        Object.entries(groups).map(([key, group]) => [key, combinedReport(group)]),
      ),
    ]),
  );
  const strata = {};
  for (const row of rows) {
    const key = JSON.stringify(row.stratum);
    for (const [model, groups] of Object.entries(row.models))
      combineRound(((strata[model] ||= {})[key] ||= fresh()), groups.overall);
  }
  const balancedStrata = Object.fromEntries(
    Object.entries(strata).map(([model, groups]) => {
      const combined = fresh();
      for (const group of Object.values(groups)) combineRound(combined, combinedReport(group));
      const report = combinedReport(combined);
      for (const group of [report.errors, report.values])
        for (const metric of Object.values(group)) {
          metric.strata = metric.rounds;
          delete metric.rounds;
        }
      return [model, report];
    }),
  );
  const comparisons = {};
  for (const context of metadata.contexts)
    for (const version of [
      ...metadata.versions,
      ...(metadata.candidateFactory ? metadata.candidateFactory.split(',') : []),
    ].filter((v) => v !== '0.11.0'))
      comparisons[`${version}-minus-0.11.0@${context}`] = paired(rows, context, version, '0.11.0');
  for (const context of metadata.contexts)
    comparisons[`physical-minus-0.11.0@${context}`] = paired(rows, context, 'physical', '0.11.0');
  return {
    ...metadata,
    completedGames: rows.length,
    weighting:
      'Equal game weight within each reported bucket. Error RMSE = sqrt(mean per-game MSE). Every game has a distinct seed; context/model differences are paired by game. Approximate intervals describe synthetic variation, not real-player validity.',
    limits:
      'Settle-now quote and best-edge audits are static opportunity forecasts, not fill-adjusted EV or a causal trading-PnL comparison. Realized losing fraction is not a count of incorrect positive-EV predictions. Context Medium is synthetic behavior scored with Medium-fit model settings. Archive versions are the prespecified comparison subset, not every historical release.',
    models: result,
    balancedStrata,
    paired: comparisons,
  };
}
function prepareRun(options = {}) {
  const out = path.resolve(options.out || DEFAULT_OUT);
  const manifestFile = path.join(out, 'manifest.json');
  const manifest = read(manifestFile);
  const manifestSha256 = sha(fs.readFileSync(manifestFile));
  if (JSON.stringify(manifest.generatorHashes) !== JSON.stringify(generatorHashes()))
    throw Error(
      'Generator changed after manifest freeze; start a new dataset instead of silently reusing seeds.',
    );
  const partition = options.partition || 'train';
  const versions = options.versions || VERSIONS;
  const samples = options.samples || manifest.discoverySamples;
  if (!Object.hasOwn(manifest.splitSizes, partition)) throw Error('Invalid partition');
  const specs = loadSpecs(
    versions,
    manifest.contexts,
    samples,
    options.candidateFactory,
    options.candidateSha,
  );
  const aliasProof = options.aliasProof ? read(options.aliasProof) : null;
  const aliases = Object.fromEntries(
    Object.entries(aliasProof?.aliases || {}).filter(
      ([alias, target]) => specs.some((s) => s.id === alias) && specs.some((s) => s.id === target),
    ),
  );
  for (const [alias, target] of Object.entries(aliases))
    if (
      !specs.some((s) => s.id === alias) ||
      !specs.some((s) => s.id === target) ||
      aliases[target]
    )
      throw Error('Alias proof does not match this model selection');
  const modelsProvenance = specs.map((s) => ({
    id: s.id,
    version: s.release.entry.version,
    bundleSha256: s.release.entry.bundleSha256,
    options: s.options,
    learning: s.learning,
    aliasOf: aliases[s.id] || null,
  }));
  const execution = { archiveLoader: 'verified-host-compile', reuseContextEngines: true };
  const modelSpecSha256 = sha(JSON.stringify({ modelsProvenance, execution }));
  return {
    out,
    manifest,
    manifestSha256,
    partition,
    versions,
    samples,
    specs,
    aliasProof,
    aliases,
    modelsProvenance,
    execution,
    modelSpecSha256,
  };
}
function selectionSpec(options = {}) {
  const p = prepareRun(options);
  return {
    locked: false,
    manifestSha256: p.manifestSha256,
    versions: p.versions,
    samples: p.samples,
    modelSpecSha256: p.modelSpecSha256,
    execution: p.execution,
    modelsProvenance: p.modelsProvenance,
  };
}
function runBatch(options = {}) {
  const {
    out,
    manifest,
    manifestSha256,
    partition,
    versions,
    samples,
    specs,
    aliasProof,
    aliases,
    modelsProvenance,
    execution,
    modelSpecSha256,
  } = prepareRun(options);
  if (partition === 'test') {
    if (!options.selection)
      throw Error(
        'Test remains closed: pass an immutable model selection file after model selection.',
      );
    const selection = read(options.selection);
    if (
      selection.manifestSha256 !== manifestSha256 ||
      selection.locked !== true ||
      JSON.stringify(selection.versions) !== JSON.stringify(versions) ||
      selection.samples !== samples ||
      selection.modelSpecSha256 !== modelSpecSha256
    )
      throw Error(
        'Selection must lock this manifest, sample count and exact model specifications before opening test.',
      );
  }
  const offset = options.offset || 0;
  const games = manifest.games
    .filter((g) => g.partition === partition)
    .slice(offset, options.limit ? offset + options.limit : undefined);
  if (!games.length) throw Error('No selected games');
  const tag = options.tag || `${partition}-${offset}-${games.length}-${samples}`;
  const folder = path.join(out, tag);
  if (fs.existsSync(folder))
    throw Error('Output already exists; choose another tag rather than overwrite evidence.');
  fs.mkdirSync(folder);
  const candidate = specs.find((s) => s.release.sourceFolder);
  if (candidate) {
    const copyFolder = path.join(folder, 'candidate-snapshot');
    fs.mkdirSync(copyFolder);
    for (const name of Object.keys(candidate.release.entry.files)) {
      const bytes = fs.readFileSync(path.join(candidate.release.sourceFolder, name));
      if (sha(bytes) !== candidate.release.entry.files[name])
        throw Error('Candidate changed before snapshot copy');
      fs.writeFileSync(path.join(copyFolder, name), bytes);
    }
  }
  const metadata = {
    schema: 1,
    manifestSha256,
    partition,
    offset,
    requestedGames: games.length,
    contexts: manifest.contexts,
    versions,
    samples,
    tag,
    candidateFactory: options.candidateFactory || null,
    execution,
    generators: manifest.generatorHashes,
    runnerSha256: sha(fs.readFileSync(__filename)),
    scorerHashes: Object.fromEntries(
      ['evaluate.cjs', 'fast-load.cjs'].map((name) => [
        name,
        sha(fs.readFileSync(path.join(__dirname, name))),
      ]),
    ),
    startedAt: new Date().toISOString(),
    modelSpecSha256,
    modelsProvenance,
    aliasProof: aliasProof
      ? { ...aliasProof, fileSha256: sha(fs.readFileSync(options.aliasProof)) }
      : null,
    selectionFileSha256: options.selection ? sha(fs.readFileSync(options.selection)) : null,
  };
  write(path.join(folder, 'run.json'), metadata);
  const rows = [];
  const started = performance.now();
  const checkpointFd = fs.openSync(path.join(folder, 'checkpoints.ndjson'), 'wx');
  const roundsFd = fs.openSync(path.join(folder, 'rounds.ndjson'), 'wx');
  try {
    for (const game of games) {
      const engines = new Map();
      const state = specs
        .filter((s) => !aliases[s.id])
        .map((s) => {
          const key =
            s.release.entry.bundleSha256 + JSON.stringify(s.options) + JSON.stringify(s.learning);
          if (!engines.has(key)) engines.set(key, new s.release.Belief.BeliefEngine(s.options));
          return { ...s, engine: engines.get(key), groups: {} };
        });
      const journals = new Map();
      for (const s of state) {
        const key = s.release.entry.files['journal.js'];
        if (!journals.has(key))
          journals.set(key, new s.release.Journal.RoundJournal(game.id, game.id));
        s.journal = journals.get(key);
      }
      let entropy;
      const round = runRound({
        ...game,
        steps: manifest.steps,
        onSnapshot(snapshot, truth, frame) {
          for (const journal of journals.values()) journal.observe(snapshot, frame.at);
          if (!manifest.checkpoints.includes(frame.step)) return;
          entropy ??= initialEntropy(snapshot.startingHand);
          const stage = ['opening', 'middle', 'late'][manifest.checkpoints.indexOf(frame.step)];
          const descriptors = [
            'overall',
            `stage:${stage}`,
            `goalSupply:${truth.deck[SUITS.indexOf(truth.goal)]}`,
            `goalSuit:${truth.goal}`,
            `initialEntropy:${entropyBin(entropy)}`,
            `players:${game.players}`,
            `policies:${game.heterogeneous ? 'mixed' : 'value-only'}`,
            `regime:${game.name}`,
          ];
          const point = {
            game: game.id,
            seed: game.seed,
            stage,
            tradeCount: snapshot.trades.length,
            goal: truth.goal,
            goalSupply: truth.deck[SUITS.indexOf(truth.goal)],
            startingHand: snapshot.startingHand,
            held: snapshot.held,
            initialEntropy: entropy,
            models: {},
          };
          for (const s of state) {
            const input = {
              ...snapshot,
              context: {
                ...snapshot.context,
                botDifficulty: s.context,
                syntheticForecastContext: true,
              },
            };
            const model = s.engine.infer(input, s.journal.evidence, s.learning);
            point.models[s.id] = observeMetrics(
              model,
              s.engine,
              input,
              truth,
              descriptors,
              s.groups,
            );
          }
          for (const [alias, target] of Object.entries(aliases))
            point.models[alias] = point.models[target];
          fs.writeSync(checkpointFd, JSON.stringify(point) + '\n');
        },
      });
      const row = {
        game: game.id,
        seed: game.seed,
        stratum: { players: game.players, heterogeneous: game.heterogeneous, regime: game.name },
        goal: round.result.goal,
        trades: round.trace.at(-1).snapshot.trades.length,
        models: Object.fromEntries(
          state.map((s) => [
            s.id,
            Object.fromEntries(
              Object.entries(s.groups).map(([key, group]) => [key, normalized(group)]),
            ),
          ]),
        ),
      };
      for (const [alias, target] of Object.entries(aliases)) row.models[alias] = row.models[target];
      rows.push(row);
      fs.writeSync(roundsFd, JSON.stringify(row) + '\n');
      if (rows.length === 1 || rows.length % 10 === 0 || rows.length === games.length) {
        const elapsedMs = performance.now() - started;
        write(path.join(folder, 'summary.json'), summarize(rows, { ...metadata, elapsedMs }));
        process.stderr.write(
          `${tag}: ${rows.length}/${games.length} games, ${(elapsedMs / 1000).toFixed(1)}s, estimated ${(((elapsedMs / rows.length) * (games.length - rows.length)) / 60e3).toFixed(1)}m remaining\n`,
        );
      }
    }
  } finally {
    fs.closeSync(checkpointFd);
    fs.closeSync(roundsFd);
  }
  return path.join(folder, 'summary.json');
}
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    const value = args[++i];
    if (!value) throw Error('Missing value for ' + key);
    if (['offset', 'limit', 'samples'].includes(key)) {
      options[key] = Number(value);
      if (!Number.isInteger(options[key]) || options[key] < (key === 'offset' ? 0 : 1))
        throw Error('Invalid ' + key);
    } else if (key === 'versions') options.versions = value.split(',');
    else if (key === 'alias-proof') options.aliasProof = value;
    else if (key === 'candidate-factory') options.candidateFactory = value;
    else if (key === 'candidate-sha') options.candidateSha = value;
    else if (['out', 'partition', 'tag', 'selection'].includes(key)) options[key] = value;
    else throw Error('Unknown option ' + key);
  }
  return options;
}
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = parse(args);
    if (command === 'init')
      console.log(
        JSON.stringify({
          manifest: path.join(options.out || DEFAULT_OUT, 'manifest.json'),
          games: createManifest(options.out).games.length,
        }),
      );
    else if (command === 'spec') console.log(JSON.stringify(selectionSpec(options), null, 2));
    else if (command === 'alias-proof') console.log(proveAliases(options.out));
    else if (command === 'run') console.log(runBatch(options));
    else
      throw Error(
        'Usage: batch.cjs init [--out DIR] | run --partition train|validation|test [--offset N --limit N --samples N --versions LIST --tag NAME --selection FILE]',
      );
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
module.exports = {
  createManifest,
  runBatch,
  selectionSpec,
  observeMetrics,
  normalized,
  combineRound,
  combinedReport,
  summarize,
  initialEntropy,
  paired,
  parse,
};
