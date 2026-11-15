'use strict';

// The environment owns hidden information. Only view(actor) reaches a policy.
const SUITS = Object.freeze(['s', 'c', 'd', 'h']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const sum = (values) => values.reduce((a, b) => a + b, 0);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
function random(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(values, rng) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
const DECKS = freeze(
  SUITS.flatMap((_, large) =>
    SUITS.flatMap((_, small) => {
      if (large === small) return [];
      const counts = [10, 10, 10, 10];
      counts[large] = 12;
      counts[small] = 8;
      return [{ counts, goal: large ^ 1 }];
    }),
  ),
);

function settlement(hands, goal) {
  const g = typeof goal === 'string' ? SUITS.indexOf(goal) : goal;
  if (!Number.isInteger(g) || g < 0 || g > 3) throw Error('Invalid goal');
  const counts = hands.map((row) => row[g]);
  const supply = sum(counts);
  const pot = 200 - 10 * supply;
  const most = Math.max(...counts);
  const winners = counts.filter((n) => n === most).length;
  const bonuses = counts.map((n) => (n === most ? pot / winners : 0));
  return { supply, pot, bonuses, payouts: counts.map((n, p) => 10 * n + bonuses[p]) };
}

class Environment {
  #initial;
  #hands;
  #deck;
  #goal;
  #cash;
  #orders;
  #trades;
  #net;
  #ended = false;
  constructor(options = {}) {
    this.seed = Number(options.seed ?? 1101) >>> 0;
    this.players = options.players ?? 4;
    if (![4, 5].includes(this.players)) throw Error('Figgie requires 4 or 5 players');
    this.names = Object.freeze(
      Array.from({ length: this.players }, (_, p) => (p ? `Bot-Sim-${p}` : 'You')),
    );
    const rng = random(this.seed);
    const chosen = DECKS[Math.floor(rng() * DECKS.length)];
    this.#deck = chosen.counts.slice();
    this.#goal = chosen.goal;
    const cards = shuffle(
      this.#deck.flatMap((n, s) => Array(n).fill(s)),
      rng,
    );
    this.#hands = this.names.map((_, p) => {
      const row = [0, 0, 0, 0];
      cards.slice((p * 40) / this.players, ((p + 1) * 40) / this.players).forEach((s) => row[s]++);
      return row;
    });
    this.#initial = clone(this.#hands);
    this.#cash = this.names.map(() => 350 - 200 / this.players);
    this.#net = this.names.map(() => [0, 0, 0, 0]);
    this.#orders = SUITS.map(() => ({ bid: null, ask: null }));
    this.#trades = [];
    this.elapsed = 0;
    this.duration = options.duration ?? 240000;
    this.revision = 0;
  }
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw Error('Invalid clock increment');
    this.elapsed = Math.min(this.duration, this.elapsed + ms);
  }
  #fill(buyer, seller, suit, price) {
    if (buyer === seller) return { ok: false, reason: 'self-trade' };
    if (this.#hands[seller][suit] < 1) return { ok: false, reason: 'no-inventory' };
    if (this.#cash[buyer] < price) return { ok: false, reason: 'no-cash' };
    this.#hands[seller][suit]--;
    this.#hands[buyer][suit]++;
    this.#net[seller][suit]--;
    this.#net[buyer][suit]++;
    this.#cash[seller] += price;
    this.#cash[buyer] -= price;
    const trade = { b: this.names[buyer], s: this.names[seller], suit: SUITS[suit], p: price };
    this.#trades.push(trade);
    // Native Figgie clears every quote, including other suits, after a fill.
    this.#orders = SUITS.map(() => ({ bid: null, ask: null }));
    this.revision++;
    return { ok: true, trade: clone(trade) };
  }
  act(actor, action) {
    if (!Number.isInteger(actor) || actor < 0 || actor >= this.players)
      return { ok: false, reason: 'actor' };
    if (this.#ended || this.elapsed >= this.duration) return { ok: false, reason: 'ended' };
    if (!action || action.kind === 'wait') return { ok: true, idle: true };
    const suit = SUITS.indexOf(action.suit);
    if (suit < 0) return { ok: false, reason: 'suit' };
    const book = this.#orders[suit];
    if (action.kind === 'cancel') {
      if (!['bid', 'ask'].includes(action.side)) return { ok: false, reason: 'side' };
      if (book[action.side]?.actor !== actor) return { ok: false, reason: 'not-owner' };
      book[action.side] = null;
      this.revision++;
      return { ok: true };
    }
    if (action.kind === 'take') {
      if (!['buy', 'sell'].includes(action.side)) return { ok: false, reason: 'side' };
      const order = book[action.side === 'buy' ? 'ask' : 'bid'];
      if (!order) return { ok: false, reason: 'no-quote' };
      return action.side === 'buy'
        ? this.#fill(actor, order.actor, suit, order.price)
        : this.#fill(order.actor, actor, suit, order.price);
    }
    if (action.kind !== 'quote' || !['bid', 'ask'].includes(action.side))
      return { ok: false, reason: 'action' };
    if (!Number.isSafeInteger(action.price) || action.price < 1)
      return { ok: false, reason: 'price' };
    if (action.side === 'ask' && this.#hands[actor][suit] < 1)
      return { ok: false, reason: 'no-inventory' };
    if (action.side === 'bid' && this.#cash[actor] < action.price)
      return { ok: false, reason: 'no-cash' };
    const opposite = book[action.side === 'bid' ? 'ask' : 'bid'];
    if (
      opposite &&
      (action.side === 'bid' ? action.price >= opposite.price : action.price <= opposite.price)
    ) {
      return action.side === 'bid'
        ? this.#fill(actor, opposite.actor, suit, opposite.price)
        : this.#fill(opposite.actor, actor, suit, opposite.price);
    }
    const previous = book[action.side];
    // This simulator models the public best quote, not an exchange order queue.
    if (
      previous &&
      previous.actor !== actor &&
      (action.side === 'bid' ? action.price <= previous.price : action.price >= previous.price)
    )
      return { ok: false, reason: 'not-improved' };
    book[action.side] = { actor, price: action.price };
    this.revision++;
    return { ok: true };
  }
  view(actor = 0) {
    if (!Number.isInteger(actor) || actor < 0 || actor >= this.players)
      throw Error('Invalid observer');
    const order = [actor, ...this.names.map((_, p) => p).filter((p) => p !== actor)];
    const seconds = Math.max(0, Math.ceil((this.duration - this.elapsed) / 1000));
    const self = this.names[actor];
    const held = this.#hands[actor].slice();
    const markets = SUITS.map((id, s) => {
      const { bid, ask } = this.#orders[s];
      const buyer = bid ? this.names[bid.actor] : null;
      const seller = ask ? this.names[ask.actor] : null;
      return {
        id,
        held: held[s],
        bid: bid?.price ?? null,
        ask: ask?.price ?? null,
        buyer,
        seller,
        canBuy: !!ask && seller !== self && this.#cash[actor] >= ask.price,
        canSell: !!bid && buyer !== self && held[s] > 0,
        canBid: this.#cash[actor] >= 1,
        canOffer: held[s] > 0,
        canRaiseBid: this.#cash[actor] >= (bid?.price ?? 0) + 1,
        canLowerAsk: held[s] > 0 && (!ask || ask.price > 1),
        canCancelBid: buyer === self,
        canCancelOffer: seller === self,
        fills: this.#trades.filter((t) => t.suit === id).map(clone),
      };
    });
    const result = {
      self,
      status: this.#ended ? 'ended' : 'live',
      round: 1,
      roundKey: 'simulated-round',
      room: 'offline-simulator',
      timer: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
      elapsed: this.elapsed,
      duration: this.duration,
      cash: this.#cash[actor],
      startingHand: this.#initial[actor].slice(),
      held,
      players: order.map((p) => ({
        name: this.names[p],
        cash: this.#cash[p],
        cards: sum(this.#hands[p]),
      })),
      trades: clone(this.#trades),
      net: order.map((p) => this.#net[p].slice()),
      markets,
      context: { botDifficulty: 'Simulated', simulated: true },
      signature: `simulated:${this.revision}:${this.#ended}`,
    };
    if (this.#ended) result.roundResult = this.result();
    return freeze(result);
  }
  truth() {
    // Used by scoring and invariant tests only; never included in policy input.
    return freeze({
      goal: SUITS[this.#goal],
      deck: this.#deck.slice(),
      initial: clone(this.#initial),
      hands: clone(this.#hands),
      cash: this.#cash.slice(),
      names: this.names.slice(),
    });
  }
  result() {
    if (!this.#ended) throw Error('Goal is not revealed before round end');
    const paid = settlement(this.#hands, this.#goal);
    const profits = Object.fromEntries(this.names.map((name, p) => [name, this.#cash[p] - 350]));
    return {
      goal: SUITS[this.#goal],
      profits,
      settledProfit: profits.You,
      verified: true,
      source: 'offline-simulator',
      payouts: Object.fromEntries(this.names.map((name, p) => [name, paid.payouts[p]])),
    };
  }
  finish() {
    if (!this.#ended) {
      const paid = settlement(this.#hands, this.#goal);
      this.#cash = this.#cash.map((cash, p) => cash + paid.payouts[p]);
      this.#orders = SUITS.map(() => ({ bid: null, ask: null }));
      this.#ended = true;
      this.elapsed = this.duration;
      this.revision++;
    }
    return this.result();
  }
}

function runRound(options = {}) {
  const { createPolicies } = require('./policies.cjs');
  const env = new Environment(options);
  const steps = options.steps ?? 240;
  if (!Number.isInteger(steps) || steps < 1) throw Error('steps must be a positive integer');
  const policies = options.policies || createPolicies({ ...options, players: env.players });
  if (policies.length !== env.players || policies.some((p) => typeof p.act !== 'function'))
    throw Error('One policy is required for each player');
  const trace = [];
  const actions = [];
  const capture = (step) => {
    const snapshot = env.view(0);
    const at = 1800000000000 + env.elapsed;
    const frame = { step, at, snapshot };
    trace.push(frame);
    options.onSnapshot?.(snapshot, env.truth(), frame);
  };
  capture(0);
  for (let step = 1; step <= steps; step++) {
    const actor = (step - 1) % env.players;
    // Capture after an action, before advancing, so the last action remains live.
    const action = policies[actor].act(env.view(actor));
    const result = env.act(actor, action);
    actions.push({ actor: env.names[actor], action: clone(action || { kind: 'wait' }), result });
    env.advance(env.duration / (steps + 1));
    capture(step);
  }
  const truthBeforeSettlement = env.truth();
  const result = env.finish();
  trace.push({ step: steps + 1, at: 1800000000000 + env.elapsed, snapshot: env.view(0) });
  return {
    seed: env.seed,
    players: env.players,
    policyTypes: policies.map((p) => p.type || 'custom'),
    actions,
    trace,
    truthBeforeSettlement,
    result,
  };
}

module.exports = { SUITS, DECKS, Environment, settlement, random, shuffle, freeze, runRound };
