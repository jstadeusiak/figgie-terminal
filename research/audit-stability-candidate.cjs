#!/usr/bin/env node
'use strict';
/* Causal full-path comparison. All outcome-dependent scoring runs after inference. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Registry = require('../tools/model-registry.cjs');
const { loadCurrent } = require('./compare-recorded-candidate.cjs');
const Values = require('./pp-value-audit.cjs');
const IDS = ['s', 'c', 'd', 'h'];
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const copy = (x) => JSON.parse(JSON.stringify(x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const remaining = (timer) =>
  typeof timer === 'string' && /^\d+:\d\d$/.test(timer)
    ? timer
        .split(':')
        .map(Number)
        .reduce((a, b) => 60 * a + b)
    : null;
const maxDelta = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])));
const tv = (p, q) => p.reduce((sum, v, i) => sum + Math.abs(v - q[i]), 0) / 2;
function top(p) {
  const order = p.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  return order[0].v - order[1].v > 1e-10 ? order[0].i : null;
}
function probabilityMetrics(p, g) {
  return {
    brier: p.reduce((sum, v, i) => sum + (v - Number(i === g)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-12, p[g])),
    goalProbability: p[g],
    correct: top(p) === g ? 1 : 0,
  };
}
function groups(events) {
  const out = [];
  for (let i = 0; i < events.length;) {
    const start = i;
    const at = events[i].at;
    while (i < events.length && events[i].at === at) i++;
    out.push({ start, end: i, at, events: events.slice(start, i) });
  }
  return out;
}
function regularGrid(points, ms = 1000) {
  if (points.length < 2) return points;
  const out = [points[0]];
  let cursor = 0;
  let previous = 0;
  for (let at = points[0].at + ms; at <= points.at(-1).at; at += ms) {
    while (cursor + 1 < points.length && points[cursor + 1].at <= at) cursor++;
    const between = points.slice(previous + 1, cursor + 1);
    out.push({
      ...points[cursor],
      at,
      coverageGap:
        between.some((p) => p.coverageGap) ||
        (!!points[cursor + 1]?.coverageGap && at > points[cursor].at),
    });
    previous = cursor;
  }
  return out;
}
function volatility(points, modelIds) {
  const durationMinutes =
    points
      .slice(1)
      .reduce((sum, p, i) => sum + (p.coverageGap ? 0 : Math.max(0, p.at - points[i].at)), 0) /
    60000;
  return Object.fromEntries(
    modelIds.map((id) => {
      let totalVariationPp = 0;
      let jumps5 = 0;
      let jumps10 = 0;
      let favoriteFlips = 0;
      let maxJumpPp = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (b.at <= a.at || b.coverageGap) continue;
        const p = a.models[id];
        const q = b.models[id];
        const jump = 100 * maxDelta(p, q);
        totalVariationPp += 100 * tv(p, q);
        jumps5 += Number(jump >= 5);
        jumps10 += Number(jump >= 10);
        maxJumpPp = Math.max(maxJumpPp, jump);
        favoriteFlips += Number(top(p) !== null && top(q) !== null && top(p) !== top(q));
      }
      return [
        id,
        {
          totalVariationPp,
          totalVariationPpPerMinute: durationMinutes ? totalVariationPp / durationMinutes : null,
          jumps5,
          jumps10,
          favoriteFlips,
          maxJumpPp,
          durationMinutes,
        },
      ];
    }),
  );
}
function scores(points, events, goal, modelIds) {
  const g = IDS.indexOf(goal);
  if (g < 0) return null;
  const lastLive =
    events
      .filter(
        (e) => ['state', 'clock'].includes(e.kind) && e.status === 'live' && remaining(e.timer) > 0,
      )
      .at(-1)?.at ?? points.at(-1)?.at;
  return Object.fromEntries(
    modelIds.map((id) => {
      const eventMetrics = points.map((p) => probabilityMetrics(p.models[id], g));
      const clock = [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const end = points[i + 1]?.at ?? lastLive;
        const seconds = Math.max(0, (end - p.at) / 1000);
        const gap = events.some(
          (e) =>
            e.seq > p.seq &&
            e.at <= end &&
            e.kind === 'coverage' &&
            (e.gapSeconds > 2 || e.status !== 'live'),
        );
        if (seconds && !gap) clock.push({ seconds, ...probabilityMetrics(p.models[id], g) });
      }
      const seconds = clock.reduce((sum, p) => sum + p.seconds, 0);
      const keys = ['brier', 'logLoss', 'goalProbability', 'correct'];
      return [
        id,
        {
          eventWeighted: Object.fromEntries(
            keys.map((k) => [k, mean(eventMetrics.map((p) => p[k]))]),
          ),
          clockWeighted: {
            seconds,
            ...Object.fromEntries(
              keys.map((k) => [
                k,
                seconds ? clock.reduce((sum, p) => sum + p.seconds * p[k], 0) / seconds : null,
              ]),
            ),
          },
        },
      ];
    }),
  );
}
function checkModel(model) {
  const p = Array.from(model.bySuit, (s) => s.probability);
  if (
    p.length !== 4 ||
    p.some((v) => !Number.isFinite(v) || v < -1e-9) ||
    Math.abs(p.reduce((a, b) => a + b, 0) - 1) > 1e-6
  )
    throw Error('Invalid probabilities');
  if (model.bySuit.some((s, i) => Math.abs(s.base - 10 * p[i]) > 1e-7))
    throw Error('Base fair/probability inconsistency');
  if (Math.abs(model.expectedPayout - model.bySuit.reduce((sum, s) => sum + s.holding, 0)) > 1e-6)
    throw Error('Inventory payout inconsistency');
  return p;
}
function priceModel(model) {
  return {
    expectedPayout: model.expectedPayout,
    expectedBase: model.expectedBase,
    expectedBonus: model.expectedBonus,
    bySuit: model.bySuit.map((s) => ({
      conditionalBonus: s.conditionalBonus,
      counterparties: copy(s.counterparties),
    })),
  };
}
function inferRound(round, bundles, protocol) {
  const baseline = bundles.baseline.release;
  const J = baseline.Journal;
  const events = round.events;
  const m = round.metadata;
  if (J.isPractice(m, events) || events.some((e, i) => e.seq !== i + 1))
    throw Error('Practice/incomplete recording: ' + round.id);
  const models = Object.keys(bundles);
  const engines = Object.fromEntries(
    models.map((id) => [
      id,
      new bundles[id].release.Belief.BeliefEngine({
        samples: 512,
        skipPricing: true,
        ...bundles[id].options,
      }),
    ]),
  );
  const live = J.livePredictions(events).filter(
    (p) => remaining(J.replay(events.filter((e) => e.seq < p.seq)).timer) > 0,
  );
  const n = Math.min(12, live.length);
  const selected = new Set(
    Array.from(
      { length: n },
      (_, i) => live[Math.round((i * (live.length - 1)) / Math.max(1, n - 1))].seq,
    ),
  );
  const predictionMap = new Map(live.map((p) => [p.seq, p]));
  const points = [];
  const valueRaw = [];
  const predictionChecks = [];
  const timings = Object.fromEntries(models.map((id) => [id, []]));
  let lastKey = '';
  let lastSeq = 0;
  for (const group of groups(events)) {
    const pred = group.events.find((e) => predictionMap.has(e.seq));
    if (!pred && !group.events.some((e) => ['state', 'checkpoint', 'round_start'].includes(e.kind)))
      continue;
    const end = pred ? events.findIndex((e) => e.seq === pred.seq) : group.end;
    const prefix = events.slice(0, end);
    const replay = J.replay(prefix);
    const last = prefix.at(-1);
    const exact =
      pred &&
      last?.kind === 'training_source' &&
      last.at === pred.at &&
      last.snapshot?.roundKey === replay?.roundKey &&
      last.snapshot?.trades?.length === pred.tradeCount;
    const snapshot = baseline.Training.blindSnapshot(exact ? last.snapshot : replay);
    if (
      !snapshot ||
      snapshot.status !== 'live' ||
      remaining(snapshot.timer) <= 0 ||
      prefix.some((e) => ['reveal', 'reveal_verified', 'settlement_pending'].includes(e.kind))
    )
      continue;
    if (pred && snapshot.trades.length !== pred.tradeCount)
      throw Error('Prediction source mismatch ' + round.id + ':' + pred.seq);
    const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
    const journal = J.restore(
      {
        id: round.id,
        base: m.base,
        snapshot: replay,
        observedAt: group.at,
        ...(pred ? { rates: pred.rates } : {}),
      },
      prefix,
    );
    // Full public evidence, rather than only baseline-selected entries, is necessary
    // because a candidate's fading tail deliberately retains extra old entries.
    const key = JSON.stringify([
      snapshot.context,
      snapshot.startingHand,
      snapshot.net,
      journal.evidence,
      prior,
      snapshot.players.map((p) => p.name),
      snapshot.markets.map((s) => [s.ask, s.bid, s.seller, s.buyer]),
    ]);
    if (key === lastKey && !pred) continue;
    const inferred = {};
    const probabilities = {};
    const times = {};
    // Alternate order deterministically to reduce shared CPU-order timing bias.
    const order = points.length % 2 ? models.slice().reverse() : models;
    for (const id of order) {
      const start = performance.now();
      inferred[id] = engines[id].infer(copy(snapshot), copy(journal.evidence), copy(prior));
      times[id] = performance.now() - start;
      timings[id].push(times[id]);
      probabilities[id] = checkModel(inferred[id]);
    }
    const structural = Array.from(inferred.baseline.baseline.probabilities);
    for (const id of models)
      if (maxDelta(structural, inferred[id].baseline.probabilities) > 1e-10)
        throw Error('Structural probabilities changed: ' + id);
    if (pred?.modelVersion === '0.13.0')
      predictionChecks.push({
        seq: pred.seq,
        maxError: maxDelta(probabilities.baseline, pred.probabilities),
      });
    if (pred && selected.has(pred.seq))
      valueRaw.push({
        seq: pred.seq,
        snapshot: copy(snapshot),
        models: Object.fromEntries(models.map((id) => [id, priceModel(inferred[id])])),
      });
    if (key === lastKey) continue;
    const since = prefix.filter((e) => e.seq > lastSeq);
    const fills = since.filter((e) => e.kind === 'fill').length;
    const structuralJumpPp = points.length
      ? 100 * maxDelta(structural, points.at(-1).structural)
      : 0;
    points.push({
      seq: prefix.at(-1).seq,
      at: group.at,
      timer: snapshot.timer,
      tradeCount: snapshot.trades.length,
      structural,
      models: probabilities,
      elapsedMs: times,
      exactSource: !!exact,
      kind: fills ? 'fill' : structuralJumpPp > 1e-6 ? 'inventory-bound' : 'quotes/evidence',
      structuralJumpPp,
      coverageGap: since.some(
        (e) => e.kind === 'coverage' && (e.gapSeconds > 2 || e.status !== 'live'),
      ),
    });
    lastKey = key;
    lastSeq = prefix.at(-1).seq;
  }
  // Outcome information enters only below, after every candidate forecast.
  const official =
    m.revealed?.verified && m.revealed.source === 'official-round-rankings' ? m.revealed : null;
  const labels = official ? Values.prepareRound(m, events) : null;
  const valuePoints = labels
    ? valueRaw.map((p) => Values.makePoint(labels, p.seq, p.snapshot, p.models))
    : [];
  return {
    id: round.id,
    goal: official?.goal ?? null,
    context: m.snapshot.context,
    status: m.snapshot.status,
    points,
    valuePoints,
    predictionChecks,
    properScores: scores(points, events, official?.goal, models),
    volatility: {
      event: volatility(points, models),
      oneSecond: volatility(regularGrid(points), models),
    },
    timings,
  };
}
function aggregate(rounds, modelIds) {
  return {
    models: Object.fromEntries(
      modelIds.map((id) => {
        const scoreRows = rounds.filter((r) => r.properScores);
        const clock = scoreRows.map((r) => r.properScores[id].clockWeighted);
        const event = scoreRows.map((r) => r.properScores[id].eventWeighted);
        const times = rounds.flatMap((r) => r.timings[id]).sort((a, b) => a - b);
        const vol = rounds
          .filter((r) => r.points.length > 2)
          .map((r) => r.volatility.oneSecond[id]);
        return [
          id,
          {
            rounds: rounds.length,
            labelledRounds: scoreRows.length,
            prefixes: rounds.reduce((n, r) => n + r.points.length, 0),
            clock: Object.fromEntries(
              ['brier', 'logLoss', 'goalProbability', 'correct'].map((k) => [
                k,
                mean(clock.map((s) => s[k])),
              ]),
            ),
            event: Object.fromEntries(
              ['brier', 'logLoss', 'goalProbability', 'correct'].map((k) => [
                k,
                mean(event.map((s) => s[k])),
              ]),
            ),
            oneSecond: {
              totalVariationPpPerMinute: mean(vol.map((v) => v.totalVariationPpPerMinute)),
              jumps5: vol.reduce((n, v) => n + v.jumps5, 0),
              favoriteFlips: vol.reduce((n, v) => n + v.favoriteFlips, 0),
            },
            computeMs: {
              calls: times.length,
              median: times[Math.floor(times.length / 2)] ?? null,
              p95: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] ?? null,
              max: times.at(-1) ?? null,
            },
          },
        ];
      }),
    ),
    values: Values.summarize(
      rounds.flatMap((r) => r.valuePoints),
      modelIds,
    ),
  };
}
function run(protocolPath, partition, selectedIds, shard) {
  const bytes = fs.readFileSync(protocolPath);
  const protocol = JSON.parse(bytes);
  const out = path.dirname(protocolPath);
  const baseline = Registry.load('0.13.0');
  if (baseline.entry.bundleSha256 !== protocol.baselineBundleSha256)
    throw Error('Baseline hash changed');
  for (const source of protocol.sources)
    if (sha(fs.readFileSync(source.file)) !== source.sha256)
      throw Error('Source changed: ' + source.file);
  for (const [file, expected] of Object.entries(protocol.scorerFiles)) {
    if (sha(fs.readFileSync(path.resolve(__dirname, '..', file))) !== expected)
      throw Error('Scorer changed: ' + file);
  }
  const specs = protocol.candidates.filter((s) => !selectedIds || selectedIds.includes(s.id));
  const bundles = { baseline: { release: baseline, options: {} } };
  for (const s of specs) {
    const release = loadCurrent(s.folder);
    if (JSON.stringify(release.hashes) !== JSON.stringify(s.hashes))
      throw Error('Candidate hash changed: ' + s.id);
    bundles[s.id] = { release, options: s.options };
  }
  const ids = protocol.partitions[partition];
  if (!ids) throw Error('Unknown partition ' + partition);
  const source = Registry.readDataset(protocol.sources.map((s) => s.file));
  const byId = new Map(source.rounds.map((r) => [r.id, r]));
  const rounds = [];
  const runnerSha256 = sha(fs.readFileSync(__filename));
  const key = sha(
    JSON.stringify({
      protocol: sha(bytes),
      runnerSha256,
      partition,
      models: Object.keys(bundles),
    }),
  );
  const cacheDir = path.join(out, 'round-cache', key);
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const [i, id] of ids.entries()) {
    if (shard && i % shard.total !== shard.index) continue;
    const file = path.join(cacheDir, id + '.json');
    const row = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file))
      : inferRound(byId.get(id), bundles, protocol);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(row) + '\n');
    rounds.push(row);
    process.stderr.write(
      `${partition} ${i + 1}/${ids.length}: ${id}, ${row.points.length} prefixes\n`,
    );
  }
  if (shard) {
    const result = { partition, shard, cachedRounds: rounds.length, cacheDir, runnerSha256 };
    console.log(JSON.stringify(result));
    return result;
  }
  const result = {
    schema: 1,
    createdAt: new Date().toISOString(),
    protocolSha256: sha(bytes),
    runnerSha256,
    partition,
    modelIds: Object.keys(bundles),
    method: protocol.method,
    summary: aggregate(rounds, Object.keys(bundles)),
    rounds,
  };
  const file = path.join(out, partition + '-' + Object.keys(bundles).join('-') + '.json');
  fs.writeFileSync(file, JSON.stringify(result) + '\n');
  console.log(
    JSON.stringify(
      {
        output: file,
        models: result.summary.models,
        inventory: result.summary.values.inventory.total.summary,
        quotes: result.summary.values.quoteValues.total.summary,
        conditionalBonus: result.summary.values.conditionalBonus.summary,
      },
      null,
      2,
    ),
  );
  return result;
}
module.exports = { run, inferRound, aggregate, regularGrid, volatility, scores };
if (require.main === module) {
  try {
    const parts = process.argv[5]?.split('/').map(Number);
    const shard = parts ? { index: parts[0], total: parts[1] } : null;
    if (
      shard &&
      (!Number.isInteger(shard.index) ||
        !Number.isInteger(shard.total) ||
        shard.total < 1 ||
        shard.index < 0 ||
        shard.index >= shard.total)
    )
      throw Error('Invalid shard');
    run(path.resolve(process.argv[2]), process.argv[3], process.argv[4]?.split(','), shard);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
