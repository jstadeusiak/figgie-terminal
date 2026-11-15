/* Content bridge between the Figgie page and the terminal.

   It reads the rendered game through FiggieAdapter, forwards each observation
   to the terminal view, streams recording events to the service worker, and
   carries out the user's manual actions on Figgie's own controls.

   Every order starts with a user action in the terminal. This script never
   decides to trade: it revalidates the live book, then clicks or types into
   the native control that Figgie already rendered. */
(() => {
  'use strict';

  const HOST_ID = 'figgie-terminal-host';
  if (document.getElementById(HOST_ID)) return;

  // A live round whose game clock has not moved for this long is shown as paused.
  const STALE_CLOCK_MS = 5000;
  // How long an order may go without visible confirmation before the user is told.
  const ORDER_CONFIRMATION_TIMEOUT_MS = 2500;
  // An identical quote posted again inside this window is an accidental double submit.
  const DUPLICATE_POST_WINDOW_MS = 200;
  // An unchanged game is still recorded this often, so recordings keep the clock.
  const OBSERVATION_HEARTBEAT_MS = 1000;
  const SETTLEMENT_CHECK_INTERVAL_MS = 1000;
  const WATCHDOG_INTERVAL_MS = 250;
  const WATCHDOG_MAX_IDLE_MS = 200;

  const RECORD_FLUSH_DELAY_MS = 40;
  const RECORD_RETRY_DELAY_MS = 1000;
  const RECORD_BATCH_SIZE = 16;
  const RECORD_PIPELINED_BATCH_SIZE = 32;
  const MAX_RECORD_FLIGHTS = 2;

  // When a recorded event should leave for the service worker.
  const FLUSH_NOW = 'now';
  const FLUSH_BATCHED = 'batched';
  // Never written synchronously: an order reaches Figgie before its own log entry.
  const FLUSH_DEFERRED = 'deferred';

  const EXPORT_URL_LIFETIME_MS = 10000;
  const TOP_LAYER = '2147483647';
  const LOBBY_TITLES = ['Home', 'Lobby', 'Login', 'Setup', 'DailyRewards'];
  const TRAINING_EVENT_KINDS = ['training_prediction', 'training_peek', 'training_continue'];

  const SUITS = [
    { id: 's', name: 'Spades', symbol: '♠' },
    { id: 'c', name: 'Clubs', symbol: '♣' },
    { id: 'd', name: 'Diamonds', symbol: '♦' },
    { id: 'h', name: 'Hearts', symbol: '♥' },
  ];

  /* The terminal's commands, described once.
       type   how the command operates Figgie: `take` clicks a resting quote,
              `post` types a price, `quick` clicks the one-chip improve arrow,
              `cancel` clicks the cancel control.
       quote  the native quote the command acts on. A take acts on the opposite
              side: buying takes the ask, selling hits the bid.
       buys   whether a fill adds a card to the user's hand.
       lane   commands sharing a lane cannot be pending at the same time. */
  const COMMANDS = {
    buy: { type: 'take', quote: 'ask', buys: true, lane: 'buy' },
    sell: { type: 'take', quote: 'bid', buys: false, lane: 'sell' },
    bid: { type: 'post', quote: 'bid', buys: true, lane: 'bid' },
    offer: { type: 'post', quote: 'ask', buys: false, lane: 'offer' },
    'raise-bid': { type: 'quick', quote: 'bid', buys: true, lane: 'bid' },
    'lower-ask': { type: 'quick', quote: 'ask', buys: false, lane: 'offer' },
    'cancel-bid': { type: 'cancel', quote: 'bid', buys: true, lane: 'bid' },
    'cancel-offer': { type: 'cancel', quote: 'ask', buys: false, lane: 'offer' },
  };

  // ── Page overlay ───────────────────────────────────────────────────────

  function createOverlayElement(tag, id, style) {
    const element = document.createElement(tag);
    element.id = id;
    Object.assign(element.style, style);
    return element;
  }

  const FLOATING_BUTTON_STYLE = {
    position: 'fixed',
    bottom: '12px',
    zIndex: TOP_LAYER,
    borderRadius: '6px',
    padding: '11px 16px',
    font: '14px system-ui',
    cursor: 'pointer',
  };

  const frame = createOverlayElement('div', HOST_ID, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    border: '0',
    zIndex: '2147483646',
    display: 'none',
    background: '#0d1619',
  });
  const shadow = frame.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' + FiggieTerminalAssets.css + '</style>' + FiggieTerminalAssets.html;

  const toggle = createOverlayElement('button', 'figgie-terminal-toggle', {
    ...FLOATING_BUTTON_STYLE,
    right: '12px',
    background: '#74dfbd',
    color: '#10251e',
    border: '0',
    display: 'none',
  });
  toggle.textContent = 'Open terminal';
  document.body.append(frame, toggle);

  // ── Recordings panel ───────────────────────────────────────────────────
  // Keeps completed recordings reachable after Figgie removes an ended match.

  const recordingsButton = createOverlayElement('button', 'figgie-recordings-toggle', {
    ...FLOATING_BUTTON_STYLE,
    right: '232px',
    background: '#24383e',
    color: '#e3eeee',
    border: '1px solid #547079',
  });
  recordingsButton.textContent = 'Recordings';

  const recordingsPanel = createOverlayElement('div', 'figgie-recordings-panel', {
    position: 'fixed',
    right: '12px',
    bottom: '64px',
    width: 'min(390px, 90vw)',
    zIndex: TOP_LAYER,
    background: '#172a30',
    color: '#e3eeee',
    border: '1px solid #547079',
    borderRadius: '8px',
    padding: '16px',
    font: '14px system-ui',
    display: 'none',
    boxShadow: '0 8px 30px #0008',
  });
  const goalOptions = SUITS.map(
    (suit) => `<option value="${suit.id}">${suit.symbol} ${suit.name}</option>`,
  ).join('');
  recordingsPanel.innerHTML = [
    '<strong>Local recordings</strong>',
    '<label style="display:block;margin:12px 0 4px">Recorded round</label>',
    '<select aria-label="Recorded round" style="width:100%"></select>',
    '<label style="display:block;margin:12px 0 4px">Revealed goal</label>',
    `<select aria-label="Recorded round goal"><option value="">Choose suit…</option>${goalOptions}</select>`,
    '<button type="button" data-save>Record result</button>',
    '<p data-round-pnl></p>',
    '<p role="status">Loading recordings…</p>',
    '<button type="button" data-export>Export round</button> ',
    '<button type="button" data-export-all>Export all</button> ',
    '<button type="button" data-close>Close</button>',
  ].join('');
  document.body.append(recordingsButton, recordingsPanel);

  const roundSelect = recordingsPanel.querySelector('[aria-label="Recorded round"]');
  const goalSelect = recordingsPanel.querySelector('[aria-label="Recorded round goal"]');
  const saveGoalButton = recordingsPanel.querySelector('[data-save]');
  const roundPnlLine = recordingsPanel.querySelector('[data-round-pnl]');
  const recordingsStatus = recordingsPanel.querySelector('[role=status]');
  let recordedRounds = [];

  // Resolves with the service worker's response; rejects on a transport or handler error.
  function requestFromWorker(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError?.message || response?.error;
        if (error) reject(Error(error));
        else resolve(response);
      });
    });
  }

  const signedChips = (value) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}`;
  const suitName = (id) => SUITS.find((suit) => suit.id === id)?.name;

  function roundLabel(round) {
    const parts = [
      `${round.practice ? 'Practice · ' : ''}${round.self}`,
      `R${round.round}`,
      new Date(round.updatedAt).toLocaleString(),
    ];
    if (Number.isFinite(round.pnl?.actualPnl)) {
      parts.push('P&L ' + signedChips(round.pnl.actualPnl));
    }
    return parts.join(' · ');
  }

  function roundPnlText(pnl) {
    if (!Number.isFinite(pnl?.actualPnl)) {
      return 'Final P&L unavailable: a settled bank or complete revealed hands are required.';
    }
    return `Round P&L ${signedChips(pnl.actualPnl)} chips · Final. Trading cash ${pnl.netCash.toFixed(2)} + settlement ${pnl.actualPayout.toFixed(2)} − ante ${pnl.ante.toFixed(2)}.`;
  }

  function goalStatusText(round) {
    if (round?.goal) return 'Saved goal: ' + suitName(round.goal);
    if (round?.ended) return 'Enter the goal revealed at the end of this round.';
    return 'Result entry is available after the recorded round ends.';
  }

  function showSelectedRound() {
    const round = recordedRounds.find((candidate) => candidate.id === roundSelect.value);
    goalSelect.value = round?.goal || '';
    saveGoalButton.disabled = !round?.ended || Boolean(round.goal);
    roundPnlLine.textContent = roundPnlText(round?.pnl);
    recordingsStatus.textContent = goalStatusText(round);
  }

  async function openRecordings() {
    recordingsPanel.style.display = 'block';
    try {
      recordedRounds = (await requestFromWorker({ type: 'figgie-rounds' })).rounds;
      roundSelect.replaceChildren();
      for (const round of recordedRounds) {
        const option = document.createElement('option');
        option.value = round.id;
        option.textContent = roundLabel(round);
        roundSelect.append(option);
      }
      showSelectedRound();
      if (!recordedRounds.length) recordingsStatus.textContent = 'No rounds recorded yet.';
    } catch (error) {
      recordingsStatus.textContent = error.message;
    }
  }

  async function saveRevealedGoal() {
    if (!goalSelect.value) return;
    try {
      const response = await requestFromWorker({
        type: 'figgie-reveal',
        roundId: roundSelect.value,
        result: { goal: goalSelect.value, source: 'user-confirmed', verified: false },
      });
      recordedRounds.find((round) => round.id === roundSelect.value).goal = goalSelect.value;
      showSelectedRound();
      const scoredRounds = response.metrics.rounds;
      recordingsStatus.textContent = `Goal saved · ${scoredRounds} scored round${scoredRounds === 1 ? '' : 's'}.`;
    } catch (error) {
      recordingsStatus.textContent = error.message;
    }
  }

  async function exportRecordings(roundId) {
    try {
      recordingsStatus.textContent = 'Exporting recordings…';
      const response = await FiggieRecordingExport.read(requestFromWorker, roundId);
      const url = URL.createObjectURL(new Blob(response.parts, { type: 'application/x-ndjson' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = response.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_LIFETIME_MS);
      recordingsStatus.textContent = 'Recording exported.';
    } catch (error) {
      recordingsStatus.textContent = error.message;
    }
  }

  recordingsButton.addEventListener('click', openRecordings);
  roundSelect.addEventListener('change', showSelectedRound);
  recordingsPanel.querySelector('[data-close]').addEventListener('click', () => {
    recordingsPanel.style.display = 'none';
  });
  saveGoalButton.addEventListener('click', saveRevealedGoal);
  recordingsPanel
    .querySelector('[data-export]')
    .addEventListener('click', () => exportRecordings(roundSelect.value));
  recordingsPanel
    .querySelector('[data-export-all]')
    .addEventListener('click', () => exportRecordings('all'));

  // ── State ──────────────────────────────────────────────────────────────

  // The terminal view. `ready` once it has mounted; `enabled` until the user
  // picks "Show Figgie", and again from the next round; `shown` while it covers the page.
  let view;
  let ready = false;
  let enabled = true;
  let shown = false;

  // The latest observation of the page.
  let lastSnapshot = null;
  let lastSignature = '';
  let lastRoundKey = '';
  let serial = 0;
  let analysisRevision = 0;
  let lastRecordAt = 0;
  // Lobby settings (such as bot difficulty) carried into the round's observations.
  let context = {};

  // The game clock, and when it last advanced.
  let lastClock = '';
  let clockAt = Date.now();

  // Refresh scheduling and the observer on Figgie's root element.
  let refreshPending = false;
  let refreshFrame = null;
  let lastRefreshAt = 0;
  let observedRoot = null;
  let sourceObserver = null;

  // Orders awaiting visible confirmation, and guards against sending one twice.
  const orders = new Map();
  const attemptedTakes = new Set();
  let lastPost = '';
  let lastPostAt = 0;

  // Recording stream. Events stay in `unconfirmedRecords` until the worker
  // acknowledges a durable write; `flights` maps each write in progress to the
  // highest sequence number it carries.
  const recordStream = crypto.randomUUID();
  const flights = new Map();
  let unconfirmedRecords = [];
  let recordSeq = 0;
  let durableSeq = 0;
  let flightId = 0;
  let flushTimer = null;
  let lastGap = '';

  // Round results and practice exposure.
  let lastReveal = '';
  let lastRevealCheck = 0;
  let pendingPracticeExposure = false;
  let practiceExposureRound = '';

  const send = (message) => ready && view.receive(message);

  // ── Recording stream ───────────────────────────────────────────────────

  function flushRecords() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (flights.size >= MAX_RECORD_FLIGHTS || !unconfirmedRecords.length) return;
    // Pipeline at most two writes. Every flight repeats the unacknowledged
    // prefix, so even reversed delivery cannot skip a stream event. The worker
    // deduplicates stream/seq; only a durable ACK releases that prefix here.
    const batch = unconfirmedRecords.slice(
      0,
      flights.size ? RECORD_PIPELINED_BATCH_SIZE : RECORD_BATCH_SIZE,
    );
    const through = batch.at(-1).seq;
    if (through <= Math.max(0, ...flights.values())) return;
    const flight = ++flightId;
    flights.set(flight, through);
    const done = (response) => finishFlight(flight, through, response);
    try {
      chrome.runtime.sendMessage({ type: 'figgie-record', batch }, done);
    } catch (error) {
      done({ error: error.message });
    }
  }

  function finishFlight(flight, through, response) {
    flights.delete(flight);
    const error = chrome.runtime.lastError?.message || response?.error;
    const alreadyDurable = through <= durableSeq;
    if (error && !alreadyDurable) {
      const coveredByAnotherFlight = [...flights.values()].some((seq) => seq >= through);
      if (!coveredByAnotherFlight) {
        send({
          type: 'recording',
          recording: { error, pendingEvents: unconfirmedRecords.length },
        });
      }
      if (!flushTimer) flushTimer = setTimeout(flushRecords, RECORD_RETRY_DELAY_MS);
      return;
    }
    if (!error && !alreadyDurable) {
      durableSeq = through;
      unconfirmedRecords = unconfirmedRecords.filter((item) => item.seq > through);
      if (response?.recording) send({ type: 'recording', recording: response.recording });
    }
    if (unconfirmedRecords.length) flushRecords();
  }

  function record(kind, data = {}, flush = FLUSH_BATCHED) {
    // The view updates its snapshot clock in place; preserve the observation
    // as captured while a previous durable write is still outstanding.
    if (data.snapshot) data = { ...data, snapshot: { ...data.snapshot } };
    unconfirmedRecords.push({
      kind,
      at: Date.now(),
      stream: recordStream,
      seq: ++recordSeq,
      ...data,
    });
    const batchFull = unconfirmedRecords.length >= RECORD_BATCH_SIZE;
    if (flush === FLUSH_NOW || (flush === FLUSH_BATCHED && batchFull)) flushRecords();
    else if (!flushTimer) flushTimer = setTimeout(flushRecords, RECORD_FLUSH_DELAY_MS);
  }

  // Records why the game could not be observed, once per distinct reason.
  function recordGap(status, reason) {
    const key = status + '|' + reason;
    if (key === lastGap) return;
    lastGap = key;
    record('gap', { status, reason }, FLUSH_NOW);
  }

  function captureSettlement() {
    if (!lastSnapshot || Date.now() - lastRevealCheck < SETTLEMENT_CHECK_INTERVAL_MS) return;
    lastRevealCheck = Date.now();
    const result = FiggieAdapter.readSettlement?.(document, lastSnapshot);
    if (!result) return;
    const key = lastSnapshot.roundKey + '|' + result.goal;
    if (key === lastReveal) return;
    lastReveal = key;
    record('reveal', { result }, FLUSH_NOW);
    send({ type: 'round-result', result });
  }

  // ── Terminal visibility ────────────────────────────────────────────────

  // Covers Figgie with the terminal, or uncovers it. Figgie's own interface is
  // hidden rather than removed: its controls must stay mounted to be operated.
  function setTerminalVisible(visible) {
    if (shown !== visible) {
      shown = visible;
      frame.style.display = visible ? 'block' : 'none';
    }
    const toggleDisplay = visible ? 'none' : 'block';
    toggle.textContent =
      lastSnapshot?.status === 'live' ? 'Open terminal' : 'Terminal ready · auto on';
    if (toggle.style.display !== toggleDisplay) toggle.style.display = toggleDisplay;
    recordingsButton.style.display = visible ? 'none' : 'block';
    if (visible) recordingsPanel.style.display = 'none';

    const source = document.getElementById('root');
    if (!source) return;
    const opacity = visible ? '0' : '';
    const pointerEvents = visible ? 'none' : '';
    if (source.style.opacity !== opacity) source.style.opacity = opacity;
    if (source.style.pointerEvents !== pointerEvents) source.style.pointerEvents = pointerEvents;
  }

  // ── Observing the page ─────────────────────────────────────────────────

  function readSource() {
    const started = performance.now();
    try {
      return FiggieAdapter.read(document);
    } finally {
      frame.dataset.readMs = (performance.now() - started).toFixed(1);
    }
  }

  const clockStalled = () => Date.now() - clockAt > STALE_CLOCK_MS;
  const sourceStalled = () => !navigator.onLine || clockStalled();

  const relevantStyle = (value) =>
    (value || '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) =>
        /^(?:background(?:-color)?|display|visibility|pointer-events)\s*:/i.test(part),
      )
      .join(';');

  // Card animation transforms/opacity change every frame. They cannot change
  // a quote, player identity, inventory count, or trade history.
  function isMeaningfulChange(change) {
    if (change.type !== 'attributes' || change.attributeName !== 'style') return true;
    if (change.target === observedRoot) return false;
    return relevantStyle(change.oldValue) !== relevantStyle(change.target.getAttribute('style'));
  }

  function sourceChanged(changes) {
    if (changes.some(isMeaningfulChange)) scheduleRefresh();
  }

  function scheduleRefresh() {
    if (refreshPending) return;
    refreshPending = true;
    refreshFrame = requestAnimationFrame(refresh);
  }

  // Figgie can replace its root element; follow it.
  function watchSourceRoot() {
    const root = document.getElementById('root');
    if (root === observedRoot) return;
    sourceObserver?.disconnect();
    observedRoot = root;
    if (!root) return;
    sourceObserver = new MutationObserver(sourceChanged);
    sourceObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['value', 'disabled', 'aria-disabled', 'hidden', 'style'],
    });
  }

  function refresh() {
    if (refreshPending && refreshFrame !== null) cancelAnimationFrame(refreshFrame);
    refreshPending = false;
    refreshFrame = null;
    lastRefreshAt = Date.now();
    watchSourceRoot();
    try {
      const snapshot = readSource();
      if (snapshot.status === 'waiting') observeWaiting(snapshot);
      else observeGame(snapshot);
    } catch (error) {
      recordGap('fault', error.message);
      captureSettlement();
      send({ type: 'fault', message: error.message });
    }
  }

  // No complete game is visible: a lobby, a transition, or a partial render.
  function observeWaiting(snapshot) {
    if (snapshot.training?.enabled && snapshot.training.handsVisible) {
      const roundWasInPlay = lastSnapshot && ['live', 'paused'].includes(lastSnapshot.status);
      if (!pendingPracticeExposure && roundWasInPlay) {
        record(
          'training_exposure',
          { data: { roundKey: lastSnapshot.roundKey, source: 'partial-visible-hands' } },
          FLUSH_NOW,
        );
      }
      pendingPracticeExposure = true;
    }
    const nextContext = FiggieAdapter.readContext?.(document);
    if (nextContext) context = { ...context, ...nextContext };
    recordGap('waiting', snapshot.reason);
    captureSettlement();
    if (LOBBY_TITLES.includes(document.title)) {
      enabled = true;
      setTerminalVisible(false);
      clockAt = Date.now();
      lastClock = '';
    } else if (enabled && !lastSnapshot && ready) {
      setTerminalVisible(true);
    }
    reconcileOrders(null);
    send({ type: 'waiting', reason: snapshot.reason });
  }

  function observeGame(snapshot) {
    if (pendingPracticeExposure) {
      practiceExposureRound = snapshot.roundKey;
      pendingPracticeExposure = false;
    }
    if (practiceExposureRound === snapshot.roundKey) {
      snapshot.context = { ...snapshot.context, learningExposure: true };
    }

    if (snapshot.roundKey !== lastRoundKey) {
      enabled = true;
      lastRoundKey = snapshot.roundKey;
      lastClock = '';
      clockAt = Date.now();
    }
    if (snapshot.timer !== lastClock) {
      lastClock = snapshot.timer;
      clockAt = Date.now();
    }
    if (snapshot.status === 'live' && sourceStalled()) snapshot.status = 'paused';

    reconcileOrders(snapshot);
    const previous = lastSnapshot;
    lastSnapshot = snapshot;
    const bookReset =
      !previous ||
      previous.roundKey !== snapshot.roundKey ||
      previous.trades.length !== snapshot.trades.length;
    if (bookReset) attemptedTakes.clear();

    const signature = snapshot.signature + '|' + snapshot.status;
    if (signature !== lastSignature) {
      lastSignature = signature;
      serial++;
      lastGap = '';
      const observed = recordObservation(snapshot);
      send({ type: 'snapshot', snapshot: observed });
    } else {
      if (Date.now() - lastRecordAt >= OBSERVATION_HEARTBEAT_MS) recordObservation(snapshot);
      send({
        type: 'heartbeat',
        timer: snapshot.timer,
        observedAt: Date.now(),
        status: snapshot.status,
        analysisRevision,
      });
    }

    // Restore/record this round before its result, even after a worker restart.
    if (snapshot.status === 'ended') captureSettlement();
    if (enabled && ready) setTerminalVisible(true);
  }

  // Records the snapshot, without its DOM references, as a new analysis revision.
  function recordObservation(snapshot) {
    const { refs, ...data } = snapshot;
    analysisRevision++;
    lastRecordAt = Date.now();
    const observed = {
      ...data,
      context: { ...context, ...snapshot.context },
      serial,
      analysisRevision,
      recordingRequired: true,
      observedAt: Date.now(),
    };
    record('observe', { snapshot: observed }, FLUSH_NOW);
    return observed;
  }

  // ── Order tracking ─────────────────────────────────────────────────────

  // Resolves each pending order once the page shows what became of it.
  function reconcileOrders(current) {
    for (const [id, order] of orders) {
      const outcome = orderOutcome(order, current);
      if (!outcome) continue;
      const { state, message } = outcome;
      orders.delete(id);
      if (state !== 'confirmed') attemptedTakes.delete(order.fingerprint);
      send({ type: 'order', id, state, message });
      const { kind, suit, price } = order.command;
      record('order_outcome', { data: { id, state, message, command: { kind, suit, price } } });
    }
  }

  function orderOutcome(order, current) {
    if (current && current.roundKey !== order.command.roundKey) {
      return { state: 'expired', message: 'Round changed; order tracking cleared.' };
    }
    const visible = current && visibleOutcome(order, current);
    if (visible) return visible;
    if (Date.now() - order.started > ORDER_CONFIRMATION_TIMEOUT_MS) {
      return {
        state: 'unconfirmed',
        message: 'No visible confirmation from Figgie. Check the quote before submitting again.',
      };
    }
    return null;
  }

  function visibleOutcome({ command, beforeCount }, current) {
    const action = COMMANDS[command.kind];
    const isCancel = action.type === 'cancel';
    const market = current.markets.find((candidate) => candidate.id === command.suit);
    const confirmed = (message) => ({ state: 'confirmed', message });

    const fill = current.trades
      .slice(beforeCount)
      .find(
        (trade) =>
          trade.suit === command.suit &&
          (action.buys
            ? trade.b === current.self && trade.p <= command.price
            : trade.s === current.self && trade.p >= command.price),
      );
    if (fill) {
      const prefix = isCancel ? 'Quote filled before cancellation: ' : '';
      return confirmed(`${prefix}Filled ${command.suit.toUpperCase()} at ${fill.p} chips.`);
    }

    const quoteOwner = action.quote === 'bid' ? market.buyer : market.seller;
    const quotePrice = action.quote === 'bid' ? market.bid : market.ask;
    if (isCancel && quoteOwner !== current.self) {
      return confirmed(`Your ${action.quote} cleared from the displayed market.`);
    }
    const restsQuote = action.type === 'post' || action.type === 'quick';
    if (restsQuote && quoteOwner === current.self && quotePrice === command.price) {
      return confirmed(`Your ${action.quote} at ${command.price} is live.`);
    }

    // Native takes carry the displayed quote's tradeId. A completed trade
    // resets the book and invalidates that id; never hold the old lane open
    // or retry it when another player won the race.
    if (action.type === 'take' && current.trades.length > beforeCount) {
      return {
        state: 'expired',
        message: 'Book reset; no matching fill observed. Review the new quotes.',
      };
    }
    return null;
  }

  // ── Manual actions ─────────────────────────────────────────────────────

  // Presets must rest in the book; one that would execute immediately is refused.
  function crossesBook(command, price, market) {
    if (command.restingOnly !== true) return false;
    if (command.kind === 'bid') return Number.isFinite(market.ask) && price >= market.ask;
    if (command.kind === 'offer') return Number.isFinite(market.bid) && price <= market.bid;
    return false;
  }

  // Confirms the native quote is still the one the user saw and acted on.
  function checkQuoteUnchanged(action, quote, command, price, self) {
    const ownerChanged = quote.owner !== command.owner;
    if (action.type === 'quick') {
      if (ownerChanged) throw Error('Quote changed. Review the refreshed price.');
      const step = action.quote === 'bid' ? 1 : -1;
      if (!quote.quick || quote.price === null || price !== quote.price + step) {
        throw Error('Quick price changed or is unavailable.');
      }
    }
    if (action.type === 'cancel') {
      if (ownerChanged) throw Error('Quote changed. Review the refreshed price.');
      if (!quote.cancel || quote.owner !== self || quote.price !== price) {
        throw Error('That quote is no longer yours to cancel.');
      }
    }
    if (action.type === 'take') {
      const takeable =
        !ownerChanged &&
        quote.price === price &&
        quote.button &&
        quote.owner &&
        quote.owner !== self;
      if (!takeable) throw Error('Quote changed or cleared. Review the refreshed price.');
    }
  }

  function clickControl(control, disabledMessage) {
    if (control.getAttribute('aria-disabled') === 'true') throw Error(disabledMessage);
    control.click();
  }

  // React tracks a controlled input through the native value setter. Setting the
  // value this way and dispatching `input` makes React see it as typed text.
  function typeIntoInput(input, text) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(input) {
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        charCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
  }

  async function postQuote(command, action, price, input) {
    if (input.disabled) throw Error('Figgie disabled this quote field.');
    typeIntoInput(input, String(price));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // React must receive the controlled value before Enter, but that frame
    // may also contain a fill/reset. Recheck identity and trade epoch after
    // the only asynchronous gap in the execution path.
    const refreshed = readSource();
    const freshInput = refreshed.refs?.get(command.suit)?.[action.quote].input;
    const freshMarket = refreshed.markets?.find((market) => market.id === command.suit);
    if (
      refreshed.status !== 'live' ||
      sourceStalled() ||
      refreshed.roundKey !== command.roundKey ||
      refreshed.trades.length !== command.tradeCount ||
      freshInput !== input ||
      !input.isConnected ||
      input.disabled ||
      input.value !== String(price) ||
      (action.buys ? price > refreshed.cash : !freshMarket?.held)
    ) {
      throw Error('Market changed before posting. Review the refreshed quote.');
    }
    if (crossesBook(command, price, freshMarket)) {
      throw Error('Preset price now crosses the book. Review the refreshed quote.');
    }
    pressEnter(input);
  }

  // Validates a command against the page as it is right now, then operates the
  // matching native control. Throws a user-facing reason when it must not be sent.
  async function dispatch(command, id) {
    const current = readSource();
    if (current.status !== 'live' || sourceStalled()) throw Error('This round is not trading.');
    if (!Object.hasOwn(COMMANDS, command.kind)) throw Error('Unknown trading action.');
    const action = COMMANDS[command.kind];
    const market = current.markets.find((candidate) => candidate.id === command.suit);
    const refs = current.refs.get(command.suit);
    if (!market || !refs || current.roundKey !== command.roundKey) {
      throw Error('Round changed. Try again.');
    }
    if (current.trades.length !== command.tradeCount) {
      throw Error('Market reset. Review the refreshed quote before submitting.');
    }

    const price = Number(command.price);
    const isCancel = action.type === 'cancel';
    const isTake = action.type === 'take';
    if (!Number.isSafeInteger(price) || price < 1) {
      throw Error('Enter a positive whole-chip price.');
    }
    if (!isCancel && action.buys && price > current.cash) throw Error('Insufficient game chips.');
    if (!isCancel && !action.buys && market.held < 1) {
      throw Error('You have no cards in this suit.');
    }
    if (crossesBook(command, price, market)) {
      throw Error('Preset price crosses the book. Use Buy or Sell now.');
    }
    const quote = refs[action.quote];
    checkQuoteUnchanged(action, quote, command, price, current.self);

    const fingerprint = [
      current.roundKey,
      current.trades.length,
      command.suit,
      command.kind,
      price,
      isTake ? quote.owner : '',
    ].join('|');
    const alreadySent = isTake
      ? attemptedTakes.has(fingerprint)
      : lastPost === fingerprint && Date.now() - lastPostAt < DUPLICATE_POST_WINDOW_MS;
    if (alreadySent) throw Error('This action was already sent. Wait for Figgie to update.');
    const lane = command.suit + '|' + action.lane;
    if ([...orders.values()].some((order) => order.lane === lane)) {
      throw Error('That order is still awaiting Figgie.');
    }

    orders.set(id, {
      command,
      beforeCount: current.trades.length,
      started: Date.now(),
      fingerprint,
      lane,
    });
    if (isTake) {
      attemptedTakes.add(fingerprint);
    } else {
      lastPost = fingerprint;
      lastPostAt = Date.now();
    }

    try {
      if (isTake) clickControl(quote.button, 'Figgie disabled this quote.');
      else if (isCancel) clickControl(quote.cancel, 'Figgie disabled this control.');
      else if (action.type === 'quick') clickControl(quote.quick, 'Figgie disabled this control.');
      else await postQuote(command, action, price, quote.input);
      scheduleRefresh();
    } catch (error) {
      orders.delete(id);
      attemptedTakes.delete(fingerprint);
      throw error;
    }
  }

  // ── Messages from the terminal view ────────────────────────────────────

  async function submitCommand({ id, command }) {
    const { kind, suit, price, owner, tradeCount, roundKey } = command;
    record(
      'command_attempt',
      {
        data: {
          id,
          command: { kind, suit, price, owner, tradeCount, roundKey },
          decision: command.decision || null,
        },
      },
      FLUSH_DEFERRED,
    );
    try {
      await dispatch(command, id);
      send({ type: 'ack', id, message: 'Submitted · awaiting Figgie confirmation…' });
      record('command_submitted', { data: { id } }, FLUSH_NOW);
    } catch (error) {
      send({ type: 'reject', id, message: error.message });
      record('command_rejected', { data: { id, message: error.message } }, FLUSH_NOW);
      scheduleRefresh();
    }
  }

  async function handleViewMessage(message) {
    switch (message.type) {
      case 'ready':
        ready = true;
        lastSignature = '';
        refresh();
        break;
      case 'show-original':
        enabled = false;
        setTerminalVisible(false);
        break;
      case 'training-event':
        if (
          TRAINING_EVENT_KINDS.includes(message.kind) &&
          message.data?.roundKey === lastSnapshot?.roundKey
        ) {
          record(message.kind, { data: message.data }, FLUSH_NOW);
        }
        break;
      case 'command':
        await submitCommand(message);
        break;
    }
  }

  // ── Start ──────────────────────────────────────────────────────────────

  window.addEventListener('pagehide', flushRecords);
  toggle.addEventListener('click', () => {
    enabled = true;
    refresh();
  });
  view = FiggieTerminalUI.mount(shadow, {
    send(message) {
      queueMicrotask(() => handleViewMessage(message));
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    clockAt = Date.now();
    refresh();
  });
  window.addEventListener('online', () => {
    clockAt = Date.now();
    refresh();
  });
  window.addEventListener('offline', refresh);
  window.addEventListener('focus', refresh);

  // Mutations drive most refreshes. This poll covers quiet stretches, pending
  // orders awaiting a timeout, and a stalled game clock.
  setInterval(() => {
    const idleFor = Date.now() - lastRefreshAt;
    const due =
      idleFor >= WATCHDOG_MAX_IDLE_MS ||
      idleFor < 0 ||
      orders.size ||
      lastSnapshot?.status === 'paused' ||
      clockStalled();
    if (!refreshPending && due) refresh();
  }, WATCHDOG_INTERVAL_MS);
  refresh();
})();
