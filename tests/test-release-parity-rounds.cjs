'use strict';

/*
 * The current model sources must reproduce release 0.13.0 exactly over whole
 * rounds: seeded offline games recorded, analyzed, scored, replayed and
 * restored the way the service worker does. The other parity cases run in
 * `test-release-parity.cjs`.
 */

const assert = require('node:assert/strict');
const {
  REFERENCE_VERSION,
  RUNTIME_DIR,
  loadReference,
  loadSources,
  compareReleases,
} = require('../tools/model-parity.cjs');

const report = compareReleases(loadReference(), loadSources(RUNTIME_DIR), { only: /^round:/ });
assert.deepEqual(report.differences, [], 'model output differs from the reference release');
console.log(`${report.comparedCases} simulated rounds match model ${REFERENCE_VERSION} exactly.`);
