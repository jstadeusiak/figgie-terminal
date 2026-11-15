#!/usr/bin/env node
'use strict';
// Read-only recorder audit. All times are local observation times, never exchange times.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SUITS = ['s', 'c', 'd', 'h'];
const NAMES = ['Spades', 'Clubs', 'Diamonds', 'Hearts'];
const MAX_HOLD_MS = 2000;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a) => {
  const b = a.slice().sort((x, y) => x - y);
  return b.length ? (b[Math.floor((b.length - 1) / 2)] + b[Math.floor(b.length / 2)]) / 2 : null;
};
const pct = (a, b) => (b ? (100 * a) / b : null);
const validPrice = (p) => Number.isFinite(p) && p > 0;
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
const copy = (x) => JSON.parse(JSON.stringify(x));

function reconstruct(events) {
  // Only source observations renew our confidence that an unchanged book remained visible.
  // Predictions/commands do not turn an unobserved gap into market coverage.
  const source = events.filter((e) =>
    ['round_start', 'checkpoint', 'state', 'clock', 'coverage'].includes(e.kind),
  );
  source.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const groups = new Map();
  for (const e of source) {
    if (!groups.has(e.at)) groups.set(e.at, []);
    groups.get(e.at).push(e);
  }
  let state = { status: 'unknown', antePending: false, book: [] };
  const frames = [];
  for (const [at, es] of groups) {
    let explicitGap = false;
    for (const e of es) {
      if (e.kind === 'round_start' || e.kind === 'checkpoint') {
        const s = e.snapshot;
        state = {
          status: s.status,
          antePending: s.antePending === true,
          book: s.markets.map((m) => [m.id, m.bid, m.ask, m.buyer, m.seller]),
        };
      } else if (e.kind === 'state') {
        state = {
          status: e.status,
          antePending: e.antePending === true,
          book: e.book.map((r) => r.slice(0, 5)),
        };
      } else if (e.kind === 'clock') state.status = e.status;
      else {
        explicitGap ||= e.gapSeconds > 0 || e.reason !== 'Source state changed';
        if (e.status) state.status = e.status;
      }
    }
    frames.push({ at, ...copy(state), explicitGap });
  }
  const intervals = [];
  const coverage = {
    maxUnobservedHoldSeconds: MAX_HOLD_MS / 1000,
    coveredSeconds: 0,
    excludedAnteSeconds: 0,
    excludedMissingGapSeconds: 0,
    excludedStatusBoundarySeconds: 0,
    excludedPausedOrNonliveSeconds: 0,
    observedLiveWallSeconds: 0,
  };
  const firstLive = frames.find((f) => f.status === 'live');
  const firstEnd = frames.find((f) => firstLive && f.at >= firstLive.at && f.status === 'ended');
  const endAt = firstEnd?.at ?? frames.at(-1)?.at;
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const dt = (b.at - a.at) / 1000;
    if (!firstLive || a.at < firstLive.at || a.at >= endAt || dt <= 0) continue;
    if (a.status === 'live') coverage.observedLiveWallSeconds += dt;
    let reason = null;
    if (a.status !== 'live') reason = 'excludedPausedOrNonliveSeconds';
    else if (b.status !== 'live') reason = 'excludedStatusBoundarySeconds';
    else if (dt * 1000 > MAX_HOLD_MS || b.explicitGap) reason = 'excludedMissingGapSeconds';
    else if (a.antePending || b.antePending) reason = 'excludedAnteSeconds';
    if (reason) coverage[reason] += dt;
    else {
      coverage.coveredSeconds += dt;
      intervals.push({ start: a.at, end: b.at, seconds: dt, book: a.book });
    }
  }
  coverage.liveSpanSeconds = firstLive && endAt ? (endAt - firstLive.at) / 1000 : 0;
  coverage.coveredPctOfObservedLiveWall = pct(
    coverage.coveredSeconds,
    coverage.observedLiveWallSeconds,
  );
  return { frames, intervals, coverage, endAt, firstAt: firstLive?.at };
}

