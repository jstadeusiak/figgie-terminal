'use strict';
/* Offline score-only helper. Invoke after all candidate forecasts are complete.
   Official outcome labels are never returned to, or consumed by, inference. */
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const Bonus = require(path.join(ROOT, 'extension/bonus-score.js'));
const Quotes = require(path.join(ROOT, 'research/audit-recorded-quote-values.cjs'));
const IDS = ['s', 'c', 'd', 'h'];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const near = (a, b) => Math.abs(a - b) < 1e-6;
function prepareRound(metadata, events) {
  const audit = Bonus.auditRound({ ...metadata, events }, { includeLabels: true });
  return {
    roundId: metadata.id,
    settlementVerified: audit.settlementVerified === true,
    reason: audit.reason,
    labels: new Map((audit.labels || []).map((x) => [x.seq, x])),
  };
}
function inventoryTruth(label, snapshot) {
  if (!label?.candidates?.length)
    return { identified: false, reason: 'No verified goal-column label' };
  const g = IDS.indexOf(label.goal);
  const self = label.selfIndex;
  const base = 10 * snapshot.held[g];
  if (g < 0 || label.candidates.some((c) => c.counts[self] !== snapshot.held[g]))
    throw Error('Label does not match forecast-time own inventory');
  const payouts = label.candidates.map((c) => Quotes.payout(c.counts, self, c.bonusPool));
  if (!payouts.every((x) => near(x, payouts[0])))
    return { identified: false, reason: 'Feasible goal allocations disagree on inventory payout' };
  return { identified: true, base, bonus: payouts[0] - base, total: payouts[0] };
}
function makePoint(round, seq, snapshot, models) {
  const label = round.labels.get(seq);
  const truth = inventoryTruth(label, snapshot);
  const g = IDS.indexOf(label?.goal);
  const predictions = {};
  for (const [id, m] of Object.entries(models))
    predictions[id] = {
      base: m.expectedBase,
      bonus: m.expectedBonus,
      total: m.expectedPayout,
      conditionalBonus: g < 0 ? null : m.bySuit[g]?.conditionalBonus,
    };
  const quotes = Quotes.executableQuotes(snapshot).map((q) => {
    const qtruth = Quotes.truthValue(label, q);
    const qp = {};
    for (const [id, m] of Object.entries(models)) {
      const v = m.bySuit[IDS.indexOf(q.suit)]?.counterparties?.[q.peer];
      const total = v?.[q.side];
      const base = v?.[q.side + 'Base'];
      qp[id] =
        Number.isFinite(total) && Number.isFinite(base)
          ? {
              total,
              base,
              bonus: total - base,
              edge: q.side === 'buy' ? total - q.price : q.price - total,
            }
          : null;
    }
    return { ...q, roundId: round.roundId, seq, truth: qtruth, predictions: qp };
  });
  return {
    roundId: round.roundId,
    seq,
    tradeCount: snapshot.trades.length,
    truth,
    predictions,
    quotes,
  };
}
function scalarScore(rows, modelIds, truthFn, predFn) {
  const usable = rows.filter(
    (r) => Number.isFinite(truthFn(r)) && modelIds.every((id) => Number.isFinite(predFn(r, id))),
  );
  const ids = [...new Set(usable.map((r) => r.roundId))];
  const perRound = ids.map((roundId) => {
    const ps = usable.filter((r) => r.roundId === roundId);
    const metrics = {};
    for (const id of modelIds) {
      const e = ps.map((p) => predFn(p, id) - truthFn(p));
      metrics[id] = { mse: mean(e.map((x) => x * x)), bias: mean(e), mae: mean(e.map(Math.abs)) };
    }
    return { roundId, n: ps.length, metrics };
  });
  const summary = {};
  for (const id of modelIds) {
    const mse = mean(perRound.map((r) => r.metrics[id].mse));
    summary[id] = {
      mse,
      rmse: mse === null ? null : Math.sqrt(mse),
      bias: mean(perRound.map((r) => r.metrics[id].bias)),
      mae: mean(perRound.map((r) => r.metrics[id].mae)),
    };
  }
  return {
    rounds: ids.length,
    observations: usable.length,
    excluded: rows.length - usable.length,
    summary,
    perRound,
  };
}
function summarize(points, modelIds) {
  const inventory = {};
  const quotes = points.flatMap((p) => p.quotes);
  const quoteValues = {};
  for (const k of ['base', 'bonus', 'total']) {
    inventory[k] = scalarScore(
      points,
      modelIds,
      (p) => (p.truth.identified ? p.truth[k] : null),
      (p, id) => p.predictions[id]?.[k],
    );
    quoteValues[k] = scalarScore(
      quotes,
      modelIds,
      (p) => (p.truth.identified ? p.truth[k] : null),
      (p, id) => p.predictions[id]?.[k],
    );
  }
  const conditionalBonus = scalarScore(
    points,
    modelIds,
    (p) => (p.truth.identified ? p.truth.bonus : null),
    (p, id) => p.predictions[id]?.conditionalBonus,
  );
  const quoteEdge = scalarScore(
    quotes,
    modelIds,
    (p) =>
      p.truth.identified
        ? p.side === 'buy'
          ? p.truth.total - p.price
          : p.price - p.truth.total
        : null,
    (p, id) => p.predictions[id]?.edge,
  );
  return {
    method:
      'Common finite identified observations across models; average squared/signed errors within round, then equally across rounds. Forecast minus truth bias.',
    inventory,
    conditionalBonus,
    quoteValues,
    quoteEdge,
    coverage: {
      rounds: new Set(points.map((p) => p.roundId)).size,
      checkpoints: points.length,
      quotes: quotes.length,
      identifiedInventory: points.filter((p) => p.truth.identified).length,
      identifiedQuotes: quotes.filter((q) => q.truth.identified).length,
    },
    limitations: [
      'Static settle-now payouts and one-card transfer values, not strategy P&L or filled-order performance.',
      'Every compatible official-payout-derived goal allocation must agree before scoring; unidentified labels remain excluded.',
      'Future public trades are reversed only to construct labels after forecasts, never as forecast input.',
      'If only goal marginals change, conditional bonus should stay identical. Buy quote values require seller-has-card conditioning across all goals; rescaling a stored buy value by goal-probability ratio is invalid.',
    ],
  };
}
module.exports = { prepareRound, inventoryTruth, makePoint, scalarScore, summarize };
