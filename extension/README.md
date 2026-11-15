# Figgie Terminal extension

This directory is the unpacked Chrome extension. Build it from the repository root with `npm run build`, then select this directory in Chrome's **Load unpacked** dialog at `chrome://extensions`.

- [Installation and project overview](../README.md)
- [Trading controls, P&L, recordings, and Learning lab](../docs/guide.md)
- [Model assumptions and version history](../docs/model.md)
- [Architecture, tests, and replay](../docs/development.md)

Release **0.13.3** preserves model 0.13's behavior. It rewrites the model sources for readability and changes no output. Immutable historical models are kept under `models/`; the `*-v*.js` files here support replay of older exports.

`npm run check` validates the build, regression fixtures, and archive hashes. `tests/test-release-parity.cjs` and `tests/test-release-parity-rounds.cjs` run seeded cases through the archived 0.13.0 release and the current sources, and require identical inference, pricing, recording, replay, and scoring output from both, number for number. The cases are synthetic tables and offline simulated rounds; they establish equivalence on those inputs, not on every possible one. This cleanup does not claim improved model accuracy.

Two further checks were run for this release. Replaying 68 complete rounds from the maintainer's private recordings (1,129 forecast checkpoints) with the archived 0.13.0 and 0.13.3 models gave identical probabilities, bonus forecasts, and scores. `research/audit-parity-sensitivity.cjs` made 2,316 one-token changes to the model sources, one at a time; the parity cases detected 2,169. Of the rest, one never finished running and 146 passed. Those 146 were read individually: they alter cache sizes, tolerance bands, redundant guards, and scalings that cancel, none of which the cases can observe.

After an update, rebuild, reload Figgie Terminal in Chrome's extension settings, and refresh Figgie between rounds. To return to the original game interface, use **Show Figgie**. Disable or remove the extension in Chrome to stop it entirely.
