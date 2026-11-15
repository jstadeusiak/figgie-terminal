'use strict';

/*
 * Parity cases for the belief engine: sessions of inferences over synthetic
 * tables of every kind, each engine option, ask-ownership evidence and its
 * fallback, and inputs the engine rejects.
 */

const assert = require('node:assert/strict');
const {
  SUIT_IDS,
  HUMAN_NAME,
  SMALL_BUDGET,
  clone,
  at,
  outcome,
  seededRandom,
  pickFrom,
  sale,
  tableSnapshot,
  randomQuotes,
  netHistory,
  randomEvidence,
  LEARNED,
  TRAILING_RECORD,
  infer,
  engineState,
} = require('./inputs.cjs');

// A fresh copy of the arguments of one inference. Evidence and learning are
// optional, and stay absent when a step leaves them out.
const inferArguments = (...given) => clone(given.filter((argument) => argument !== undefined));

// Runs one engine through a sequence of inferences, as a tab session does.
// A step is `{ snapshot, evidence, learning }`.
function engineCase(name, { engineOptions, steps, check }) {
  return {
    name,
    check,
    run(release) {
      const engine = new release.Belief.BeliefEngine(engineOptions);
      const beforeFirstInference = SUIT_IDS.map((suit) => engine.revealedStyles(suit));
      const results = steps.map(({ snapshot, evidence, learning }) => ({
        result: outcome(() =>
          infer(release, engine, ...inferArguments(snapshot, evidence, learning)),
        ),
        revealedStyles: [...SUIT_IDS, 'x'].map((suit) => engine.revealedStyles(suit)),
        engine: engineState(engine),
      }));
      return { beforeFirstInference, results };
    },
  };
}

// ── Cases: belief engine ─────────────────────────────────────────────────

