#!/usr/bin/env node
'use strict';
/* Outcome labels are used only AFTER inference. No hypothetical future trades. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Registry = require('../tools/model-registry.cjs');
const { loadCurrent } = require('./compare-recorded-candidate.cjs');
const ROOT = path.resolve(__dirname, '..');
const REVIEW = path.join(ROOT, 'outputs/opponent-learning-review-2026-10-28');
const OUT = path.join(ROOT, 'outputs/simulation-audit-2026-10-28');
const IDS = ['s', 'c', 'd', 'h'];
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const copy = (x) => JSON.parse(JSON.stringify(x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function payout(counts, self, bonus) {
  const max = Math.max(...counts);
  const ties = counts.filter((v) => v === max).length;
  return 10 * counts[self] + (counts[self] === max ? bonus / ties : 0);
}
function truthValue(label, quote) {
  if (!label?.candidates?.length)
    return { identified: false, reason: 'No verified goal-column label' };
  if (quote.suit !== label.goal) return { identified: true, base: 0, bonus: 0, total: 0 };
  const peer = label.names.indexOf(quote.peer);
  const self = label.selfIndex;
  if (peer < 0 || peer === self) return { identified: false, reason: 'Unknown counterparty' };
  const values = [];
  for (const c of label.candidates) {
    const before = payout(c.counts, self, c.bonusPool);
    const after = c.counts.slice();
    const seller = quote.side === 'buy' ? peer : self;
    if (after[seller] < 1)
      return { identified: false, reason: 'Transfer not legal in every feasible goal allocation' };
    after[self] += quote.side === 'buy' ? 1 : -1;
    after[peer] += quote.side === 'buy' ? -1 : 1;
    values.push(
      quote.side === 'buy'
        ? payout(after, self, c.bonusPool) - before
        : before - payout(after, self, c.bonusPool),
    );
  }
  if (!values.every((v) => Math.abs(v - values[0]) < 1e-6))
    return { identified: false, reason: 'Feasible goal allocations disagree on transfer value' };
  return { identified: true, base: 10, bonus: values[0] - 10, total: values[0] };
}
function executableQuotes(snapshot) {
  const names = snapshot.players.map((p) => p.name);
  const quotes = [];
  for (const m of snapshot.markets)
    for (const side of ['buy', 'sell']) {
      const peer = side === 'buy' ? m.seller : m.buyer;
      const price = side === 'buy' ? m.ask : m.bid;
      if (
        m[side === 'buy' ? 'canBuy' : 'canSell'] !== true ||
        !Number.isFinite(price) ||
        price < 0 ||
        !names.includes(peer) ||
        peer === snapshot.self
      )
        continue;
      quotes.push({ suit: m.id, side, peer, price });
    }
  return quotes;
}
function scores(rows, model) {
  const usable = rows.filter(
    (q) =>
      q.truth.identified &&
      Object.values(q.predictions).every((p) => p && Number.isFinite(p.total)),
  );
  const rounds = [...new Set(usable.map((q) => q.roundId))];
  const perRound = rounds.map((roundId) => {
    const ps = usable.filter((q) => q.roundId === roundId);
    const out = { roundId, quotes: ps.length };
    for (const k of ['base', 'bonus', 'total']) {
      const errors = ps.map((q) => q.predictions[model][k] - q.truth[k]);
      out[k] = {
        mse: mean(errors.map((e) => e * e)),
        bias: mean(errors),
        mae: mean(errors.map(Math.abs)),
      };
    }
    return out;
  });
  const out = { rounds: rounds.length, quotes: usable.length };
  for (const k of ['base', 'bonus', 'total']) {
    const mse = mean(perRound.map((r) => r[k].mse));
    out[k] = {
      mse,
      rmse: mse === null ? null : Math.sqrt(mse),
      bias: mean(perRound.map((r) => r[k].bias)),
      mae: mean(perRound.map((r) => r[k].mae)),
    };
  }
  return { ...out, perRound };
}
function bestScores(points, model) {
  const selected = points
    .map((p) => {
      const q = p.quotes
        .filter((q) => Number.isFinite(q.predictions[model]?.edge))
        .sort((a, b) => b.predictions[model].edge - a.predictions[model].edge)[0];
      return q && q.predictions[model].edge > 0 ? q : null;
    })
    .filter(Boolean);
  const identified = selected.filter((q) => q.truth.identified);
  const perRound = [...new Set(identified.map((q) => q.roundId))].map((roundId) => {
    const rows = identified.filter((q) => q.roundId === roundId);
    return {
      roundId,
      n: rows.length,
      predictedEdge: mean(rows.map((q) => q.predictions[model].edge)),
      realizedEdge: mean(
        rows.map((q) => (q.side === 'buy' ? q.truth.total - q.price : q.price - q.truth.total)),
      ),
      realizedLosingFraction: mean(
        rows.map((q) =>
          Number((q.side === 'buy' ? q.truth.total - q.price : q.price - q.truth.total) < 0),
        ),
      ),
    };
  });
  return {
    positiveSelections: selected.length,
    identified: identified.length,
    unidentified: selected.length - identified.length,
    rounds: perRound.length,
    predictedEdge: mean(perRound.map((r) => r.predictedEdge)),
    realizedEdge: mean(perRound.map((r) => r.realizedEdge)),
    realizedLosingFraction: mean(perRound.map((r) => r.realizedLosingFraction)),
    perRound,
  };
}
function run(options = {}) {
  const baseline = Registry.load('0.11.0');
  const candidate = loadCurrent();
  const manifestBytes = fs.readFileSync(path.join(REVIEW, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const data = fs.readFileSync(path.join(REVIEW, 'recordings-combined.ndjson'));
  if (sha(data) !== manifest.datasetSha256) throw Error('Corpus hash mismatch');
  let ids = Object.values(manifest.partitions).flat();
  if (options.limit) ids = ids.slice(0, options.limit);
  const wanted = new Set(ids);
  const rounds = new Map();
  for (const line of data.toString('utf8').trim().split('\n')) {
    const e = JSON.parse(line);
    const id = e.kind === 'round_metadata' ? e.id : e.roundId;
    if (!wanted.has(id)) continue;
    if (!rounds.has(id)) rounds.set(id, { events: [] });
    if (e.kind === 'round_metadata') rounds.get(id).metadata = e;
    else rounds.get(id).events.push(e);
  }
  const specs = {
    baseline: { release: baseline, options: {} },
    plain: { release: candidate, options: { goalStratified: true } },
    referenceEss: { release: candidate, options: { goalStratified: true, referenceEss: true } },
  };
  const points = [];
  const roundCoverage = [];
  for (const [index, id] of ids.entries()) {
    const { metadata: m, events } = rounds.get(id);
    const preds = baseline.Journal.livePredictions(events);
    const chosen = [...new Set([0, Math.floor((preds.length - 1) / 2), preds.length - 1])]
      .filter((i) => i >= 0)
      .map((i) => preds[i]);
    const engines = Object.fromEntries(
      Object.entries(specs).map(([name, s]) => [
        name,
        new s.release.Belief.BeliefEngine({ samples: 512, skipPricing: true, ...s.options }),
      ]),
    );
    // Forecasters receive only the causal prefix. Official result labels are fetched below.
    const roundPoints = [];
    for (const p of chosen) {
      const prefix = events.filter((e) => e.seq < p.seq);
      const snapshot = baseline.Training.blindSnapshot(baseline.Journal.replay(prefix));
      if (snapshot.status !== 'live' || snapshot.trades.length !== p.tradeCount)
        throw Error('Invalid live prefix');
      const prior = copy(prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {});
      const quotes = executableQuotes(snapshot).map((q) => ({
        ...q,
        roundId: id,
        seq: p.seq,
        predictions: {},
      }));
      for (const [name, s] of Object.entries(specs)) {
        const journal = s.release.Journal.restore(
          { id, base: m.base, snapshot, observedAt: p.at, rates: p.rates },
          prefix,
        );
        const model = engines[name].infer(snapshot, journal.evidence, prior);
        for (const q of quotes) {
          const c = model.bySuit[IDS.indexOf(q.suit)].counterparties[q.peer];
          const total = c?.[q.side];
          const base = c?.[q.side + 'Base'];
          q.predictions[name] =
            Number.isFinite(total) && Number.isFinite(base)
              ? {
                  total,
                  base,
                  bonus: total - base,
                  edge: q.side === 'buy' ? total - q.price : q.price - total,
                }
              : null;
        }
      }
      roundPoints.push({ roundId: id, seq: p.seq, tradeCount: p.tradeCount, quotes });
    }
    const labels = candidate.Bonus.auditRound({ ...m, events }, { includeLabels: true });
    const bySeq = new Map((labels.labels || []).map((p) => [p.seq, p]));
    for (const p of roundPoints)
      for (const q of p.quotes) q.truth = truthValue(bySeq.get(p.seq), q);
    points.push(...roundPoints);
    roundCoverage.push({
      roundId: id,
      availableCheckpoints: preds.length,
      chosen: chosen.map((p) => p.seq),
      labelledCheckpoints: roundPoints.filter((p) => bySeq.has(p.seq)).length,
      settlementVerified: labels.settlementVerified === true,
      reason: labels.reason,
    });
    process.stderr.write(`Recorded quote audit ${index + 1}/${ids.length} ${id}\n`);
  }
  const quotes = points.flatMap((p) => p.quotes);
  const modelIds = Object.keys(specs);
  const report = {
    schema: 1,
    createdAt: new Date().toISOString(),
    scope:
      'Already-seen official concealed recorded rounds. Executable quotes at first, middle, and last saved live checkpoint per round. Static immediate-settlement marginal values; not policy P&L or fill-adjusted EV.',
    datasetSha256: sha(data),
    manifestSha256: sha(manifestBytes),
    baseline: { version: '0.11.0', bundleSha256: baseline.entry.bundleSha256 },
    candidate: {
      files: candidate.hashes,
      options: Object.fromEntries(
        modelIds
          .filter((k) => k !== 'baseline')
          .map((k) => [k, { samples: 512, skipPricing: true, ...specs[k].options }]),
      ),
    },
    coverage: {
      rounds: ids.length,
      checkpoints: points.length,
      executableQuotes: quotes.length,
      identifiedQuotes: quotes.filter((q) => q.truth.identified).length,
      unidentifiedReasons: Object.fromEntries(
        [...new Set(quotes.filter((q) => !q.truth.identified).map((q) => q.truth.reason))].map(
          (reason) => [reason, quotes.filter((q) => q.truth.reason === reason).length],
        ),
      ),
    },
    scores: Object.fromEntries(modelIds.map((k) => [k, scores(quotes, k)])),
    bestPositiveQuote: Object.fromEntries(modelIds.map((k) => [k, bestScores(points, k)])),
    limitations: [
      'Labels use only actual goal holdings compatible with official settlement and all public flows; no complete hidden hands are invented.',
      'A transfer is labeled only when every compatible goal allocation agrees and the transfer is legal in all. Non-goal transfers have zero settlement value.',
      'All-quote scores use common identified quotes with finite forecasts from every model, averaged within round then equally across rounds.',
      'Base and bonus here are UNCONDITIONAL marginal-value components. Separate conditional-goal bonus forecasts are scored in the full recorded regression.',
      'The best positive quote is selected from forecasts before checking truth availability. Realized losing fraction does not disprove positive EV.',
      'Selected quotes may differ across models; best-quote summaries are descriptive static opportunities, without execution or strategy simulation.',
    ],
    roundCoverage,
    points,
  };
  const output = options.out || path.join(OUT, 'recorded-quote-values.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  return {
    output,
    coverage: report.coverage,
    scores: Object.fromEntries(
      modelIds.map((k) => [k, { ...report.scores[k], perRound: undefined }]),
    ),
    bestPositiveQuote: Object.fromEntries(
      modelIds.map((k) => [k, { ...report.bestPositiveQuote[k], perRound: undefined }]),
    ),
  };
}
module.exports = { truthValue, payout, executableQuotes, scores, bestScores, run };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--limit') options.limit = Number(args[++i]);
      else if (args[i] === '--out') options.out = args[++i];
      else throw Error('Unknown argument ' + args[i]);
    }
    console.log(JSON.stringify(run(options), null, 2));
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