function spanCovered(intervals, start, end) {
  if (end < start) return false;
  let at = start;
  for (const i of intervals) {
    if (i.end <= at) continue;
    if (i.start > at) return false;
    at = Math.min(end, i.end);
    if (at >= end) return true;
  }
  return at >= end;
}
function summarySide(bucket, denominator) {
  return {
    seconds: bucket.seconds,
    availabilityPct: pct(bucket.seconds, denominator),
    timeWeightedPrice: bucket.seconds ? bucket.value / bucket.seconds : null,
  };
}
function analyzeRound(metadata, events) {
  const { frames, intervals, coverage, endAt, firstAt } = reconstruct(events);
  const self = metadata.self;
  const fills = events.filter((e) => e.kind === 'fill').sort((a, b) => a.index - b.index);
  const observedFills = fills.filter((e) => !e.recovered);
  const resets = events.filter((e) => e.kind === 'book_reset').sort((a, b) => a.seq - b.seq);
  const quotes = events.filter((e) => e.kind === 'quote');
  const start = events.find((e) => e.kind === 'round_start')?.snapshot;
  const lastPrediction = events
    .filter(
      (e) =>
        e.kind === 'prediction' &&
        Array.isArray(e.probabilities) &&
        Array.isArray(e.baseline) &&
        e.at < endAt,
    )
    .at(-1);
  const summaries = SUITS.map((suit, index) => {
    const buckets = Object.fromEntries(
      [
        'bid',
        'ask',
        'ownBid',
        'ownAsk',
        'opponentBid',
        'opponentAsk',
        'unknownBid',
        'unknownAsk',
        'spread',
      ].map((k) => [k, { seconds: 0, value: 0 }]),
    );
    const add = (key, seconds, price) => {
      buckets[key].seconds += seconds;
      buckets[key].value += seconds * price;
    };
    const owners = {};
    let bidAtLeast5Seconds = 0;
    let bidAtLeast10Seconds = 0;
    let bothMissingSeconds = 0;
    for (const interval of intervals) {
      const row = interval.book.find((r) => r[0] === suit);
      if (!row) continue;
      const [, bid, ask, buyer, seller] = row;
      const dt = interval.seconds;
      for (const [side, price, owner] of [
        ['bid', bid, buyer],
        ['ask', ask, seller],
      ]) {
        if (!validPrice(price)) continue;
        add(side, dt, price);
        add(
          (!owner ? 'unknown' : owner === self ? 'own' : 'opponent') +
            (side === 'bid' ? 'Bid' : 'Ask'),
          dt,
          price,
        );
        if (owner) {
          owners[owner] ||= {
            bidSeconds: 0,
            bidValue: 0,
            askSeconds: 0,
            askValue: 0,
            bidAtLeast10Seconds: 0,
          };
          owners[owner][side + 'Seconds'] += dt;
          owners[owner][side + 'Value'] += dt * price;
          if (side === 'bid' && price >= 10) owners[owner].bidAtLeast10Seconds += dt;
        }
      }
      if (validPrice(bid) && validPrice(ask)) add('spread', dt, ask - bid);
      if (!validPrice(bid) && !validPrice(ask)) bothMissingSeconds += dt;
      if (validPrice(bid) && bid >= 5) bidAtLeast5Seconds += dt;
      if (validPrice(bid) && bid >= 10) bidAtLeast10Seconds += dt;
    }
    const suitFills = fills.filter((f) => f.trade.suit === suit);
    const bidQuotes = quotes.filter(
      (q) => q.suit === suit && q.side === 'bid' && !q.recovered && validPrice(q.price),
    );
    const episodes = resets.map((reset, i) => {
      const next = resets[i + 1];
      const stopAt = next?.at ?? endAt;
      const previous = frames
        .filter((f) => f.at < reset.at)
        .at(-1)
        ?.book.find((r) => r[0] === suit);
      const eligible = bidQuotes.filter(
        (q) => q.seq > reset.seq && (!next || q.seq < next.seq) && q.at <= stopAt,
      );
      const first = eligible[0];
      const sameOwner = previous?.[3] ? eligible.find((q) => q.owner === previous[3]) : null;
      return {
        epoch: reset.to,
        resetAt: reset.at,
        windowSeconds: (stopAt - reset.at) / 1000,
        previousBuyer: previous?.[3] ?? null,
        previousBid: previous?.[1] ?? null,
        firstBuyer: first?.owner ?? null,
        firstBid: first?.price ?? null,
        firstBidDelaySeconds: first ? (first.at - reset.at) / 1000 : null,
        firstBidDelayCovered: first ? spanCovered(intervals, reset.at, first.at) : false,
        sameBuyerReappeared: Boolean(sameOwner),
        sameBuyerDelaySeconds: sameOwner ? (sameOwner.at - reset.at) / 1000 : null,
        sameBuyerDelayCovered: sameOwner ? spanCovered(intervals, reset.at, sameOwner.at) : false,
        sameBuyerBid: sameOwner?.price ?? null,
        windowFullyCovered: spanCovered(intervals, reset.at, stopAt),
        absentIsCensored: !first && !spanCovered(intervals, reset.at, stopAt),
      };
    });
    const sameOwner = episodes.filter((e) => e.sameBuyerReappeared && e.sameBuyerDelayCovered);
    const firstBids = episodes.filter((e) => e.firstBidDelayCovered);
    const ownTrades = suitFills.filter((f) => f.trade.b === self || f.trade.s === self);
    return {
      suit,
      name: NAMES[index],
      goal: metadata.revealed?.goal === suit,
      book: Object.fromEntries(
        Object.entries(buckets).map(([k, b]) => [k, summarySide(b, coverage.coveredSeconds)]),
      ),
      persistence: {
        bidAtLeast5Seconds,
        bidAtLeast10Seconds,
        bidAtLeast5PctOfBidTime: pct(bidAtLeast5Seconds, buckets.bid.seconds),
        bidAtLeast10PctOfBidTime: pct(bidAtLeast10Seconds, buckets.bid.seconds),
        bothMissingSeconds,
        observedBidUpdates: bidQuotes.length,
        strictBidRaises: bidQuotes.filter((q) => validPrice(q.priorPrice) && q.price > q.priorPrice)
          .length,
        bidOwners: Object.fromEntries(
          Object.entries(owners).map(([owner, o]) => [
            owner,
            {
              bidSeconds: o.bidSeconds,
              bidTimeWeightedPrice: o.bidSeconds ? o.bidValue / o.bidSeconds : null,
              askSeconds: o.askSeconds,
              askTimeWeightedPrice: o.askSeconds ? o.askValue / o.askSeconds : null,
              bidAtLeast10Seconds: o.bidAtLeast10Seconds,
              bidEpochs: [
                ...new Set(bidQuotes.filter((q) => q.owner === owner).map((q) => q.epoch)),
              ].length,
            },
          ]),
        ),
      },
      resetRebid: {
        globalResets: resets.length,
        firstBidObserved: episodes.filter((e) => e.firstBuyer).length,
        firstBidDelayCoveredCount: firstBids.length,
        medianFirstBidDelaySeconds: median(firstBids.map((e) => e.firstBidDelaySeconds)),
        previousBidOwnerKnown: episodes.filter((e) => e.previousBuyer).length,
        sameBuyerReturnedCoveredCount: sameOwner.length,
        medianSameBuyerDelaySeconds: median(sameOwner.map((e) => e.sameBuyerDelaySeconds)),
        episodes,
      },
      trading: {
        fills: suitFills.length,
        recoveredFills: suitFills.filter((f) => f.recovered).length,
        turnoverPerCoveredMinute: coverage.coveredSeconds
          ? (suitFills.filter((f) => !f.recovered).length * 60) / coverage.coveredSeconds
          : null,
        cashVolume: suitFills.reduce((sum, f) => sum + f.trade.p, 0),
        meanPrice: mean(suitFills.map((f) => f.trade.p)),
        ownBuys: ownTrades.filter((f) => f.trade.b === self).length,
        ownSells: ownTrades.filter((f) => f.trade.s === self).length,
        fillsDetail: suitFills.map((f) => ({
          index: f.index,
          at: f.at,
          secondsFromStart: (f.at - firstAt) / 1000,
          ...f.trade,
          recovered: Boolean(f.recovered),
          initiator: f.initiator,
          resting: f.resting,
          initiatorConfidence: f.initiatorConfidence,
        })),
      },
    };
  });
  const latencies = observedFills.slice(1).map((f, i) => ({
    fromIndex: observedFills[i].index,
    toIndex: f.index,
    observedSeconds: (f.at - observedFills[i].at) / 1000,
    fullyCovered: spanCovered(intervals, observedFills[i].at, f.at),
    coalesced: f.at === observedFills[i].at,
  }));
  const eligibleLatency = latencies.filter((x) => x.fullyCovered).map((x) => x.observedSeconds);
  return {
    id: metadata.id,
    self,
    version: metadata.version,
    goal: metadata.revealed?.goal ?? null,
    officialResultVerified: metadata.revealed?.verified === true,
    practice: metadata.practice === true || events.some((e) => e.kind === 'practice_mode'),
    context: start?.context,
    profit: metadata.revealed?.settledProfit ?? null,
    players: start?.players?.map((p) => p.name),
    initialHand: start?.held,
    initialRecordedTradeCount: start?.trades?.length ?? null,
    coverage,
    fills: fills.length,
    recoveredFills: fills.filter((f) => f.recovered).length,
    finalSavedPrediction: lastPrediction
      ? {
          at: lastPrediction.at,
          tradeCount: lastPrediction.tradeCount,
          probabilities: lastPrediction.probabilities,
          structuralBaseline: lastPrediction.baseline,
          behaviorDifferencePercentagePoints: lastPrediction.probabilities.map(
            (p, i) => 100 * (p - lastPrediction.baseline[i]),
          ),
        }
      : null,
    fillTiming: {
      meaning:
        'Time between local observations of fills, not exchange execution latency or order latency.',
      intervals: latencies,
      continuousIntervals: eligibleLatency.length,
      meanSeconds: mean(eligibleLatency),
      medianSeconds: median(eligibleLatency),
      minSeconds: eligibleLatency.length ? Math.min(...eligibleLatency) : null,
      maxSeconds: eligibleLatency.length ? Math.max(...eligibleLatency) : null,
    },
    suits: summaries,
  };
}

