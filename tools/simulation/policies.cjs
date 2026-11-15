'use strict';

// Deliberately independent of both production belief engines. These are varied
// synthetic behaviors, not a reverse-engineering claim about Figgie's bots.
const { SUITS, DECKS, random, shuffle } = require('./simulator.cjs');
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const sum = (a) => a.reduce((x, y) => x + y, 0);
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) result *= (n - i + 1) / i;
  return result;
}
const priorCache = new Map();
function privateOdds(hand) {
  const key = hand.join(',');
  if (!priorCache.has(key)) {
    const weights = DECKS.map((d) => d.counts.reduce((w, n, s) => w * choose(n, hand[s]), 1));
    const total = sum(weights);
    priorCache.set(
      key,
      weights.map((w) => w / total),
    );
  }
  return priorCache.get(key).slice();
}
function estimate(view, usePublic) {
  const weights = privateOdds(view.startingHand);
  const names = view.players.map((p) => p.name);
  const net = names.map(() => [0, 0, 0, 0]);
  const minimum = names.map(() => [0, 0, 0, 0]);
  for (const trade of view.trades) {
    const s = SUITS.indexOf(trade.suit);
    const seller = names.indexOf(trade.s);
    const buyer = names.indexOf(trade.b);
    net[seller][s]--;
    net[buyer][s]++;
    minimum[seller][s] = Math.max(minimum[seller][s], -net[seller][s]);
  }
  // Simple supply pruning, not the candidate's nested model of opponent beliefs.
  const feasible = weights.map((w, k) =>
    DECKS[k].counts.every(
      (n, s) => view.startingHand[s] + sum(minimum.slice(1).map((row) => row[s])) <= n,
    )
      ? w
      : 0,
  );
  const mass = sum(feasible);
  const mixed = weights.map(
    (w, k) => (1 - usePublic) * w + usePublic * (mass ? feasible[k] / mass : w),
  );
  const goals = [0, 0, 0, 0];
  const supply = [0, 0, 0, 0];
  mixed.forEach((w, k) => {
    goals[DECKS[k].goal] += w;
    DECKS[k].counts.forEach((n, s) => (supply[s] += w * n));
  });
  return { goals, supply, net };
}
function normal(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
}
const PROFILES = Object.freeze({
  value: { public: 0.1, bonus: 0.05, anchor: 0.05, inventory: 0.12, spread: 0.8, error: 0.55 },
  bonus: { public: 0.8, bonus: 1, anchor: 0.1, inventory: 0.04, spread: 1, error: 0.6 },
  liquidity: { public: 0.25, bonus: 0.15, anchor: 0.55, inventory: 0.65, spread: 0.6, error: 1.1 },
  momentum: { public: 0.3, bonus: 0.25, anchor: 0.55, inventory: 0.12, spread: 1, error: 1.2 },
  noisy: { public: 0, bonus: 0.25, anchor: 0.3, inventory: 0.25, spread: 1.4, error: 2.8 },
});

