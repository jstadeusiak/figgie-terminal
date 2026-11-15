/* Service worker: recording and inference for each Figgie tab.

   A tab's session holds the current round's journal (its recorded events and
   the evidence derived from them), a belief engine, and the last model that
   engine produced. Content scripts send observations and user actions to
   record, and ask for a model of one specific observation. Messages from a
   tab are handled strictly in order.

   Nothing here places an order or contacts a server. State lives in memory
   and in the local record store. */
'use strict';

importScripts(
  'model-fit.js',
  'goal-signal.js',
  'belief.js',
  'training.js',
  'pnl.js',
  'journal.js',
  'bonus-score.js',
  'record-store.js',
  'ratings.js',
);

// The extension and its model are released together under one version.
const RELEASE_VERSION = FiggieBelief.VERSION;
const FIGGIE_PLAY_URL = /^https:\/\/(www\.)?figgie\.com\/play\//;
const OFFICIAL_SOURCE = 'official-round-rankings';
const TRAINING_EVENT_KINDS = ['training_prediction', 'training_peek', 'training_continue'];

// A recorded round can be resumed, after a reload or worker restart, this long after its last update.
const RESUME_WINDOW_MS = 45 * 60 * 1000;
// How long a model request waits for its observation to be recorded.
const MODEL_WAIT_TIMEOUT_MS = 2000;
const EXPORT_LIFETIME_MS = 300000;
const MAX_TRAINING_CHECKPOINTS = 8;

// Stored learning is rescored from the recordings whenever this changes.
const CALIBRATION_VERSION = 2;
// Behavior-style priors start with the weight of this many observations.
const STYLE_PRIOR_WEIGHT = 40;
// How far one revealed round moves the population mixture and a named human's.
const POPULATION_STYLE_STEP = 0.1;
const HUMAN_STYLE_STEP = 0.25;

const store = new FiggieRecordStore();
const sessions = new Map(); // tab id → { journal, events, engine, lastModel, lastComputedAt }
const messageQueues = new Map(); // tab id → promise for that tab's latest message
const waitingModels = new Map(); // tab id → model requests waiting for their observation
const exportsByTab = new Map(); // tab id → chunked export in progress
let learning = null;
let learningLoad = null;

const byMostRecent = (a, b) => b.updatedAt - a.updatedAt;
const isRecent = (record) => Date.now() - record.updatedAt < RESUME_WINDOW_MS;
const isBot = (name) => /^Bot-/.test(name);
const isOfficial = (result) => result?.verified === true && result.source === OFFICIAL_SOURCE;
const validGoal = (result) => FiggieBelief.IDS.includes(result?.goal);
const roundEnded = (session) => session?.journal.previous?.status === 'ended';
const runningMean = (mean, count, value) => ((mean || 0) * count + value) / (count + 1);