function beliefEngineCases() {
  const random = seededRandom(71);

  // A session as a tab sees it: evidence grows, trades arrive, the display
  // options change, and old evidence falls out of the window.
  function session(options, learned = {}) {
    const tableAfter = (tradeCount) => {
      const snapshot = tableSnapshot({ ...options, trades: options.trades.slice(0, tradeCount) });
      const names = snapshot.players.map((player) => player.name);
      const quotes = randomQuotes(random, names);
      snapshot.markets.forEach((market) => Object.assign(market, quotes[market.id]));
      return snapshot;
    };
    const opening = tableAfter(0);
    const middle = tableAfter(Math.min(3, options.trades.length));
    const late = tableAfter(options.trades.length);
    const openingEvidence = randomEvidence(random, opening, 12);
    const middleEvidence = [...openingEvidence, ...randomEvidence(random, middle, 16)];
    const lateEvidence = [...middleEvidence, ...randomEvidence(random, late, 24)];
    const drafts = Object.fromEntries(
      late.markets.map((market) => [
        market.id,
        {
          bid: pickFrom(random, [market.bid, (market.bid ?? 3) + 2, (market.bid ?? 3) - 1, 0, 2.5]),
          ask: pickFrom(random, [market.ask, (market.ask ?? 9) - 2, (market.ask ?? 9) + 1, null]),
        },
      ]),
    );
    return {
      opening: { snapshot: opening, evidence: [], learning: {} },
      firstQuotes: { snapshot: opening, evidence: openingEvidence, learning: learned },
      afterTrades: {
        snapshot: middle,
        evidence: middleEvidence,
        learning: { ...learned, rates: LEARNED.rates },
      },
      withDrafts: {
        snapshot: late,
        evidence: lateEvidence,
        learning: { ...learned, quotePrices: drafts },
      },
      cardsOnly: {
        snapshot: late,
        evidence: lateEvidence,
        learning: { ...learned, forceBaseline: true },
      },
      windowMoved: { snapshot: late, evidence: lateEvidence.slice(14), learning: learned },
    };
  }

  const fourPlayers = {
    hand: [3, 3, 2, 2],
    trades: [
      sale(1, 2, 'h', 6),
      sale(3, 1, 's', 4),
      sale(2, 0, 'c', 9),
      sale(1, 3, 'h', 5),
      sale(0, 2, 'd', 7),
      sale(2, 3, 'd', 8),
    ],
  };
  const fivePlayers = {
    hand: [3, 2, 2, 1],
    players: 5,
    trades: [sale(4, 1, 'd', 3), sale(2, 4, 's', 8), sale(1, 0, 'h', 6), sale(3, 2, 'c', 4)],
  };
  const withHuman = { ...fourPlayers, names: ['You', 'Bot-A', HUMAN_NAME, 'Bot-C'] };
  const fiveWithHuman = {
    ...fivePlayers,
    difficulty: null,
    names: ['You', HUMAN_NAME, 'Bot-A', 'Bot-B', 'Bot-C'],
  };
  const whole = (steps) => Object.values(steps);
  const short = ({ afterTrades, withDrafts, cardsOnly }) => [afterTrades, withDrafts, cardsOnly];
  const valueOf = (output, index) => output.results[index].result.value;

  const cases = [
    engineCase('engine: four Medium bots, reduced budget', {
      engineOptions: SMALL_BUDGET,
      steps: whole(session(fourPlayers, LEARNED)),
    }),
    engineCase('engine: four Medium bots at the production budget', {
      steps: whole(session(fourPlayers, LEARNED)),
      check(output) {
        const priced = valueOf(output, 3);
        assert.equal(priced.behavior.goalCalibration.active, true);
        assert.equal(priced.inventoryCalibration.active, true);
        assert.equal(priced.stateCount, 12 * 512);
        assert.ok(Object.values(priced.resting).some((market) => market.bid || market.ask));
        assert.ok(Object.values(priced.actualBook).some((market) => market.bid || market.ask));
        assert.equal(valueOf(output, 4).mode, 'Cards only');
        assert.equal(output.results[4].engine.rebuilds, output.results[3].engine.rebuilds);
      },
    }),
    engineCase('engine: five Medium bots at the production budget', {
      steps: short(session(fivePlayers, LEARNED)),
      check: (output) => assert.equal(valueOf(output, 1).stateCount, 12 * 384),
    }),
    engineCase('engine: four Hard bots', {
      engineOptions: SMALL_BUDGET,
      steps: short(session({ ...fourPlayers, difficulty: 'Hard' }, LEARNED)),
      check: (output) => assert.equal(valueOf(output, 1).behavior.group, 'bots:Hard'),
    }),
    engineCase('engine: four bots of unknown difficulty', {
      engineOptions: SMALL_BUDGET,
      steps: short(session({ ...fourPlayers, difficulty: null }, LEARNED)),
      check: (output) => assert.equal(valueOf(output, 1).behavior.group, 'bots'),
    }),
    engineCase('engine: four players with a human', {
      engineOptions: SMALL_BUDGET,
      steps: short(session(withHuman, LEARNED)),
      check: (output) => assert.equal(valueOf(output, 1).behavior.group, 'mixed'),
    }),
    engineCase('engine: five Hard bots', {
      engineOptions: SMALL_BUDGET,
      steps: short(session({ ...fivePlayers, difficulty: 'Hard' })),
    }),
    engineCase('engine: five players of unknown difficulty with a human', {
      engineOptions: SMALL_BUDGET,
      steps: short(session(fiveWithHuman, LEARNED)),
      check: (output) => assert.equal(valueOf(output, 1).behavior.group, 'mixed'),
    }),
    engineCase('engine: quality guard after a trailing record', {
      engineOptions: SMALL_BUDGET,
      steps: short(session(fourPlayers, TRAILING_RECORD)),
      check(output) {
        const { goalCalibration, blend } = valueOf(output, 1).behavior;
        assert.equal(goalCalibration.reason, 'quality guard');
        assert.equal(blend, 0.1);
      },
    }),
  ];

  const engineOptions = {
    'unstratified sampling': { goalStratified: false },
    'no reference effective size': { referenceEss: false },
    'custom signal policy': {
      signalPolicy: { temperature: 0.45, quote: 0.3, consent: 0.05, cap: 0.5 },
    },
    'goal calibration off': { goalCalibration: false },
    'raw goal calibration': { goalCalibration: { kind: 'raw' } },
    'additive goal calibration': { goalCalibration: { kind: 'additive', strength: 3 } },
    'unit likelihood power': { goalCalibration: { kind: 'likelihood-power', strength: 1 } },
    'no pricing': { skipPricing: true },
    'no opponent learning': { opponentLearning: false },
    'larger opponent sample': { opponentSamples: 20 },
    'smallest sample': { samples: 8, opponentSamples: 1 },
  };
  for (const [label, options] of Object.entries(engineOptions)) {
    const { firstQuotes, withDrafts, cardsOnly } = session(fourPlayers, LEARNED);
    cases.push(
      engineCase(`engine option: ${label}`, {
        engineOptions: { ...SMALL_BUDGET, ...options },
        steps: [firstQuotes, withDrafts, cardsOnly],
      }),
    );
  }
  // A calibration requested outside its scope is reported, not applied.
  cases.push(
    engineCase('engine option: goal calibration outside its scope', {
      engineOptions: { ...SMALL_BUDGET, goalCalibration: { kind: 'additive', strength: 3 } },
      steps: [session(fivePlayers).withDrafts, session(withHuman).withDrafts],
      check(output) {
        const reasons = [0, 1].map(
          (index) => valueOf(output, index).behavior.goalCalibration.reason,
        );
        assert.deepEqual(reasons, ['outside scope', 'outside scope']);
      },
    }),
    engineCase('engine option: unstratified sampling, five players', {
      engineOptions: { ...SMALL_BUDGET, goalStratified: false },
      steps: [session(fivePlayers, LEARNED).withDrafts],
    }),
  );

  // Hands that leave few legal decks, and sales that pin down opponents' hands.
  const edgeTables = [
    { hand: [8, 2, 0, 0], trades: [] },
    {
      hand: [0, 0, 5, 5],
      trades: [sale(1, 2, 's', 3), sale(1, 2, 's', 3), sale(1, 3, 's', 4), sale(1, 0, 's', 5)],
    },
    { hand: [10, 0, 0, 0], trades: [sale(0, 1, 's', 9)] },
    {
      hand: [1, 1, 3, 3],
      players: 5,
      trades: [sale(2, 3, 'c', 4), sale(2, 3, 'c', 4), sale(2, 4, 'c', 4)],
    },
    {
      hand: [2, 3, 3, 2],
      trades: Array.from({ length: 9 }, (_, index) =>
        sale(1 + (index % 3), 0, SUIT_IDS[index % 4], 5),
      ),
    },
  ];
  edgeTables.forEach((options, index) => {
    const { opening, afterTrades, withDrafts } = session(options, LEARNED);
    cases.push(
      engineCase(`engine: edge table ${index + 1}`, {
        engineOptions: SMALL_BUDGET,
        steps: [opening, afterTrades, withDrafts],
        // Before anyone quotes, a deck stays possible when you hold a whole
        // suit of it: all twelve for the first table, nine for the third.
        check: (output) =>
          assert.equal(valueOf(output, 0).configurations.length, [12, 12, 9, 12, 12][index]),
      }),
    );
  });
  return cases;
}

