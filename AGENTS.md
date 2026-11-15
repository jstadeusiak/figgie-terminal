# Model development

Before changing inference behavior, evidence semantics, calibration, or pricing,
verify the model registry and snapshot the current release if it is not already
archived. Use `node tools/model-registry.cjs verify` and
`node tools/model-registry.cjs snapshot VERSION DESCRIPTION`.

Archived files under `models/` are immutable. A changed model gets a new version;
never replace an older model with changed code under the same identifier. Keep
the engine, journal, fit, payout, training-isolation, and scoring dependencies
together. The registry verifies their hashes and loads versions in isolated
contexts, preventing current settings from changing historical comparisons.

Compare candidates against the current deployed model on complete, official,
non-practice recordings. Freeze chronological development/validation/test splits
before candidate selection. Use only information available before each action.
Report goal-probability scores, bonus/pricing error, and runtime separately.
Replay comparisons do not establish improved trading P&L. Keep motivating
examples separate from held-out evaluation.

Use Brier/log loss for goal probabilities and squared error plus signed calibration
for expected payouts and trade values; MAE is secondary. Weight games or declared
strata consistently, not individual opportunities with unequal counts. A losing
realized outcome does not by itself refute a positive expected value. Distinguish
settle-now quote values, fill probabilities, and actual policy trading profit.

Freeze simulation generator hashes, seed partitions, model source/options and
sampling budgets. Keep seeds out of policy-visible state. Use the production
sampling budget for promotion checks: sample-dependent calibration guards can
change the effective model, not just numerical precision.

Run the seeded simulation rule/privacy tests and representative runtime checks.
Synthetic games are controlled experiments, not independent evidence about the
native bots. Keep trading and data-generation policies independent of the model
being evaluated. Preserve existing recordings and the user's uncommitted work.

At release, add an immutable snapshot and registry description, verify historical
replay, build the extension, and record the validation artifacts and limitations
in the existing extension README. Follow the user's authorized installation
scope; do not invent an additional approval step.
