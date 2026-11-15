'use strict';

/*
 * Parity cases for what a round paid: round accounting, the exact practice
 * comparison, and the scoring of stored bonus forecasts.
 */

const assert = require('node:assert/strict');
const {
  SUIT_IDS,
  OFFICIAL_SOURCE,
  SIMULATOR_SOURCE,
  clone,
  sum,
  at,
  outcome,
  sale,
  tableSnapshot,
} = require('./inputs.cjs');

// ── Cases: round accounting ──────────────────────────────────────────────

function pnlCases() {
  const trades = [sale(1, 0, 'h', 6), sale(0, 2, 's', 4), sale(3, 0, 'h', 8)];
  const ended = (changes = {}) => ({
    ...tableSnapshot({ hand: [3, 3, 2, 2], trades, cash: 240 }),
    status: 'ended',
    ...changes,
  });
  const live = (cash, timer, changes = {}) => ended({ status: 'live', cash, timer, ...changes });
  // Hearts is the goal with ten cards; you hold four of them.
  const hands = {
    You: [2, 3, 2, 4],
    'Bot-A': [3, 2, 3, 1],
    'Bot-B': [4, 2, 2, 2],
    'Bot-C': [3, 3, 1, 3],
  };
  const revealed = (changes = {}) => ({ goal: 'h', finalHands: { ...hands, ...changes } });
  const spadesRevealed = {
    goal: 's',
    finalHands: {
      You: [2, 3, 2, 4],
      'Bot-A': [1, 3, 3, 3],
      'Bot-B': [3, 2, 3, 2],
      'Bot-C': [2, 2, 4, 2],
    },
  };
  const settled = {
    openingBank: 300,
    endCash: 310,
    endedAt: 0,
    endObservedAt: 4000,
    endCashSince: 1000,
  };
  const official = {
    verified: true,
    source: OFFICIAL_SOURCE,
    settledProfit: 30,
    settledBank: 240,
  };
  const model = {
    expectedPayout: 41.5,
    bySuit: [
      { probability: 0, conditionalPayout: null },
      {
        probability: 0.25,
        conditionalPayout: 55.5,
        conditionalBonus: 25.5,
        conditionalLeaderProbability: 0.4,
        conditionalSoloProbability: 0.3,
        conditionalTieProbability: 0.1,
        conditionalNoBonusProbability: 0.6,
      },
      { probability: 0.5, conditionalPayout: 20, conditionalBonus: 0 },
      { probability: NaN, conditionalPayout: 12 },
    ],
  };
  const fivePlayers = tableSnapshot({ hand: [2, 2, 2, 2], players: 5 }).players;
  // Arguments of Pnl.summary: snapshot, model, accounting, revealed result.
  const summaries = [
    // Payout from revealed hands, and the results that cannot give one.
    [ended(), null, {}, revealed()],
    [ended(), model, settled, revealed()],
    [ended(), model, settled, { ...revealed(), goal: 'c' }],
    [ended(), null, {}, revealed({ You: [2, 3, 2, 5] })],
    [ended(), null, {}, revealed({ 'Bot-A': [3, 2, 3, 1.5] })],
    [ended(), null, {}, revealed({ 'Bot-A': [3, 2, 3, 0] })],
    [ended(), null, {}, revealed({ 'Bot-A': undefined })],
    [ended(), null, {}, { ...revealed(), goal: 'x' }],
    [ended(), null, {}, { goal: 'h' }],
    [live(240, '3:10'), model, settled, revealed()],
    // The official result, and the results that are not trusted.
    [ended({ roundResult: official }), model, {}, null],
    [ended(), model, {}, official],
    [ended({ roundResult: { ...official, settledBank: 241 } }), null, {}, null],
    [ended({ roundResult: { ...official, verified: false } }), null, {}, null],
    [ended({ roundResult: { ...official, source: SIMULATOR_SOURCE } }), null, {}, null],
    [ended({ roundResult: { ...official, settledProfit: 400 } }), null, {}, null],
    [ended({ roundResult: { ...official, settledProfit: -70 } }), null, {}, null],
    [ended({ roundResult: { ...official, settledProfit: '30' } }), null, {}, null],
    // The settled bank, and the observations that are not yet settled.
    [ended(), null, settled, null],
    [ended(), null, { ...settled, endObservedAt: 2999 }, null],
    [ended(), null, { ...settled, endCashSince: 2501 }, null],
    [ended(), null, { ...settled, openingBank: undefined }, null],
    [ended(), null, { ...settled, endCash: 900 }, null],
    [ended(), null, { ...settled, endCash: 200 }, null],
    [ended(), null, { ...settled, endedAt: undefined }, null],
    [ended({ players: fivePlayers }), model, {}, null],
    [ended({ trades: [] }), model],
    [live(240, '3:10', { trades: undefined }), { expectedPayout: Infinity }],
    // Payouts exactly on a limit: the whole pot, half a chip more, nothing.
    [ended({ roundResult: { ...official, settledProfit: 140 } }), null, {}, null],
    [ended({ roundResult: { ...official, settledProfit: 140.5 } }), null, {}, null],
    [ended({ roundResult: { ...official, settledProfit: -60 } }), null, {}, null],
    [ended(), null, { ...settled, endCash: 440 }, null],
    [ended(), null, { ...settled, endCash: 440.5 }, null],
    [ended(), null, { ...settled, endCash: 240 }, null],
    // Settled for exactly as long as required.
    [ended(), null, { ...settled, endObservedAt: 3000 }, null],
    [ended(), null, { ...settled, endCashSince: 2500 }, null],
    // Spades as the goal with another player leading, a player holding none
    // of the goal, and an impossible negative holding.
    [ended(), null, {}, spadesRevealed],
    [ended(), null, {}, revealed({ 'Bot-A': [3, 2, 3, 0], 'Bot-B': [4, 2, 2, 3] })],
    [ended(), null, {}, revealed({ 'Bot-A': [3, 2, 3, -1], 'Bot-B': [4, 2, 2, 4] })],
  ];
  const invalidTrades = [
    { b: 'You', s: 'Bot-A', suit: 'x', p: 5 },
    { b: 'You', s: 'Bot-A', suit: 'h', p: -1 },
    { b: 'You', s: 'Bot-A', suit: 'h', p: '5' },
  ];
  // The ante overlay animates balances before the round's bank can be trusted.
  const observations = [
    [live(250, '4:00', { antePending: true }), 0],
    [live(260, '4:00'), 100],
    [live(240, '3:59'), 300],
    [live(240, '3:58'), 900],
    [live(240, '3:58'), 1299],
    [live(240, '3:57'), 1300],
    [live(245, '3:56'), 2000],
    [live(240, '0:00', { trades: [] }), 2500],
    [live(240, '', { trades: [] }), 2600],
    [live(NaN, '3:50'), 2700],
    [ended({ cash: 280 }), 3000],
    [ended({ cash: 310 }), 3400],
    [ended({ cash: 310 }), 5000],
    [ended({ cash: 310 }), 6500],
  ];
  const fill = { b: 'You', s: 'Bot-A', suit: 'h', p: 6 };
  const heldAfterFill = [3, 3, 2, 3];
  const afterFill = live(244, '3:50', { trades: ended().trades.slice(0, 1) });
  const recordedEvents = [
    { kind: 'fill', index: 0, trade: fill, at: 0 },
    { kind: 'round_start', snapshot: live(250, '4:00', { trades: [] }), at: 0 },
    { kind: 'clock', timer: '3:59', status: 'live', at: 1000 },
    { kind: 'fill', index: 0, trade: fill, at: 1500 },
    { kind: 'fill', index: 0, trade: fill, at: 1600 },
    { kind: 'state', cash: 244, status: 'live', timer: '3:58', held: heldAfterFill, at: 2000 },
    { kind: 'quote', at: 2100 },
    { kind: 'state', cash: 244, status: 'live', timer: '3:57', held: heldAfterFill, at: 3100 },
    { kind: 'checkpoint', snapshot: afterFill, at: 4000 },
    { kind: 'clock', timer: '0:00', status: 'ended', at: 9000 },
    { kind: 'state', cash: 300, status: 'ended', timer: '0:00', held: heldAfterFill, at: 9500 },
  ];
  return [
    {
      name: 'pnl: summary, cash flow and hand payout',
      check(output) {
        const sources = new Set(output.summaries.map((summary) => summary.source));
        assert.equal(sources.size, 4, 'no source and each of the three settlement sources');
        assert.ok(output.invalidTrades.every((result) => result.threw));
      },
      run(release) {
        const { Pnl } = release;
        return {
          summaries: summaries.map((summaryArguments) => Pnl.summary(...clone(summaryArguments))),
          payouts: summaries.map(([snapshot, , , result]) => Pnl.handPayout(snapshot, result)),
          invalidTrades: invalidTrades.map((trade) =>
            outcome(() => Pnl.cashFlow({ self: 'You', trades: [trade] })),
          ),
          withoutTrades: Pnl.cashFlow({ self: 'You' }),
          tradeWithYourself: Pnl.cashFlow({ self: 'You', trades: [{ ...fill, s: 'You', p: 0 }] }),
        };
      },
    },
    {
      name: 'pnl: observing the bank and restoring it from events',
      check(output) {
        assert.equal(output.observed.at(-1)[1].source, 'Settled bank − pre-ante opening bank');
        assert.equal(output.observed[5][0].openingBank, 300);
      },
      run(release) {
        const { Pnl } = release;
        let accounting;
        const observed = observations.map(([snapshot, observedAt]) => {
          accounting = Pnl.observe(accounting, clone(snapshot), observedAt);
          return [clone(accounting), Pnl.summary(clone(snapshot), null, accounting, null)];
        });
        const prefixes = [recordedEvents.length, 6, 2, 1, 0];
        return {
          observed,
          restored: prefixes.map((count) =>
            Pnl.restore(clone(recordedEvents.slice(0, count)), null, 0),
          ),
          restoredWithSnapshot: Pnl.restore(clone(recordedEvents), ended({ cash: 300 }), 14000),
        };
      },
    },
  ];
}

