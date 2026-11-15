/*
 * Round journal. Turns the snapshots observed during one round into a
 * sequence of recorded events, derives from them the opponent evidence the
 * model reads, and replays, restores and scores a recorded round.
 *
 * Observable-event journal and replay. Source timestamps are LOCAL observation
 * times; recovered fills have unknown execution times, never invented ones.
 */
(function (scope) {
  'use strict';

  const Pnl = scope.FiggiePnl || (typeof require === 'function' ? require('./pnl.js') : null);

  const SUIT_IDS = ['s', 'c', 'd', 'h'];
  const EVENT_SCHEMA = 1;
  // Statuses in which a round is being played.
  const ACTIVE_STATUSES = ['live', 'paused'];
  // The events that store a whole snapshot.
  const SNAPSHOT_EVENT_KINDS = ['round_start', 'checkpoint'];

  // The fields of one market kept in a `state` event, in the order stored.
  const BOOK_FIELDS = [
    'id',
    'bid',
    'ask',
    'buyer',
    'seller',
    'canBuy',
    'canSell',
    'canBid',
    'canOffer',
    'canRaiseBid',
    'canLowerAsk',
    'canCancelBid',
    'canCancelOffer',
  ];
  // The commands that withdraw or replace your own resting quote on each side.
  const QUOTE_REPLACING_COMMANDS = {
    bid: ['cancel-bid', 'bid', 'raise-bid'],
    ask: ['cancel-offer', 'offer', 'lower-ask'],
  };

  // Two observations further apart than this are separate stretches of
  // coverage. One comparison is made in seconds and one in milliseconds, as
  // they always were, so that neither changes by a rounding error.
  const CONTINUOUS_GAP_SECONDS = 2;
  const CONTINUOUS_GAP_MS = 2000;
  // How long your order attempts are remembered, and how soon after one a
  // matching fill or quote change is put down to it.
  const COMMAND_MEMORY_MS = 5000;
  const COMMAND_MATCH_WINDOW_MS = 2500;
  // A live round is checkpointed at least this often.
  const CHECKPOINT_INTERVAL_MS = 10000;
  // Goal forecasts are recorded at most this often.
  const PREDICTION_INTERVAL_MS = 15000;
  // How long a resting quote is watched for the fill that was forecast for it.
  const FILL_HORIZON_MS = 10000;

  // The price a suit is anchored to before it has traded.
  const DEFAULT_ANCHOR_PRICE = 5;
  // Confidence that the side inferred from the book is the one that took the quote.
  const INFERRED_INITIATOR_CONFIDENCE = 0.6;
  // A true goal given less probability than this has its log loss capped.
  const LOG_LOSS_PROBABILITY_FLOOR = 1e-9;
  // Signal temperatures of the rounds that stored a candidate forecast to compare.
  const COMPARED_TEMPERATURES = [0.3, 0.6];
  const CANDIDATE_TEMPERATURE = 0.6;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hasGoal = (result) => SUIT_IDS.includes(result?.goal);
  const emptyFlow = (names) => names.map(() => [0, 0, 0, 0]);
  const withoutNulls = (object) =>
    Object.fromEntries(Object.entries(object || {}).filter(([, value]) => value !== null));

  function sameTrade(a, b) {
    return a && b && a.suit === b.suit && a.b === b.b && a.s === b.s && a.p === b.p;
  }

  // Moves one traded card from the seller's net flow to the buyer's.
  function applyTrade(net, names, trade) {
    const suit = SUIT_IDS.indexOf(trade.suit);
    net[names.indexOf(trade.s)][suit]--;
    net[names.indexOf(trade.b)][suit]++;
  }

  // ── Practice rounds ────────────────────────────────────────────────────

  // True while a round in play shows other players' hands.
  function visiblePractice(snapshot) {
    return (
      ACTIVE_STATUSES.includes(snapshot?.status) &&
      (snapshot.context?.learningExposure === true ||
        (snapshot.training?.enabled === true && snapshot.training.handsVisible === true))
    );
  }

  // True when a stored round, or any of its events, was played with hands visible.
  function isPractice(record, events = record?.events || []) {
    return (
      record?.practice === true ||
      visiblePractice(record?.snapshot) ||
      visiblePractice(record?.previous) ||
      events.some(
        (event) =>
          event.kind === 'practice_mode' ||
          event.practice === true ||
          visiblePractice(event.snapshot),
      )
    );
  }

  // A copy of a snapshot without the page element references.
  function clean(snapshot) {
    const { refs, ...recordable } = snapshot;
    return clone(recordable);
  }

  // ── Evidence ───────────────────────────────────────────────────────────

  // A fill exposes both participants, but only the taker selected a known peer.
  // Its epoch and net are the state BEFORE this fill; the completed transfer must
  // not become information available when explaining the preceding decision.
  function fillEvidence(event) {
    const trade = event.trade;
    const initiator = [trade.b, trade.s].includes(event.initiator) ? event.initiator : null;
    const shared = {
      suit: trade.suit,
      price: trade.p,
      net: Array.isArray(event.netBefore) ? clone(event.netBefore) : undefined,
      anchor: event.anchor || DEFAULT_ANCHOR_PRICE,
      epoch: event.index,
      at: event.at,
      sourceSeq: event.seq,
      recovered: Boolean(event.recovered),
      confidence: event.initiatorConfidence ?? (initiator ? INFERRED_INITIATOR_CONFIDENCE : 0),
    };
    const sides = [
      [trade.b, 'buy', trade.s],
      [trade.s, 'sell', trade.b],
    ];
    return sides.map(([actor, direction, counterparty]) => ({
      ...shared,
      kind: actor === initiator ? 'take' : 'consent',
      actor,
      direction,
      counterparty,
      passive: initiator ? actor !== initiator : null,
      counterpartyKnownBeforeAction: actor === initiator,
      recovered: initiator ? shared.recovered : true,
    }));
  }

  function quoteEvidence(event) {
    return {
      kind: 'quote',
      actor: event.owner,
      direction: event.side === 'bid' ? 'buy' : 'sell',
      suit: event.suit,
      price: event.price,
      net: Array.isArray(event.net) ? clone(event.net) : undefined,
      anchor: event.anchor,
      epoch: event.epoch,
      at: event.at,
      sourceSeq: event.seq,
      recovered: Boolean(event.recovered),
    };
  }

  // ── Recording one observation ──────────────────────────────────────────
  // The steps of RoundJournal.observe, in the order their events are recorded.
  // An observation is { snapshot, previous, names, at, continuous,
  // elapsedSeconds, tradeCountBefore, newFills, lastPrices }.

  // True when the trades seen now begin with every trade seen before.
  function extendsHistory(earlierTrades, trades) {
    return (
      trades.length >= earlierTrades.length &&
      earlierTrades.every((trade, index) => sameTrade(trade, trades[index]))
    );
  }

  function lastTradePrice(snapshot, suitId) {
    const lastTrade = snapshot?.trades.filter((trade) => trade.suit === suitId).at(-1);
    return lastTrade?.p || DEFAULT_ANCHOR_PRICE;
  }

  // Marks where recording begins, or where it was interrupted.
  function recordCoverage(journal, { snapshot, previous, at, elapsedSeconds }) {
    if (!previous) {
      journal.append(
        'round_start',
        {
          snapshot,
          coverage:
            'Recording starts here; historical fills are recovered without execution timestamps',
        },
        at,
      );
      return;
    }
    const gapped = elapsedSeconds > CONTINUOUS_GAP_SECONDS;
    if (gapped || at < journal.at || snapshot.status !== previous.status) {
      journal.append(
        'coverage',
        {
          status: snapshot.status,
          gapSeconds: gapped ? elapsedSeconds : 0,
          reason: gapped ? 'Observation gap' : 'Source state changed',
        },
        at,
      );
    }
  }

  // Adds the time since the last observation to the live time and to the time
  // each visible best quote has been exposed.
  function accrueExposure(journal, { previous, elapsedSeconds }) {
    journal.rates.liveSeconds += elapsedSeconds;
    for (const market of previous.markets) {
      for (const side of ['bid', 'ask']) {
        if (Number.isFinite(market[side])) journal.rates[side].exposure += elapsedSeconds;
      }
    }
  }

  // Works out who took which resting quote. Your own order attempt settles it;
  // otherwise the fill must match exactly one side of the book seen just before.
  function attributeFill(trade, market, ownCommand, { snapshot, continuous }) {
    if (ownCommand) {
      return {
        initiator: snapshot.self,
        resting: ownCommand.command.kind === 'buy' ? 'ask' : 'bid',
        classification: 'own-command',
      };
    }
    const hitBid = Boolean(market && market.bid === trade.p && market.buyer === trade.b);
    const liftedAsk = Boolean(market && market.ask === trade.p && market.seller === trade.s);
    if (!continuous || hitBid === liftedAsk) {
      return { initiator: null, resting: null, classification: 'unknown' };
    }
    return liftedAsk
      ? { initiator: trade.b, resting: 'ask', classification: 'ask-taken' }
      : { initiator: trade.s, resting: 'bid', classification: 'bid-hit' };
  }

  // Your recent order attempt that this fill carried out, if any.
  function ownCommandFor(journal, trade, { snapshot, at }) {
    return journal.commands.find(
      (attempt) =>
        at - attempt.at < COMMAND_MATCH_WINDOW_MS &&
        attempt.command?.suit === trade.suit &&
        attempt.command.price === trade.p &&
        ((attempt.command.kind === 'buy' && trade.b === snapshot.self) ||
          (attempt.command.kind === 'sell' && trade.s === snapshot.self)),
    );
  }

  // Records each trade not seen before, with the public flow before it.
  function recordFills(journal, observation) {
    const { snapshot, previous, names, at, continuous, tradeCountBefore, newFills, lastPrices } =
      observation;
    const net = previous ? clone(previous.net) : emptyFlow(names);
    newFills.forEach((trade, offset) => {
      const index = tradeCountBefore + offset;
      const suit = SUIT_IDS.indexOf(trade.suit);
      // Only the first new fill can be matched against the book seen before it.
      const market =
        offset === 0 ? previous?.markets?.find((earlier) => earlier.id === trade.suit) : null;
      const ownCommand = ownCommandFor(journal, trade, observation);
      const { initiator, resting, classification } = attributeFill(
        trade,
        market,
        ownCommand,
        observation,
      );
      const fill = journal.append(
        'fill',
        {
          index,
          trade,
          initiator,
          resting,
          classification,
          initiatorConfidence: initiatorConfidence(classification, initiator),
          anchor: lastPrices[suit],
          recovered: !previous,
          executionTimeKnown: false,
          netBefore: net,
          epoch: index,
        },
        at,
      );
      journal.evidence.push(...fillEvidence(fill));
      if (continuous) {
        journal.rates.resets++;
        if (resting) journal.rates[resting].fills++;
      }
      applyTrade(net, names, trade);
      lastPrices[suit] = trade.p;
    });
  }

  function initiatorConfidence(classification, initiator) {
    if (classification === 'own-command') return 1;
    return initiator ? INFERRED_INITIATOR_CONFIDENCE : 0;
  }

  // Records every best quote that changed, and every one that disappeared.
  function recordQuotes(journal, observation) {
    const { snapshot, previous, at, continuous, newFills, lastPrices } = observation;
    const hadFill = newFills.length > 0;
    for (const market of snapshot.markets) {
      const earlier = previous?.markets?.find((candidate) => candidate.id === market.id);
      for (const side of ['ask', 'bid']) {
        const ownerField = side === 'ask' ? 'seller' : 'buyer';
        const owner = market[ownerField];
        const price = market[side];
        const earlierOwner = earlier?.[ownerField];
        const earlierPrice = earlier?.[side];
        if (previous && !hadFill && price === earlierPrice && owner === earlierOwner) continue;
        if (!Number.isFinite(price)) {
          if (Number.isFinite(earlierPrice)) {
            journal.append(
              'book_clear',
              {
                suit: market.id,
                side,
                priorOwner: earlierOwner,
                cause: hadFill ? 'reset' : 'unknown; best-only feed cannot prove cancellation',
              },
              at,
            );
          }
          continue;
        }
        const ownerChanged = earlierOwner && earlierOwner !== owner;
        const event = journal.append(
          'quote',
          {
            suit: market.id,
            side,
            price,
            owner,
            priorOwner: earlierOwner || null,
            priorPrice: earlierPrice ?? null,
            epoch: snapshot.trades.length,
            net: snapshot.net,
            recovered: !previous,
            anchor: lastPrices[SUIT_IDS.indexOf(market.id)],
            classification: ownerChanged ? 'best-owner-change' : 'best-price-update',
          },
          at,
        );
        if (owner && snapshot.status === 'live') journal.evidence.push(quoteEvidence(event));
        const improved = side === 'bid' ? price > earlierPrice : price < earlierPrice;
        const outbid =
          continuous && !hadFill && ownerChanged && Number.isFinite(earlierPrice) && improved;
        if (outbid) journal.rates[side].outbids++;
      }
    }
  }

  function recordBalances(journal, { snapshot, previous, at }) {
    const playerCash = (table) => table.players.map((player) => player.cash);
    const changed =
      previous &&
      (snapshot.cash !== previous.cash ||
        !sameJson(snapshot.held, previous.held) ||
        !sameJson(playerCash(snapshot), playerCash(previous)));
    if (!changed) return;
    journal.append(
      'balances',
      {
        cash: snapshot.cash,
        held: snapshot.held,
        players: snapshot.players.map((player) => ({ name: player.name, cash: player.cash })),
        derivedFromFills: true,
      },
      at,
    );
  }

  // Records the parts of the snapshot that replay needs, when any changed.
  function recordState(journal, { snapshot, previous, at }) {
    const changed =
      !previous || snapshot.signature !== previous.signature || snapshot.status !== previous.status;
    if (!changed) return;
    journal.append(
      'state',
      {
        status: snapshot.status,
        timer: snapshot.timer,
        cash: snapshot.cash,
        held: snapshot.held,
        net: snapshot.net,
        roundResult: snapshot.roundResult,
        antePending: snapshot.antePending,
        playerCash: snapshot.players.map((player) => player.cash),
        book: snapshot.markets.map((market) => BOOK_FIELDS.map((field) => market[field])),
      },
      at,
    );
  }

  function recordClock(journal, { snapshot, at }) {
    if (snapshot.timer === journal.lastClock) return;
    journal.append('clock', { timer: snapshot.timer, status: snapshot.status }, at);
    journal.lastClock = snapshot.timer;
  }

  // Stores the whole snapshot at the start, after fills and status or result
  // changes, and otherwise every ten seconds until the round ends.
  function recordCheckpoint(journal, { snapshot, previous, at, newFills }) {
    const due =
      !previous ||
      newFills.length ||
      snapshot.status !== previous.status ||
      !sameJson(snapshot.roundResult, previous.roundResult) ||
      (snapshot.status !== 'ended' && at - journal.checkpointAt >= CHECKPOINT_INTERVAL_MS);
    if (!due) return;
    journal.append('checkpoint', { snapshot }, at);
    journal.checkpointAt = at;
  }

  // Follows your bank, and records the round's result once, when it is known
  // or changes.
  function recordSettlement(journal, { snapshot, at }) {
    journal.accounting = Pnl.observe(journal.accounting, snapshot, at);
    const pnl = Pnl.summary(snapshot, null, journal.accounting, journal.revealed);
    const resultKey = JSON.stringify([pnl.actualPnl, pnl.actualPayout]);
    if (pnl.actualPnl !== null && journal.accounting.savedResultKey !== resultKey) {
      journal.accounting.savedResultKey = resultKey;
      journal.append('round_pnl', { pnl }, at);
    }
  }

  // ── Journal ────────────────────────────────────────────────────────────

  class RoundJournal {
    constructor(id, base, emit = () => {}) {
      this.id = id;
      this.base = base;
      this.emit = emit;
      this.seq = 0;
      this.events = [];
      this.evidence = [];
      this.previous = null;
      this.at = 0;
      this.checkpointAt = 0;
      this.lastClock = '';
      this.commands = [];
      this.rates = {
        bid: { fills: 0, exposure: 0, outbids: 0 },
        ask: { fills: 0, exposure: 0, outbids: 0 },
        resets: 0,
        liveSeconds: 0,
      };
      this.predictions = [];
      this.fillPredictions = [];
      this.revealed = null;
      this.pendingSettlement = null;
      this.practice = false;
      this.practiceSince = null;
      this.practicePeeked = false;
      this.trainingCheckpoints = {};
      this.cursors = {};
      this.dirty = false;
    }

    // Records one event and hands it to the emit callback. A payload's own
    // `id` is kept as `commandId`, since `id` identifies the event.
    append(kind, data, at) {
      const payload = clone(data);
      if (Object.hasOwn(payload, 'id')) {
        payload.commandId = payload.id;
        delete payload.id;
      }
      const event = {
        ...payload,
        schema: EVENT_SCHEMA,
        id: this.id + ':' + ++this.seq,
        roundId: this.id,
        seq: this.seq,
        at,
        kind,
      };
      this.events.push(event);
      this.emit(event);
      this.dirty = true;
      return event;
    }

    // Marks the round as practice the first time other hands are visible.
    markPractice(snapshot, at) {
      if (this.practice || !visiblePractice(snapshot)) return false;
      this.practice = true;
      this.practiceSince = at;
      this.append(
        'practice_mode',
        { practice: true, source: 'Visible hands during an active round' },
        at,
      );
      return true;
    }

    // Records one of your actions. Order attempts are remembered for a few
    // seconds, to attribute the fills and quote changes that follow.
    command(kind, data, at) {
      const event = this.append(kind, data, at);
      if (kind === 'command_attempt') {
        this.commands.push(event);
        this.commands = this.commands.filter((attempt) => at - attempt.at < COMMAND_MEMORY_MS);
      }
      return event;
    }

    // Records a stretch the terminal could not observe. Fill forecasts still
    // open are closed as censored: their outcome was not seen.
    gap(status, reason, at) {
      this.append('coverage', { status, reason }, at);
      for (const forecast of this.fillPredictions) {
        if (forecast.done) continue;
        forecast.done = true;
        this.append(
          'fill_outcome',
          {
            key: forecast.key,
            pFill: forecast.pFill,
            filled: false,
            censored: true,
            reason: 'coverage gap',
            observedSeconds: Math.max(0, (at - forecast.at) / 1000),
          },
          at,
        );
      }
    }

    // Records everything that changed between the previous snapshot and this one.
    observe(raw, at = Date.now()) {
      const snapshot = clean(raw);
      this.markPractice(snapshot, at);
      // Context the page no longer shows keeps its last known value.
      snapshot.context = { ...(this.previous?.context || {}), ...withoutNulls(snapshot.context) };
      const names = snapshot.players.map((player) => player.name);
      const previous = this.previous;
      if (previous && !extendsHistory(previous.trades, snapshot.trades)) {
        throw Error('History changed; a new recording segment is required');
      }
      const elapsedSeconds = previous ? Math.max(0, (at - this.at) / 1000) : 0;
      const continuous =
        Boolean(previous) &&
        at >= this.at &&
        elapsedSeconds <= CONTINUOUS_GAP_SECONDS &&
        previous.status === 'live' &&
        snapshot.status === 'live';
      const tradeCountBefore = previous?.trades.length || 0;
      const observation = {
        snapshot,
        previous,
        names,
        at,
        continuous,
        elapsedSeconds,
        tradeCountBefore,
        newFills: snapshot.trades.slice(tradeCountBefore),
        lastPrices: SUIT_IDS.map((id) => lastTradePrice(previous, id)),
      };
      const { newFills } = observation;

      recordCoverage(this, observation);
      if (continuous) accrueExposure(this, observation);
      if (previous && !continuous) this.resolveFillPredictions(snapshot, at, 'coverage gap', []);
      recordFills(this, observation);
      if (newFills.length && previous) {
        const reset = { cause: 'fill', from: tradeCountBefore, to: snapshot.trades.length };
        this.append('book_reset', reset, at);
        this.resolveFillPredictions(snapshot, at, 'reset', newFills);
      }
      recordQuotes(this, observation);
      recordBalances(this, observation);
      recordState(this, observation);
      recordClock(this, observation);
      recordCheckpoint(this, observation);
      this.resolveFillPredictions(snapshot, at, snapshot.status === 'ended' ? 'end' : null, []);
      recordSettlement(this, observation);

      this.previous = snapshot;
      this.at = at;
      this.dirty = true;
      return this;
    }

    // Records the model's goal forecast, while the round is live and its
    // outcome unknown.
    prediction(model, at) {
      const lastPrediction = this.predictions.at(-1);
      const tooSoon = lastPrediction && at - lastPrediction.at < PREDICTION_INTERVAL_MS;
      const outcomeKnown = this.revealed || hasGoal(this.pendingSettlement?.result);
      if (outcomeKnown || this.previous?.status !== 'live' || tooSoon) return;
      const prediction = {
        at,
        practice: this.practice,
        tradeCount: this.previous.trades.length,
        probabilities: model.scoringProbabilities || model.bySuit.map((suit) => suit.probability),
        baseline: model.baseline.probabilities,
        behavior: model.behavior.probabilities,
        rates: this.rates,
        modelVersion: model.version,
        provisional: model.behavior.provisional,
        expectedPayout: model.expectedPayout,
        expectedBase: model.expectedBase,
        expectedBonus: model.expectedBonus,
        roundPnl: model.roundPnl,
        goalScenarios: model.roundPnl?.goalScenarios,
        signals: model.behavior.signals,
        goalCalibration: model.behavior.goalCalibration || null,
        evidenceSelection: model.behavior.evidenceSelection,
        inventoryEvidence: model.inventoryEvidence,
        inventoryCalibration: model.inventoryCalibration,
      };
      this.predictions.push(prediction);
      this.append('prediction', prediction, at);
    }

    // Records the model's fill forecast for each best quote you own.
    trackActualTopQuotes(model, at) {
      const table = this.previous;
      if (!table || table.status !== 'live') return;
      // Only actual observed quote opportunities can be scored. Hypothetical +1/-1
      // estimates are not mislabeled as filled/not-filled observations.
      for (const market of table.markets) {
        for (const side of ['bid', 'ask']) {
          const owner = market[side === 'bid' ? 'buyer' : 'seller'];
          const price = market[side];
          if (!Number.isFinite(price) || owner !== table.self) continue;
          const quoteKey = [table.trades.length, market.id, side, owner, price].join('|');
          const isTracked = this.fillPredictions.some(
            (forecast) => forecast.quoteKey === quoteKey && !forecast.done,
          );
          if (isTracked) continue;
          const forecastFill = model.actualBook?.[market.id]?.[side];
          if (!forecastFill) continue;
          const forecast = {
            key: quoteKey + '|' + at,
            quoteKey,
            at,
            expiresAt: at + FILL_HORIZON_MS,
            epoch: table.trades.length,
            suit: market.id,
            side,
            owner,
            price,
            pFill: forecastFill.pFill,
            done: false,
          };
          forecast.seq = this.append('fill_prediction', forecast, at).seq;
          this.fillPredictions.push(forecast);
        }
      }
    }

    // Closes each open fill forecast whose quote filled, left the top of the
    // book or outlived its horizon, or whose outcome can no longer be observed
    // (`reason`). `fills` are the trades just seen.
    resolveFillPredictions(snapshot, at, reason, fills) {
      for (const forecast of this.fillPredictions) {
        if (forecast.done) continue;
        const { suit, side, owner, price } = forecast;
        const market = snapshot.markets.find((candidate) => candidate.id === suit);
        const ownerNow = market?.[side === 'bid' ? 'buyer' : 'seller'];
        const fill = fills.find(
          (trade) =>
            trade.suit === suit &&
            trade.p === price &&
            (side === 'bid' ? trade.b === owner : trade.s === owner),
        );
        const topChanged = !market || ownerNow !== owner || market[side] !== price;
        const isOver = fill || reason || topChanged || at >= forecast.expiresAt;
        if (!isOver) continue;

        forecast.done = true;
        const continuous =
          at >= this.at &&
          at - this.at <= CONTINUOUS_GAP_MS &&
          this.previous?.status === 'live' &&
          snapshot.status === 'live';
        // You withdrew or replaced the quote yourself, so it could not fill.
        const withdrawn = this.commands.some(
          (attempt) =>
            attempt.seq > forecast.seq &&
            attempt.at >= forecast.at &&
            attempt.at <= at &&
            at - attempt.at < COMMAND_MATCH_WINDOW_MS &&
            attempt.command?.suit === suit &&
            owner === snapshot.self &&
            QUOTE_REPLACING_COMMANDS[side].includes(attempt.command.kind),
        );
        const censored =
          !continuous ||
          reason === 'end' ||
          reason === 'coverage gap' ||
          (Boolean(fill) && at > forecast.expiresAt) ||
          (!fill && withdrawn);
        const unfilledReason = reason || (topChanged ? 'top changed' : 'horizon');
        this.append(
          'fill_outcome',
          {
            key: forecast.key,
            pFill: forecast.pFill,
            filled: Boolean(fill),
            censored,
            reason: fill ? 'fill' : unfilledReason,
            observedSeconds: Math.max(0, (at - forecast.at) / 1000),
          },
          at,
        );
      }
    }

    // Records the round's goal suit, once.
    reveal(result, at) {
      if (this.revealed) return false;
      if (!SUIT_IDS.includes(result.goal)) throw Error('Invalid revealed goal');
      this.revealed = clone(result);
      this.append('reveal', { ...result, source: result.source || 'user-confirmed' }, at);
      return true;
    }

    summary() {
      return {
        roundId: this.id,
        practice: this.practice,
        practicePeeked: this.practicePeeked,
        roundKey: this.previous?.roundKey,
        events: this.seq,
        evidence: this.evidence.length,
        coverage: 'Best visible quotes; DOM-coalesced changes may be missed',
        recoveredFills: this.events.filter((event) => event.kind === 'fill' && event.recovered)
          .length,
        revealed: this.revealed,
        pnl: this.previous
          ? Pnl.summary(this.previous, null, this.accounting, this.revealed)
          : null,
      };
    }
  }

  // ── Restore and replay ─────────────────────────────────────────────────

  // Rebuilds a journal from a stored round record and its recorded events.
  function restore(record, events, emit) {
    const journal = new RoundJournal(record.id, record.base, emit);
    journal.events = events.slice();
    journal.seq = Math.max(record.seq || 0, ...events.map((event) => event.seq));
    journal.previous = record.snapshot || replay(events);
    journal.at = record.observedAt || record.updatedAt;
    journal.rates = record.rates || journal.rates;
    journal.revealed = record.revealed || null;
    journal.pendingSettlement = record.pendingSettlement || null;
    journal.practice = isPractice(record, events);
    journal.practiceSince =
      record.practiceSince || events.find((event) => event.kind === 'practice_mode')?.at || null;
    journal.practicePeeked =
      record.practicePeeked === true || events.some((event) => event.kind === 'training_peek');
    journal.trainingCheckpoints = clone(record.trainingCheckpoints || {});
    journal.cursors = record.cursors || {};
    journal.accounting = record.accounting || Pnl.restore(events, journal.previous, journal.at);
    journal.predictions = events.filter((event) => event.kind === 'prediction');
    const resolvedKeys = new Set(
      events.filter((event) => event.kind === 'fill_outcome').map((event) => event.key),
    );
    journal.fillPredictions = events
      .filter((event) => event.kind === 'fill_prediction')
      .map((event) => ({ ...event, done: resolvedKeys.has(event.key) }));
    for (const event of events) {
      if (event.kind === 'checkpoint') journal.checkpointAt = event.at;
      if (event.kind === 'quote' && event.owner) journal.evidence.push(quoteEvidence(event));
      if (event.kind === 'fill') journal.evidence.push(...fillEvidence(event));
    }
    return journal;
  }

  // Rebuilds the last snapshot from recorded events: the latest stored
  // snapshot, brought forward by the fills, states and clock ticks after it.
  function replay(events) {
    let snapshot = null;
    for (const event of events) {
      if (SNAPSHOT_EVENT_KINDS.includes(event.kind)) snapshot = clone(event.snapshot);
      if (!snapshot) continue;
      if (event.kind === 'fill' && event.index >= snapshot.trades.length) {
        snapshot.trades.push(clone(event.trade));
      }
      if (event.kind === 'state') applyState(snapshot, event);
      if (event.kind === 'clock') {
        snapshot.timer = event.timer;
        snapshot.status = event.status;
      }
    }
    if (snapshot) {
      for (const market of snapshot.markets) {
        market.fills = snapshot.trades.filter((trade) => trade.suit === market.id);
      }
    }
    return snapshot;
  }

  function applyState(snapshot, event) {
    Object.assign(snapshot, {
      status: event.status,
      timer: event.timer,
      cash: event.cash,
      held: clone(event.held),
      net: clone(event.net),
      roundResult: event.roundResult,
      antePending: event.antePending,
    });
    snapshot.players.forEach((player, seat) => (player.cash = event.playerCash[seat]));
    for (const row of event.book) {
      const market = snapshot.markets.find((candidate) => candidate.id === row[0]);
      BOOK_FIELDS.forEach((field, index) => (market[field] = row[index]));
    }
  }

  // ── Scoring ────────────────────────────────────────────────────────────

  // Scores a revealed round's live goal forecasts against the goal suit:
  // the model's probabilities and the physical baseline, by Brier score and
  // log loss. Practice rounds and rounds without live forecasts are not scored.
  function scoreRound(journal) {
    if (isPractice(journal) || !journal.revealed || !journal.predictions.length) return null;
    const goal = SUIT_IDS.indexOf(journal.revealed.goal);
    const predictions = livePredictions(journal.events);
    if (!predictions.length) return null;

    const brier = (probabilities) =>
      probabilities.reduce(
        (total, probability, suit) => total + (probability - (suit === goal ? 1 : 0)) ** 2,
        0,
      );
    const logLoss = (probabilities) =>
      -Math.log(Math.max(LOG_LOSS_PROBABILITY_FLOOR, probabilities[goal]));
    const mean = (forecasts, score) =>
      forecasts.reduce((total, forecast) => total + score(forecast), 0) / forecasts.length;

    // Older rounds stored a candidate signal setting's forecast beside the one in force.
    const compared = predictions.filter(
      (prediction) =>
        COMPARED_TEMPERATURES.includes(prediction.signals?.temperature) &&
        prediction.candidateSignals?.temperature === CANDIDATE_TEMPERATURE &&
        Array.isArray(prediction.candidateProbabilities) &&
        Array.isArray(prediction.referenceProbabilities),
    );
    const signalComparison = compared.length
      ? {
          candidateBrier: mean(compared, (prediction) => brier(prediction.candidateProbabilities)),
          checkpoints: compared.length,
          opponentBrier: mean(compared, (prediction) => brier(prediction.probabilities)),
          referenceBrier: mean(compared, (prediction) => brier(prediction.referenceProbabilities)),
        }
      : null;
    return {
      signalComparison,
      roundId: journal.id,
      checkpoints: predictions.length,
      excludedCheckpoints: journal.predictions.length - predictions.length,
      opponentBrier: mean(predictions, (prediction) => brier(prediction.probabilities)),
      baselineBrier: mean(predictions, (prediction) => brier(prediction.baseline)),
      opponentLogLoss: mean(predictions, (prediction) => logLoss(prediction.probabilities)),
      baselineLogLoss: mean(predictions, (prediction) => logLoss(prediction.baseline)),
    };
  }

  // The recorded forecasts made while the round was live and before anything
  // showed its outcome.
  function livePredictions(events) {
    if (isPractice(null, events)) return [];
    let phase = 'unknown';
    let outcomeKnown = false;
    const predictions = [];
    for (const event of events) {
      if (SNAPSHOT_EVENT_KINDS.includes(event.kind)) phase = event.snapshot.status;
      if (event.kind === 'state' || event.kind === 'clock') phase = event.status;
      const showsOutcome =
        event.kind === 'reveal' ||
        (event.kind === 'settlement_pending' && hasGoal(event.result)) ||
        hasGoal(event.roundResult) ||
        hasGoal(event.snapshot?.roundResult);
      if (showsOutcome) outcomeKnown = true;
      if (event.kind === 'prediction' && phase === 'live' && !outcomeKnown) {
        predictions.push(event);
      }
    }
    return predictions;
  }

  // The recorded fill outcomes, for scoring. A fill seen inside its horizon
  // with no coverage gap in between was censored by older versions; it counts.
  function scoredFillOutcomes(events) {
    if (isPractice(null, events)) return [];
    const forecasts = new Map(
      events.filter((event) => event.kind === 'fill_prediction').map((event) => [event.key, event]),
    );
    const gaps = events.filter((event) => event.kind === 'coverage');
    return events
      .filter((event) => event.kind === 'fill_outcome')
      .map((outcome) => {
        const forecast = forecasts.get(outcome.key);
        const wasObserved =
          outcome.censored &&
          outcome.filled &&
          forecast &&
          outcome.at >= forecast.at &&
          outcome.at <= forecast.expiresAt &&
          !gaps.some((gap) => gap.seq > forecast.seq && gap.seq <= outcome.seq);
        return wasObserved ? { ...outcome, censored: false, legacyRecovered: true } : outcome;
      });
  }

  scope.FiggieJournal = {
    RoundJournal,
    visiblePractice,
    isPractice,
    clean,
    replay,
    restore,
    scoreRound,
    livePredictions,
    scoredFillOutcomes,
  };
  if (typeof module !== 'undefined') module.exports = scope.FiggieJournal;
})(globalThis);
