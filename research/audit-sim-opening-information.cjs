'use strict';
// Exact opening information, before any quotes or trades. This evaluates the
// information in one dealt hand, not policy quality or the chance to win a game.
const fs = require('node:fs');
const path = require('node:path');
const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) value *= (n - Math.min(k, n - k) + i) / i;
  return value;
};
const decks = [];
for (let twelve = 0; twelve < 4; twelve++)
  for (let eight = 0; eight < 4; eight++)
    if (twelve !== eight) {
      const counts = [10, 10, 10, 10];
      counts[twelve] = 12;
      counts[eight] = 8;
      decks.push({ counts, goal: twelve ^ 1 });
    }
function analyze(players) {
  const handSize = 40 / players;
  const denominator = choose(40, handSize);
  const hands = [];
  let total = 0;
  let entropy = 0;
  let accuracy = 0;
  let brier = 0;
  for (let s = 0; s <= handSize; s++)
    for (let c = 0; c <= handSize - s; c++)
      for (let d = 0; d <= handSize - s - c; d++) {
        const hand = [s, c, d, handSize - s - c - d];
        const joint = [0, 0, 0, 0];
        for (const deck of decks) {
          const mass =
            deck.counts.reduce((p, n, i) => p * choose(n, hand[i]), 1) / (12 * denominator);
          joint[deck.goal] += mass;
        }
        const mass = joint.reduce((a, b) => a + b, 0);
        if (!mass) continue;
        const probabilities = joint.map((v) => v / mass);
        const top = Math.max(...probabilities);
        const bits = -probabilities.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
        const expectedBrier = 1 - probabilities.reduce((sum, p) => sum + p * p, 0);
        hands.push({
          hand,
          probability: mass,
          goalProbabilities: probabilities,
          topGoalProbability: top,
          entropyBits: bits,
        });
        total += mass;
        entropy += mass * bits;
        accuracy += mass * top;
        brier += mass * expectedBrier;
      }
  if (Math.abs(total - 1) > 1e-12) throw Error('Opening distribution not normalized');
  const probabilityAtLeast = (threshold) =>
    hands.reduce(
      (sum, h) => sum + (h.topGoalProbability >= threshold - 1e-12 ? h.probability : 0),
      0,
    );
  const probabilityAbove = (threshold) =>
    hands.reduce(
      (sum, h) => sum + (h.topGoalProbability > threshold + 1e-12 ? h.probability : 0),
      0,
    );
  return {
    players,
    handSize,
    legalHandPatterns: hands.length,
    totalProbability: total,
    priorEntropyBits: 2,
    expectedPosteriorEntropyBits: entropy,
    expectedInformationGainBits: 2 - entropy,
    expectedTopPickAccuracy: accuracy,
    expectedBayesBrier: brier,
    probabilityTopGoalStrictlyAbove50Percent: probabilityAbove(0.5),
    probabilityTopGoalAtLeast50Percent: probabilityAtLeast(0.5),
    probabilityTopGoalAtLeast75Percent: probabilityAtLeast(0.75),
    probabilityTopGoalAtLeast90Percent: probabilityAtLeast(0.9),
    hands,
  };
}
const four = analyze(4);
const five = analyze(5);
const summary = (x) => {
  const { hands, ...s } = x;
  return s;
};
const result = {
  schema: 1,
  method:
    'Exact enumeration of all one-player opening hand compositions. Each of the 12 ordered choices of the 12-card and 8-card suits has prior probability1/12. Hand likelihood is the multivariate hypergeometric product(C(deck_suit,hand_suit))/C(40,handSize). The goal is the other suit of the 12-card suit color. No public trades, quotes, known opponent hands, or policy assumptions enter.',
  interpretation:
    'These are opening-hand information and Bayes classification metrics, not game win probabilities. Four players receive10cards each; five players receive8cards each. Five total players means user plus four bots.',
  summary: {
    fourPlayers: summary(four),
    fivePlayers: summary(five),
    fiveMinusFour: {
      expectedPosteriorEntropyBits:
        five.expectedPosteriorEntropyBits - four.expectedPosteriorEntropyBits,
      expectedInformationGainBits:
        five.expectedInformationGainBits - four.expectedInformationGainBits,
      expectedTopPickAccuracy: five.expectedTopPickAccuracy - four.expectedTopPickAccuracy,
      probabilityTopGoalStrictlyAbove50Percent:
        five.probabilityTopGoalStrictlyAbove50Percent -
        four.probabilityTopGoalStrictlyAbove50Percent,
    },
  },
  distributions: { fourPlayers: four.hands, fivePlayers: five.hands },
};
const out =
  process.argv[2] ||
  path.resolve(
    __dirname,
    '../outputs/simulation-audit-2026-10-28/opening-information-players.json',
  );
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ out, ...result.summary }, null, 2));
