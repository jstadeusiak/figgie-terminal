'use strict';

/*
 * Shared inputs of the model parity cases: seeded randomness, synthetic
 * tables and opponent evidence, a stand-in for what earlier rounds taught,
 * and the helpers that run one build of the model and collect what it holds.
 */

const assert = require('node:assert/strict');

const SUIT_IDS = ['s', 'c', 'd', 'h'];
const BOT_NAMES = ['Bot-A', 'Bot-B', 'Bot-C', 'Bot-D'];
const HUMAN_NAME = 'Alice';
const OFFICIAL_SOURCE = 'official-round-rankings';
const SIMULATOR_SOURCE = 'offline-simulator';
const ROUND_START_AT = 1800000000000;

// Stands in for the two model fields that legitimately differ between builds.
const RELEASE_LABEL = 'release';

// A reduced sampling budget for the cases that do not need the production one.
const SMALL_BUDGET = { samples: 48, opponentSamples: 8 };

// ── Small helpers ────────────────────────────────────────────────────────

const clone = (value) => JSON.parse(JSON.stringify(value));
const sum = (numbers) => numbers.reduce((total, number) => total + number, 0);
const at = (seconds) => ROUND_START_AT + 1000 * seconds;

// What a call returns, or the message it throws. Cases use this for inputs the
// model is expected to reject, so a rejection is compared like any other output.
function outcome(call) {
  try {
    return { value: call() };
  } catch (error) {
    return { threw: error.message };
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const integerBelow = (random, limit) => Math.floor(random() * limit);
const pickFrom = (random, items) => items[integerBelow(random, items.length)];
const chance = (random, probability) => random() < probability;

// Rows of single-digit counts, written compactly: '2001 0300' is
// [[2, 0, 0, 1], [0, 3, 0, 0]].
const rows = (text) => text.split(' ').map((row) => [...row].map(Number));

// One executed trade. Seats index the table's players; you are seat 0.
const sale = (seller, buyer, suit, price) => ({ seller, buyer, suit, price });

// Every way to hold `size` cards across the four suits.
function allHands(size) {
  const hands = [];
  for (let spades = 0; spades <= size; spades++) {
    for (let clubs = 0; clubs <= size - spades; clubs++) {
      for (let diamonds = 0; diamonds <= size - spades - clubs; diamonds++) {
        hands.push([spades, clubs, diamonds, size - spades - clubs - diamonds]);
      }
    }
  }
  return hands;
}

// ── Tables and evidence ──────────────────────────────────────────────────

// A live table seen by `You`. The public flow, your inventory and each
// market's fills follow from the starting hand and the trades.
function tableSnapshot({
  hand,
  trades = [],
  players = 4,
  difficulty = 'Medium',
  names = null,
  quotes = {},
  roundKey = 'parity-table',
  cash = 300,
}) {
  const playerNames = names || ['You', ...BOT_NAMES.slice(0, players - 1)];
  const net = playerNames.map(() => [0, 0, 0, 0]);
  const tradeRows = trades.map(({ seller, buyer, suit, price }) => {
    net[seller][SUIT_IDS.indexOf(suit)]--;
    net[buyer][SUIT_IDS.indexOf(suit)]++;
    return { b: playerNames[buyer], s: playerNames[seller], suit, p: price };
  });
  const held = hand.map((count, suit) => count + net[0][suit]);
  const dealSize = 40 / playerNames.length;
  return {
    status: 'live',
    self: playerNames[0],
    cash,
    startingHand: hand.slice(),
    held,
    players: playerNames.map((name, seat) => ({
      name,
      cash: seat ? 240 - 60 * seat : cash,
      cards: dealSize + sum(net[seat]),
    })),
    net,
    trades: tradeRows,
    markets: SUIT_IDS.map((id, suit) => ({
      id,
      bid: null,
      ask: null,
      buyer: null,
      seller: null,
      canBuy: false,
      canSell: false,
      canBid: true,
      canOffer: held[suit] > 0,
      canRaiseBid: true,
      canLowerAsk: held[suit] > 0,
      canCancelBid: false,
      canCancelOffer: false,
      fills: tradeRows.filter((trade) => trade.suit === id),
      ...quotes[id],
    })),
    context: difficulty ? { botDifficulty: difficulty } : {},
    roundKey,
    timer: '3:10',
    round: 1,
    room: 'parity',
  };
}

// Random best quotes for every market: some yours, some one-sided, some absent.
function randomQuotes(random, playerNames) {
  const quotes = {};
  for (const id of SUIT_IDS) {
    const bid = chance(random, 0.8) ? 2 + integerBelow(random, 6) : null;
    const ask = chance(random, 0.8) ? (bid ?? 4) + 1 + integerBelow(random, 5) : null;
    quotes[id] = {
      bid,
      ask,
      buyer: bid === null ? null : pickFrom(random, playerNames),
      seller: ask === null ? null : pickFrom(random, playerNames),
      canBid: chance(random, 0.9),
      canRaiseBid: chance(random, 0.9),
    };
  }
  return quotes;
}

// The public card flow before each trade and after the last one.
function netHistory(snapshot) {
  const names = snapshot.players.map((player) => player.name);
  const history = [names.map(() => [0, 0, 0, 0])];
  for (const trade of snapshot.trades) {
    const net = clone(history.at(-1));
    const suit = SUIT_IDS.indexOf(trade.suit);
    net[names.indexOf(trade.s)][suit]--;
    net[names.indexOf(trade.b)][suit]++;
    history.push(net);
  }
  return history;
}

// Evidence shaped like the journal's: quotes, takes and consents at random
// public cuts, with occasional recovered events and same-instant observations.
function randomEvidence(random, snapshot, count) {
  const names = snapshot.players.map((player) => player.name);
  const nets = netHistory(snapshot);
  const events = [];
  let observedAt = 1000;
  for (let index = 0; index < count; index++) {
    observedAt += 400 * integerBelow(random, 3);
    const epoch = integerBelow(random, nets.length);
    const actor = pickFrom(random, names);
    const kind = pickFrom(random, ['quote', 'quote', 'quote', 'take', 'consent']);
    const event = {
      kind,
      actor,
      suit: pickFrom(random, SUIT_IDS),
      direction: pickFrom(random, ['buy', 'sell']),
      price: 1 + integerBelow(random, 14),
      epoch,
      net: clone(nets[epoch]),
      anchor: 1 + integerBelow(random, 12),
      at: observedAt,
      sourceSeq: index + 1,
      recovered: chance(random, 0.1),
    };
    if (kind !== 'quote') {
      const others = names.filter((name) => name !== actor);
      event.counterparty = pickFrom(random, others);
      event.confidence = pickFrom(random, [1, 0.6, 0, undefined]);
      event.passive = kind === 'consent' ? pickFrom(random, [true, false, null]) : false;
      event.counterpartyKnownBeforeAction = kind === 'take';
    }
    events.push(event);
  }
  return events;
}

// Evidence a healthy journal never writes but the engine must tolerate.
function malformedEvidence(snapshot) {
  const names = snapshot.players.map((player) => player.name);
  const ask = {
    kind: 'quote',
    actor: names[1],
    suit: 'h',
    direction: 'sell',
    price: 6,
    epoch: 0,
    net: names.map(() => [0, 0, 0, 0]),
    anchor: 5,
    at: 500,
    sourceSeq: 900,
    recovered: false,
  };
  const take = { ...ask, kind: 'take', direction: 'buy', counterparty: names[2] };
  return [
    { ...ask, net: names.map(() => [1, 0, 0, 0]) },
    { ...ask, net: undefined, direction: 'buy' },
    { ...ask, net: [[0, 0, 0, 0]] },
    { ...ask, epoch: snapshot.trades.length + 3 },
    { ...ask, epoch: -1 },
    { ...ask, epoch: 0.5 },
    { ...ask, price: 4.5 },
    { ...ask, price: 0 },
    { ...ask, suit: 'x' },
    { ...ask, suit: '' },
    { ...ask, actor: 'Nobody' },
    { ...ask, actor: names[0] },
    { ...ask, kind: 'cancel' },
    { ...ask, price: Infinity },
    { ...take, counterpartyKnownBeforeAction: true },
    { ...take, recovered: true },
    { ...ask, kind: 'consent', passive: true, at: undefined, sourceSeq: undefined },
  ];
}

// What the terminal has learned from earlier rounds, as stored.
const LEARNED = {
  metrics: { rounds: 7, opponentBrier: 0.61, baselineBrier: 0.66 },
  stylePriors: { [HUMAN_NAME]: [0.1, 0.6, 0.01, 0.29], 'Bot-B': [0.4, 0.2, 0.3, 0.1] },
  population: {
    bots: [0.2, 0.3, 0.3, 0.2],
    mixed: [0.25, 0.35, 0.15, 0.25],
    'bots:Hard': [0.5, 0.2, 0.2, 0.1],
  },
  groupMetrics: {
    'bots:Medium': { rounds: 11, opponentBrier: 0.9, baselineBrier: 0.6 },
    'bots:Hard': { rounds: 20, opponentBrier: 0.62, baselineBrier: 0.6 },
  },
  bonusGroupMetrics: { 'bots:Medium': { rounds: 3, bonusMae: 7.5 } },
  rates: {
    bid: { fills: 9, exposure: 410.5, outbids: 31 },
    ask: { fills: 4, exposure: 388.25, outbids: 12 },
    resets: 44,
    liveSeconds: 902.75,
  },
  fillCalibrationValidated: true,
};

// The quality guard trips once a group's record trails the physical baseline.
const TRAILING_RECORD = {
  groupMetrics: { 'bots:Medium': { rounds: 12, opponentBrier: 0.7, baselineBrier: 0.6 } },
};

// ── Running the model ────────────────────────────────────────────────────

// One inference. The release label and timing are checked, then replaced, so
// everything else in the model can be compared exactly.
function infer(release, engine, snapshot, evidence, learning) {
  const model = engine.infer(snapshot, evidence, learning);
  assert.equal(model.version, release.Belief.VERSION);
  assert.ok(Number.isFinite(model.computeMs) && model.computeMs >= 0);
  model.version = RELEASE_LABEL;
  model.computeMs = 0;
  return model;
}

// The engine fields other scripts read, plus the opponent-knowledge state.
function engineState(engine) {
  return {
    pool: engine.pool,
    poolKey: engine.poolKey,
    state: engine.state,
    latest: engine.latest,
    rebuilds: engine.rebuilds,
    inventoryEvidence: engine.inventoryEvidence,
    cachedEpisodes: engine.eventLogCache.size,
    knowledge: engine.knowledge && {
      stats: engine.knowledge.stats,
      summary: engine.knowledge.summary(),
      asks: engine.knowledge.asks,
      nets: engine.knowledge.nets,
      floors: engine.knowledge.floors,
    },
  };
}

// Everything a journal holds except its emit callback.
function journalState(journal) {
  const { emit, ...state } = journal;
  return state;
}

module.exports = {
  SUIT_IDS,
  BOT_NAMES,
  HUMAN_NAME,
  OFFICIAL_SOURCE,
  SIMULATOR_SOURCE,
  ROUND_START_AT,
  RELEASE_LABEL,
  SMALL_BUDGET,
  clone,
  sum,
  at,
  outcome,
  seededRandom,
  integerBelow,
  pickFrom,
  chance,
  rows,
  sale,
  allHands,
  tableSnapshot,
  randomQuotes,
  netHistory,
  randomEvidence,
  malformedEvidence,
  LEARNED,
  TRAILING_RECORD,
  infer,
  engineState,
  journalState,
};
