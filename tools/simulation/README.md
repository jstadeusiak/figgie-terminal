# Offline simulation

Seeded Figgie games provide repeatable rule, numerical, and model-comparison checks. The simulator runs locally and cannot submit a live order.

## Quick start

Run from the repository root:

```sh
node tests/test-simulation.cjs
node tools/simulation/cli.cjs --games 2 --samples 64 --opponent-samples 8 --out outputs/simulation-smoke.json
```

The quick command uses a reduced sampling budget for a smoke check. For comparisons at each archived model's defaults:

```sh
node tools/model-registry.cjs verify
node tools/simulation/cli.cjs --baseline-version 0.12.0 --candidate-version 0.13.0 --out outputs/simulation-comparison.json
```

Version flags select verified, isolated model archives. Their defaults remain intact unless `--samples` or `--opponent-samples` is supplied explicitly. Reports record source hashes, selected versions, constructor overrides, and effective settings.

Without version flags, the CLI compares the frozen 0.10 forecaster with the current runtime at a lower default sampling budget. Use explicit versions for a release comparison.

## Options

```sh
node tools/simulation/cli.cjs --help
```

| Option          | Default | Purpose                                             |
| --------------- | ------- | --------------------------------------------------- |
| `--games`       | 20      | Number of seeded rounds                             |
| `--players`     | 4       | Four- or five-player deals                          |
| `--seed`        | 1101    | First round's reproducible seed                     |
| `--steps`       | 240     | Decision steps per round                            |
| `--checkpoints` | 5       | Forecast checkpoints per round                      |
| `--difficulty`  | medium  | Synthetic policy noise setting                      |
| `--noise`       | 1       | Quote disturbance scale                             |
| `--brownian`    | 0       | Persistence of bounded quote disturbances           |
| `--homogeneous` | off     | Use private-value policies instead of varied styles |
| `--out`         | stdout  | JSON report destination                             |

The synthetic difficulty label does not identify the behavior of Figgie's native bots. Brownian disturbances affect quotes; they do not turn finite cards and fixed terminal payouts into an unbounded geometric Brownian price process. `--max-price` bounds simulated policy quotes, not the real game's legal price rule.

## Rules and information

The environment selects uniformly among the 12 legal deck layouts, deals all 40 cards, charges the 200-chip pot equally, and enforces cash, inventory, and positive integer one-card trades. Every fill clears all quotes. Goal cards pay 10 chips each; the remaining pot goes to the largest goal holding, split equally for ties.

Each independent policy receives a frozen copy of its own hand, cash, visible quotes, player totals, and public trades. It cannot see other hands or the goal before settlement. Policies combine private-hand valuation, rough bonus incentives, inventory management, momentum, and noise. They do not call the tested inference engine.

Both forecasters receive the same public path. Only the scorer sees hidden truth. The environment models the best visible quotes, without an exchange queue or network latency.

## Read the results

Reports separate:

- Goal Brier score and log loss.
- Conditional bonus and leadership errors.
- Expected inventory payout errors.
- Named-counterparty transfer values and executable quote EV errors.
- Compute time and descriptive policy P&L.

MSE/RMSE and signed bias describe different aspects of an estimate. Unsupported or unidentified values remain unscored. Checkpoints within a round are correlated; compare round-level results rather than treating every checkpoint as an independent trial.

The policies generate trades independently of the tested models. Their P&L therefore does not measure a model's trading performance. Synthetic results supplement recorded-round evaluation and cannot establish that the assumed policies match real opponents.

## Larger comparisons

`batch.cjs` creates a frozen manifest of 1,200 seeds split into 600 training, 200 validation, and 400 test games. It varies player count, policy mix, and quote noise. Seeds remain in scorer metadata rather than policy-visible identifiers.

```sh
node tools/simulation/batch.cjs init
node tools/simulation/batch.cjs run --partition train --limit 200 --tag discovery-first200
```

The batch tool retains its historical default output directory under `outputs/`. Each run records source and model hashes, options, per-game scores, and checkpoint forecasts. Existing run folders are not overwritten. Changing the generator requires a new manifest and output directory.

Validation and test use a frozen model specification and do not fit parameters. Generate a specification with `batch.cjs spec`; after selection, a test run requires a selection file with `locked: true` and matching manifest, model, and sampling hashes. Production-budget checks are necessary because changing sample counts can also change a model's concentration guards.

Candidate factories and historical discovery aliases are research tooling. Consult `batch.cjs` before using them, and retain their provenance in comparisons. See [the contribution guide](../../CONTRIBUTING.md) for model selection requirements.
