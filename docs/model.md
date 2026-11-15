# Model and evaluation

Figgie Terminal estimates goal suits, hidden holdings, settlement values, and the chance a resting quote will fill. Release **0.13.3** preserves the inference behavior of **0.13.0**. Its behavioral assumptions are provisional; it does not know the native bots' strategy or other players' hidden cards.

## Physical baseline

The model assumes a uniformly selected legal deck layout and a random equal deal. The deck contains 12, 10, 10, and 8 cards across the four suits. The goal is the other suit of the same color as the 12-card suit, so the goal has 8 or 10 cards.

A dynamic program integrates feasible allocations using:

- Your starting hand.
- Public card transfers and each player's running net flow.
- Qualified observed asks, which establish that the seller held a card at that point.

Negative net flow establishes a lower bound on a player's starting holding. Selling a card previously acquired from someone else does not add another starting card. Ask constraints must reconcile with their trade epoch and public inventory flow; recovered or inconsistent asks are excluded or trigger a fallback to executed trades.

Under these assumptions, **Cards** probabilities are exact. Current hidden-hand distributions and behavioral valuations use stratified samples.

## Opponent evidence

For each possible opponent hand, the model reconstructs what that opponent could infer from their hand and the public history available before an action. It uses that information to compare four assumed behavior families: base-card value, leader bonus, liquidity or price following, and noise.

Quote prices and identifiable takes contribute evidence. Ambiguous consent receives less weight. Repeated improvements within a quote episode are combined, and a captured resting quote is not counted again as an independent decision when it fills. Your own orders do not vote for your own goal hypothesis.

Four-player Medium-bot games use each opponent's latest 24 episodes. Other contexts use the opening eight and latest sixteen. Random bot display names are not treated as persistent personalities. A quality guard reduces behavioral influence when eligible group scores trail the physical baseline.

### Current goal calibration

Four-player Medium-bot tables apply an additional fitted transformation. For physical probabilities `S` and the raw behavioral posterior `B`:

```text
Q[g] ∝ S[g] × (B[g] / S[g])^16
P[g] = 0.45 × S[g] + 0.55 × Q[g]
```

`Q` is normalized across feasible goals; impossible goals remain zero. The strength 16 applies to a likelihood ratio, not to probability or price directly. It can amplify small behavioral changes, so displayed probabilities may move sharply.

The transformation preserves the current distribution within each goal. All pricing paths use the reweighted worlds, keeping goal probabilities, inventory value, counterparties, and resting-order values consistent. Other table types retain their scoped defaults.

## Inventory and leader bonus

Each goal card pays 10 chips. The remaining pot goes to the largest goal holding, split equally among tied leaders.

In four-player Medium-bot games, an empirical inventory adjustment gives more weight to worlds where net accumulators started with larger holdings of the possible goal. The adjustment normalizes separately within each goal, preserving goal probabilities. An effective-sample guard limits concentration.

Bonus values depend on hidden opponents' inventories and can have large errors near ties. A card transferred from a rival changes both holdings. Named-counterparty buy values also condition on the seller owning a card; multiplying a generic fair value by goal probability is insufficient to reproduce them.

The model values immediate settlement. Future trading and resale are outside that value. Resting quotes additionally model who might accept, their willingness, and a bounded fill horizon. [The user guide](guide.md) explains the displayed fields.

## Learning isolation

The Learning lab is a separate information path. It may use hands Figgie visibly exposes to compute exact practice comparisons. Those hands are stripped from the ordinary inference snapshot. Exposed-hand rounds and after-peek predictions remain marked as practice and are excluded from ordinary calibration.

Official results enter scoring only after forecasts. Replay uses the recorded public prefix and contemporaneous priors for each prediction. Future trades may help construct a retrospective value label, but never become forecast inputs.

## Version history

`models/registry.json` records versions, provenance, dependency files, and SHA-256 hashes. Archives load in isolated contexts so current fit settings cannot alter an older comparator.

| Version | Role                                                             |
| ------- | ---------------------------------------------------------------- |
| 0.3–0.6 | Early inference and replay engines                               |
| 0.7     | Qualified ask ownership evidence and inventory calibration       |
| 0.8     | Recent opponent-evidence window for four-player Medium bots      |
| 0.9     | Learning-mode isolation and practice recording                   |
| 0.10    | Faster execution, recording, and recovery paths                  |
| 0.11    | Opponents' public learning and named-counterparty valuation      |
| 0.12    | Goal-allocation stratification and numerical stability           |
| 0.13    | Stronger goal-likelihood calibration for four-player Medium bots |
| 0.13.1  | Formatting-only intermediate snapshot                            |
| 0.13.2  | Equivalent source cleanup and public development tooling         |
| 0.13.3  | Readable model sources with exact numeric parity to 0.13.0       |

Earlier archives include compatible supporting files reconstructed from retained source snapshots; each registry entry records that provenance. Frozen archives are historical artifacts and retain their original formatting.

The repository also contains experimental code. A candidate's presence does not mean it is active. In particular, a later evidence-fading experiment reduced volatility but failed its inventory-payout validation limit; it was not released as model 0.14.

## What the evaluations establish

Recorded comparisons are retrospective and based primarily on four-player bot games. The stronger 0.13 goal calibration improved aggregate probability and static value scores in its historical comparison, but the ten-round probability-improvement confidence intervals included zero. This is not prospective calibration or evidence of improved trading profit.

Model work measures distinct questions:

| Question                                    | Measures                                                              |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Are goal probabilities useful?              | Brier score, log loss, calibration                                    |
| Is settlement valued accurately?            | Inventory and conditional-bonus MSE, RMSE, signed bias                |
| Are particular transfers valued accurately? | Named-counterparty quote-value errors on identifiable labels          |
| Are resting fills predicted accurately?     | Observed own-quote fill outcomes with censored gaps and cancellations |
| Is the model stable and usable?             | Same-history probability movement, large jumps, and CPU timing        |

Checkpoints within a round are correlated. Comparisons average within each round and then across rounds, preserve chronological selection splits, and keep motivating examples separate from selection. A realized unlikely goal does not by itself invalidate a probability estimate.

The private recorded corpus and account-specific reports are not distributed. Included tests and the [offline simulator](../tools/simulation/README.md) exercise rules, isolation, replay, and numerical consistency without those files. Synthetic policies are independent of the tested model and do not claim to reproduce Figgie's native bots. Neither replay nor these simulations establishes an alternative trading strategy's P&L.
