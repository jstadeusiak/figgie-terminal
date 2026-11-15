/* Read-only accounting and stored-decision audit; no current-model replay or fit. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'outputs/hard-mode-review-2026-10-28');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
const P = require('../extension/pnl.js');
const rows = fs
  .readFileSync(path.join(dir, 'hard-round.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const m = rows.find((e) => e.kind === 'round_metadata');
const events = rows.filter((e) => e.roundId === m.id).sort((a, b) => a.seq - b.seq);
const s = m.snapshot;
const j = J.restore(m, events);
const result = m.revealed;
const goal = result.goal;
const gi = B.IDS.indexOf(goal);
const names = s.players.map((p) => p.name);
const ante = 200 / names.length;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const copy = (x) => JSON.parse(JSON.stringify(x));
const before = (seq, fn) => events.filter((e) => e.seq < seq && fn(e)).at(-1);
const fills = events.filter((e) => e.kind === 'fill');
const predictions = J.livePredictions(events);
assert.equal(result.verified, true);
assert.equal(result.source, 'official-round-rankings');
assert.equal(fills.length, s.trades.length);
const players = names.map((name) => {
  const p = {
    name,
    bySuit: Object.fromEntries(
      B.IDS.map((id) => [
        id,
        { buys: [], sales: [], spent: 0, received: 0, netCards: 0, netCash: 0 },
      ]),
    ),
  };
  for (const t of s.trades) {
    const v = p.bySuit[t.suit];
    if (t.b === name) {
      v.buys.push(t.p);
      v.spent += t.p;
      v.netCards++;
    }
    if (t.s === name) {
      v.sales.push(t.p);
      v.received += t.p;
      v.netCards--;
    }
  }
  for (const v of Object.values(p.bySuit)) v.netCash = v.received - v.spent;
  p.spent = sum(Object.values(p.bySuit).map((v) => v.spent));
  p.received = sum(Object.values(p.bySuit).map((v) => v.received));
  p.netCash = p.received - p.spent;
  p.pnl = result.profits[name];
  p.settlement = p.pnl - p.netCash + ante;
  return p;
});
assert.equal(sum(players.map((p) => p.netCash)), 0);
assert.equal(sum(players.map((p) => p.settlement)), 200);
assert.equal(sum(players.map((p) => p.pnl)), 0);
const commands = events
  .filter((e) => e.kind === 'command_attempt')
  .map((e, i, all) => {
    const end = all.slice(i + 1).find((x) => x.commandId === e.commandId)?.seq ?? Infinity;
    const related = events.filter(
      (x) => x.seq > e.seq && x.seq < end && x.commandId === e.commandId,
    );
    return {
      ...e,
      submitted: related.some((x) => x.kind === 'command_submitted'),
      rejected: related.some((x) => x.kind === 'command_rejected'),
      outcomes: related
        .filter((x) => x.kind === 'order_outcome')
        .map((x) => ({ seq: x.seq, state: x.state, message: x.message })),
    };
  });
const ownTrades = [];
const used = new Set();
let ownHeld = s.startingHand.slice();
let ownCash = 0;
for (const f of fills) {
  const t = f.trade;
  if (t.b !== s.self && t.s !== s.self) continue;
  const side = t.b === s.self ? 'buy' : 'sell';
  const k = B.IDS.indexOf(t.suit);
  const kinds = side === 'buy' ? ['buy', 'bid', 'raise-bid'] : ['sell', 'offer', 'lower-ask'];
  const matched =
    commands
      .filter(
        (c) =>
          !used.has(c.seq) &&
          c.submitted &&
          !c.rejected &&
          c.seq < f.seq &&
          c.command.suit === t.suit &&
          c.command.price === t.p &&
          c.command.tradeCount === f.index &&
          kinds.includes(c.command.kind),
      )
      .filter((c) =>
        ['buy', 'sell'].includes(c.command.kind)
          ? f.at - c.at <= 2500
          : events.some(
              (e) =>
                e.seq > c.seq &&
                e.seq < f.seq &&
                e.kind === 'quote' &&
                e.owner === s.self &&
                e.suit === t.suit &&
                e.side === (side === 'buy' ? 'bid' : 'ask') &&
                e.price === t.p &&
                e.epoch === f.index,
            ),
      )
      .at(-1) || null;
  if (matched) used.add(matched.seq);
  const clock = before(f.seq, (e) => ['clock', 'state'].includes(e.kind) && e.timer);
  const previousPrediction = predictions.filter((e) => e.seq < f.seq).at(-1);
  const heldBefore = ownHeld.slice();
  ownHeld[k] += side === 'buy' ? 1 : -1;
  ownCash += side === 'buy' ? -t.p : t.p;
  ownTrades.push({
    tradeNumber: f.index + 1,
    seq: f.seq,
    at: f.at,
    timer: clock?.timer,
    side,
    suit: t.suit,
    price: t.p,
    buyer: t.b,
    seller: t.s,
    heldBefore,
    heldAfter: ownHeld.slice(),
    netCashAfter: ownCash,
    classification: f.classification,
    command: matched
      ? {
          seq: matched.seq,
          commandId: matched.commandId,
          at: matched.at,
          kind: matched.command.kind,
          ageAtFillMs: f.at - matched.at,
          decision: matched.decision,
          outcomes: matched.outcomes,
        }
      : null,
    previousPeriodicPrediction: previousPrediction
      ? {
          seq: previousPrediction.seq,
          ageAtFillMs: f.at - previousPrediction.at,
          tradeCount: previousPrediction.tradeCount,
          probabilities: previousPrediction.probabilities,
          expectedBonus: previousPrediction.expectedBonus,
          goalScenarios: previousPrediction.goalScenarios,
        }
      : null,
    realizedBaseValueChange:
      side === 'buy' ? (t.suit === goal ? 10 : 0) - t.p : t.p - (t.suit === goal ? 10 : 0),
  });
}
assert.deepEqual(ownHeld, s.held);
assert.equal(ownCash, players[0].netCash);
// Strict public-history/ask bounds constrain possible starting hands; they do not reveal the actual allocation.
const physical = B.physical(s);
const tradeMinimum = copy(physical.minimum);
const askDiagnostics = B.askInventoryConstraints(s, physical, j.evidence);
const cases = [];
function allAllocations(deck, initialGoal) {
  const remaining = deck.map((n, k) => n - s.startingHand[k]);
  const out = [];
  const hands = [s.startingHand.slice()];
  function walk(p, left) {
    if (p === names.length) {
      if (left.every((n) => n === 0)) out.push(copy(hands));
      return;
    }
    const min = physical.minimum[p];
    for (let c = 0; c <= left[1]; c++)
      for (let d = 0; d <= left[2]; d++) {
        const hand = [initialGoal[p], c, d, 10 - initialGoal[p] - c - d];
        if (hand.some((v, k) => v < min[k] || v < 0 || v > left[k])) continue;
        hands[p] = hand;
        walk(
          p + 1,
          left.map((n, k) => n - hand[k]),
        );
      }
  }
  walk(1, remaining);
  return out;
}
for (const total of [8, 10]) {
  const bonus = 200 - 10 * total;
  const counts = Array(names.length).fill(0);
  function walk(p, left) {
    if (p === names.length) {
      if (left) return;
      const max = Math.max(...counts);
      const ties = counts.filter((n) => n === max).length;
      if (
        counts.some(
          (n, k) =>
            Math.abs(10 * n + (n === max ? bonus / ties : 0) - players[k].settlement) > 1e-6,
        )
      )
        return;
      const initialGoal = counts.map((n, k) => n - s.net[k][gi]);
      if (initialGoal[0] !== s.startingHand[gi]) return;
      const feasible = [];
      for (const candidate of B.DECKS.filter((d) => d.goal === gi && d.deck[gi] === total)) {
        const allocations = allAllocations(candidate.deck, initialGoal);
        if (allocations.length)
          feasible.push({
            deck: candidate.deck,
            allocationCount: allocations.length,
            witnessStartingHands: allocations[0],
            possibleMothHands: [
              ...new Map(allocations.map((h) => [h[3].join(','), h[3]])).values(),
            ],
          });
      }
      if (!feasible.length) return;
      const maxInitial = Math.max(...initialGoal);
      const tiesInitial = initialGoal.filter((n) => n === maxInitial).length;
      const noTradePnl = initialGoal.map(
        (n) => 10 * n + (n === maxInitial ? bonus / tiesInitial : 0) - ante,
      );
      cases.push({
        goalSupply: total,
        bonusPool: bonus,
        initialGoal,
        finalGoal: counts.slice(),
        noTradePnl,
        actualMinusNoTradePnl: players.map((p, k) => p.pnl - noTradePnl[k]),
        feasible,
      });
      return;
    }
    for (let n = 0; n <= Math.min(left, s.players[p].cards); n++) {
      counts[p] = n;
      walk(p + 1, left - n);
    }
  }
  walk(0, total);
}
const mothGoalTrades = fills
  .filter((f) => f.trade.suit === goal && (f.trade.b === 'Bot-Moth' || f.trade.s === 'Bot-Moth'))
  .map((f) => ({
    tradeNumber: f.index + 1,
    seq: f.seq,
    timer: before(f.seq, (e) => ['state', 'clock'].includes(e.kind) && e.timer)?.timer,
    side: f.trade.b === 'Bot-Moth' ? 'buy' : 'sell',
    price: f.trade.p,
    counterparty: f.trade.b === 'Bot-Moth' ? f.trade.s : f.trade.b,
  }));
let mothCount = 5;
for (const t of mothGoalTrades) {
  t.ifUserReportedFiveIsCorrect = {
    before: mothCount,
    after: mothCount + (t.side === 'buy' ? 1 : -1),
  };
  mothCount = t.ifUserReportedFiveIsCorrect.after;
}
const expensive = ownTrades.find((t) => t.suit === 'd' && t.side === 'buy' && t.price === 23);
const decision = expensive.command.decision;
const output = {
  scope: {
    roundId: m.id,
    source: 'hard-round.ndjson',
    recordedVersion: m.version,
    difficulty: s.context.botDifficulty,
    practice: m.practice,
    officialResult: result,
    tradeCount: s.trades.length,
    ownTradeCount: ownTrades.length,
    storedPredictions: predictions.length,
    caveat:
      'Single first Hard round. Descriptive accounting and historical forecasts, not a model fit, policy backtest, or reconstruction of hidden bot beliefs.',
  },
  players,
  own: {
    startingHand: s.startingHand,
    endingHand: s.held,
    ante,
    netCash: players[0].netCash,
    settlement: players[0].settlement,
    pnl: players[0].pnl,
    goalScenariosNoBonusFinal: s.held.map((n) => players[0].netCash - ante + 10 * n),
    versusKeptDealBySuit: Object.fromEntries(
      B.IDS.map((id, k) => [
        id,
        players[0].bySuit[id].netCash + (id === goal ? 10 * (s.held[k] - s.startingHand[k]) : 0),
      ]),
    ),
    ownTrades,
  },
  moth: {
    startingFiveIsUserReportNotRecorded: true,
    goalTrades: mothGoalTrades,
    goalInventoryDelta: 2,
    goalNetCash: -11,
    totalNetCash: -30,
    settlement: 170,
    pnl: 90,
    conditionalStartingHandIfFiveGoalCards: [5, 3, 1, 1],
    terminalPrivateHandOddsIfThatHand: B.privateBelief([5, 3, 1, 1]).goals,
    privateOddsCaveat:
      'The starting hand above follows only if the user’s five-Spades observation is correct, combined with later public inventory minima. These are terminal-model hand-only odds, not Bot-Moth’s actual beliefs. Actual full starting hand is not recorded.',
  },
  allocationAudit: {
    tradeMinimum,
    qualifiedAskMinimum: physical.minimum,
    askDiagnostics,
    cases,
    note: 'Both goal supplies remain possible under full public fill and qualified-ask constraints. Witness hands are hypothetical allocations, not revealed hands.',
  },
  expensiveDiamond: {
    tradeNumber: expensive.tradeNumber,
    timer: expensive.timer,
    heldBefore: expensive.heldBefore,
    heldAfter: expensive.heldAfter,
    price: 23,
    commandSeq: expensive.command.seq,
    fillSeq: expensive.seq,
    modelAgeMs: decision.modelAgeMs,
    goalProbability: decision.goalProbabilities[2],
    cardsOnlyProbability: decision.cardsOnly[2],
    baseFair: decision.baseFair,
    baseEdge: decision.baseEdge,
    bonusEdge: decision.bonusEdge,
    fullEV: decision.conditionalGain,
    bonusConditionalOnGoal: decision.bonusEdge / decision.goalProbabilities[2],
    totalModelMarginalValue: 23 + decision.conditionalGain,
    interpretation:
      'This buy was explicitly endorsed by the fresh stored model. Almost all of its value came from a hypothetical bonus change on acquiring the fourth diamond from Bot-Shark. The later wrong goal is not by itself an EV arithmetic defect, but this large uncalibrated Hard bonus term deserves separate validation; base fair alone did not justify 23.',
  },
  probabilities: {
    first: predictions[0].probabilities,
    last: predictions.at(-1).probabilities,
    lastPhysical: predictions.at(-1).baseline,
    lastBehavior: predictions.at(-1).behavior,
    recordedSignals: predictions.at(-1).signals,
    inventoryCalibration: predictions.at(-1).inventoryCalibration,
  },
  conclusions: [
    'Moth’s +90 came from a 170-chip settlement minus 30 trading cash and 50 ante. It was an inventory/bonus win, not 90 chips of spread arbitrage.',
    'Moth bought three Spades and sold one, increasing the dealt position by two. If starting five is correct the sequence was 5→6→7→8→7. Net flow alone cannot show a strong initial inventory.',
    'Under both payout-compatible goal allocations, Moth was already the initial sole goal leader. The static everyone-keeps-the-deal benchmark is +100 for Moth and −30 for the user; actual results are 10 and 31 chips worse respectively. This is hindsight accounting, not a causal no-trades simulation.',
    'User’s three Diamond buys cost 41 and no Diamonds paid. Clubs and Hearts sales generated 20, while Spades trading cash of +10 did not replace the 20 base payout from the two dealt Spades.',
    'Owning five Spades does not imply Spades is almost certainly goal. The rule uses the other suit of the color of the 12-card suit, and the whole dealt hand matters. We cannot infer Bot-Moth’s information or strategy from its result.',
    'There is no shown arithmetic contradiction in the 23-chip decision. Its +10.59 modeled EV depends on +29.48 estimated bonus lift, offsetting −18.89 base-price edge. Do not label this simply the user ignoring the model or a stale quote.',
    'A target estimate of roughly 41% is still a substantial wrong-goal risk. Goal probabilities and conditional bonus odds should be judged separately over more Hard rounds; no coefficients are selected from this single outcome.',
  ],
  strategy: [
    'Separate cash capture from the bonus race. A one-card buy then higher-price sale is spread capture; carrying a large goal stack to settlement is inventory risk. A round can profit from either.',
    'Track who already has a plausible large starting position, who is accumulating, and which rival is selling. Net flow is change, not total inventory. Repeated gross buys and an initial five-card holding have different information content.',
    'Read price edge and bonus edge separately. An expensive fourth/fifth card can be rational only if it changes the likely lead enough; after a robust sole lead the extra bonus value can drop sharply.',
    'A holding of six guarantees a sole goal majority under 8/10-card goal supply. Five guarantees at least a tie, but it does not establish which suit is goal. Extra cards can be monetized while protecting a lead, subject to goal uncertainty and counterparty effects.',
    'Use the no-bonus and wrong-goal P&L as a budget before buying a bonus-dependent card. The 23-chip buy added 23 downside in every non-Diamond scenario; a positive model average did not eliminate that exposure.',
  ],
  hindsightIllustrations: {
    skip23BuyKeepingEveryOtherRecordedTradeFixed: -38,
    skipAllDiamondBuysKeepingEveryOtherRecordedTradeFixed: -20,
    caveat:
      'Accounting illustration only. Other players, orders, later inventory and chosen actions might differ under another policy.',
  },
};
assert.equal(cases.length, 2);
assert.equal(expensive.command.decision.modelAgeMs, 418);
assert.equal(output.own.pnl, -61);
assert.equal(players[3].pnl, 90);
assert.equal(ownTrades.length, 14);
fs.writeFileSync(path.join(dir, 'trading-analysis.json'), JSON.stringify(output, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      players: players.map(({ name, netCash, settlement, pnl }) => ({
        name,
        netCash,
        settlement,
        pnl,
      })),
      allocations: cases.map(({ goalSupply, initialGoal, finalGoal, noTradePnl, feasible }) => ({
        goalSupply,
        initialGoal,
        finalGoal,
        noTradePnl,
        witnesses: feasible,
      })),
      expensive: output.expensiveDiamond,
      ownTrades: ownTrades.map((t) => ({
        tradeNumber: t.tradeNumber,
        timer: t.timer,
        side: t.side,
        suit: t.suit,
        price: t.price,
        command: t.command?.seq,
        fullEV: t.command?.decision?.conditionalGain,
        baseEdge: t.command?.decision?.baseEdge,
        bonusEdge: t.command?.decision?.bonusEdge,
      })),
    },
    null,
    2,
  ),
);
