'use strict';

/*
 * Seeded cases for the model parity check (`model-parity.cjs`).
 *
 * A case is `{ name, run(release), check?(output) }`. `run` drives one build
 * of the model and returns everything it produced. `check`, where present,
 * asserts that the reference output reached the behavior the case exists for,
 * so a case cannot silently stop exercising it.
 *
 * Inputs are built from fixed seeds, and each build receives its own copy, so
 * both see identical data. Nothing reads a recording: the rounds come from
 * the offline simulator, whose policies do not call the model. The cases
 * live in `parity/`, grouped by the part of the model they exercise.
 */

const { outcome } = require('./parity/inputs.cjs');
const { beliefCases } = require('./parity/belief-cases.cjs');
const { engineCases } = require('./parity/engine-cases.cjs');
const { journalCases } = require('./parity/journal-cases.cjs');
const { simulatedRoundCases } = require('./parity/round-cases.cjs');
const { settlementCases } = require('./parity/settlement-cases.cjs');

// Cheap, broad cases come first so that a difference is found early.
function buildCases() {
  return [
    ...beliefCases(),
    ...settlementCases(),
    ...journalCases(),
    ...engineCases(),
    ...simulatedRoundCases(),
  ];
}

module.exports = { buildCases, outcome };