function historicalComparison(rounds, latestId) {
  const eligible = rounds.filter(
    (r) =>
      r.id !== latestId &&
      r.officialResultVerified &&
      !r.practice &&
      SUITS.includes(r.goal) &&
      r.initialRecordedTradeCount === 0 &&
      r.recoveredFills === 0 &&
      r.coverage.coveredSeconds >= 30 &&
      r.coverage.coveredPctOfObservedLiveWall >= 80,
  );
  const fields = {
    bidPrice: (s) => s.book.bid.timeWeightedPrice,
    askPrice: (s) => s.book.ask.timeWeightedPrice,
    spread: (s) => s.book.spread.timeWeightedPrice,
    bidAvailabilityPct: (s) => s.book.bid.availabilityPct,
    askAvailabilityPct: (s) => s.book.ask.availabilityPct,
    twoSidedAvailabilityPct: (s) => s.book.spread.availabilityPct,
    fills: (s) => s.trading.fills,
    highBidTimePct: (s) => s.persistence.bidAtLeast10PctOfBidTime,
  };
  const paired = eligible.map((r) => {
    const goal = r.suits.find((s) => s.goal);
    const others = r.suits.filter((s) => !s.goal);
    return {
      id: r.id,
      goal: r.goal,
      profit: r.profit,
      coveredSeconds: r.coverage.coveredSeconds,
      metrics: Object.fromEntries(
        Object.entries(fields).map(([k, fn]) => {
          const g = fn(goal);
          const other = mean(others.map(fn).filter(Number.isFinite));
          return [
            k,
            {
              goal: g,
              otherSuitsMean: other,
              difference: Number.isFinite(g) && Number.isFinite(other) ? g - other : null,
            },
          ];
        }),
      ),
    };
  });
  return {
    description:
      'Descriptive retrospective comparison of goal versus the mean of the other three suits within each completed closed-hand round; then equal-weight rounds. No fitted signal, no held-out claim, no independence claim. Official here means verified settlement, not ranked matchmaking.',
    eligibleRounds: eligible.length,
    allOtherVerifiedClosedHandRounds: rounds.filter(
      (r) => r.id !== latestId && r.officialResultVerified && !r.practice,
    ).length,
    filters:
      'Recording starts with zero fills; no recovered fills; at least 30 covered seconds; at least 80% covered/live wall time; verified goal; not exposed-hands practice.',
    mean: Object.fromEntries(
      Object.keys(fields).map((k) => {
        const a = paired.map((r) => r.metrics[k]).filter((m) => Number.isFinite(m.difference));
        return [
          k,
          {
            pairedRounds: a.length,
            goal: mean(a.map((m) => m.goal)),
            otherSuitsMean: mean(a.map((m) => m.otherSuitsMean)),
            difference: mean(a.map((m) => m.difference)),
          },
        ];
      }),
    ),
    rounds: paired,
  };
}

