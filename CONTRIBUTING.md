# Contributing

Keep changes focused and behavior easy to verify. A cleanup should preserve outputs; a model change should explain what evidence it uses and how it was evaluated.

## Set up

Use Node.js 22 LTS (22.13+) or Node.js 24+, and Python 3:

```sh
npm ci
npm run build
npm test
npm run format:check
```

Load `extension/` as an unpacked Chrome extension for manual testing. Refresh Figgie between rounds after reloading the extension. Describe any manual checks in your pull request.

## Code changes

- Keep manual order dispatch independent of expensive rendering, recording, or inference work.
- Preserve stale-book, round, source-revision, and duplicate-action checks.
- Keep ordinary inference blind to exposed opponent hands and future results.
- Test a changed behavior at its boundary. Use synthetic fixtures when a private recording is unnecessary.
- Edit `terminal.html` and `terminal.css`, then rebuild `ui-assets.js`.
- Do not reformat immutable model archives or frozen replay dependencies.

Avoid speculative abstractions, redundant comments, and error handling that hides broken assumptions. Explain real failure paths and retain checks that guard external game state or persisted data.

## Model changes

Read `AGENTS.md` and [the model documentation](docs/model.md). Before changing inference, evidence semantics, calibration, or pricing:

1. Verify the registry and preserve the current release if it is not archived.
2. Declare the candidate, sampling budget, chronological partitions, and acceptance criteria before scoring.
3. Replay only information available at each forecast. Keep motivating examples outside candidate selection.
4. Report goal scores, conditional-bonus and quote-value errors, and runtime separately. Average correlated checkpoints within each round.
5. Give an accepted behavioral change a new version and archive its complete dependencies. Verify historical replay and rebuild the extension.

Synthetic games are useful for rule and numerical checks. They are not independent evidence of the native bots' behavior. Same-history forecast improvements do not demonstrate improved trading P&L.

Formatting or equivalent refactoring does not require retuning a model. Preserve the immutable reference and verify that numeric outputs are unchanged with `node tools/model-parity.cjs`, which compares the current sources with the archived release case by case.

## Reports and pull requests

For a bug, include the extension version, Chrome version, expected behavior, actual behavior, and reproduction steps. A small synthetic fixture is preferable to an entire recording archive. If a recording is needed, inspect it for player names, profile statistics, and other information you do not want to publish.

A pull request should state the problem, the resulting behavior, the checks run, and remaining limitations. Keep personal recordings, account-specific reports, screenshots, credentials, and downloaded third-party bundles out of commits.
