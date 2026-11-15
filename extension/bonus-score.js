/*
 * Bonus forecast scoring. Scores the bonus forecasts stored during a round
 * after it has settled, without changing any forecast.
 *
 * Official payouts identify feasible final goal holdings. Reverse public fills
 * to label the SAME inventory checkpoint; later trades are never forecast error.
 */
(function (scope) {
  'use strict';

  const SUIT_IDS = ['s', 'c', 'd', 'h'];
  const OFFICIAL_SOURCE = 'official-round-rankings';

  const DECK_SIZE = 40;
  const PLAYER_COUNTS = [4, 5];
  const SUIT_SIZE = 10;
  const LARGE_SUIT_SIZE = 12;
  const SMALL_SUIT_SIZE = 8;
  // The goal is never the 12-card suit, so it has 8 or 10 cards.
  const GOAL_SUIT_SIZES = [8, 10];
  const POT_CHIPS = 200;
  const CHIPS_PER_GOAL_CARD = 10;
  // The whole bonus when the goal suit has 8 cards.
  const MAX_BONUS_CHIPS = 120;

  // Chip amounts closer than this are equal.
  const CHIP_TOLERANCE = 1e-6;
  // Limits on the work one stored round may ask for.
  const MAX_EVENTS = 20000;
  const MAX_TRADES = 2000;
  const MAX_HISTORY_CHECKS = 200000;

  const BONUS_CATEGORIES = ['solo', 'tie', 'none'];

  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const near = (a, b) =>
    Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= CHIP_TOLERANCE;
  const isHand = (counts) =>
    Array.isArray(counts) &&
    counts.length === SUIT_IDS.length &&
    counts.every((count) => Number.isInteger(count) && count >= 0 && count <= DECK_SIZE);
  const sameTrade = (a, b) =>
    a && b && a.b === b.b && a.s === b.s && a.suit === b.suit && a.p === b.p;
  const sameList = (a, b) =>
    Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
  const isProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  const mean = (points, key) =>
    points.length ? sum(points.map((point) => point[key])) / points.length : null;

  function fail(reason) {
    return { score: null, reason };
  }

  // The partner of a suit is the other suit of its color: spades and clubs,
  // diamonds and hearts. The goal's partner is the 12-card suit.
  const partnerOf = (suit) => suit ^ 1;

  // ── Audit ──────────────────────────────────────────────────────────────

  // Scores one settled round's stored bonus forecasts. Returns the score, or
  // the reason the round cannot be scored. `options.includeLabels` adds the
  // feasible goal holdings at every scored checkpoint.
  function auditRound(journal, options = {}) {
    const Journal =
      scope.FiggieJournal || (typeof require === 'function' ? require('./journal.js') : null);
    if (Journal?.isPractice(journal)) {
      return fail('Practice rounds are excluded from normal bonus calibration');
    }
    const snapshot = journal?.previous || journal?.snapshot;
    const result = journal?.revealed;
    const events = journal?.events;
    if (!isOfficiallySettled(snapshot, result)) {
      return fail('Verified official settlement required');
    }
    if (!hasBoundedHistory(snapshot, events)) return fail('Missing or oversized round history');

    const names = snapshot.players.map((player) => player?.name);
    const playerCount = names.length;
    const round = {
      id: journal.id,
      snapshot,
      result,
      names,
      playerCount,
      dealSize: DECK_SIZE / playerCount,
      self: names.indexOf(snapshot.self),
      goal: SUIT_IDS.indexOf(result.goal),
      ante: POT_CHIPS / playerCount,
    };
    if (!hasValidTable(round)) return fail('Invalid players or own inventory');
    if (!hasZeroSumProfits(round)) return fail('Complete zero-sum official profits required');
    const selfProfit = result.profits[snapshot.self];
    if (result.settledProfit !== undefined && !near(result.settledProfit, selfProfit)) {
      return fail('Official self profit mismatch');
    }

    const flows = tradeFlows(snapshot.trades, names);
    if (!flows) return fail('Malformed trade');
    Object.assign(round, { net: flows.net, minimum: flows.minimum });
    if (!reconcilesWithFills(round)) {
      return fail('Final inventory does not reconcile with complete fills');
    }
    const payouts = names.map((name, seat) => result.profits[name] - flows.cash[seat] + round.ante);
    const payoutsInRange = payouts.every(
      (payout) => payout >= -CHIP_TOLERANCE && payout <= POT_CHIPS + CHIP_TOLERANCE,
    );
    if (!payoutsInRange || !near(sum(payouts), POT_CHIPS)) {
      return fail('Official payouts do not reconcile');
    }
    const candidates = goalHoldingCandidates(round, payouts);
    if (!candidates.length) return fail('No feasible goal holdings reproduce official payouts');

    const replay = replayForecasts(round, events, candidates, options.includeLabels === true);
    if (replay.failure) return fail(replay.failure);
    const { points, labels, counts } = replay;
    const optionalLabels = options.includeLabels === true ? { labels } : {};
    if (!points.length) {
      const reason = counts.ambiguous
        ? 'All bonus truths are ambiguous'
        : 'No eligible live bonus forecasts';
      return { ...fail(reason), settlementVerified: true, ...optionalLabels };
    }
    return {
      reason: null,
      settlementVerified: true,
      ...optionalLabels,
      score: forecastScore(round, points, counts, candidates.length),
    };
  }

  function scoreRound(journal) {
    return auditRound(journal).score;
  }

  // ── Validating the settled round ───────────────────────────────────────

  function isOfficiallySettled(snapshot, result) {
    return Boolean(
      snapshot &&
      snapshot.status === 'ended' &&
      result &&
      result.verified === true &&
      result.source === OFFICIAL_SOURCE &&
      SUIT_IDS.includes(result.goal),
    );
  }

  function hasBoundedHistory(snapshot, events) {
    return (
      Array.isArray(snapshot.players) &&
      PLAYER_COUNTS.includes(snapshot.players.length) &&
      Array.isArray(snapshot.trades) &&
      snapshot.trades.length <= MAX_TRADES &&
      Array.isArray(events) &&
      events.length > 0 &&
      events.length <= MAX_EVENTS
    );
  }

  function hasValidTable({ snapshot, names, playerCount, dealSize, self }) {
    const everyPlayerNamed = names.every((name) => typeof name === 'string' && name);
    return (
      everyPlayerNamed &&
      new Set(names).size === playerCount &&
      self >= 0 &&
      isHand(snapshot.startingHand) &&
      sum(snapshot.startingHand) === dealSize &&
      isHand(snapshot.held)
    );
  }

  function hasZeroSumProfits({ result, names, playerCount }) {
    const { profits } = result;
    if (!profits || Object.keys(profits).length !== playerCount) return false;
    const everyProfitKnown = names.every(
      (name) => Object.hasOwn(profits, name) && Number.isFinite(profits[name]),
    );
    if (!everyProfitKnown) return false;
    const total = sum(names.map((name) => profits[name]));
    return near(total, 0);
  }

  // Adds up the executed trades: each player's net cards per suit, the most of
  // each suit a player has been net short (so must have been dealt), and each
  // player's net trading cash. Returns null when a trade is malformed.
  function tradeFlows(trades, names) {
    const net = names.map(() => [0, 0, 0, 0]);
    const minimum = names.map(() => [0, 0, 0, 0]);
    const cash = names.map(() => 0);
    for (const trade of trades) {
      const seller = names.indexOf(trade?.s);
      const buyer = names.indexOf(trade?.b);
      const suit = SUIT_IDS.indexOf(trade?.suit);
      const isMalformed =
        seller < 0 ||
        buyer < 0 ||
        seller === buyer ||
        suit < 0 ||
        !Number.isFinite(trade.p) ||
        trade.p < 0;
      if (isMalformed) return null;
      net[seller][suit]--;
      net[buyer][suit]++;
      minimum[seller][suit] = Math.max(minimum[seller][suit], -net[seller][suit]);
      cash[seller] += trade.p;
      cash[buyer] -= trade.p;
    }
    return { net, minimum, cash };
  }

  // Your final hand and every player's final card count must follow from the
  // deal and the executed trades.
  function reconcilesWithFills({ snapshot, dealSize, self, net, minimum }) {
    const { startingHand, held, players } = snapshot;
    return (
      held.every((count, suit) => count === startingHand[suit] + net[self][suit]) &&
      startingHand.every((count, suit) => count >= minimum[self][suit]) &&
      players.every(
        (player, seat) =>
          Number.isInteger(player.cards) && player.cards === dealSize + sum(net[seat]),
      )
    );
  }

  // ── Goal holdings that reproduce the payouts ───────────────────────────

  // Every way the players could have been dealt the goal suit that reproduces
  // the official payouts: the starting goal cards per seat and the bonus pool.
  function goalHoldingCandidates(round, payouts) {
    const { snapshot, playerCount, self, goal, net } = round;
    const candidates = [];
    for (const goalCards of GOAL_SUIT_SIZES) {
      const counts = Array(playerCount).fill(0);
      const bonus = POT_CHIPS - CHIPS_PER_GOAL_CARD * goalCards;

      const keepIfConsistent = () => {
        const most = Math.max(...counts);
        const leaders = counts.filter((count) => count === most).length;
        const reproducesPayouts = counts.every((count, seat) =>
          near(CHIPS_PER_GOAL_CARD * count + (count === most ? bonus / leaders : 0), payouts[seat]),
        );
        if (!reproducesPayouts) return;
        const initial = counts.map((count, seat) => count - net[seat][goal]);
        if (isFeasibleDeal(round, initial, goalCards)) candidates.push({ initial, bonus });
      };

      // Tries every split of the remaining goal cards over the seats from `seat` on.
      const enumerate = (seat, remaining) => {
        if (seat === playerCount) {
          if (!remaining) keepIfConsistent();
          return;
        }
        if (seat === self) {
          const count = snapshot.held[goal];
          if (count <= remaining) {
            counts[seat] = count;
            enumerate(seat + 1, remaining - count);
          }
          return;
        }
        const most = Math.min(remaining, snapshot.players[seat].cards);
        for (let count = 0; count <= most; count++) {
          counts[seat] = count;
          enumerate(seat + 1, remaining - count);
        }
      };
      enumerate(0, goalCards);
    }
    return candidates;
  }

  // With a fixed goal column and own hand, the remaining cells form a complete
  // transportation table. Nonnegative row/column residuals are sufficient for a
  // feasible integer allocation above the executed-sale minimum in every suit.
  function isFeasibleDeal(round, initial, goalCards) {
    const { snapshot, dealSize, self, goal, minimum } = round;
    const { startingHand } = snapshot;
    const largeSuit = partnerOf(goal);
    for (let smallSuit = 0; smallSuit < SUIT_IDS.length; smallSuit++) {
      if (smallSuit === largeSuit) continue;
      const deck = [SUIT_SIZE, SUIT_SIZE, SUIT_SIZE, SUIT_SIZE];
      deck[largeSuit] = LARGE_SUIT_SIZE;
      deck[smallSuit] = SMALL_SUIT_SIZE;
      if (deck[goal] !== goalCards) continue;
      if (startingHand.some((count, suit) => count > deck[suit])) continue;

      const goalCountsAllowed =
        initial.every(
          (count, seat) =>
            Number.isInteger(count) && count >= minimum[seat][goal] && count <= dealSize,
        ) && initial[self] === startingHand[goal];
      if (!goalCountsAllowed) continue;

      // Each other hand must have room for the non-goal cards it has sold.
      const handsHaveRoom = initial.every((count, seat) => {
        if (seat === self) return true;
        const soldOtherSuits = sum(minimum[seat].filter((_, suit) => suit !== goal));
        return dealSize - count - soldOtherSuits >= 0;
      });
      if (!handsHaveRoom) continue;

      // Each other suit must have enough cards for your hand and the others' sales.
      const suitsHaveCards = deck.every((size, suit) => {
        if (suit === goal) return true;
        const soldByOthers = sum(minimum.map((row, seat) => (seat === self ? 0 : row[suit])));
        return size - startingHand[suit] - soldByOthers >= 0;
      });
      if (!suitsHaveCards) continue;
      return true;
    }
    return false;
  }

  // ── Replaying the recorded forecasts ───────────────────────────────────

  // Walks the recorded events in order, rebuilding the public card flow, and
  // scores each live forecast against the bonus its own checkpoint would have
  // paid. Returns the scored points, or the reason the recording is unusable.
  function replayForecasts(round, events, candidates, includeLabels) {
    const { snapshot, result, names, self, goal } = round;
    const progress = {
      flow: names.map(() => [0, 0, 0, 0]),
      tradeCount: 0,
      started: false,
      phase: 'unknown',
      outcomeKnown: false,
      historyChecks: 0,
    };
    const counts = { all: 0, eligible: 0, ambiguous: 0 };
    const points = [];
    const labels = [];

    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const isForeign =
        event?.roundId !== undefined && round.id !== undefined && event.roundId !== round.id;
      if (!event || event.seq !== index + 1 || isForeign) {
        return { failure: 'Incomplete or unordered journal sequence' };
      }
      const failure = advance(progress, event, round);
      if (failure) return { failure };
      if (event.kind !== 'prediction') continue;

      counts.all++;
      const isLiveCheckpoint =
        progress.started &&
        progress.phase === 'live' &&
        !progress.outcomeKnown &&
        event.tradeCount === progress.tradeCount;
      if (!isLiveCheckpoint) continue;
      const holdingsNow = candidates.map((candidate) =>
        candidate.initial.map((count, seat) => count + progress.flow[seat][goal]),
      );
      // Offline-only labels: all allocations still feasible under the official outcome.
      // Never fed into inference; default scoreRound output and label rules are unchanged.
      if (includeLabels) {
        labels.push({
          seq: event.seq,
          tradeCount: progress.tradeCount,
          goal: result.goal,
          names: names.slice(),
          selfIndex: self,
          candidates: candidates.map((candidate, which) => ({
            counts: holdingsNow[which],
            bonusPool: candidate.bonus,
          })),
        });
      }
      const scenario = Array.isArray(event.goalScenarios)
        ? event.goalScenarios.find((forecast) => forecast?.suit === result.goal)
        : null;
      const hasBonusForecast =
        scenario &&
        Number.isFinite(scenario.bonus) &&
        scenario.bonus >= 0 &&
        scenario.bonus <= MAX_BONUS_CHIPS;
      if (!hasBonusForecast) continue;

      counts.eligible++;
      const truths = candidates.map((candidate, which) =>
        settleNowBonus(holdingsNow[which], self, candidate.bonus),
      );
      const isUnambiguous = truths.every(
        (truth) => near(truth.bonus, truths[0].bonus) && truth.category === truths[0].category,
      );
      if (!isUnambiguous) {
        counts.ambiguous++;
        continue;
      }
      points.push(forecastPoint(scenario, truths[0]));
    }

    if (!progress.started || progress.tradeCount !== snapshot.trades.length) {
      return { failure: 'Missing complete fill journal' };
    }
    return { points, labels, counts };
  }

  // Applies one recorded event to the replay. Returns the reason the recording
  // cannot be trusted, or null.
  function advance(progress, event, round) {
    const { snapshot, names } = round;
    if (event.kind === 'round_start') {
      if (progress.started || progress.tradeCount || event.snapshot?.trades?.length) {
        return 'Recovered or repeated round start';
      }
      if (!matchesReplay(progress, event.snapshot, round)) return 'Inconsistent opening checkpoint';
      progress.started = true;
      progress.phase = event.snapshot.status;
    }
    if (event.kind === 'fill') {
      const isNextFill =
        progress.started &&
        !event.recovered &&
        event.index === progress.tradeCount &&
        sameTrade(event.trade, snapshot.trades[progress.tradeCount]);
      if (!isNextFill) return 'Recovered, missing, or changed fill history';
      const suit = SUIT_IDS.indexOf(event.trade.suit);
      progress.flow[names.indexOf(event.trade.s)][suit]--;
      progress.flow[names.indexOf(event.trade.b)][suit]++;
      progress.tradeCount++;
    }
    if (event.kind === 'checkpoint') {
      if (!progress.started || !matchesReplay(progress, event.snapshot, round)) {
        return 'Inconsistent checkpoint history';
      }
      progress.phase = event.snapshot.status;
    }
    if (event.kind === 'state') {
      if (!progress.started || !sameList(event.held, heldNow(progress, round))) {
        return 'State inventory contradicts fills';
      }
      progress.phase = event.status;
    }
    if (event.kind === 'clock') progress.phase = event.status;
    const revealsOutcome =
      event.kind === 'reveal' ||
      (event.kind === 'settlement_pending' && SUIT_IDS.includes(event.result?.goal)) ||
      progress.phase === 'ended' ||
      SUIT_IDS.includes(event.roundResult?.goal) ||
      SUIT_IDS.includes(event.snapshot?.roundResult?.goal);
    if (revealsOutcome) progress.outcomeKnown = true;
    return null;
  }

  // Your inventory at this point of the replay.
  function heldNow(progress, { snapshot, self }) {
    return snapshot.startingHand.map((count, suit) => count + progress.flow[self][suit]);
  }

  // True when a recorded snapshot shows the same table, hand and trade history
  // as the replay at this point.
  function matchesReplay(progress, recorded, round) {
    const { snapshot, names } = round;
    const sameTable =
      recorded &&
      recorded.self === snapshot.self &&
      sameList(recorded.startingHand, snapshot.startingHand) &&
      Array.isArray(recorded.players) &&
      sameList(
        recorded.players.map((player) => player?.name),
        names,
      ) &&
      Array.isArray(recorded.trades) &&
      recorded.trades.length === progress.tradeCount &&
      sameList(recorded.held, heldNow(progress, round));
    if (!sameTable) return false;
    progress.historyChecks += recorded.trades.length;
    if (progress.historyChecks > MAX_HISTORY_CHECKS) return false;
    return recorded.trades.every((trade, index) => sameTrade(trade, snapshot.trades[index]));
  }

  // The bonus you would take if the round settled with these goal holdings.
  function settleNowBonus(holdings, self, bonusPool) {
    const most = Math.max(...holdings);
    const leaders = holdings.filter((count) => count === most).length;
    if (holdings[self] !== most) return { bonus: 0, category: 'none' };
    return { bonus: bonusPool / leaders, category: leaders === 1 ? 'solo' : 'tie' };
  }

  // One forecast's errors against the true settle-now bonus.
  function forecastPoint(scenario, truth) {
    const probabilities = [
      scenario.soloProbability,
      scenario.tieProbability,
      scenario.noBonusProbability,
    ];
    const category = BONUS_CATEGORIES.indexOf(truth.category);
    const hasCategoryForecast = probabilities.every(isProbability) && near(sum(probabilities), 1);
    const categoryBrier = hasCategoryForecast
      ? sum(
          probabilities.map(
            (probability, which) => (probability - Number(which === category)) ** 2,
          ),
        )
      : null;
    const leaderBrier = isProbability(scenario.leaderProbability)
      ? (scenario.leaderProbability - Number(truth.category !== 'none')) ** 2
      : null;
    return { error: scenario.bonus - truth.bonus, categoryBrier, leaderBrier };
  }

  // ── Score ──────────────────────────────────────────────────────────────

  function forecastScore(round, points, counts, candidateCount) {
    const categoryPoints = points.filter((point) => point.categoryBrier !== null);
    const leaderPoints = points.filter((point) => point.leaderBrier !== null);
    const bonusMse = sum(points.map((point) => point.error * point.error)) / points.length;
    return {
      roundId: round.id,
      goal: round.result.goal,
      checkpoints: points.length,
      excludedCheckpoints: counts.all - points.length,
      eligibleCheckpoints: counts.eligible,
      ambiguousCheckpoints: counts.ambiguous,
      candidateAllocations: candidateCount,
      bonusMae: sum(points.map((point) => Math.abs(point.error))) / points.length,
      bonusBias: mean(points, 'error'),
      bonusMse,
      bonusRmse: Math.sqrt(bonusMse),
      categoryBrier: mean(categoryPoints, 'categoryBrier'),
      categoryCheckpoints: categoryPoints.length,
      leaderBrier: mean(leaderPoints, 'leaderBrier'),
      leaderCheckpoints: leaderPoints.length,
      method: 'Official payouts; settle-now bonus at each saved live inventory checkpoint',
    };
  }

  scope.FiggieBonusScore = { scoreRound, auditRound };
  if (typeof module !== 'undefined') module.exports = scope.FiggieBonusScore;
})(globalThis);