function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input)
    throw Error(
      'Usage: node research/audit-friction.cjs RECORDING.ndjson [OUTPUT.json] [ROUND_ID]',
    );
  const output =
    args[1] || path.resolve(__dirname, '../outputs/friction-review-2026-10-29/friction-audit.json');
  let latestId = args[2];
  const raw = fs.readFileSync(input, 'utf8');
  const rows = raw.trim().split('\n').map(JSON.parse);
  const byRound = new Map();
  for (const e of rows)
    if (e.roundId) {
      if (!byRound.has(e.roundId)) byRound.set(e.roundId, []);
      byRound.get(e.roundId).push(e);
    }
  const rounds = rows
    .filter((r) => r.kind === 'round_metadata')
    .map((m) =>
      analyzeRound(
        m,
        (byRound.get(m.id) || []).sort((a, b) => a.seq - b.seq),
      ),
    );
  latestId ||= rounds.at(-1)?.id;
  const latest = rounds.find((r) => r.id === latestId);
  if (!latest) throw Error('Requested round not present');
  const result = {
    schema: 1,
    createdAt: new Date().toISOString(),
    source: { input, sha256: hash(raw), scriptSha256: hash(fs.readFileSync(__filename)) },
    methodology: [
      'Visible best quotes only, weighted by seconds within bounded live source-observation intervals. Prices are conditional on availability; missing quotes are never zero prices.',
      'Same-timestamp source events collapse to the last source state. Its book applies only forward to the next observation. Commands and predictions do not refresh coverage.',
      'Only consecutive source observations at most 2 seconds apart, both live, with ante complete and no explicit incoming gap are covered. Longer gaps are entirely excluded; no extrapolation after the last observation. Paused/status transitions are excluded.',
      'Own versus opponent means the displayed top quote owner. Deeper losing quotes are not observed. Spread is conditional on both displayed sides, possibly including own quotes.',
      'High-bid persistence reports fixed transparent thresholds of 5 and 10 game chips, not fitted cutoffs or a claim those bids are informed. Bonus value can justify prices above 10.',
      'Rebids use observed quote events after each global fill reset until the next reset/end. Continuity is checked before reporting a delay. Absence with incomplete coverage is censored.',
      'The export contains DOM-coalesced observations. Fill timestamps are observation times; quantities are one card per fill. This cannot measure true exchange/order execution latency.',
      'Exposed-hands practice is excluded from the historical comparison. Quote prices already inform the model; a new friction feature requires validation of its incremental information.',
    ],
    latest,
    historicalComparison: historicalComparison(rounds, latestId),
    roundCoverage: rounds.map((r) => ({
      id: r.id,
      practice: r.practice,
      verified: r.officialResultVerified,
      goal: r.goal,
      ...r.coverage,
    })),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        output,
        coveredSeconds: latest.coverage.coveredSeconds,
        suits: latest.suits.map((s) => ({
          suit: s.suit,
          bid: s.book.bid.timeWeightedPrice,
          ask: s.book.ask.timeWeightedPrice,
          spread: s.book.spread.timeWeightedPrice,
          bidAvailablePct: s.book.bid.availabilityPct,
          askAvailablePct: s.book.ask.availabilityPct,
          fills: s.trading.fills,
        })),
        comparisonRounds: result.historicalComparison.eligibleRounds,
      },
      null,
      2,
    ),
  );
}
if (require.main === module) main();
module.exports = { reconstruct, analyzeRound, historicalComparison, spanCovered };