function askOwnershipCases() {
  // You hold nine spades, so at most three remain for the others. Bot-A has
  // already sold two of them.
  const snapshot = tableSnapshot({
    hand: [9, 1, 0, 0],
    trades: [sale(1, 2, 's', 6), sale(1, 2, 's', 7)],
  });
  const names = snapshot.players.map((player) => player.name);
  const nets = netHistory(snapshot);
  const spadeAsk = (seat, sequence) => ({
    kind: 'quote',
    actor: names[seat],
    suit: 's',
    direction: 'sell',
    price: 8,
    epoch: 2,
    net: clone(nets[2]),
    anchor: 6,
    at: sequence,
    sourceSeq: sequence,
    recovered: false,
  });
  const oneMoreSpade = [spadeAsk(3, 10)];
  // Bot-A offers a third spade and Bot-C a fourth: one more than exist.
  const tooManySpades = [spadeAsk(1, 20), spadeAsk(3, 30)];
  const fourSpadesSold = tableSnapshot({
    hand: [9, 1, 0, 0],
    trades: Array.from({ length: 4 }, () => sale(1, 2, 's', 6)),
  });
  const step = (table, evidence, learning = {}) => ({ snapshot: table, evidence, learning });
  return [
    engineCase('engine: an ask tightens an inventory bound', {
      engineOptions: { samples: 96 },
      steps: [step(snapshot, []), step(snapshot, oneMoreSpade)],
      check(output) {
        const evidence = output.results[1].result.value.inventoryEvidence;
        assert.equal(evidence.tightenedBounds, 1);
        assert.equal(evidence.fallback, false);
        assert.equal(output.results[1].engine.rebuilds, 2);
      },
    }),
    engineCase('engine: conflicting asks fall back to executed trades', {
      engineOptions: { samples: 96 },
      steps: [
        step(snapshot, tooManySpades),
        step(snapshot, tooManySpades, { forceBaseline: true }),
        step(snapshot, oneMoreSpade),
      ],
      check(output) {
        const evidence = output.results[0].result.value.inventoryEvidence;
        assert.equal(evidence.fallback, true);
        assert.equal(evidence.reason, 'Ask constraints conflict; using executed trades only');
      },
    }),
    engineCase('engine: rejected inputs', {
      engineOptions: { samples: 96 },
      steps: [
        step(fourSpadesSold, []),
        step({ ...snapshot, startingHand: [9, 1, 0, 1] }, []),
        step({ ...snapshot, held: [9, 0, 0, 0] }, []),
        // Evidence and learning are optional, but learning cannot be null.
        { snapshot },
        step(snapshot, [], null),
      ],
      check(output) {
        const messages = output.results.map(({ result }) => result.threw);
        assert.deepEqual(messages.slice(0, 3), [
          'No legal deals satisfy the observed inventories',
          'Invalid deal',
          'Current inventory contradicts the reconstructed deal',
        ]);
        assert.ok(output.results[3].result.value);
        assert.match(messages[4], /stylePriors/);
      },
    }),
  ];
}

