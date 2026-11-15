'use strict';

/*
 * Parity cases for the round journal: hand-built sessions that reach each
 * kind of recorded event and each time limit exactly, stored rounds restored,
 * and the predicates and scores computed from stored events.
 */

const assert = require('node:assert/strict');
const {
  RELEASE_LABEL,
  clone,
  at,
  outcome,
  sale,
  tableSnapshot,
  journalState,
} = require('./inputs.cjs');

// ── Cases: journal ───────────────────────────────────────────────────────

function journalCases() {
  const hand = [3, 3, 2, 2];
  const firstFill = sale(1, 0, 'h', 6);
  const secondFill = sale(2, 0, 'h', 7);
  const thirdFill = sale(0, 3, 'c', 9);
  const quotes = {
    h: { bid: 5, ask: 6, buyer: 'Bot-B', seller: 'Bot-A' },
    s: { bid: 3, ask: null, buyer: 'You', seller: null },
    c: { bid: null, ask: 9, buyer: null, seller: 'You' },
  };
  const improved = { ...quotes, h: { bid: 6, ask: 7, buyer: 'Bot-C', seller: 'Bot-B' } };
  const table = (trades, book, changes = {}) => ({
    ...tableSnapshot({ hand, trades, quotes: book, roundKey: 'journal' }),
    signature: JSON.stringify([trades, book, changes]),
    ...changes,
  });
  const forecast = {
    version: RELEASE_LABEL,
    bySuit: [0.4, 0.3, 0.2, 0.1].map((probability) => ({ probability })),
    baseline: { probabilities: [0.25, 0.25, 0.25, 0.25] },
    behavior: {
      probabilities: [0.5, 0.2, 0.2, 0.1],
      provisional: true,
      signals: { temperature: 0.6 },
    },
    actualBook: { s: { bid: { pFill: 0.25 } }, c: { ask: { pFill: 0.4 } } },
  };
  const calibrated = {
    ...forecast,
    scoringProbabilities: [0.1, 0.2, 0.3, 0.4],
    roundPnl: { goalScenarios: [] },
  };
  const exposed = { status: 'live', context: { learningExposure: true } };

  function recordedSession(release) {
    const emitted = [];
    const journal = new release.Journal.RoundJournal('journal-1', 'base-1', (event) =>
      emitted.push(event),
    );
    const buy = { id: 'c1', command: { kind: 'buy', suit: 'h', price: 7 } };
    const cancel = { command: { kind: 'cancel-bid', suit: 's' } };
    const twoFills = [firstFill, secondFill];
    const threeFills = [firstFill, secondFill, thirdFill];
    const steps = [
      // Recording starts after a fill: that fill is recovered, not timed.
      () => journal.observe(table([firstFill], quotes), at(0)),
      () => journal.prediction(forecast, at(0.2)),
      () => journal.trackActualTopQuotes(forecast, at(0.2)),
      // A bot outbids another, then only your balance changes.
      () => journal.observe(table([firstFill], improved), at(1)),
      () => journal.observe(table([firstFill], improved, { cash: 290 }), at(1.5)),
      // You lift the offer; the fill resets the book and your resting quotes.
      () => journal.command('command_attempt', buy, at(2)),
      () => journal.observe(table(twoFills, {}), at(2.4)),
      () => journal.prediction(calibrated, at(3)),
      () => journal.prediction(calibrated, at(20)),
      () => journal.observe(table(twoFills, quotes), at(21)),
      () => journal.trackActualTopQuotes(forecast, at(21)),
      () => journal.trackActualTopQuotes(forecast, at(21.5)),
      // You cancel your bid; a bot then lifts your resting offer.
      () => journal.command('command_attempt', cancel, at(22)),
      () => journal.observe(table(twoFills, { c: quotes.c }), at(22.2)),
      () => journal.observe(table(threeFills, {}), at(23)),
      () => journal.command('note', { id: 'c2', text: 'kept' }, at(23.5)),
      // The tab is hidden, then the clock is seen running backwards.
      () => journal.gap('hidden', 'Tab hidden', at(24)),
      () => journal.observe(table(threeFills, quotes), at(40)),
      () => journal.trackActualTopQuotes(forecast, at(40)),
      () => journal.observe(table(threeFills, quotes, { timer: '0:10' }), at(52)),
      () => journal.observe(table(threeFills, quotes), at(51)),
      () => journal.markPractice(exposed, at(53)),
      () => journal.markPractice(exposed, at(54)),
      () => journal.reveal({ goal: 'x' }, at(55)),
      () => journal.reveal({ goal: 'h' }, at(56)),
      () => journal.prediction(calibrated, at(90)),
      () => journal.summary(),
    ];
    const results = steps.map((step) => {
      const result = outcome(step);
      return result.value === journal ? 'journal' : result;
    });
    const replays = [3, journal.events.length].map((cut) =>
      release.Journal.replay(clone(journal.events.slice(0, cut))),
    );
    return { results, journal: journalState(journal), emitted, replays };
  }

  function storedEvents() {
    const live = { status: 'live' };
    const prediction = (seq, probabilities, extras = {}) => ({
      kind: 'prediction',
      seq,
      at: at(seq),
      probabilities,
      baseline: [0.25, 0.25, 0.25, 0.25],
      signals: { temperature: 0.6 },
      ...extras,
    });
    // Older rounds stored a candidate forecast beside the one in force.
    const compared = {
      candidateSignals: { temperature: 0.6 },
      candidateProbabilities: [0.1, 0.1, 0.1, 0.7],
      referenceProbabilities: [0.2, 0.2, 0.2, 0.4],
    };
    const fillPrediction = (seq, key) => ({
      kind: 'fill_prediction',
      seq,
      key,
      at: at(seq),
      expiresAt: at(seq + 10),
    });
    const fillOutcome = (seq, key, seconds, changes = {}) => ({
      kind: 'fill_outcome',
      seq,
      key,
      at: at(seconds),
      censored: true,
      filled: true,
      ...changes,
    });
    return [
      { kind: 'prediction', seq: 1, probabilities: [1, 0, 0, 0], baseline: [1, 0, 0, 0] },
      { kind: 'round_start', seq: 2, snapshot: live },
      prediction(3, [0.1, 0.2, 0.3, 0.4], compared),
      prediction(4, [0, 0, 1, 0], { ...compared, signals: { temperature: 0.3 } }),
      prediction(5, [0.4, 0.3, 0.2, 0.1], { ...compared, signals: { temperature: 0.5 } }),
      { kind: 'clock', seq: 6, status: 'paused' },
      prediction(7, [0.25, 0.25, 0.25, 0.25]),
      { kind: 'state', seq: 8, status: 'live' },
      prediction(9, [0.3, 0.3, 0.2, 0.2], { ...compared, candidateProbabilities: null }),
      fillPrediction(10, 'k1'),
      fillPrediction(11, 'k2'),
      fillPrediction(12, 'k3'),
      fillOutcome(13, 'k1', 15),
      { kind: 'coverage', seq: 14 },
      fillOutcome(15, 'k2', 16),
      fillOutcome(16, 'k3', 30),
      fillOutcome(17, 'k4', 16),
      fillOutcome(18, 'k3', 16, { filled: false }),
      fillOutcome(19, 'k3', 16, { censored: false }),
      { kind: 'checkpoint', seq: 20, snapshot: live },
      prediction(21, [0.7, 0.1, 0.1, 0.1]),
      // Outcomes at the very instant of a forecast and at its horizon, and
      // coverage gaps numbered at either edge of the stretch they must fall in.
      fillPrediction(22, 'k5'),
      fillOutcome(23, 'k5', 22),
      fillOutcome(24, 'k5', 32),
      fillPrediction(25, 'k6'),
      { kind: 'coverage', seq: 25 },
      fillOutcome(26, 'k6', 27),
      fillPrediction(27, 'k7'),
      { kind: 'coverage', seq: 28 },
      fillOutcome(28, 'k7', 29),
    ];
  }

  function storedEventScores(release) {
    const { Journal } = release;
    const events = storedEvents();
    const lastForecast = events.findLast((event) => event.kind === 'prediction');
    const afterReveal = { ...lastForecast, seq: 23 };
    const reveals = [
      { kind: 'reveal', seq: 22 },
      { kind: 'settlement_pending', seq: 22, result: { goal: 'h' } },
      { kind: 'settlement_pending', seq: 22, result: { goal: 'x' } },
      { kind: 'state', seq: 22, status: 'live', roundResult: { goal: 'c' } },
      { kind: 'checkpoint', seq: 22, snapshot: { status: 'live', roundResult: { goal: 'd' } } },
    ];
    const withoutComparison = [events[0], events[1], events[6], events[7], events[8]];
    const journals = [
      { id: 'scored', revealed: { goal: 'h' }, predictions: [1, 2, 3], events },
      { id: 'unrevealed', revealed: null, predictions: [1], events },
      { id: 'no forecasts', revealed: { goal: 'h' }, predictions: [], events },
      { id: 'practice', practice: true, revealed: { goal: 'h' }, predictions: [1], events },
      { id: 'none live', revealed: { goal: 's' }, predictions: [1], events: events.slice(0, 1) },
      { id: 'uncompared', revealed: { goal: 'd' }, predictions: [1], events: withoutComparison },
    ];
    const visibleHands = { enabled: true, handsVisible: true };
    const snapshots = [
      null,
      { status: 'live' },
      exposed,
      { status: 'paused', training: visibleHands },
      { status: 'live', training: { enabled: true, handsVisible: false } },
      { status: 'ended', context: { learningExposure: true } },
      { status: 'live', training: { enabled: 1, handsVisible: true } },
    ];
    const records = [
      null,
      {},
      { practice: true },
      { snapshot: exposed },
      { previous: snapshots[3] },
      { events: [{ kind: 'practice_mode' }] },
      { events: [{ kind: 'state', practice: true }] },
      { events: [{ kind: 'checkpoint', snapshot: exposed }] },
      { events: [{ kind: 'checkpoint', snapshot: snapshots[1] }] },
    ];
    const practiceEvents = [{ kind: 'practice_mode' }, ...events];
    return {
      scores: journals.map((journal) => Journal.scoreRound(clone(journal))),
      live: reveals.map((reveal) => Journal.livePredictions([...events, reveal, afterReveal])),
      fillOutcomes: Journal.scoredFillOutcomes(clone(events)),
      practiceOutcomes: Journal.scoredFillOutcomes(practiceEvents),
      practiceLive: Journal.livePredictions(practiceEvents),
      visible: snapshots.map((snapshot) => Journal.visiblePractice(snapshot)),
      practice: records.map((record) => Journal.isPractice(record)),
      practiceByEvents: Journal.isPractice({ events: [] }, [{ practice: true }]),
      cleaned: Journal.clean({ status: 'live', refs: { node: 1 }, nested: { refs: 2 } }),
      replayWithoutStart: Journal.replay([{ kind: 'fill', index: 0, trade: {} }]),
    };
  }

  // A session whose events fall exactly on the journal's limits: two seconds
  // between observations, 2.5 and 5 seconds after an order, ten seconds to a
  // checkpoint or a fill horizon, fifteen between forecasts.
  function boundarySession(release) {
    const emitted = [];
    const journal = new release.Journal.RoundJournal('journal-2', 'base-2', (event) =>
      emitted.push(event),
    );
    const beforeObserving = clone(journalState(journal));
    const bots = { h: quotes.h };
    const yourBid = (price) => ({ ...bots, s: { ...quotes.s, bid: price } });
    const yourOffer = { ...bots, c: quotes.c };
    const bothYours = (bid) => ({ ...yourBid(bid), c: quotes.c });
    const otherOwners = { h: { ...quotes.h, buyer: 'Bot-C', seller: 'Bot-C' } };
    const anothersBid = { ...bots, s: { ...quotes.s, buyer: 'Bot-A' } };
    const lifted = [sale(1, 0, 'h', 6)];
    const sold = [...lifted, sale(0, 3, 'c', 9)];
    const fourFills = [...sold, sale(2, 3, 'd', 4), sale(3, 2, 'd', 5)];
    const fiveFills = [...fourFills, sale(0, 2, 'c', 9)];
    const changedHistories = [
      sale(1, 0, 'd', 6),
      sale(1, 2, 'h', 6),
      sale(2, 0, 'h', 6),
      sale(1, 0, 'h', 7),
    ].map((changed) => [changed, ...fiveFills.slice(1)]);
    const priced = { actualBook: { h: { bid: { pFill: 0.5 } }, s: { bid: { pFill: 0.3 } } } };

    const observe = (seconds, trades, book, changes) => () =>
      journal.observe(table(trades, book, changes), at(seconds));
    const track =
      (seconds, model = forecast) =>
      () =>
        journal.trackActualTopQuotes(model, at(seconds));
    const attempt = (seconds, kind, suit, price) => () =>
      journal.command('command_attempt', { command: { kind, suit, price } }, at(seconds));
    const predict = (seconds, model) => () => journal.prediction(model, at(seconds));
    const steps = [
      // Before the first observation there is nothing to track.
      track(0),
      observe(0, [], bothYours(3), { context: { botDifficulty: 'Medium', learningMode: true } }),
      track(0),
      // A cancel at the instant of the forecast still explains the vanished
      // bid. Context the page stops showing keeps its last value.
      attempt(0, 'cancel-bid', 's'),
      observe(1, [], yourOffer, { context: { botDifficulty: null } }),
      // Exactly two seconds apart is continuous coverage.
      observe(3, [], yourOffer),
      observe(5, [], yourOffer),
      observe(7, [], yourOffer),
      observe(9, [], yourOffer),
      // Ten seconds in, your offer's forecast reaches its horizon and a
      // checkpoint is due.
      observe(10, [], yourOffer),
      // A fill seen exactly 2.5 seconds after your order is not put down to it.
      attempt(10, 'buy', 'h', 6),
      observe(12, [], yourOffer),
      observe(12.5, lifted, {}),
      // Exactly five seconds after an order attempt, it is forgotten.
      observe(14.5, lifted, bothYours(4)),
      attempt(15, 'bid', 's', 4),
      observe(15, lifted, bothYours(4)),
      track(15),
      // A second observation at the same instant is continuous: the fill of
      // your offer is attributed and scored.
      observe(15, sold, {}),
      observe(17, sold, {}),
      // Two fills arrive in one observation.
      observe(19, fourFills, bots),
      predict(19, forecast),
      // Fifteen seconds later the next forecast is recorded. That long
      // without an observation is a gap.
      observe(34, fourFills, bots),
      predict(34, calibrated),
      // A status change exactly two seconds on is not an observation gap.
      // Nothing is forecast or tracked while the round is paused.
      observe(36, fourFills, yourBid(3), { status: 'paused' }),
      predict(60, calibrated),
      track(36),
      observe(38, fourFills, yourBid(3)),
      // A pending settlement that names the goal ends forecasting.
      () => (journal.pendingSettlement = { result: { goal: 'h' } }),
      predict(80, calibrated),
      () => (journal.pendingSettlement = null),
      // Only your own best quotes are tracked, whatever the model priced.
      track(38, priced),
      // Raising your bid replaces the quote that was forecast.
      attempt(39, 'raise-bid', 's'),
      observe(40, fourFills, yourBid(4)),
      track(40),
      // A cancel at the instant the bid is seen gone explains it.
      attempt(41, 'cancel-bid', 's'),
      observe(41, fourFills, bots),
      observe(42, fourFills, yourBid(4)),
      track(42),
      // Exactly 2.5 seconds after a cancel, a vanished bid is not put down to it.
      attempt(42.5, 'cancel-bid', 's'),
      observe(44, fourFills, yourBid(4)),
      observe(45, fourFills, bots),
      // A fill exactly at the horizon is inside it.
      observe(46, fourFills, yourOffer),
      track(46),
      observe(48, fourFills, yourOffer),
      observe(50, fourFills, yourOffer),
      observe(52, fourFills, yourOffer),
      observe(54, fourFills, yourOffer),
      observe(56, fiveFills, {}),
      // A best quote that changes hands at the same price is not an outbid.
      // If it was yours and forecast, the top of the book has changed.
      observe(58, fiveFills, bots),
      attempt(58, 'bid', 'd', 2),
      observe(60, fiveFills, otherOwners),
      observe(62, fiveFills, yourBid(3)),
      track(62),
      observe(63, fiveFills, anothersBid),
      // Exactly five seconds after the last order attempt, only this one is
      // remembered.
      attempt(63, 'bid', 'd', 2),
      // A coverage gap closes the forecasts still open.
      observe(64, fiveFills, yourBid(3)),
      track(64),
      () => journal.gap('hidden', 'Tab hidden', at(64.5)),
      // History that differs in one field of one trade is another round.
      ...changedHistories.map((trades) => observe(65, trades, {})),
      () => journal.summary(),
    ];
    const results = steps.map((step) => {
      const result = outcome(step);
      return result.value === journal ? 'journal' : result;
    });
    const events = journal.events;
    return {
      beforeObserving,
      results,
      journal: journalState(journal),
      emitted,
      replays: [2, 20, 45, events.length].map((cut) =>
        release.Journal.replay(clone(events.slice(0, cut))),
      ),
      fillOutcomes: release.Journal.scoredFillOutcomes(events),
      livePredictions: release.Journal.livePredictions(events),
    };
  }

  // Rounds stored by older versions and bare records: fills without an anchor
  // or a confidence, and records without a sequence number or any events.
  function restoredRecords(release) {
    const trade = { b: 'You', s: 'Bot-A', suit: 'h', p: 6 };
    const snapshot = table([], {});
    const fill = (seq, fields) => ({
      kind: 'fill',
      seq,
      at: at(seq),
      index: seq - 1,
      trade,
      ...fields,
    });
    const quote = (seq, owner) => ({
      kind: 'quote',
      seq,
      at: at(seq),
      owner,
      side: 'ask',
      suit: 'h',
      price: 6,
      epoch: 3,
    });
    const events = [
      fill(1, { initiator: 'You' }),
      fill(2, { initiator: null, anchor: 7, netBefore: snapshot.net }),
      fill(3, { initiator: 'Nobody', initiatorConfidence: 0.9, recovered: true }),
      quote(4, 'Bot-A'),
      quote(5, null),
      { kind: 'checkpoint', seq: 6, at: at(6), snapshot },
    ];
    const peek = { kind: 'training_peek', seq: 1, at: at(1) };
    const records = [
      [{ id: 'legacy', base: 'b', snapshot, updatedAt: at(9), practicePeeked: true }, events],
      [{ id: 'numbered', base: 'b', seq: 40, snapshot, observedAt: at(8) }, events],
      [{ id: 'empty', base: 'b', snapshot }, []],
      [{ id: 'peeked', base: 'b', snapshot }, [peek]],
    ];
    return records.map(([record, recorded]) =>
      journalState(release.Journal.restore(clone(record), clone(recorded))),
    );
  }

  return [
    {
      name: 'journal: recovered history, quotes, commands and outcomes',
      check(output) {
        const kinds = new Set(output.emitted.map((event) => event.kind));
        for (const kind of ['fill', 'quote', 'book_clear', 'book_reset', 'balances', 'coverage']) {
          assert.ok(kinds.has(kind), `records a ${kind} event`);
        }
        assert.ok(output.emitted.some((event) => event.classification === 'own-command'));
        assert.ok(output.emitted.some((event) => event.classification === 'ask-taken'));
        const reasons = output.emitted
          .filter((event) => event.kind === 'fill_outcome')
          .map((event) => event.reason);
        assert.deepEqual([...new Set(reasons)].sort(), [
          'coverage gap',
          'fill',
          'reset',
          'top changed',
        ]);
        assert.equal(output.results[23].threw, 'Invalid revealed goal');
      },
      run: recordedSession,
    },
    {
      name: 'journal: events exactly on the time limits',
      check(output) {
        const emittedOf = (kind) => output.emitted.filter((event) => event.kind === kind);
        assert.deepEqual(
          emittedOf('fill_outcome').map((event) => [event.reason, event.censored]),
          [
            ['top changed', true],
            ['horizon', false],
            ['reset', false],
            ['fill', false],
            ['top changed', true],
            ['top changed', true],
            ['top changed', false],
            ['fill', false],
            ['top changed', false],
            ['coverage gap', true],
          ],
        );
        assert.deepEqual(
          emittedOf('fill').map((event) => event.classification),
          ['ask-taken', 'ask-taken', 'unknown', 'unknown', 'ask-taken'],
        );
        assert.equal(emittedOf('prediction').length, 2);
        assert.ok(emittedOf('checkpoint').some((event) => event.at === at(10)));
        const { bid, ask } = output.journal.rates;
        assert.deepEqual([bid.outbids, ask.outbids], [0, 0], 'a same-price owner change');
        assert.deepEqual([bid.fills, ask.fills], [0, 3]);
        assert.equal(output.journal.previous.context.learningMode, true);
        const rejected = output.results.filter((result) => result.threw);
        assert.equal(rejected.length, 4, 'each changed history is rejected');
        assert.equal(output.journal.commands.length, 1, 'older order attempts are forgotten');
      },
      run: boundarySession,
    },
    {
      name: 'journal: restoring stored rounds',
      check(output) {
        // The evidence list was built in the model's own context; copy it here.
        const confidences = Array.from(output[0].evidence)
          .filter((evidence) => evidence.kind !== 'quote')
          .map((evidence) => evidence.confidence);
        assert.deepEqual(confidences, [0.6, 0.6, 0, 0, 0.9, 0.9]);
        assert.deepEqual(
          output.map((journal) => journal.seq),
          [6, 40, 0, 1],
        );
        assert.deepEqual(
          output.map((journal) => journal.practicePeeked),
          [true, false, false, true],
        );
      },
      run: restoredRecords,
    },
    {
      name: 'journal: predicates and scoring of stored events',
      check(output) {
        assert.equal(output.scores[0].signalComparison.checkpoints, 2);
        assert.deepEqual(
          output.scores.map((score) => score === null),
          [false, true, true, true, true, false],
        );
        assert.equal(output.fillOutcomes.filter((fill) => fill.legacyRecovered).length, 4);
      },
      run: storedEventScores,
    },
  ];
}

module.exports = { journalCases };