function normalized(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

// ── Learning state ───────────────────────────────────────────────────────
// Scores and priors accumulated across rounds, stored as one `global` record.

const emptyRoundMetrics = () => ({
  rounds: 0,
  opponentBrier: 0,
  baselineBrier: 0,
  opponentLogLoss: 0,
  baselineLogLoss: 0,
});

const priorStyleCounts = () =>
  FiggieBelief.DEFAULT_PRIOR.map((share) => share * STYLE_PRIOR_WEIGHT);

const freshLearning = () => ({
  id: 'global',
  version: RELEASE_VERSION,
  metrics: emptyRoundMetrics(),
  stylePriors: {},
  humanStyleCounts: {},
  population: {
    bots: FiggieBelief.DEFAULT_PRIOR.slice(),
    mixed: FiggieBelief.DEFAULT_PRIOR.slice(),
  },
  styleCounts: {
    bots: priorStyleCounts(),
    mixed: priorStyleCounts(),
  },
  rates: {
    bid: { fills: 0, exposure: 0, outbids: 0 },
    ask: { fills: 0, exposure: 0, outbids: 0 },
    resets: 0,
    liveSeconds: 0,
  },
  scored: [],
});

// Scores are kept per kind of table: all bots at one difficulty, or any table with humans.
function opponentGroup(snapshot) {
  const allBots = snapshot.players.every(
    (player) => player.name === snapshot.self || isBot(player.name),
  );
  if (!allBots) return 'mixed';
  const difficulty = snapshot.context?.botDifficulty;
  return difficulty ? 'bots:' + difficulty : 'bots';
}

function addRoundMetric(metrics, score) {
  const rounds = metrics.rounds || 0;
  for (const key of ['opponentBrier', 'baselineBrier', 'opponentLogLoss', 'baselineLogLoss']) {
    metrics[key] = runningMean(metrics[key], rounds, score[key]);
  }
  metrics.rounds = rounds + 1;
}

// Bonus calibration is a separate report; it never changes live model weights.
function addBonusMetric(metric, score) {
  const rounds = metric.rounds || 0;
  for (const key of ['bonusMae', 'bonusBias']) {
    metric[key] = runningMean(metric[key], rounds, score[key]);
  }
  metric.rounds = rounds + 1;
  // Older stored rounds have no MSE; do not count them as zero-error rounds.
  if (Number.isFinite(score.bonusMse)) {
    const mseRounds = metric.mseRounds || 0;
    metric.bonusMse = runningMean(metric.bonusMse, mseRounds, score.bonusMse);
    metric.mseRounds = mseRounds + 1;
    metric.bonusRmse = Math.sqrt(metric.bonusMse);
  }
  for (const kind of ['category', 'leader']) {
    const brierKey = kind + 'Brier';
    const roundsKey = kind + 'Rounds';
    if (!Number.isFinite(score[brierKey])) continue;
    const scoredRounds = metric[roundsKey] || 0;
    metric[brierKey] = runningMean(metric[brierKey], scoredRounds, score[brierKey]);
    metric[roundsKey] = scoredRounds + 1;
  }
  for (const key of [
    'checkpoints',
    'categoryCheckpoints',
    'leaderCheckpoints',
    'excludedCheckpoints',
  ])
    metric[key] = (metric[key] || 0) + (score[key] || 0);
}

const fillSquaredError = (outcome) => (outcome.pFill - (outcome.filled ? 1 : 0)) ** 2;

function addRates(total, rates) {
  for (const side of ['bid', 'ask']) {
    for (const key of ['fills', 'exposure', 'outbids']) total[side][key] += rates[side][key];
  }
  total.resets += rates.resets;
  total.liveSeconds += rates.liveSeconds;
}

// Fill and reset rates learned so far, plus this round's own unless it is practice.
function combinedRates(roundRates, learnedRates) {
  const combined = JSON.parse(JSON.stringify(learnedRates || freshLearning().rates));
  if (roundRates) addRates(combined, roundRates);
  return combined;
}

async function getLearning() {
  if (learningLoad) return learningLoad;
  if (learning?.calibrationVersion === CALIBRATION_VERSION) return learning;
  learningLoad = (async () => {
    learning = (await store.get('learning', 'global')) || freshLearning();
    if (learning.calibrationVersion !== CALIBRATION_VERSION) {
      await rescoreFromRecordings(learning);
      await store.saveLearning(learning);
    }
    return learning;
  })();
  try {
    return await learningLoad;
  } catch (error) {
    learning = null;
    throw error;
  } finally {
    learningLoad = null;
  }
}

// Rebuilds the round and fill scores from the stored recordings, counting only
// live pre-reveal predictions and observable fill outcomes.
async function rescoreFromRecordings(learned) {
  const metrics = emptyRoundMetrics();
  const groupMetrics = {};
  const fillRounds = [];
  const scoredRounds = [];
  let recoveredFills = 0;
  let excludedCheckpoints = 0;
  let fillCount = 0;
  let fillError = 0;
  for (const record of await store.all('rounds')) {
    const wasScored = record.revealed && learned.scored.includes(record.id);
    if (record.snapshot?.status !== 'ended' && !wasScored) continue;
    const events = await store.events(record.id);
    const journal = FiggieJournal.restore(record, events);
    if (journal.practice) continue;
    if (journal.previous?.status === 'ended') {
      fillRounds.push(journal.id);
      for (const outcome of FiggieJournal.scoredFillOutcomes(events)) {
        if (outcome.censored) continue;
        fillCount++;
        fillError += fillSquaredError(outcome);
        if (outcome.legacyRecovered) recoveredFills++;
      }
    }
    if (!wasScored) continue;
    const score = FiggieJournal.scoreRound(journal);
    if (!score) continue;
    scoredRounds.push(journal.id);
    addRoundMetric(metrics, score);
    addRoundMetric((groupMetrics[opponentGroup(journal.previous)] ||= { rounds: 0 }), score);
    excludedCheckpoints += score.excludedCheckpoints || 0;
  }
  metrics.fillScored = fillCount;
  metrics.fillBrier = fillCount ? fillError / fillCount : 0;
  learned.metrics = metrics;
  learned.scored = scoredRounds;
  learned.groupMetrics = groupMetrics;
  learned.fillScoredRounds = fillRounds;
  learned.calibrationVersion = CALIBRATION_VERSION;
  learned.calibrationAudit = {
    at: Date.now(),
    excludedPostEndCheckpoints: excludedCheckpoints,
    recoveredKnownFills: recoveredFills,
    scope:
      'Raw recordings unchanged; score only live pre-reveal predictions and observable fill outcomes',
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────

// Identifies one dealt round, however far it has progressed.
function baseKey(snapshot) {
  return JSON.stringify([
    snapshot.self,
    snapshot.room,
    snapshot.round,
    snapshot.players.map((player) => player.name),
    snapshot.startingHand,
  ]);
}

// A stored round continues when the observed trade history extends what was recorded.
function canResume(record, snapshot) {
  return (
    record.base === baseKey(snapshot) &&
    isRecent(record) &&
    (!record.revealed || snapshot.status === 'ended') &&
    record.snapshot &&
    record.snapshot.trades.length <= snapshot.trades.length &&
    record.snapshot.trades.every(
      (trade, index) => JSON.stringify(trade) === JSON.stringify(snapshot.trades[index]),
    )
  );
}

function roundRecord(session) {
  const journal = session.journal;
  return {
    id: journal.id,
    base: journal.base,
    seq: journal.seq,
    self: journal.previous?.self,
    updatedAt: Date.now(),
    observedAt: journal.at,
    snapshot: journal.previous,
    rates: { ...journal.rates, bid: { ...journal.rates.bid }, ask: { ...journal.rates.ask } },
    revealed: journal.revealed,
    practice: journal.practice,
    practiceSince: journal.practiceSince,
    practicePeeked: journal.practicePeeked,
    trainingCheckpoints: { ...journal.trainingCheckpoints },
    pendingSettlement: journal.pendingSettlement || null,
    cursors: { ...journal.cursors },
    accounting: { ...journal.accounting },
    version: RELEASE_VERSION,
  };
}

// Queues the session's new events, and optionally the learning state, for the next disk commit.
function save(session, learningUpdate) {
  if (!session.events.length && !session.journal.dirty && !learningUpdate) return;
  const events = session.events.splice(0);
  store.queue(roundRecord(session), events, learningUpdate);
  session.journal.dirty = false;
}

// Practice status follows a round across recording segments.
function inheritPractice(journal, prior, at) {
  if (journal.practice || !FiggieJournal.isPractice(prior)) return;
  journal.practice = true;
  journal.practiceSince = prior.practiceSince || at;
  journal.practicePeeked = prior.practicePeeked === true;
  journal.append(
    'practice_mode',
    { practice: true, source: 'Earlier recording segment of this round' },
    at,
  );
}

// Returns the tab's session for this round, resuming a stored recording when
// its history matches or starting a new recording segment otherwise.
async function sessionFor(tab, snapshot) {
  const base = baseKey(snapshot);
  const current = sessions.get(tab);
  if (
    current &&
    current.journal.base === base &&
    snapshot.trades.length >= current.journal.previous?.trades.length
  ) {
    return current;
  }
  if (current) {
    current.journal.append('segment_end', { reason: 'Round or history changed' }, Date.now());
    save(current);
  }

  const records = await (store.roundsForBase ? store.roundsForBase(base) : store.all('rounds'));
  const record = records
    .filter((candidate) => canResume(candidate, snapshot))
    .sort(byMostRecent)[0];
  const events = [];
  const emit = (event) => events.push(event);
  const id = record?.id || 'round-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8);
  const journal = record
    ? FiggieJournal.restore(record, await store.events(record.id), emit)
    : new FiggieJournal.RoundJournal(id, base, emit);
  journal.pendingSettlement = record?.pendingSettlement || null;

  const earlierSegment =
    current?.journal?.base === journal.base
      ? current.journal
      : records
          .filter(
            (candidate) =>
              candidate.base === journal.base &&
              isRecent(candidate) &&
              FiggieJournal.isPractice(candidate),
          )
          .sort(byMostRecent)[0];
  inheritPractice(journal, earlierSegment, Date.now());

  const session = {
    journal,
    events,
    engine: new FiggieBelief.BeliefEngine(),
    lastModel: null,
    lastComputedAt: 0,
  };
  sessions.set(tab, session);
  journal.append(
    'segment_start',
    {
      tabId: tab,
      recovered: Boolean(record),
      coverage: 'Visible DOM observations only; event bursts may be coalesced',
    },
    Date.now(),
  );
  return session;
}

// Loads a stored round, with a model of its final state, so its result can be recorded later.
async function restoreSession(roundId) {
  await store.flush();
  const record = await store.get('rounds', roundId);
  if (!record?.snapshot) throw Error('Recorded round not found');
  const events = [];
  const journal = FiggieJournal.restore(record, await store.events(record.id), (event) =>
    events.push(event),
  );
  const engine = new FiggieBelief.BeliefEngine();
  const learned = await getLearning();
  const lastModel = engine.infer(FiggieTraining.blindSnapshot(record.snapshot), journal.evidence, {
    ...learned,
    rates: combinedRates(journal.practice ? null : journal.rates, learned.rates),
  });
  return { journal, events, engine, lastModel };
}

const journalSummary = (session) => ({
  ...session.journal.summary(),
  observedRevision: session.journal.previous?.analysisRevision || 0,
});

const recordingSummary = (session) => ({ ...journalSummary(session), ...store.status() });

// ── Inference ────────────────────────────────────────────────────────────

const withoutNulls = (object) =>
  Object.fromEntries(Object.entries(object || {}).filter(([, value]) => value !== null));

async function analyze(session, job, at) {
  const journal = session.journal;
  const snapshot = {
    ...job.snapshot,
    context: { ...journal.previous?.context, ...withoutNulls(job.snapshot.context) },
  };
  journal.markPractice(snapshot, at);
  // Inference never sees hands that practice mode exposes. The P&L summary and
  // practice comparison below are the only readers of the unblinded snapshot.
  const blindSnapshot = FiggieTraining.blindSnapshot(snapshot);
  const learned = await getLearning();
  if (!journal.learningSaved) {
    journal.learningSaved = true;
    journal.append('learning_prior', { learning: learned }, at);
  }
  const model = session.engine.infer(blindSnapshot, journal.evidence, {
    ...learned,
    forceBaseline: job.opponentEnabled === false,
    quotePrices: job.quotePrices || {},
    rates: combinedRates(journal.practice ? null : journal.rates, learned.rates),
  });
  model.roundPnl = FiggiePnl.summary(snapshot, model, journal.accounting, journal.revealed);
  model.training = FiggieTraining.analyze(snapshot, model);
  if (journal.practice && model.training.available) {
    journal.append('training_source', { snapshot: FiggieJournal.clean(snapshot) }, at);
  }
  session.lastModel = model;
  session.lastComputedAt = at;
  if (journal.previous?.signature === snapshot.signature) {
    journal.prediction(model, at);
    journal.trackActualTopQuotes(model, at);
  } else {
    model.recordingCoverageIncomplete = true;
  }
  save(session);
  return model;
}

// Disk commits must not hold the ordered in-memory queue. A model still waits
// for its exact source observation, and runs before later evidence in a batch.
function modelReadiness(session, snapshot) {
  if (!session || session.journal.base !== baseKey(snapshot) || !session.journal.previous) {
    return 'waiting';
  }
  const previous = session.journal.previous;
  const requested = Number(snapshot.analysisRevision) || 0;
  const observed = Number(previous.analysisRevision) || 0;
  if (observed > requested) return 'superseded';
  const matches = observed === requested && previous.signature === snapshot.signature;
  return matches ? 'ready' : 'waiting';
}

const modelResponse = (session, job, model) => ({
  id: job.id,
  model,
  recording: recordingSummary(session),
});

const supersededResponse = (job) => ({
  id: job.id,
  superseded: true,
  error: 'Model snapshot was superseded by a newer observation.',
});

const errorResponse = (id, error) => ({
  id,
  error: error.message,
  recording: { ...store.status(), error: error.message },
});

function waitForObservation(tab, job) {
  let resolve;
  const completion = new Promise((done) => (resolve = done));
  const entry = { job, resolve, timer: null };
  const waiting = waitingModels.get(tab) || [];
  waiting.push(entry);
  waitingModels.set(tab, waiting);
  entry.timer = setTimeout(() => {
    stopWaiting(tab, entry);
    resolve({
      id: job.id,
      error: 'Model is waiting for the recorded market observation. New quotes remain available.',
    });
  }, MODEL_WAIT_TIMEOUT_MS);
  return { completion };
}

function stopWaiting(tab, entry) {
  clearTimeout(entry.timer);
  const waiting = waitingModels.get(tab);
  if (!waiting) return;
  const index = waiting.indexOf(entry);
  if (index >= 0) waiting.splice(index, 1);
  if (!waiting.length) waitingModels.delete(tab);
}

// Runs every waiting model request whose observation has now been recorded.
async function resumeModels(tab, session) {
  for (const entry of [...(waitingModels.get(tab) || [])]) {
    const job = entry.job;
    const readiness = modelReadiness(session, job.snapshot);
    if (readiness === 'waiting') continue;
    stopWaiting(tab, entry);
    if (readiness === 'superseded') {
      entry.resolve(supersededResponse(job));
      continue;
    }
    try {
      const model = await analyze(session, job, Date.now());
      entry.resolve(modelResponse(session, job, model));
    } catch (error) {
      entry.resolve(errorResponse(job.id, error));
    }
  }
}

// ── Round results ────────────────────────────────────────────────────────

// An official result belongs to this round only if its banks agree with the
// final observed balances and it does not contradict rankings already seen.
function officialResultMatches(journal, result) {
  const snapshot = journal.previous;
  const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
  if (
    snapshot?.status !== 'ended' ||
    !isOfficial(result) ||
    !near(result.settledBank, snapshot.cash) ||
    !snapshot.players.every((player) => near(result.banks?.[player.name], player.cash))
  ) {
    return false;
  }
  const observed = snapshot.roundResult;
  if (!isOfficial(observed)) return true;
  return (
    observed.goal === result.goal &&
    snapshot.players.every((player) =>
      near(observed.profits?.[player.name], result.profits?.[player.name]),
    )
  );
}

const goalConflicts = (journal, result) =>
  journal.revealed && journal.revealed.goal !== result.goal;

const officialProfitsConflict = (journal, result) =>
  isOfficial(result) &&
  isOfficial(journal.revealed) &&
  journal.previous.players.some(
    (player) => journal.revealed.profits?.[player.name] !== result.profits?.[player.name],
  );

function scoreBonusOnce(session, learned, at) {
  const journal = session.journal;
  if (
    journal.practice ||
    !officialResultMatches(journal, journal.revealed) ||
    (learned.bonusScoredRounds || []).includes(journal.id) ||
    journal.events.some((event) => event.kind === 'bonus_score')
  ) {
    return false;
  }
  const score = FiggieBonusScore.scoreRound(journal);
  if (!score) return false;
  learned.bonusScoredRounds ||= [];
  learned.bonusMetrics ||= {};
  learned.bonusGroupMetrics ||= {};
  addBonusMetric(learned.bonusMetrics, score);
  addBonusMetric((learned.bonusGroupMetrics[opponentGroup(journal.previous)] ||= {}), score);
  learned.bonusScoredRounds.push(journal.id);
  journal.append('bonus_score', score, at);
  return true;
}

function scoreFillsOnce(session, learned) {
  const journal = session.journal;
  if (journal.practice) return false;
  learned.fillScoredRounds ||= [];
  if (journal.previous?.status !== 'ended' || learned.fillScoredRounds.includes(journal.id)) {
    return false;
  }
  const outcomes = FiggieJournal.scoredFillOutcomes(journal.events).filter(
    (outcome) => !outcome.censored,
  );
  if (outcomes.length) {
    const scoredBefore = learned.metrics.fillScored || 0;
    const error = outcomes.reduce((total, outcome) => total + fillSquaredError(outcome), 0);
    learned.metrics.fillBrier =
      ((learned.metrics.fillBrier || 0) * scoredBefore + error) / (scoredBefore + outcomes.length);
    learned.metrics.fillScored = scoredBefore + outcomes.length;
  }
  learned.fillScoredRounds.push(journal.id);
  return true;
}

function recordRoundScore(journal, learned, score, at) {
  const group = opponentGroup(journal.previous);
  if (score.signalComparison) {
    learned.signalMetrics ||= {};
    const metric = (learned.signalMetrics[group] ||= { rounds: 0 });
    for (const key of ['opponentBrier', 'referenceBrier', 'candidateBrier']) {
      metric[key] = runningMean(metric[key], metric.rounds, score.signalComparison[key]);
    }
    metric.rounds++;
  }
  addRoundMetric(learned.metrics, score);
  learned.groupMetrics ||= {};
  addRoundMetric((learned.groupMetrics[group] ||= { rounds: 0 }), score);
  learned.scored.push(journal.id);
  journal.append('round_score', score, at);
}

// Update a broad population policy mixture from the revealed goal. Sparse
// rounds receive very little weight; bot names are never persistent styles.
function learnStyles(session, learned, goal) {
  const group = opponentGroup(session.journal.previous);
  learned.styleCounts[group] ||= priorStyleCounts();
  if (!session.lastModel) return;
  const groupCounts = learned.styleCounts[group];
  const addStyles = (counts, actor, step) =>
    FiggieBelief.STYLE_NAMES.forEach((style, index) => {
      counts[index] += step * actor.probabilities[style];
    });
  for (const actor of session.engine.revealedStyles(goal)) {
    addStyles(groupCounts, actor, POPULATION_STYLE_STEP);
    if (isBot(actor.name)) continue;
    learned.humanStyleCounts ||= {};
    const humanCounts = (learned.humanStyleCounts[actor.name] ||= priorStyleCounts());
    addStyles(humanCounts, actor, HUMAN_STYLE_STEP);
    learned.stylePriors[actor.name] = normalized(humanCounts);
  }
  learned.population[group] = normalized(groupCounts);
}

// Records the revealed goal, then scores the round's saved forecasts once.
async function settle(session, result, at) {
  const journal = session.journal;
  if (journal.previous?.status !== 'ended') {
    throw Error('Record the revealed goal after the round ends.');
  }
  if (!validGoal(result)) throw Error('Choose a valid revealed goal suit');
  if (goalConflicts(journal, result)) {
    throw Error('Revealed goal conflicts with the saved round result');
  }
  const official = isOfficial(result);
  if (official && !officialResultMatches(journal, result)) {
    throw Error('Official result does not match this round settlement');
  }
  if (officialProfitsConflict(journal, result)) {
    throw Error('Official profits conflict with the saved round result');
  }

  if (!journal.revealed) {
    journal.reveal(result, at);
  } else if (
    official &&
    !isOfficial(journal.revealed) &&
    FiggieBonusScore.auditRound({ ...journal, revealed: result }).settlementVerified
  ) {
    // An official result replaces a goal the user entered by hand.
    journal.revealed = JSON.parse(JSON.stringify(result));
    journal.append('reveal_verified', result, at);
  }

  const learned = await getLearning();
  const score = FiggieJournal.scoreRound(journal);
  if (!journal.practice && score && !learned.scored.includes(journal.id)) {
    recordRoundScore(journal, learned, score, at);
    learnStyles(session, learned, result.goal);
    addRates(learned.rates, journal.rates);
    scoreFillsOnce(session, learned);
    save(session, learned);
  }
  if (scoreBonusOnce(session, learned, at)) save(session, learned);
  save(session);
  await store.flush();
}

// The DOM can reveal rankings just before its final balance snapshot. Keep that
// observation durable, then reconcile it after the matching ended state arrives.
function deferSettlement(session, result, at) {
  const journal = session.journal;
  if (JSON.stringify(journal.pendingSettlement?.result) === JSON.stringify(result)) return;
  journal.pendingSettlement = { result: JSON.parse(JSON.stringify(result)), at };
  journal.append('settlement_pending', { result }, at);
}

async function settlePending(session) {
  const journal = session.journal;
  const pending = journal.pendingSettlement;
  if (!pending || journal.previous?.status !== 'ended') return;
  const result = pending.result;
  // Keep waiting: the matching final balances may not have been observed yet.
  if (isOfficial(result) && !officialResultMatches(journal, result)) return;
  const invalid =
    !validGoal(result) ||
    goalConflicts(journal, result) ||
    officialProfitsConflict(journal, result);
  if (invalid) {
    journal.append(
      'settlement_rejected',
      { reason: 'Invalid or conflicting round result' },
      pending.at,
    );
  } else {
    await settle(session, result, pending.at);
  }
  journal.pendingSettlement = null;
  journal.dirty = true;
  save(session);
}

// ── Practice ─────────────────────────────────────────────────────────────

function recordPracticeExposure(session, data, at) {
  const journal = session.journal;
  const previous = journal.previous;
  if (
    !data.roundKey ||
    data.roundKey !== previous?.roundKey ||
    !['live', 'paused'].includes(previous.status)
  ) {
    return;
  }
  journal.markPractice(
    { ...previous, context: { ...previous.context, learningExposure: true } },
    at,
  );
  journal.append('training_exposure', { ...data, practice: true }, at);
}

// Finds the recorded snapshot, with its visible hands, that a practice
// checkpoint was taken from: the same round, trade count, and source revision.
function findPracticeSnapshot(
  journal,
  { tradeCount, roundKey, beforeSeq = Infinity, sourceRevision = null, beforeAt = Infinity },
) {
  const matches = (snapshot) =>
    snapshot &&
    snapshot.roundKey === roundKey &&
    snapshot.trades?.length === tradeCount &&
    (sourceRevision === null || snapshot.analysisRevision === sourceRevision) &&
    (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt <= beforeAt) &&
    FiggieJournal.visiblePractice(snapshot) &&
    snapshot.training?.valid === true;
  if (beforeSeq === Infinity && matches(journal.previous)) {
    return FiggieJournal.clean(journal.previous);
  }
  const event = journal.events.findLast(
    (candidate) => candidate.seq < beforeSeq && matches(candidate.snapshot),
  );
  return event ? FiggieJournal.clean(event.snapshot) : null;
}

// A locked prediction freezes its checkpoint: the blind model at that moment
// and the source snapshot the exact answer will later be computed from.
function freezePrediction(session, data, checkpointAt) {
  const journal = session.journal;
  const model = session.lastModel;
  const serverBlindModel = model
    ? {
        modelVersion: model.version,
        computedAt: session.lastComputedAt,
        probabilities: model.bySuit.map((suit) => suit.probability),
        goalScenarios: model.roundPnl?.goalScenarios,
      }
    : null;
  const snapshot = findPracticeSnapshot(journal, {
    tradeCount: data.tradeCount ?? journal.previous.trades.length,
    roundKey: data.roundKey || journal.previous.roundKey,
    sourceRevision: data.sourceRevision ?? null,
    beforeAt: checkpointAt,
  });
  if (snapshot) {
    journal.trainingCheckpoints[checkpointAt] = { snapshot };
    const checkpoints = Object.keys(journal.trainingCheckpoints);
    for (const key of checkpoints.slice(0, -MAX_TRAINING_CHECKPOINTS)) {
      delete journal.trainingCheckpoints[key];
    }
  }
  return {
    serverBlindModel,
    checkpointCaptured: Boolean(snapshot),
    checkpointSourceRevision: snapshot?.analysisRevision ?? null,
  };
}

// A peek computes the exact answer for the frozen checkpoint and scores the
// user's locked prediction and the blind model against it.
function revealPracticeTruth(journal, checkpointAt) {
  journal.practicePeeked = true;
  const prediction = journal.events.findLast(
    (event) => event.kind === 'training_prediction' && event.checkpointAt === checkpointAt,
  );
  const blindProbabilities =
    prediction?.blindProbabilities || prediction?.serverBlindModel?.probabilities;
  let frozenSnapshot = journal.trainingCheckpoints[checkpointAt]?.snapshot;
  if (!frozenSnapshot && prediction) {
    frozenSnapshot = findPracticeSnapshot(journal, {
      tradeCount: prediction.tradeCount,
      roundKey: prediction.roundKey,
      beforeSeq: prediction.seq,
      sourceRevision: prediction.sourceRevision ?? null,
      beforeAt: prediction.checkpointAt,
    });
  }
  const frozenModel = prediction
    ? { bySuit: (blindProbabilities || []).map((probability) => ({ probability })) }
    : null;
  const trainingTruth = frozenSnapshot
    ? FiggieTraining.analyze(frozenSnapshot, frozenModel)
    : {
        available: false,
        reason: 'The recorded source for this frozen checkpoint is unavailable.',
      };
  if (!trainingTruth.available || !prediction) return { trainingTruth };
  return {
    trainingTruth,
    trainingScores: {
      predictionSeq: prediction.seq,
      afterPeek: prediction.afterPeek,
      user: FiggieTraining.scorePrediction(
        prediction.userProbabilities || prediction.probabilities,
        trainingTruth.exactGoal,
      ),
      blind: FiggieTraining.scorePrediction(blindProbabilities, trainingTruth.exactGoal),
    },
  };
}

function recordTrainingEvent(session, kind, data, at) {
  const journal = session.journal;
  const previous = journal.previous;
  if (
    !previous ||
    (data.roundKey && data.roundKey !== previous.roundKey) ||
    (!journal.practice && !FiggieJournal.visiblePractice(previous))
  ) {
    return;
  }
  if (!journal.practice) {
    journal.practice = true;
    journal.practiceSince = at;
    journal.append('practice_mode', { practice: true, source: 'Training interaction' }, at);
  }
  const checkpointAt = data.checkpointAt ?? data.at ?? at;
  const payload = {
    ...data,
    checkpointAt,
    practice: true,
    afterPeek: Boolean(journal.practicePeeked || data.afterPeek),
    serverCheckpoint: {
      roundKey: previous.roundKey,
      tradeCount: previous.trades.length,
      timer: previous.timer,
    },
  };
  if (kind === 'training_prediction') {
    Object.assign(payload, freezePrediction(session, data, checkpointAt));
  }
  if (kind === 'training_peek') Object.assign(payload, revealPracticeTruth(journal, checkpointAt));
  journal.append(kind, payload, at);
}

// ── Recording ────────────────────────────────────────────────────────────

// Content scripts resend unacknowledged events; each stream's cursor skips repeats.
const alreadyRecorded = (session, item) =>
  item.stream && (session.journal.cursors[item.stream] || 0) >= item.seq;

function markRecorded(session, item) {
  if (item.stream) session.journal.cursors[item.stream] = item.seq;
}

// Applies an observation to its round's journal. If the page contradicts the
// recorded history, that segment is closed and a new one starts from here.
async function recordObservation(tab, session, item) {
  try {
    session.journal.observe(item.snapshot, item.at);
    return session;
  } catch (error) {
    session.journal.append('coverage', { reason: error.message, status: 'history-reset' }, item.at);
    save(session);
    const interrupted = session.journal;
    sessions.delete(tab);
    const restarted = await sessionFor(tab, item.snapshot);
    if (interrupted.base === restarted.journal.base) {
      inheritPractice(restarted.journal, interrupted, item.at);
    }
    restarted.journal.observe(item.snapshot, item.at);
    return restarted;
  }
}

async function recordEvent(session, item) {
  const data = item.data || {};
  if (item.kind === 'reveal') {
    deferSettlement(session, item.result, item.at);
    if (roundEnded(session)) await settlePending(session);
  } else if (item.kind === 'training_exposure') {
    recordPracticeExposure(session, data, item.at);
  } else if (TRAINING_EVENT_KINDS.includes(item.kind)) {
    recordTrainingEvent(session, item.kind, data, item.at);
  } else if (item.kind === 'gap') {
    session.journal.gap(item.status, item.reason, item.at);
  } else {
    session.journal.command(item.kind, data, item.at);
  }
}

// ── Messages ─────────────────────────────────────────────────────────────

async function handleRecord(message, tab) {
  let session = sessions.get(tab);
  for (const item of message.batch || []) {
    if (session && alreadyRecorded(session, item)) continue;
    if (item.kind === 'observe') {
      session = await sessionFor(tab, item.snapshot);
      if (alreadyRecorded(session, item)) continue;
      session = await recordObservation(tab, session, item);
      markRecorded(session, item);
      save(session);
      await resumeModels(tab, session);
      if (roundEnded(session)) await settlePending(session);
    } else if (session) {
      await recordEvent(session, item);
      markRecorded(session, item);
      save(session);
    }
  }
  if (roundEnded(session)) {
    await settlePending(session);
    const learned = await getLearning();
    if (scoreFillsOnce(session, learned)) save(session, learned);
  }
  const recording = session ? journalSummary(session) : {};
  return {
    completion: store.flush().then(() => ({ recording: { ...recording, ...store.status() } })),
  };
}

async function handleModel(message, tab) {
  const job = message.job;
  const snapshot = job.snapshot;
  if (snapshot.recordingRequired && Number.isFinite(snapshot.analysisRevision)) {
    const readiness = modelReadiness(sessions.get(tab), snapshot);
    if (readiness === 'waiting') return waitForObservation(tab, job);
    if (readiness === 'superseded') return supersededResponse(job);
  }
  const session = await sessionFor(tab, snapshot);
  const unobserved =
    !session.journal.previous || session.journal.previous.signature !== snapshot.signature;
  if (!snapshot.recordingRequired && unobserved) {
    session.journal.observe(snapshot, snapshot.observedAt || Date.now());
  }
  const model = await analyze(session, job, Date.now());
  return modelResponse(session, job, model);
}

async function handleReveal(message, tab) {
  if (!validGoal(message.result)) throw Error('Choose a valid revealed goal suit');
  let session = sessions.get(tab);
  if (message.roundId && session?.journal.id !== message.roundId) {
    session = await restoreSession(message.roundId);
  }
  if (!session) throw Error('No recorded round');
  if (!roundEnded(session)) throw Error('Record the revealed goal after the round ends.');
  await settle(session, message.result, Date.now());
  return { recording: recordingSummary(session), metrics: (await getLearning()).metrics };
}

async function handleRecordStatus(message, tab) {
  const session = sessions.get(tab);
  await store.flush();
  return {
    recording: session ? recordingSummary(session) : store.status(),
    metrics: (await getLearning()).metrics,
  };
}

async function handleRounds() {
  await store.flush();
  const rounds = [];
  for (const record of (await store.all('rounds')).sort(byMostRecent)) {
    const accounting =
      record.accounting ||
      FiggiePnl.restore(
        await store.events(record.id),
        record.snapshot,
        record.observedAt || record.updatedAt,
      );
    rounds.push({
      id: record.id,
      practice: FiggieJournal.isPractice(record),
      practicePeeked: record.practicePeeked === true,
      self: record.self,
      round: record.snapshot?.round,
      ended: record.snapshot?.status === 'ended',
      updatedAt: record.updatedAt,
      goal: record.revealed?.goal,
      pnl: record.snapshot
        ? FiggiePnl.summary(record.snapshot, null, accounting, record.revealed)
        : null,
    });
  }
  return { rounds };
}

const exportFilename = () =>
  'figgie-recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.ndjson';

// `all` exports every round (null); otherwise the named round, or the tab's current one.
const exportRoundId = (message, tab) =>
  message.roundId === 'all' ? null : message.roundId || sessions.get(tab)?.journal.id;

async function handleExport(message, tab) {
  await store.flush();
  return {
    text: await store.export(exportRoundId(message, tab)),
    filename: exportFilename(),
  };
}

function handleExportStart(message, tab) {
  for (const [owner, job] of exportsByTab) {
    if (Date.now() - job.at > EXPORT_LIFETIME_MS) exportsByTab.delete(owner);
  }
  const roundId = exportRoundId(message, tab);
  if (message.roundId !== 'all' && !roundId) throw Error('Choose a recorded round to export');
  const exportId = crypto.randomUUID();
  exportsByTab.set(tab, {
    id: exportId,
    iterator: store.exportChunks(roundId),
    next: 0,
    last: null,
    at: Date.now(),
  });
  return { exportId, filename: exportFilename() };
}

async function handleExportChunk(message, tab) {
  const job = exportsByTab.get(tab);
  if (!job || job.id !== message.exportId || Date.now() - job.at > EXPORT_LIFETIME_MS) {
    throw Error('Export expired. Please export again.');
  }
  if (!Number.isSafeInteger(message.index) || message.index < 0) {
    throw Error('Invalid export position');
  }
  // A repeated request for the last chunk is a retry; answer it again.
  if (job.last?.index === message.index) return job.last;
  if (message.index !== job.next) throw Error('Export position changed. Please export again.');
  const item = await job.iterator.next();
  job.at = Date.now();
  job.next++;
  job.last = { index: message.index, text: item.value || '', done: item.done };
  return job.last;
}

function handleExportClose(message, tab) {
  if (exportsByTab.get(tab)?.id === message.exportId) exportsByTab.delete(tab);
  return { ok: true };
}

function handleRatingObservation(message) {
  const observation = FiggieRatings.validate(message.observation);
  if (!observation) throw Error('Invalid visible rating observation');
  return {
    completion: store
      .saveRatingObservation({ ...observation, kind: 'rating_observation' })
      .then(() => ({ ok: true, id: observation.id })),
  };
}

async function handleRatings() {
  return { ok: true, observations: await store.ratingObservations() };
}

const HANDLERS = {
  'figgie-record': handleRecord,
  'figgie-model': handleModel,
  'figgie-reveal': handleReveal,
  'figgie-record-status': handleRecordStatus,
  'figgie-rounds': handleRounds,
  'figgie-export': handleExport,
  'figgie-export-start': handleExportStart,
  'figgie-export-chunk': handleExportChunk,
  'figgie-export-close': handleExportClose,
  'figgie-rating-observation': handleRatingObservation,
  'figgie-ratings': handleRatings,
};

/* Each tab's messages run one at a time, in arrival order. A handler may
   return `{ completion }`: the queue then moves on to the tab's next message
   while the reply waits for that promise, such as a disk commit or a model
   whose observation has not been recorded yet. */
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    !Object.hasOwn(HANDLERS, message?.type) ||
    sender.id !== chrome.runtime.id ||
    !FIGGIE_PLAY_URL.test(sender.tab?.url || '')
  ) {
    return false;
  }
  const tab = sender.tab.id;
  const previous = messageQueues.get(tab) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => HANDLERS[message.type](message, tab));
  messageQueues.set(tab, task);
  task
    .then((result) => result?.completion || result)
    .then(reply, (error) => reply(errorResponse(message.job?.id, error)));
  return true;
});
