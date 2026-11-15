/*
 * Belief engine. Infers the goal suit and the hidden hands from your cards,
 * the public trades and what the other players quote and take, then values
 * your inventory and your quotes under that belief.
 *
 * Local inference: exact physical constraints, stratified hidden-hand worlds,
 * and deliberately conservative, explicitly provisional opponent likelihoods.
 */
(function (scope) {
  'use strict';

  const IDS = ['s', 'c', 'd', 'h'];
  const VERSION = '0.13.3';
  const MODEL_FITS =
    scope.FiggieModelFit || (typeof require === 'function' ? require('./model-fit.js') : {});
  const GOAL_SIGNAL =
    scope.FiggieGoalSignal || (typeof require === 'function' ? require('./goal-signal.js') : null);

  // ── The game ───────────────────────────────────────────────────────────

  // A deck has 40 cards: one suit of 12, two of 10 and one of 8, dealt evenly
  // to 4 or 5 players. The goal is the other suit of the 12-card suit's color.
  const DECK_SIZE = 40;
  const SUIT_COUNT = 4;
  const SUIT_SIZE = 10;
  const LARGE_SUIT_SIZE = 12;
  const SMALL_SUIT_SIZE = 8;
  const PLAYER_COUNTS = [4, 5];
  // The pot pays 10 chips per goal card. The rest is the bonus, which goes to
  // whoever holds the most goal cards and is split between equal leaders.
  const POT_CHIPS = 200;
  const CHIPS_PER_GOAL_CARD = 10;

  // ── Sampling ───────────────────────────────────────────────────────────

  // Hidden-hand worlds sampled for each legal deck.
  const DEFAULT_SAMPLES = 512;
  // Five-player tables use three quarters of that, but never fewer than this.
  const FIVE_PLAYER_SAMPLE_SHARE = 0.75;
  const FIVE_PLAYER_MIN_SAMPLES = 192;

  // Samples per deck of the hands an opponent cannot see, and their limits.
  const DEFAULT_OPPONENT_SAMPLES = 12;
  const MIN_OPPONENT_SAMPLES = 8;
  const MAX_OPPONENT_SAMPLES = 128;
  // Cache sizes: an opponent's sampled beliefs, the values read from one of
  // them, exact public tables, and the hand rows those tables are built from.
  const MAX_OPPONENT_BELIEFS = 6000;
  const MAX_VALUES_PER_BELIEF = 48;
  const MAX_PUBLIC_TABLES = 256;
  const MAX_PUBLIC_HAND_ROWS = 256;

  // A suit count runs from 0 to 12, so three of them pack into one index in
  // base 13, and one of them fits in four bits.
  const COUNT_BASE = LARGE_SUIT_SIZE + 1;
  const PUBLIC_TABLE_SIZE = COUNT_BASE ** 3;
  const COUNT_BITS = 4;
  const COUNT_MASK = 15;
  const packCounts = (a, b, c) => (a * COUNT_BASE + b) * COUNT_BASE + c;
  // The largest hand: ten cards at a four-player table.
  const MAX_HAND_SIZE = DECK_SIZE / Math.min(...PLAYER_COUNTS);

  // ── Opponent behavior ──────────────────────────────────────────────────

  // The behavior families an opponent's actions are explained by, and the
  // weight each starts with.
  const STYLE_NAMES = ['value', 'bonus', 'liquidity', 'noise'];
  const STYLE_BONUS = 1;
  const STYLE_LIQUIDITY = 2;
  const STYLE_NOISE = 3;
  const DEFAULT_PRIOR = [0.3, 0.25, 0.2, 0.25];
  // No family's prior weight is taken below this.
  const MIN_STYLE_PRIOR = 0.02;

  // How much evidence counts: `temperature` scales the whole likelihood,
  // `quote` and `consent` weigh those events, and `cap` limits one opponent.
  const DEFAULT_SIGNALS = { temperature: 0.3, quote: 0.2, consent: 0.12, cap: 5 };
  // Events rebuilt from history rather than observed live count for less.
  const RECOVERED_TAKE_WEIGHT = 0.2;
  const RECOVERED_QUOTE_WEIGHT = 0.05;

  // Evidence kept per opponent: the opening episodes plus the latest, or only
  // the latest where a fit says so.
  const OPENING_EPISODES = 8;
  const LATEST_EPISODES = 16;
  const RECENT_ONLY_EPISODES = 24;

  // The chip scale over which willingness to trade changes with price.
  const PRICE_SCALE = 4;
  const LIQUIDITY_PRICE_SCALE = 6;
  // The argument of the logistic is clamped to this range.
  const SIGMOID_LIMIT = 40;
  // The noise family spreads a quote evenly over this many price levels.
  const QUOTE_PRICE_LEVELS = 80;
  // A take or consent: a floor plus a share that follows willingness.
  const ACCEPT_FLOOR = 0.03;
  const ACCEPT_RANGE = 0.94;
  // A quote: a noise share plus a share that follows the price's distance
  // from the quoter's value. A quote is centered this many chips on the
  // profitable side of that value.
  const QUOTE_NOISE_SHARE = 0.025;
  const QUOTE_SIGNAL_SHARE = 0.975;
  const QUOTE_MARGIN = 2;
  const MIN_QUOTE_DENSITY = 1e-7;
  const MIN_QUOTE_NORMALIZER = 0.02;
  // Offering or selling a card while holding none of the suit is this unlikely.
  const SHORT_SALE_PENALTY = 0.02;
  const MIN_LIKELIHOOD = 1e-9;
  // The noise family accepts any price half the time.
  const NOISE_ACCEPTANCE = 0.5;

  // A reservation price without opponent knowledge: a bonus guess that fades
  // with distance from the estimated lead, and a liquidity trader's shading.
  const ASSUMED_BONUS_CHIPS = 110;
  const LEAD_WIDTH_CARDS = 1.6;
  const DEFAULT_ANCHOR_PRICE = 5;
  const NEUTRAL_HOLDING = 3;
  const SHADING_PER_CARD = 0.25;

  // ── Mixing and calibration ─────────────────────────────────────────────

  // Weight of the behavioral posterior without a fit, and once the quality
  // guard has tripped: enough rounds with a Brier score this much worse than
  // the physical baseline's.
  const DEFAULT_BLEND = 0.35;
  const GUARDED_BLEND = 0.1;
  const GUARD_MIN_ROUNDS = 12;
  const GUARD_BRIER_MARGIN = 0.025;
  const CALIBRATED_GROUP = 'bots:Medium';
  const CALIBRATED_PLAYERS = 4;

  // Inventory calibration keeps at least this many effective worlds per goal.
  const DEFAULT_MIN_EFFECTIVE = 64;
  const MIN_BLEND_CURVATURE = 1e-15;

  // ── Resting quotes ─────────────────────────────────────────────────────

  // A resting quote is valued over this many seconds.
  const FILL_HORIZON_SECONDS = 10;
  // Prior exposure, in seconds, behind one assumed fill, outbid and reset.
  const FILL_PRIOR_SECONDS = 30;
  const OUTBID_PRIOR_SECONDS = 10;
  const RESET_PRIOR_SECONDS = 10;
  // Opponents who would each accept half the time fill at the base rate
  // between them.
  const FILL_INTENSITY_SCALE = 2;

  // ── Numeric helpers ────────────────────────────────────────────────────

  const BINOMIALS = Array.from({ length: DECK_SIZE + 1 }, (_, total) =>
    Array.from({ length: DECK_SIZE + 1 }, (_, picked) => {
      if (picked > total) return 0;
      const fewer = Math.min(picked, total - picked);
      let ways = 1;
      for (let step = 1; step <= fewer; step++) ways *= (total - fewer + step) / step;
      return ways;
    }),
  );
  // The number of ways to choose `picked` of `total` cards.
  const choose = (total, picked) =>
    total >= 0 && picked >= 0 && picked <= total ? BINOMIALS[total][picked] : 0;

  const LOG_FACTORIAL = [0];
  for (let n = 1; n <= DECK_SIZE; n++) LOG_FACTORIAL[n] = LOG_FACTORIAL[n - 1] + Math.log(n);

  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x, -SIGMOID_LIMIT, SIGMOID_LIMIT)));
  const logsumexp = (logs) => {
    const largest = Math.max(...logs);
    return largest + Math.log(sum(logs.map((log) => Math.exp(log - largest))));
  };
  const emptyFlow = (names) => names.map(() => [0, 0, 0, 0]);
  const indexes = (list) => list.map((_, index) => index);

  // A 32-bit FNV-1a hash of a value's text. Sampling seeds are made from it.
  function hash(value) {
    let state = 2166136261;
    for (const character of String(value)) {
      state = Math.imul(state ^ character.charCodeAt(0), 16777619);
    }
    return state >>> 0;
  }

  // A seeded generator of numbers in [0, 1) (mulberry32).
  function rng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Decks and one hand's private belief ────────────────────────────────

  // The twelve legal decks: which suit has 12 cards, which has 8.
  const DECKS = [];
  for (let largeSuit = 0; largeSuit < SUIT_COUNT; largeSuit++) {
    for (let smallSuit = 0; smallSuit < SUIT_COUNT; smallSuit++) {
      if (largeSuit === smallSuit) continue;
      const deck = [SUIT_SIZE, SUIT_SIZE, SUIT_SIZE, SUIT_SIZE];
      deck[largeSuit] = LARGE_SUIT_SIZE;
      deck[smallSuit] = SMALL_SUIT_SIZE;
      DECKS.push({ deck, goal: largeSuit ^ 1 });
    }
  }

  const bonusPool = (config) => POT_CHIPS - CHIPS_PER_GOAL_CARD * config.deck[config.goal];

  // The number of ways a deck can deal this hand.
  const handWays = (deck, hand) =>
    deck.reduce((ways, size, suit) => ways * choose(size, hand[suit]), 1);

  const handCache = new Map();

  // What a hand alone says: the probability of each goal suit and the expected
  // size of each suit.
  function privateBelief(hand) {
    const key = hand.join(',');
    if (handCache.has(key)) return handCache.get(key);
    let total = 0;
    const goals = [0, 0, 0, 0];
    const counts = [0, 0, 0, 0];
    for (const config of DECKS) {
      const ways = handWays(config.deck, hand);
      total += ways;
      goals[config.goal] += ways;
      config.deck.forEach((size, suit) => (counts[suit] += ways * size));
    }
    const result = {
      goals: goals.map((ways) => ways / total),
      counts: counts.map((ways) => ways / total),
    };
    handCache.set(key, result);
    return result;
  }

  // ── Physical constraints ───────────────────────────────────────────────

  // Reads the deal's public facts from a snapshot: the players, your starting
  // hand, each player's net card flow, and the fewest cards of each suit each
  // player must have been dealt to make the sales they made.
  function physical(snapshot) {
    const names = snapshot.players.map((player) => player.name);
    const n = names.length;
    const size = DECK_SIZE / n;
    const hand = snapshot.startingHand;
    const isLegalDeal =
      PLAYER_COUNTS.includes(n) &&
      sum(hand) === size &&
      hand.every((count) => Number.isInteger(count) && count >= 0 && count <= LARGE_SUIT_SIZE);
    if (!isLegalDeal) throw Error('Invalid deal');

    const net = emptyFlow(names);
    const minimum = emptyFlow(names);
    for (const trade of snapshot.trades) {
      const suit = IDS.indexOf(trade.suit);
      const seller = names.indexOf(trade.s);
      const buyer = names.indexOf(trade.b);
      if (suit < 0 || seller < 0 || buyer < 0 || seller === buyer) throw Error('Invalid trade');
      net[seller][suit]--;
      minimum[seller][suit] = Math.max(minimum[seller][suit], -net[seller][suit]);
      net[buyer][suit]++;
    }
    if (hand.some((count, suit) => count < minimum[0][suit])) {
      throw Error('Hand contradicts history');
    }
    if (snapshot.held?.some((count, suit) => count !== hand[suit] + net[0][suit])) {
      throw Error('Current inventory contradicts the reconstructed deal');
    }
    return { names, n, size, hand, net, minimum };
  }

  // A native live ask exposes ownership even when it never executes. Validate its
  // epoch against public trade flow before using it as an inventory lower bound.
  function askInventoryConstraints(snapshot, state, events) {
    const diagnostic = { qualifiedAsks: 0, tightenedBounds: 0, rejectedAsks: 0, fallback: false };
    const tradeCount = snapshot.trades.length;
    const asksByEpoch = new Map();
    for (const event of events) {
      if (event.kind !== 'quote' || event.direction !== 'sell' || event.recovered) continue;
      const actor = state.names.indexOf(event.actor);
      const suit = IDS.indexOf(event.suit);
      if (actor <= 0 || suit < 0) continue;
      const isWellFormed =
        Number.isSafeInteger(event.epoch) &&
        event.epoch >= 0 &&
        event.epoch <= tradeCount &&
        Number.isSafeInteger(event.price) &&
        event.price > 0 &&
        Array.isArray(event.net) &&
        event.net.length === state.n;
      if (!isWellFormed) {
        diagnostic.rejectedAsks++;
        continue;
      }
      if (!asksByEpoch.has(event.epoch)) asksByEpoch.set(event.epoch, []);
      asksByEpoch.get(event.epoch).push({ event, actor, suit });
    }

    // Replay the trades; an ask counts only if it recorded the flow of its epoch.
    const net = emptyFlow(state.names);
    for (let epoch = 0; epoch <= tradeCount; epoch++) {
      for (const { event, actor, suit } of asksByEpoch.get(epoch) || []) {
        if (!recordsFlow(event.net, net)) {
          diagnostic.rejectedAsks++;
          continue;
        }
        const minimum = Math.max(0, 1 - net[actor][suit]);
        if (minimum > state.size) {
          diagnostic.rejectedAsks++;
          continue;
        }
        diagnostic.qualifiedAsks++;
        if (minimum > state.minimum[actor][suit]) {
          state.minimum[actor][suit] = minimum;
          diagnostic.tightenedBounds++;
        }
      }
      const trade = snapshot.trades[epoch];
      if (trade) {
        const suit = IDS.indexOf(trade.suit);
        net[state.names.indexOf(trade.b)][suit]++;
        net[state.names.indexOf(trade.s)][suit]--;
      }
    }
    return diagnostic;
  }

  // True when an event's recorded flow is exactly the replayed one.
  function recordsFlow(recorded, net) {
    return recorded.every(
      (row, seat) =>
        Array.isArray(row) &&
        row.length === SUIT_COUNT &&
        row.every((count, suit) => Number.isSafeInteger(count) && count === net[seat][suit]),
    );
  }

  // ── Inventory calibration ──────────────────────────────────────────────

  // Residual inventory calibration: net acquirers tended to start with more cards
  // in the audited four-player Medium-bot rounds. Renormalize within each goal so
  // this changes bonus/selection estimates, never the goal-suit marginal itself.
  function inventoryWeights(
    worlds,
    weights,
    net,
    strength,
    minEffective = DEFAULT_MIN_EFFECTIVE,
    referenceEss = false,
  ) {
    const mass = [0, 0, 0, 0];
    const maxScore = [-Infinity, -Infinity, -Infinity, -Infinity];
    const scores = worlds.map((world) => {
      const goal = world.goal;
      const acquired = world.initial
        .slice(1)
        .map((hand, other) => Math.max(0, net[other + 1][goal]) * hand[goal]);
      return strength * sum(acquired);
    });
    worlds.forEach((world, index) => {
      mass[world.goal] += weights[index];
      maxScore[world.goal] = Math.max(maxScore[world.goal], scores[index]);
    });
    const tiltedMass = [0, 0, 0, 0];
    const tilted = worlds.map((world, index) => {
      const weight = weights[index] * Math.exp(scores[index] - maxScore[world.goal]);
      tiltedMass[world.goal] += weight;
      return weight;
    });
    const essMultiplier = (world) => (referenceEss ? (world.referenceEssMultiplier ?? 1) : 1);

    // Optional importance-moment correction retains the original equal-deck
    // proposal as the ESS reference when goal strata use unequal draw counts.
    // It changes the guard calculation, never the posterior mass of a world.
    const beforeSquared = [0, 0, 0, 0];
    const tiltedSquared = [0, 0, 0, 0];
    const crossProduct = [0, 0, 0, 0];
    worlds.forEach((world, index) => {
      const goal = world.goal;
      if (!mass[goal]) return;
      const before = weights[index] / mass[goal];
      const after = tilted[index] / tiltedMass[goal];
      const multiplier = essMultiplier(world);
      beforeSquared[goal] += before * before * multiplier;
      tiltedSquared[goal] += after * after * multiplier;
      crossProduct[goal] += before * after * multiplier;
    });

    // How far each goal moves towards the tilted weights: all the way, unless
    // that would leave fewer effective worlds than the guard allows.
    const blends = mass.map((goalMass, goal) => {
      if (!goalMass || !minEffective) return 1;
      const target = Math.min(minEffective, 1 / beforeSquared[goal]);
      if (1 / tiltedSquared[goal] >= target) return 1;
      // The blend at which the mixture has exactly `target` effective worlds.
      const a = tiltedSquared[goal] + beforeSquared[goal] - 2 * crossProduct[goal];
      const b = 2 * (crossProduct[goal] - beforeSquared[goal]);
      const c = beforeSquared[goal] - 1 / target;
      if (!(a > MIN_BLEND_CURVATURE)) return 0;
      return clamp((-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a), 0, 1);
    });

    const blendedSquared = [0, 0, 0, 0];
    const blended = worlds.map((world, index) => {
      const goal = world.goal;
      if (!mass[goal]) return 0;
      const before = weights[index] / mass[goal];
      const after = tilted[index] / tiltedMass[goal];
      const share = before + blends[goal] * (after - before);
      blendedSquared[goal] += share * share * essMultiplier(world);
      return mass[goal] * share;
    });
    return {
      weights: blended,
      goals: mass.map((goalMass, goal) => ({
        suit: IDS[goal],
        probability: goalMass,
        effectiveBefore: goalMass ? 1 / beforeSquared[goal] : null,
        effectiveAfter: goalMass ? 1 / blendedSquared[goal] : null,
        calibrationBlend: blends[goal],
      })),
    };
  }

  // ── Allocations of the hidden cards ────────────────────────────────────

  /* Dynamic program over suit allocations. It integrates ALL feasible allocations,
     rather than assuming the Monte Carlo sample gives the structural goal odds.

     `remaining` are the cards of each suit not in your hand, `lower` the fewest
     of each suit every hidden hand holds, and `size` the hand size. Suits are
     dealt out one at a time; `caps` are the cards each hand can still take. */
  function allocationDP(remaining, lower, size) {
    const handCount = lower.length;
    const lastSuit = SUIT_COUNT - 1;
    const memo = new Map();
    const drawCache = new Map();
    // For each hand, the cards it must still receive from a suit onwards.
    const stillOwed = lower.map((row) => [0, 1, 2, 3, 4].map((suit) => sum(row.slice(suit))));
    const stateKey = (suit, caps) => suit + ':' + caps.join(',');

    // The number of ways to deal one suit so that each hand gets its count.
    const ways = (counts) => {
      let left = sum(counts);
      let result = 1;
      for (let hand = 0; hand < counts.length - 1; hand++) {
        result *= choose(left, counts[hand]);
        left -= counts[hand];
      }
      return result;
    };

    // Every way to deal out one suit, with the weight of all that can follow.
    function transitions(suit, caps) {
      const result = [];
      const row = Array(handCount).fill(0);
      function deal(hand, left) {
        const room = caps[hand] - stillOwed[hand][suit + 1];
        if (hand === handCount - 1) {
          row[hand] = left;
          if (left < lower[hand][suit] || left > room) return;
          const next = caps.map((cap, index) => cap - row[index]);
          if (next.some((cap) => cap < 0)) return;
          const tail = mass(suit + 1, next);
          if (tail > 0) result.push({ row: row.slice(), next, weight: ways(row) * tail });
          return;
        }
        const most = Math.min(left, room);
        for (let count = lower[hand][suit]; count <= most; count++) {
          row[hand] = count;
          deal(hand + 1, left - count);
        }
      }
      deal(0, remaining[suit]);
      return result;
    }

    // The number of ways to deal out this suit and every later one.
    function mass(suit, caps) {
      if (caps.some((cap, hand) => cap < stillOwed[hand][suit])) return 0;
      if (suit === SUIT_COUNT) return caps.every((cap) => cap === 0) ? 1 : 0;
      if (suit === lastSuit) {
        const fits =
          sum(caps) === remaining[lastSuit] &&
          caps.every((cap, hand) => cap >= lower[hand][lastSuit]);
        return fits ? ways(caps) : 0;
      }
      const key = stateKey(suit, caps);
      if (memo.has(key)) return memo.get(key);
      const total = sum(transitions(suit, caps).map((transition) => transition.weight));
      memo.set(key, total);
      return total;
    }

    const initialCaps = Array(handCount).fill(size);
    const total = mass(0, initialCaps);

    // Draws one allocation in proportion to its weight. `firstChoice` fixes how
    // the first suit is dealt.
    function sample(random, firstChoice = null) {
      const hands = Array.from({ length: handCount }, () => [0, 0, 0, 0]);
      let caps = initialCaps.slice();
      for (let suit = 0; suit < lastSuit; suit++) {
        let selected = firstChoice && suit === 0 ? firstChoice : null;
        if (!selected) {
          const key = stateKey(suit, caps);
          let choices = drawCache.get(key);
          if (!choices) {
            choices = transitions(suit, caps);
            drawCache.set(key, choices);
          }
          let pick = random() * sum(choices.map((choice) => choice.weight));
          selected = choices.at(-1);
          for (const candidate of choices) {
            pick -= candidate.weight;
            if (pick <= 0) {
              selected = candidate;
              break;
            }
          }
        }
        if (!selected) throw Error('No feasible sampled allocation');
        selected.row.forEach((count, hand) => (hands[hand][suit] = count));
        caps = selected.next;
      }
      caps.forEach((count, hand) => (hands[hand][lastSuit] = count));
      return hands;
    }

    // The number of ways to deal the hidden hands with no constraint at all.
    let unconstrained = 1;
    let left = sum(remaining);
    for (let hand = 0; hand < handCount - 1; hand++) {
      unconstrained *= choose(left, size);
      left -= size;
    }
    return {
      mass: total / unconstrained,
      sample,
      states: memo.size,
      strata: () => transitions(0, initialCaps),
    };
  }

  // Splits a sampling budget over strata in proportion to their weight, with at
  // least one draw each. Leftover draws go to the largest remainders.
  function stratifiedCounts(strata, budget) {
    const count = Math.max(budget, strata.length);
    const mass = sum(strata.map((stratum) => stratum.weight));
    const remaining = count - strata.length;
    const share = (stratum) => (remaining * stratum.weight) / mass;
    const counts = strata.map((stratum) => 1 + Math.floor(share(stratum)));
    const remainders = strata
      .map((stratum, index) => ({ index, fraction: share(stratum) - Math.floor(share(stratum)) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    const leftover = count - sum(counts);
    for (let extra = 0; extra < leftover; extra++) counts[remainders[extra].index]++;
    return { counts, mass };
  }

  // What you are paid when the goal cards are held like this. You are seat 0.
  function payout(counts, bonus) {
    const most = Math.max(...counts);
    let leaders = 0;
    for (const count of counts) if (count === most) leaders++;
    return CHIPS_PER_GOAL_CARD * counts[0] + (counts[0] === most ? bonus / leaders : 0);
  }

  // ── What an opponent can know ──────────────────────────────────────────

  /* A second, deliberately separate information set for a hypothetical opponent.
     It never receives the viewer's dealt hand or the other hands of an outer
     inference world. Lower bounds are reconstructed at the action's public cut.
     Public goal probabilities integrate all feasible allocations by polynomial
     convolution; bonus ownership uses bounded conditional importance sampling. */

  const HYPERGEOMETRIC = [];

  // Draws how many of `draws` cards, taken from `total`, are among the
  // `successes` marked ones.
  function hypergeometricDraw(total, successes, draws, random) {
    if (!successes || !draws) return 0;
    if (successes === total) return draws;
    // Successes are at most 12 and draws at most a hand, so the key is unique.
    const key = (total * COUNT_BASE + successes) * (MAX_HAND_SIZE + 1) + draws;
    let table = HYPERGEOMETRIC[key];
    if (!table) {
      const low = Math.max(0, draws - (total - successes));
      const high = Math.min(draws, successes);
      const cdf = [];
      let mass = 0;
      for (let hits = low; hits <= high; hits++) {
        mass += choose(successes, hits) * choose(total - successes, draws - hits);
        cdf.push(mass);
      }
      table = { low, cdf, mass };
      HYPERGEOMETRIC[key] = table;
    }
    const pick = random() * table.mass;
    let index = 0;
    while (index < table.cdf.length - 1 && pick >= table.cdf[index]) index++;
    return table.low + index;
  }

  const PUBLIC_HAND_ROWS = new Map();

  // Every hand of `size` cards that holds at least `lower` of each suit, with
  // its packed index and the weight 1 / (product of its count factorials).
  function publicHandRows(size, lower) {
    const key = size + '|' + lower.join(',');
    if (PUBLIC_HAND_ROWS.has(key)) return PUBLIC_HAND_ROWS.get(key);
    const rows = [];
    for (let a = lower[0]; a <= size - lower[1] - lower[2] - lower[3]; a++) {
      for (let b = lower[1]; b <= size - a - lower[2] - lower[3]; b++) {
        for (let c = lower[2]; c <= size - a - b - lower[3]; c++) {
          const d = size - a - b - c;
          rows.push({
            a,
            b,
            c,
            d,
            index: packCounts(a, b, c),
            weight: Math.exp(
              -LOG_FACTORIAL[a] - LOG_FACTORIAL[b] - LOG_FACTORIAL[c] - LOG_FACTORIAL[d],
            ),
          });
        }
      }
    }
    PUBLIC_HAND_ROWS.set(key, rows);
    if (PUBLIC_HAND_ROWS.size > MAX_PUBLIC_HAND_ROWS) {
      PUBLIC_HAND_ROWS.delete(PUBLIC_HAND_ROWS.keys().next().value);
    }
    return rows;
  }

  // Integrate every legal unknown hand once per public-bound pattern. Coefficients
  // of the product of hand polynomials are sums of 1/prod(card-count factorials).
  // Legal decks all share 12!10!10!8!, so for a fixed private hand these exact
  // coefficients are proportional to the deck posterior. The fourth suit count
  // follows from the known total; only three coordinates need storage.
  function publicMassTable(size, lower) {
    let layer = new Float64Array(PUBLIC_TABLE_SIZE);
    layer[0] = 1;
    let active = [{ a: 0, b: 0, c: 0, d: 0, index: 0 }];
    for (const bound of lower) {
      const next = new Float64Array(PUBLIC_TABLE_SIZE);
      const nextActive = [];
      const rows = publicHandRows(size, bound);
      for (const partial of active) {
        const previous = layer[partial.index];
        for (const hand of rows) {
          const a = partial.a + hand.a;
          const b = partial.b + hand.b;
          const c = partial.c + hand.c;
          const d = partial.d + hand.d;
          if (
            a > LARGE_SUIT_SIZE ||
            b > LARGE_SUIT_SIZE ||
            c > LARGE_SUIT_SIZE ||
            d > LARGE_SUIT_SIZE
          ) {
            continue;
          }
          const index = partial.index + hand.index;
          if (!next[index]) nextActive.push({ a, b, c, d, index });
          next[index] += previous * hand.weight;
        }
      }
      layer = next;
      active = nextActive;
    }
    return layer;
  }

  // The index of a suit-count triple in a public mass table.
  const publicTableIndex = (counts) => packCounts(counts[0], counts[1], counts[2]);

  class OpponentKnowledge {
    constructor(options = {}) {
      this.samples = Math.max(
        MIN_OPPONENT_SAMPLES,
        Math.min(MAX_OPPONENT_SAMPLES, options.samples || DEFAULT_OPPONENT_SAMPLES),
      );
      this.maxEntries = options.maxEntries || MAX_OPPONENT_BELIEFS;
      this.cache = new Map();
      this.massCache = new Map();
      this.prefixCache = new Map();
      this.namespace = '';
      this.stats = { builds: 0, hits: 0, samples: 0, minEffective: Infinity };
    }

    // Reads the round's public history: the card flow and the sale floors
    // after each trade, and every ask that proves its owner held a card.
    prepare(snapshot, events) {
      const namespace = JSON.stringify([
        snapshot.roundKey,
        snapshot.players.map((player) => player.name),
      ]);
      if (namespace !== this.namespace) {
        this.cache.clear();
        this.massCache.clear();
        this.prefixCache.clear();
        this.namespace = namespace;
      }
      this.names = snapshot.players.map((player) => player.name);
      this.n = this.names.length;
      this.size = DECK_SIZE / this.n;
      this.events = events;
      this.trades = snapshot.trades;
      this.nets = [emptyFlow(this.names)];
      this.floors = [emptyFlow(this.names)];
      for (const trade of this.trades) {
        const net = this.nets.at(-1).map((row) => row.slice());
        const floor = this.floors.at(-1).map((row) => row.slice());
        const suit = IDS.indexOf(trade.suit);
        const seller = this.names.indexOf(trade.s);
        const buyer = this.names.indexOf(trade.b);
        if (suit < 0 || seller < 0 || buyer < 0) break;
        net[seller][suit]--;
        net[buyer][suit]++;
        floor[seller][suit] = Math.max(floor[seller][suit], -net[seller][suit]);
        this.nets.push(net);
        this.floors.push(floor);
      }
      this.asks = [];
      for (const event of events) {
        if (event.kind !== 'quote' || event.direction !== 'sell' || event.recovered) continue;
        const actor = this.names.indexOf(event.actor);
        const suit = IDS.indexOf(event.suit);
        const net = this.nets[event.epoch];
        const isUsable =
          actor >= 0 &&
          suit >= 0 &&
          net &&
          Number.isSafeInteger(event.price) &&
          event.price > 0 &&
          this.sameNet(event.net, net);
        if (!isUsable) continue;
        this.asks.push({ event, actor, suit, minimum: Math.max(0, 1 - net[actor][suit]) });
      }
      this.prefixCache.clear();
    }

    sameNet(a, b) {
      return (
        Array.isArray(a) &&
        a.length === b.length &&
        a.every(
          (row, seat) =>
            Array.isArray(row) &&
            row.length === SUIT_COUNT &&
            row.every((count, suit) => count === b[seat][suit]),
        )
      );
    }

    // True when event `a` was public before event `b` was decided.
    before(a, b) {
      if (a.epoch !== b.epoch) return a.epoch < b.epoch;
      if (b.passive === true || b.recovered) return false;
      // Quotes read in the same DOM observation have an arbitrary append order.
      // Their source sequence does not prove one was visible before the other.
      if (Number.isFinite(a.at) && a.at === b.at) return false;
      if (Number.isFinite(a.sourceSeq) && Number.isFinite(b.sourceSeq)) {
        return a.sourceSeq < b.sourceSeq;
      }
      return Number.isFinite(a.at) && Number.isFinite(b.at) && a.at < b.at;
    }

    // The public history an actor could see when deciding `event`, or all of
    // it when no event is given: the card flow and each player's lower bounds.
    prefix(event = null) {
      const epoch = event ? event.epoch : this.trades.length;
      const net = this.nets[epoch];
      if (!net || (event && !this.sameNet(event.net, net))) return null;
      const key = event
        ? JSON.stringify([
            epoch,
            event.sourceSeq ?? null,
            event.at ?? null,
            event.passive === true,
            event.recovered === true,
          ])
        : 'current';
      if (this.prefixCache.has(key)) return this.prefixCache.get(key);
      const lower = this.floors[epoch].map((row) => row.slice());
      for (const ask of this.asks) {
        if (!event || this.before(ask.event, event)) {
          lower[ask.actor][ask.suit] = Math.max(lower[ask.actor][ask.suit], ask.minimum);
        }
      }
      const value = { epoch, net, lower, key: lower.map((row) => row.join(',')).join(';') };
      this.prefixCache.set(key, value);
      return value;
    }

    // What an actor holding `initial` believes about the other hands, given a
    // public prefix. Returns the sampled belief and the seat order it uses, or
    // null when the hand contradicts the prefix.
    posterior(initial, actor, prefix, other = -1, buy = false, suit = -1) {
      const contradictsPrefix =
        !prefix || initial.some((count, index) => count < prefix.lower[actor][index]);
      if (contradictsPrefix) return null;
      let lower = prefix.lower;
      // Taking a named seller's offer discloses that one card is available now.
      // This is observable ownership, not the seller's hidden inventory quantity.
      if (buy && other >= 0 && other !== actor && suit >= 0) {
        const minimum = Math.max(0, 1 - prefix.net[other][suit]);
        if (minimum > lower[other][suit]) {
          lower = lower.map((row) => row.slice());
          lower[other][suit] = minimum;
        }
      }
      // An actor already knows their exact hand; changes in their own public floor
      // supply no new information and must not create another conditional pool.
      // Seat names do not affect deal probability. Canonical seat order shares a
      // conditional pool across actors while restoring actual identities at value
      // time. Equal-bound seats remain exchangeable, not known hidden hands.
      const byLowerBounds = (a, b) => {
        for (let index = 0; index < SUIT_COUNT; index++) {
          if (lower[a][index] !== lower[b][index]) return lower[a][index] - lower[b][index];
        }
        return a - b;
      };
      const others = indexes(this.names)
        .filter((seat) => seat !== actor)
        .sort(byLowerBounds);
      const order = [actor, ...others];
      const boundsKey = others.map((seat) => lower[seat].join(',')).join(';');
      const cacheKey = initial.join(',') + '|' + boundsKey;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.stats.hits++;
        // Moved to the end, so the least recently used belief is evicted first.
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return { pool: cached, order };
      }

      const caps = others.map((seat) => this.size - sum(lower[seat]));
      if (caps.some((cap) => cap < 0)) return null;
      const otherBounds = others.map((seat) => lower[seat]);
      const masses = this.publicMasses(this.size + '|' + boundsKey, otherBounds);
      const draws = sampleHiddenHands({
        initial,
        cacheKey,
        otherBounds,
        caps,
        masses,
        samples: this.samples,
      });
      if (!draws.logWeights.length) return null;

      const pool = normalizedBelief(draws);
      this.cache.set(cacheKey, pool);
      this.stats.builds++;
      this.stats.samples += draws.logWeights.length;
      this.stats.minEffective = Math.min(this.stats.minEffective, pool.effective);
      if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
      return { pool, order };
    }

    // The exact table of public deal masses for one pattern of lower bounds.
    publicMasses(key, otherBounds) {
      let masses = this.massCache.get(key);
      if (!masses) {
        masses = publicMassTable(this.size, otherBounds);
        this.massCache.set(key, masses);
        if (this.massCache.size > MAX_PUBLIC_TABLES) {
          this.massCache.delete(this.massCache.keys().next().value);
        }
      }
      return masses;
    }

    // What trading one card of a suit is worth to an actor holding `initial`,
    // as that actor could judge it when deciding `event`: 10 chips times the
    // goal probability, plus the change in the actor's expected bonus.
    value(initial, actor, event = null, options = {}) {
      const prefix = options.prefix || this.prefix(event);
      const suit = options.suit ?? IDS.indexOf(event?.suit);
      const buy = options.buy ?? event?.direction === 'buy';
      const other = this.knownCounterparty(actor, event, options);
      const posterior = this.posterior(initial, actor, prefix, other, buy, suit);
      if (!posterior || suit < 0) return null;
      const { pool: belief, order } = posterior;
      const peerIndex = order.indexOf(other);
      const key =
        suit +
        '|' +
        Number(buy) +
        '|' +
        peerIndex +
        '|' +
        order.map((seat) => prefix.net[seat][suit]).join(',');
      if (belief.values.has(key)) return belief.values.get(key);

      const goalProbability = belief.probabilities[suit];
      let bonus = 0;
      for (let index = 0; index < belief.weights.length; index++) {
        if (belief.goals[index] !== suit) continue;
        const counts = order.map(
          (seat, position) =>
            ((belief.packed[index] >>> (COUNT_BITS * position)) & COUNT_MASK) +
            prefix.net[seat][suit],
        );
        if (!buy && counts[0] < 1) continue;
        const before = this.share(counts, 0, belief.bonuses[index]);
        // Without a known counterparty, the card is equally likely to come
        // from, or go to, any other seat that can trade it.
        const peers =
          peerIndex >= 0
            ? [peerIndex]
            : indexes(order).filter((position) => position !== 0 && (!buy || counts[position] > 0));
        let change = 0;
        let peerCount = 0;
        for (const peer of peers) {
          if (buy && counts[peer] < 1) continue;
          counts[0] += buy ? 1 : -1;
          counts[peer] += buy ? -1 : 1;
          const after = this.share(counts, 0, belief.bonuses[index]);
          counts[0] += buy ? -1 : 1;
          counts[peer] += buy ? 1 : -1;
          change += buy ? after - before : before - after;
          peerCount++;
        }
        if (peerCount) bonus += (belief.weights[index] * change) / peerCount;
      }
      const result = {
        base: CHIPS_PER_GOAL_CARD * goalProbability,
        bonus,
        total: CHIPS_PER_GOAL_CARD * goalProbability + bonus,
        probabilities: belief.probabilities,
        effective: belief.effective,
        knownCounterparty: other >= 0,
      };
      belief.values.set(key, result);
      if (belief.values.size > MAX_VALUES_PER_BELIEF) {
        belief.values.delete(belief.values.keys().next().value);
      }
      return result;
    }

    // The seat an actor knew they were trading with, or -1.
    knownCounterparty(actor, event, options) {
      let known = -1;
      if (options.counterparty !== undefined) {
        known = options.counterparty;
      } else if (event?.counterpartyKnownBeforeAction === true) {
        known = this.names.indexOf(event.counterparty);
      }
      return known >= 0 && known !== actor ? known : -1;
    }

    // An actor's share of the bonus when the goal cards are held like this.
    share(counts, actor, bonus) {
      const maximum = Math.max(...counts);
      if (counts[actor] !== maximum) return 0;
      return bonus / counts.filter((count) => count === maximum).length;
    }

    summary() {
      return {
        method: 'Exact causal public goal probabilities; sampled conditional bonus',
        goalMethod: 'Exact public-hand polynomial convolution',
        bonusMethod: 'Conditional importance sampling',
        approximate: true,
        samplesPerDeck: this.samples,
        cachedHands: this.cache.size,
        exactPublicTables: this.massCache.size,
        builds: this.stats.builds,
        cacheHits: this.stats.hits,
        minEffective: Number.isFinite(this.stats.minEffective) ? this.stats.minEffective : null,
      };
    }
  }

  // Samples the hands an actor cannot see, deck by deck. For each sample it
  // keeps every seat's goal-suit count packed into one integer (the actor's
  // in the low bits), the goal, the bonus pool and an importance log weight.
  function sampleHiddenHands({ initial, cacheKey, otherBounds, caps, masses, samples }) {
    const freeCards = sum(caps);
    const mandatory = IDS.map((_, suit) => sum(otherBounds.map((bounds) => bounds[suit])));
    const lastOther = otherBounds.length - 1;
    const draws = {
      packedValues: [],
      goalValues: [],
      bonusValues: [],
      logWeights: [],
      ranges: [],
      totalMass: 0,
    };
    for (let deckIndex = 0; deckIndex < DECKS.length; deckIndex++) {
      const config = DECKS[deckIndex];
      const remaining = config.deck.map((size, suit) => size - initial[suit]);
      const residual = remaining.map((count, suit) => count - mandatory[suit]);
      if (residual.some((count) => count < 0)) continue;
      const mass = masses[publicTableIndex(remaining)];
      if (!(mass > 0)) continue;
      const start = draws.logWeights.length;
      const random = rng(hash(cacheKey + '|' + deckIndex));
      draws.totalMass += mass;
      for (let sample = 0; sample < samples; sample++) {
        const left = residual.slice();
        let cardsLeft = freeCards;
        let logWeight = 0;
        let packed = initial[config.goal];
        for (let other = 0; other < otherBounds.length; other++) {
          let population = cardsLeft;
          let toDraw = caps[other];
          const bounds = otherBounds[other];
          for (let suit = 0; suit < SUIT_COUNT; suit++) {
            const available = left[suit];
            // The last hand takes what is left; a hand's last suit takes the rest.
            let drawn;
            if (other === lastOther) drawn = available;
            else if (suit === SUIT_COUNT - 1) drawn = toDraw;
            else drawn = hypergeometricDraw(population, available, toDraw, random);
            population -= available;
            toDraw -= drawn;
            left[suit] -= drawn;
            const count = bounds[suit] + drawn;
            logWeight += LOG_FACTORIAL[drawn] - LOG_FACTORIAL[count];
            if (suit === config.goal) packed |= count << ((other + 1) * COUNT_BITS);
          }
          cardsLeft -= caps[other];
        }
        draws.packedValues.push(packed);
        draws.goalValues.push(config.goal);
        draws.bonusValues.push(bonusPool(config));
        draws.logWeights.push(logWeight);
      }
      draws.ranges.push({ start, end: draws.logWeights.length, mass });
    }
    return draws;
  }

  // Turns the samples into a weighted belief. Each deck's samples share that
  // deck's exact public mass.
  function normalizedBelief({
    packedValues,
    goalValues,
    bonusValues,
    logWeights,
    ranges,
    totalMass,
  }) {
    const probabilities = [0, 0, 0, 0];
    const packed = Uint32Array.from(packedValues);
    const goals = Uint8Array.from(goalValues);
    const bonuses = Uint8Array.from(bonusValues);
    const weights = new Float64Array(logWeights.length);
    let squaredWeights = 0;
    for (const range of ranges) {
      const normalizer = logsumexp(logWeights.slice(range.start, range.end));
      for (let index = range.start; index < range.end; index++) {
        const weight = (range.mass / totalMass) * Math.exp(logWeights[index] - normalizer);
        weights[index] = weight;
        probabilities[goals[index]] += weight;
        squaredWeights += weight * weight;
      }
    }
    return {
      probabilities,
      packed,
      goals,
      bonuses,
      weights,
      effective: 1 / squaredWeights,
      values: new Map(),
    };
  }

  // ── How an opponent's actions read ─────────────────────────────────────

  // How much one piece of evidence counts under a signal policy.
  function evidenceStrength(event, signals) {
    if (event.kind === 'take') {
      return event.recovered ? RECOVERED_TAKE_WEIGHT : (event.confidence ?? 1);
    }
    if (event.kind === 'consent') return signals.consent;
    return event.recovered ? RECOVERED_QUOTE_WEIGHT : signals.quote;
  }

  const priceScale = (style) => (style === STYLE_LIQUIDITY ? LIQUIDITY_PRICE_SCALE : PRICE_SCALE);

  // The price at which an actor holding `initial` would be indifferent to
  // trading one card of a suit, under one behavior family. The value and bonus
  // families use what the actor can know; liquidity follows the last price.
  function reservation(initial, actor, suit, context, style) {
    if (context.knowledge && style !== STYLE_LIQUIDITY) {
      const value = context.knowledge.value(initial, actor, context.event, {
        prefix: context.prefix,
        suit,
        buy: context.buy,
        counterparty: context.counterparty,
      });
      if (value) return style === STYLE_BONUS ? value.total : value.base;
    }
    const belief = privateBelief(initial);
    const goalProbability = belief.goals[suit];
    const net = context.net || [];
    const held = initial[suit] + (net[actor]?.[suit] || 0);
    const playerCount = context.names?.length || 4;
    const estimatedMax = Math.max(
      0,
      ...Array.from({ length: playerCount }, (_, seat) =>
        seat === actor
          ? 0
          : (belief.counts[suit] - initial[suit]) / (playerCount - 1) + (net[seat]?.[suit] || 0),
      ),
    );
    const lead = Math.exp(-0.5 * ((held - estimatedMax) / LEAD_WIDTH_CARDS) ** 2);
    if (style === STYLE_LIQUIDITY) {
      const anchor = Math.max(1, context.anchor || DEFAULT_ANCHOR_PRICE);
      return anchor - SHADING_PER_CARD * (held - NEUTRAL_HOLDING);
    }
    const bonus =
      style === STYLE_BONUS
        ? (ASSUMED_BONUS_CHIPS * goalProbability * lead) / (playerCount - 1)
        : 0;
    return CHIPS_PER_GOAL_CARD * goalProbability + bonus;
  }

  // The log likelihood of one observed action under each behavior family, for
  // an actor holding `initial`.
  function eventLogs(initial, actor, event, context) {
    const suit = IDS.indexOf(event.suit);
    if (suit < 0) return [0, 0, 0, 0];
    const buy = event.direction === 'buy';
    const held = initial[suit] + (event.net?.[actor]?.[suit] || 0);
    const price = event.price;
    const isQuote = event.kind !== 'take' && event.kind !== 'consent';
    const eventContext = { ...context, net: event.net, anchor: event.anchor, event, buy };
    const logs = [];
    for (let style = 0; style < STYLE_NAMES.length; style++) {
      if (style === STYLE_NOISE) {
        logs.push(Math.log(event.kind === 'quote' ? 1 / QUOTE_PRICE_LEVELS : NOISE_ACCEPTANCE));
        continue;
      }
      const value = reservation(initial, actor, suit, eventContext, style);
      const scale = priceScale(style);
      const edge = buy ? value - price : price - value;
      let likelihood = isQuote
        ? quoteLikelihood(price, value, buy, scale)
        : ACCEPT_FLOOR + ACCEPT_RANGE * sigmoid(edge / scale);
      if (!buy && held < 1) likelihood *= SHORT_SALE_PENALTY;
      logs.push(Math.log(Math.max(MIN_LIKELIHOOD, likelihood)));
    }
    return logs;
  }

  // The likelihood of resting a quote at exactly this price: the logistic mass
  // of the one-chip interval around it, centered a margin inside the quoter's
  // value and normalized over positive prices.
  function quoteLikelihood(price, value, buy, scale) {
    const center = value + (buy ? -QUOTE_MARGIN : QUOTE_MARGIN);
    const upper = sigmoid((price + 0.5 - center) / scale);
    const lower = sigmoid((price - 0.5 - center) / scale);
    const normalizer = 1 - sigmoid((0.5 - center) / scale);
    const density = (upper - lower) / Math.max(MIN_QUOTE_NORMALIZER, normalizer);
    return (
      QUOTE_NOISE_SHARE / QUOTE_PRICE_LEVELS +
      QUOTE_SIGNAL_SHARE * Math.max(MIN_QUOTE_DENSITY, density)
    );
  }

  // Picks the evidence the model reads from everything recorded.
  function chooseEvidence(events, self, options = {}) {
    // Repeated pennies replace ONE quote episode. Our own choices never vote for
    // their own goal hypothesis. Absence, outbidding and forced resets are not sells.
    const episodes = new Map();
    for (const event of events) {
      const isEvidence =
        ['quote', 'take', 'consent'].includes(event.kind) &&
        event.actor !== self &&
        Number.isFinite(event.price) &&
        event.suit;
      if (!isEvidence) continue;
      const id = [event.epoch, event.actor, event.suit, event.direction].join('|');
      if (supersedes(event, episodes.get(id))) episodes.set(id, event);
    }
    const byActor = new Map();
    for (const event of episodes.values()) {
      if (!byActor.has(event.actor)) byActor.set(event.actor, []);
      byActor.get(event.actor).push(event);
    }
    const chosen = [];
    for (const episodeList of byActor.values()) {
      const sorted = episodeList.sort((a, b) => a.at - b.at);
      const opening = options.recentOnly ? [] : sorted.slice(0, OPENING_EPISODES);
      const latest = sorted.slice(options.recentOnly ? -RECENT_ONLY_EPISODES : -LATEST_EPISODES);
      for (const event of new Set([...opening, ...latest])) chosen.push(event);
    }
    return chosen;
  }

  // True when an event replaces what its episode holds: a take always, an
  // active consent over a quote, and a quote that improves on the last one.
  function supersedes(event, current) {
    if (!current || event.kind === 'take') return true;
    if (current.kind !== 'quote') return false;
    if (event.kind === 'consent') return event.passive !== true;
    if (event.kind !== 'quote') return false;
    return event.direction === 'buy' ? event.price > current.price : event.price < current.price;
  }

  // The kind of table: all bots at one difficulty, all bots, or with humans.
  function tableGroup(snapshot) {
    const allBots = snapshot.players.every(
      (player) => player.name === snapshot.self || /^Bot-/.test(player.name),
    );
    if (!allBots) return { allBots, group: 'mixed' };
    const difficulty = snapshot.context?.botDifficulty;
    return { allBots, group: 'bots' + (difficulty ? ':' + difficulty : '') };
  }

  // ── Settling the sampled worlds ────────────────────────────────────────

  // Adds up, over the weighted worlds, what your current hand would be paid
  // and what one card moved to or from each opponent would change. Also stores
  // on each world the change in your payout from buying a goal card from, or
  // selling one to, each opponent.
  function settleWorlds({ snapshot, state, worlds, weights, behavior, stylesByWorld }) {
    const counterpartyTotals = () => {
      const byName = {};
      for (const name of state.names.slice(1)) {
        byName[name] = { mass: 0, buyValue: 0, sellValue: 0, buyBaseValue: 0 };
      }
      return byName;
    };
    const totals = {
      structural: [0, 0, 0, 0],
      raw: [0, 0, 0, 0],
      goals: [0, 0, 0, 0],
      stylePosterior: state.names.map(() => [0, 0, 0, 0]),
      expectedPayout: 0,
      leaderProbability: 0,
      suits: IDS.map(() => ({
        holding: 0,
        leaderMass: 0,
        soloMass: 0,
        tieMass: 0,
        payoutFloor: Infinity,
        counterparties: counterpartyTotals(),
      })),
    };
    for (let index = 0; index < worlds.length; index++) {
      const world = worlds[index];
      const weight = weights[index];
      const goal = world.goal;
      const goalTotals = totals.suits[goal];
      totals.structural[goal] += world.base;
      totals.raw[goal] += behavior[index];
      totals.goals[goal] += weight;

      const counts = world.initial.map((hand, seat) => hand[goal] + state.net[seat][goal]);
      const most = Math.max(...counts);
      const leaders = counts.reduce((total, count) => total + Number(count === most), 0);
      const leads = counts[0] === most;
      const before = CHIPS_PER_GOAL_CARD * counts[0] + (leads ? world.bonus / leaders : 0);
      world.buyDelta = [];
      world.sellDelta = [];
      for (let actor = 1; actor < state.n; actor++) {
        const after = counts.slice();
        after[0]++;
        after[actor]--;
        world.buyDelta[actor] = payout(after, world.bonus) - before;
        after[0] -= 2;
        after[actor] += 2;
        world.sellDelta[actor] = before - payout(after, world.bonus);
      }
      totals.expectedPayout += weight * before;
      if (leads) totals.leaderProbability += weight;
      goalTotals.holding += weight * before;
      if (leads) {
        goalTotals.leaderMass += weight;
        if (leaders === 1) goalTotals.soloMass += weight;
        else goalTotals.tieMass += weight;
      }
      // This floor follows from deck size, not from the finite sampled worlds.
      // Five of ten guarantees half the bonus; six guarantees the entire bonus.
      const otherCards = (POT_CHIPS - world.bonus) / CHIPS_PER_GOAL_CARD - counts[0];
      let guaranteedBonus = 0;
      if (counts[0] > otherCards) guaranteedBonus = world.bonus;
      else if (counts[0] === otherCards) guaranteedBonus = world.bonus / 2;
      goalTotals.payoutFloor = Math.min(
        goalTotals.payoutFloor,
        CHIPS_PER_GOAL_CARD * counts[0] + guaranteedBonus,
      );

      for (let actor = 1; actor < state.n; actor++) {
        const styles = stylesByWorld[index][actor];
        styles.forEach((share, style) => (totals.stylePosterior[actor][style] += weight * share));
        for (let suit = 0; suit < SUIT_COUNT; suit++) {
          const item = totals.suits[suit].counterparties[state.names[actor]];
          if (world.initial[actor][suit] + state.net[actor][suit] > 0) {
            item.mass += weight;
            if (goal === suit) {
              item.buyValue += weight * world.buyDelta[actor];
              item.buyBaseValue += weight * CHIPS_PER_GOAL_CARD;
            }
          }
          if (snapshot.held[suit] > 0 && goal === suit) {
            item.sellValue += weight * world.sellDelta[actor];
          }
        }
      }
    }
    return totals;
  }

  // One suit's estimates: its goal probability, your payout if it is the goal,
  // and the value of buying a card from, or selling one to, each opponent.
  function suitEstimate(suit, totals, snapshot, handOdds) {
    const goalProbability = totals.goals[suit];
    const suitTotals = totals.suits[suit];
    const held = snapshot.held[suit];
    // Estimates given that this suit is the goal exist only if it can be.
    const ifGoal = (value) => (goalProbability > 0 ? value : null);
    const shareOfGoal = (mass) => clamp(mass / goalProbability, 0, 1);
    const conditionalPayout = ifGoal(suitTotals.holding / goalProbability);

    const counterparties = {};
    for (const [name, item] of Object.entries(suitTotals.counterparties)) {
      const buy = item.mass ? item.buyValue / item.mass : null;
      const buyBase = item.mass ? item.buyBaseValue / item.mass : null;
      const sellBase = held > 0 ? CHIPS_PER_GOAL_CARD * goalProbability : 0;
      counterparties[name] = {
        buy,
        buyBase,
        buyBonus: buy === null ? null : buy - buyBase,
        sell: item.sellValue,
        sellBase,
        sellBonus: item.sellValue - sellBase,
        hasCardProbability: item.mass,
      };
    }
    // The headline values are against whoever owns the best quote now.
    const seller = counterparties[snapshot.markets[suit].seller];
    const buyer = counterparties[snapshot.markets[suit].buyer];
    return {
      probability: goalProbability,
      base: CHIPS_PER_GOAL_CARD * goalProbability,
      buy: seller?.buy ?? null,
      sell: buyer?.sell ?? null,
      holding: suitTotals.holding,
      conditionalPayout,
      conditionalBonus: ifGoal(Math.max(0, conditionalPayout - CHIPS_PER_GOAL_CARD * held)),
      conditionalLeaderProbability: ifGoal(shareOfGoal(suitTotals.leaderMass)),
      conditionalSoloProbability: ifGoal(shareOfGoal(suitTotals.soloMass)),
      conditionalTieProbability: ifGoal(shareOfGoal(suitTotals.tieMass)),
      conditionalNoBonusProbability: ifGoal(
        clamp(1 - suitTotals.leaderMass / goalProbability, 0, 1),
      ),
      conditionalBasePayout: ifGoal(CHIPS_PER_GOAL_CARD * held),
      conditionalPayoutFloor: ifGoal(suitTotals.payoutFloor),
      counterparties,
      structuralProbability: totals.structural[suit],
      behaviorProbability: totals.raw[suit],
      handProbability: handOdds[suit],
      buyBase: seller?.buyBase ?? null,
      buyBonus: seller?.buyBonus ?? null,
      sellBase: buyer?.sellBase ?? null,
      sellBonus: buyer?.sellBonus ?? null,
    };
  }

  // ── Pricing a resting quote ────────────────────────────────────────────

  // The price a quote of yours would rest at: the price it has, your draft,
  // or one chip better than the current best.
  function restingPrice(market, side, draft, actual) {
    if (actual) return market[side];
    if (isDraftPrice(draft)) return draft;
    if (side === 'bid') return Number.isFinite(market.bid) ? market.bid + 1 : null;
    return Number.isFinite(market.ask) ? market.ask - 1 : null;
  }

  const isDraftPrice = (draft) => Number.isSafeInteger(draft) && draft > 0;

  // True when you could have this quote resting at the top of the book.
  function canRest({ snapshot, market, suit, side, price, draft, actual }) {
    const buy = side === 'bid';
    const owner = market[buy ? 'buyer' : 'seller'];
    const cannotAfford = buy ? snapshot.cash < price : snapshot.held[suit] < 1;
    if (actual) return owner === snapshot.self && Number.isFinite(price) && !cannotAfford;

    const custom = isDraftPrice(draft);
    let allowed;
    if (custom) allowed = buy ? market.canBid : market.canOffer;
    else allowed = buy ? market.canRaiseBid : market.canLowerAsk;
    if (!allowed || !Number.isSafeInteger(price) || price < 1 || cannotAfford) return false;
    // A quote behind the current best never becomes top during this horizon.
    // Treat it as unavailable rather than borrowing a top-of-book fill rate.
    if (custom && Number.isFinite(market[side])) {
      const behindBest = buy ? price < market.bid : price > market.ask;
      const joinsAnothersQuote = price === market[side] && owner !== snapshot.self;
      if (behindBest || joinsAnothersQuote) return false;
    }
    return true;
  }

  // The chance an opponent with this hand and style mix takes your quote of
  // one card at `price`. The opponent is on the other side and knows it is you.
  function acceptance({ styles, hand, actor, suit, market, buy, price, nowContext }) {
    const midpoint =
      market.bid && market.ask ? (market.bid + market.ask) / 2 : DEFAULT_ANCHOR_PRICE;
    const context = {
      ...nowContext,
      buy: !buy,
      counterparty: 0,
      anchor: market.fills.at(-1)?.p || midpoint,
    };
    let willing = 0;
    for (let style = 0; style < STYLE_NAMES.length; style++) {
      if (style === STYLE_NOISE) {
        willing += styles[style] * NOISE_ACCEPTANCE;
        continue;
      }
      const value = reservation(hand, actor, suit, context, style);
      willing += styles[style] * sigmoid((buy ? price - value : value - price) / priceScale(style));
    }
    return willing;
  }

  // Values one quote of yours resting at the top of a market: the chance it
  // fills within the horizon, and what a fill is worth by who takes it.
  function restingQuoteValue(quote, worlds, weights, stylesByWorld) {
    const { snapshot, state, learning, nowContext, market, suit, side, price } = quote;
    const buy = side === 'bid';
    const horizon = FILL_HORIZON_SECONDS;
    // Competing hazards per second: a fill, being outbid, a book reset.
    const rates = learning.rates?.[side] || {};
    const exposure = rates.exposure || 0;
    const baseFill = (1 + (rates.fills || 0)) / (FILL_PRIOR_SECONDS + exposure);
    const outbid = (1 + (rates.outbids || 0)) / (OUTBID_PRIOR_SECONDS + exposure);
    const reset =
      (1 + (learning.rates?.resets || 0)) /
      (RESET_PRIOR_SECONDS + (learning.rates?.liveSeconds || 0));

    // An opponent's acceptance depends on their hand, not on the rest of the world.
    const acceptanceByHand = state.names.map(() => new Map());
    let pFill = 0;
    let ev = 0;
    let baseEv = 0;
    const parties = state.names.map(() => ({ mass: 0, value: 0 }));
    for (let index = 0; index < worlds.length; index++) {
      const world = worlds[index];
      const hazards = [];
      let total = 0;
      for (let actor = 1; actor < state.n; actor++) {
        const held = world.initial[actor][suit] + state.net[actor][suit];
        const cash = snapshot.players[actor].cash;
        if ((buy && held < 1) || (!buy && cash < price)) {
          hazards[actor] = 0;
          continue;
        }
        const code = world.codes[actor];
        let willing = acceptanceByHand[actor].get(code);
        if (willing === undefined) {
          const styles = stylesByWorld[index][actor];
          const hand = world.initial[actor];
          willing = acceptance({ styles, hand, actor, suit, market, buy, price, nowContext });
          acceptanceByHand[actor].set(code, willing);
        }
        const intensity = (baseFill * FILL_INTENSITY_SCALE * willing) / (state.n - 1);
        hazards[actor] = intensity;
        total += intensity;
      }
      if (!total) continue;
      const competing = total + outbid + reset;
      const fill = (total / competing) * (1 - Math.exp(-competing * horizon));
      pFill += weights[index] * fill;
      const isGoal = world.goal === suit;
      const baseValue = isGoal ? CHIPS_PER_GOAL_CARD : 0;
      for (let actor = 1; actor < state.n; actor++) {
        if (!hazards[actor]) continue;
        const mass = (weights[index] * fill * hazards[actor]) / total;
        const payoutChange = buy ? world.buyDelta[actor] : world.sellDelta[actor];
        const cardValue = isGoal ? payoutChange : 0;
        const value = buy ? cardValue - price : price - cardValue;
        ev += mass * value;
        baseEv += mass * (buy ? baseValue - price : price - baseValue);
        parties[actor].mass += mass;
        parties[actor].value += mass * value;
      }
    }
    return {
      price,
      horizon,
      pFill,
      ev,
      conditionalEdge: pFill ? ev / pFill : null,
      conditionalBaseEdge: pFill ? baseEv / pFill : null,
      conditionalBonusEdge: pFill ? (ev - baseEv) / pFill : null,
      provisional: learning.fillCalibrationValidated !== true,
      observedFills: rates.fills || 0,
      exposureSeconds: exposure,
      scope: 'Before reset, losing top of book, or 10 seconds; no automatic cancellation',
      counterparties: state.names.slice(1).map((name, other) => {
        const party = parties[other + 1];
        return {
          name,
          probability: pFill ? party.mass / pFill : 0,
          conditionalEdge: party.mass ? party.value / party.mass : null,
        };
      }),
    };
  }

  // ── Engine ─────────────────────────────────────────────────────────────

  class BeliefEngine {
    constructor(options = {}) {
      this.samples = options.samples || DEFAULT_SAMPLES;
      this.goalStratified = options.goalStratified !== false;
      this.referenceEss = options.referenceEss !== false;
      this.pool = null;
      this.poolKey = '';
      this.rebuilds = 0;
      this.signalPolicy = options.signalPolicy;
      this.goalCalibration = givenGoalCalibration(options.goalCalibration);
      this.skipPricing = options.skipPricing === true;
      this.eventLogCache = new Map();
      this.opponentLearning = options.opponentLearning !== false;
      this.knowledge = this.opponentLearning
        ? new OpponentKnowledge({ samples: options.opponentSamples })
        : null;
    }

    // Samples the hidden-hand worlds consistent with the deal's public facts.
    // The pool is kept until those facts change.
    build(snapshot, events = []) {
      const state = physical(snapshot);
      const inventoryEvidence = askInventoryConstraints(snapshot, state, events);
      this.inventoryEvidence = inventoryEvidence;
      const key = JSON.stringify([state.names, state.hand, state.minimum]);
      if (this.poolKey === key) {
        this.state = state;
        return;
      }
      const configurations = [];
      const worlds = [];
      const handOdds = [0, 0, 0, 0];
      let handTotal = 0;
      let total = 0;
      for (const config of DECKS) {
        // The probability of this deck and of being dealt your hand from it.
        const handMass =
          handWays(config.deck, state.hand) / choose(DECK_SIZE, state.size) / DECKS.length;
        handOdds[config.goal] += handMass;
        handTotal += handMass;
        if (!handMass) continue;
        const remaining = config.deck.map((size, suit) => size - state.hand[suit]);
        if (remaining.some((count) => count < 0)) continue;
        // Dealing the goal suit first makes each stratum one goal-suit split.
        const order = this.goalStratified
          ? [config.goal, ...indexes(IDS).filter((suit) => suit !== config.goal)]
          : [0, 1, 2, 3];
        const allocation = allocationDP(
          order.map((suit) => remaining[suit]),
          state.minimum.slice(1).map((row) => order.map((suit) => row[suit])),
          state.size,
        );
        const mass = handMass * allocation.mass;
        if (!(mass > 0)) continue;
        configurations.push({ ...config, mass });
        total += mass;
        const random = rng(hash(key + '|' + config.deck.join(',')));
        const count =
          state.n === 5
            ? Math.max(FIVE_PLAYER_MIN_SAMPLES, Math.floor(this.samples * FIVE_PLAYER_SAMPLE_SHARE))
            : this.samples;
        const sampled = this.goalStratified
          ? stratifiedWorlds({ state, config, order, allocation, mass, count, random })
          : plainWorlds({ state, config, allocation, mass, count, random });
        for (const world of sampled) worlds.push(world);
      }
      if (!total) {
        if (inventoryEvidence.tightenedBounds) {
          this.build(snapshot, []);
          this.inventoryEvidence = {
            ...inventoryEvidence,
            fallback: true,
            reason: 'Ask constraints conflict; using executed trades only',
          };
          return;
        }
        throw Error('No legal deals satisfy the observed inventories');
      }
      for (const world of worlds) world.base /= total;
      this.pool = {
        worlds,
        configurations: configurations.map((configuration) => ({
          ...configuration,
          probability: configuration.mass / total,
        })),
        handOdds: handOdds.map((mass) => mass / handTotal),
        evidenceProbability: total / handTotal,
      };
      this.poolKey = key;
      this.state = state;
      this.rebuilds++;
    }

    // The model for one snapshot: goal probabilities, settlement estimates and
    // quote values. `events` is the journal's evidence; `learning` holds what
    // earlier rounds taught and the display options.
    infer(snapshot, events = [], learning = {}) {
      const started = performance.now();
      this.build(snapshot, events);
      const { worlds } = this.pool;
      const state = this.state;
      const { allBots, group } = tableGroup(snapshot);
      if (this.knowledge) this.knowledge.prepare(snapshot, events);
      const fit = MODEL_FITS[group];
      const recentOnly = fit?.evidenceWindow?.players === state.n;
      const evidence = chooseEvidence(events, snapshot.self, { recentOnly });
      const signalPolicy = this.signalPolicy || fit?.signals || DEFAULT_SIGNALS;
      const priors = stylePriors(state.names, learning, group, allBots);
      const { forceBaseline } = learning;
      const { behavior, stylesByWorld } = this.behaviorPosterior(evidence, signalPolicy, priors);

      // Behavior has no calibrated track record at installation. A physical mixture
      // preserves uncertainty instead of presenting assumed policies as learned fact.
      const groupMetrics = learning.groupMetrics?.[group];
      const calibrated = Boolean(fit?.prospectivelyValidated);
      const failed =
        (groupMetrics?.rounds || 0) >= GUARD_MIN_ROUNDS &&
        groupMetrics.opponentBrier > groupMetrics.baselineBrier + GUARD_BRIER_MARGIN;
      const recommendedBlend = failed ? GUARDED_BLEND : (fit?.blend ?? DEFAULT_BLEND);
      const blend = forceBaseline ? 0 : recommendedBlend;
      const mixed = worlds.map(
        (world, index) => (1 - blend) * world.base + blend * behavior[index],
      );
      const byInventory = this.calibrateInventory(mixed, fit, forceBaseline);
      const { inventoryCalibration } = byInventory;
      const { weights, calibratedScoring, goalCalibration } = this.calibrateGoals(
        byInventory.weights,
        inventoryCalibration,
        { fit, group, failed, recommendedBlend, behavior, forceBaseline },
      );

      const totals = settleWorlds({ snapshot, state, worlds, weights, behavior, stylesByWorld });
      const bySuit = IDS.map((_, suit) => suitEstimate(suit, totals, snapshot, this.pool.handOdds));
      const { structural, raw, expectedPayout } = totals;
      const expectedBase = sum(bySuit.map((suit, index) => suit.base * snapshot.held[index]));
      const effective = 1 / sum(weights.map((weight) => weight * weight));
      const model = {
        version: VERSION,
        inventoryEvidence: this.inventoryEvidence,
        inventoryCalibration,
        mode: forceBaseline ? 'Cards only' : 'Opponent',
        bySuit,
        expectedPayout,
        expectedBase,
        expectedBonus: expectedPayout - expectedBase,
        leaderProbability: totals.leaderProbability,
        stateCount: worlds.length,
        currentInventory: snapshot.held.slice(),
        net: state.net,
        minimum: state.minimum,
        scoringProbabilities:
          calibratedScoring ||
          structural.map(
            (probability, goal) =>
              (1 - recommendedBlend) * probability + recommendedBlend * raw[goal],
          ),
        baseline: { mode: 'Exact constraints', probabilities: structural },
        behavior: {
          probabilities: raw,
          blend,
          group,
          evidenceSelection: recentOnly ? 'latest24' : 'opening8-plus-latest16',
          signals: signalPolicy,
          validation: fit || null,
          observations: evidence.length,
          provisional: !calibrated || failed,
          styles: styleRows(state.names, (seat, style) => totals.stylePosterior[seat][style]),
        },
        metrics: learning.metrics || { rounds: 0 },
        bonusMetrics: learning.bonusGroupMetrics?.[group] || null,
        effectiveWorlds: effective,
        configurations: this.pool.configurations,
        evidenceProbability: this.pool.evidenceProbability,
      };
      if (goalCalibration) model.behavior.goalCalibration = goalCalibration;
      model.resting = this.skipPricing
        ? {}
        : this.resting(snapshot, worlds, weights, stylesByWorld, learning);
      model.actualBook = this.skipPricing
        ? {}
        : this.resting(snapshot, worlds, weights, stylesByWorld, learning, true);
      if (this.knowledge) model.behavior.opponentLearning = this.knowledge.summary();
      this.latest = { worlds, weights, stylesByWorld, names: state.names };
      model.computeMs = performance.now() - started;
      return model;
    }

    // Applies the fitted inventory calibration, where the table has one and
    // the display is not cards-only. Returns the weights and a description of
    // what was applied.
    calibrateInventory(weights, fit, forceBaseline) {
      const state = this.state;
      const inventoryFit =
        !forceBaseline && fit?.inventoryCalibration?.players === state.n
          ? fit.inventoryCalibration
          : null;
      const inventoryCalibration = {
        active: Boolean(inventoryFit),
        provisional: true,
        id: inventoryFit?.id || null,
      };
      if (!inventoryFit) return { weights, inventoryCalibration };
      const adjusted = inventoryWeights(
        this.pool.worlds,
        weights,
        state.net,
        inventoryFit.strength,
        inventoryFit.minEffective,
        this.goalStratified && this.referenceEss,
      );
      Object.assign(inventoryCalibration, {
        strength: inventoryFit.strength,
        goals: adjusted.goals,
      });
      return { weights: adjusted.weights, inventoryCalibration };
    }

    // Goal calibration preserves conditional hidden-hand distributions.
    // Payout and fill estimates consume the same reweighted worlds.
    //
    // Returns the weights, the goal probabilities the model scores itself on
    // (null outside the calibration's scope) and a description of the policy
    // (null when there is none).
    calibrateGoals(weights, inventoryCalibration, mixture) {
      const { fit, group, failed, recommendedBlend, behavior, forceBaseline } = mixture;
      const { worlds } = this.pool;
      const goalPolicy =
        this.goalCalibration === false ? null : this.goalCalibration || fit?.goalCalibration;
      if (!goalPolicy) return { weights, calibratedScoring: null, goalCalibration: null };

      const inScope = group === CALIBRATED_GROUP && this.state.n === CALIBRATED_PLAYERS;
      const eligible = inScope && !failed;
      const calibrationBlend = goalPolicy.kind === 'raw' ? 1 : recommendedBlend;
      const goalCalibration = {
        ...goalPolicy,
        eligible,
        active: eligible && !forceBaseline,
        blend: calibrationBlend,
        scope: 'Four-player Medium bots',
        reason: inactiveReason(inScope, failed, forceBaseline),
      };
      if (!eligible) return { weights, calibratedScoring: null, goalCalibration };

      if (!GOAL_SIGNAL) throw Error('Goal calibration dependency unavailable');
      const physicalMass = [0, 0, 0, 0];
      const behaviorMass = [0, 0, 0, 0];
      for (let index = 0; index < worlds.length; index++) {
        physicalMass[worlds[index].goal] += worlds[index].base;
        behaviorMass[worlds[index].goal] += behavior[index];
      }
      const calibratedScoring = GOAL_SIGNAL.targetProbabilities(
        physicalMass,
        behaviorMass,
        goalPolicy,
        calibrationBlend,
      );
      // A cards-only display still reports the calibrated scoring probabilities.
      if (forceBaseline) return { weights, calibratedScoring, goalCalibration };

      const reweighted = GOAL_SIGNAL.reweight(worlds, weights, calibratedScoring);
      if (inventoryCalibration.goals) {
        for (let goal = 0; goal < SUIT_COUNT; goal++) {
          inventoryCalibration.goals[goal].probability = calibratedScoring[goal];
        }
      }
      return { weights: reweighted, calibratedScoring, goalCalibration };
    }

    // The behavioral posterior over the sampled worlds: each world's weight
    // after the opponents' actions, and each opponent's style mix in it.
    behaviorPosterior(evidence, signalPolicy, priors) {
      const { worlds } = this.pool;
      const state = this.state;
      const context = { names: state.names, knowledge: this.knowledge };
      const actorEvidence = state.names.map((name) =>
        evidence.filter((event) => event.actor === name),
      );
      const logCaches = this.episodeLogCaches(evidence);
      // A hand is scored once per actor however many worlds deal it.
      const scored = state.names.map(() => new Map());
      const logWeights = [];
      const stylesByWorld = [];

      const scoreHand = (hand, code, actor) => {
        const logs = [0, 0, 0, 0];
        const observations = actorEvidence[actor];
        const weightTotal = sum(observations.map((event) => evidenceStrength(event, signalPolicy)));
        const cap = Math.min(1, signalPolicy.cap / Math.max(1, weightTotal));
        for (const event of observations) {
          const cache = logCaches.get(event);
          let eventLog = cache.get(code);
          if (!eventLog) {
            eventLog = eventLogs(hand, actor, event, context);
            cache.set(code, eventLog);
          }
          const strength = evidenceStrength(event, signalPolicy) * cap;
          for (let style = 0; style < STYLE_NAMES.length; style++) {
            logs[style] += strength * eventLog[style];
          }
        }
        const joint = logs.map((log, style) => log + priors[actor][style]);
        const normalizer = logsumexp(joint);
        return { score: normalizer, styles: joint.map((log) => Math.exp(log - normalizer)) };
      };

      for (const world of worlds) {
        let score = 0;
        const actorStyles = [];
        for (let actor = 1; actor < state.n; actor++) {
          const code = world.codes[actor];
          let stats = scored[actor].get(code);
          if (!stats) {
            stats = scoreHand(world.initial[actor], code, actor);
            scored[actor].set(code, stats);
          }
          score += stats.score;
          actorStyles[actor] = stats.styles;
        }
        logWeights.push(Math.log(world.base) + signalPolicy.temperature * score);
        stylesByWorld.push(actorStyles);
      }
      const normalizer = logsumexp(logWeights);
      const behavior = logWeights.map((logWeight) => Math.exp(logWeight - normalizer));
      return { behavior, stylesByWorld };
    }

    // Cache likelihoods of unchanged public episodes, never their posterior weights.
    // Keys include actor, inventory flow and price anchor; prune to current evidence.
    episodeLogCaches(evidence) {
      const names = this.state.names;
      const caches = new Map();
      const active = new Set();
      for (const event of evidence) {
        const actor = names.indexOf(event.actor);
        const prefix = this.knowledge?.prefix(event);
        const key = JSON.stringify([
          actor,
          event.kind,
          event.suit,
          event.direction,
          event.price,
          event.net,
          event.anchor,
          names,
          event.counterparty,
          event.counterpartyKnownBeforeAction,
          prefix?.key,
        ]);
        active.add(key);
        if (!this.eventLogCache.has(key)) this.eventLogCache.set(key, new Map());
        caches.set(event, this.eventLogCache.get(key));
      }
      for (const key of this.eventLogCache.keys()) {
        if (!active.has(key)) this.eventLogCache.delete(key);
      }
      return caches;
    }

    // Each opponent's style mix in the worlds where a suit is the goal, by the
    // latest inference.
    revealedStyles(goal) {
      if (!this.latest) return [];
      const { worlds, weights, stylesByWorld, names } = this.latest;
      const goalIndex = IDS.indexOf(goal);
      let mass = 0;
      const totals = names.map(() => [0, 0, 0, 0]);
      worlds.forEach((world, index) => {
        if (world.goal !== goalIndex) return;
        mass += weights[index];
        for (let actor = 1; actor < names.length; actor++) {
          stylesByWorld[index][actor].forEach(
            (share, style) => (totals[actor][style] += weights[index] * share),
          );
        }
      });
      if (!mass) return [];
      return styleRows(names, (seat, style) => totals[seat][style] / mass);
    }

    // Values a quote of yours on each side of each market. With `actual`, the
    // quotes you have resting now; otherwise your drafts, or one chip inside
    // the best quote.
    resting(snapshot, worlds, weights, stylesByWorld, learning, actual = false) {
      const state = this.state;
      const result = {};
      const nowContext = {
        names: state.names,
        net: state.net,
        knowledge: this.knowledge,
        prefix: this.knowledge?.prefix(),
      };
      for (let suit = 0; suit < SUIT_COUNT; suit++) {
        const market = snapshot.markets[suit];
        result[market.id] = {};
        for (const side of ['bid', 'ask']) {
          const draft = learning.quotePrices?.[market.id]?.[side];
          const price = restingPrice(market, side, draft, actual);
          if (!canRest({ snapshot, market, suit, side, price, draft, actual })) continue;
          const quote = { snapshot, state, learning, nowContext, market, suit, side, price };
          result[market.id][side] = restingQuoteValue(quote, worlds, weights, stylesByWorld);
        }
      }
      return result;
    }
  }

  // The goal calibration an engine was constructed with: false switches it
  // off, a policy replaces the fitted one, and anything else leaves the fit.
  function givenGoalCalibration(option) {
    if (option === false) return false;
    return option ? { ...option } : null;
  }

  // Why goal calibration is not applied, or null when it is.
  function inactiveReason(inScope, failed, forceBaseline) {
    if (!inScope) return 'outside scope';
    if (failed) return 'quality guard';
    return forceBaseline ? 'cards-only display' : null;
  }

  // The log prior over behavior families for each player: what was learned
  // about that player, else about the table's group, else the default.
  function stylePriors(names, learning, group, allBots) {
    return names.map((name) => {
      const prior =
        learning.stylePriors?.[name] ||
        learning.population?.[group] ||
        learning.population?.[allBots ? 'bots' : 'mixed'] ||
        DEFAULT_PRIOR;
      return prior.map((share) => Math.log(Math.max(MIN_STYLE_PRIOR, share)));
    });
  }

  // Each opponent's probability of every behavior family, by name.
  function styleRows(names, probability) {
    return names.slice(1).map((name, other) => ({
      name,
      probabilities: Object.fromEntries(
        STYLE_NAMES.map((styleName, style) => [styleName, probability(other + 1, style)]),
      ),
    }));
  }

  // Worlds for one deck, sampled within each split of the goal suit so that
  // every split is represented.
  function stratifiedWorlds({ state, config, order, allocation, mass, count, random }) {
    const worlds = [];
    const strata = allocation.strata();
    const budget = stratifiedCounts(strata, count);
    for (let index = 0; index < strata.length; index++) {
      const stratum = strata[index];
      const draws = budget.counts[index];
      for (let draw = 0; draw < draws; draw++) {
        const hidden = allocation.sample(random, stratum).map((row) => {
          // Back from the order the suits were dealt in to suit order.
          const hand = [];
          order.forEach((suit, position) => (hand[suit] = row[position]));
          return hand;
        });
        const initial = [state.hand.slice(), ...hidden];
        worlds.push({
          initial,
          codes: initial.map((hand) => hand.join(',')),
          goal: config.goal,
          bonus: bonusPool(config),
          base: (mass * stratum.weight) / budget.mass / draws,
          referenceEssMultiplier: draws / ((count * stratum.weight) / budget.mass),
        });
      }
    }
    return worlds;
  }

  // Worlds for one deck, sampled in proportion to their probability.
  function plainWorlds({ state, config, allocation, mass, count, random }) {
    const worlds = [];
    for (let draw = 0; draw < count; draw++) {
      const initial = [state.hand.slice(), ...allocation.sample(random)];
      worlds.push({
        initial,
        codes: initial.map((hand) => hand.join(',')),
        goal: config.goal,
        bonus: bonusPool(config),
        base: mass / count,
      });
    }
    return worlds;
  }

  scope.FiggieBelief = {
    VERSION,
    IDS,
    DECKS,
    STYLE_NAMES,
    DEFAULT_PRIOR,
    DEFAULT_SIGNALS,
    BeliefEngine,
    OpponentKnowledge,
    physical,
    allocationDP,
    privateBelief,
    chooseEvidence,
    eventLogs,
    hash,
    askInventoryConstraints,
    inventoryWeights,
  };
  if (typeof module !== 'undefined') module.exports = scope.FiggieBelief;
})(globalThis);
