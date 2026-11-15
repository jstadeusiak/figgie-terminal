#!/usr/bin/env node
'use strict';

/*
 * Offline replay check for an exported recording.
 *
 * For every recorded prediction, this rebuilds the round from the events that
 * came before it, re-runs the engine version that made the prediction, and
 * measures how far the replayed goal probabilities are from the recorded ones.
 * The model is given only the information that was available at each recorded
 * prediction. No network.
 *
 * Usage: node extension/replay.cjs recording.ndjson
 *
 * Prints a JSON report with one entry per round. Exits with status 2 if the
 * replay error of any round exceeds 1e-8.
 */

const fs = require('node:fs');

// Load order matters. These files double as browser scripts: each registers
// itself on globalThis and binds to whatever is already registered there when
// it loads. So belief.js loads before any versioned model fit, and training.js
// before the versioned engines replace the current one in that registry.
const { BeliefEngine, VERSION } = require('./belief.js');
const Training = require('./training.js');
const { BeliefEngine: V12Engine } = require('./belief-v0.12.js');
const { BeliefEngine: V11Engine } = require('./belief-v0.11.js');
const { BeliefEngine: V10Engine } = require('./belief-v0.10.js');
const { BeliefEngine: V09Engine } = require('./belief-v0.9.js');
const { BeliefEngine: V08Engine } = require('./belief-v0.8.js');
const { BeliefEngine: V07Engine } = require('./belief-v0.7.js');
const { BeliefEngine: V06Engine } = require('./belief-v0.6.js');
const { BeliefEngine: V05Engine } = require('./belief-v0.5.js');
const { BeliefEngine: V04Engine } = require('./belief-v0.4.js');
const { BeliefEngine: V03Engine } = require('./belief-v0.3.js');
const Journal = require('./journal.js');
const JournalV10 = require('./journal-v0.10.js');
const JournalV11 = require('./journal-v0.11.js');
const JournalV12 = require('./journal-v0.12.js');

const USAGE = 'Usage: node replay.cjs recording.ndjson';
const EXIT_USAGE = 1;
const EXIT_REPLAY_MISMATCH = 2;
const REPLAY_ERROR_TOLERANCE = 1e-8;

// A prediction recorded without a model version is replayed as this one.
const UNSTAMPED_MODEL_VERSION = '0.3.0';

const ENGINE_CLASSES = {
  current: BeliefEngine,
  v03: V03Engine,
  v04: V04Engine,
  v05: V05Engine,
  v06: V06Engine,
  v07: V07Engine,
  v08: V08Engine,
  v09: V09Engine,
  v10: V10Engine,
  v11: V11Engine,
  v12: V12Engine,
};

// How to reproduce a prediction, by the model version that recorded it: the
// engine that inferred it, the journal that rebuilds its evidence, and whether
// the model input is blinded first (versions 0.9 to 0.13).
const REPLAY_RULES = [
  { versions: /^0\.[23]\./, engine: 'v03', Journal: JournalV10, blind: false },
  { versions: /^0\.4\./, engine: 'v04', Journal: JournalV10, blind: false },
  { versions: /^0\.5\./, engine: 'v05', Journal: JournalV10, blind: false },
  { versions: /^0\.6\./, engine: 'v06', Journal: JournalV10, blind: false },
  { versions: /^0\.7\./, engine: 'v07', Journal: JournalV10, blind: false },
  { versions: /^0\.8\./, engine: 'v08', Journal: JournalV10, blind: false },
  { versions: /^0\.9\./, engine: 'v09', Journal: JournalV10, blind: true },
  { versions: /^0\.10\./, engine: 'v10', Journal: JournalV10, blind: true },
  { versions: /^0\.11\./, engine: 'v11', Journal: JournalV11, blind: true },
  { versions: /^0\.12\./, engine: 'v12', Journal: JournalV12, blind: true },
  { versions: /^0\.13\./, engine: 'current', Journal, blind: true },
];
const FALLBACK_RULE = { engine: 'current', Journal, blind: false };

const RATE_SIDES = ['bid', 'ask'];
const RATE_COUNTERS = ['fills', 'exposure', 'outbids'];
const NO_RATES = {
  bid: { fills: 0, exposure: 0, outbids: 0 },
  ask: { fills: 0, exposure: 0, outbids: 0 },
  resets: 0,
  liveSeconds: 0,
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const bySeq = (a, b) => a.seq - b.seq;

const replayRuleFor = (modelVersion) =>
  REPLAY_RULES.find((rule) => rule.versions.test(modelVersion)) || FALLBACK_RULE;

function readRows(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw Error(`Invalid NDJSON at line ${index + 1}`);
      }
    });
}

