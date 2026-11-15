/* Offline, causal comparison. Outcome labels never enter inference. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/opponent-learning-review-2026-10-28');
const folder = path.join(ROOT, 'extension');
const IDS = ['s', 'c', 'd', 'h'];
const J0 = require(path.join(folder, 'journal-v0.10.js'));
const Score = require(path.join(folder, 'bonus-score.js'));
const Pnl = require(path.join(folder, 'pnl.js'));
const Training = require(path.join(folder, 'training.js'));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const copy = (x) => JSON.parse(JSON.stringify(x));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const write = (name, value) =>
  fs.writeFileSync(
    path.join(OUT, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
  );
const diagnostics = new Set(['round-1793241016120-8b6d8314', 'round-1793243309089-b6a773d9']);
function prepare(sources) {
  if (!sources?.length)
    throw Error(
      'Usage: node research/audit-opponent-learning.cjs prepare RECORDING.ndjson [RECORDING.ndjson ...]',
    );
  fs.mkdirSync(OUT, { recursive: true });
  const rounds = new Map();
  const conflicts = [];
  const inventory = [];
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const rows = text.trim().split('\n').filter(Boolean).map(JSON.parse);
    const seen = new Set();
    for (const r of rows) {
      if (!['round_metadata'].includes(r.kind) && !r.roundId) continue;
      const id = r.kind === 'round_metadata' ? r.id : r.roundId;
      seen.add(id);
      if (!rounds.has(id)) rounds.set(id, { id, metas: [], events: new Map(), sources: new Set() });
      const round = rounds.get(id);
      round.sources.add(file);
      if (r.kind === 'round_metadata') {
        round.metas.push(r);
        continue;
      }
      const key = r.id || id + ':' + r.seq;
      const old = round.events.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(r)) {
        conflicts.push({ roundId: id, eventId: key, source: file });
        continue;
      }
      round.events.set(key, r);
    }
    inventory.push({
      path: file,
      sha256: sha(text),
      bytes: Buffer.byteLength(text),
      rounds: seen.size,
    });
  }
  const selected = [];
  const excluded = [];
  const data = [];
  for (const r of rounds.values()) {
    const events = [...r.events.values()].sort((a, b) => a.seq - b.seq);
    const metas = r.metas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const m = metas[0];
    if (!m) {
      excluded.push({ id: r.id, reason: 'No metadata' });
      continue;
    }
    const at = events[0]?.at || Number(r.id.split('-')[1]);
    const reveal = m.revealed;
    let reason = null;
    if (J0.isPractice(m, events)) reason = 'Practice/exposed hands';
    else if (
      !reveal?.verified ||
      reveal.source !== 'official-round-rankings' ||
      !IDS.includes(reveal.goal)
    )
      reason = 'No verified official result';
    else if (m.snapshot?.status !== 'ended') reason = 'Not a completed round';
    else if (!J0.livePredictions(events).length) reason = 'No live pre-reveal predictions';
    else if (events.some((e, i) => e.seq !== i + 1)) reason = 'Incomplete event sequence';
    else if (conflicts.some((c) => c.roundId === r.id))
      reason = 'Conflicting duplicate event records';
    const predictions = J0.livePredictions(events);
    const bonus = Score.auditRound({ ...m, events });
    const descriptor = {
      id: r.id,
      at,
      version: m.version,
      difficulty: m.snapshot?.context?.botDifficulty || 'unknown',
      players: m.snapshot?.players?.length,
      goal: reveal?.goal,
      predictions: predictions.length,
      events: events.length,
      bonusEligible: !!bonus.score,
      bonusExclusion: bonus.reason || null,
      sources: [...r.sources],
    };
    if (reason) excluded.push({ ...descriptor, reason });
    else selected.push(descriptor);
    data.push({ ...m, kind: 'round_metadata' }, ...events);
  }
  selected.sort((a, b) => a.at - b.at);
  const ordinary = selected.filter((r) => !diagnostics.has(r.id));
  const trainEnd = Math.floor(ordinary.length * 0.6);
  const validationEnd = trainEnd + Math.floor(ordinary.length * 0.2);
  const partitions = {
    train: ordinary.slice(0, trainEnd).map((r) => r.id),
    validation: ordinary.slice(trainEnd, validationEnd).map((r) => r.id),
    test: ordinary.slice(validationEnd).map((r) => r.id),
    diagnostic: selected.filter((r) => diagnostics.has(r.id)).map((r) => r.id),
  };
  const ndjson = data.map(JSON.stringify).join('\n') + '\n';
  const manifest = {
    preparedAt: new Date().toISOString(),
    method:
      'Deduplicate round and immutable event IDs; latest metadata. Freeze chronological 60/20/20 candidate-development split before candidate output. The two motivating recent rounds are diagnostic-only. Earlier rounds have been seen in previous model development, so this is not a new prospective trial.',
    sources: inventory,
    conflicts,
    selected,
    excluded,
    partitions,
    datasetSha256: sha(ndjson),
  };
  write('recordings-combined.ndjson', ndjson);
  write('manifest.json', manifest);
  console.log(
    JSON.stringify(
      {
        segments: rounds.size,
        eligible: selected.length,
        excluded: excluded.length,
        conflicts: conflicts.length,
        partitions: Object.fromEntries(Object.entries(partitions).map(([k, v]) => [k, v.length])),
        difficulty: Object.fromEntries(
          [...new Set(selected.map((r) => r.difficulty))].map((d) => [
            d,
            selected.filter((r) => r.difficulty === d).length,
          ]),
        ),
        bonusEligible: selected.filter((r) => r.bonusEligible).length,
      },
      null,
      2,
    ),
  );
}
function pointMetric(p, g) {
  return {
    brier: sum(p.map((v, i) => (v - Number(i === g)) ** 2)),
    logLoss: -Math.log(Math.max(1e-12, p[g])),
    actualGoalP: p[g],
    top: p.indexOf(Math.max(...p)),
    confidence: Math.max(...p),
  };
}
function calibration(rounds, key) {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: i / 10,
    to: (i + 1) / 10,
    weight: 0,
    probability: 0,
    frequency: 0,
  }));
  for (const r of rounds)
    for (const p of r.points) {
      const weight = 1 / r.points.length;
      for (let s = 0; s < 4; s++) {
        const v = p.models[key].probabilities[s];
        const b = bins[Math.min(9, Math.floor(v * 10))];
        b.weight += weight;
        b.probability += weight * v;
        b.frequency += weight * Number(IDS[s] === r.goal);
      }
    }
  return bins
    .filter((b) => b.weight)
    .map((b) => ({
      ...b,
      probability: b.probability / b.weight,
      frequency: b.frequency / b.weight,
    }));
}
function aggregate(rounds, keys) {
  return Object.fromEntries(
    keys.map((key) => {
      const scored = rounds.filter((r) => r.points.length);
      const bonus = rounds.map((r) => r.bonus[key]?.score).filter(Boolean);
      return [
        key,
        {
          rounds: scored.length,
          checkpoints: sum(scored.map((r) => r.points.length)),
          brier: mean(scored.map((r) => mean(r.points.map((p) => p.models[key].metric.brier)))),
          logLoss: mean(scored.map((r) => mean(r.points.map((p) => p.models[key].metric.logLoss)))),
          meanActualGoalP: mean(
            scored.map((r) => mean(r.points.map((p) => p.models[key].metric.actualGoalP))),
          ),
          finalCorrect: sum(
            scored.map((r) =>
              Number(r.points.at(-1).models[key].metric.top === IDS.indexOf(r.goal)),
            ),
          ),
          bonusRounds: bonus.length,
          bonusCheckpoints: sum(bonus.map((b) => b.checkpoints)),
          bonusMae: mean(bonus.map((b) => b.bonusMae)),
          bonusBias: mean(bonus.map((b) => b.bonusBias)),
          bonusCategoryBrier: mean(bonus.map((b) => b.categoryBrier).filter(Number.isFinite)),
          bonusLeaderBrier: mean(bonus.map((b) => b.leaderBrier).filter(Number.isFinite)),
          calibration: calibration(scored, key),
        },
      ];
    }),
  );
}
function distribution(a) {
  a = a.filter(Number.isFinite).sort((x, y) => x - y);
  return {
    count: a.length,
    min: a[0] ?? null,
    median: a[Math.floor(a.length * 0.5)] ?? null,
    p90: a[Math.floor(a.length * 0.9)] ?? null,
    p95: a[Math.floor(a.length * 0.95)] ?? null,
    max: a.at(-1) ?? null,
  };
}
function paired(rounds, keys) {
  return Object.fromEntries(
    keys
      .filter((k) => k !== 'baseline')
      .map((k) => {
        const values = rounds
          .filter((r) => r.points.length)
          .map((r) =>
            mean(r.points.map((p) => p.models[k].metric.brier - p.models.baseline.metric.brier)),
          );
        const bootstrap = [];
        let state = 0x27a1d5;
        const random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 4294967296;
        };
        if (values.length)
          for (let j = 0; j < 2000; j++)
            bootstrap.push(mean(values.map(() => values[Math.floor(random() * values.length)])));
        bootstrap.sort((a, b) => a - b);
        return [
          k,
          {
            meanRoundBrierChange: mean(values),
            improved: values.filter((v) => v < 0).length,
            worsened: values.filter((v) => v > 0).length,
            unchanged: values.filter((v) => v === 0).length,
            bootstrap95: [
              bootstrap[Math.floor(bootstrap.length * 0.025)] ?? null,
              bootstrap[Math.floor(bootstrap.length * 0.975)] ?? null,
            ],
            note: 'Round bootstrap is descriptive; repeated players and rounds are not necessarily independent.',
          },
        ];
      }),
  );
}
async function evaluate(phase, variantFile) {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json')));
  const raw = fs.readFileSync(path.join(OUT, 'recordings-combined.ndjson'), 'utf8');
  if (sha(raw) !== manifest.datasetSha256) throw Error('Dataset changed after partition lock');
  const rows = raw.trim().split('\n').map(JSON.parse);
  const by = new Map();
  for (const row of rows) {
    const id = row.kind === 'round_metadata' ? row.id : row.roundId;
    if (!by.has(id)) by.set(id, { events: [] });
    if (row.kind === 'round_metadata') by.get(id).metadata = row;
    else by.get(id).events.push(row);
  }
  const variants = variantFile
    ? JSON.parse(fs.readFileSync(variantFile))
    : { candidate: { opponentLearning: true } };
  const keys = ['baseline', ...Object.keys(variants)];
  const ids =
    phase === 'all'
      ? Object.values(manifest.partitions).flat()
      : phase === 'smoke'
        ? manifest.partitions.train.slice(0, 1)
        : manifest.partitions[phase];
  if (!ids) throw Error('Unknown phase ' + phase);
  const B0 = require(path.join(folder, 'belief-v0.10.js'));
  const B = require(path.join(folder, 'belief.js'));
  const J = require(path.join(folder, 'journal.js'));
  const results = [];
  const evaluatedSourceHashes = sourceHashes();
  const timing = Object.fromEntries(keys.map((k) => [k, []]));
  for (const id of ids) {
    const { metadata: m, events: es } = by.get(id);
    const predictions = J0.livePredictions(es);
    const g = IDS.indexOf(m.revealed.goal);
    const engines = {
      baseline: new B0.BeliefEngine({ skipPricing: true }),
      ...Object.fromEntries(
        Object.entries(variants).map(([k, options]) => [
          k,
          new B.BeliefEngine({ skipPricing: true, ...options }),
        ]),
      ),
    };
    const points = [];
    const replacement = Object.fromEntries(keys.map((k) => [k, new Map()]));
    for (const e of predictions) {
      const prefix = es.filter((x) => x.seq < e.seq);
      const snapshot = Training.blindSnapshot(J0.replay(prefix));
      const prior = copy(prefix.findLast((x) => x.kind === 'learning_prior')?.learning || {});
      if (!snapshot || snapshot.status !== 'live' || snapshot.trades.length !== e.tradeCount)
        throw Error('Causal checkpoint mismatch ' + id + ':' + e.seq);
      const record = { id: m.id, base: m.base, snapshot, observedAt: e.at, rates: e.rates };
      const journals = {
        baseline: J0.restore(record, prefix),
        candidate: J.restore(record, prefix),
      };
      const models = {};
      for (const key of keys) {
        const started = performance.now();
        const v = engines[key].infer(
          snapshot,
          journals[key === 'baseline' ? 'baseline' : 'candidate'].evidence,
          { ...prior, rates: combinedRates(e.rates, prior.rates) },
        );
        const elapsedMs = performance.now() - started;
        const p = v.bySuit.map((s) => s.probability);
        const scenarios = Pnl.summary(snapshot, v).goalScenarios;
        timing[key].push(elapsedMs);
        models[key] = {
          probabilities: p,
          metric: pointMetric(p, g),
          elapsedMs,
          computeMs: v.computeMs,
          states: v.stateCount,
          behavior: v.behavior,
          opponentLearning: v.behavior?.opponentLearning || v.opponentLearning || null,
          bonus: scenarios[g],
        };
        replacement[key].set(e.seq, { ...e, probabilities: p, goalScenarios: scenarios });
      }
      points.push({
        seq: e.seq,
        at: e.at,
        timer: snapshot.timer,
        tradeCount: e.tradeCount,
        models,
      });
    }
    const bonus = Object.fromEntries(
      keys.map((k) => [
        k,
        Score.auditRound({ ...m, events: es.map((e) => replacement[k].get(e.seq) || e) }),
      ]),
    );
    results.push({
      id,
      at: es[0]?.at,
      goal: m.revealed.goal,
      difficulty: m.snapshot.context?.botDifficulty || 'unknown',
      players: m.snapshot.players.length,
      points,
      bonus,
    });
    write('progress-' + phase + '.json', {
      completed: results.length,
      total: ids.length,
      lastRound: id,
      variants,
      aggregate: aggregate(results, keys),
    });
    console.log(
      JSON.stringify({
        phase,
        round: results.length,
        total: ids.length,
        id,
        checkpoints: points.length,
        brier: Object.fromEntries(
          keys.map((k) => [k, mean(points.map((p) => p.models[k].metric.brier))]),
        ),
      }),
    );
  }
  const report = {
    phase,
    createdAt: new Date().toISOString(),
    datasetSha256: manifest.datasetSha256,
    variants,
    sourceHashes: evaluatedSourceHashes,
    modelSourceSha256: sha(fs.readFileSync(path.join(folder, 'belief.js'), 'utf8')),
    baselineSourceSha256: sha(fs.readFileSync(path.join(folder, 'belief-v0.10.js'), 'utf8')),
    method:
      'Same live pre-reveal prefixes and saved learning priors, with frozen v0.10 journal for baseline and new journal for candidate. All eligible predictions; equal round weighting. Payout labels are used only after inference. No profit backtest claim.',
    aggregate: aggregate(results, keys),
    paired: paired(results, keys),
    byPartition: Object.fromEntries(
      Object.entries(manifest.partitions).map(([part, ids]) => [
        part,
        aggregate(
          results.filter((r) => ids.includes(r.id)),
          keys,
        ),
      ]),
    ),
    byDifficulty: Object.fromEntries(
      [...new Set(results.map((r) => r.difficulty))].map((d) => [
        d,
        aggregate(
          results.filter((r) => r.difficulty === d),
          keys,
        ),
      ]),
    ),
    latency: Object.fromEntries(keys.map((k) => [k, distribution(timing[k])])),
    rounds: results,
  };
  write('evaluation-' + phase + '.json', report);
  console.log(
    JSON.stringify(
      { ...report, rounds: undefined, aggregate: report.aggregate, byDifficulty: undefined },
      null,
      2,
    ),
  );
}
function combinedRates(local, global) {
  const zero = {
    bid: { fills: 0, exposure: 0, outbids: 0 },
    ask: { fills: 0, exposure: 0, outbids: 0 },
    resets: 0,
    liveSeconds: 0,
  };
  const r = copy(global || zero);
  for (const side of ['bid', 'ask']) {
    r[side] = { ...zero[side], ...r[side] };
    for (const key of ['fills', 'exposure', 'outbids']) r[side][key] += local?.[side]?.[key] || 0;
  }
  r.resets = (r.resets || 0) + (local?.resets || 0);
  r.liveSeconds = (r.liveSeconds || 0) + (local?.liveSeconds || 0);
  return r;
}
function sourceHashes() {
  return Object.fromEntries(
    [
      'belief-v0.10.js',
      'journal-v0.10.js',
      'model-fit-v0.10.js',
      'belief.js',
      'journal.js',
      'model-fit.js',
      'opponent-beliefs.js',
    ]
      .filter((f) => fs.existsSync(path.join(folder, f)))
      .map((f) => [f, sha(fs.readFileSync(path.join(folder, f)))]),
  );
}
function dataset() {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json')));
  const raw = fs.readFileSync(path.join(OUT, 'recordings-combined.ndjson'), 'utf8');
  if (sha(raw) !== manifest.datasetSha256) throw Error('Dataset changed after partition lock');
  const by = new Map();
  for (const row of raw.trim().split('\n').map(JSON.parse)) {
    const id = row.kind === 'round_metadata' ? row.id : row.roundId;
    if (!by.has(id)) by.set(id, { events: [] });
    if (row.kind === 'round_metadata') by.get(id).metadata = row;
    else by.get(id).events.push(row);
  }
  return { manifest, by };
}
function benchmark(variantFile) {
  const { manifest, by } = dataset();
  const variants = variantFile
    ? JSON.parse(fs.readFileSync(variantFile))
    : { candidate: { opponentLearning: true } };
  const B0 = require(path.join(folder, 'belief-v0.10.js'));
  const B = require(path.join(folder, 'belief.js'));
  const J = require(path.join(folder, 'journal.js'));
  const evaluatedSourceHashes = sourceHashes();
  // Selection uses only chronology and event count, never prediction accuracy.
  const chosen = [
    manifest.partitions.train[0],
    manifest.partitions.train.at(-1),
    ...manifest.partitions.diagnostic,
  ];
  const cases = [];
  for (const id of chosen) {
    const { metadata: m, events } = by.get(id);
    const predictions = J0.livePredictions(events);
    const indexes = [0, Math.floor(predictions.length / 2), predictions.length - 1];
    for (const idx of new Set(indexes)) {
      const e = predictions[idx];
      const prefix = events.filter((x) => x.seq < e.seq);
      const snapshot = Training.blindSnapshot(J0.replay(prefix));
      const prior = copy(prefix.findLast((x) => x.kind === 'learning_prior')?.learning || {});
      const record = { id: m.id, base: m.base, snapshot, observedAt: e.at, rates: e.rates };
      prior.rates = combinedRates(e.rates, prior.rates);
      cases.push({
        id: id + ':' + e.seq,
        snapshot,
        prior,
        record,
        prefix,
        journals: { baseline: J0.restore(record, prefix), candidate: J.restore(record, prefix) },
        tradeCount: e.tradeCount,
        difficulty: m.snapshot.context?.botDifficulty || 'unknown',
        synthetic: false,
      });
    }
  }
  // Five players have no eligible recorded rounds. Exercise a legal symmetric
  // synthetic book separately, rather than represent it as empirical coverage.
  const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C', 'Bot-D'];
  const snapshot = {
    status: 'live',
    self: 'You',
    cash: 350,
    held: [2, 2, 2, 2],
    startingHand: [2, 2, 2, 2],
    players: names.map((name) => ({ name, cards: 8, cash: 350 })),
    trades: [],
    net: names.map(() => [0, 0, 0, 0]),
    context: { botDifficulty: 'Medium' },
    markets: IDS.map((id) => ({
      id,
      bid: 3,
      ask: 7,
      buyer: names[1],
      seller: names[2],
      canBid: true,
      canOffer: true,
      canRaiseBid: true,
      canLowerAsk: true,
      fills: [],
    })),
  };
  cases.push({
    id: 'synthetic-five-player',
    snapshot,
    prior: {},
    journals: { baseline: { evidence: [] }, candidate: { evidence: [] } },
    tradeCount: 0,
    difficulty: 'Medium',
    synthetic: true,
  });
  // A legal five-player synthetic flow adds lower bounds and a larger own stack.
  const flow = copy(snapshot);
  flow.roundKey = 'synthetic-five-player-flow';
  flow.signature = 'flow0';
  flow.markets.forEach((m) => {
    m.bid = null;
    m.ask = null;
    m.buyer = null;
    m.seller = null;
    m.canRaiseBid = false;
    m.canLowerAsk = false;
  });
  const flowJ0 = new J0.RoundJournal(flow.roundKey, flow.roundKey);
  const flowJ = new J.RoundJournal(flow.roundKey, flow.roundKey);
  flowJ0.observe(flow, 1000);
  flowJ.observe(flow, 1000);
  const moves = [
    [1, 0, 's'],
    [1, 0, 's'],
    [1, 0, 's'],
    [2, 3, 'c'],
    [3, 4, 'c'],
    [3, 4, 'c'],
    [3, 4, 'c'],
    [4, 2, 'd'],
    [4, 2, 'd'],
    [0, 1, 'h'],
  ];
  moves.forEach(([seller, buyer, suit], i) => {
    const k = IDS.indexOf(suit);
    const trade = { s: names[seller], b: names[buyer], suit, p: 5 };
    flow.trades.push(trade);
    flow.net[seller][k]--;
    flow.net[buyer][k]++;
    flow.players[seller].cash += 5;
    flow.players[buyer].cash -= 5;
    flow.held = flow.startingHand.map((v, k) => v + flow.net[0][k]);
    flow.cash = flow.players[0].cash;
    flow.players.forEach((p, k) => (p.cards = 8 + sum(flow.net[k])));
    flow.markets.forEach((m, k) => {
      m.held = flow.held[k];
      m.fills = flow.trades.filter((t) => t.suit === m.id);
    });
    flow.signature = 'flow' + (i + 1);
    flowJ0.observe(flow, 1100 + i * 100);
    flowJ.observe(flow, 1100 + i * 100);
  });
  flow.markets.forEach((m, k) => {
    m.bid = 3;
    m.ask = 7;
    m.buyer = names[1];
    m.seller = names[k === 1 ? 1 : 2];
    m.canRaiseBid = true;
    m.canLowerAsk = flow.held[k] > 0;
  });
  flowJ0.observe(flow, 2100);
  flowJ.observe(flow, 2100);
  cases.push({
    id: flow.roundKey,
    snapshot: flow,
    prior: {},
    record: {
      id: flow.roundKey,
      base: flow.roundKey,
      snapshot: flow,
      observedAt: 2100,
      rates: flowJ0.rates,
    },
    prefix: flowJ0.events,
    journals: { baseline: flowJ0, candidate: flowJ },
    tradeCount: flow.trades.length,
    difficulty: 'Medium',
    synthetic: true,
  });
  const measured = [];
  for (const c of cases) {
    for (const key of ['baseline', ...Object.keys(variants)]) {
      const Engine = key === 'baseline' ? B0.BeliefEngine : B.BeliefEngine;
      const options = key === 'baseline' ? {} : variants[key];
      const events = c.journals[key === 'baseline' ? 'baseline' : 'candidate'].evidence;
      const cold = [];
      const warm = [];
      const quote = [];
      const publicQuote = [];
      const engine = new Engine(options);
      let last;
      for (let repeat = 0; repeat < 3; repeat++) {
        const coldEngine = new Engine(options);
        const started = performance.now();
        last = coldEngine.infer(c.snapshot, events, c.prior);
        cold.push(performance.now() - started);
      }
      engine.infer(c.snapshot, events, c.prior);
      for (let repeat = 0; repeat < 7; repeat++) {
        let started = performance.now();
        last = engine.infer(c.snapshot, events, c.prior);
        warm.push(performance.now() - started);
        const quotePrices = {};
        for (const m of c.snapshot.markets)
          quotePrices[m.id] = {
            bid: Math.max(1, (m.bid || 1) + 1 + (repeat % 2)),
            ask: Math.max(1, (m.ask || 8) - 1 - (repeat % 2)),
          };
        started = performance.now();
        last = engine.infer(c.snapshot, events, { ...c.prior, quotePrices });
        quote.push(performance.now() - started);
      }
      const Journal = key === 'baseline' ? J0 : J;
      const publicJournal = c.record
        ? Journal.restore(c.record, c.prefix)
        : new Journal.RoundJournal(c.id, c.id);
      if (!c.record) publicJournal.observe(c.snapshot, 1000);
      const publicEngine = new Engine(options);
      publicEngine.infer(c.snapshot, publicJournal.evidence, c.prior);
      for (let repeat = 0; repeat < 7; repeat++) {
        const next = copy(c.snapshot);
        const m = next.markets[0];
        m.bid = 1 + (repeat % 2);
        m.ask = Math.max(4, m.ask || 4);
        m.buyer = next.players[1].name;
        next.signature += '|bench' + repeat;
        const started = performance.now();
        publicJournal.observe(next, (c.record?.observedAt || 1000) + 100 * (repeat + 1));
        publicEngine.infer(next, publicJournal.evidence, c.prior);
        publicQuote.push(performance.now() - started);
      }
      measured.push({
        id: c.id,
        key,
        players: c.snapshot.players.length,
        synthetic: c.synthetic,
        difficulty: c.difficulty,
        tradeCount: c.tradeCount,
        evidence: events.length,
        cold,
        warm,
        quote,
        publicQuote,
        states: last.stateCount,
        opponentLearning: last.behavior?.opponentLearning || last.opponentLearning || null,
      });
      console.log(
        JSON.stringify({
          benchmark: c.id,
          key,
          cold: distribution(cold),
          warm: distribution(warm),
          quote: distribution(quote),
          publicQuote: distribution(publicQuote),
        }),
      );
    }
  }
  const groups = {};
  for (const key of ['baseline', ...Object.keys(variants)])
    for (const players of [4, 5]) {
      const rows = measured.filter((m) => m.key === key && m.players === players);
      groups[key + '-' + players + 'p'] = {
        cold: distribution(rows.flatMap((r) => r.cold)),
        warm: distribution(rows.flatMap((r) => r.warm)),
        quote: distribution(rows.flatMap((r) => r.quote)),
        publicQuote: distribution(rows.flatMap((r) => r.publicQuote)),
      };
    }
  const report = {
    createdAt: new Date().toISOString(),
    datasetSha256: manifest.datasetSha256,
    variants,
    sourceHashes: evaluatedSourceHashes,
    method:
      'Full pricing, 3 cold calls + 7 cache-warm calls + 7 changed user quote prices + 7 public-book updates with journal ingestion per checkpoint. Recorded first/middle/final checkpoints from first and last train round plus two diagnostic rounds. Five-player synthetic opening and constrained-flow coverage is separate. Wall-clock JS on this machine; not input-to-network or browser latency.',
    groups,
    measured,
  };
  write('latency.json', report);
  console.log(JSON.stringify(groups, null, 2));
}
function summarize() {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name)));
  const manifest = read('manifest.json');
  const selection = read('selection.json');
  const protocol = read('protocol.json');
  const phases = {};
  const all = [];
  for (const phase of ['train', 'validation', 'test', 'diagnostic']) {
    const report = read('evaluation-' + phase + '.json');
    const key = report.variants.candidate ? 'candidate' : 'samples12';
    const rows = report.rounds.map((r) => ({
      ...r,
      points: r.points.map((p) => ({
        ...p,
        models: { baseline: p.models.baseline, candidate: p.models[key] },
      })),
      bonus: { baseline: r.bonus.baseline, candidate: r.bonus[key] },
    }));
    phases[phase] = {
      aggregate: aggregate(rows, ['baseline', 'candidate']),
      paired: paired(rows, ['baseline', 'candidate']),
      roundIds: rows.map((r) => r.id),
      sourceHashes: report.sourceHashes,
    };
    for (const r of rows) all.push({ ...r, phase });
  }
  const diagnostics = all
    .filter((r) => r.phase === 'diagnostic')
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      difficulty: r.difficulty,
      finalProbabilities: Object.fromEntries(
        ['baseline', 'candidate'].map((k) => [k, r.points.at(-1).models[k].probabilities]),
      ),
      meanBrierChange: mean(
        r.points.map((p) => p.models.candidate.metric.brier - p.models.baseline.metric.brier),
      ),
    }));
  const flips = all
    .filter(
      (r) =>
        r.points.at(-1).models.baseline.metric.top !== r.points.at(-1).models.candidate.metric.top,
    )
    .map((r) => ({
      id: r.id,
      phase: r.phase,
      goal: r.goal,
      baseline: IDS[r.points.at(-1).models.baseline.metric.top],
      candidate: IDS[r.points.at(-1).models.candidate.metric.top],
    }));
  const selected = all.filter((r) => r.phase !== 'diagnostic');
  const summary = {
    createdAt: new Date().toISOString(),
    datasetSha256: manifest.datasetSha256,
    inventory: {
      segments: manifest.selected.length + manifest.excluded.length,
      eligible: manifest.selected.length,
      excluded: manifest.excluded.length,
      exclusionReasons: Object.fromEntries(
        [...new Set(manifest.excluded.map((r) => r.reason))].map((reason) => [
          reason,
          manifest.excluded.filter((r) => r.reason === reason).length,
        ]),
      ),
    },
    selection,
    correctnessRerun: fs.existsSync(path.join(OUT, 'correctness-rerun.json'))
      ? read('correctness-rerun.json')
      : null,
    phases,
    nonDiagnosticAggregate: aggregate(selected, ['baseline', 'candidate']),
    allAggregate: aggregate(all, ['baseline', 'candidate']),
    byDifficulty: Object.fromEntries(
      [...new Set(all.map((r) => r.difficulty))].map((d) => [
        d,
        aggregate(
          all.filter((r) => r.difficulty === d),
          ['baseline', 'candidate'],
        ),
      ]),
    ),
    diagnostics,
    finalTopChanges: flips,
    latency: read('latency.json'),
    limitations: protocol.limitations,
  };
  write('comparison-summary.json', summary);
  console.log(
    JSON.stringify(
      {
        inventory: summary.inventory,
        phases: Object.fromEntries(
          Object.entries(phases).map(([p, v]) => [
            p,
            Object.fromEntries(
              Object.entries(v.aggregate).map(([k, a]) => [k, { ...a, calibration: undefined }]),
            ),
          ]),
        ),
        diagnostics,
        flips,
      },
      null,
      2,
    ),
  );
}
const [mode = 'prepare', ...args] = process.argv.slice(2);
const variantFile = args[0];
if (mode === 'prepare') prepare(args);
else if (mode === 'summary') summarize();
else if (mode === 'benchmark') benchmark(variantFile);
else
  evaluate(mode, variantFile).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
