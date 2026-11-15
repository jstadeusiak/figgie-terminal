const fs = require('fs');
const J = require('../extension/journal.js');
const P = require('../extension/pnl.js');
const dir = 'outputs/model-review-recent-2026-10-27';
const rows = fs
  .readFileSync(dir + '/recordings.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const ids = ['s', 'c', 'd', 'h'];
const metas = rows.filter((e) => e.kind === 'round_metadata' && e.revealed).slice(-2);
const result = [];
for (const m of metas) {
  const es = rows.filter((e) => e.roundId === m.id).sort((a, b) => a.seq - b.seq);
  const ps = J.livePredictions(es);
  const g = ids.indexOf(m.revealed.goal);
  const journal = J.restore(m, es);
  const pnl = P.summary(m.snapshot, null, journal.accounting, m.revealed);
  const vector = (p) => Object.fromEntries(ids.map((id, i) => [id, +(p[i] * 100).toFixed(2)]));
  const points = ps.length
    ? [ps[0], ...[0.25, 0.5, 0.75].map((f) => ps[Math.floor((ps.length - 1) * f)]), ps.at(-1)].map(
        (e) => ({
          seq: e.seq,
          seconds: +((e.at - ps[0].at) / 1000).toFixed(1),
          trades: e.tradeCount,
          probabilities: vector(e.probabilities),
          cards: vector(e.baseline),
          estimatedPnl: e.roundPnl?.estimatedPnl,
        }),
      )
    : [];
  const ownFills = es
    .filter(
      (e) => e.kind === 'fill' && (e.trade.b === m.snapshot.self || e.trade.s === m.snapshot.self),
    )
    .map((e) => {
      const buy = e.trade.b === m.snapshot.self;
      const cmd = es
        .filter(
          (c) =>
            c.kind === 'command_attempt' &&
            c.at <= e.at &&
            e.at - c.at < 10000 &&
            c.command.suit === e.trade.suit &&
            c.command.tradeCount === e.index &&
            ['buy', 'sell', 'bid', 'offer', 'raise-bid', 'lower-ask'].includes(c.command.kind),
        )
        .at(-1);
      return {
        seq: e.seq,
        seconds: Math.round((e.at - ps[0].at) / 1000),
        side: buy ? 'buy' : 'sell',
        suit: e.trade.suit,
        price: e.trade.p,
        classification: e.classification,
        associatedCommand: cmd
          ? {
              kind: cmd.command.kind,
              price: cmd.command.price,
              ageMs: e.at - cmd.at,
              estimatedGain: cmd.decision?.estimatedGain,
              conditionalGain: cmd.decision?.conditionalGain,
              probabilities: cmd.decision?.goalProbabilities,
            }
          : null,
      };
    });
  const commands = es.filter((e) => e.kind === 'command_attempt' && e.decision);
  result.push({
    id: m.id,
    round: m.snapshot.round,
    goal: m.revealed.goal,
    startingHand: m.snapshot.startingHand,
    endingHand: m.snapshot.held,
    pnl,
    points,
    predictions: ps.length,
    goalProbabilityRange: ps.length
      ? [
          Math.min(...ps.map((p) => p.probabilities[g])),
          Math.max(...ps.map((p) => p.probabilities[g])),
        ]
      : [],
    maxOpponentShiftPP: ps.length
      ? Math.max(
          ...ps.flatMap((p) => p.probabilities.map((v, i) => 100 * Math.abs(v - p.baseline[i]))),
        )
      : null,
    coverage: es.filter((e) => e.kind === 'coverage').map((e) => ({ at: e.at, ...e })),
    decisionCount: commands.length,
    negativeEstimateCommands: commands
      .filter((e) => e.decision.estimatedGain < 0)
      .map((e) => ({
        seq: e.seq,
        kind: e.command.kind,
        suit: e.command.suit,
        price: e.command.price,
        gain: e.decision.estimatedGain,
        conditional: e.decision.conditionalGain,
      })),
    ownFills,
  });
}
fs.writeFileSync(dir + '/review.json', JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    result.map((r) => ({
      ...r,
      pnl: {
        actual: r.pnl.actualPnl,
        tradingCash: r.pnl.netCash,
        settlement: r.pnl.actualPayout,
        ante: r.pnl.ante,
        bySuit: r.pnl.bySuit,
      },
      coverage: r.coverage.map((e) => ({ reason: e.reason, status: e.status, at: e.at })),
    })),
    null,
    2,
  ),
);
