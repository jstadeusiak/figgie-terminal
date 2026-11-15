'use strict';

/*
 * Parity cases over whole rounds. Seeded offline games are recorded and
 * analyzed the way the service worker does it, then scored, replayed and
 * restored. The simulator's policies do not call the model.
 */

const assert = require('node:assert/strict');
const { runRound } = require('../simulation/simulator.cjs');
const {
  SUIT_IDS,
  HUMAN_NAME,
  OFFICIAL_SOURCE,
  SIMULATOR_SOURCE,
  SMALL_BUDGET,
  clone,
  at,
  outcome,
  seededRandom,
  integerBelow,
  chance,
  LEARNED,
  infer,
  journalState,
} = require('./inputs.cjs');

// How long an analysis waits for a moment when you have a resting quote.
const OWN_QUOTE_WAIT_MS = 9000;
// The settled table stays on screen; these are the later looks at it.
const SETTLED_LOOKS_MS = [900, 1900, 3200, 5200];

// ── Cases: complete simulated rounds ─────────────────────────────────────

// Turns one simulator action of yours into the command the terminal records.
function recordedCommand(action, markets) {
  const market = markets.find((candidate) => candidate.id === action.suit);
  if (action.kind === 'take') {
    const price = action.side === 'buy' ? market.ask : market.bid;
    return { kind: action.side, suit: action.suit, price };
  }
  if (action.kind === 'cancel') {
    return { kind: action.side === 'bid' ? 'cancel-bid' : 'cancel-offer', suit: action.suit };
  }
  return { kind: action.side === 'bid' ? 'bid' : 'offer', suit: action.suit, price: action.price };
}

// Plays one seeded round offline and returns what the terminal would observe:
// per step, the time, the snapshot and the command you issued to get there.
function simulateRound(scenario) {
  const truths = [];
  const round = runRound({
    seed: scenario.seed,
    players: scenario.players,
    steps: scenario.steps,
    onSnapshot: (_snapshot, truth) => truths.push(truth),
  });
  const renamed = (value) =>
    scenario.human
      ? JSON.parse(JSON.stringify(value).replaceAll(`"${scenario.human}"`, `"${HUMAN_NAME}"`))
      : clone(value);

  const frames = round.trace.map((frame, index) => {
    const snapshot = renamed(frame.snapshot);
    snapshot.roundKey = scenario.name;
    snapshot.context = scenario.difficulty ? { botDifficulty: scenario.difficulty } : {};
    if (snapshot.roundResult) {
      snapshot.roundResult.source = scenario.resultSource || OFFICIAL_SOURCE;
      if (scenario.settledBank) snapshot.roundResult.settledBank = snapshot.cash;
    }
    // Practice mode shows every hand; the simulator's hidden truth stands in.
    const truth = truths[index];
    if (scenario.practice && truth) {
      const byName = (hands) =>
        Object.fromEntries(truth.names.map((name, seat) => [name, hands[seat]]));
      snapshot.training = renamed({
        enabled: true,
        handsVisible: true,
        valid: true,
        hands: byName(truth.hands),
        startingHands: byName(truth.initial),
        deckTotals: truth.deck,
      });
    }
    const taken = round.actions[index - 1];
    const isOwnAction = taken?.actor === 'You' && taken.result.ok && taken.action.kind !== 'wait';
    const command = isOwnAction
      ? recordedCommand(taken.action, round.trace[index - 1].snapshot.markets)
      : null;
    return { at: frame.at, snapshot, command };
  });

  const settled = frames.at(-1);
  for (const delayMs of SETTLED_LOOKS_MS) {
    frames.push({ at: settled.at + delayMs, snapshot: clone(settled.snapshot), command: null });
  }
  return frames;
}

const ownsQuote = (snapshot) =>
  snapshot.markets.some(
    (market) => market.buyer === snapshot.self || market.seller === snapshot.self,
  );

