/*
 * Practice truth. When a practice round shows every hand, this works out the
 * exact goal suit, what the current hands would pay, and what moving one card
 * would be worth, to set beside the model's blind estimates. It also strips a
 * snapshot down to what the blind model may see.
 *
 * Training truth is an isolated teaching result, never an inference input.
 * Values below settle the current hands immediately; they predict no future trades.
 */
(function (scope) {
  'use strict';

  const Belief =
    scope.FiggieBelief || (typeof require === 'function' ? require('./belief.js') : null);

  const SUIT_IDS = ['s', 'c', 'd', 'h'];
  const DECK_SIZE = 40;
  const PLAYER_COUNTS = [4, 5];
  const LARGE_SUIT_SIZE = 12;
  const SORTED_SUIT_SIZES = '8,10,10,12';
  const POT_CHIPS = 200;
  const CHIPS_PER_GOAL_CARD = 10;

  // Statuses in which a practice comparison is shown.
  const ACTIVE_STATUSES = ['live', 'paused'];
  // How far four probabilities may sum from one.
  const SUM_TOLERANCE = 1e-8;
  // A true goal given less probability than this has its log loss capped.
  const LOG_LOSS_PROBABILITY_FLOOR = 1e-12;

  // The public fields of a snapshot, by level. See blindSnapshot.
  const PUBLIC_SNAPSHOT_FIELDS = [
    'status',
    'reason',
    'antePending',
    'self',
    'cash',
    'round',
    'timer',
    'room',
    'roundKey',
  ];
  const PUBLIC_HAND_FIELDS = ['held', 'startingHand'];
  const PUBLIC_PLAYER_FIELDS = ['name', 'cash', 'color', 'cards'];
  const PUBLIC_TRADE_FIELDS = ['b', 's', 'suit', 'p'];
  const PUBLIC_CONTEXT_FIELDS = ['botDifficulty'];
  // The market fields that make up the snapshot signature, in signature order.
  const QUOTE_SIGNATURE_FIELDS = [
    'bid',
    'ask',
    'buyer',
    'seller',
    'canBuy',
    'canSell',
    'canBid',
    'canOffer',
    'canRaiseBid',
    'canLowerAsk',
    'canCancelBid',
    'canCancelOffer',
  ];
  const PUBLIC_MARKET_FIELDS = [
    'id',
    'name',
    'symbol',
    'color',
    'card',
    'viewBox',
    'held',
    ...QUOTE_SIGNATURE_FIELDS,
  ];

  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const copy = (list) => list.slice();
  const unavailable = (reason) => ({ available: false, reason });

  const isHand = (hand) =>
    Array.isArray(hand) &&
    hand.length === SUIT_IDS.length &&
    hand.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= LARGE_SUIT_SIZE);

  const isProbabilityVector = (probabilities) =>
    Array.isArray(probabilities) &&
    probabilities.length === SUIT_IDS.length &&
    probabilities.every(
      (probability) => Number.isFinite(probability) && probability >= 0 && probability <= 1,
    ) &&
    Math.abs(sum(probabilities) - 1) < SUM_TOLERANCE;

  // The number of ways to choose `picked` of `total` cards.
  function choose(total, picked) {
    if (picked < 0 || picked > total) return 0;
    const fewer = Math.min(picked, total - picked);
    let ways = 1;
    for (let step = 1; step <= fewer; step++) ways *= (total - fewer + step) / step;
    return ways;
  }

  // The listed fields of an object, where it has them.
  function pick(source, fields) {
    const picked = {};
    for (const field of fields) {
      if (source && Object.hasOwn(source, field)) picked[field] = source[field];
    }
    return picked;
  }

  // ── Blind snapshot ─────────────────────────────────────────────────────

  /* Explicit public-field allowlists prevent new truth fields from silently entering
     either the blind model or its cache/signature. The returned snapshot is a copy. */
  function blindSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const blind = pick(snapshot, PUBLIC_SNAPSHOT_FIELDS);
    for (const field of PUBLIC_HAND_FIELDS) {
      if (Array.isArray(snapshot[field])) blind[field] = copy(snapshot[field]);
    }
    if (Array.isArray(snapshot.net)) blind.net = snapshot.net.map(copy);
    if (Array.isArray(snapshot.players)) blind.players = snapshot.players.map(publicPlayer);
    if (Array.isArray(snapshot.trades)) blind.trades = snapshot.trades.map(publicTrade);
    if (Array.isArray(snapshot.markets)) blind.markets = snapshot.markets.map(publicMarket);
    blind.context = pick(snapshot.context, PUBLIC_CONTEXT_FIELDS);
    if (typeof snapshot.context?.learningMode === 'boolean') {
      blind.context.learningMode = snapshot.context.learningMode;
    }
    blind.signature = JSON.stringify({
      roundKey: blind.roundKey,
      cash: blind.cash,
      held: blind.held,
      trades: blind.trades,
      quotes: blind.markets?.map((market) => QUOTE_SIGNATURE_FIELDS.map((field) => market[field])),
    });
    return blind;
  }

  function publicPlayer(player) {
    const visible = pick(player, PUBLIC_PLAYER_FIELDS);
    if (Array.isArray(player.observedNet)) visible.observedNet = copy(player.observedNet);
    return visible;
  }

  function publicTrade(trade) {
    return pick(trade, PUBLIC_TRADE_FIELDS);
  }

  function publicMarket(market) {
    const visible = pick(market, PUBLIC_MARKET_FIELDS);
    if (Array.isArray(market.fills)) visible.fills = market.fills.map(publicTrade);
    return visible;
  }

  // ── Exact probabilities and scores ─────────────────────────────────────

  /* Exact posterior from a chosen subset of STARTING hands. Each legal deck is
     equally likely a priori; sequential hypergeometric deal likelihoods provide
     the weight. No behavioral assumption, current inventory or future data enters. */
  function knownHandProbabilities(hands = {}, options = {}) {
    const playerCount = options.playerCount ?? 4;
    if (!PLAYER_COUNTS.includes(playerCount)) return unavailable('Expected four or five players.');
    if (!hands || typeof hands !== 'object' || Array.isArray(hands)) {
      return unavailable('Supply starting hands keyed by player name.');
    }
    const entries = Object.entries(hands);
    const dealSize = DECK_SIZE / playerCount;
    if (!entries.length) return unavailable('Choose at least one known starting hand.');
    const isDealt = ([name, hand]) => name && isHand(hand) && sum(hand) === dealSize;
    if (entries.length > playerCount || !entries.every(isDealt)) {
      return unavailable('Known starting hands are incomplete or invalid.');
    }

    const knownHands = entries.map(([, hand]) => hand);
    const configurations = [];
    let total = 0;
    const probabilities = [0, 0, 0, 0];
    for (const config of Belief.DECKS) {
      const weight = dealLikelihood(config.deck, knownHands, dealSize);
      if (weight > 0) {
        configurations.push({ deck: copy(config.deck), goal: SUIT_IDS[config.goal], weight });
        total += weight;
        probabilities[config.goal] += weight;
      }
    }
    if (!(total > 0)) return unavailable('Known hands cannot come from a legal Figgie deck.');
    return {
      available: true,
      probabilities: probabilities.map((weight) => weight / total),
      knownPlayers: entries.map(([name]) => name),
      knownCards: entries.length * dealSize,
      scope: 'Starting hands only; exact deal probabilities.',
      configurations: configurations.map((configuration) => ({
        deck: configuration.deck,
        goal: configuration.goal,
        probability: configuration.weight / total,
      })),
    };
  }

  // The probability of dealing these hands, one after another, from one deck.
  function dealLikelihood(deck, hands, dealSize) {
    const remaining = copy(deck);
    let weight = 1;
    let cardsLeft = DECK_SIZE;
    for (const hand of hands) {
      let ways = 1;
      for (let suit = 0; suit < SUIT_IDS.length; suit++) {
        ways *= choose(remaining[suit], hand[suit]);
        remaining[suit] -= hand[suit];
      }
      weight *= ways / choose(cardsLeft, dealSize);
      cardsLeft -= dealSize;
      if (!weight) break;
    }
    return weight;
  }

  // Scores four goal probabilities against the goal that was dealt. `goal` is
  // a suit id or its index.
  function scorePrediction(probabilities, goal) {
    const goalIndex = typeof goal === 'number' ? goal : SUIT_IDS.indexOf(goal);
    const isGoal = Number.isInteger(goalIndex) && goalIndex >= 0 && goalIndex < SUIT_IDS.length;
    if (!isGoal || !isProbabilityVector(probabilities)) {
      return unavailable('A valid goal and four probabilities summing to one are required.');
    }
    const top = probabilities.indexOf(Math.max(...probabilities));
    const goalProbability = probabilities[goalIndex];
    return {
      available: true,
      goal: SUIT_IDS[goalIndex],
      probabilities: copy(probabilities),
      goalProbability,
      brier: sum(
        probabilities.map((probability, suit) => (probability - Number(suit === goalIndex)) ** 2),
      ),
      logLoss: -Math.log(Math.max(LOG_LOSS_PROBABILITY_FLOOR, goalProbability)),
      logLossClipped: goalProbability < LOG_LOSS_PROBABILITY_FLOOR,
      topChoice: SUIT_IDS[top],
      correct: top === goalIndex,
      confidence: probabilities[top],
    };
  }

  // ── Settlement of visible hands ────────────────────────────────────────

  // What each player would be paid if these hands settled now.
  function settlement(hands, names, goal, bonusPool) {
    const counts = names.map((name) => hands[name][goal]);
    const most = Math.max(...counts);
    const leaders = names.filter((name, seat) => counts[seat] === most);
    const tieCount = leaders.length;
    return Object.fromEntries(
      names.map((name, seat) => {
        const leader = leaders.includes(name);
        const base = CHIPS_PER_GOAL_CARD * counts[seat];
        const bonus = leader ? bonusPool / tieCount : 0;
        return [
          name,
          {
            base,
            bonus,
            total: base + bonus,
            leader,
            solo: leader && tieCount === 1,
            tieCount: leader ? tieCount : 0,
          },
        ];
      }),
    );
  }

  // Your payout after one card of a suit moves from `seller` to `buyer`.
  function payoutAfterTransfer(table, suit, seller, buyer) {
    const { names, self, currentHands, goal, bonusPool } = table;
    const hands = Object.fromEntries(names.map((name) => [name, copy(currentHands[name])]));
    hands[buyer][suit]++;
    hands[seller][suit]--;
    return settlement(hands, names, goal, bonusPool)[self].total;
  }

  // ── Reading the visible table ──────────────────────────────────────────

  // Validates the hands a practice snapshot shows. Returns the table they
  // describe, or `{ problem }` naming the first thing that does not add up.
  function readVisibleTable(snapshot) {
    const training = snapshot.training;
    const players = snapshot.players;
    const playerCount = players?.length;
    const isNamed = (player) => typeof player.name === 'string' && player.name;
    if (!PLAYER_COUNTS.includes(playerCount) || !players.every(isNamed)) {
      return { problem: 'Player list is incomplete.' };
    }
    const names = players.map((player) => player.name);
    const self = snapshot.self;
    const dealSize = DECK_SIZE / playerCount;
    if (new Set(names).size !== playerCount || !names.includes(self)) {
      return { problem: 'Player identities are inconsistent.' };
    }

    const startingHands = training.startingHands;
    const currentHands = training.hands;
    const hasBothHands = (name) =>
      isHand(startingHands[name]) &&
      sum(startingHands[name]) === dealSize &&
      isHand(currentHands[name]);
    if (!startingHands || !currentHands || !names.every(hasBothHands)) {
      return { problem: 'All starting and current hands are required.' };
    }

    const suitTotals = (hands) =>
      SUIT_IDS.map((_, suit) => sum(names.map((name) => hands[name][suit])));
    const sameAs = (expected) => (count, suit) => count === expected[suit];
    const deckTotals = suitTotals(startingHands);
    const currentTotals = suitTotals(currentHands);
    const sortedTotals = deckTotals
      .slice()
      .sort((a, b) => a - b)
      .join(',');
    const isLegalDeck =
      sortedTotals === SORTED_SUIT_SIZES &&
      deckTotals.every(sameAs(currentTotals)) &&
      isHand(training.deckTotals) &&
      training.deckTotals.every(sameAs(deckTotals));
    if (!isLegalDeck) return { problem: 'Visible hands do not reconcile to a legal 40-card deck.' };

    const matchesOwnHand =
      isHand(snapshot.startingHand) &&
      snapshot.startingHand.every(sameAs(startingHands[self])) &&
      isHand(snapshot.held) &&
      snapshot.held.every(sameAs(currentHands[self]));
    if (!matchesOwnHand) {
      return { problem: 'Your visible hand disagrees with the public snapshot.' };
    }

    if (!Array.isArray(snapshot.trades)) return { problem: 'Public trade history is missing.' };
    const replayed = replayTrades(snapshot.trades, names, startingHands);
    if (!replayed) return { problem: 'Visible hands disagree with public trade history.' };
    const matchesHistory = names.every((name) =>
      currentHands[name].every(sameAs(replayed.hands[name])),
    );
    if (!matchesHistory) {
      return { problem: 'Visible current hands disagree with public trade history.' };
    }

    // The goal is the other suit of the 12-card suit's color.
    const goal = deckTotals.indexOf(LARGE_SUIT_SIZE) ^ 1;
    return {
      names,
      self,
      playerCount,
      startingHands,
      currentHands,
      deckTotals,
      tradeCash: replayed.cash,
      goal,
      bonusPool: POT_CHIPS - CHIPS_PER_GOAL_CARD * deckTotals[goal],
      ante: POT_CHIPS / playerCount,
    };
  }

  // Applies the public trades to the starting hands. Returns the resulting
  // hands and each player's net trading cash, or null when a trade is
  // impossible for those hands.
  function replayTrades(trades, names, startingHands) {
    const hands = Object.fromEntries(names.map((name) => [name, copy(startingHands[name])]));
    const cash = Object.fromEntries(names.map((name) => [name, 0]));
    for (const trade of trades) {
      const suit = SUIT_IDS.indexOf(trade.suit);
      const isPossible =
        suit >= 0 &&
        names.includes(trade.b) &&
        names.includes(trade.s) &&
        trade.b !== trade.s &&
        Number.isFinite(trade.p) &&
        trade.p >= 0 &&
        hands[trade.s][suit] >= 1;
      if (!isPossible) return null;
      hands[trade.b][suit]++;
      hands[trade.s][suit]--;
      cash[trade.b] -= trade.p;
      cash[trade.s] += trade.p;
    }
    return { hands, cash };
  }

  // ── Analysis ───────────────────────────────────────────────────────────

  // The exact comparison for a practice snapshot whose hands are all visible,
  // or why there is none. `blindModel` is the model inferred without them.
  function analyze(snapshot, blindModel = null) {
    const training = snapshot?.training;
    if (training?.enabled !== true || training.handsVisible !== true) {
      return unavailable('Visible-hands training is not enabled.');
    }
    if (!ACTIVE_STATUSES.includes(snapshot.status)) {
      return unavailable(
        'Training comparison requires a live practice round; post-round reveals do not enable it.',
      );
    }
    if (training.valid !== true) {
      return unavailable(training.reason || 'Waiting for complete, consistent visible hands.');
    }
    const table = readVisibleTable(snapshot);
    if (table.problem) return unavailable(table.problem);

    const { names, self, playerCount, startingHands, deckTotals, tradeCash, goal, ante } = table;
    const exactGoal = SUIT_IDS[goal];
    const exactProbabilities = SUIT_IDS.map((_, suit) => Number(suit === goal));
    const payouts = settlement(table.currentHands, names, goal, table.bonusPool);
    const own = payouts[self];
    const leaders = names.filter((name) => payouts[name].leader);
    const playerRows = names.map((name) => playerRow(table, payouts, name));
    const otherHands = Object.fromEntries(
      names.filter((name) => name !== self).map((name) => [name, startingHands[name]]),
    );
    const blind = blindProbabilities(blindModel);
    return {
      available: true,
      roundKey: snapshot.roundKey,
      asOfTradeCount: snapshot.trades.length,
      noFutureTrades: true,
      scope:
        'Exact settlement of current visible hands; one-card transfers assume immediate settlement and predict no future trades or fills.',
      exactGoal,
      exactProbabilities,
      deckTotals: copy(deckTotals),
      players: playerRows,
      knownHandSets: knownHandSets(table),
      probabilityTable: {
        blind,
        selfHand: copy(playerRows.find((row) => row.name === self).handOdds),
        allHands: copy(exactProbabilities),
        otherHands: knownHandProbabilities(otherHands, { playerCount }).probabilities,
        players: playerRows.map((row) => ({ name: row.name, probabilities: copy(row.handOdds) })),
      },
      blindScore: blind ? scorePrediction(blind, exactGoal) : null,
      settlement: { ...own, bonusPool: table.bonusPool, leaders, tieCount: leaders.length },
      roundPnl: {
        netCash: tradeCash[self],
        ante,
        settlement: own.total,
        settleNowPnl: tradeCash[self] - ante + own.total,
      },
      bySuit: SUIT_IDS.map((id, suit) => suitRow(table, own, snapshot.markets, id, suit)),
    };
  }

  // The goal probabilities the blind model displayed, or the ones it scores
  // itself on when the displayed ones are not a distribution.
  function blindProbabilities(blindModel) {
    const displayed = blindModel?.bySuit?.map((suit) => suit.probability);
    if (isProbabilityVector(displayed)) return copy(displayed);
    const scored = blindModel?.scoringProbabilities;
    return isProbabilityVector(scored) ? copy(scored) : null;
  }

  // One player's hands, what their own starting hand alone says about the
  // goal, and what they would be paid now.
  function playerRow(table, payouts, name) {
    const { self, playerCount, startingHands, currentHands, tradeCash, ante } = table;
    const handOdds = copy(Belief.privateBelief(startingHands[name]).goals);
    const withYourHand = Object.fromEntries(
      [...new Set([self, name])].map((player) => [player, startingHands[player]]),
    );
    return {
      name,
      startingHand: copy(startingHands[name]),
      currentHand: copy(currentHands[name]),
      handOdds,
      privateHandProbabilities: copy(handOdds),
      probabilityScope: 'Starting hand only; excludes public trading and all other hands.',
      withYourHandProbabilities: knownHandProbabilities(withYourHand, { playerCount })
        .probabilities,
      settlement: { ...payouts[name] },
      netCash: tradeCash[name],
      roundPnl: tradeCash[name] - ante + payouts[name].total,
    };
  }

  // The exact goal probabilities from your starting hand plus every subset of
  // the other starting hands. Keyed by a bit mask over the seats.
  function knownHandSets(table) {
    const { names, self, playerCount, startingHands } = table;
    const sets = {};
    const selfBit = 1 << names.indexOf(self);
    for (let mask = 1; mask < 1 << playerCount; mask++) {
      if (!(mask & selfBit)) continue;
      const selected = Object.fromEntries(
        names.filter((name, seat) => mask & (1 << seat)).map((name) => [name, startingHands[name]]),
      );
      const posterior = knownHandProbabilities(selected, { playerCount });
      sets[mask] = posterior.available
        ? { probabilities: posterior.probabilities, knownPlayers: posterior.knownPlayers }
        : posterior;
    }
    return sets;
  }

  // One suit's exact value: what buying a card from, or selling one to, each
  // other player would change in your payout, and the edge on the quotes shown.
  function suitRow(table, own, markets, id, suit) {
    const { names, self, currentHands, goal } = table;
    const market = markets?.find((candidate) => candidate.id === id) || {};
    const baseValue = suit === goal ? CHIPS_PER_GOAL_CARD : 0;
    const counterparties = Object.create(null);
    for (const name of names.filter((other) => other !== self)) {
      let buy = null;
      let sell = null;
      if (currentHands[name][suit] > 0) {
        buy = payoutAfterTransfer(table, suit, name, self) - own.total;
      }
      if (currentHands[self][suit] > 0) {
        sell = own.total - payoutAfterTransfer(table, suit, self, name);
      }
      const buyBase = buy === null ? null : baseValue;
      const sellBase = sell === null ? null : baseValue;
      const canLiftAsk = buy !== null && market.seller === name && Number.isFinite(market.ask);
      const canHitBid = sell !== null && market.buyer === name && Number.isFinite(market.bid);
      counterparties[name] = {
        buy,
        sell,
        buyBase,
        buyBonus: buy === null ? null : buy - buyBase,
        sellBase,
        sellBonus: sell === null ? null : sell - sellBase,
        buyEdge: canLiftAsk ? buy - market.ask : null,
        sellEdge: canHitBid ? market.bid - sell : null,
      };
    }
    const seller = counterparties[market.seller];
    const buyer = counterparties[market.buyer];
    return {
      id,
      probability: Number(suit === goal),
      base: baseValue,
      buy: seller?.buy ?? null,
      sell: buyer?.sell ?? null,
      buyEdge: seller?.buyEdge ?? null,
      sellEdge: buyer?.sellEdge ?? null,
      counterparties,
    };
  }

  scope.FiggieTraining = { analyze, blindSnapshot, knownHandProbabilities, scorePrediction };
  if (typeof module !== 'undefined') module.exports = scope.FiggieTraining;
})(globalThis);
