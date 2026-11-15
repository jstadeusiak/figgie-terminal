function figgieBayes(markets) {
  const players = ['You', 'Meerkat', 'Cheetah', 'Jaguar'];
  const hand = [4, 3, 2, 1];
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
    buy: 0,
    sell: null,
    holding: 0,
    buyMass: 0,
    buyNumerator: 0,
    sellNumerator: 0,
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
            const seller = players.indexOf(suit.seller);
            const buyer = players.indexOf(suit.buyer);
            if (seller > 0 && current[seller][s] > 0) {
              bySuit[s].buyMass += weight;
              if (s === goal) {
                const after = counts.slice();
                after[0]++;
                after[seller]--;
                bySuit[s].buyNumerator += weight * (payout(after, bonus) - before);
              }
            }
            if (buyer > 0 && current[0][s] > 0 && s === goal) {
              const after = counts.slice();
              after[0]--;
              after[buyer]++;
              bySuit[s].sellNumerator += weight * (before - payout(after, bonus));
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
    result.buy = result.buyMass ? result.buyNumerator / result.buyMass : null;
    result.sell = markets[s].buyer === 'You' ? null : result.sellNumerator / totalMass;
    result.holding /= totalMass;
    delete result.buyMass;
    delete result.buyNumerator;
    delete result.sellNumerator;
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