// Draft quote prices around the visible book, as typed into the terminal.
function draftQuotes(random, snapshot) {
  const drafts = {};
  for (const market of snapshot.markets) {
    if (chance(random, 0.4)) continue;
    drafts[market.id] = {
      bid: (market.bid ?? 3) + integerBelow(random, 4) - 1,
      ask: (market.ask ?? 9) + integerBelow(random, 4) - 2,
    };
  }
  return drafts;
}

// What the service worker stores for a round between observations.
function roundRecord(journal) {
  return {
    id: journal.id,
    base: journal.base,
    seq: journal.seq,
    snapshot: journal.previous,
    observedAt: journal.at,
    updatedAt: journal.at,
    rates: journal.rates,
    revealed: journal.revealed,
    practice: journal.practice,
    practiceSince: journal.practiceSince,
    practicePeeked: journal.practicePeeked,
    trainingCheckpoints: { ...journal.trainingCheckpoints },
    pendingSettlement: journal.pendingSettlement || null,
    cursors: { ...journal.cursors },
    accounting: { ...journal.accounting },
  };
}

// Records and analyzes a whole round the way the service worker does, then
// scores, replays and restores it. Returns everything that was produced.
function playRound(release, scenario, frames) {
  const { Belief, Journal, Training, Pnl, Bonus } = release;
  const random = seededRandom(scenario.seed);
  const emitted = [];
  const emit = (event) => emitted.push(event);
  let journal = new Journal.RoundJournal(scenario.name, `base:${scenario.name}`, emit);
  const engine = new Belief.BeliefEngine(scenario.engineOptions);
  const analyses = [];
  const rejectedObservations = [];
  let lastAnalysisAt = -Infinity;
  let restored = null;

  function observe(frame, index) {
    const snapshot = clone(frame.snapshot);
    if (scenario.pausedFrames?.includes(index) && snapshot.status === 'live') {
      snapshot.status = 'paused';
    }
    if (index === scenario.hiddenFrame) journal.gap('hidden', 'Tab hidden', frame.at - 400);
    if (frame.command) {
      const data = { id: `command-${index}`, command: frame.command };
      journal.command('command_attempt', data, frame.at - 300);
      journal.command('command_result', { ...data, ok: true }, frame.at - 100);
    }
    if (index === scenario.restoreFrame) {
      const record = roundRecord(journal);
      if (scenario.restoreFromEvents) {
        delete record.snapshot;
        delete record.accounting;
        delete record.rates;
      }
      journal = Journal.restore(clone(record), clone(journal.events), emit);
      restored = clone(journalState(journal));
    }
    if (index === scenario.rewoundFrame)
      snapshot.trades.length = journal.previous.trades.length - 1;
    // The page adds element references; the journal must drop them.
    const observed = outcome(() =>
      journal.observe({ ...snapshot, refs: { stale: true } }, frame.at),
    );
    if (observed.threw) rejectedObservations.push({ index, message: observed.threw });
    return snapshot;
  }

  function isAnalysisDue(snapshot, now) {
    if (journal.previous?.status !== 'live') return false;
    const waitedMs = now - lastAnalysisAt;
    if (waitedMs < scenario.analysisIntervalMs) return false;
    // Prefer a moment when you have a resting quote, so its fill is forecast.
    return ownsQuote(snapshot) || waitedMs >= scenario.analysisIntervalMs + OWN_QUOTE_WAIT_MS;
  }

  function analyze(snapshot, now) {
    lastAnalysisAt = now;
    const blind = Training.blindSnapshot(snapshot);
    const learning = {
      ...scenario.learning,
      forceBaseline: scenario.cardsOnlyEvery
        ? analyses.length % scenario.cardsOnlyEvery === 1
        : false,
      quotePrices: scenario.drafts ? draftQuotes(random, snapshot) : {},
      rates: journal.practice ? scenario.learning?.rates : journal.rates,
    };
    if (!analyses.length) journal.append('learning_prior', { learning }, now);
    const model = infer(release, engine, blind, journal.evidence, learning);
    model.roundPnl = Pnl.summary(snapshot, model, journal.accounting, journal.revealed);
    model.training = Training.analyze(snapshot, model);
    journal.prediction(model, now);
    journal.trackActualTopQuotes(model, now);
    analyses.push({ blind, model: clone(model) });
  }

  frames.forEach((frame, index) => {
    if (scenario.missedFrames?.includes(index)) return;
    const snapshot = observe(frame, index);
    if (isAnalysisDue(snapshot, frame.at)) analyze(snapshot, frame.at);
  });

  const final = journal.previous;
  const reveals = [1, 2].map(() => journal.reveal(clone(final.roundResult), journal.at));
  const events = journal.events;
  const cuts = [1, 2, Math.floor(events.length / 3), Math.floor(events.length / 2), events.length];
  const rebuiltRecord = { id: scenario.name, base: 'rebuilt', updatedAt: journal.at };
  return {
    rejectedObservations,
    analyses,
    restored,
    reveals,
    revealedStyles: SUIT_IDS.map((suit) => engine.revealedStyles(suit)),
    journal: journalState(journal),
    emitted,
    summary: journal.summary(),
    roundScore: Journal.scoreRound(journal),
    bonusAudit: Bonus.auditRound(journal),
    bonusLabels: Bonus.auditRound(journal, { includeLabels: true }),
    bonusScore: Bonus.scoreRound(journal),
    livePredictions: Journal.livePredictions(events),
    fillOutcomes: Journal.scoredFillOutcomes(events),
    practice: Journal.isPractice(journal),
    replays: cuts.map((cut) => Journal.replay(clone(events.slice(0, cut)))),
    accounting: cuts.map((cut) =>
      Pnl.restore(clone(events.slice(0, cut)), clone(final), journal.at),
    ),
    restoredFromRecord: journalState(Journal.restore(clone(roundRecord(journal)), clone(events))),
    restoredFromEvents: journalState(Journal.restore(rebuiltRecord, clone(events))),
    registryReplay: registryReplay(release, scenario, journal),
  };
}

