#!/usr/bin/env node
'use strict';

/*
 * How much does the parity check notice?
 *
 * Makes one small change at a time to a scratch copy of the model sources: a
 * number nudged, an operator swapped. Each changed copy is run through
 * `model-parity.cjs`. A change the check reports is detected; one it passes
 * has survived. Survivors are either changes that cannot alter an output (a
 * cache size, a guard that never binds) or behavior no case reaches. A run
 * that does not finish in time is unresolved: the change may loop forever, or
 * the machine may be busy. Rerun those with `--retry`.
 *
 * Usage:
 *   node research/audit-parity-sensitivity.cjs [--sources DIR] [--file NAME] [--every N]
 *                                          [--jobs N] [--retry REPORT]
 *
 * `--sources` names the folder whose model sources are changed (the runtime
 * sources by default), `--file` limits the audit to one of them, `--every`
 * samples every Nth change, and `--retry` reruns only the survivors of an
 * earlier report of the same sources, after cases were added. Prints JSON:
 * totals per file, the surviving changes and the unresolved ones.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse } = require('acorn');
const { MODULE_FILES, RUNTIME_DIR } = require('../tools/model-parity.cjs');

const PARITY_SCRIPT = path.join(__dirname, '../tools/model-parity.cjs');
// How long one changed copy may run. The whole check takes about a minute.
const RUN_TIMEOUT_MS = 600000;

const SWAPPED_OPERATORS = {
  '+': '-',
  '-': '+',
  '*': '/',
  '/': '*',
  '<': '<=',
  '<=': '<',
  '>': '>=',
  '>=': '>',
  '===': '!==',
  '!==': '===',
  '&&': '||',
  '||': '&&',
  '+=': '-=',
  '-=': '+=',
  '*=': '/=',
  '/=': '*=',
};
const OPERATOR_NODES = ['BinaryExpression', 'LogicalExpression', 'AssignmentExpression'];

// The cases that can reach each source file, so a change is not run through
// cases that never load it.
const RELEVANT_CASES = {
  'belief.js': null,
  'model-fit.js': '^(module surface|engine|round)',
  'goal-signal.js': '^(goal signal|engine|round)',
  'journal.js': '^(journal|bonus|round)',
  'pnl.js': '^(pnl|journal|round)',
  'training.js': '^(training|round)',
  'bonus-score.js': '^(bonus|round)',
};

// ── Finding the changes ──────────────────────────────────────────────────

function eachNode(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => eachNode(child, visit));
    else if (value && typeof value === 'object') eachNode(value, visit);
  }
}

// An integer moves by one; any other number by one part in a billion.
function nudged(value) {
  return Number.isInteger(value) ? String(value + 1) : String(value * (1 + 1e-9));
}

// Every single-token change to one source text: { start, end, text }.
function changesTo(source) {
  const changes = [];
  eachNode(parse(source, { ecmaVersion: 'latest' }), (node) => {
    if (node.type === 'Literal' && typeof node.value === 'number') {
      changes.push({ start: node.start, end: node.end, text: nudged(node.value) });
    }
    if (OPERATOR_NODES.includes(node.type) && Object.hasOwn(SWAPPED_OPERATORS, node.operator)) {
      // The operator sits between the operands; skip any comment before it.
      const between = source.slice(node.left.end, node.right.start);
      const start = node.left.end + between.lastIndexOf(node.operator);
      changes.push({
        start,
        end: start + node.operator.length,
        text: SWAPPED_OPERATORS[node.operator],
      });
    }
  });
  return changes.sort((a, b) => a.start - b.start);
}

function describe(file, source, change) {
  const before = source.slice(0, change.start);
  const line = before.split('\n').length;
  const lineText = source.split('\n')[line - 1].trim();
  return {
    file,
    line,
    column: change.start - before.lastIndexOf('\n'),
    from: source.slice(change.start, change.end),
    to: change.text,
    source: lineText,
  };
}

// ── Running one changed copy ─────────────────────────────────────────────

// Writes the sources with one change applied into a worker's scratch folder.
function writeChangedCopy(folder, sources, file, change) {
  for (const [name, source] of Object.entries(sources)) {
    const text =
      name === file
        ? source.slice(0, change.start) + change.text + source.slice(change.end)
        : source;
    fs.writeFileSync(path.join(folder, name), text);
  }
}

// Resolves to what the parity check made of the folder's sources: 'survived'
// when it accepts them, 'detected' when it reports a difference or they fail
// outright, and 'unresolved' when the run was stopped for taking too long.
function parityVerdict(folder, casePattern) {
  const args = [PARITY_SCRIPT, '--sources', folder, '--fail-fast'];
  if (casePattern) args.push('--cases', casePattern);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'ignore', timeout: RUN_TIMEOUT_MS });
    child.on('close', (code, signal) => {
      if (signal) resolve('unresolved');
      else resolve(code === 0 ? 'survived' : 'detected');
    });
  });
}

// ── The audit ────────────────────────────────────────────────────────────

async function audit({ sourceDir, onlyFile, every, jobs, retry }) {
  const files = Object.values(MODULE_FILES).filter((file) => !onlyFile || file === onlyFile);
  const sources = Object.fromEntries(
    Object.values(MODULE_FILES).map((file) => [
      file,
      fs.readFileSync(path.join(sourceDir, file), 'utf8'),
    ]),
  );
  const identity = ({ file, line, column, to }) => [file, line, column, to].join(':');
  const retried = retry && new Set([...retry.survivors, ...(retry.unresolved || [])].map(identity));
  const queue = files.flatMap((file) =>
    changesTo(sources[file])
      .filter((_change, index) => index % every === 0)
      .filter((change) => !retried || retried.has(identity(describe(file, sources[file], change))))
      .map((change) => ({ file, change })),
  );
  const totals = Object.fromEntries(
    files.map((file) => [file, { changes: 0, detected: 0, survived: 0, unresolved: 0 }]),
  );
  const survivors = [];
  const unresolved = [];
  let finished = 0;

  async function work() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'figgie-parity-'));
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { file, change } = item;
      writeChangedCopy(folder, sources, file, change);
      const verdict = await parityVerdict(folder, RELEVANT_CASES[file]);
      totals[file].changes++;
      totals[file][verdict]++;
      if (verdict !== 'detected') {
        const described = describe(file, sources[file], change);
        (verdict === 'survived' ? survivors : unresolved).push(described);
        const { line, column, from, to } = described;
        console.error(`${verdict}: ${file}:${line}:${column} ${from} → ${to}`);
      }
      finished++;
      if (finished % 25 === 0) console.error(`${finished} changes run`);
    }
    fs.rmSync(folder, { recursive: true });
  }

  await Promise.all(Array.from({ length: jobs }, work));
  const bySourceOrder = (a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
  return {
    every,
    totals,
    survivors: survivors.sort(bySourceOrder),
    unresolved: unresolved.sort(bySourceOrder),
  };
}

// ── Command line ─────────────────────────────────────────────────────────

async function main(argv) {
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const earlierReport = option('--retry');
  const report = await audit({
    sourceDir: path.resolve(option('--sources') || RUNTIME_DIR),
    onlyFile: option('--file'),
    every: Number(option('--every') || 1),
    jobs: Number(option('--jobs') || Math.max(1, os.availableParallelism() - 1)),
    retry: earlierReport ? JSON.parse(fs.readFileSync(earlierReport, 'utf8')) : null,
  });
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { changesTo, audit };

if (require.main === module) main(process.argv.slice(2));
