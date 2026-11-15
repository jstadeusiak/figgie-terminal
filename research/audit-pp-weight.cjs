#!/usr/bin/env node
'use strict';
// Frozen recorded-path experiment. Outcome labels enter only after inference.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const R = require('../tools/model-registry.cjs');
const V = require('./pp-value-audit.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/pp-weight-review-2026-10-30');
const GOAL_HELPER = path.join(ROOT, 'models/0.13.0/goal-signal.js');
const G = require(GOAL_HELPER);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const copy = (x) => JSON.parse(JSON.stringify(x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const IDS = ['s', 'c', 'd', 'h'];
function target(model, spec) {
  if (
    spec.kind === 'identity' ||
    model.behavior.group !== 'bots:Medium' ||
    model.currentInventory.length !== 4 ||
    model.minimum.length !== 4
  )
    return model.bySuit.map((s) => s.probability);
  const blend = model.behavior.blend;
  if (blend === 0 || blend === 0.1) return model.bySuit.map((s) => s.probability);
  return G.targetProbabilities(
    model.baseline.probabilities,
    model.behavior.probabilities,
    spec,
    spec.kind === 'raw' ? 1 : blend,
  );
}
function ownership(engine, model) {
  const p = model.bySuit.map((s) => s.probability);
  const H = engine.latest.names.map(() => IDS.map(() => [0, 0, 0, 0]));
  engine.latest.worlds.forEach((w, i) => {
    const g = w.goal;
    if (!p[g]) return;
    const weight = engine.latest.weights[i] / p[g];
    for (let a = 1; a < H.length; a++)
      for (let s = 0; s < 4; s++)
        if (w.initial[a][s] + engine.state.net[a][s] > 0) H[a][s][g] += weight;
  });
  return H;
}
function revalue(model, snapshot, H, names, p) {
  const bySuit = model.bySuit.map((v, s) => {
    const ratio = v.probability ? p[s] / v.probability : 0;
    const counterparties = {};
    for (let a = 1; a < names.length; a++) {
      const old = v.counterparties[names[a]];
      const mass = H[a][s].reduce((n, h, g) => n + h * p[g], 0);
      const buy = mass ? (old.buy * old.hasCardProbability * ratio) / mass : null;
      const buyBase = mass ? (old.buyBase * old.hasCardProbability * ratio) / mass : null;
      const sell = old.sell * ratio;
      const sellBase = old.sellBase * ratio;
      counterparties[names[a]] = {
        ...old,
        buy,
        buyBase,
        buyBonus: buy === null ? null : buy - buyBase,
        sell,
        sellBase,
        sellBonus: sell - sellBase,
        hasCardProbability: mass,
      };
    }
    const out = {
      ...v,
      probability: p[s],
      base: 10 * p[s],
      holding: v.holding * ratio,
      counterparties,
    };
    for (const field of ['buy', 'buyBase', 'buyBonus'])
      out[field] = counterparties[snapshot.markets[s].seller]?.[field] ?? null;
    for (const field of ['sell', 'sellBase', 'sellBonus'])
      out[field] = counterparties[snapshot.markets[s].buyer]?.[field] ?? null;
    return out;
  });
  const expectedPayout = bySuit.reduce((n, v) => n + v.holding, 0);
  const expectedBase = bySuit.reduce((n, v, s) => n + v.base * snapshot.held[s], 0);
  return {
    ...model,
    bySuit,
    expectedPayout,
    expectedBase,
    expectedBonus: expectedPayout - expectedBase,
  };
}
function pointScores(p, g) {
  const max = Math.max(...p);
  const winners = p.map((x, i) => (Math.abs(x - max) < 1e-12 ? i : -1)).filter((i) => i >= 0);
  return {
    brier: p.reduce((n, x, i) => n + (x - Number(i === g)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-12, p[g])),
    correct: winners.includes(g) ? 1 / winners.length : 0,
    goalProbability: p[g],
  };
}
function summarize(rounds, specs) {
  const models = {};
  for (const spec of specs) {
    const rows = rounds.map((r) => ({
      id: r.id,
      ...Object.fromEntries(
        ['brier', 'logLoss', 'correct', 'goalProbability'].map((k) => [
          k,
          mean(r.points.map((p) => p.models[spec.id][k])),
        ]),
      ),
    }));
    models[spec.id] = {
      rounds: rows.length,
      checkpoints: rounds.reduce((n, r) => n + r.points.length, 0),
      ...Object.fromEntries(
        ['brier', 'logLoss', 'correct', 'goalProbability'].map((k) => [
          k,
          mean(rows.map((r) => r[k])),
        ]),
      ),
      perRound: rows,
    };
  }
  return {
    models,
    values: V.summarize(
      rounds.flatMap((r) => r.valuePoints),
      specs.map((s) => s.id),
    ),
  };
}
function run(partition, selected) {
  const protocol = JSON.parse(fs.readFileSync(path.join(OUT, 'protocol.json')));
  const cohort = JSON.parse(fs.readFileSync(path.join(OUT, 'cohort.json')));
  if (sha(fs.readFileSync(path.join(OUT, 'cohort.json'))) !== protocol.cohortSha256)
    throw Error('Frozen cohort changed');
  const source = fs.readFileSync(path.join(OUT, 'recordings.ndjson'));
  if (sha(source) !== protocol.sourceSha256) throw Error('Frozen corpus changed');
  const release = R.load(protocol.baseline);
  const J = release.Journal;
  const ids = cohort.partitions[partition];
  if (!ids) throw Error('Unknown partition');
  const specs = selected
    ? protocol.candidates.filter((s) => selected.includes(s.id))
    : protocol.candidates;
  if (!specs.some((s) => s.id === 'current')) throw Error('Include current baseline');
  const data = R.readDataset([path.join(OUT, 'recordings.ndjson')]);
  const byId = new Map(data.rounds.map((r) => [r.id, r]));
  const rounds = [];
  for (const [ri, id] of ids.entries()) {
    const { metadata: m, events } = byId.get(id);
    const preds = J.livePredictions(events);
    const indices = [
      ...new Set(
        Array.from({ length: Math.min(12, preds.length) }, (_, i) =>
          Math.round((i * (preds.length - 1)) / Math.max(1, Math.min(12, preds.length) - 1)),
        ),
      ),
    ];
    const engine = new release.Belief.BeliefEngine({ samples: 512, skipPricing: true });
    const points = [];
    const valueRaw = [];
    const g = IDS.indexOf(m.revealed.goal);
    if (g < 0 || J.isPractice(m, events) || events.some((e, i) => e.seq !== i + 1))
      throw Error('Invalid frozen round');
    for (const index of indices) {
      const pred = preds[index];
      const prefix = events.filter((e) => e.seq < pred.seq);
      const replayed = J.replay(prefix);
      const last = prefix.at(-1);
      const exact =
        last?.kind === 'training_source' &&
        last.at === pred.at &&
        last.snapshot?.roundKey === replayed.roundKey &&
        last.snapshot?.trades?.length === pred.tradeCount;
      const snapshot = release.Training.blindSnapshot(exact ? last.snapshot : replayed);
      if (snapshot.status !== 'live' || snapshot.trades.length !== pred.tradeCount)
        throw Error('Invalid causal checkpoint');
      const prior = copy(prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {});
      const journal = J.restore(
        { id, base: m.base, snapshot: replayed, observedAt: pred.at, rates: pred.rates },
        prefix,
      );
      const start = performance.now();
      const model = engine.infer(snapshot, journal.evidence, prior);
      const elapsedMs = performance.now() - start;
      const H = ownership(engine, model);
      const models = {};
      const scores = {};
      for (const spec of specs) {
        const p = target(model, spec);
        models[spec.id] =
          spec.kind === 'identity' ? model : revalue(model, snapshot, H, engine.latest.names, p);
        scores[spec.id] = { probabilities: Array.from(p), ...pointScores(p, g) };
      }
      points.push({
        seq: pred.seq,
        at: pred.at,
        timer: snapshot.timer,
        tradeCount: pred.tradeCount,
        exactSource: exact,
        structural: Array.from(model.baseline.probabilities),
        raw: Array.from(model.behavior.probabilities),
        blend: model.behavior.blend,
        observations: model.behavior.observations,
        elapsedMs,
        models: scores,
      });
      valueRaw.push({ seq: pred.seq, snapshot, models });
    }
    // Full results are available only to this scorer, after predictions finish.
    const labels = V.prepareRound(m, events);
    const valuePoints = valueRaw.map((p) => V.makePoint(labels, p.seq, p.snapshot, p.models));
    rounds.push({ id, goal: m.revealed.goal, points, valuePoints });
    process.stderr.write(`${partition} ${ri + 1}/${ids.length} ${id}\n`);
  }
  const result = {
    schema: 1,
    partition,
    createdAt: new Date().toISOString(),
    protocolSha256: sha(fs.readFileSync(path.join(OUT, 'protocol.json'))),
    cohortSha256: sha(fs.readFileSync(path.join(OUT, 'cohort.json'))),
    runnerSha256: sha(fs.readFileSync(__filename)),
    goalHelperSha256: sha(fs.readFileSync(GOAL_HELPER)),
    baseline: release.entry.bundleSha256,
    specs,
    summary: summarize(rounds, specs),
    rounds,
  };
  const file = path.join(OUT, partition + '.json');
  fs.writeFileSync(file, JSON.stringify(result) + '\n');
  console.log(
    JSON.stringify(
      {
        file,
        models: Object.fromEntries(
          Object.entries(result.summary.models).map(([id, m]) => [
            id,
            { ...m, perRound: undefined },
          ]),
        ),
        inventory: result.summary.values.inventory.total.summary,
        quote: result.summary.values.quoteValues.total.summary,
      },
      null,
      2,
    ),
  );
  return result;
}
module.exports = { target, ownership, revalue, pointScores, summarize, run };
if (require.main === module) run(process.argv[2], process.argv[3]?.split(','));