function createPolicy(type, options = {}) {
  if (!PROFILES[type]) throw Error(`Unknown policy: ${type}`);
  const profile = PROFILES[type];
  const rng = random(options.seed ?? 1);
  const noise = options.noise ?? 1;
  const brownian = clamp(options.brownian ?? 0, 0, 1);
  const maxPrice = options.maxPrice ?? 50;
  const difficulty = { easy: 1.5, medium: 1, hard: 0.55 }[options.difficulty || 'medium'];
  if (!Number.isFinite(difficulty)) throw Error('difficulty must be easy, medium or hard');
  const deviations = [0, 0, 0, 0];
  let lastTime = 0;
  return {
    type,
    act(view) {
      const dt = clamp((view.elapsed - lastTime) / 1000, 0.25, 8);
      lastTime = view.elapsed;
      for (let s = 0; s < 4; s++)
        deviations[s] = clamp(
          deviations[s] * Math.exp(-0.2 * (1 - brownian) * dt) +
            normal(rng) * profile.error * noise * difficulty * Math.sqrt(dt),
          -maxPrice / 3,
          maxPrice / 3,
        );
      const info = estimate(view, profile.public);
      const n = view.players.length;
      const values = SUITS.map((suit, s) => {
        const market = view.markets[s];
        const recent = view.trades.filter((t) => t.suit === suit).slice(-6);
        const last = recent.at(-1)?.p ?? 5;
        const trend = recent.length > 1 ? clamp(last - recent[0].p, -4, 4) : 0;
        const base = 10 * info.goals[s];
        const anchor =
          market.bid !== null && market.ask !== null ? (market.bid + market.ask) / 2 : last;
        const expectedOthers = view.players
          .slice(1)
          .map((_, p) =>
            Math.max(0, (info.supply[s] - view.startingHand[s]) / (n - 1) + info.net[p + 1][s]),
          );
        const leader = Math.max(...expectedOthers);
        const held = view.held[s];
        // Smooth contest approximation, based only on public net and own cards.
        // A marginal card matters near the lead; winning six is not a hard rule.
        const winChance = (cards) => 1 / (1 + Math.exp(-(cards - leader) / 1.1));
        const bonusPot = 110; // Goal supply is 8 or 10; an intentionally rough policy belief.
        const buyBonus = bonusPot * info.goals[s] * (winChance(held + 1) - winChance(held));
        const sellBonus = bonusPot * info.goals[s] * (winChance(held) - winChance(held - 1));
        const mark =
          base * (1 - profile.anchor) +
          anchor * profile.anchor +
          deviations[s] -
          profile.inventory * (held - 40 / n / 4) +
          (type === 'momentum' ? 0.6 * trend : 0);
        return { buy: mark + profile.bonus * buyBonus, sell: mark + profile.bonus * sellBonus };
      });
      const takes = [];
      for (let s = 0; s < 4; s++) {
        const m = view.markets[s];
        if (m.canBuy)
          takes.push({
            action: { kind: 'take', suit: SUITS[s], side: 'buy' },
            edge: values[s].buy - m.ask,
          });
        if (m.canSell)
          takes.push({
            action: { kind: 'take', suit: SUITS[s], side: 'sell' },
            edge: m.bid - values[s].sell,
          });
      }
      takes.sort((a, b) => b.edge - a.edge);
      if (takes[0] && takes[0].edge > -0.15 && rng() < 0.88) return takes[0].action;
      const candidates = shuffle(
        SUITS.flatMap((suit, s) => [
          { suit, s, side: 'bid' },
          ...(view.held[s] ? [{ suit, s, side: 'ask' }] : []),
        ]),
        rng,
      );
      for (const candidate of candidates) {
        const { s, side, suit } = candidate;
        const market = view.markets[s];
        const reservation = values[s][side === 'bid' ? 'buy' : 'sell'];
        let price =
          side === 'bid'
            ? Math.floor(reservation - profile.spread)
            : Math.ceil(reservation + profile.spread);
        price = clamp(price, 1, maxPrice);
        // Improve by one when feasible rather than continuously leapfrogging fair value.
        if (side === 'bid' && market.bid !== null && market.buyer !== view.self) {
          if (market.bid + 1 > reservation) continue;
          price = Math.min(price, market.bid + 1);
          if (price <= market.bid) continue;
        }
        if (side === 'ask' && market.ask !== null && market.seller !== view.self) {
          if (market.ask - 1 < reservation || market.ask <= 1) continue;
          price = Math.max(price, market.ask - 1);
          if (price >= market.ask) continue;
        }
        if (side === 'bid' && price > view.cash) continue;
        if (market[side] === price && market[side === 'bid' ? 'buyer' : 'seller'] === view.self)
          continue;
        return { kind: 'quote', suit, side, price };
      }
      return { kind: 'wait' };
    },
  };
}
function createPolicies(options = {}) {
  const seed = Number(options.seed ?? 1101);
  const players = options.players ?? 4;
  const types =
    options.heterogeneous === false
      ? Array(players).fill('value')
      : shuffle(Object.keys(PROFILES), random(seed ^ 0xb07)).slice(0, players);
  return types.map((type, p) => createPolicy(type, { ...options, seed: seed + (p + 1) * 7919 }));
}

module.exports = { createPolicy, createPolicies, privateOdds, estimate, PROFILES };