// The registry's comparison path: rebuild each live checkpoint from the
// recorded prefix alone and forecast it again without pricing.
function registryReplay(release, scenario, journal) {
  const { Belief, Journal, Training, Pnl, Bonus } = release;
  const engine = new Belief.BeliefEngine({ ...scenario.engineOptions, skipPricing: true });
  const events = journal.events;
  const replayedScenarios = new Map();
  const points = Journal.livePredictions(events).map((prediction) => {
    const prefix = events.filter((event) => event.seq < prediction.seq);
    const blind = Training.blindSnapshot(Journal.replay(clone(prefix)));
    const prior = prefix.findLast((event) => event.kind === 'learning_prior')?.learning || {};
    const rebuilt = Journal.restore(
      {
        id: journal.id,
        base: journal.base,
        snapshot: blind,
        observedAt: prediction.at,
        rates: prediction.rates,
      },
      clone(prefix),
    );
    const model = infer(release, engine, blind, rebuilt.evidence, clone(prior));
    replayedScenarios.set(prediction.seq, Pnl.summary(blind, model).goalScenarios);
    return { seq: prediction.seq, evidence: rebuilt.evidence.length, model };
  });
  const rescoredEvents = events.map((event) =>
    event.kind === 'prediction'
      ? { ...event, goalScenarios: replayedScenarios.get(event.seq) || null }
      : event,
  );
  const bonus = Bonus.auditRound({ ...roundRecord(journal), events: rescoredEvents });
  return { points, bonus };
}

