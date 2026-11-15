#!/usr/bin/env node
'use strict';

/*
 * Numeric parity between two builds of the model.
 *
 * Runs the seeded cases of `model-parity-cases.cjs` through a reference release
 * and a candidate, and reports every case whose complete output differs.
 * Outputs are compared exactly: each number bit for bit, each key in its
 * order, each thrown message. Only the release label (`version`) and the
 * wall-clock timing (`computeMs`) of a model are left out.
 *
 * A refactor that keeps this report empty has preserved inference, pricing,
 * recording, replay and scoring on every case. It says nothing about inputs
 * the cases do not reach; `audit-parity-sensitivity.cjs` measures how many
 * deliberate source changes the cases detect.
 *
 * Usage:
 *   node tools/model-parity.cjs [--sources DIR] [--reference VERSION] [--cases PATTERN] [--fail-fast]
 *
 * `--cases` keeps the cases whose name matches a regular expression. Prints a
 * JSON report and exits 1 when any case differs.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load } = require('./model-registry.cjs');
const { buildCases, outcome } = require('./model-parity-cases.cjs');

const ROOT_DIR = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'models');
const RUNTIME_DIR = path.join(ROOT_DIR, 'extension');

// The last release whose behavior was validated on recorded rounds.
const REFERENCE_VERSION = '0.13.0';

const MODULE_FILES = {
  Belief: 'belief.js',
  Journal: 'journal.js',
  Training: 'training.js',
  Pnl: 'pnl.js',
  Bonus: 'bonus-score.js',
  GoalSignal: 'goal-signal.js',
  ModelFit: 'model-fit.js',
};
const MODEL_CLASSES = [
  ['Belief', 'BeliefEngine'],
  ['Belief', 'OpponentKnowledge'],
  ['Journal', 'RoundJournal'],
];

const PREVIEW_LENGTH = 160;

// ── Loading ──────────────────────────────────────────────────────────────

// Runs the model sources of one folder in their own vm context, as the
// registry does for an archive, and returns the requested modules.
function loadSources(folder, moduleNames = Object.keys(MODULE_FILES)) {
  const context = vm.createContext({
    console,
    performance,
    Date,
    setTimeout,
    clearTimeout,
    crypto: crypto.webcrypto,
  });
  const loadedModules = new Map();

  function requireSource(name) {
    if (!name.startsWith('./')) throw Error(`Unexpected model dependency: ${name}`);
    const file = path.join(folder, name);
    if (loadedModules.has(file)) return loadedModules.get(file).exports;
    // Registered before it runs, so circular requires see the partial exports.
    const sourceModule = { exports: {} };
    loadedModules.set(file, sourceModule);
    const run = new vm.Script(
      `(function(exports,require,module){\n${fs.readFileSync(file, 'utf8')}\n})`,
      { filename: file },
    ).runInContext(context);
    run(sourceModule.exports, requireSource, sourceModule);
    return sourceModule.exports;
  }

  return Object.fromEntries(
    moduleNames.map((name) => [name, requireSource(`./${MODULE_FILES[name]}`)]),
  );
}

// The archived release, hash-verified by the registry. The registry does not
// hand out the two data-only modules, so they are read from the same archive.
function loadReference(version = REFERENCE_VERSION) {
  const archived = load(version);
  const extras = loadSources(path.join(ARCHIVE_DIR, version), ['GoalSignal', 'ModelFit']);
  return { ...archived, ...extras };
}

// ── Exact comparison ─────────────────────────────────────────────────────

const typeTag = (value) => Object.prototype.toString.call(value).slice(8, -1);
const isPrimitive = (value) => value === null || typeof value !== 'object';
const hasPrototype = (object) => Object.getPrototypeOf(object) !== null;

// Returns null when two values are identical, or the first place they differ.
// The two sides come from different vm contexts, so types are compared by tag
// rather than by prototype.
function firstDifference(reference, candidate, at = '$') {
  const difference = { at, reference: preview(reference), candidate: preview(candidate) };
  if (typeof reference === 'function' || typeof candidate === 'function') {
    return typeof reference === typeof candidate ? null : difference;
  }
  if (isPrimitive(reference) || isPrimitive(candidate)) {
    return Object.is(reference, candidate) ? null : difference;
  }
  const tag = typeTag(reference);
  if (tag !== typeTag(candidate)) return difference;
  if (tag === 'Map') {
    return firstDifference([...reference.entries()], [...candidate.entries()], `${at}<Map>`);
  }
  if (tag === 'Set') {
    return firstDifference([...reference.values()], [...candidate.values()], `${at}<Set>`);
  }
  if (Array.isArray(reference) || ArrayBuffer.isView(reference)) {
    return firstListDifference(reference, candidate, at);
  }
  return firstObjectDifference(reference, candidate, at);
}

function firstListDifference(reference, candidate, at) {
  if (reference.length !== candidate.length) {
    return { at: `${at}.length`, reference: reference.length, candidate: candidate.length };
  }
  for (let index = 0; index < reference.length; index++) {
    const item = `${at}[${index}]`;
    // An empty slot and a stored `undefined` are different outputs.
    if (index in reference !== index in candidate) {
      return { at: item, reference: index in reference, candidate: index in candidate };
    }
    const difference = firstDifference(reference[index], candidate[index], item);
    if (difference) return difference;
  }
  return null;
}

function firstObjectDifference(reference, candidate, at) {
  const keys = Object.keys(reference);
  const candidateKeys = Object.keys(candidate);
  const sameKeys =
    keys.length === candidateKeys.length &&
    keys.every((key, index) => key === candidateKeys[index]);
  if (!sameKeys) return { at: `${at} keys`, reference: keys, candidate: candidateKeys };
  const referencePrototype = hasPrototype(reference);
  const candidatePrototype = hasPrototype(candidate);
  if (referencePrototype !== candidatePrototype) {
    return { at: `${at} prototype`, reference: referencePrototype, candidate: candidatePrototype };
  }
  for (const key of keys) {
    const difference = firstDifference(reference[key], candidate[key], `${at}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function preview(value) {
  if (typeof value === 'function') return 'function';
  if (isPrimitive(value)) return Object.is(value, -0) ? '-0' : String(value);
  const text = JSON.stringify(value) ?? typeTag(value);
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
}

// ── Running the comparison ───────────────────────────────────────────────

// Every method of the reference classes must still exist on the candidate.
function missingMethods(reference, candidate) {
  const missing = [];
  for (const [moduleName, className] of MODEL_CLASSES) {
    const methods = Object.getOwnPropertyNames(reference[moduleName][className].prototype);
    const candidatePrototype = candidate[moduleName][className]?.prototype || {};
    for (const method of methods) {
      if (typeof candidatePrototype[method] !== 'function') missing.push(`${className}.${method}`);
    }
  }
  return missing;
}

// Runs every case through both releases. Returns how many cases were compared
// and, for each case that differs, the first place where it does.
function compareReleases(reference, candidate, options = {}) {
  const differences = missingMethods(reference, candidate).map((method) => ({
    case: 'class methods',
    at: method,
    reference: 'function',
    candidate: 'missing',
  }));
  const cases = buildCases().filter(
    (modelCase) => !options.only || options.only.test(modelCase.name),
  );
  let comparedCases = 0;
  for (const modelCase of cases) {
    if (options.failFast && differences.length) break;
    // The reference must run cleanly and reach the behavior the case is for:
    // a case that fails there proves nothing about the candidate.
    const expected = modelCase.run(reference);
    modelCase.check?.(expected);
    const actual = outcome(() => modelCase.run(candidate));
    const difference = actual.threw
      ? { at: 'candidate threw', reference: 'completed', candidate: actual.threw }
      : firstDifference(expected, actual.value);
    if (difference) differences.push({ case: modelCase.name, ...difference });
    comparedCases++;
  }
  return { comparedCases, differences };
}

// ── Command line ─────────────────────────────────────────────────────────

function main(argv) {
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const sources = path.resolve(option('--sources') || RUNTIME_DIR);
  const version = option('--reference') || REFERENCE_VERSION;
  const pattern = option('--cases');
  const report = compareReleases(loadReference(version), loadSources(sources), {
    failFast: argv.includes('--fail-fast'),
    only: pattern ? new RegExp(pattern) : null,
  });
  console.log(JSON.stringify({ reference: version, sources, ...report }, null, 2));
  process.exitCode = report.differences.length ? 1 : 0;
}

module.exports = {
  REFERENCE_VERSION,
  RUNTIME_DIR,
  MODULE_FILES,
  loadSources,
  loadReference,
  firstDifference,
  compareReleases,
};

if (require.main === module) main(process.argv.slice(2));