// Which of your quotes can be valued at all: one you can just afford, ones
// you cannot afford or have no card for, and a book with fractional prices.
function quoteAvailabilityCases() {
  const snapshot = tableSnapshot({
    hand: [3, 3, 4, 0],
    cash: 7,
    quotes: {
      // Raising this bid costs exactly your seven chips; the offer is yours.
      s: { bid: 6, ask: 9, buyer: 'Bot-A', seller: 'You' },
      // Raising this bid costs eight.
      c: { bid: 7, ask: null, buyer: 'Bot-A', seller: null },
      d: { bid: 5.5, ask: 9.5, buyer: 'Bot-B', seller: 'Bot-C' },
      // Your own bid of eight, and an offer the page allows without a heart to sell.
      h: { bid: 8, ask: 9, buyer: 'You', seller: 'Bot-C', canOffer: true, canLowerAsk: true },
    },
  });
  // Bot-C has exactly the eight chips your offer costs one chip inside the
  // best; Bot-B cannot pay it.
  snapshot.players[3].cash = 8;
  snapshot.players[2].cash = 3;
  // Nobody can pay two hundred chips for a club.
  const drafts = {
    s: { bid: 7, ask: 8 },
    c: { bid: 9, ask: 200 },
    d: { bid: 6, ask: 9 },
    h: { bid: 7, ask: 5 },
  };
  const sides = (book) => Object.fromEntries(SUIT_IDS.map((id) => [id, Object.keys(book[id])]));
  return [
    engineCase('engine: quotes you can and cannot place', {
      engineOptions: SMALL_BUDGET,
      steps: [
        { snapshot, evidence: [], learning: {} },
        { snapshot, evidence: [], learning: { quotePrices: drafts } },
      ],
      check(output) {
        const [oneChipInside, drafted] = output.results.map(({ result }) => result.value);
        assert.deepEqual(sides(oneChipInside.resting), { s: ['bid', 'ask'], c: [], d: [], h: [] });
        assert.deepEqual(sides(oneChipInside.actualBook), { s: ['ask'], c: [], d: [], h: [] });
        assert.deepEqual(sides(drafted.resting), {
          s: ['bid', 'ask'],
          c: ['ask'],
          d: ['bid', 'ask'],
          h: [],
        });
        assert.equal(drafted.resting.c.ask.pFill, 0);
        assert.ok(oneChipInside.resting.s.ask.pFill > 0);
      },
    }),
  ];
}

function engineCases() {
  return [...askOwnershipCases(), ...quoteAvailabilityCases(), ...beliefEngineCases()];
}

module.exports = { engineCases };
