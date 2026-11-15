/* Observable-event journal and replay. Source timestamps are LOCAL observation
   times; recovered fills have unknown execution times, never invented ones. */
(function (scope) {
  'use strict';
  const IDS = ['s', 'c', 'd', 'h'];
  const Pnl = scope.FiggiePnl || (typeof require === 'function' ? require('./pnl.js') : null);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function visiblePractice(snapshot) {
    return (
      ['live', 'paused'].includes(snapshot?.status) &&
      (snapshot.context?.learningExposure === true ||
        (snapshot.training?.enabled === true && snapshot.training.handsVisible === true))
    );
  }
  function isPractice(record, events = record?.events || []) {
    return (
      record?.practice === true ||
      visiblePractice(record?.snapshot) ||
      visiblePractice(record?.previous) ||
      events.some(
        (e) => e.kind === 'practice_mode' || e.practice === true || visiblePractice(e.snapshot),
      )
    );
  }
  function clean(snapshot) {
    const { refs, ...s } = snapshot;
    return clone(s);
  }
  function zero(names) {
    return names.map(() => [0, 0, 0, 0]);
  }
  function move(net, names, t) {
    const s = IDS.indexOf(t.suit);
    net[names.indexOf(t.s)][s]--;
    net[names.indexOf(t.b)][s]++;
  }
  function sameTrade(a, b) {
    return a && b && a.suit === b.suit && a.b === b.b && a.s === b.s && a.p === b.p;
  }
  // A fill exposes both participants, but only the taker selected a known peer.
  // Its epoch and net are the state BEFORE this fill; the completed transfer must
  // not become information available when explaining the preceding decision.
  function fillEvidence(event) {
    const t = event.trade,
      initiator = [t.b, t.s].includes(event.initiator) ? event.initiator : null;
    const base = {
      suit: t.suit,
      price: t.p,
      net: Array.isArray(event.netBefore) ? clone(event.netBefore) : undefined,
      anchor: event.anchor || 5,
      epoch: event.index,
      at: event.at,
      sourceSeq: event.seq,
      recovered: Boolean(event.recovered),
      confidence: event.initiatorConfidence ?? (initiator ? 0.6 : 0),
    };
    return [
      [t.b, 'buy', t.s],
      [t.s, 'sell', t.b],
    ].map(([actor, direction, counterparty]) => ({
      ...base,
      kind: actor === initiator ? 'take' : 'consent',
      actor,
      direction,
      counterparty,
      passive: initiator ? actor !== initiator : null,
      counterpartyKnownBeforeAction: actor === initiator,
      recovered: initiator ? base.recovered : true,
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
    append(kind, data, at) {
      const payload = clone(data);
      if (Object.hasOwn(payload, 'id')) {
        payload.commandId = payload.id;
        delete payload.id;
      }
      const event = {
        ...payload,
        schema: 1,
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
    command(kind, data, at) {
      const e = this.append(kind, data, at);
      if (kind === 'command_attempt') {
        this.commands.push(e);
        this.commands = this.commands.filter((c) => at - c.at < 5000);
      }
      return e;
    }
    gap(status, reason, at) {
      this.append('coverage', { status, reason }, at);
      for (const p of this.fillPredictions) {
        if (p.done) continue;
        p.done = true;
        this.append(
          'fill_outcome',
          {
            key: p.key,
            pFill: p.pFill,
            filled: false,
            censored: true,
            reason: 'coverage gap',
            observedSeconds: Math.max(0, (at - p.at) / 1000),
          },
          at,
        );
      }
    }
    observe(raw, at = Date.now()) {
      const snapshot = clean(raw);
      this.markPractice(snapshot, at);
      snapshot.context = {
        ...(this.previous?.context || {}),
        ...Object.fromEntries(Object.entries(snapshot.context || {}).filter(([, v]) => v !== null)),
      };
      const names = snapshot.players.map((p) => p.name),
        previous = this.previous;
      if (
        previous &&
        (snapshot.trades.length < previous.trades.length ||
          !previous.trades.every((t, i) => sameTrade(t, snapshot.trades[i])))
      )
        throw Error('History changed; a new recording segment is required');
      const dt = previous ? Math.max(0, (at - this.at) / 1000) : 0,
        continuous =
          previous &&
          at >= this.at &&
          dt <= 2 &&
          previous.status === 'live' &&
          snapshot.status === 'live';
      if (!previous)
        this.append(
          'round_start',
          {
            snapshot,
            coverage:
              'Recording starts here; historical fills are recovered without execution timestamps',
          },
          at,
        );
      if (previous && (dt > 2 || at < this.at || snapshot.status !== previous.status))
        this.append(
          'coverage',
          {
            status: snapshot.status,
            gapSeconds: dt > 2 ? dt : 0,
            reason: dt > 2 ? 'Observation gap' : 'Source state changed',
          },
          at,
        );
      if (continuous) {
        this.rates.liveSeconds += dt;
        for (const m of previous.markets)
          for (const side of ['bid', 'ask'])
            if (Number.isFinite(m[side])) this.rates[side].exposure += dt;
      }
      let net = previous ? clone(previous.net) : zero(names),
        lastPrices = IDS.map((id) => previous?.trades.filter((t) => t.suit === id).at(-1)?.p || 5),
        priorQuotes = previous?.markets;
      const start = previous?.trades.length || 0,
        newFills = snapshot.trades.slice(start);
      if (previous && !continuous) this.resolveFillPredictions(snapshot, at, 'coverage gap', []);
      for (let j = 0; j < newFills.length; j++) {
        const t = newFills[j],
          index = start + j,
          s = IDS.indexOf(t.suit),
          market = j === 0 ? priorQuotes?.find((m) => m.id === t.suit) : null;
        let resting = null,
          initiator = null,
          classification = 'unknown';
        const bid = market && market.bid === t.p && market.buyer === t.b,
          ask = market && market.ask === t.p && market.seller === t.s;
        if (continuous && bid !== ask) {
          resting = ask ? 'ask' : 'bid';
          initiator = ask ? t.b : t.s;
          classification = ask ? 'ask-taken' : 'bid-hit';
        }
        const command = this.commands.find(
          (c) =>
            at - c.at < 2500 &&
            c.command?.suit === t.suit &&
            c.command.price === t.p &&
            ((c.command.kind === 'buy' && t.b === snapshot.self) ||
              (c.command.kind === 'sell' && t.s === snapshot.self)),
        );
        if (command) {
          initiator = snapshot.self;
          resting = command.command.kind === 'buy' ? 'ask' : 'bid';
          classification = 'own-command';
        }
        const recovered = !previous;
        const fill = this.append(
          'fill',
          {
            index,
            trade: t,
            initiator,
            resting,
            classification,
            initiatorConfidence: classification === 'own-command' ? 1 : initiator ? 0.6 : 0,
            anchor: lastPrices[s],
            recovered,
            executionTimeKnown: false,
            netBefore: net,
            epoch: index,
          },
          at,
        );
        this.evidence.push(...fillEvidence(fill));
        if (continuous) {
          this.rates.resets++;
          if (resting) this.rates[resting].fills++;
        }
        move(net, names, t);
        lastPrices[s] = t.p;
      }
      if (newFills.length && previous) {
        this.append('book_reset', { cause: 'fill', from: start, to: snapshot.trades.length }, at);
        this.resolveFillPredictions(snapshot, at, 'reset', newFills);
      }
      for (const market of snapshot.markets) {
        const old = priorQuotes?.find((m) => m.id === market.id);
        for (const side of ['ask', 'bid']) {
          const ownerKey = side === 'ask' ? 'seller' : 'buyer',
            owner = market[ownerKey],
            price = market[side],
            oldOwner = old?.[ownerKey],
            oldPrice = old?.[side];
          if (previous && !newFills.length && price === oldPrice && owner === oldOwner) continue;
          if (!Number.isFinite(price)) {
            if (Number.isFinite(oldPrice))
              this.append(
                'book_clear',
                {
                  suit: market.id,
                  side,
                  priorOwner: oldOwner,
                  cause: newFills.length
                    ? 'reset'
                    : 'unknown; best-only feed cannot prove cancellation',
                },
                at,
              );
            continue;
          }
          const event = this.append(
            'quote',
            {
              suit: market.id,
              side,
              price,
              owner,
              priorOwner: oldOwner || null,
              priorPrice: oldPrice ?? null,
              epoch: snapshot.trades.length,
              net: snapshot.net,
              recovered: !previous,
              anchor: lastPrices[IDS.indexOf(market.id)],
              classification:
                oldOwner && oldOwner !== owner ? 'best-owner-change' : 'best-price-update',
            },
            at,
          );
          if (owner && snapshot.status === 'live') this.evidence.push(quoteEvidence(event));
          if (
            continuous &&
            !newFills.length &&
            oldOwner &&
            oldOwner !== owner &&
            Number.isFinite(oldPrice) &&
            ((side === 'bid' && price > oldPrice) || (side === 'ask' && price < oldPrice))
          )
            this.rates[side].outbids++;
        }
      }
      if (
        previous &&
        (snapshot.cash !== previous.cash ||
          JSON.stringify(snapshot.held) !== JSON.stringify(previous.held) ||
          JSON.stringify(snapshot.players.map((p) => p.cash)) !==
            JSON.stringify(previous.players.map((p) => p.cash)))
      )
        this.append(
          'balances',
          {
            cash: snapshot.cash,
            held: snapshot.held,
            players: snapshot.players.map((p) => ({ name: p.name, cash: p.cash })),
            derivedFromFills: true,
          },
          at,
        );
      if (
        !previous ||
        snapshot.signature !== previous.signature ||
        snapshot.status !== previous.status
      )
        this.append(
          'state',
          {
            status: snapshot.status,
            timer: snapshot.timer,
            cash: snapshot.cash,
            held: snapshot.held,
            net: snapshot.net,
            roundResult: snapshot.roundResult,
            antePending: snapshot.antePending,
            playerCash: snapshot.players.map((p) => p.cash),
            book: snapshot.markets.map((m) => [
              m.id,
              m.bid,
              m.ask,
              m.buyer,
              m.seller,
              m.canBuy,
              m.canSell,
              m.canBid,
              m.canOffer,
              m.canRaiseBid,
              m.canLowerAsk,
              m.canCancelBid,
              m.canCancelOffer,
            ]),
          },
          at,
        );
      if (snapshot.timer !== this.lastClock) {
        this.append('clock', { timer: snapshot.timer, status: snapshot.status }, at);
        this.lastClock = snapshot.timer;
      }
      if (
        !previous ||
        newFills.length ||
        snapshot.status !== previous.status ||
        JSON.stringify(snapshot.roundResult) !== JSON.stringify(previous.roundResult) ||
        (snapshot.status !== 'ended' && at - this.checkpointAt >= 10000)
      ) {
        this.append('checkpoint', { snapshot }, at);
        this.checkpointAt = at;
      }
      this.resolveFillPredictions(snapshot, at, snapshot.status === 'ended' ? 'end' : null, []);
      this.accounting = Pnl.observe(this.accounting, snapshot, at);
      const pnl = Pnl.summary(snapshot, null, this.accounting, this.revealed),
        resultKey = JSON.stringify([pnl.actualPnl, pnl.actualPayout]);
      if (pnl.actualPnl !== null && this.accounting.savedResultKey !== resultKey) {
        this.accounting.savedResultKey = resultKey;
        this.append('round_pnl', { pnl }, at);
      }
      this.previous = snapshot;
      this.at = at;
      this.dirty = true;
      return this;
    }
    prediction(model, at) {
      if (
        this.revealed ||
        IDS.includes(this.pendingSettlement?.result?.goal) ||
        this.previous?.status !== 'live' ||
        (this.predictions.length && at - this.predictions.at(-1).at < 15000)
      )
        return;
      const prediction = {
        at,
        practice: this.practice,
        tradeCount: this.previous.trades.length,
        probabilities: model.scoringProbabilities || model.bySuit.map((s) => s.probability),
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
    trackActualTopQuotes(model, at) {
      if (!this.previous || this.previous.status !== 'live') return;
      // Only actual observed quote opportunities can be scored. Hypothetical +1/-1
      // estimates are not mislabeled as filled/not-filled observations.
      for (const market of this.previous.markets)
        for (const side of ['bid', 'ask']) {
          const owner = market[side === 'bid' ? 'buyer' : 'seller'];
          if (!Number.isFinite(market[side]) || owner !== this.previous.self) continue;
          const key = [this.previous.trades.length, market.id, side, owner, market[side]].join('|');
          if (this.fillPredictions.some((p) => p.quoteKey === key && !p.done)) continue;
          const hypothetical = model.actualBook?.[market.id]?.[side];
          if (!hypothetical) continue;
          const p = {
            key: key + '|' + at,
            quoteKey: key,
            at,
            expiresAt: at + 10000,
            epoch: this.previous.trades.length,
            suit: market.id,
            side,
            owner,
            price: market[side],
            pFill: hypothetical.pFill,
            done: false,
          };
          p.seq = this.append('fill_prediction', p, at).seq;
          this.fillPredictions.push(p);
        }
    }
    resolveFillPredictions(snapshot, at, reason, fills) {
      for (const p of this.fillPredictions) {
        if (p.done) continue;
        const market = snapshot.markets.find((m) => m.id === p.suit),
          owner = market?.[p.side === 'bid' ? 'buyer' : 'seller'];
        const hit = fills.find(
          (t) =>
            t.suit === p.suit &&
            t.p === p.price &&
            (p.side === 'bid' ? t.b === p.owner : t.s === p.owner),
        );
        const changed = !market || owner !== p.owner || market[p.side] !== p.price;
        if (hit || reason || changed || at >= p.expiresAt) {
          p.done = true;
          const continuous =
            at >= this.at &&
            at - this.at <= 2000 &&
            this.previous?.status === 'live' &&
            snapshot.status === 'live';
          const explicitCancel = this.commands.some(
            (c) =>
              c.seq > p.seq &&
              c.at >= p.at &&
              c.at <= at &&
              at - c.at < 2500 &&
              c.command?.suit === p.suit &&
              p.owner === snapshot.self &&
              [
                'cancel-' + (p.side === 'ask' ? 'offer' : 'bid'),
                p.side === 'ask' ? 'offer' : 'bid',
                p.side === 'ask' ? 'lower-ask' : 'raise-bid',
              ].includes(c.command.kind),
          );
          const censored =
            !continuous ||
            reason === 'end' ||
            reason === 'coverage gap' ||
            (Boolean(hit) && at > p.expiresAt) ||
            (!hit && explicitCancel);
          this.append(
            'fill_outcome',
            {
              key: p.key,
              pFill: p.pFill,
              filled: Boolean(hit),
              censored,
              reason: hit ? 'fill' : reason || (changed ? 'top changed' : 'horizon'),
              observedSeconds: Math.max(0, (at - p.at) / 1000),
            },
            at,
          );
        }
      }
    }
    reveal(result, at) {
      if (this.revealed) return false;
      if (!IDS.includes(result.goal)) throw Error('Invalid revealed goal');
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
        recoveredFills: this.events.filter((e) => e.kind === 'fill' && e.recovered).length,
        revealed: this.revealed,
        pnl: this.previous
          ? Pnl.summary(this.previous, null, this.accounting, this.revealed)
          : null,
      };
    }
  }
  function restore(record, events, emit) {
    const j = new RoundJournal(record.id, record.base, emit);
    j.events = events.slice();
    j.seq = Math.max(record.seq || 0, ...events.map((e) => e.seq));
    j.previous = record.snapshot || replay(events);
    j.at = record.observedAt || record.updatedAt;
    j.rates = record.rates || j.rates;
    j.revealed = record.revealed || null;
    j.pendingSettlement = record.pendingSettlement || null;
    j.practice = isPractice(record, events);
    j.practiceSince =
      record.practiceSince || events.find((e) => e.kind === 'practice_mode')?.at || null;
    j.practicePeeked =
      record.practicePeeked === true || events.some((e) => e.kind === 'training_peek');
    j.trainingCheckpoints = clone(record.trainingCheckpoints || {});
    j.cursors = record.cursors || {};
    j.accounting = record.accounting || Pnl.restore(events, j.previous, j.at);
    j.predictions = events.filter((e) => e.kind === 'prediction');
    const resolved = new Set(events.filter((e) => e.kind === 'fill_outcome').map((e) => e.key));
    j.fillPredictions = events
      .filter((e) => e.kind === 'fill_prediction')
      .map((e) => ({ ...e, done: resolved.has(e.key) }));
    for (const e of events) {
      if (e.kind === 'checkpoint') j.checkpointAt = e.at;
      if (e.kind === 'quote' && e.owner) j.evidence.push(quoteEvidence(e));
      if (e.kind === 'fill') j.evidence.push(...fillEvidence(e));
    }
    return j;
  }
  function replay(events) {
    let snapshot = null;
    for (const e of events) {
      if (e.kind === 'round_start' || e.kind === 'checkpoint') snapshot = clone(e.snapshot);
      if (!snapshot) continue;
      if (e.kind === 'fill' && e.index >= snapshot.trades.length)
        snapshot.trades.push(clone(e.trade));
      if (e.kind === 'state') {
        Object.assign(snapshot, {
          status: e.status,
          timer: e.timer,
          cash: e.cash,
          held: clone(e.held),
          net: clone(e.net),
          roundResult: e.roundResult,
          antePending: e.antePending,
        });
        snapshot.players.forEach((p, i) => (p.cash = e.playerCash[i]));
        for (const row of e.book) {
          const m = snapshot.markets.find((m) => m.id === row[0]);
          [
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
          ].forEach((k, i) => (m[k] = row[i]));
        }
      }
      if (e.kind === 'clock') {
        snapshot.timer = e.timer;
        snapshot.status = e.status;
      }
    }
    if (snapshot)
      for (const m of snapshot.markets) m.fills = snapshot.trades.filter((t) => t.suit === m.id);
    return snapshot;
  }
  function scoreRound(journal) {
    if (isPractice(journal) || !journal.revealed || !journal.predictions.length) return null;
    const goal = IDS.indexOf(journal.revealed.goal),
      predictions = livePredictions(journal.events);
    if (!predictions.length) return null;
    const compared = predictions.filter(
      (p) =>
        [0.3, 0.6].includes(p.signals?.temperature) &&
        p.candidateSignals?.temperature === 0.6 &&
        Array.isArray(p.candidateProbabilities) &&
        Array.isArray(p.referenceProbabilities),
    );
    const brier = (ps) => ps.reduce((v, p, i) => v + (p - (i === goal ? 1 : 0)) ** 2, 0),
      loss = (ps) => -Math.log(Math.max(1e-9, ps[goal]));
    const signalComparison = compared.length
      ? {
          candidateBrier:
            compared.reduce((v, p) => v + brier(p.candidateProbabilities), 0) / compared.length,
          checkpoints: compared.length,
          opponentBrier: compared.reduce((v, p) => v + brier(p.probabilities), 0) / compared.length,
          referenceBrier:
            compared.reduce((v, p) => v + brier(p.referenceProbabilities), 0) / compared.length,
        }
      : null;
    return {
      signalComparison,
      roundId: journal.id,
      checkpoints: predictions.length,
      excludedCheckpoints: journal.predictions.length - predictions.length,
      opponentBrier:
        predictions.reduce((v, p) => v + brier(p.probabilities), 0) / predictions.length,
      baselineBrier: predictions.reduce((v, p) => v + brier(p.baseline), 0) / predictions.length,
      opponentLogLoss:
        predictions.reduce((v, p) => v + loss(p.probabilities), 0) / predictions.length,
      baselineLogLoss: predictions.reduce((v, p) => v + loss(p.baseline), 0) / predictions.length,
    };
  }
  function livePredictions(events) {
    if (isPractice(null, events)) return [];
    let phase = 'unknown',
      revealed = false;
    const result = [];
    for (const e of events) {
      if (e.kind === 'round_start' || e.kind === 'checkpoint') phase = e.snapshot.status;
      if (e.kind === 'state' || e.kind === 'clock') phase = e.status;
      if (
        e.kind === 'reveal' ||
        (e.kind === 'settlement_pending' && IDS.includes(e.result?.goal)) ||
        IDS.includes(e.roundResult?.goal) ||
        IDS.includes(e.snapshot?.roundResult?.goal)
      )
        revealed = true;
      if (e.kind === 'prediction' && phase === 'live' && !revealed) result.push(e);
    }
    return result;
  }
  function scoredFillOutcomes(events) {
    if (isPractice(null, events)) return [];
    const predictions = new Map(
        events.filter((e) => e.kind === 'fill_prediction').map((e) => [e.key, e]),
      ),
      coverage = events.filter((e) => e.kind === 'coverage');
    return events
      .filter((e) => e.kind === 'fill_outcome')
      .map((e) => {
        const p = predictions.get(e.key);
        if (
          e.censored &&
          e.filled &&
          p &&
          e.at >= p.at &&
          e.at <= p.expiresAt &&
          !coverage.some((c) => c.seq > p.seq && c.seq <= e.seq)
        )
          return { ...e, censored: false, legacyRecovered: true };
        return e;
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
