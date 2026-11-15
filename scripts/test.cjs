#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tests = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((name) => /^test-.*\.cjs$/.test(name))
  .sort()
  .map((name) => path.join('tests', name));

let failures = 0;
for (const file of tests) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!ok) {
    failures++;
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) console.error(result.error.message);
  }
}
console.log(`${tests.length - failures}/${tests.length} test files passed.`);
process.exitCode = failures ? 1 : 0;
