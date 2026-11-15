/* Independent reference model, used only by tests.

   For four players it enumerates every legal deal consistent with the user's
   starting hand and the public trade history; for five it samples them. It
   shares no code with the extension's inference engine (belief.js), so the
   tests use it to cross-check that engine's cards-only probabilities. */
function exactFour(markets, options) {
  const players = options.players;
  const hand = options.hand;
  const net = players.map(() => [0, 0, 0, 0]);
  const minimum = players.map(() => [0, 0, 0, 0]);
  const chooseMemo = new Map();
  function choose(n, k) {
    if (n < 0 || k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    const key = `${n},${k}`;
    if (chooseMemo.has(key)) return chooseMemo.get(key);
    let result = 1;
    for (let i = 1; i <= k; i++) result *= (n - k + i) / i;
    chooseMemo.set(key, result);
    return result;
  }
  markets.forEach((suit, s) =>
    suit.fills.forEach((fill) => {
      const seller = players.indexOf(fill.s);
      const buyer = players.indexOf(fill.b);
      if (seller < 0 || buyer < 0 || seller === buyer) throw Error('Invalid observed trade');
      net[seller][s]--;
      minimum[seller][s] = Math.max(minimum[seller][s], -net[seller][s]);
      net[buyer][s]++;
    }),
  );
  if (hand.some((count, s) => count < minimum[0][s]))
    throw Error('Starting hand contradicts trades');
  function rows(lower, upper) {
    const result = [];
    for (let a = lower[0]; a <= Math.min(upper[0], 10); a++)
      for (let b = lower[1]; b <= Math.min(upper[1], 10 - a); b++)
        for (let c = lower[2]; c <= Math.min(upper[2], 10 - a - b); c++) {
          const d = 10 - a - b - c;
          if (d >= lower[3] && d <= upper[3]) result.push([a, b, c, d]);
        }
    return result;
  }
  const odds = [0, 0, 0, 0];
  const handOdds = [0, 0, 0, 0];
  const bySuit = markets.map(() => ({
    probability: 0,
    base: 0,
    holding: 0,
    counterparties: players.map(() => ({ buyMass: 0, buyNumerator: 0, sellNumerator: 0 })),
  }));
  const configurations = [];
  let totalMass = 0;
  let handMass = 0;
  let stateCount = 0;
  let expectedPayout = 0;
  const allocationDenominator = choose(30, 10) * choose(20, 10);
  const payout = (counts, bonus) => {
    const max = Math.max(...counts);
    return (
      10 * counts[0] + (counts[0] === max ? bonus / counts.filter((c) => c === max).length : 0)
    );
  };
  for (let twelve = 0; twelve < 4; twelve++)
    for (let eight = 0; eight < 4; eight++) {
      if (twelve === eight) continue;
      const deck = [10, 10, 10, 10];
      deck[twelve] = 12;
      deck[eight] = 8;
      const goal = twelve ^ 1;
      const handLikelihood =
        deck.reduce((weight, n, s) => weight * choose(n, hand[s]), 1) / choose(40, 10);
      const handWeight = handLikelihood / 12;
      handOdds[goal] += handWeight;
      handMass += handWeight;
      const remaining = deck.map((count, s) => count - hand[s]);
      const firstRows = rows(minimum[1], remaining);
      const secondRows = rows(minimum[2], remaining);
      let configMass = 0;
      for (const a of firstRows)
        for (const b of secondRows) {
          const c = remaining.map((n, s) => n - a[s] - b[s]);
          if (c.some((n, s) => n < minimum[3][s])) continue;
          let ways = 1;
          for (let s = 0; s < 4; s++)
            ways *= choose(remaining[s], a[s]) * choose(remaining[s] - a[s], b[s]);
          if (!ways) continue;
          const weight = (handWeight * ways) / allocationDenominator;
          const current = [hand, a, b, c].map((row, p) => row.map((count, s) => count + net[p][s]));
          if (current.some((row) => row.some((n) => n < 0))) throw Error('Infeasible allocation');
          stateCount++;
          totalMass += weight;
          configMass += weight;
          odds[goal] += weight;
          const counts = current.map((row) => row[goal]);
          const bonus = 200 - 10 * deck[goal];
          const before = payout(counts, bonus);
          expectedPayout += weight * before;
          bySuit[goal].holding += weight * before;
          markets.forEach((suit, s) => {
            for (let counterparty = 1; counterparty < players.length; counterparty++) {
              const value = bySuit[s].counterparties[counterparty];
              if (current[counterparty][s] > 0) {
                value.buyMass += weight;
                if (s === goal) {
                  const after = counts.slice();
                  after[0]++;
                  after[counterparty]--;
                  value.buyNumerator += weight * (payout(after, bonus) - before);
                }
              }
              if (s === goal && current[0][s] > 0) {
                const after = counts.slice();
                after[0]--;
                after[counterparty]++;
                value.sellNumerator += weight * (before - payout(after, bonus));
              }
            }
          });
        }
      configurations.push({ deck, goal, mass: configMass });
    }
  if (!totalMass) throw Error('No deals satisfy the evidence');
  bySuit.forEach((result, s) => {
    result.probability = odds[s] / totalMass;
    result.handProbability = handOdds[s] / handMass;
    result.base = 10 * result.probability;
    result.counterparties = Object.fromEntries(
      players.slice(1).map((name, i) => {
        const v = result.counterparties[i + 1];
        return [
          name,
          {
            buy: v.buyMass ? v.buyNumerator / v.buyMass : null,
            sell: v.sellNumerator / totalMass,
            hasCardProbability: v.buyMass / totalMass,
          },
        ];
      }),
    );
    result.buy = result.counterparties[markets[s].seller]?.buy ?? null;
    result.sell = result.counterparties[markets[s].buyer]?.sell ?? null;
    result.holding /= totalMass;
  });
  const expectedBase = bySuit.reduce((sum, suit, s) => sum + suit.base * (hand[s] + net[0][s]), 0);
  return {
    bySuit,
    expectedPayout: expectedPayout / totalMass,
    expectedBase,
    expectedBonus: expectedPayout / totalMass - expectedBase,
    stateCount,
    configurations: configurations.map((c) => ({
      deck: c.deck,
      goal: c.goal,
      probability: c.mass / totalMass,
    })),
    currentInventory: hand.map((n, s) => n + net[0][s]),
    net,
    minimum,
    evidenceProbability: totalMass / handMass,
  };
}
function sampledFive(markets, options) {
  const { players, hand } = options;
  const n = players.length;
  const size = 40 / n;
  const net = players.map(() => [0, 0, 0, 0]);
  const minimum = players.map(() => [0, 0, 0, 0]);
  markets.forEach((s, i) =>
    s.fills.forEach((t) => {
      const a = players.indexOf(t.s);
      const b = players.indexOf(t.b);
      if (a < 0 || b < 0) throw Error('Unknown trade participant');
      net[a][i]--;
      minimum[a][i] = Math.max(minimum[a][i], -net[a][i]);
      net[b][i]++;
    }),
  );
  const choose = (n, k) => {
    if (k < 0 || k > n) return 0;
    let value = 1;
    for (let i = 1; i <= Math.min(k, n - k); i++) value *= (n - Math.min(k, n - k) + i) / i;
    return value;
  };
  const decks = [];
  const handOdds = [0, 0, 0, 0];
  let handTotal = 0;
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++)
      if (a !== b) {
        const deck = [10, 10, 10, 10];
        deck[a] = 12;
        deck[b] = 8;
        const weight = deck.reduce((v, k, s) => v * choose(k, hand[s]), 1);
        const remaining = deck.flatMap((k, s) => Array(k - hand[s]).fill(s));
        decks.push({ deck, goal: a ^ 1, weight, remaining });
        handOdds[a ^ 1] += weight;
        handTotal += weight;
      }
  let seed = 2166136261;
  for (const ch of JSON.stringify([hand, players, minimum]))
    seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  const random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const result = markets.map(() => ({
    hits: 0,
    holding: 0,
    counterparties: players.map(() => ({ buyWeight: 0, buyValue: 0, sellValue: 0 })),
  }));
  let accepted = 0;
  let attempts = 0;
  let totalPayout = 0;
  const payout = (counts, bonus) => {
    const max = Math.max(...counts);
    return (
      10 * counts[0] + (counts[0] === max ? bonus / counts.filter((k) => k === max).length : 0)
    );
  };
  while (attempts < 80000 && accepted < 8000) {
    attempts++;
    let pick = random() * handTotal;
    let d = decks.at(-1);
    for (const candidate of decks) {
      pick -= candidate.weight;
      if (pick <= 0) {
        d = candidate;
        break;
      }
    }
    const shuffled = d.remaining.slice();
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    const initial = [hand.slice(), ...Array.from({ length: n - 1 }, () => [0, 0, 0, 0])];
    shuffled.forEach((s, j) => initial[1 + Math.floor(j / size)][s]++);
    if (initial.some((row, p) => row.some((k, s) => k < minimum[p][s]))) continue;
    const now = initial.map((row, p) => row.map((k, s) => k + net[p][s]));
    accepted++;
    const g = d.goal;
    const counts = now.map((row) => row[g]);
    const bonus = 200 - 10 * d.deck[g];
    const before = payout(counts, bonus);
    result[g].hits++;
    result[g].holding += before;
    totalPayout += before;
    markets.forEach((suit, s) => {
      for (let counterparty = 1; counterparty < n; counterparty++) {
        const value = result[s].counterparties[counterparty];
        if (now[counterparty][s] > 0) {
          value.buyWeight++;
          if (s === g) {
            const after = counts.slice();
            after[0]++;
            after[counterparty]--;
            value.buyValue += payout(after, bonus) - before;
          }
        }
        if (s === g && now[0][s] > 0) {
          const after = counts.slice();
          after[0]--;
          after[counterparty]++;
          value.sellValue += before - payout(after, bonus);
        }
      }
    });
  }
  if (accepted < 100) throw Error('Insufficient feasible sampled deals for a reliable model.');
  const bySuit = result.map((r, s) => {
    const counterparties = Object.fromEntries(
      players.slice(1).map((name, i) => {
        const v = r.counterparties[i + 1];
        return [
          name,
          {
            buy: v.buyWeight ? v.buyValue / v.buyWeight : null,
            sell: v.sellValue / accepted,
            hasCardProbability: v.buyWeight / accepted,
          },
        ];
      }),
    );
    return {
      probability: r.hits / accepted,
      handProbability: handOdds[s] / handTotal,
      base: (10 * r.hits) / accepted,
      counterparties,
      buy: counterparties[markets[s].seller]?.buy ?? null,
      sell: counterparties[markets[s].buyer]?.sell ?? null,
      holding: r.holding / accepted,
      probabilityError:
        1.96 * Math.sqrt(((r.hits / accepted) * (1 - r.hits / accepted)) / accepted),
    };
  });
  const currentInventory = hand.map((k, s) => k + net[0][s]);
  const expectedBase = bySuit.reduce((v, r, s) => v + r.base * currentInventory[s], 0);
  return {
    bySuit,
    currentInventory,
    expectedPayout: totalPayout / accepted,
    expectedBase,
    expectedBonus: totalPayout / accepted - expectedBase,
    net,
    minimum,
    stateCount: accepted,
    mode: 'Sampled',
    attempts,
  };
}
function inferFiggie(markets, options) {
  if (
    ![4, 5].includes(options.players.length) ||
    options.hand.reduce((a, b) => a + b, 0) !== 40 / options.players.length
  )
    throw Error('Incomplete starting hand or player list.');
  const result =
    options.players.length === 4 ? exactFour(markets, options) : sampledFive(markets, options);
  return { ...result, mode: result.mode || 'Exact' };
}
if (typeof module !== 'undefined') module.exports = { inferFiggie, exactFour, sampledFive };
