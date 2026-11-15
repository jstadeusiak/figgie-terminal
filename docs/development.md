# Architecture and local tools

## Runtime

The extension is plain JavaScript with a Manifest V3 background service worker. It has no application server or external model service.

```text
Visible Figgie game
    ↓
DOM adapter → content bridge → local journal / background inference
                    ↕                         ↓
             manual controls          probabilities and values
                    ↕                         ↓
               Figgie UI ←──────── terminal UI
```

| Source                                        | Responsibility                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `adapter.js`                                  | Read and validate the rendered game state                                |
| `content.js`                                  | Observe changes, queue recording events, dispatch guarded manual actions |
| `ui.js`, `flow-chart.js`, `training-ui.js`    | Render controls, player flow, and practice comparisons                   |
| `terminal.html`, `terminal.css`, `build.py`   | UI source and bundle generation                                          |
| `background.js`                               | Recording and inference orchestration                                    |
| `belief.js`, `model-fit.js`, `goal-signal.js` | Physical inference, behavioral evidence, and goal calibration            |
| `pnl.js`                                      | Inventory scenarios and round accounting                                 |
| `journal.js`, `record-store.js`               | Event normalization, local persistence, replay, and scoring              |
| `training.js`                                 | Exact practice comparisons and private-hand isolation                    |
| `ratings.js`                                  | Visible profile observations and rating-interval analysis                |
| `replay.cjs`                                  | Reproduce recorded forecasts offline                                     |

These files are under `extension/`. `ui-assets.js` is generated from HTML and CSS; edit those source files and rebuild instead of hand-editing the bundle.

Manual actions dispatch independently of model computation. The bridge revalidates the current book and round before using Figgie's controls. Inference uses the matching observation revision; late responses cannot update a newer round. Recording acknowledgments follow durable commits, while the in-memory model can proceed without waiting for disk.

## Build and tests

Run from the repository root:

```sh
npm ci
npm run build
npm test
npm run format:check
```

`npm test` runs every `tests/test-*.cjs` file, including the simulator tests; run one directly with `node tests/test-<name>.cjs`. The public checks use synthetic fixtures and included sources. Tests cover order dispatch, state recovery, probability and payout consistency, practice isolation, recording/export behavior, model archives, and simulator rules. Timing checks measure local computation, not network or server execution latency.

Historical audit scripts under `research/` may require local exports or research artifacts that are intentionally excluded from Git. They are separate from the fixture-based public test suite. Read a tool's usage or source before selecting a corpus; some research runners refer to frozen historical partitions.

### Model parity

The current model sources must compute exactly what release 0.13.0 computes. `tests/test-release-parity.cjs` and `tests/test-release-parity-rounds.cjs` run the seeded cases under `tools/parity/` through the archived release and through the current sources, then compare the complete outputs: every number, every key, and every thrown message. After an equivalent rewrite of a model file, run the comparison directly. It reports where each differing case first diverges:

```sh
node tools/model-parity.cjs
```

`research/audit-parity-sensitivity.cjs` measures how much the cases notice. It makes one small change at a time to a scratch copy of the sources and lists the changes the comparison does not detect. A full audit takes a long time; limit it with `--file` or `--every`.

## Replay your recordings

Export NDJSON from the terminal or lobby Recordings panel, then run:

```sh
node extension/replay.cjs /path/to/recording.ndjson
```

Replay uses the source version, public observations, and priors available before each saved prediction. It reports probability differences and coverage. Missing historical observations cannot be reconstructed by a new model.

Compare immutable model versions on your own exports:

```sh
node tools/model-registry.cjs list
node tools/model-registry.cjs verify
node tools/model-registry.cjs compare 0.12.0 0.13.0 /path/to/recording.ndjson
```

Multiple exports may be supplied. Identical events are deduplicated; conflicting histories are rejected. A split manifest can restrict a comparison with `--split manifest.json --partition test`.

For visible rating snapshots:

```sh
node tools/analyze-ratings.cjs /path/to/recording.ndjson
```

Adjacent profile observations sometimes identify a single completed round; otherwise the report retains interval totals. The tool does not recover or assume the server's rating formula.

## Model changes

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) and `AGENTS.md`. Verify and preserve the current model before changing inference. A behavioral change needs a new version, an immutable archive, and separate probability, value, and runtime evidence. Formatting alone should preserve behavior and pass equivalence checks.

The source archives under `models/` are immutable, including their dependency files. Do not reformat them or replace a historical version's bytes. The registry verifies the archive hashes before loading comparisons.