// ── Cases: training truth ────────────────────────────────────────────────

// A practice table: the starting hands are visible, and the current hands
// follow from them and the public trades.
function practiceTable(startingHands, tableOptions) {
  const snapshot = tableSnapshot({ hand: Object.values(startingHands)[0], ...tableOptions });
  const current = clone(startingHands);
  snapshot.players.forEach((player, seat) => {
    snapshot.net[seat].forEach((change, suit) => (current[player.name][suit] += change));
  });
  snapshot.training = {
    enabled: true,
    handsVisible: true,
    valid: true,
    hands: current,
    startingHands: clone(startingHands),
    deckTotals: [12, 10, 10, 8],
  };
  return snapshot;
}

function trainingCases() {
  const hands = {
    You: [3, 3, 2, 2],
    'Bot-A': [4, 2, 3, 1],
    'Bot-B': [2, 3, 2, 3],
    'Bot-C': [3, 2, 3, 2],
  };
  const fourPlayers = () =>
    practiceTable(hands, {
      // A card given away for nothing is still a trade.
      trades: [sale(1, 0, 's', 6), sale(0, 2, 'c', 4), sale(3, 1, 'd', 0)],
      quotes: {
        s: { bid: 4, ask: 7, buyer: 'Bot-A', seller: 'Bot-B' },
        c: { bid: 3, ask: null, buyer: 'Bot-C', seller: null },
        h: { bid: null, ask: 9, buyer: null, seller: 'You' },
      },
    });
  const fivePlayers = () =>
    practiceTable(
      {
        You: [3, 2, 2, 1],
        'Bot-A': [2, 2, 2, 2],
        'Bot-B': [2, 2, 2, 2],
        'Bot-C': [3, 2, 2, 1],
        'Bot-D': [2, 2, 2, 2],
      },
      { players: 5, trades: [sale(4, 0, 'h', 2)] },
    );
  const training = (snapshot) => snapshot.training;
  const corruptions = {
    valid: () => {},
    paused: (snapshot) => (snapshot.status = 'paused'),
    'no markets': (snapshot) => delete snapshot.markets,
    'not enabled': (snapshot) => (training(snapshot).enabled = false),
    'hands hidden': (snapshot) => (training(snapshot).handsVisible = false),
    'no training': (snapshot) => delete snapshot.training,
    ended: (snapshot) => (snapshot.status = 'ended'),
    'invalid with a reason': (snapshot) => {
      Object.assign(training(snapshot), { valid: false, reason: 'Still reading.' });
    },
    'invalid without a reason': (snapshot) => (training(snapshot).valid = false),
    'three players': (snapshot) => snapshot.players.pop(),
    'unnamed player': (snapshot) => (snapshot.players[2].name = ''),
    'duplicate player': (snapshot) => (snapshot.players[2].name = 'Bot-A'),
    'self missing': (snapshot) => (snapshot.self = 'Nobody'),
    'no starting hands': (snapshot) => delete training(snapshot).startingHands,
    'no current hands': (snapshot) => delete training(snapshot).hands,
    'short starting hand': (snapshot) => training(snapshot).startingHands['Bot-B'][0]--,
    'invalid current hand': (snapshot) => (training(snapshot).hands['Bot-B'][0] = -1),
    'illegal deck': (snapshot) => {
      training(snapshot).startingHands['Bot-B'] = [3, 2, 2, 3];
      training(snapshot).hands['Bot-B'][0]++;
      training(snapshot).hands['Bot-B'][1]--;
    },
    'current totals differ': (snapshot) => {
      training(snapshot).hands['Bot-B'][0]++;
      training(snapshot).hands['Bot-B'][1]--;
    },
    'no deck totals': (snapshot) => delete training(snapshot).deckTotals,
    'wrong deck totals': (snapshot) => (training(snapshot).deckTotals = [10, 12, 10, 8]),
    'starting hand differs': (snapshot) => (snapshot.startingHand = [3, 2, 3, 2]),
    'held differs': (snapshot) => (snapshot.held = [3, 3, 2, 2]),
    'no trades': (snapshot) => delete snapshot.trades,
    'unknown suit': (snapshot) => (snapshot.trades[0].suit = 'x'),
    'unknown buyer': (snapshot) => (snapshot.trades[0].b = 'Nobody'),
    'unknown seller': (snapshot) => (snapshot.trades[0].s = 'Nobody'),
    'self trade': (snapshot) => (snapshot.trades[0].b = snapshot.trades[0].s),
    'negative price': (snapshot) => (snapshot.trades[0].p = -1),
    oversold: (snapshot) => {
      snapshot.trades.unshift(...Array(5).fill({ b: 'You', s: 'Bot-A', suit: 's', p: 1 }));
    },
    'history disagrees': (snapshot) => snapshot.trades.pop(),
  };
  const suitProbabilities = (probabilities) =>
    probabilities.map((probability) => ({ probability }));
  const blindModels = [
    null,
    { bySuit: suitProbabilities([0.1, 0.2, 0.3, 0.4]) },
    // Displayed probabilities that do not sum to one: the scoring ones are used.
    {
      bySuit: suitProbabilities([0.1, 0.2, 0.3, 0.5]),
      scoringProbabilities: [0.25, 0.25, 0.25, 0.25],
    },
    { scoringProbabilities: [0.5, 0.5, 0.1, -0.1] },
  ];

  // Fields the blind model must never see, scattered through a snapshot.
  const exposedSnapshot = () => {
    const snapshot = {
      ...fourPlayers(),
      refs: { node: 1 },
      roundResult: { goal: 'h' },
      hiddenGoal: 'h',
      context: { botDifficulty: 'Medium', learningMode: true, learningExposure: true, secret: 1 },
    };
    Object.assign(snapshot.players[1], { hand: [1, 2, 3, 4], observedNet: [0, 1, 0, -1] });
    snapshot.trades[0].goal = 'h';
    snapshot.markets[0].truth = 9;
    return snapshot;
  };
  const blindInputs = [
    exposedSnapshot(),
    { ...exposedSnapshot(), context: undefined, net: 'none' },
    { status: 'waiting' },
    null,
    'live',
  ];
  // Arguments of Training.knownHandProbabilities: hands by name, options.
  const knownHands = [
    [hands, { playerCount: 4 }],
    [{ You: hands.You }, {}],
    [{ You: hands.You, 'Bot-A': hands['Bot-A'] }, { playerCount: 4 }],
    [{ You: [2, 2, 2, 2], 'Bot-A': [3, 3, 1, 1] }, { playerCount: 5 }],
    [undefined, undefined],
    [{}, {}],
    [{ You: hands.You }, { playerCount: 3 }],
    [{ You: hands.You }, { playerCount: 5 }],
    [[hands.You], {}],
    [null, {}],
    ['hands', {}],
    [{ '': hands.You }, {}],
    [{ You: [10, 0, 0, 0], 'Bot-A': [10, 0, 0, 0] }, {}],
    [{ ...hands, Extra: [3, 3, 2, 2] }, {}],
    [{ You: [13, -3, 0, 0] }, {}],
    [{ You: [2.5, 2.5, 2.5, 2.5] }, {}],
    [{ You: [10, 0, 0] }, {}],
  ];
  // Arguments of Training.scorePrediction: probabilities, goal.
  const predictions = [
    [[0.1, 0.2, 0.3, 0.4], 'h'],
    [[0.1, 0.2, 0.3, 0.4], 0],
    [[0.25, 0.25, 0.25, 0.25], 'c'],
    [[1, 0, 0, 0], 'd'],
    [[1, 0, 0, 0], 's'],
    [[0.2, 0.3, 0.5 - 1e-9, 1e-9], 'h'],
    [[0.2, 0.3, 0.5, 1e-13], 'h'],
    [[0.2, 0.3, 0.5, 1e-12], 'h'],
    [[0.5, 0.5, 0, 0], 'x'],
    [[0.5, 0.5, 0, 0], 4],
    [[0.5, 0.5, 0, 0], 1.5],
    [[0.5, 0.6, 0, 0], 's'],
    [[0.5, 0.5, 0], 's'],
    [[1.5, -0.5, 0, 0], 's'],
    [[0.5, 0.5, 0, NaN], 's'],
    ['0.25', 's'],
  ];
  return [
    {
      name: 'training: analyze',
      check(output) {
        assert.deepEqual(
          output.analyses.slice(0, 3).map((byModel) => byModel[1].available),
          [true, true, true],
        );
        const reasons = new Set(output.analyses.map((byModel) => byModel[0].reason));
        assert.equal(reasons.size, 13, 'an available analysis and each of the twelve refusals');
        assert.equal(output.fivePlayers.available, true);
      },
      run(release) {
        const { Training } = release;
        return {
          analyses: Object.values(corruptions).map((corrupt) => {
            const snapshot = fourPlayers();
            corrupt(snapshot);
            return blindModels.map((model) => Training.analyze(snapshot, model));
          }),
          fivePlayers: Training.analyze(fivePlayers(), blindModels[1]),
          withoutSnapshot: [Training.analyze(null), Training.analyze(undefined, blindModels[1])],
        };
      },
    },
    {
      name: 'training: blindSnapshot, known hands and prediction scores',
      check(output) {
        assert.equal(output.blind[0].roundResult, undefined);
        assert.equal(output.blind[0].players[1].hand, undefined);
        assert.equal(output.known.filter((result) => result.available).length, 4);
        assert.equal(output.scores.filter((result) => result.available).length, 8);
      },
      run(release) {
        const { Training } = release;
        return {
          blind: blindInputs.map((snapshot) => Training.blindSnapshot(snapshot)),
          known: knownHands.map((knownArguments) =>
            Training.knownHandProbabilities(...knownArguments),
          ),
          scores: predictions.map(([probabilities, goal]) =>
            Training.scorePrediction(probabilities, goal),
          ),
        };
      },
    },
  ];
}

