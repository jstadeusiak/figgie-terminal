#!/usr/bin/env node
'use strict';
/* Dense public-state reconstruction; no private results enter inference. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/volatility-review-2026-10-30');
const Registry = require('../tools/model-registry.cjs');
const release = Registry.load('0.12.0');
const J = release.Journal;
const G = require(path.join(ROOT, 'models/0.13.0/goal-signal.js'));
const file = path.join(OUT, 'new-rounds.ndjson');
const data = Registry.readDataset([file]);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const copy = (x) => JSON.parse(JSON.stringify(x));
const IDS = ['s', 'c', 'd', 'h'];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const specs = ['v012', 'v013', 'lr8'];
const remaining = (t) =>
  typeof t === 'string' && /^\d+:\d\d$/.test(t)
    ? t
        .split(':')
        .map(Number)
        .reduce((a, b) => 60 * a + b)
    : null;
const maxMove = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const tv = (a, b) => a.reduce((n, x, i) => n + Math.abs(x - b[i]), 0) / 2;
function favorite(p, margin = 0) {
  const order = p.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  return order[0].v - order[1].v > Math.max(1e-10, margin) ? order[0].i : null;
}
function metric(p, g) {
  return {
    brier: p.reduce((n, x, i) => n + (x - Number(i === g)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-12, p[g])),
    goalP: p[g],
    correct: favorite(p) === g ? 1 : 0,
  };
}
function evidenceKey(e) {
  return JSON.stringify([
    e.epoch,
    e.actor,
    e.suit,
    e.direction,
    e.kind,
    e.price,
    e.at,
    e.counterparty,
    e.counterpartyKnownBeforeAction,
    e.net,
    e.anchor,
  ]);
}
function groups(events) {
  const result = [];
  for (let i = 0; i < events.length;) {
    const start = i;
    const at = events[i].at;
    while (i < events.length && events[i].at === at) i++;
    result.push({ start, end: i, at, events: events.slice(start, i) });
  }
  return result;
}
function summarizePath(points, events) {
  const out = {};
  for (const spec of specs) {
    let variation = 0;
    let flips = 0;
    let decisiveFlips = 0;
    let jumps5 = 0;
    let jumps10 = 0;
    let jumps20 = 0;
    const transitions = [];
    const lastMoves = [null, null, null, null];
    let reversals = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dt = (b.at - a.at) / 1000;
      if (dt <= 0 || b.coverageGap) continue;
      const p = a.models[spec];
      const q = b.models[spec];
      const d = q.map((v, s) => 100 * (v - p[s]));
      const jump = Math.max(...d.map(Math.abs));
      const mass = 100 * tv(p, q);
      const f = favorite(p);
      const f2 = favorite(q);
      variation += mass;
      if (f !== null && f2 !== null && f !== f2) flips++;
      if (f !== null && f2 !== null && f !== f2 && favorite(q, 0.01) !== null) decisiveFlips++;
      if (jump >= 5) jumps5++;
      if (jump >= 10) jumps10++;
      if (jump >= 20) jumps20++;
      for (let s = 0; s < 4; s++)
        if (Math.abs(d[s]) >= 2) {
          const prior = lastMoves[s];
          if (
            prior &&
            b.at - prior.at <= 10000 &&
            prior.delta * d[s] < 0 &&
            Math.abs(d[s]) >= Math.abs(prior.delta) / 2
          )
            reversals++;
          lastMoves[s] = { at: b.at, delta: d[s] };
        }
      transitions.push({
        fromSeq: a.seq,
        toSeq: b.seq,
        fromAt: a.at,
        at: b.at,
        seconds: dt,
        timer: b.timer,
        from: p,
        to: q,
        deltaPp: d,
        maxJumpPp: jump,
        totalVariationPp: mass,
        fromFavorite: f === null ? null : IDS[f],
        toFavorite: f2 === null ? null : IDS[f2],
        kind: b.kind,
        structuralJumpPp: b.structuralJumpPp,
        newFills: b.newFills,
        newQuotes: b.newQuotes,
        selectedAdded: b.selectedAdded,
        selectedRemoved: b.selectedRemoved,
        poolChanged: b.poolChanged,
        opponentBuilds: b.opponentBuilds,
      });
    }
    const sorted = transitions.map((t) => t.maxJumpPp).sort((a, b) => a - b);
    const minutes = points.length > 1 ? (points.at(-1).at - points[0].at) / 60000 : 0;
    out[spec] = {
      points: points.length,
      transitions: transitions.length,
      durationMinutes: minutes,
      totalVariationPp: variation,
      totalVariationPpPerMinute: minutes ? variation / minutes : null,
      meanMaxJumpPp: mean(sorted),
      p95MaxJumpPp: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      maxJumpPp: sorted.at(-1) ?? null,
      jumpsAtLeast5Pp: jumps5,
      jumpsAtLeast10Pp: jumps10,
      jumpsAtLeast20Pp: jumps20,
      favoriteFlips: flips,
      decisiveFavoriteFlips: decisiveFlips,
      reversalsWithin10Seconds: reversals,
      byKind: Object.fromEntries(
        [...new Set(transitions.map((t) => t.kind))].map((k) => {
          const ts = transitions.filter((t) => t.kind === k);
          return [
            k,
            {
              transitions: ts.length,
              meanMaxJumpPp: mean(ts.map((t) => t.maxJumpPp)),
              totalVariationPp: ts.reduce((n, t) => n + t.totalVariationPp, 0),
              maxJumpPp: Math.max(...ts.map((t) => t.maxJumpPp)),
            },
          ];
        }),
      ),
      largest: transitions.sort((a, b) => b.maxJumpPp - a.maxJumpPp).slice(0, 15),
    };
  }
  return out;
}
function scorePath(points, events, goal) {
  const g = IDS.indexOf(goal);
  if (g < 0) return null;
  const result = {};
  const lastPositiveAt =
    events
      .filter(
        (e) =>
          (e.kind === 'state' || e.kind === 'clock') &&
          e.status === 'live' &&
          remaining(e.timer) > 0,
      )
      .at(-1)?.at ?? points.at(-1)?.at;
  for (const spec of specs) {
    const eligible = points.filter((p) => p.remaining > 0);
    const perPoint = eligible.map((p) => metric(p.models[spec], g));
    const weighted = [];
    for (let i = 0; i < eligible.length; i++) {
      const a = eligible[i];
      const end = eligible[i + 1]?.at ?? lastPositiveAt;
      const dt = Math.max(0, (end - a.at) / 1000);
      const hasGap = events.some(
        (e) =>
          e.seq > a.seq &&
          e.at <= end &&
          e.kind === 'coverage' &&
          (e.gapSeconds > 2 || e.status !== 'live'),
      );
      if (dt && !hasGap) weighted.push({ seconds: dt, ...metric(a.models[spec], g) });
    }
    const seconds = weighted.reduce((n, p) => n + p.seconds, 0);
    result[spec] = {
      eventWeighted: Object.fromEntries(
        ['brier', 'logLoss', 'goalP', 'correct'].map((k) => [k, mean(perPoint.map((p) => p[k]))]),
      ),
      clockWeighted: {
        seconds,
        ...Object.fromEntries(
          ['brier', 'logLoss', 'goalP', 'correct'].map((k) => [
            k,
            seconds ? weighted.reduce((n, p) => n + p.seconds * p[k], 0) / seconds : null,
          ]),
        ),
      },
    };
  }
  return result;
}
function run() {
  const chosen = data.rounds.filter((r) =>
    r.events.some((e) => e.kind === 'prediction' && e.modelVersion === '0.13.0'),
  );
  const rounds = [];
  for (const [ri, r] of chosen.entries()) {
    const es = r.events;
    const m = r.metadata;
    const engine = new release.Belief.BeliefEngine({ samples: 512, skipPricing: true });
    const points = [];
    const actualChecks = [];
    let lastChosen = new Set();
    let priorPool = '';
    let lastSeq = 0;
    let lastP = null;
    let totalMs = 0;
    let lastRelevantKey = '';
    const predictionBySeq = new Map(J.livePredictions(es).map((p) => [p.seq, p]));
    for (const group of groups(es)) {
      const firstPred = group.events.find((e) => predictionBySeq.has(e.seq));
      const hasFrame = group.events.some((e) =>
        ['state', 'checkpoint', 'round_start'].includes(e.kind),
      );
      if (!hasFrame && !firstPred) continue;
      // A prediction's exact strict prefix takes priority; otherwise observe the
      // complete native state batch, never a quote before its matching net/book.
      const end = firstPred ? es.findIndex((e) => e.seq === firstPred.seq) : group.end;
      const prefix = es.slice(0, end);
      const snapshot = release.Training.blindSnapshot(J.replay(prefix));
      if (
        !snapshot ||
        snapshot.status !== 'live' ||
        remaining(snapshot.timer) <= 0 ||
        prefix.some(
          (e) =>
            e.kind === 'reveal' || e.kind === 'reveal_verified' || e.kind === 'settlement_pending',
        )
      )
        continue;
      const priorEvent = prefix.findLast((e) => e.kind === 'learning_prior');
      if (!priorEvent) continue;
      const journal = J.restore({ id: r.id, base: m.base, snapshot, observedAt: group.at }, prefix);
      const selected = release.Belief.chooseEvidence(journal.evidence, snapshot.self, {
        recentOnly: snapshot.context?.botDifficulty === 'Medium' && snapshot.players.length === 4,
      });
      const keys = new Set(selected.map(evidenceKey));
      const newKey = JSON.stringify([
        snapshot.context,
        snapshot.startingHand,
        snapshot.net,
        [...keys],
        snapshot.players.map((p) => p.name),
      ]);
      if (newKey === lastRelevantKey && !firstPred) continue;
      const start = performance.now();
      const model = engine.infer(snapshot, journal.evidence, copy(priorEvent.learning));
      const elapsedMs = performance.now() - start;
      totalMs += elapsedMs;
      const p = Array.from(model.bySuit, (s) => s.probability);
      const S = Array.from(model.baseline.probabilities);
      const B = Array.from(model.behavior.probabilities);
      const active =
        model.behavior.group === 'bots:Medium' &&
        snapshot.players.length === 4 &&
        model.behavior.blend !== 0.1;
      const models = {
        v012: p,
        v013: active
          ? G.targetProbabilities(
              S,
              B,
              { kind: 'likelihood-power', strength: 16 },
              model.behavior.blend,
            )
          : p.slice(),
        lr8: active
          ? G.targetProbabilities(
              S,
              B,
              { kind: 'likelihood-power', strength: 8 },
              model.behavior.blend,
            )
          : p.slice(),
      };
      if (firstPred)
        actualChecks.push({
          seq: firstPred.seq,
          version: firstPred.modelVersion,
          remaining: remaining(snapshot.timer),
          maxError: maxMove(models.v013, firstPred.probabilities),
          context: snapshot.context,
          active,
        });
      if (newKey === lastRelevantKey) continue;
      const since = prefix.filter((e) => e.seq > lastSeq);
      const newFills = since.filter((e) => e.kind === 'fill').map((e) => e.trade);
      const newQuotes = since
        .filter((e) => e.kind === 'quote')
        .map((e) => ({
          suit: e.suit,
          side: e.side,
          price: e.price,
          owner: e.owner,
          epoch: e.epoch,
          classification: e.classification,
        }));
      const structuralJump = lastP ? 100 * maxMove(S, lastP.structural) : 0;
      const selectedAdded = [...keys].filter((k) => !lastChosen.has(k));
      const selectedRemoved = [...lastChosen].filter((k) => !keys.has(k));
      const coverageGap = since.some(
        (e) => e.kind === 'coverage' && (e.gapSeconds > 2 || e.status !== 'live'),
      );
      const seq = prefix.at(-1).seq;
      const kind = newFills.length
        ? 'fill'
        : structuralJump > 1e-6
          ? 'inventory-bound-without-fill'
          : newQuotes.length
            ? 'quotes-only'
            : selectedAdded.length || selectedRemoved.length
              ? 'evidence-change'
              : 'context-or-observation';
      const point = {
        seq,
        at: group.at,
        timer: snapshot.timer,
        remaining: remaining(snapshot.timer),
        tradeCount: snapshot.trades.length,
        context: snapshot.context,
        active,
        structural: S,
        raw: B,
        models,
        elapsedMs,
        newFills,
        newQuotes,
        kind,
        structuralJumpPp: structuralJump,
        selectedAdded: selectedAdded.length,
        selectedRemoved: selectedRemoved.length,
        selectedEvidence: keys.size,
        poolChanged: priorPool !== engine.poolKey,
        opponentBuilds: model.behavior.opponentLearning?.builds,
        coverageGap,
      };
      points.push(point);
      lastRelevantKey = newKey;
      lastChosen = keys;
      priorPool = engine.poolKey;
      lastSeq = seq;
      lastP = point;
    }
    const official =
      m.revealed?.verified && m.revealed.source === 'official-round-rankings' ? m.revealed : null;
    rounds.push({
      id: r.id,
      context: m.snapshot.context,
      status: m.snapshot.status,
      goal: official?.goal || null,
      pnl: official?.settledProfit ?? null,
      actualPredictionChecks: actualChecks,
      actualPredictionMaxError: actualChecks.length
        ? Math.max(...actualChecks.map((p) => p.maxError))
        : null,
      totalInferMs: totalMs,
      volatility: summarizePath(points, es),
      properScores: official ? scorePath(points, es, official.goal) : null,
      points,
    });
    fs.writeFileSync(path.join(OUT, 'dense-volatility.partial.json'), JSON.stringify({ rounds }));
    process.stderr.write(
      `Dense ${ri + 1}/${chosen.length} ${r.id}: ${points.length} relevant frames, ${Math.round(totalMs)} ms\n`,
    );
  }
  const report = {
    schema: 1,
    createdAt: new Date().toISOString(),
    source: { file, sha256: sha(fs.readFileSync(file)) },
    runnerSha256: sha(fs.readFileSync(__filename)),
    baseline: release.entry.bundleSha256,
    method:
      'Reconstructed public-state path, not an exact display trace. Saved model predictions are only every15s; each complete state/checkpoint observation batch is replayed at its event prefix. Quote-only partial batches are never inferred. Duplicate goal-relevant input states omitted. Archived0.12 at512samples; exact goal-only LR16/LR8 transforms retain context/failure scope. Official results enter only after inference. Positive clocks only. Quote/evidence transitions remain unthrottled; UI may coalesce intermediate states.',
    definitions: {
      totalVariation:
        'sum over transitions of0.5*L1 probability difference, expressed inpercentagepoints',
      flip: 'unique top suit changes; decisive also requiresnewtop margin>=1pp',
      reversal: 'a suit move>=2pp reversed byatleast half within10s ofprevious>=2pp move',
      properScores:
        'Separate event- andclock-weighted averages; officialendedonly. Clock holds last reconstructedforecastuntilnext andexcludesrecordedcoveragegaps. Round summaries remainindividual.',
    },
    limitations: [
      'Dense replays may include observed states that were coalesced or superseded before display.',
      'Conditioning on known outcome is restricted toscoring; no inferred goals assigned tolive/unlabelledsegments.',
      'No alternative trading P&L or fill-adjusted returns are established.',
      'LR8 is an already-defined diagnostic strength, not a selected or promoted policy.',
    ],
    rounds,
  };
  const output = path.join(OUT, 'dense-volatility.json');
  fs.writeFileSync(output, JSON.stringify(report) + '\n');
  console.log(
    JSON.stringify(
      {
        output,
        rounds: rounds.map((r) => ({
          id: r.id,
          context: r.context,
          goal: r.goal,
          points: r.points.length,
          maxReplayError: r.actualPredictionMaxError,
          volatility: Object.fromEntries(
            specs.map((s) => [s, { ...r.volatility[s], largest: undefined, byKind: undefined }]),
          ),
          properScores: r.properScores,
        })),
      },
      null,
      2,
    ),
  );
}
if (require.main === module) run();
module.exports = { run, summarizePath, scorePath };
