'use strict';

/*
 * The current model sources must reproduce release 0.13.0 exactly.
 *
 * Release 0.13.3 rewrote the model for readability. It changed how the model
 * is written, not what it computes. This test runs the parity cases through
 * the archived 0.13.0 release and through the current sources, and requires
 * identical output from both: inference, pricing, recording, replay and
 * scoring. See `model-parity.cjs` for what is compared and how.
 *
 * The complete simulated rounds run in `test-release-parity-rounds.cjs`.
 */

const assert = require('node:assert/strict');
const {
  REFERENCE_VERSION,
  RUNTIME_DIR,
  loadReference,
  loadSources,
  compareReleases,
} = require('../tools/model-parity.cjs');

const report = compareReleases(loadReference(), loadSources(RUNTIME_DIR), { only: /^(?!round:)/ });
assert.deepEqual(report.differences, [], 'model output differs from the reference release');
console.log(`${report.comparedCases} parity cases match model ${REFERENCE_VERSION} exactly.`);
