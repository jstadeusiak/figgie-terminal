/* Causal, bounded public bid timing summaries. Candidate v1; no outcome inputs.
   Local observation times describe visible commitment, not exchange latency. */
(function (scope) {
  'use strict';
  const VERSION = 'bid-signals-v1';
  const SUITS = ['s', 'c', 'd', 'h'];
  const LIMITS = Object.freeze({
    coverageMs: 2000,
    dwellMs: 10000,
    epochs: 6,
    fastMs: 2000,
    fastCount: 3,
  });
  const KINDS = new Set([
    'round_start',
    'checkpoint',
    'state',
    'clock',
    'coverage',
    'quote',
    'fill',
    'book_reset',
    'book_clear',
  ]);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const validPrice = (x) => Number.isFinite(x) && x > 0;
  const active = (f) => f?.status === 'live' && f.antePending === false;
  const emptyBook = () => Object.fromEntries(SUITS.map((s) => [s, { owner: null, price: null }]));
  function initial(self) {
    return {
      self: self || null,
      players: [],
      frame: null,
      rows: {},
      resets: [],
      pendingReset: null,
      clockKey: null,
      serial: 0,
      blockNextCoverage: false,
      coverage: {
        coveredMs: 0,
        excludedMs: 0,
        qualifiedResets: 0,
        coObservedReturns: 0,
        recoveredReturns: 0,
      },
    };
  }
  function publicEvent(e) {
    const p = { kind: e.kind, at: e.at, seq: e.seq };
    if (e.kind === 'round_start' || e.kind === 'checkpoint') {
      const s = e.snapshot || {};
      p.source = {
        self: s.self,
        players: (s.players || []).map((x) => x.name),
        status: s.status,
        timer: s.timer,
        epoch: Array.isArray(s.trades) ? s.trades.length : null,
        book: (s.markets || []).map((m) => [m.id, m.bid, m.buyer]),
      };
      if (Object.hasOwn(s, 'antePending')) p.source.antePending = s.antePending;
    } else if (e.kind === 'state') {
      p.source = {
        status: e.status,
        timer: e.timer,
        book: (e.book || []).map((r) => [r[0], r[1], r[3]]),
      };
      if (Object.hasOwn(e, 'antePending')) p.source.antePending = e.antePending;
    } else if (e.kind === 'clock') {
      p.timer = e.timer;
      p.status = e.status;
    } else if (e.kind === 'coverage') {
      p.status = e.status;
      p.reason = e.reason;
      p.gapSeconds = e.gapSeconds;
    } else if (e.kind === 'quote') {
      Object.assign(p, {
        suit: e.suit,
        side: e.side,
        price: e.price,
        owner: e.owner,
        epoch: e.epoch,
        recovered: e.recovered === true,
      });
    } else if (e.kind === 'fill') {
      p.index = e.index;
      p.recovered = e.recovered === true;
    } else if (e.kind === 'book_reset') {
      p.cause = e.cause;
      p.from = e.from;
      p.to = e.to;
    } else if (e.kind === 'book_clear') {
      p.suit = e.suit;
      p.side = e.side;
    }
    return p;
  }
  function rowFor(state, owner, suit, epoch, price) {
    if (
      owner === state.self ||
      !state.players.includes(owner) ||
      !SUITS.includes(suit) ||
      !Number.isInteger(epoch) ||
      !validPrice(price)
    )
      return null;
    const key = JSON.stringify([owner, suit, epoch]);
    let row = state.rows[key];
    if (!row)
      row = state.rows[key] = { owner, suit, epoch, peak: price, ms: 0, serial: ++state.serial };
    if (price > row.peak) {
      row.peak = price;
      row.ms = 0;
    }
    return row;
  }
  function trimRows(state) {
    // At most six measured episodes plus the current unmeasured episode per pair.
    for (const owner of state.players)
      for (const suit of SUITS) {
        const rows = Object.entries(state.rows)
          .filter(([, r]) => r.owner === owner && r.suit === suit)
          .sort((a, b) => b[1].serial - a[1].serial);
        let measured = 0;
        let unmeasured = 0;
        for (const [key, row] of rows) {
          if (row.ms > 0 ? ++measured > LIMITS.epochs : ++unmeasured > 1) delete state.rows[key];
        }
      }
  }
  function applyGroup(state, group) {
    if (!group) return;
    const start = group.events.find((e) => e.kind === 'round_start');
    if (start) {
      const self = start.source.self || state.self;
      Object.assign(state, initial(self));
    }
    const prior = state.frame;
    // Never rewind the coverage watermark: otherwise a later recovery can count
    // part of an already counted interval twice. Wait for a fresh source boundary.
    if (prior && group.at < prior.at) {
      state.pendingReset = null;
      state.blockNextCoverage = true;
      return;
    }
    const frame = prior
      ? clone(prior)
      : {
          at: group.at,
          status: 'unknown',
          antePending: null,
          timer: null,
          epoch: null,
          book: emptyBook(),
        };
    frame.at = group.at;
    let source = false;
    let explicitGap = false;
    const quotes = [];
    const fills = [];
    const resets = [];
    for (const e of group.events) {
      if (e.source) {
        source = true;
        const s = e.source;
        if (s.self) state.self = s.self;
        if (s.players?.length) state.players = s.players.slice();
        if (s.status !== undefined) frame.status = s.status;
        if (s.timer !== undefined) frame.timer = s.timer;
        if (Object.hasOwn(s, 'antePending'))
          frame.antePending = typeof s.antePending === 'boolean' ? s.antePending : null;
        if (Number.isInteger(s.epoch)) frame.epoch = s.epoch;
        if (s.book.length) {
          frame.book = emptyBook();
          for (const [suit, price, owner] of s.book)
            if (SUITS.includes(suit)) frame.book[suit] = { price, owner };
        }
      } else if (e.kind === 'clock') {
        const key = JSON.stringify([e.timer, e.status]);
        // Duplicate clock payloads do not manufacture coverage between real ticks.
        if (key !== state.clockKey) {
          source = true;
          state.clockKey = key;
          frame.timer = e.timer;
          if (e.status !== undefined) frame.status = e.status;
        }
      } else if (e.kind === 'coverage') {
        explicitGap = true;
        if (e.status !== undefined) frame.status = e.status;
      } else if (e.kind === 'quote' && e.side === 'bid' && SUITS.includes(e.suit)) {
        quotes.push(e);
        frame.book[e.suit] = { price: e.price, owner: e.owner };
        if (Number.isInteger(e.epoch)) frame.epoch = e.epoch;
      } else if (e.kind === 'fill') fills.push(e);
      else if (e.kind === 'book_reset') {
        resets.push(e);
        frame.book = emptyBook();
        if (Number.isInteger(e.to)) frame.epoch = e.to;
      } else if (e.kind === 'book_clear' && e.side === 'bid' && SUITS.includes(e.suit))
        frame.book[e.suit] = { owner: null, price: null };
    }
    // Quotes alone, predictions, commands, and repeated clock payloads cannot
    // extend an unchanged book. A later source frame must confirm the interval.
    if (!source) {
      if (
        explicitGap ||
        quotes.length ||
        resets.length ||
        group.events.some((e) => e.kind === 'book_clear')
      ) {
        state.pendingReset = null;
        state.blockNextCoverage = true;
        // Retain observed book changes provisionally, without renewing coverage.
        // The next confirmed source is a boundary, never an elapsed-time credit.
        if (prior) {
          frame.at = prior.at;
          state.frame = frame;
        }
      }
      return;
    }
    const dt = prior ? group.at - prior.at : 0;
    const continuous = Boolean(
      prior &&
      dt > 0 &&
      dt <= LIMITS.coverageMs &&
      active(prior) &&
      active(frame) &&
      !explicitGap &&
      !state.blockNextCoverage,
    );
    state.blockNextCoverage = false;
    if (continuous) {
      state.coverage.coveredMs += dt;
      for (const suit of SUITS) {
        const q = prior.book[suit];
        const row = rowFor(state, q.owner, suit, prior.epoch, q.price);
        if (row && q.price === row.peak) row.ms = Math.min(LIMITS.dwellMs, row.ms + dt);
      }
    } else {
      if (dt > 0) state.coverage.excludedMs += dt;
      state.pendingReset = null;
    }
    for (const reset of resets) {
      const matched = fills.filter(
        (f) =>
          Number.isInteger(f.index) && f.index >= reset.from && f.index < reset.to && !f.recovered,
      );
      const qualified =
        continuous &&
        reset.cause === 'fill' &&
        Number.isInteger(reset.from) &&
        Number.isInteger(reset.to) &&
        reset.to > reset.from &&
        prior.epoch === reset.from &&
        new Set(matched.map((f) => f.index)).size === reset.to - reset.from;
      state.pendingReset = null;
      if (qualified) {
        state.coverage.qualifiedResets++;
        const r = {
          epoch: reset.to,
          at: group.at,
          returned: {},
          fast: {},
          expected: clone(prior.book),
        };
        state.resets.push(r);
        state.resets = state.resets.slice(-LIMITS.epochs);
        state.pendingReset = r.epoch;
      }
    }
    if (active(frame)) {
      for (const q of quotes) {
        rowFor(state, q.owner, q.suit, q.epoch, q.price);
        const r = state.resets.find((r) => r.epoch === state.pendingReset);
        if (
          !r ||
          r.epoch !== q.epoch ||
          r.returned[q.suit] ||
          r.expected[q.suit]?.owner !== q.owner ||
          !validPrice(r.expected[q.suit]?.price) ||
          q.owner === state.self ||
          !state.players.includes(q.owner) ||
          !validPrice(q.price)
        )
          continue;
        // Even an unmeasurable first return consumes this reset's opportunity: a
        // later price update is not a second re-entry into the book.
        r.returned[q.suit] = true;
        const delay = group.at - r.at;
        if (q.recovered) {
          state.coverage.recoveredReturns++;
          continue;
        }
        if (delay === 0) {
          state.coverage.coObservedReturns++;
          continue;
        }
        if (delay > 0 && delay <= LIMITS.fastMs) r.fast[q.suit] = q.owner;
      }
      for (const suit of SUITS) {
        const q = frame.book[suit];
        rowFor(state, q.owner, suit, frame.epoch, q.price);
        const r = state.resets.find((r) => r.epoch === state.pendingReset);
        // A source book can show the owner already back even when its quote event
        // was missed. Do not let a later amendment masquerade as the first return.
        if (
          r &&
          r.epoch === frame.epoch &&
          q.owner === r.expected[suit]?.owner &&
          validPrice(q.price)
        )
          r.returned[suit] = true;
      }
    }
    const pending = state.resets.find((r) => r.epoch === state.pendingReset);
    if (pending && (group.at - pending.at > LIMITS.fastMs || !active(frame)))
      state.pendingReset = null;
    state.frame = frame;
    trimRows(state);
  }
  function summarize(state) {
    const opponents = state.players.filter((n) => n !== state.self);
    const byActor = {};
    for (const owner of opponents) {
      byActor[owner] = SUITS.map((suit) => {
        const rows = Object.values(state.rows)
          .filter((r) => r.owner === owner && r.suit === suit && r.ms > 0)
          .sort((a, b) => b.serial - a.serial)
          .slice(0, LIMITS.epochs);
        const returns = state.resets.filter((r) => r.fast[suit] === owner).length;
        return {
          dwell: rows.length
            ? rows.reduce((a, r) => a + r.ms / LIMITS.dwellMs, 0) / rows.length
            : 0,
          fastReturn: Math.min(LIMITS.fastCount, returns) / LIMITS.fastCount,
          measuredEpochs: rows.length,
          fastReturns: returns,
        };
      });
    }
    const values = SUITS.map((_, s) =>
      [0, 1].map((i) =>
        opponents.length
          ? opponents.reduce((a, n) => a + byActor[n][s][i ? 'fastReturn' : 'dwell'], 0) /
            opponents.length
          : 0,
      ),
    );
    return {
      version: VERSION,
      suits: SUITS.slice(),
      columns: ['peakBidDwell', 'fastReturn'],
      values,
      diagnostics: {
        asOf: state.frame?.at ?? null,
        epoch: state.frame?.epoch ?? null,
        opponents: opponents.length,
        byActor,
        coverage: { ...state.coverage },
      },
    };
  }
  class Tracker {
    constructor(options = {}) {
      this.self = options.self || null;
      this.state = initial(this.self);
      this.pending = null;
      this.roundId = null;
      this.lastSeq = -1;
    }
    push(event) {
      if (!event || typeof event !== 'object') return this;
      if (event.roundId && this.roundId && event.roundId !== this.roundId) {
        this.state = initial(this.self);
        this.pending = null;
        this.lastSeq = -1;
      }
      if (event.roundId) this.roundId = event.roundId;
      if (Number.isInteger(event.seq)) {
        if (event.seq <= this.lastSeq) return this;
        this.lastSeq = event.seq;
      }
      if (!KINDS.has(event.kind) || !Number.isFinite(event.at)) return this;
      if (this.pending && this.pending.at !== event.at) {
        applyGroup(this.state, this.pending);
        this.pending = null;
      }
      if (!this.pending) this.pending = { at: event.at, events: [] };
      this.pending.events.push(publicEvent(event));
      return this;
    }
    pushAll(events) {
      for (const e of events || []) this.push(e);
      return this;
    }
    features() {
      const preview = clone(this.state);
      applyGroup(preview, this.pending);
      return summarize(preview);
    }
  }
  scope.FiggieBidSignals = { VERSION, SUITS, LIMITS, Tracker };
  if (typeof module !== 'undefined') module.exports = scope.FiggieBidSignals;
})(globalThis);
