# Figgie Terminal

A Chrome extension that turns [Figgie](https://www.figgie.com/play/) into a compact trading terminal. See all four suits, follow player inventory changes, and place manual orders from one screen.

This is an independent project, unaffiliated with Figgie or Jane Street.

## Features

- **Four suit markets:** buy and sell controls, quote owners, custom prices, presets, one-chip improvements, cancellation, and optional keyboard shortcuts.
- **Player flow:** consistent player colors, accumulation timelines, net card changes, and a compact trade feed.
- **Inventory and P&L:** consolidated holdings, net round profit, and downside scenarios for each possible goal suit.
- **Local inference:** goal probabilities, base fair values, leader-bonus estimates, and separate immediate-trade and resting-order values.
- **Learning lab:** lock a prediction, peek at visibly exposed hands, and compare your reasoning with exact conditional probabilities.
- **Record and replay:** local game journals, NDJSON export, versioned model comparisons, and seeded offline simulations.

Every trade is initiated by you. The extension reads the rendered game and operates Figgie's existing controls using your current session; it does not run a trading bot.

## Install

Requires Chrome, Python 3, and Node.js 22 LTS (22.13+) or Node.js 24+.

1. Download or clone this repository, then run from its root:

   ```sh
   npm ci
   npm run build
   ```

2. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked**.
3. Choose the repository's `extension` directory.
4. Open [Figgie](https://www.figgie.com/play/). The terminal becomes available when a complete game state is visible. **Show Figgie** returns to the original interface.

After updating the source, rebuild, reload the extension in Chrome, and refresh Figgie between rounds. Keep the extension directory in place while it is installed.

## Use

The left side of each market buys cards; the right side sells them. **Buy now** takes the best ask, while **Sell now** hits the best bid. Presets and custom-price inputs post resting quotes.

Enable **Keys 1–8** for the following immediate actions:

| Suit     | Buy | Sell |
| -------- | --- | ---- |
| Spades   | `1` | `2`  |
| Clubs    | `3` | `4`  |
| Diamonds | `5` | `6`  |
| Hearts   | `7` | `8`  |

Shortcuts are inactive while typing or using the Learning lab. Read the [user guide](docs/guide.md) for order controls, player flow, P&L, recordings, and practice exercises.

## Understand the estimates

**Base fair = 10 × goal probability.** A 29% goal probability gives a base fair of 2.90 chips, before any leader bonus. The `pp` adjustment and **Signals** value are already included in that probability and fair value.

The physical baseline follows the legal deck and observed ownership constraints. Opponent behavior, hidden inventories, bonuses, and fill probabilities require assumptions and sampling. They are experimental estimates, can move sharply, and do not guarantee profitable trades. Four-player Medium-bot calibration does not establish accuracy against human players.

See [the model documentation](docs/model.md) for the assumptions, current model, archived versions, and evaluation limits.

## Data and privacy

The extension stores observations and predictions in IndexedDB in your Chrome profile. It has no analytics service, remote model, or recording upload. It does not require an API key or cookie access.

Exports can contain player names, trades, visible profile statistics, and model decisions. Review them before sharing. Personal recordings, research results, downloaded site code, and local screenshots are excluded from this repository. Export recordings you want to keep before removing the extension or clearing its browser data.

## Development

```sh
npm ci
npm run build
npm test
npm run format:check
```

| Directory           | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `extension/`        | Extension source and generated UI bundle             |
| `models/`           | Immutable, hash-verified model archives              |
| `tests/`            | Regression tests and their fixtures                  |
| `tools/`            | Model registry and rating analysis                   |
| `tools/simulation/` | Seeded game simulator and model comparisons          |
| `research/`         | Offline audits and historical research scripts       |
| `scripts/`          | Test runner and release packaging                    |
| `docs/`             | User guide, model assumptions, and development notes |

The public test suite uses included fixtures. Historical research tools that require private recordings are documented separately from those checks.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), [architecture and replay](docs/development.md), or the [simulation guide](tools/simulation/README.md).

## License

MIT. See [LICENSE](LICENSE).
