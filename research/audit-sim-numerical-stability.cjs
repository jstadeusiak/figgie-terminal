'use strict';
// Numerical variance only: fixed TRAIN prefixes, no outcome selection/scoring.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Registry = require('../tools/model-registry.cjs');
const A = require('./audit-sim-structure.cjs');
const Current = require('../extension/belief.js');
const V11 = Registry.load('0.11.0');
const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'outputs/opponent-learning-review-2026-10-28');
const IDS = ['s', 'c', 'd', 'h'];
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const mean = (a) => a.reduce((a, b) => a + b, 0) / a.length;
function remap(value, names) {
  if (typeof value === 'string') return names.get(value) || value;
  if (Array.isArray(value)) return value.map((v) => remap(v, names));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [names.get(k) || k, remap(v, names)]),
    );
  return value;
}
function flatten(model, snapshot) {
  const result = {
    expectedPayout: { total: model.expectedPayout },
    goalProbability: {},
    baseFair: {},
    conditionalBonus: {},
    namedTransfer: {},
    baseBookEdge: {},
  };
  for (let s = 0; s < 4; s++) {
    const row = model.bySuit[s];
    const id = IDS[s];
    const market = snapshot.markets[s];
    result.goalProbability[id] = row.probability;
    result.baseFair[id] = row.base;
    result.conditionalBonus[id] = row.conditionalBonus;
    for (let p = 1; p < snapshot.players.length; p++)
      for (const side of ['buy', 'sell']) {
        const value = row.counterparties[snapshot.players[p].name][side];
        if (Number.isFinite(value)) result.namedTransfer[`${id}.peer${p}.${side}`] = value;
      }
    if (Number.isFinite(market.ask) && Number.isFinite(row.buyBase))
      result.baseBookEdge[id + '.buy'] = row.buyBase - market.ask;
    if (Number.isFinite(market.bid) && Number.isFinite(row.sellBase))
      result.baseBookEdge[id + '.sell'] = market.bid - row.sellBase;
  }
  return result;
}
function flattenOracle(oracle, snapshot) {
  const result = {
    expectedPayout: { total: oracle.expectedPayout },
    goalProbability: {},
    baseFair: {},
    conditionalBonus: {},
    namedTransfer: {},
  };
  for (let s = 0; s < 4; s++) {
    const row = oracle.bySuit[s];
    const id = IDS[s];
    result.goalProbability[id] = row.probability;
    result.baseFair[id] = 10 * row.probability;
    result.conditionalBonus[id] = row.conditionalBonus;
    for (let p = 1; p < snapshot.players.length; p++)
      for (const side of ['buy', 'sell'])
        if (Number.isFinite(row[side][p]))
          result.namedTransfer[`${id}.peer${p}.${side}`] = row[side][p];
  }
  return result;
}
function distribution(values, truth) {
  const m = mean(values);
  const sd = Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
  return {
    mean: m,
    sd,
    min: Math.min(...values),
    max: Math.max(...values),
    range: Math.max(...values) - Math.min(...values),
    ...(Number.isFinite(truth)
      ? {
          exact: truth,
          rmse: Math.sqrt(mean(values.map((v) => (v - truth) ** 2))),
          bias: m - truth,
        }
      : {}),
  };
}
function summarize(rows, truth) {
  const result = {};
  for (const group of Object.keys(rows[0])) {
    result[group] = {};
    for (const key of Object.keys(rows[0][group]))
      result[group][key] = distribution(
        rows.map((r) => r[group][key]),
        truth?.[group]?.[key],
      );
  }
  return result;
}
function aggregate(cases, mode) {
  const output = {};
  for (const model of ['v011', 'stratified', 'referenceEss']) {
    output[model] = {};
    for (const group of Object.keys(cases[0].models[model][mode])) {
      const summaries = cases.flatMap((c) => Object.values(c.models[model][mode][group]));
      const withTruth = summaries.filter((r) => Number.isFinite(r.rmse));
      output[model][group] = {
        fields: summaries.length,
        rmsSd: Math.sqrt(mean(summaries.map((r) => r.sd ** 2))),
        meanRange: mean(summaries.map((r) => r.range)),
        maxRange: Math.max(...summaries.map((r) => r.range)),
        ...(withTruth.length
          ? {
              rmseAgainstExact: Math.sqrt(mean(withTruth.map((r) => r.rmse ** 2))),
              maxAbsoluteBias: Math.max(...withTruth.map((r) => Math.abs(r.bias))),
            }
          : {}),
      };
    }
  }
  return output;
}
function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'manifest.json')));
  const data = fs.readFileSync(path.join(SOURCE, 'recordings-combined.ndjson'));
  if (sha(data) !== manifest.datasetSha256) throw Error('Dataset changed');
  const rows = data.toString().trim().split('\n').map(JSON.parse);
  const cases = [];
  const selected = [manifest.partitions.train[0], manifest.partitions.train.at(-1)];
  for (const id of selected) {
    const events = rows.filter((r) => r.roundId === id).sort((a, b) => a.seq - b.seq);
    const metadata = rows.find((r) => r.kind === 'round_metadata' && r.id === id);
    const predictions = V11.Journal.livePredictions(events);
    for (const [label, fraction] of [
      ['mid', 0.5],
      ['late', 0.85],
    ]) {
      const prediction = predictions[Math.floor((predictions.length - 1) * fraction)];
      const prefix = events.filter((e) => e.seq < prediction.seq);
      const snapshot = V11.Training.blindSnapshot(V11.Journal.replay(prefix));
      const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
      const journal = V11.Journal.restore({ ...metadata, snapshot }, prefix);
      const physicalEngine = new V11.Belief.BeliefEngine({ skipPricing: true });
      physicalEngine.build(snapshot, journal.evidence);
      const oracle = flattenOracle(A.exactPhysical(physicalEngine), snapshot);
      const models = {};
      for (const [model, B, options] of [
        ['v011', V11.Belief, {}],
        ['stratified', Current, { goalStratified: true }],
        ['referenceEss', Current, { goalStratified: true, referenceEss: true }],
      ]) {
        const active = [];
        const physical = [];
        for (let salt = 0; salt < 16; salt++) {
          const names = new Map(
            snapshot.players.map((p, i) => [
              p.name,
              (p.name.startsWith('Bot-') ? 'Bot-' : 'Player-') + `Numeric${salt}-Role${i}`,
            ]),
          );
          const renamed = remap(snapshot, names);
          const evidence = remap(journal.evidence, names);
          const learning = remap(prior, names);
          const engine = new B.BeliefEngine({ samples: 512, skipPricing: true, ...options });
          const estimated = engine.infer(renamed, evidence, learning);
          active.push(flatten(estimated, renamed));
          physical.push(
            flatten(engine.infer(renamed, evidence, { ...learning, forceBaseline: true }), renamed),
          );
        }
        models[model] = {
          active: summarize(active),
          physical: summarize(physical, oracle),
          raw: { active, physical },
        };
      }
      cases.push({
        roundId: id,
        label,
        seq: prediction.seq,
        tradeCount: snapshot.trades.length,
        timer: snapshot.timer,
        players: snapshot.players.map((p) => p.name),
        ownStartingHand: snapshot.startingHand,
        held: snapshot.held,
        models,
      });
      process.stderr.write(`Numeric audit ${cases.length}/4 ${id}:${prediction.seq}\n`);
    }
  }
  const result = {
    schema: 1,
    createdAt: new Date().toISOString(),
    method:
      'Four fixed TRAIN prefixes: first and last chronological TRAIN rounds, each at floor((predictionCount-1)*0.5) and floor((predictionCount-1)*0.85). Sixteen consistent name bijections; all Bot prefixes, self, public actors/counterparties, and saved name-keyed priors preserved. No outcome labels read for selection or scoring.',
    samplesPerDeck: 512,
    renamings: 16,
    reference:
      'Exact physical payout/marginal enumeration only for forceBaseline controls; active behavioral forecasts scored only for numerical dispersion. High-budget reference omitted because changing particle budget changes the absolute ESS64 calibration guard.',
    sources: {
      datasetSha256: manifest.datasetSha256,
      v011Bundle: V11.entry.bundleSha256,
      currentBeliefSha256: sha(fs.readFileSync(path.join(ROOT, 'extension/belief.js'))),
    },
    aggregate: { active: aggregate(cases, 'active'), physical: aggregate(cases, 'physical') },
    cases,
  };
  const out =
    process.argv[2] ||
    path.join(ROOT, 'outputs/simulation-audit-2026-10-28/numerical-stability.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      { out, aggregate: result.aggregate, cases: cases.map(({ models, ...c }) => c) },
      null,
      2,
    ),
  );
}
main();