// ── Cases: bonus scoring ─────────────────────────────────────────────────

// A round recorded cleanly from the deal to an official settlement. Hearts is
// the goal; `finalHearts` are the hearts each seat holds at the end.
function settledRound({ hand, players, trades, finalHearts, events }) {
  const tableAfter = (tradeCount, changes = {}) => ({
    ...tableSnapshot({ hand, players, trades: trades.slice(0, tradeCount), roundKey: 'bonus' }),
    ...changes,
  });
  const final = tableAfter(trades.length, { status: 'ended' });
  const names = final.players.map((player) => player.name);
  const most = Math.max(...finalHearts);
  const leaders = finalHearts.filter((count) => count === most).length;
  const bonusPool = 200 - 10 * sum(finalHearts);
  const tradeCash = (name) =>
    sum(
      final.trades.map(
        (trade) => (trade.s === name ? trade.p : 0) - (trade.b === name ? trade.p : 0),
      ),
    );
  const payout = (seat) =>
    10 * finalHearts[seat] + (finalHearts[seat] === most ? bonusPool / leaders : 0);
  const profits = Object.fromEntries(
    names.map((name, seat) => [name, tradeCash(name) - 200 / names.length + payout(seat)]),
  );
  return {
    id: 'bonus-round',
    snapshot: final,
    revealed: {
      goal: 'h',
      verified: true,
      source: OFFICIAL_SOURCE,
      profits,
      settledProfit: profits.You,
    },
    // A fill gets its own copy of the trade, so either can be changed alone.
    events: events(tableAfter, final).map((event, index) => ({
      ...event,
      ...(event.trade ? { trade: { ...event.trade } } : {}),
      seq: index + 1,
      roundId: 'bonus-round',
    })),
  };
}