// Groups rows into rounds, in order of first appearance. A round's last
// metadata row wins; rows that belong to no round are ignored.
function groupByRound(rows) {
  const rounds = new Map();
  const roundFor = (id) => {
    if (!rounds.has(id)) rounds.set(id, { id, events: [] });
    return rounds.get(id);
  };
  for (const row of rows) {
    if (row.kind === 'round_metadata') {
      roundFor(row.id).metadata = row;
    } else if (row.roundId) {
      roundFor(row.roundId).events.push(row);
    }
  }
  return [...rounds.values()];
}

// Engines keep state between inferences, so every round gets a fresh set.
function createEngines() {
  return Object.fromEntries(
    Object.entries(ENGINE_CLASSES).map(([name, Engine]) => [name, new Engine()]),
  );
}

// Practice recordings retain the exact model source. Older workers could
// infer with an unknown difficulty while the journal retained the last known
// difficulty; replay that saved input, still stripping every private field.
const isExactSource = (source, prediction, snapshot) =>
  source?.kind === 'training_source' &&
  source.at === prediction.at &&
  source.snapshot?.roundKey === snapshot.roundKey &&
  source.snapshot?.trades?.length === prediction.tradeCount;

// The fill statistics the model was given: the learned prior plus, outside
// practice, what the round itself had observed by the time of the prediction.
function ratesAt(prior, prediction) {
  const rates = clone(prior.rates || NO_RATES);
  if (prediction.rates && !prediction.practice) {
    for (const side of RATE_SIDES) {
      for (const counter of RATE_COUNTERS) {
        rates[side][counter] += prediction.rates[side][counter];
      }
    }
    rates.resets += prediction.rates.resets;
    rates.liveSeconds += prediction.rates.liveSeconds;
  }
  return rates;
}

function largestDifference(replayed, recorded) {
  let largest = 0;
  replayed.forEach((probability, index) => {
    largest = Math.max(largest, Math.abs(probability - recorded[index]));
  });
  return largest;
}

// Re-runs the model for one recorded prediction from the events before it.
// Returns null when those events do not yet describe a round.
function replayPrediction(round, priorEvents, prediction, engines) {
  const snapshot = Journal.replay(priorEvents);
  if (!snapshot) return null;

  const rule = replayRuleFor(prediction.modelVersion || UNSTAMPED_MODEL_VERSION);
  const source = priorEvents.at(-1);
  const usedExactSource = rule.blind && isExactSource(source, prediction, snapshot);
  const inferenceSnapshot = usedExactSource ? source.snapshot : snapshot;

  const prior = priorEvents.findLast((event) => event.kind === 'learning_prior')?.learning || {};
  const learning = { ...prior, rates: ratesAt(prior, prediction) };
  const journal = rule.Journal.restore(
    {
      id: round.id,
      base: round.metadata?.base,
      snapshot,
      observedAt: prediction.at,
      rates: prediction.rates,
    },
    priorEvents,
  );
  const model = engines[rule.engine].infer(
    rule.blind ? Training.blindSnapshot(inferenceSnapshot) : inferenceSnapshot,
    journal.evidence,
    learning,
  );
  return {
    usedExactSource,
    error: largestDifference(model.scoringProbabilities, prediction.probabilities),
    computeMs: model.computeMs,
  };
}

function replayRound(round) {
  const events = round.events.sort(bySeq);
  const engines = createEngines();
  let predictionsChecked = 0;
  let sourceSnapshotsChecked = 0;
  let maxError = 0;
  let totalComputeMs = 0;

  for (const [index, event] of events.entries()) {
    if (event.kind !== 'prediction') continue;
    const replayed = replayPrediction(round, events.slice(0, index), event, engines);
    if (!replayed) continue;
    predictionsChecked++;
    if (replayed.usedExactSource) sourceSnapshotsChecked++;
    maxError = Math.max(maxError, replayed.error);
    totalComputeMs += replayed.computeMs;
  }

  // The whole round, with its revealed goal if one was recorded, for scoring.
  const journal = Journal.restore(
    {
      ...round.metadata,
      id: round.id,
      snapshot: Journal.replay(events),
      revealed: events.find((event) => event.kind === 'reveal'),
    },
    events,
  );
  return {
    roundId: round.id,
    events: events.length,
    predictionsChecked,
    sourceSnapshotsChecked,
    maxProbabilityReplayError: maxError,
    meanComputeMs: predictionsChecked ? totalComputeMs / predictionsChecked : null,
    score: Journal.scoreRound(journal),
    coverage: events.filter((event) => event.kind === 'coverage').length,
  };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }
  const rounds = groupByRound(readRows(file));
  const report = rounds.map(replayRound);
  console.log(JSON.stringify({ version: VERSION, rounds: report }, null, 2));
  if (report.some((round) => round.maxProbabilityReplayError > REPLAY_ERROR_TOLERANCE)) {
    process.exitCode = EXIT_REPLAY_MISMATCH;
  }
}

main();
