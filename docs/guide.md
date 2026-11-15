# User guide

## Trading controls

Each suit has **Buy** controls on the left and **Sell** controls on the right.

| Control          | Action                                           |
| ---------------- | ------------------------------------------------ |
| Buy now          | Buy one card from the displayed best ask         |
| Sell now         | Sell one card to the displayed best bid          |
| Bid input / Post | Offer to buy one card at your price              |
| Ask input / Post | Offer to sell one card at your price             |
| Bid presets      | Post at 1, 2, 4, or 8 chips                      |
| Ask presets      | Post at 16, 12, 10, or 8 chips                   |
| `+1` / `−1`      | Improve the displayed best bid / ask by one chip |
| `×`              | Cancel your quote on that side                   |

Player-colored badges identify the best quote's owner. **YOU · TOP** marks your own quote. Prices must be positive whole chips. A preset that would cross the opposite quote is disabled; use **Buy now** or **Sell now** to take that quote explicitly.

Optional shortcuts follow suit order: `1/2` for spades, `3/4` for clubs, `5/6` for diamonds, and `7/8` for hearts. Each pair is buy/sell. Typing, held keys, modifier combinations, and the Learning lab suppress trade shortcuts. Pressing Enter in a price input posts that quote.

Every fill clears the game's quotes. The extension checks for stale prices, round changes, and resets before dispatching an action. It does not automatically retry an order. An unconfirmed action is marked after a timeout; inspect the current game before acting again. Input drafts clear on fills and new rounds.

## Inventory and player flow

The inventory bar shows your current holdings and their change since the deal. The settlement estimate is what those holdings are modeled to pay if the round ended now.

Player colors match across timelines, flow rows, recent trades, and quote-owner badges. In each suit's timeline:

- A rising lane means net accumulation; a falling lane means net selling.
- Filled circles mark purchases and hollow circles mark sales.
- The horizontal axis is observed trade sequence, not elapsed time.
- The final delta is purchases minus sales, not the player's total holdings.

Hover a marker for the buyer, seller, and price. Recent trades use `buyer ← seller @ price`, newest first. Scroll the single-row feed horizontally to see older entries.

All players' net card changes sum to zero. The **Opp** total is therefore the negative of your own net change. It summarizes where cards moved, but does not add an independent market signal.

## Probabilities and fair values

**Cards** is the physical baseline given your dealt hand, public trades, and qualified observed asks. The larger goal percentage adds the opponent-behavior model when **Opponents** is enabled.

**pp** means percentage points: a rise from 20% to 29% is `+9 pp`. **Signals** expresses the same adjustment in chips per card. In that example, cards-only fair is 2.00, Signals is +0.90, and displayed base fair is 2.90. The adjustment is already included.

Base fair excludes the leader bonus. Buying from a particular seller can have a different value because observing that seller conditions the model on them owning a card, and transferring a card can change both players' bonus prospects.

### Immediate trades

**Buy value / Sell value** estimate the change in settlement value from a one-card transfer with the displayed counterparty. **Gain if filled** subtracts the purchase price, or subtracts the settlement value surrendered from the sale proceeds.

A **bonus** tag means positive modeled gain depends on the leader bonus: the base-card edge alone is negative. Hover for the base-card and bonus components. These values assume immediate settlement and exclude later resale.

### Resting quotes

The preview below a price input names the proposed quote. With an empty input, it previews Bid +1 or Ask −1; a valid competitive draft previews that price instead.

- **Gain if filled:** estimated profit change conditional on someone accepting one card at that price.
- **Fill ~X% / 10s:** estimated chance of that fill.
- **Order EV**, in the hover details: fill probability × gain conditional on a fill.

The horizon ends after ten seconds, a market reset, or loss of top position. It excludes fills after returning to the top and future resale. Quotes behind the best price have no fill estimate because the adapter cannot see queue position or hidden depth. A crossing draft directs you to the immediate trade control.

## Round P&L

```text
Estimated round P&L = sale proceeds − purchase costs + estimated settlement − ante
```

The ante is 50 chips with four players or 40 with five. Settlement combines the 10-chip payout per goal card with the leader bonus. Accumulating the most goal cards can still lose money after purchase costs and ante.

The sidebar's **P&L by goal** table shows the consequences of each possible goal suit:

| Column   | Meaning                                                                          |
| -------- | -------------------------------------------------------------------------------- |
| No bonus | Trading cash − ante + 10 × your cards in that suit                               |
| If wins  | Net round P&L conditional on that suit being the goal, including estimated bonus |
| EV share | Goal probability × the corresponding conditional P&L                             |

The four EV shares sum to estimated round P&L, apart from rounding. **No bonus** excludes every bonus, including one already secured by a lead or tie. It is a conservative comparison, not necessarily the minimum feasible payout.

At settlement, **Final** P&L uses reconciled official results, settled balances, or validated revealed hands. Missing or inconsistent settlement evidence leaves the result unavailable. A dash means unavailable, not a zero probability or zero payout.

## Recordings

**REC** reports local recording status. Observations, quote owners, fills, inventory, cash, manual actions, prediction checkpoints, and results are saved in IndexedDB in your Chrome profile. **REC ERROR** means a storage or delivery problem needs attention.

Open **Recordings & diagnostics** during a round or **Recordings** in the lobby to export NDJSON. Exports remain on your machine until you share them. Recording does not silently delete older rounds; make your own backups.

The journal captures local observation times. Brief quote changes can be missed, and historical fills recovered after reconnecting have unknown execution times. A lost top quote is not automatically classified as a voluntary cancellation.

The extension records verified official results when they are visible. You can also enter a revealed goal after the round ends. Model coefficients are not automatically refitted or promoted when more rounds are recorded. Some local priors, scores, and observed fill rates update from eligible results.

Opening Figgie's **Statistics** records the visible rating and counters locally. Rating observations support later analysis; they do not feed goal-suit inference or establish the server's rating formula.

## Learning lab

In Figgie's Learning mode with **Opponent Hands Visible**, open **Learning lab** in the terminal:

1. Assign goal probabilities totaling 100%, optionally guess an opponent's holdings, and lock your prediction.
2. Peek at one opponent. **Your hand + revealed** shows exact conditional goal probabilities from the hands you have revealed.
3. Use **Reveal all** to identify the goal and compare your forecast with the ordinary blind model. The lab also shows exact settle-now P&L and one-card values for the checkpoint.
4. Select **Continue playing** to hide the comparison and make another prediction.

The clock keeps running. Each opponent's private-hand prior describes the information their hand provides, not what that player actually believes or how a bot is programmed.

The ordinary model does not consume the exposed hands. Hand exposure marks the round as practice, including after reloads, and practice rounds are excluded from ordinary calibration. Predictions made after a peek are labeled accordingly. Ordinary end-of-round reveals do not make a concealed round practice.

## Connection problems

If the terminal is waiting or stale, check the original game with **Show Figgie**. Reconnect through Figgie's own interface when necessary. Refresh or update the extension between rounds, and use the recording status and diagnostics when reporting a problem.
