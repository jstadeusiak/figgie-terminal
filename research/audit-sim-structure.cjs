'use strict';
// Exact physical payout oracle for auditing finite-world error. No behavior
// fitting, hidden outcome, or runtime changes. Archived v0.11 remains immutable.
const assert = require('node:assert/strict');
const R = require('../tools/model-registry.cjs');
const { Belief: B } = R.load('0.11.0');
const IDS = ['s', 'c', 'd', 'h'];
const fact = [1];
for (let i = 1; i <= 40; i++) fact[i] = fact[i - 1] * i;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const ways = (a) => fact[sum(a)] / a.reduce((v, n) => v * fact[n], 1);
function marginal(config, state, suit) {
  const columns = [0, 1, 2, 3].filter((s) => s !== suit);
  const remaining = config.deck.map((v, s) => v - state.hand[s]);
  const lower = state.minimum.slice(1);
  const memo = new Map();
  const future = lower.map((row) =>
    columns.map((_, i) => sum(columns.slice(i).map((s) => row[s]))),
  );
  function assignments(total, lo, hi, visit) {
    const row = [];
    function walk(p, left) {
      if (p === lo.length - 1) {
        if (left >= lo[p] && left <= hi[p]) {
          row[p] = left;
          visit(row);
        }
        return;
      }
      for (let v = lo[p]; v <= Math.min(hi[p], left); v++) {
        row[p] = v;
        walk(p + 1, left - v);
      }
    }
    walk(0, total);
  }
  function mass(j, caps) {
    if (caps.some((v, p) => v < future[p][j])) return 0;
    if (j === 2) return sum(caps) === remaining[columns[j]] ? ways(caps) : 0;
    const key = j + '|' + caps.join(',');
    if (memo.has(key)) return memo.get(key);
    let total = 0;
    assignments(
      remaining[columns[j]],
      lower.map((r) => r[columns[j]]),
      caps.map((v, p) => v - (future[p][j + 1] || 0)),
      (row) => {
        total +=
          ways(row) *
          mass(
            j + 1,
            caps.map((v, p) => v - row[p]),
          );
      },
    );
    memo.set(key, total);
    return total;
  }
  const rows = [];
  assignments(
    remaining[suit],
    lower.map((r) => r[suit]),
    lower.map((r) => state.size - sum(columns.map((s) => r[s]))),
    (row) => {
      const weight =
        ways(row) *
        mass(
          0,
          row.map((v) => state.size - v),
        );
      if (weight) rows.push({ counts: [state.hand[suit], ...row], weight });
    },
  );
  const total = sum(rows.map((r) => r.weight));
  assert(total > 0);
  return rows.map((r) => ({ ...r, probability: r.weight / total }));
}
function payout(counts, bonus) {
  const maximum = Math.max(...counts);
  const ties = counts.filter((v) => v === maximum).length;
  return counts[0] * 10 + (counts[0] === maximum ? bonus / ties : 0);
}
function exactPhysical(engine) {
  const state = engine.state;
  const n = state.n;
  const bySuit = IDS.map(() => ({
    probability: 0,
    bonus: 0,
    leader: 0,
    buyNumerator: Array(n).fill(0),
    availability: Array(n).fill(0),
    sell: Array(n).fill(0),
  }));
  let expectedPayout = 0;
  for (const config of engine.pool.configurations) {
    const g = config.goal;
    const p = config.probability;
    const bonus = 200 - 10 * config.deck[g];
    bySuit[g].probability += p;
    for (let s = 0; s < 4; s++)
      for (const row of marginal(config, state, s)) {
        const w = p * row.probability;
        const counts = row.counts.map((v, a) => v + state.net[a][s]);
        for (let a = 1; a < n; a++) if (counts[a] > 0) bySuit[s].availability[a] += w;
        if (s !== g) continue;
        const before = payout(counts, bonus);
        const bs = before - counts[0] * 10;
        bySuit[g].bonus += w * bs;
        bySuit[g].leader += w * Number(bs > 0);
        expectedPayout += w * before;
        for (let a = 1; a < n; a++) {
          const after = counts.slice();
          if (counts[a] > 0) {
            after[0]++;
            after[a]--;
            bySuit[g].buyNumerator[a] += w * (payout(after, bonus) - before);
            after[0]--;
            after[a]++;
          }
          if (counts[0] > 0) {
            after[0]--;
            after[a]++;
            bySuit[g].sell[a] += w * (before - payout(after, bonus));
          }
        }
      }
  }
  return {
    expectedPayout,
    bySuit: bySuit.map((r) => ({
      ...r,
      conditionalBonus: r.bonus / r.probability,
      conditionalLeader: r.leader / r.probability,
      buy: r.buyNumerator.map((v, a) => (r.availability[a] ? v / r.availability[a] : null)),
    })),
  };
}
function exactCalibratedBonus(engine, strength, blends = [1, 1, 1, 1]) {
  const state = engine.state;
  const rows = [[], [], [], []];
  for (const c of engine.pool.configurations)
    for (const row of marginal(c, state, c.goal)) {
      const counts = row.counts.map((v, a) => v + state.net[a][c.goal]);
      const before = payout(counts, 200 - 10 * c.deck[c.goal]);
      rows[c.goal].push({
        mass: c.probability * row.probability,
        score:
          strength *
          sum(row.counts.slice(1).map((v, a) => Math.max(0, state.net[a + 1][c.goal]) * v)),
        bonus: before - counts[0] * 10,
      });
    }
  return rows.map((list, g) => {
    const mass = sum(list.map((r) => r.mass));
    const max = Math.max(...list.map((r) => r.score));
    const norm = sum(list.map((r) => r.mass * Math.exp(r.score - max)));
    return sum(
      list.map(
        (r) =>
          r.bonus *
          (((1 - blends[g]) * r.mass) / mass +
            (blends[g] * r.mass * Math.exp(r.score - max)) / norm),
      ),
    );
  });
}
function frame(hand, flows = [], salt = 0, difficulty = 'Simulated') {
  const names = ['You', ...['A', 'B', 'C'].map((n) => 'Bot-' + n + '-' + salt)];
  const trades = flows.map(([s, b, suit]) => ({ s: names[s], b: names[b], suit: IDS[suit], p: 5 }));
  const net = names.map(() => [0, 0, 0, 0]);
  for (const [a, b, s] of flows) {
    net[a][s]--;
    net[b][s]++;
  }
  const held = hand.map((v, s) => v + net[0][s]);
  return {
    status: 'live',
    self: names[0],
    roundKey: 'structural-audit',
    startingHand: hand,
    held,
    net,
    cash: 350,
    players: names.map((name) => ({ name, cash: 350 })),
    trades,
    context: { botDifficulty: difficulty },
    markets: IDS.map((id) => ({
      id,
      bid: 3,
      ask: 7,
      buyer: names[1],
      seller: names[2],
      canBid: true,
      canOffer: true,
      canRaiseBid: true,
      canLowerAsk: true,
      fills: [],
    })),
  };
}
function summary(a) {
  const sorted = a.slice().sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted.at(-1),
    range: sorted.at(-1) - sorted[0],
    mean: sum(a) / a.length,
  };
}
function audit() {
  const cases = [
    { id: 'balanced-opening', hand: [3, 3, 2, 2], flows: [] },
    { id: 'four-hearts', hand: [3, 2, 1, 4], flows: [] },
    { id: 'one-heart-acquired', hand: [2, 2, 3, 3], flows: [[1, 0, 3]] },
    {
      id: 'competing-acquirer',
      hand: [2, 2, 2, 4],
      flows: [
        [2, 1, 3],
        [3, 1, 3],
      ],
    },
    { id: 'sparse-held-suits', hand: [5, 4, 1, 0], flows: [] },
  ];
  const results = [];
  for (const c of cases) {
    const input = frame(c.hand, c.flows);
    const engine = new B.BeliefEngine({ skipPricing: true });
    engine.build(input);
    const started = performance.now();
    const exact = exactPhysical(engine);
    const oracleMs = performance.now() - started;
    const errors = [];
    const values = [];
    for (let salt = 0; salt < 24; salt++) {
      const model = new B.BeliefEngine({ skipPricing: true }).infer(
        frame(c.hand, c.flows, salt),
        [],
        { forceBaseline: true },
      );
      values.push(model.expectedPayout);
      const fieldErrors = [];
      for (let s = 0; s < 4; s++) {
        fieldErrors.push(
          Math.abs(model.bySuit[s].conditionalBonus - exact.bySuit[s].conditionalBonus),
        );
        for (let a = 1; a < 4; a++) {
          fieldErrors.push(
            Math.abs(
              model.bySuit[s].counterparties['Bot-' + ['A', 'B', 'C'][a - 1] + '-' + salt].buy -
                exact.bySuit[s].buy[a],
            ),
          );
        }
      }
      errors.push(Math.max(...fieldErrors));
    }
    results.push({
      id: c.id,
      oracleMs,
      exactPayout: exact.expectedPayout,
      payoutAcrossNameOnlyChanges: summary(values),
      maxConditionalBonusOrBuyError: summary(errors),
      exactConditionalBonus: exact.bySuit.map((s) => s.conditionalBonus),
    });
  }
  return results;
}
if (require.main === module) console.log(JSON.stringify(audit(), null, 2));
module.exports = { marginal, exactPhysical, exactCalibratedBonus, frame, audit };
