/* Read-only coaching audit of stored decisions and actual executions.
   Stored pre-fill decisions/predictions are never replaced by hindsight estimates. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'outputs/model-review-v08');
const J = require('../extension/journal.js');
const P = require('../extension/pnl.js');
const B = require('../extension/belief-v0.6.js');
const sources = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json')));
const newIds = new Set(sources.newRoundIds);
const rows = fs
  .readFileSync(path.join(dir, 'recordings-combined.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const byId = new Map();
for (const e of rows)
  if (e.roundId) {
    if (!byId.has(e.roundId)) byId.set(e.roundId, []);
    byId.get(e.roundId).push(e);
  }
const IDS = ['s', 'c', 'd', 'h'];
const TEST = 'round-1793144490477-e7c5a184';
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : null);
const round = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
const countBy = (xs, f) => xs.reduce((a, x) => ((a[f(x)] = (a[f(x)] || 0) + 1), a), {});
const clock = (t) => {
  const m = String(t).match(/^(\d+):(\d\d)$/);
  return m ? 60 * Number(m[1]) + Number(m[2]) : null;
};
function dealtBenchmarks(s, result, flow) {
  if (!result?.verified || result.source !== 'official-round-rankings') return [];
  const names = s.players.map((p) => p.name);
  const self = names.indexOf(s.self);
  const n = names.length;
  const g = IDS.indexOf(result.goal);
  const size = 40 / n;
  const ante = 200 / n;
  const net = names.map(() => [0, 0, 0, 0]);
  const minimum = names.map(() => [0, 0, 0, 0]);
  const cash = names.map(() => 0);
  const out = [];
  if (g < 0 || !names.every((name) => Number.isFinite(result.profits?.[name]))) return [];
  for (const t of s.trades) {
    const a = names.indexOf(t.s);
    const b = names.indexOf(t.b);
    const k = IDS.indexOf(t.suit);
    net[a][k]--;
    net[b][k]++;
    minimum[a][k] = Math.max(minimum[a][k], -net[a][k]);
    cash[a] += t.p;
    cash[b] -= t.p;
  }
  const payouts = names.map((name, i) => result.profits[name] - cash[i] + ante);
  for (const total of [8, 10]) {
    const counts = Array(n).fill(0);
    const bonus = 200 - 10 * total;
    const walk = (i, left) => {
      if (i === n) {
        if (left) return;
        const max = Math.max(...counts);
        const ties = counts.filter((v) => v === max).length;
        if (
          counts.some(
            (v, k) => Math.abs(10 * v + (v === max ? bonus / ties : 0) - payouts[k]) > 1e-6,
          )
        )
          return;
        const initial = counts.map((v, k) => v - net[k][g]);
        if (
          initial[self] !== s.startingHand[g] ||
          initial.some((v, k) => v < minimum[k][g] || v > size)
        )
          return;
        const feasible = [0, 1, 2, 3].some((scarce) => {
          if (scarce === (g ^ 1)) return false;
          const deck = [10, 10, 10, 10];
          deck[g ^ 1] = 12;
          deck[scarce] = 8;
          if (deck[g] !== total || s.startingHand.some((v, k) => v > deck[k])) return false;
          return (
            initial.every(
              (v, k) => k === self || size - v - sum(minimum[k].filter((_, z) => z !== g)) >= 0,
            ) &&
            deck.every(
              (v, k) =>
                k === g ||
                v - s.startingHand[k] - sum(minimum.map((row, z) => (z === self ? 0 : row[k]))) >=
                  0,
            )
          );
        });
        if (!feasible) return;
        const imax = Math.max(...initial);
        const it = initial.filter((v) => v === imax).length;
        const dealtBonus = initial[self] === imax ? bonus / it : 0;
        out.push({
          goalTotal: total,
          initialGoal: initial,
          finalGoal: counts.slice(),
          dealtBonus,
          noTradesPnl: -ante + 10 * s.startingHand[g] + dealtBonus,
        });
        return;
      }
      if (i === self) {
        const v = s.held[g];
        if (v <= left) {
          counts[i] = v;
          walk(i + 1, left - v);
        }
        return;
      }
      for (let v = 0; v <= Math.min(left, s.players[i].cards); v++) {
        counts[i] = v;
        walk(i + 1, left - v);
      }
    };
    walk(0, total);
  }
  return out;
}
function report(m) {
  const events = (byId.get(m.id) || []).sort((a, b) => a.seq - b.seq);
  const s = m.snapshot;
  const j = J.restore(m, events);
  const pnl = P.summary(s, null, j.accounting, m.revealed);
  const predictions = J.livePredictions(events);
  const initial = B.privateBelief(s.startingHand).goals;
  const rank = IDS.map((suit, i) => ({ suit, p: initial[i] })).sort((a, b) => b.p - a.p);
  const goal = m.revealed?.goal || s.roundResult?.goal;
  const gi = IDS.indexOf(goal);
  const result = m.revealed || s.roundResult;
  const commands = events
    .filter((e) => e.kind === 'command_attempt')
    .map((e, index, all) => {
      const end = all.slice(index + 1).find((x) => x.commandId === e.commandId)?.seq ?? Infinity;
      const related = events.filter(
        (x) => x.seq > e.seq && x.seq < end && x.commandId === e.commandId,
      );
      return {
        seq: e.seq,
        at: e.at,
        commandId: e.commandId,
        ...e.command,
        decision: e.decision || null,
        rejected: related.some((x) => x.kind === 'command_rejected'),
        submitted: related.some((x) => x.kind === 'command_submitted'),
        outcomes: related
          .filter((x) => x.kind === 'order_outcome')
          .map((x) => ({ state: x.state, message: x.message })),
      };
    });
  const byTrade = new Map(events.filter((e) => e.kind === 'fill').map((e) => [e.index, e]));
  const used = new Set();
  const trades = [];
  const pairs = [];
  const lots = IDS.map(() => []);
  let held = s.startingHand.slice();
  let netCash = 0;
  let maxNetSpend = 0;
  let worstNoBonus = -200 / s.players.length + 10 * Math.min(...held);
  for (let index = 0; index < s.trades.length; index++) {
    const t = s.trades[index];
    const k = IDS.indexOf(t.suit);
    if (t.b !== s.self && t.s !== s.self) continue;
    const side = t.b === s.self ? 'buy' : 'sell';
    const fill = byTrade.get(index);
    const beforeHeld = held.slice();
    const beforeCash = netCash;
    const prev = fill ? predictions.filter((p) => p.seq < fill.seq).at(-1) : null;
    const priorClock = fill
      ? events
          .filter((e) => e.seq < fill.seq && (e.kind === 'clock' || e.kind === 'state') && e.timer)
          .at(-1)
      : null;
    const remaining = clock(priorClock?.timer);
    const kinds = side === 'buy' ? ['buy', 'bid', 'raise-bid'] : ['sell', 'offer', 'lower-ask'];
    const candidates = fill
      ? commands.filter(
          (c) =>
            !used.has(c.seq) &&
            !c.rejected &&
            c.submitted &&
            c.seq < fill.seq &&
            c.suit === t.suit &&
            c.price === t.p &&
            c.tradeCount === index &&
            kinds.includes(c.kind),
        )
      : [];
    const matched =
      candidates
        .filter((c) =>
          ['buy', 'sell'].includes(c.kind)
            ? fill.at - c.at <= 2500
            : events.some(
                (e) =>
                  e.seq > c.seq &&
                  e.seq < fill.seq &&
                  e.kind === 'quote' &&
                  e.owner === s.self &&
                  e.suit === t.suit &&
                  e.side === (side === 'buy' ? 'bid' : 'ask') &&
                  e.price === t.p &&
                  e.epoch === index,
              ),
        )
        .at(-1) || null;
    if (matched) used.add(matched.seq);
    const d = matched?.decision;
    const prob = d?.goalProbabilities?.[k] ?? prev?.probabilities?.[k] ?? null;
    const base = Number.isFinite(prob) ? 10 * prob : null;
    if (side === 'buy') {
      held[k]++;
      netCash -= t.p;
    } else {
      held[k]--;
      netCash += t.p;
    }
    const noBonus = held.map((q) => netCash - 200 / s.players.length + 10 * q);
    maxNetSpend = Math.max(maxNetSpend, -netCash);
    worstNoBonus = Math.min(worstNoBonus, ...noBonus);
    const r = {
      index,
      seq: fill?.seq,
      at: fill?.at,
      side,
      suit: t.suit,
      price: t.p,
      buyer: t.b,
      seller: t.s,
      classification: fill?.classification,
      recovered: fill?.recovered,
      remainingSeconds: remaining,
      phase:
        remaining === null
          ? 'unknown'
          : remaining > 120
            ? 'early'
            : remaining > 60
              ? 'middle'
              : 'last-minute',
      heldBefore: beforeHeld,
      heldAfter: held.slice(),
      netCashBefore: beforeCash,
      netCashAfter: netCash,
      noBonusPnlBySuit: noBonus,
      matchedCommandSeq: matched?.seq ?? null,
      commandKind: matched?.kind ?? null,
      commandAgeMs: matched ? fill.at - matched.at : null,
      decision: d || null,
      probabilityBefore: prob,
      probabilitySource: d
        ? 'matched command decision'
        : prev
          ? 'preceding periodic prediction'
          : null,
      predictionAgeMs: prev && fill ? fill.at - prev.at : null,
      simpleBaseEdge: base === null ? null : side === 'buy' ? base - t.p : t.p - base,
      fullModelEdge: d?.conditionalGain ?? null,
      actualGoal: goal === t.suit,
      realizedBaseEdge:
        gi < 0
          ? null
          : side === 'buy'
            ? (goal === t.suit ? 10 : 0) - t.p
            : t.p - (goal === t.suit ? 10 : 0),
    };
    trades.push(r);
    if (side === 'buy') lots[k].push(r);
    else if (lots[k].length) {
      const buy = lots[k].shift();
      pairs.push({
        suit: t.suit,
        buyIndex: buy.index,
        sellIndex: index,
        buyPrice: buy.price,
        sellPrice: t.p,
        spread: t.p - buy.price,
        seconds: fill?.at && buy.at ? (fill.at - buy.at) / 1000 : null,
        buyProbability: buy.probabilityBefore,
        sellProbability: prob,
        buyModelEdge: buy.fullModelEdge,
        sellModelEdge: r.fullModelEdge,
      });
    }
  }
  const allDecisions = commands.filter((c) => !c.kind.startsWith('cancel') && c.decision);
  const pricedDecisions = allDecisions.filter((c) => Number.isFinite(c.decision.conditionalGain));
  const fillDecisions = trades.filter((t) => t.decision);
  const fullFills = fillDecisions.filter((t) => Number.isFinite(t.fullModelEdge));
  const noTrade = dealtBenchmarks(s, result, pnl);
  const bmarks = noTrade.map((c) => c.noTradesPnl);
  const last = predictions.at(-1);
  const start = events.find((e) => e.kind === 'round_start')?.at || events[0]?.at;
  const truthByIndex = new Map(trades.map((t) => [t.index, { gains: [], bonusChanges: [] }]));
  const truthDecomposition = [];
  for (const allocation of noTrade) {
    let counts = allocation.initialGoal.slice();
    let ownChanges = 0;
    let opponentChanges = 0;
    const self = s.players.findIndex((p) => p.name === s.self);
    const names = s.players.map((p) => p.name);
    const bonus = 200 - 10 * allocation.goalTotal;
    const payoff = () => {
      const max = Math.max(...counts);
      return (
        10 * counts[self] +
        (counts[self] === max ? bonus / counts.filter((v) => v === max).length : 0)
      );
    };
    for (let index = 0; index < s.trades.length; index++) {
      const t = s.trades[index];
      const before = payoff();
      const own = t.b === s.self || t.s === s.self;
      if (t.suit === goal) {
        counts[names.indexOf(t.s)]--;
        counts[names.indexOf(t.b)]++;
      }
      const delta = payoff() - before;
      const cashDelta = t.b === s.self ? -t.p : t.s === s.self ? t.p : 0;
      if (own) {
        ownChanges += delta + cashDelta;
        const truth = truthByIndex.get(index);
        truth.gains.push(delta + cashDelta);
        truth.bonusChanges.push(delta - (t.suit === goal ? (t.b === s.self ? 10 : -10) : 0));
      } else opponentChanges += delta;
    }
    truthDecomposition.push({
      goalTotal: allocation.goalTotal,
      initialPnl: allocation.noTradesPnl,
      ownTradeSettleNowChanges: ownChanges,
      opponentBonusChanges: opponentChanges,
      reconciledPnl: allocation.noTradesPnl + ownChanges + opponentChanges,
    });
  }
  for (const t of trades) {
    const truth = truthByIndex.get(t.index);
    t.realizedSettleNowGainRange = truth.gains.length
      ? [Math.min(...truth.gains), Math.max(...truth.gains)]
      : null;
    t.realizedBonusChangeRange = truth.bonusChanges.length
      ? [Math.min(...truth.bonusChanges), Math.max(...truth.bonusChanges)]
      : null;
  }

  const infoGroup =
    rank[0].p >= 0.6
      ? 'strong-single'
      : rank[0].p + rank[1].p >= 0.75
        ? 'concentrated-two'
        : rank[0].p <= 0.3
          ? 'flat'
          : 'moderate';
  return {
    id: m.id,
    new: newIds.has(m.id),
    test: m.id === TEST,
    round: s.round,
    at: start,
    time: new Date(start).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    status: s.status,
    goal,
    difficulty: s.context?.botDifficulty,
    models: [...new Set(predictions.map((p) => p.modelVersion))],
    startingHand: s.startingHand,
    endingHand: s.held,
    initialProbabilities: initial,
    initialTop: rank[0],
    initialTop2: rank[0].p + rank[1].p,
    infoGroup,
    pnl: {
      actual: pnl.actualPnl,
      source: pnl.source,
      spent: pnl.spent,
      received: pnl.received,
      netCash: pnl.netCash,
      settlement: pnl.actualPayout,
      ante: pnl.ante,
      bySuit: pnl.bySuit,
    },
    official: result?.verified === true && result.source === 'official-round-rankings',
    actualBonus: gi < 0 || pnl.actualPayout === null ? null : pnl.actualPayout - 10 * s.held[gi],
    baseTradingValue: gi < 0 ? null : pnl.netCash + 10 * (s.held[gi] - s.startingHand[gi]),
    dealtBenchmarks: noTrade,
    truthDecomposition,
    noTradePnlRange: bmarks.length ? [Math.min(...bmarks), Math.max(...bmarks)] : null,
    versusNoTradeRange:
      bmarks.length && pnl.actualPnl !== null
        ? [pnl.actualPnl - Math.max(...bmarks), pnl.actualPnl - Math.min(...bmarks)]
        : null,
    maxNetSpend,
    worstNoBonusPnlDuring: worstNoBonus,
    finalNoBonusPnl: s.held.map((q) => pnl.netCash - pnl.ante + 10 * q),
    firstForecast: predictions[0]
      ? {
          probabilities: predictions[0].probabilities,
          estimatedPnl: predictions[0].roundPnl?.estimatedPnl,
        }
      : null,
    lastForecast: last
      ? {
          seq: last.seq,
          at: last.at,
          tradeCount: last.tradeCount,
          probabilities: last.probabilities,
          estimatedPnl: last.roundPnl?.estimatedPnl,
          goalScenarios: last.goalScenarios,
        }
      : null,
    allTrades: s.trades.length,
    ownTrades: trades,
    roundTrips: pairs,
    commands,
    counts: {
      commands: commands.length,
      byKind: countBy(commands, (c) => c.kind),
      rejected: commands.filter((c) => c.rejected).length,
      submitted: commands.filter((c) => c.submitted).length,
      decisions: allDecisions.length,
      pricedDecisions: pricedDecisions.length,
      negativeDecisionAttempts: pricedDecisions.filter((c) => c.decision.conditionalGain < 0)
        .length,
      actualFills: trades.length,
      matchedFillCommands: trades.filter((t) => t.matchedCommandSeq !== null).length,
      matchedFillDecisions: fillDecisions.length,
      pricedFillDecisions: fullFills.length,
      negativeFullEvFills: fullFills.filter((t) => t.fullModelEdge < 0).length,
      positiveBonusDependentFills: fullFills.filter(
        (t) => t.fullModelEdge > 0 && t.decision.baseEdge < 0,
      ).length,
    },
    sequenceGaps: events
      .slice(1)
      .reduce((n, e, i) => n + Math.max(0, e.seq - events[i].seq - 1), 0),
  };
}
const reports = rows
  .filter((e) => e.kind === 'round_metadata')
  .map(report)
  .sort((a, b) => a.at - b.at);
const newRounds = reports.filter((r) => r.new);
const newOfficial = newRounds.filter((r) => r.official && r.pnl.actual !== null);
const old = reports.filter((r) => !r.new && !r.test);
const oldOfficial = old.filter((r) => r.official && r.pnl.actual !== null);
function aggregate(rs) {
  const settled = rs.filter((r) => r.pnl.actual !== null);
  const trades = rs.flatMap((r) => r.ownTrades);
  const fills = trades.filter((t) => Number.isFinite(t.fullModelEdge));
  return {
    rounds: rs.length,
    settledRounds: settled.length,
    pnl: sum(settled.map((r) => r.pnl.actual)),
    meanPnl: avg(settled.map((r) => r.pnl.actual)),
    profitable: settled.filter((r) => r.pnl.actual > 0).length,
    losses: settled.filter((r) => r.pnl.actual < 0).length,
    spent: sum(rs.map((r) => r.pnl.spent)),
    received: sum(rs.map((r) => r.pnl.received)),
    netCash: sum(rs.map((r) => r.pnl.netCash)),
    settlement: sum(settled.map((r) => r.pnl.settlement)),
    ante: sum(settled.map((r) => r.pnl.ante)),
    actualFills: trades.length,
    bought: trades.filter((t) => t.side === 'buy').length,
    sold: trades.filter((t) => t.side === 'sell').length,
    commands: sum(rs.map((r) => r.counts.commands)),
    pricedDecisionAttempts: sum(rs.map((r) => r.counts.pricedDecisions)),
    negativeDecisionAttempts: sum(rs.map((r) => r.counts.negativeDecisionAttempts)),
    matchedFillCommands: trades.filter((t) => t.matchedCommandSeq !== null).length,
    pricedFillDecisions: fills.length,
    negativeFullEvFills: fills.filter((t) => t.fullModelEdge < 0).length,
    positiveBonusDependentFills: fills.filter((t) => t.fullModelEdge > 0 && t.decision.baseEdge < 0)
      .length,
    baseTradingValue: sum(
      rs.filter((r) => r.baseTradingValue !== null).map((r) => r.baseTradingValue),
    ),
    actualBonus: sum(rs.filter((r) => r.actualBonus !== null).map((r) => r.actualBonus)),
    buySellRoundTrips: rs.flatMap((r) => r.roundTrips).length,
    roundTripSpread: sum(rs.flatMap((r) => r.roundTrips).map((t) => t.spread)),
    meanMaxNetSpend: avg(rs.map((r) => r.maxNetSpend)),
  };
}
const newTrades = newOfficial.flatMap((r) =>
  r.ownTrades.map((t) => ({ roundId: r.id, time: r.time, pnl: r.pnl.actual, ...t })),
);
const summary = {
  newSegments: newRounds.length,
  newOfficial: aggregate(newOfficial),
  newAllSettled: aggregate(newRounds.filter((r) => r.pnl.actual !== null)),
  newUnlabeled: newRounds
    .filter((r) => !r.goal)
    .map((r) => ({ id: r.id, status: r.status, pnl: r.pnl, hand: r.endingHand })),
  oldOfficial: aggregate(oldOfficial),
  oldMediumOfficial: aggregate(oldOfficial.filter((r) => r.difficulty === 'Medium')),
  oldAllSettled: aggregate(old.filter((r) => r.pnl.actual !== null)),
  latestFiveOfficial: aggregate(newOfficial.slice(-5)),
  earlierFifteenOfficial: aggregate(newOfficial.slice(0, -5)),
  openingTopProbabilityRange: [
    Math.min(...newOfficial.map((r) => r.initialTop.p)),
    Math.max(...newOfficial.map((r) => r.initialTop.p)),
  ],
  byOpeningTop: Object.fromEntries(
    [
      ['atLeast45Percent', (r) => r.initialTop.p >= 0.45],
      ['30to45Percent', (r) => r.initialTop.p > 0.3 && r.initialTop.p < 0.45],
      ['atMost30Percent', (r) => r.initialTop.p <= 0.3],
    ].map(([name, test]) => [name, aggregate(newOfficial.filter(test))]),
  ),
  byStartingCertainty: Object.fromEntries(
    ['strong-single', 'concentrated-two', 'moderate', 'flat'].map((g) => [
      g,
      aggregate(newOfficial.filter((r) => r.infoGroup === g)),
    ]),
  ),
  byBonusReceived: {
    yes: aggregate(newOfficial.filter((r) => r.actualBonus > 0)),
    no: aggregate(newOfficial.filter((r) => r.actualBonus === 0)),
  },
  fillClassifications: countBy(newTrades, (t) => t.classification || 'unknown'),
  fillsByPhase: countBy(newTrades, (t) => t.phase),
  phaseEdges: Object.fromEntries(
    ['early', 'middle', 'last-minute'].map((phase) => {
      const ts = newTrades.filter((t) => t.phase === phase);
      const scored = ts.filter((t) => Number.isFinite(t.fullModelEdge));
      return [
        phase,
        {
          fills: ts.length,
          pricedFillDecisions: scored.length,
          negativeFullEv: scored.filter((t) => t.fullModelEdge < 0).length,
          meanFullEv: avg(scored.map((t) => t.fullModelEdge)),
          simpleBaseEdge: avg(
            ts.filter((t) => Number.isFinite(t.simpleBaseEdge)).map((t) => t.simpleBaseEdge),
          ),
        },
      ];
    }),
  ),
};
const examples = [
  {
    roundId: 'round-1793226593203-a6d72199',
    tradeIndices: [28, 35],
    lesson: 'Avoid an expensive late card with no path to a bonus.',
    detail:
      'At 26 seconds left, bought one club for 21 with recorded goal probability 26.44%, base fair 2.64, bonus benefit zero, full model EV −18.36. Sold it for 13 about 17.55 seconds later, locking an 8-chip spread loss. Even a certain goal pays only 10 for an isolated non-bonus card; resale speculation requires a separate thesis.',
  },
  {
    roundId: 'round-1793206033265-8cc78344',
    tradeIndices: [10],
    lesson: 'A sale above base fair can still destroy a valuable tie.',
    detail:
      'Sold a club for 14 while holding four and assigning clubs 69.0%; full conditional model EV was −34.17, despite positive base-price edge. Reconstructed actual holdings show a 50-chip tie bonus was lost, so settle-now marginal result was −46. The round still won 71 overall; a winning round can contain a costly trade.',
  },
  {
    roundId: 'round-1793209812520-9411f5d4',
    tradeIndices: [50],
    lesson:
      'A negative model label is not proof of a bad trade when its bonus-state estimate is wrong.',
    detail:
      'Bought the sixth heart from Bot-Lamb for 27 with three seconds left. Recorded goal probability 64.97%, modeled bonus benefit only 0.27, full EV −20.23. Official-payout reconstruction shows the purchase broke a 5–5 tie: settlement increased 60, net marginal gain +33. This is a bonus-estimation failure, not evidence the purchase was irrational.',
  },
  {
    roundId: 'round-1793225243383-60f41b68',
    tradeIndices: [4, 8, 20],
    lesson: 'Separate an unlucky goal from an avoidable additional wager.',
    detail:
      'Early hearts sold at 6 and 12 when recorded goal probabilities were 12.56% and 10.29%; both had positive full model EV. Hearts ultimately won, but that alone does not invalidate the sales. A later sixth spade purchase at 14 with four seconds left had full model EV −5.75 and spent the remaining 14 chips of positive trade cash, increasing the realized loss from that action by 14.',
  },
  {
    roundId: 'round-1793211445420-03d45404',
    tradeIndices: [28],
    lesson: 'Cash can win without the goal-card majority.',
    detail:
      'Earned 30 with two clubs at settlement and no bonus: net trading cash +60, base payout +20, ante −50. Sold the third club for 11 with nine seconds left and about 48.6% goal probability; model EV was +5.95 and the actual base-value gain was +1.',
  },
  {
    roundId: 'round-1793210362851-4ee584e3',
    tradeIndices: [14, 20],
    lesson: 'Strong information does not require chasing ownership.',
    detail:
      'Opening hand implied hearts 47.8% but contained zero hearts. Bought one heart for 7 and sold it for 13; eventually held no cards and finished +4 entirely through cash generation. The initial buy was slightly negative on the stored model, so the profitable round trip alone is not evidence to repeat every similar bid.',
  },
];
const coaching = {
  principalDistinctions: [
    'Goal probability measures which suit pays; your inventory and opponents’ holdings determine whether the next card changes the bonus.',
    'Initial information strength and initial inventory strength are different. Five diamonds can favor hearts while leaving you with few hearts.',
    'Actual round profit includes the 50-chip ante. A losing round can still contain profitable trades, and a profitable round can contain costly trades.',
  ],
  strongOneOrTwoCandidates: [
    'Use the candidate probabilities as a ranking, not certainty. These new opening hands never exceeded 48.44% on one suit or 73.35% on two.',
    'Build in one-card steps. Pay a premium above the 10×probability base only when the incremental card plausibly gains or protects a bonus, considering the named counterparty.',
    'Protect a valuable tie or lead from cheap sales. A transfer to your nearest rival moves the gap by two cards. Recheck the full sell value, not just sale price versus base fair.',
    'Holding six cards guarantees sole majority if that suit is goal under the normal 8/10 goal supply. Holding five guarantees at least a tie; the sixth can still be valuable if one opponent owns the other five. Beyond six, another goal card has no additional majority bonus.',
  ],
  flatHands: [
    'Prefer small, favorable quotes and sales of overpriced inventory while gathering information; avoid treating four speculative bonus opportunities as four independent bargains.',
    'Follow repeated purchases and their counterparties, including gross activity. Net zero can conceal a large dealt position or buying followed by selling.',
    'When an opponent has a convincing concentration advantage, monetize expensive cards rather than funding a late race without a clear path to catch up.',
    'A proposed conservative practice rule is one speculative card at a time and a predeclared additional-risk budget. No numerical budget has been optimized from this sample.',
  ],
  realtimeChecklist: [
    'Check suit probability and base fair at the actual quote.',
    'Check your current quantity, the counterparty, and whether this specific transfer changes a tie/lead.',
    'Read the full conditional edge for the action you intend; a resting order’s fill-adjusted EV is not the same as the gain if it fills.',
    'Check each goal scenario and the no-bonus P&L. Positive average EV does not remove a 50-chip downside in an unowned suit.',
    'In the last 30 seconds, require a stated price/bonus reason before chasing or dumping; 17 of 46 priced executed trades in that period disagreed with the displayed full-EV model.',
  ],
  caveats: [
    'This is observational coaching on 20 new official rounds, not an optimized strategy backtest.',
    'Recorded full-EV labels are provisional model estimates; the sixth-heart example demonstrates a material bonus-state miss.',
    'The new model, dealt hands, opponent behavior and the user’s style changed together; old/new P&L is not a causal model-version test.',
    'The five flat-hand losses are a small descriptive group, not proof flat hands cannot be profitable.',
    'The hypothetical no-trades benchmark freezes everybody’s dealt allocation. It is not what opponents would necessarily do if the user alone stopped trading.',
  ],
};
for (const r of newOfficial) {
  if (r.ownTrades.length !== sum(Object.values(r.pnl.bySuit).map((v) => v.bought + v.sold)))
    throw Error('Own fill count mismatch ' + r.id);
  if (r.truthDecomposition.some((d) => Math.abs(d.reconciledPnl - r.pnl.actual) > 1e-6))
    throw Error('Hindsight accounting mismatch ' + r.id);
}
const output = {
  scope:
    'New IDs from sources.json analyzed separately from historical baseline. Actual trades are counted from final public execution history; commands are attempts, never fills.',
  methods: {
    probabilities:
      'Matched pre-execution submitted command decision when same price/suit/side/epoch and either immediate take or observed own resting quote. Otherwise the latest preceding stored prediction, with its age reported. No current-model replay replaces historical forecasts.',
    matching:
      'A command can match at most one fill; direct takes must fill within 2.5 seconds, resting quotes must be observed owned at exactly that pre-fill epoch.',
    certainty:
      'Strong single: opening private-only top >=60%; concentrated two: top two >=75%; flat: top <=30%; moderate: other hands. Groups describe information, not expected profitability.',
    roundTrips:
      'FIFO buy then later sell in the same suit; dealt inventory is not assigned a purchase cost. Spread is an accounting subtrade, not a claim the cards are individually identifiable.',
    noTrade:
      'Reconstruct all payout-compatible initial goal allocations; hypothetical all players keep dealt allocation. Differences are descriptive, not a causal counterfactual replay of changed opponent behavior.',
    truthDecomposition:
      'Hindsight accounting only: initial payoff plus own trade cash/settle-now changes plus bonus changes caused by other players trading. This is not a simulation of how opponents would react had a trade been skipped.',
    risk: 'No-bonus P&L = current trade cash − ante + 10×held if that suit is goal. Current expected bonus can improve this figure; a bonus is never guaranteed.',
  },
  summary,
  examples,
  coaching,
  reports,
};
fs.writeFileSync(path.join(dir, 'trading-analysis.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log('ROUND_SUMMARY');
for (const r of newRounds)
  console.log(
    JSON.stringify({
      id: r.id,
      time: r.time,
      hand: r.startingHand,
      info: r.infoGroup,
      top: r.initialTop,
      top2: round(r.initialTop2),
      goal: r.goal,
      pnl: r.pnl,
      bonus: r.actualBonus,
      noTrade: r.noTradePnlRange,
      delta: r.versusNoTradeRange,
      held: r.endingHand,
      maxSpend: r.maxNetSpend,
      fills: r.counts.actualFills,
      scored: r.counts.pricedFillDecisions,
      negative: r.counts.negativeFullEvFills,
      lastP: r.lastForecast?.probabilities,
      lastEV: r.lastForecast?.estimatedPnl,
    }),
  );
