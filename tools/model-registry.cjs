#!/usr/bin/env node
'use strict';

/*
 * Model registry: immutable, self-contained model releases for comparisons on
 * growing datasets.
 *
 * Each release is a folder models/VERSION holding one engine and its support
 * files. models/registry.json records a SHA-256 for every archived file, so a
 * release can be verified, loaded in isolation and replayed over recorded
 * rounds long after the live source has moved on.
 *
 * Usage:
 *   node tools/model-registry.cjs list
 *   node tools/model-registry.cjs verify [VERSION]
 *   node tools/model-registry.cjs snapshot VERSION NOTE
 *   node tools/model-registry.cjs compare VERSION_A VERSION_B EXPORT.ndjson [MORE_EXPORTS.ndjson]
 *                                        [--split MANIFEST.json --partition NAME]
 *
 * Every command prints JSON. The same operations are exported for scripts.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'models');
const REGISTRY_FILE = path.join(ARCHIVE_DIR, 'registry.json');
const RUNTIME_DIR = path.join(ROOT_DIR, 'extension');

const REGISTRY_SCHEMA = 1;
const REPORT_SCHEMA = 2;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const GOAL_SIGNAL_FILE = 'goal-signal.js';
const HISTORICAL_FIT_FILE = 'model-fit-v0.10.js';

const SUIT_IDS = ['s', 'c', 'd', 'h'];
const OFFICIAL_RESULT_SOURCE = 'official-round-rankings';
const PAYOUT_PER_GOAL_CARD = 10;

const PROBABILITY_TOLERANCE = 1e-9;
const PROBABILITY_SUM_TOLERANCE = 1e-6;
const LOG_LOSS_PROBABILITY_FLOOR = 1e-12;

// Fixed wording embedded in every comparison report.
const REPORT_SCOPE =
  'Paired retrospective replay on official complete non-practice rounds. Displayed goal probabilities and conditional settle-now bonus scored separately. Equal round weighting; historical priors come only from each prediction prefix.';
const EV_NOT_SCORED_REASON =
  'Concealed-hand recordings do not consistently identify every named counterparty inventory at every action. No counterfactual fill, action EV, realized strategy profit, or alternative trading-policy return is scored. Bonus errors use only identifiable official-payout-derived labels; final profit is not an EV label.';
const BONUS_METHOD =
  'Equal round weighting. Official settlement plus reversed public fills identifies forecast-time inventory; ambiguous labels are excluded.';
const SPLIT_SCOPE =
  'Manifest selects round identities only; actual input data has its own datasetSha256.';

const USAGE =
  'Usage: node tools/model-registry.cjs list | verify [VERSION] | snapshot VERSION NOTE | compare VERSION_A VERSION_B EXPORT.ndjson [MORE_EXPORTS.ndjson]';
const COMPARE_USAGE =
  'compare VERSION_A VERSION_B EXPORT.ndjson [MORE_EXPORTS.ndjson] [--split MANIFEST.json --partition NAME]';

// ── Small helpers ────────────────────────────────────────────────────────

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const sum = (numbers) => numbers.reduce((total, number) => total + number, 0);
const mean = (numbers) => (numbers.length ? sum(numbers) / numbers.length : null);

const byId = (a, b) => a.id.localeCompare(b.id);
const bySeq = (a, b) => a.seq - b.seq;
// Numeric-aware, so that 0.10.0 sorts after 0.9.0.
const byVersion = (a, b) => a.version.localeCompare(b.version, undefined, { numeric: true });

const withSortedKeys = (object) =>
  Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, object[key]]),
  );

// JSON with object keys sorted at every level, so equal content hashes equally
// whatever order its keys were written in.
function stableJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? withSortedKeys(item) : item,
  );
}

function requireVersionFormat(version) {
  if (!VERSION_PATTERN.test(version)) throw Error('Version must be major.minor.patch');
  return version;
}

// ── Registry: read, verify, snapshot ─────────────────────────────────────

function readRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return { schema: REGISTRY_SCHEMA, models: [] };
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
}

const bundleHash = (files) => sha256(JSON.stringify(files));

// Checks one version, or every version, against the recorded hashes and
// returns the matching registry entries.
function verify(version) {
  const entries = readRegistry().models.filter((entry) => !version || entry.version === version);
  if (version && !entries.length) throw Error(`Unknown model ${version}`);
  for (const entry of entries) verifyEntry(entry);
  return entries;
}

function verifyEntry(entry) {
  for (const [name, expectedHash] of Object.entries(entry.files)) {
    const file = path.join(ARCHIVE_DIR, entry.version, name);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expectedHash) {
      throw Error(`Archived model changed: ${entry.version}/${name}`);
    }
  }
  if (bundleHash(entry.files) !== entry.bundleSha256) {
    throw Error(`Archive manifest changed: ${entry.version}`);
  }
}

// Archives the current runtime sources as an immutable release. Repeating a
// snapshot of unchanged sources returns the existing entry.
function snapshot(version, options = {}) {
  requireVersionFormat(version);
  const registry = readRegistry();
  const sources = snapshotSources(options);
  const fileHashes = {};
  for (const [name, file] of Object.entries(sources)) {
    fileHashes[name] = sha256(fs.readFileSync(file));
  }

  const existing = registry.models.find((entry) => entry.version === version);
  if (existing) {
    verify(version);
    if (JSON.stringify(existing.files) !== JSON.stringify(fileHashes)) {
      throw Error(`Version ${version} is immutable; choose a new version for changed behavior.`);
    }
    return existing;
  }

  const folder = path.join(ARCHIVE_DIR, version);
  if (fs.existsSync(folder)) throw Error(`Unregistered archive directory exists: ${folder}`);
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, file] of Object.entries(sources)) {
    fs.copyFileSync(file, path.join(folder, name));
  }

  const entry = {
    version,
    frozenAt: new Date().toISOString(),
    description: options.note || '',
    provenance: options.historical
      ? 'Previously frozen engine; compatible support files archived now.'
      : 'Complete source snapshot at release.',
    files: fileHashes,
    bundleSha256: bundleHash(fileHashes),
  };
  registry.models.push(entry);
  registry.models.sort(byVersion);
  fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`);
  return entry;
}

const runtimeFile = (name) => path.join(RUNTIME_DIR, name);

// Maps each archived file name to the source file it is copied from.
function snapshotSources(options) {
  const sources = {
    'belief.js': options.engine || runtimeFile('belief.js'),
    'journal.js': options.journal || runtimeFile('journal.js'),
    'model-fit.js': options.fit || runtimeFile('model-fit.js'),
    'pnl.js': runtimeFile('pnl.js'),
    'training.js': runtimeFile('training.js'),
    'bonus-score.js': runtimeFile('bonus-score.js'),
  };
  // Earlier standalone replay engines explicitly reference this frozen fit.
  if (options.historical) sources[HISTORICAL_FIT_FILE] = runtimeFile(HISTORICAL_FIT_FILE);
  // Newer engines use this pure numerical dependency. Archive it with the
  // engine, while leaving historical six-file manifests unchanged.
  const engineFile = sources['belief.js'];
  if (fs.readFileSync(engineFile, 'utf8').includes(`require('./${GOAL_SIGNAL_FILE}')`)) {
    sources[GOAL_SIGNAL_FILE] =
      options.goalSignal || path.join(path.dirname(engineFile), GOAL_SIGNAL_FILE);
  }
  return sources;
}

// ── Isolated loading of an archived release ──────────────────────────────

// Verifies a release, then runs it in its own vm context and returns its
// modules. Two loads of the same version share no state.
function load(version) {
  const [entry] = verify(requireVersionFormat(version));
  const requireArchived = createArchiveRequire(entry);
  const Belief = requireArchived('./belief.js');
  const Journal = requireArchived('./journal.js');
  const Training = requireArchived('./training.js');
  const Pnl = requireArchived('./pnl.js');
  const Bonus = requireArchived('./bonus-score.js');
  if (Belief.VERSION !== version) {
    throw Error(`Archived engine version mismatch: ${version} vs ${Belief.VERSION}`);
  }
  return { entry, Belief, Journal, Training, Pnl, Bonus };
}

// Builds the require() handed to archived code. This is the registry's security
// and reproducibility boundary: archived code runs in a fresh vm context that
// exposes only the host objects listed below, and it may only require files
// that are relative, inside its own archive folder, and listed in the manifest
// that verify() has just checked.
function createArchiveRequire(entry) {
  const folder = path.join(ARCHIVE_DIR, entry.version);
  const loadedModules = new Map();
  const context = vm.createContext({
    console,
    performance,
    Date,
    setTimeout,
    clearTimeout,
    crypto: crypto.webcrypto,
  });

  function resolveDependency(name, fromDir) {
    if (!name.startsWith('./') && !name.startsWith('../')) {
      throw Error(`Unexpected model dependency: ${name}`);
    }
    const file = path.resolve(fromDir, name);
    if (!file.startsWith(folder + path.sep)) throw Error('Dependency escapes model archive');
    const relative = path.relative(folder, file);
    if (!Object.hasOwn(entry.files, relative)) {
      throw Error(`Unverified model dependency: ${relative}`);
    }
    return file;
  }

  function requireArchived(name, fromDir = folder) {
    const file = resolveDependency(name, fromDir);
    if (loadedModules.has(file)) return loadedModules.get(file).exports;

    // Registered before it runs, so circular requires see the partial exports.
    const archivedModule = { exports: {} };
    loadedModules.set(file, archivedModule);
    const source = fs.readFileSync(file, 'utf8');
    // The same function wrapper Node puts around a CommonJS module.
    const run = new vm.Script(
      `(function(exports,require,module,__filename,__dirname){\n${source}\n})`,
      { filename: file },
    ).runInContext(context);
    const fileDir = path.dirname(file);
    run(
      archivedModule.exports,
      (dependency) => requireArchived(dependency, fileDir),
      archivedModule,
      file,
      fileDir,
    );
    return archivedModule.exports;
  }

  return requireArchived;
}

// ── Recorded datasets (NDJSON exports) ───────────────────────────────────

// Reads one or more exports into rounds, sorted by id. A round may be spread
// over several files, and an event may appear in more than one of them.
function readDataset(files) {
  const rounds = new Map();
  const sources = [];
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    sources.push({ path: path.resolve(file), bytes: bytes.length, sha256: sha256(bytes) });
    for (const [lineIndex, line] of bytes.toString('utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      const row = parseRow(line, file, lineIndex);
      const roundId = row.kind === 'round_metadata' ? row.id : row.roundId;
      if (!roundId) continue;
      if (!rounds.has(roundId)) {
        rounds.set(roundId, { id: roundId, events: new Map(), metadata: null });
      }
      const round = rounds.get(roundId);
      if (row.kind === 'round_metadata') {
        keepNewestMetadata(round, row);
      } else {
        addEvent(round, row, lineIndex);
      }
    }
  }

  const ordered = [...rounds.values()].sort(byId).map((round) => ({
    id: round.id,
    metadata: round.metadata,
    events: [...round.events.values()].sort(bySeq),
  }));
  return {
    rounds: ordered.filter((round) => round.metadata),
    missingMetadata: ordered.filter((round) => !round.metadata).map((round) => round.id),
    sources,
    datasetSha256: sha256(stableJson(ordered)),
  };
}

function rowsFrom(files) {
  return readDataset(files).rounds;
}

function parseRow(line, file, lineIndex) {
  try {
    return JSON.parse(line);
  } catch {
    throw Error(`${file}:${lineIndex + 1}: invalid NDJSON`);
  }
}

// A later export of a round supersedes an earlier one; a tie goes to the row
// read last.
function keepNewestMetadata(round, row) {
  if (!round.metadata || (row.updatedAt || 0) >= (round.metadata.updatedAt || 0)) {
    round.metadata = row;
  }
}

// Accepts an exact duplicate of an event already read and rejects a different
// event recorded under the same identity.
function addEvent(round, row, lineIndex) {
  const key = eventKey(row, lineIndex);
  const known = round.events.get(key);
  if (known && stableJson(known) !== stableJson(row)) {
    const label = row.id || `${round.id}:${row.seq}`;
    throw Error(`Conflicting recorded event ${label}`);
  }
  round.events.set(key, row);
}

function eventKey(row, lineIndex) {
  if (Number.isSafeInteger(row.seq)) return `seq:${row.seq}`;
  return row.id || `line:${lineIndex}`;
}

// Describes which rounds a comparison is restricted to: all of them, or the
// round ids of one named partition in a split manifest.
function splitSelection(options, rounds) {
  if (!options.splitFile && !options.partition) {
    return { mode: 'all-eligible', requestedRoundIds: null, sourceSha256: null };
  }
  if (!options.splitFile || !options.partition) {
    throw Error('Both splitFile and partition are required');
  }
  const bytes = fs.readFileSync(options.splitFile);
  const manifest = JSON.parse(bytes);
  const roundIds = manifest.partitions?.[options.partition];
  if (!isListOfUniqueStrings(roundIds)) {
    throw Error(`Invalid or missing split partition ${options.partition}`);
  }
  const presentIds = new Set(rounds.map((round) => round.id));
  return {
    mode: 'manifest',
    partition: options.partition,
    path: path.resolve(options.splitFile),
    sourceSha256: sha256(bytes),
    declaredDatasetSha256: manifest.datasetSha256 || null,
    requestedRoundIds: roundIds.slice(),
    missingRoundIds: roundIds.filter((id) => !presentIds.has(id)),
    scope: SPLIT_SCOPE,
  };
}

function isListOfUniqueStrings(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}

// ── Comparison: paired replay of several releases ────────────────────────

// Replays every eligible recorded round with each release and reports goal
// probability and bonus forecast accuracy on the checkpoints they share.
function compare(versions, files, options = {}) {
  if (!versions.length || new Set(versions).size !== versions.length) {
    throw Error('Supply distinct model versions');
  }
  const releases = versions.map(load);
  const dataset = readDataset(files);
  const split = splitSelection(options, dataset.rounds);
  const requestedIds = split.requestedRoundIds && new Set(split.requestedRoundIds);
  const isRequested = (roundId) => !requestedIds || requestedIds.has(roundId);
  const selectedRounds = dataset.rounds.filter((round) => isRequested(round.id));

  const excluded = dataset.missingMetadata
    .filter(isRequested)
    .map((id) => ({ id, reason: 'missing metadata' }));
  const included = [];
  const checkpointExclusions = [];
  for (const round of selectedRounds) {
    const evaluation = evaluateRound(round, releases);
    checkpointExclusions.push(...evaluation.checkpointExclusions);
    if (evaluation.exclusionReason) {
      excluded.push({ id: round.id, reason: evaluation.exclusionReason });
    } else {
      included.push(evaluation.scoredRound);
    }
  }

  return buildReport({
    versions,
    releases,
    dataset,
    split,
    selectedRoundCount: selectedRounds.length,
    included,
    excluded,
    checkpointExclusions,
  });
}

// Scores one round with every release, or says why the round is left out.
// Eligibility and checkpoints are decided once, by the first release's journal,
// so every release is scored on exactly the same checkpoints.
function evaluateRound(round, releases) {
  const journal = releases[0].Journal;
  const reason = exclusionReason(round, journal);
  if (reason) return { exclusionReason: reason, checkpointExclusions: [] };

  const predictions = journal.livePredictions(round.events);
  const goalIndex = SUIT_IDS.indexOf(round.metadata.revealed.goal);
  if (goalIndex < 0) return { exclusionReason: 'invalid goal', checkpointExclusions: [] };

  const { checkpoints, checkpointExclusions } = consistentCheckpoints(round, predictions, journal);
  if (!checkpoints.length) {
    return {
      exclusionReason: 'no consistent live pre-reveal predictions',
      checkpointExclusions,
    };
  }

  const scoredRound = {
    id: round.id,
    goal: round.metadata.revealed.goal,
    difficulty: round.metadata.snapshot?.context?.botDifficulty || 'unknown',
    results: releases.map((release) => replayRelease(release, round, checkpoints, goalIndex)),
  };
  return { scoredRound, checkpointExclusions };
}

function exclusionReason(round, journal) {
  const { metadata, events } = round;
  if (journal.isPractice(metadata, events)) return 'practice';
  if (!hasOfficialGoal(metadata)) return 'unverified goal';
  if (metadata.snapshot?.status !== 'ended') return 'not ended';
  if (!hasCompleteSequence(events)) return 'incomplete event sequence';
  return null;
}

const hasOfficialGoal = (metadata) =>
  Boolean(metadata.revealed?.verified) && metadata.revealed.source === OFFICIAL_RESULT_SOURCE;

const hasCompleteSequence = (events) =>
  events.length > 0 && events.every((event, index) => event.seq === index + 1);

// Keeps the live predictions whose recorded trade count agrees with the round
// state rebuilt from the events before them, and lists the ones that do not.
function consistentCheckpoints(round, predictions, journal) {
  const checkpoints = [];
  const checkpointExclusions = [];
  for (const prediction of predictions) {
    const priorEvents = round.events.filter((event) => event.seq < prediction.seq);
    const liveSnapshot = journal.replay(priorEvents);
    const isConsistent =
      liveSnapshot &&
      liveSnapshot.status === 'live' &&
      liveSnapshot.trades?.length === prediction.tradeCount;
    if (isConsistent) {
      checkpoints.push({ prediction, priorEvents, liveSnapshot });
    } else {
      checkpointExclusions.push({
        id: round.id,
        seq: prediction.seq,
        reason: 'live inventory/trade-count mismatch',
      });
    }
  }
  return { checkpoints, checkpointExclusions };
}

// Replays one release over the shared checkpoints of one round.
function replayRelease(release, round, checkpoints, goalIndex) {
  const engine = new release.Belief.BeliefEngine({ skipPricing: true });
  const points = [];
  const replayedScenarios = new Map();
  for (const checkpoint of checkpoints) {
    const replayed = replayCheckpoint(release, engine, round, checkpoint, goalIndex);
    points.push(replayed.point);
    replayedScenarios.set(checkpoint.prediction.seq, replayed.goalScenarios);
  }

  // Unreplayed stored forecasts must never be attributed to this release.
  const scoreEvents = round.events.map((event) =>
    event.kind === 'prediction'
      ? { ...event, goalScenarios: replayedScenarios.get(event.seq) || null }
      : event,
  );
  const bonus = release.Bonus.auditRound({ ...round.metadata, events: scoreEvents });
  return {
    roundId: round.id,
    version: release.entry.version,
    points,
    brier: mean(points.map((point) => point.brier)),
    logLoss: mean(points.map((point) => point.logLoss)),
    finalCorrect: points.at(-1).top === goalIndex,
    bonus,
  };
}

// Re-runs one release at one checkpoint. The model sees a blinded snapshot, the
// evidence from earlier events and the learning prior then in force; nothing
// recorded after the prediction can reach it.
function replayCheckpoint(release, engine, round, checkpoint, goalIndex) {
  const { prediction, priorEvents, liveSnapshot } = checkpoint;
  const blindSnapshot = release.Training.blindSnapshot(liveSnapshot);
  const lastPrior = priorEvents.findLast((event) => event.kind === 'learning_prior');
  const learning = clone(lastPrior?.learning || {});
  const journal = release.Journal.restore(
    {
      id: round.id,
      base: round.metadata.base,
      snapshot: blindSnapshot,
      observedAt: prediction.at,
      rates: prediction.rates,
    },
    priorEvents,
  );
  const model = engine.infer(blindSnapshot, journal.evidence, learning);
  const probabilities = goalProbabilities(model);
  const forecast = bonusForecast(release, blindSnapshot, model);
  return {
    goalScenarios: forecast.scenarios,
    point: {
      seq: prediction.seq,
      tradeCount: prediction.tradeCount,
      probabilities,
      brier: brierScore(probabilities, goalIndex),
      logLoss: -Math.log(Math.max(LOG_LOSS_PROBABILITY_FLOOR, probabilities[goalIndex])),
      top: probabilities.indexOf(Math.max(...probabilities)),
      goalConditionalBonus: forecast.scenarios[goalIndex]?.bonus ?? null,
      bonusForecastSource: forecast.source,
      computeMs: model.computeMs,
    },
  };
}

function brierScore(probabilities, goalIndex) {
  const squaredErrors = probabilities.map(
    (probability, suitIndex) => (probability - Number(suitIndex === goalIndex)) ** 2,
  );
  return sum(squaredErrors);
}

// The goal probabilities shown to the player, one per suit.
function goalProbabilities(model) {
  const probabilities = model.bySuit?.map((suit) => suit.probability);
  if (!isProbabilityVector(probabilities)) throw Error('Invalid displayed goal probabilities');
  // The engine ran in its own vm context; copy into an Array of this one.
  return Array.from(probabilities);
}

function isProbabilityVector(values) {
  return (
    Array.isArray(values) &&
    values.length === SUIT_IDS.length &&
    values.every(isProbability) &&
    Math.abs(sum(values) - 1) <= PROBABILITY_SUM_TOLERANCE
  );
}

const isProbability = (value) =>
  Number.isFinite(value) && value >= -PROBABILITY_TOLERANCE && value <= 1 + PROBABILITY_TOLERANCE;

// What the release forecasts for each suit, should that suit turn out to be the
// goal. The conditional bonus in these scenarios is what gets scored.
function bonusForecast(release, blindSnapshot, model) {
  // Older engines exposed expected holdings but no conditional fields. This
  // recovers their forecast algebraically, without using a revealed outcome.
  let derived = false;
  const bySuit = model.bySuit.map((suit, suitIndex) => {
    if (Number.isFinite(suit.conditionalBonus)) return suit;
    if (!(suit.probability > 0) || !Number.isFinite(suit.holding)) return suit;
    derived = true;
    const conditionalPayout = suit.holding / suit.probability;
    const heldPayout = PAYOUT_PER_GOAL_CARD * blindSnapshot.held[suitIndex];
    return {
      ...suit,
      conditionalPayout,
      conditionalBonus: Math.max(0, conditionalPayout - heldPayout),
    };
  });
  return {
    scenarios: release.Pnl.summary(blindSnapshot, { ...model, bySuit }).goalScenarios,
    source: derived
      ? 'expected holding / goal probability; category probabilities unavailable where absent'
      : 'native conditional payout',
  };
}

function buildReport({
  versions,
  releases,
  dataset,
  split,
  selectedRoundCount,
  included,
  excluded,
  checkpointExclusions,
}) {
  const appliedCohort = included.map((round) => ({
    id: round.id,
    checkpoints: round.results[0].points.map((point) => point.seq),
  }));
  return {
    schema: REPORT_SCHEMA,
    evaluatedAt: new Date().toISOString(),
    runnerSha256: sha256(fs.readFileSync(__filename)),
    sources: dataset.sources,
    datasetSha256: dataset.datasetSha256,
    split: {
      ...split,
      appliedRoundIds: included.map((round) => round.id),
      appliedSha256: sha256(stableJson(appliedCohort)),
    },
    models: releases.map(({ entry }) => ({
      version: entry.version,
      bundleSha256: entry.bundleSha256,
      files: entry.files,
    })),
    scope: REPORT_SCOPE,
    coverage: {
      inputRounds: dataset.rounds.length + dataset.missingMetadata.length,
      selectedBySplit: selectedRoundCount,
      includedRounds: included.length,
      excludedRounds: excluded.length,
      sharedCheckpoints: sum(appliedCohort.map((round) => round.checkpoints.length)),
      checkpointExclusions,
    },
    ev: { scored: false, checkpoints: 0, reason: EV_NOT_SCORED_REASON },
    summary: versions.map((version) => summarize(version, included)),
    byDifficulty: summarizeByDifficulty(versions, included),
    excluded,
    rounds: included,
  };
}

function summarizeByDifficulty(versions, rounds) {
  const difficulties = [...new Set(rounds.map((round) => round.difficulty))];
  return Object.fromEntries(
    difficulties.map((difficulty) => {
      const sameDifficulty = rounds.filter((round) => round.difficulty === difficulty);
      return [difficulty, versions.map((version) => summarize(version, sameDifficulty))];
    }),
  );
}

// Aggregates one release's results over the given rounds.
function summarize(version, rounds) {
  const results = rounds
    .map((round) => round.results.find((result) => result.version === version))
    .filter((result) => result?.points.length);
  const bonusScores = results.map((result) => result.bonus?.score).filter(Boolean);
  const meanOfFinite = (key) =>
    mean(bonusScores.map((score) => score[key]).filter(Number.isFinite));
  return {
    version,
    rounds: results.length,
    checkpoints: sum(results.map((result) => result.points.length)),
    brier: mean(results.map((result) => result.brier)),
    logLoss: mean(results.map((result) => result.logLoss)),
    finalCorrect: results.filter((result) => result.finalCorrect).length,
    bonus: {
      rounds: bonusScores.length,
      checkpoints: sum(bonusScores.map((score) => score.checkpoints)),
      mae: meanOfFinite('bonusMae'),
      bias: meanOfFinite('bonusBias'),
      categoryBrier: meanOfFinite('categoryBrier'),
      leaderBrier: meanOfFinite('leaderBrier'),
      categoryCheckpoints: sum(bonusScores.map((score) => score.categoryCheckpoints || 0)),
      ambiguousCheckpoints: sum(bonusScores.map((score) => score.ambiguousCheckpoints || 0)),
      excludedRounds: results
        .filter((result) => !result.bonus?.score)
        .map((result) => ({ id: result.roundId, reason: result.bonus?.reason || 'unavailable' })),
      method: BONUS_METHOD,
    },
  };
}

// ── Command line ─────────────────────────────────────────────────────────

function listCommand() {
  return readRegistry().models.map(({ version, frozenAt, description, bundleSha256 }) => ({
    version,
    frozenAt,
    description,
    bundleSha256,
  }));
}

function verifyCommand([version]) {
  return { verified: verify(version).map((entry) => entry.version) };
}

function snapshotCommand([version, ...noteWords]) {
  return snapshot(version, { note: noteWords.join(' ') });
}

function compareCommand(args) {
  if (args.length < 3) throw Error(COMPARE_USAGE);
  const versions = args.slice(0, 2);
  const files = [];
  const options = {};
  const remaining = args.slice(2);
  while (remaining.length) {
    const argument = remaining.shift();
    if (argument === '--split') {
      options.splitFile = remaining.shift();
    } else if (argument === '--partition') {
      options.partition = remaining.shift();
    } else {
      files.push(argument);
    }
  }
  if (!files.length) throw Error('At least one export is required');
  return compare(versions, files, options);
}

// Each command receives its arguments and returns the value to print as JSON.
const COMMANDS = {
  list: listCommand,
  verify: verifyCommand,
  snapshot: snapshotCommand,
  compare: compareCommand,
};

function main(argv) {
  const [commandName, ...args] = argv;
  try {
    if (!Object.hasOwn(COMMANDS, commandName)) throw Error(USAGE);
    console.log(JSON.stringify(COMMANDS[commandName](args), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { readRegistry, verify, snapshot, load, rowsFrom, readDataset, compare };

if (require.main === module) main(process.argv.slice(2));