function simulatedRoundCases() {
  const eventKinds = (output) => new Set(output.journal.events.map((event) => event.kind));
  const scenarios = [
    {
      name: 'round: four Medium bots at the production budget',
      seed: 2101,
      players: 4,
      steps: 240,
      difficulty: 'Medium',
      settledBank: true,
      analysisIntervalMs: 55000,
      drafts: true,
      learning: LEARNED,
      check(output) {
        assert.ok(output.roundScore, 'the round is scored');
        assert.ok(output.bonusScore, 'bonus forecasts are scored');
        assert.ok(output.registryReplay.bonus.score, 'replayed bonus forecasts are scored');
        assert.ok(output.fillOutcomes.length, 'own quotes are tracked to an outcome');
        assert.equal(output.summary.pnl.source, 'Official round result');
        assert.ok(eventKinds(output).has('command_attempt'));
      },
    },
    {
      name: 'round: four Medium bots with drafts, cards-only checks and gaps',
      seed: 2207,
      players: 4,
      steps: 200,
      difficulty: 'Medium',
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 12000,
      cardsOnlyEvery: 3,
      drafts: true,
      hiddenFrame: 90,
      missedFrames: [40, 41, 42, 43, 150],
      learning: LEARNED,
      check(output) {
        assert.ok(eventKinds(output).has('coverage'));
        assert.equal(output.summary.pnl.source, 'Settled bank − pre-ante opening bank');
        assert.ok(
          output.journal.predictions.length < output.analyses.length,
          'forecasts closer than fifteen seconds are not recorded',
        );
        assert.ok(output.fillOutcomes.some((fill) => fill.censored));
        assert.ok(output.fillOutcomes.some((fill) => !fill.censored));
      },
    },
    {
      name: 'round: four Hard bots restored mid-round',
      seed: 2309,
      players: 4,
      steps: 160,
      difficulty: 'Hard',
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 30000,
      restoreFrame: 80,
      settledBank: true,
      learning: { rates: LEARNED.rates },
      check: (output) => assert.ok(output.restored.evidence.length),
    },
    {
      name: 'round: four bots of unknown difficulty, paused and rebuilt from events',
      seed: 2411,
      players: 4,
      steps: 160,
      difficulty: null,
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 30000,
      pausedFrames: [60, 61, 62, 63, 64],
      restoreFrame: 130,
      restoreFromEvents: true,
      check: (output) => assert.equal(output.analyses[0].model.behavior.group, 'bots'),
    },
    {
      name: 'round: four players with a human',
      seed: 2503,
      players: 4,
      steps: 160,
      difficulty: 'Medium',
      human: 'Bot-Sim-2',
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 30000,
      drafts: true,
      learning: LEARNED,
      check: (output) => assert.equal(output.analyses[0].model.behavior.group, 'mixed'),
    },
    {
      name: 'round: five Medium bots',
      seed: 2609,
      players: 5,
      steps: 160,
      difficulty: 'Medium',
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 70000,
      settledBank: true,
      learning: LEARNED,
      check: (output) => assert.ok(output.bonusScore, 'five-player bonus forecasts are scored'),
    },
    {
      name: 'round: five Hard bots with a human',
      seed: 2707,
      players: 5,
      steps: 120,
      difficulty: 'Hard',
      human: 'Bot-Sim-3',
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 90000,
      drafts: true,
    },
    {
      name: 'round: practice with visible hands',
      seed: 2801,
      players: 4,
      steps: 160,
      difficulty: 'Medium',
      practice: true,
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 40000,
      learning: LEARNED,
      check(output) {
        assert.equal(output.practice, true);
        assert.equal(output.analyses[0].model.training.available, true);
        assert.equal(output.roundScore, null);
      },
    },
    {
      name: 'round: five-player practice',
      seed: 2903,
      players: 5,
      steps: 120,
      difficulty: 'Hard',
      practice: true,
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 80000,
      check: (output) => assert.equal(output.analyses[0].model.training.available, true),
    },
    {
      name: 'round: unofficial result and rewound history',
      seed: 3001,
      players: 4,
      steps: 160,
      difficulty: 'Medium',
      resultSource: SIMULATOR_SOURCE,
      engineOptions: SMALL_BUDGET,
      analysisIntervalMs: 50000,
      rewoundFrame: 100,
      check(output) {
        assert.deepEqual(output.rejectedObservations, [
          { index: 100, message: 'History changed; a new recording segment is required' },
        ]);
        assert.equal(output.bonusAudit.reason, 'Verified official settlement required');
      },
    },
  ];
  return scenarios.map((scenario) => {
    const frames = simulateRound(scenario);
    return {
      name: scenario.name,
      check: scenario.check,
      run: (release) => playRound(release, scenario, frames),
    };
  });
}

module.exports = { simulatedRoundCases };
