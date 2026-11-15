/*
 * Round wealth accounting. Adds up what your trades cost and earned, follows
 * your bank from the ante to settlement, and reports what the round paid once
 * that can be established.
 *
 * Trading cash flow is not profit until settlement.
 */
(function (scope) {
  'use strict';

  const SUIT_IDS = ['s', 'c', 'd', 'h'];
  const FLOW_FIELDS = ['spent', 'received', 'bought', 'sold', 'netCash'];
  // Recorded events after which the bank is observed again when restoring.
  const OBSERVED_EVENT_KINDS = ['round_start', 'checkpoint', 'state', 'clock'];

  // Every round the players ante this pot between them. It pays 10 chips per
  // goal card, and the rest to whoever holds the most goal cards.
  const POT_CHIPS = 200;
  const CHIPS_PER_GOAL_CARD = 10;
  const GOAL_SUIT_SIZES = [8, 10];

  const OFFICIAL_SOURCE = 'official-round-rankings';
  const RUNNING_TIMER = /^\d+:\d\d$/;
  const EXPIRED_TIMER = '0:00';

  // The opening bank is trusted once its estimate has held for this long.
  const OPENING_BANK_STABLE_MS = 1000;
  // The final bank is trusted once the round has been over for this long and
  // the balance has not moved for this long.
  const SETTLED_AFTER_END_MS = 3000;
  const SETTLED_BALANCE_STABLE_MS = 1500;
  // Slack, in chips, when a derived payout is checked against the pot.
  const PAYOUT_TOLERANCE = 1e-6;

  const isFiniteNumber = Number.isFinite;
  const sum = (values) => values.reduce((total, value) => total + value, 0);

  // ── Trading cash flow ──────────────────────────────────────────────────

  // What your trades spent and received, in total and for each suit.
  function cashFlow(snapshot) {
    const bySuit = Object.fromEntries(
      SUIT_IDS.map((id) => [id, { spent: 0, received: 0, bought: 0, sold: 0, netCash: 0 }]),
    );
    for (const trade of snapshot.trades || []) {
      const flow = bySuit[trade.suit];
      if (!flow || !isFiniteNumber(trade.p) || trade.p < 0) {
        throw Error('Invalid trade for round accounting');
      }
      if (trade.b === snapshot.self) {
        flow.spent += trade.p;
        flow.bought++;
      }
      if (trade.s === snapshot.self) {
        flow.received += trade.p;
        flow.sold++;
      }
    }
    const total = { spent: 0, received: 0, bought: 0, sold: 0, netCash: 0, bySuit };
    for (const flow of Object.values(bySuit)) {
      flow.netCash = flow.received - flow.spent;
      for (const field of FLOW_FIELDS) total[field] += flow[field];
    }
    return total;
  }

  // ── Following the bank ─────────────────────────────────────────────────

  // Updates the round's accounting with one observed snapshot and returns it.
  function observe(accounting, snapshot, at) {
    if (!accounting) accounting = {};
    const flow = cashFlow(snapshot);
    const ante = POT_CHIPS / snapshot.players.length;
    // The ante overlay animates balances. Freeze a reconciled opening bank only
    // after the live balance minus trade cash has stayed consistent for a second.
    if (isBalanceReadable(snapshot)) {
      const candidate = snapshot.cash - flow.netCash + ante;
      if (accounting.bankCandidate !== candidate) {
        accounting.bankCandidate = candidate;
        accounting.candidateSince = at;
      } else if (
        !isFiniteNumber(accounting.openingBank) &&
        at - accounting.candidateSince >= OPENING_BANK_STABLE_MS
      ) {
        accounting.openingBank = candidate;
        accounting.anchorAt = at;
        accounting.anchorSource = 'Reconciled live cash + ante − net trading cash';
      }
    }
    if (snapshot.status === 'ended') {
      if (!isFiniteNumber(accounting.endedAt)) accounting.endedAt = at;
      if (accounting.endCash !== snapshot.cash) {
        accounting.endCash = snapshot.cash;
        accounting.endCashSince = at;
      }
      accounting.endObservedAt = at;
    }
    return accounting;
  }

  // True once the ante has been paid and the round is under way: the clock is
  // running or a trade has happened.
  function isBalanceReadable(snapshot) {
    if (snapshot.status !== 'live' || snapshot.antePending || !isFiniteNumber(snapshot.cash)) {
      return false;
    }
    const clockRunning = RUNNING_TIMER.test(snapshot.timer) && snapshot.timer !== EXPIRED_TIMER;
    return Boolean(clockRunning || snapshot.trades.length);
  }

  // True once an ended round's final balance has stopped moving.
  function isSettled(snapshot, accounting) {
    return (
      snapshot.status === 'ended' &&
      isFiniteNumber(accounting.endedAt) &&
      accounting.endObservedAt - accounting.endedAt >= SETTLED_AFTER_END_MS &&
      accounting.endObservedAt - accounting.endCashSince >= SETTLED_BALANCE_STABLE_MS
    );
  }

  // Rebuilds the accounting of a recorded round from its events, then
  // observes the given snapshot, if any.
  function restore(events, snapshot, at) {
    const accounting = {};
    let replayed = null;
    for (const event of events) {
      if (event.kind === 'round_start' || event.kind === 'checkpoint') {
        replayed = JSON.parse(JSON.stringify(event.snapshot));
      }
      if (!replayed) continue;
      if (event.kind === 'fill' && event.index >= replayed.trades.length) {
        replayed.trades.push(event.trade);
      }
      if (event.kind === 'state') {
        Object.assign(replayed, {
          cash: event.cash,
          status: event.status,
          timer: event.timer,
          held: event.held,
        });
      }
      if (event.kind === 'clock') {
        Object.assign(replayed, { timer: event.timer, status: event.status });
      }
      if (OBSERVED_EVENT_KINDS.includes(event.kind)) observe(accounting, replayed, event.at);
    }
    if (snapshot) observe(accounting, snapshot, at);
    return accounting;
  }

  // ── Settlement ─────────────────────────────────────────────────────────

  // Your payout when every final hand is known, or null when the hands are
  // missing or cannot be a settled Figgie round.
  function handPayout(snapshot, result) {
    const goal = SUIT_IDS.indexOf(result?.goal);
    const hands = result?.finalHands;
    const everyHandKnown =
      goal >= 0 && hands && snapshot.players.every((player) => Array.isArray(hands[player.name]));
    if (!everyHandKnown) return null;
    const counts = snapshot.players.map((player) => hands[player.name][goal]);
    if (counts.some((count) => !Number.isInteger(count) || count < 0)) return null;
    const goalCards = sum(counts);
    if (!GOAL_SUIT_SIZES.includes(goalCards)) return null;
    if (counts[0] !== snapshot.held[goal]) return null;
    const most = Math.max(...counts);
    const leaders = counts.filter((count) => count === most).length;
    const bonus = POT_CHIPS - CHIPS_PER_GOAL_CARD * goalCards;
    return CHIPS_PER_GOAL_CARD * counts[0] + (counts[0] === most ? bonus / leaders : 0);
  }

  const isPossiblePayout = (payout) =>
    payout >= -PAYOUT_TOLERANCE && payout <= POT_CHIPS + PAYOUT_TOLERANCE;

  // What the round paid and earned, from revealed final hands.
  function resultFromHands(snapshot, flow, ante, result) {
    const payout = handPayout(snapshot, result);
    if (payout === null) return null;
    return { payout, pnl: flow.netCash - ante + payout, source: 'Revealed hands' };
  }

  // The same from Figgie's own rankings, once they match the bank on screen.
  function resultFromRankings(snapshot, flow, ante, result) {
    const official = snapshot.roundResult || result;
    const isTrusted =
      official?.verified &&
      official.source === OFFICIAL_SOURCE &&
      isFiniteNumber(official.settledProfit) &&
      official.settledBank === snapshot.cash;
    if (!isTrusted) return null;
    const payout = official.settledProfit - flow.netCash + ante;
    if (!isPossiblePayout(payout)) return null;
    return {
      payout: Math.max(0, payout),
      pnl: official.settledProfit,
      source: 'Official round result',
    };
  }

  // The same from the change in your bank over the round.
  function resultFromBank(flow, ante, accounting) {
    if (!isFiniteNumber(accounting.openingBank) || !isFiniteNumber(accounting.endCash)) {
      return null;
    }
    const payout = accounting.endCash - accounting.openingBank + ante - flow.netCash;
    // Reject unreconciled cash and partial updates rather than inventing profit.
    if (!isPossiblePayout(payout)) return null;
    return {
      payout: Math.max(0, payout),
      pnl: accounting.endCash - accounting.openingBank,
      source: 'Settled bank − pre-ante opening bank',
    };
  }

  // The actual result of an ended round. The official rankings come first,
  // then revealed hands, then the settled bank.
  function actualResult(snapshot, flow, ante, accounting, result, settled) {
    const ended = snapshot.status === 'ended';
    const fromHands = ended ? resultFromHands(snapshot, flow, ante, result) : null;
    const fromRankings = ended ? resultFromRankings(snapshot, flow, ante, result) : null;
    const fromBank = () => (settled ? resultFromBank(flow, ante, accounting) : null);
    return fromRankings || fromHands || fromBank() || { payout: null, pnl: null, source: null };
  }

  // ── Summary ────────────────────────────────────────────────────────────

  // What the round would pay and earn under each possible goal suit, by the
  // model's forecast of your settlement in that case.
  function goalScenarios(snapshot, model, flow, ante) {
    return SUIT_IDS.map((suit, index) => {
      const forecast = model?.bySuit?.[index];
      const settlement = forecast?.conditionalPayout;
      const probability = forecast?.probability ?? null;
      const isPossible = isFiniteNumber(probability) && probability > 0;
      const pnl = isFiniteNumber(settlement) ? flow.netCash - ante + settlement : null;
      return {
        suit,
        probability,
        settlement: isFiniteNumber(settlement) ? settlement : null,
        bonus: isFiniteNumber(forecast?.conditionalBonus) ? forecast.conditionalBonus : null,
        leaderProbability: forecast?.conditionalLeaderProbability ?? null,
        soloProbability: forecast?.conditionalSoloProbability ?? null,
        tieProbability: forecast?.conditionalTieProbability ?? null,
        noBonusProbability: forecast?.conditionalNoBonusProbability ?? null,
        noBonusPnl: isPossible
          ? flow.netCash - ante + CHIPS_PER_GOAL_CARD * snapshot.held[index]
          : null,
        pnl,
        weightedPnl: probabilityWeighted(probability, pnl),
      };
    });
  }

  function probabilityWeighted(probability, pnl) {
    if (probability === 0) return 0;
    if (!isFiniteNumber(probability) || !isFiniteNumber(pnl)) return null;
    return probability * pnl;
  }

  // The round's profit and loss so far: trading cash flow, the model's
  // estimate of settlement, and the actual result once it is known.
  function summary(snapshot, model = null, accounting = {}, result = null) {
    const flow = cashFlow(snapshot);
    const ante = POT_CHIPS / snapshot.players.length;
    const estimatedSettlement = isFiniteNumber(model?.expectedPayout) ? model.expectedPayout : null;
    const settled = isSettled(snapshot, accounting);
    const actual = actualResult(snapshot, flow, ante, accounting, result, settled);
    return {
      ...flow,
      goalScenarios: goalScenarios(snapshot, model, flow, ante),
      roundKey: snapshot.roundKey,
      ante,
      openingBank: isFiniteNumber(accounting.openingBank) ? accounting.openingBank : null,
      endingBank: settled ? accounting.endCash : null,
      estimatedSettlement,
      estimatedPnl: estimatedSettlement === null ? null : flow.netCash - ante + estimatedSettlement,
      actualPayout: actual.payout,
      actualPnl: actual.pnl,
      source: actual.source,
      settlementPending: snapshot.status === 'ended' && actual.pnl === null,
    };
  }

  scope.FiggiePnl = { cashFlow, observe, summary, restore, handPayout };
  if (typeof module !== 'undefined') module.exports = scope.FiggiePnl;
})(globalThis);