function bonusCases() {
  const forecast = (tradeCount, bonus, probabilities = {}) => ({
    kind: 'prediction',
    tradeCount,
    goalScenarios: SUIT_IDS.map((suit) => ({ suit, bonus, ...probabilities })),
  });
  const calibrated = {
    soloProbability: 0.5,
    tieProbability: 0.2,
    noBonusProbability: 0.3,
    leaderProbability: 0.7,
  };
  // You end with four of eight hearts and take the whole bonus.
  const leadingRound = () =>
    settledRound({
      hand: [3, 3, 2, 2],
      // The spade changes hands for nothing: a price of zero is a price.
      trades: [sale(1, 0, 'h', 6), sale(2, 3, 'h', 4), sale(0, 2, 's', 0), sale(2, 0, 'h', 7)],
      finalHearts: [4, 0, 1, 3],
      events: (tableAfter, final) => [
        { kind: 'round_start', snapshot: tableAfter(0) },
        forecast(0, 30, calibrated),
        { kind: 'fill', index: 0, trade: final.trades[0] },
        { kind: 'state', status: 'live', held: tableAfter(1).held },
        forecast(1, 50),
        // A forecast made against a stale trade count is not scored.
        forecast(0, 50),
        { kind: 'fill', index: 1, trade: final.trades[1] },
        { kind: 'checkpoint', snapshot: tableAfter(2) },
        // Bonuses outside [0, 120] and missing scenarios are not eligible.
        forecast(2, 121),
        forecast(2, -1),
        { kind: 'prediction', tradeCount: 2, goalScenarios: null },
        forecast(2, 60, { ...calibrated, soloProbability: 0.6 }),
        { kind: 'fill', index: 2, trade: final.trades[2] },
        { kind: 'clock', status: 'paused' },
        forecast(3, 70),
        { kind: 'clock', status: 'live' },
        forecast(3, 80, { ...calibrated, leaderProbability: 2 }),
        { kind: 'fill', index: 3, trade: final.trades[3] },
        forecast(4, 120, calibrated),
        { kind: 'state', status: 'ended', held: final.held },
        forecast(4, 120),
      ],
    });
  // Bot-A's payout of 160 fits four of eight hearts or six of ten. Before you
  // sold it a heart, the first reading has you tied for the bonus and the
  // second does not, so that checkpoint has no single true bonus.
  const twoReadingsRound = (laterForecasts) =>
    settledRound({
      hand: [3, 2, 2, 3],
      trades: [sale(0, 1, 'h', 6)],
      finalHearts: [2, 4, 1, 1],
      events: (tableAfter, final) => [
        { kind: 'round_start', snapshot: tableAfter(0) },
        forecast(0, 30, calibrated),
        { kind: 'fill', index: 0, trade: final.trades[0] },
        ...laterForecasts,
      ],
    });

  // Edits that add or remove events keep the sequence complete.
  const renumber = (round) => round.events.forEach((event, index) => (event.seq = index + 1));
  const withoutEvents = (round, isRemoved) => {
    round.events = round.events.filter((event) => !isRemoved(event));
    renumber(round);
  };
  const moveProfit = (round, from, to, amount) => {
    round.revealed.profits[from] -= amount;
    round.revealed.profits[to] += amount;
    delete round.revealed.settledProfit;
  };
  const corruptions = {
    valid: () => {},
    'no settled profit': (round) => delete round.revealed.settledProfit,
    'journal form': (round) => {
      round.previous = round.snapshot;
      delete round.snapshot;
    },
    practice: (round) => (round.practice = true),
    'not ended': (round) => (round.snapshot.status = 'live'),
    unverified: (round) => (round.revealed.verified = false),
    'unofficial source': (round) => (round.revealed.source = SIMULATOR_SOURCE),
    'unknown goal': (round) => (round.revealed.goal = 'x'),
    'no result': (round) => delete round.revealed,
    'three players': (round) => round.snapshot.players.pop(),
    'no trades': (round) => delete round.snapshot.trades,
    'no events': (round) => (round.events = []),
    'oversized history': (round) => {
      round.events = Array.from({ length: 20001 }, (_, index) => ({
        kind: 'clock',
        seq: index + 1,
      }));
    },
    'oversized trade list': (round) => {
      round.snapshot.trades = Array(2001).fill(round.snapshot.trades[0]);
    },
    'unnamed player': (round) => (round.snapshot.players[1].name = ''),
    'duplicate player': (round) => (round.snapshot.players[1].name = 'Bot-B'),
    'self missing': (round) => (round.snapshot.self = 'Nobody'),
    'short starting hand': (round) => (round.snapshot.startingHand = [3, 3, 2, 1]),
    'invalid held': (round) => (round.snapshot.held = [3, 3, 2, -1]),
    'no profits': (round) => delete round.revealed.profits,
    'missing profit': (round) => delete round.revealed.profits['Bot-B'],
    'extra profit': (round) => (round.revealed.profits.Extra = 0),
    'profits not zero-sum': (round) => round.revealed.profits['Bot-B']++,
    'self profit mismatch': (round) => round.revealed.settledProfit++,
    'malformed trade': (round) => (round.snapshot.trades[1].p = -1),
    'held contradicts fills': (round) => round.snapshot.held[0]++,
    'card count contradicts fills': (round) => round.snapshot.players[2].cards++,
    'payout out of range': (round) => moveProfit(round, 'Bot-A', 'You', 300),
    'unreproducible payouts': (round) => moveProfit(round, 'Bot-B', 'You', 5),
    'sequence gap': (round) => round.events[3].seq++,
    'foreign event': (round) => (round.events[3].roundId = 'other-round'),
    'repeated start': (round) => {
      round.events.splice(1, 0, clone(round.events[0]));
      renumber(round);
    },
    'recovered start': (round) => {
      round.events[0].snapshot.trades.push(round.snapshot.trades[0]);
    },
    'inconsistent start': (round) => (round.events[0].snapshot.self = 'Bot-A'),
    'recovered fill': (round) => (round.events[2].recovered = true),
    'changed fill': (round) => (round.events[2].trade.p = 99),
    'fill before start': (round) => withoutEvents(round, (event) => event.kind === 'round_start'),
    'inconsistent checkpoint': (round) => round.events[7].snapshot.held[0]++,
    'state contradicts fills': (round) => round.events[3].held[0]++,
    'journal stops early': (round) => withoutEvents(round, (event) => event.seq >= 18),
    'no forecasts': (round) => withoutEvents(round, (event) => event.kind === 'prediction'),
    'early reveal': (round) => (round.events[1] = { kind: 'reveal', seq: 2 }),
    'pending settlement': (round) => {
      round.events[1] = { kind: 'settlement_pending', seq: 2, result: { goal: 'h' } };
    },
    'result in a state': (round) => (round.events[3].roundResult = { goal: 'h' }),
    // Each way one trade can be malformed, and each way a fill or a
    // checkpoint can disagree with the settled table in a single field.
    'unknown seller': (round) => (round.snapshot.trades[1].s = 'Nobody'),
    'unknown buyer': (round) => (round.snapshot.trades[1].b = 'Nobody'),
    'trade with oneself': (round) => (round.snapshot.trades[1].b = round.snapshot.trades[1].s),
    'unknown suit': (round) => (round.snapshot.trades[1].suit = 'x'),
    'unpriced trade': (round) => (round.snapshot.trades[1].p = '4'),
    'fill with another buyer': (round) => (round.events[2].trade.b = 'Bot-B'),
    'fill with another seller': (round) => (round.events[2].trade.s = 'Bot-B'),
    'fill of another suit': (round) => (round.events[2].trade.suit = 's'),
    'fill without a trade': (round) => (round.events[2].trade = null),
    'fill out of order': (round) => round.events[2].index++,
    'checkpoint of another hand': (round) => round.events[7].snapshot.startingHand[0]++,
    'checkpoint without players': (round) => (round.events[7].snapshot.players = null),
    'checkpoint of other players': (round) => (round.events[7].snapshot.players[1].name = 'Bot-Z'),
    'checkpoint without trades': (round) => (round.events[7].snapshot.trades = null),
    'pending settlement without a goal': (round) => {
      round.events[1] = { kind: 'settlement_pending', seq: 2, result: { goal: 'x' } };
    },
    'a single event': (round) => (round.events = [round.events[0]]),
    // The largest histories that are still read.
    'most trades allowed': (round) => {
      round.snapshot.trades = Array(2000).fill(round.snapshot.trades[0]);
    },
    'most events allowed': (round) => {
      round.events = Array.from({ length: 20000 }, (_, index) => ({
        kind: 'clock',
        seq: index + 1,
      }));
    },
  };

  // A round with one forecast at the deal, followed by every fill.
  const plainRound = ({ hand, players, trades = [], finalHearts }) =>
    settledRound({
      hand,
      players,
      trades,
      finalHearts,
      events: (tableAfter, final) => [
        { kind: 'round_start', snapshot: tableAfter(0) },
        forecast(0, 30, calibrated),
        ...final.trades.map((trade, index) => ({ kind: 'fill', index, trade })),
      ],
    });
  const times = (count, trade) => Array(count).fill(trade);
  // Rounds whose payouts fit a second reading that only the deal can rule
  // out, or that sit on a limit of what a deal allows.
  const edgeRounds = {
    // You hold every heart and are paid the whole pot.
    'you hold every goal card': { hand: [0, 1, 1, 8], finalHearts: [8, 0, 0, 0] },
    // Bot-A is paid the whole pot: all eight hearts, or all ten.
    'a bot holds every goal card': { hand: [4, 3, 3, 0], finalHearts: [0, 8, 0, 0] },
    // Your ten spades fill a ten-card suit exactly.
    'your hand fills a suit': { hand: [10, 0, 0, 0], finalHearts: [0, 4, 2, 2] },
    // With five spades and five clubs in your hand and four more of each
    // sold by others, neither can be the eight-card suit: hearts must be.
    'only one suit can be short': {
      hand: [5, 5, 0, 0],
      trades: [...times(4, sale(1, 2, 's', 3)), ...times(4, sale(3, 2, 'c', 3))],
      finalHearts: [0, 4, 2, 2],
    },
    // Bot-A sold two hearts and bought them back, so it was dealt two.
    'sold and bought back': {
      hand: [2, 2, 2, 4],
      trades: [...times(2, sale(1, 2, 'h', 5)), ...times(2, sale(2, 1, 'h', 5))],
      finalHearts: [4, 1, 2, 1],
    },
    // Bot-A sold five spades before buying five clubs, so it was dealt at
    // most five hearts, though it holds ten cards again.
    'no room for six goal cards': {
      hand: [3, 3, 3, 1],
      trades: [...times(5, sale(1, 2, 's', 3)), ...times(5, sale(2, 1, 'c', 3))],
      finalHearts: [1, 6, 2, 1],
    },
    // You hold six diamonds and the others have sold seven: one more than the
    // twelve-card suit has.
    'the largest suit is oversold': {
      hand: [1, 1, 6, 2],
      trades: [...times(4, sale(1, 2, 'd', 3)), ...times(3, sale(3, 2, 'd', 3))],
      finalHearts: [2, 3, 2, 1],
    },
    // Five players: nine hearts cannot have been dealt into a hand of eight.
    'more goal cards than a hand': {
      hand: [3, 3, 2, 0],
      players: 5,
      trades: times(2, sale(2, 1, 's', 3)),
      finalHearts: [0, 9, 1, 0, 0],
    },
    // At the deal you lead alone under both readings, for different bonuses.
    'leading alone either way': {
      hand: [1, 1, 2, 6],
      trades: times(3, sale(0, 1, 'h', 5)),
      finalHearts: [3, 4, 1, 0],
    },
  };

  // A long round checkpointed many times. Comparing a checkpoint's history
  // costs one check per trade, and a round is allowed 200,000 of them.
  const longRound = (earlyCheckpoint) => {
    const backAndForth = Array.from({ length: 1000 }, (_, index) =>
      index % 2 ? sale(2, 1, 'd', 4) : sale(1, 2, 'd', 4),
    );
    return settledRound({
      hand: [3, 3, 2, 2],
      trades: backAndForth,
      finalHearts: [2, 3, 2, 1],
      events(tableAfter, final) {
        const checkpoint = { kind: 'checkpoint', snapshot: tableAfter(final.trades.length) };
        const fills = final.trades.map((trade, index) => ({ kind: 'fill', index, trade }));
        const afterFirstFill = { kind: 'checkpoint', snapshot: tableAfter(1) };
        return [
          { kind: 'round_start', snapshot: tableAfter(0) },
          forecast(0, 30, calibrated),
          fills[0],
          ...(earlyCheckpoint ? [afterFirstFill] : []),
          ...fills.slice(1),
          ...times(200, checkpoint),
        ];
      },
    });
  };
  const audit = (Bonus, round) => ({
    plain: Bonus.auditRound(round),
    labelled: Bonus.auditRound(round, { includeLabels: true }),
    score: Bonus.scoreRound(round),
  });
  return [
    {
      name: 'bonus: audit of a recorded round and its rejections',
      check(output) {
        for (const accepted of output.audits.slice(0, 3)) {
          assert.equal(accepted.plain.reason, null);
          assert.equal(accepted.plain.score.checkpoints, 5);
        }
        const reasons = new Set(output.audits.map((result) => result.plain.reason));
        assert.equal(reasons.size, 19, 'an accepted round and each of eighteen rejections');
      },
      run(release) {
        return {
          audits: Object.values(corruptions).map((corrupt) => {
            const round = leadingRound();
            corrupt(round);
            return audit(release.Bonus, round);
          }),
          withoutRound: [null, {}].map((round) => release.Bonus.auditRound(round)),
        };
      },
    },
    {
      name: 'bonus: payouts that fit two goal sizes',
      check(output) {
        assert.equal(output.allAmbiguous.plain.reason, 'All bonus truths are ambiguous');
        assert.equal(output.partlyAmbiguous.plain.score.ambiguousCheckpoints, 1);
        assert.equal(output.partlyAmbiguous.plain.score.candidateAllocations, 2);
      },
      run(release) {
        return {
          allAmbiguous: audit(release.Bonus, twoReadingsRound([])),
          partlyAmbiguous: audit(release.Bonus, twoReadingsRound([forecast(1, 12, calibrated)])),
        };
      },
    },
    {
      name: 'bonus: goal holdings at the edge of what a deal allows',
      check(output) {
        const summary = Object.fromEntries(
          Object.entries(output).map(([name, result]) => [
            name,
            result.plain.score?.candidateAllocations ?? result.plain.reason,
          ]),
        );
        assert.deepEqual(summary, {
          'you hold every goal card': 1,
          'a bot holds every goal card': 2,
          'your hand fills a suit': 2,
          'only one suit can be short': 1,
          'sold and bought back': 'No feasible goal holdings reproduce official payouts',
          'no room for six goal cards': 1,
          'the largest suit is oversold': 'No feasible goal holdings reproduce official payouts',
          'more goal cards than a hand': 1,
          'leading alone either way': 'All bonus truths are ambiguous',
        });
      },
      run: (release) =>
        Object.fromEntries(
          Object.entries(edgeRounds).map(([name, round]) => [
            name,
            audit(release.Bonus, plainRound(round)),
          ]),
        ),
    },
    {
      name: 'bonus: the limit on history checks',
      check(output) {
        assert.equal(output.atTheLimit.reason, null);
        assert.equal(output.oneOver.reason, 'Inconsistent checkpoint history');
      },
      run: (release) => ({
        atTheLimit: release.Bonus.auditRound(longRound(false)),
        oneOver: release.Bonus.auditRound(longRound(true)),
      }),
    },
  ];
}

function settlementCases() {
  return [...pnlCases(), ...trainingCases(), ...bonusCases()];
}

module.exports = { settlementCases };
