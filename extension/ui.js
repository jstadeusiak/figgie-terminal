/*
 * Trading terminal view.
 *
 * Mounts the terminal inside the extension's shadow root and keeps it in step with the
 * game: four market panels with take, quote and preset controls, the model and P&L
 * panels, player flow, the trade tape and keyboard shortcuts. It also decides when to
 * ask the background worker for a new model.
 *
 * The view never touches Figgie itself. Snapshots and order results arrive through
 * `receive`; orders leave through `bridge.send`.
 *
 * Loaded after pnl.js and recording-export.js, which it requires, and after flow-chart.js
 * and training-ui.js, which it uses when present.
 */
(() => {
  'use strict';

  const SUITS = [
    { id: 's', name: 'Spades', symbol: '♠' },
    { id: 'c', name: 'Clubs', symbol: '♣' },
    { id: 'd', name: 'Diamonds', symbol: '♦' },
    { id: 'h', name: 'Hearts', symbol: '♥' },
  ];

  // Columns follow the user's action: buy now at the ask or post a bid;
  // sell now at the bid or post an ask. Book side and posting side are distinct.
  // Figgie calls a posted ask an offer, so order kinds are 'bid' and 'offer' while the
  // quote sides they create are 'bid' and 'ask'.
  const BUY_COLUMN = {
    action: 'buy',
    actionName: 'Buy',
    takeLabel: 'Buy now',
    bookSide: 'ask',
    bookName: 'Ask',
    bookOwner: 'seller',
    quoteSide: 'bid',
    orderKind: 'bid',
    presets: [1, 2, 4, 8],
    quickLabel: 'Bid +1',
    quickStep: '+1',
    quickVerb: 'Raise',
  };
  const SELL_COLUMN = {
    action: 'sell',
    actionName: 'Sell',
    takeLabel: 'Sell now',
    bookSide: 'bid',
    bookName: 'Bid',
    bookOwner: 'buyer',
    quoteSide: 'ask',
    orderKind: 'offer',
    presets: [16, 12, 10, 8],
    quickLabel: 'Ask −1',
    quickStep: '−1',
    quickVerb: 'Lower',
  };
  const COLUMNS = [BUY_COLUMN, SELL_COLUMN];
  const ORDER_KINDS = ['bid', 'offer'];

  // Trading pauses when the source has been silent for this long.
  const LIVE_SOURCE_TIMEOUT_MS = 1800;
  const SOURCE_AGE_REFRESH_INTERVAL_MS = 500;
  const MODEL_REQUEST_MIN_INTERVAL_MS = 120;
  const DIAGNOSTICS_REFRESH_DELAY_MS = 250;
  const EXPORT_URL_LIFETIME_MS = 10000;
  // How far ahead the model forecasts a fill for a resting quote.
  const RESTING_HORIZON_SECONDS = 10;
  // Every goal-suit card pays ten chips at settlement.
  const CHIPS_PER_GOAL_CARD = 10;
  const RECENT_TRADE_LIMIT = 24;
  const MIN_CHART_WIDTH_PX = 100;
  const MIN_CHART_HEIGHT_PX = 40;
  // Values this close to zero are shown as neutral, not as a gain or a loss.
  const SIGN_TOLERANCE = 1e-8;

  const NO_VALUE = '—';
  const LIVE_SOURCE_LABEL = '● Live source';
  const MODEL_UPDATING_LABEL = 'Updating…';
  const WAIT_FOR_LIVE_NOTICE = 'Wait for a live Figgie snapshot.';
  const NEW_ROUND_NOTICE =
    'Buy column: buy now or post a bid. Sell column: sell now or post an ask.' +
    ' Gains are per filled card; posted fills are uncertain.';

  const TRADE_HOTKEY = /^[1-8]$/;
  const TEXT_ENTRY =
    'input:not([type=checkbox]),textarea,select,[contenteditable]:not([contenteditable=false])';
  const DRAFT_INPUT = {
    bid: 'form[data-quote="bid"] input',
    ask: 'form[data-quote="ask"] input',
  };
  const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // Settlement facts the journal can supply when the snapshot alone cannot settle the round.
  const JOURNAL_PNL_FIELDS = [
    'actualPnl',
    'actualPayout',
    'openingBank',
    'endingBank',
    'source',
    'settlementPending',
  ];

  // ── Formatting ─────────────────────────────────────────────────────────

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
  const chips = (value) => (Number.isFinite(value) ? value.toFixed(2) : NO_VALUE);
  const signedChips = (value) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}`;
  const signedChipsOrDash = (value) => (Number.isFinite(value) ? signedChips(value) : NO_VALUE);
  const signedCount = (count) => `${count > 0 ? '+' : ''}${count}`;
  const percent = (probability, digits = 1) => `${(probability * 100).toFixed(digits)}%`;

  function signClass(value) {
    if (value > SIGN_TOLERANCE) return 'ff-positive';
    if (value < -SIGN_TOLERANCE) return 'ff-negative';
    return 'ff-zero';
  }
  const signClassOrZero = (value) => (Number.isFinite(value) ? signClass(value) : 'ff-zero');

  const suitColorClass = (suitId) =>
    suitId === 'd' || suitId === 'h' ? 'ff-suit-red' : 'ff-suit-black';
  // Accepts a suit or a market: both carry an id and a symbol.
  const suitIcon = ({ id, symbol }) =>
    `<span class="ff-suit-icon ${suitColorClass(id)}">${symbol}</span>`;
  const suitById = (suitId) => SUITS.find((suit) => suit.id === suitId);

  const displayName = (name, self) => (name === self ? 'You' : name);
  const shortName = (name, self) => (name === self ? 'You' : name.replace(/^Bot-/, ''));
  const playerByName = (snapshot, name) => snapshot.players.find((player) => player.name === name);

  const sameValues = (previous, next) =>
    previous?.length === next.length && previous.every((value, i) => Object.is(value, next[i]));

  // ── Market rules ───────────────────────────────────────────────────────

  const columnForOrder = (orderKind) => (orderKind === 'bid' ? BUY_COLUMN : SELL_COLUMN);
  const canTake = (market, action) => (action === 'buy' ? market.canBuy : market.canSell);
  const canPost = (market, orderKind) => (orderKind === 'bid' ? market.canBid : market.canOffer);
  const canImprove = (market, orderKind) =>
    orderKind === 'bid' ? market.canRaiseBid : market.canLowerAsk;
  const canCancel = (market, orderKind) =>
    orderKind === 'bid' ? market.canCancelBid : market.canCancelOffer;

  // Orders that touch the same resting quote share a lane; a lane carries one pending order.
  function orderLane(kind) {
    if (kind === 'raise-bid' || kind === 'cancel-bid') return 'bid';
    if (kind === 'lower-ask' || kind === 'cancel-offer') return 'offer';
    return kind;
  }

  function quoteSideOfOrder(kind) {
    if (kind === 'bid' || kind === 'raise-bid') return 'bid';
    if (kind === 'offer' || kind === 'lower-ask') return 'ask';
    return null;
  }

  // A bid at or above the best ask, or an ask at or below the best bid, would trade at once.
  function crossesBook(market, quoteSide, price) {
    if (quoteSide === 'bid') return Number.isFinite(market.ask) && price >= market.ask;
    return Number.isFinite(market.bid) && price <= market.bid;
  }

  // A draft is usable only as a positive whole number of chips.
  function draftPrice(text) {
    const price = Number(text);
    return text !== '' && Number.isSafeInteger(price) && price > 0 ? price : null;
  }

  // The price a resting estimate describes: the typed draft, else a one-chip improvement.
  function restingPrice(market, quoteSide, draft) {
    if (draft !== '') return draftPrice(draft);
    if (quoteSide === 'bid') return Number.isFinite(market.bid) ? market.bid + 1 : null;
    return Number.isFinite(market.ask) && market.ask > 1 ? market.ask - 1 : null;
  }

  const takeGain = (action, value, price) => (action === 'buy' ? value - price : price - value);

  // Buy and sell values depend on who is on the other side of the book.
  function counterpartyEstimate(suitEstimate, market) {
    return (
      suitEstimate && {
        ...suitEstimate,
        buy: suitEstimate.counterparties?.[market.seller]?.buy ?? null,
        sell: suitEstimate.counterparties?.[market.buyer]?.sell ?? null,
      }
    );
  }

  // ── Trade history ──────────────────────────────────────────────────────

  const sameTrade = (a, b) => a.b === b.b && a.s === b.s && a.suit === b.suit && a.p === b.p;

  function sameHistory(before, after) {
    return (
      before?.roundKey === after.roundKey &&
      before.trades.length === after.trades.length &&
      before.trades.every((trade, i) => sameTrade(trade, after.trades[i]))
    );
  }

  // ── Order decisions ────────────────────────────────────────────────────

  const NO_DECISION_ESTIMATE = {
    gain: null,
    fillChance: null,
    conditionalGain: null,
    baseEdge: null,
    bonusEdge: null,
  };

  // A take fills at once, so its expected gain is the gain if filled.
  function takeDecisionEstimate(order, market, suitEstimate) {
    const isBuy = order.kind === 'buy';
    const party = suitEstimate.counterparties?.[isBuy ? market.seller : market.buyer];
    const value = isBuy ? party?.buy : party?.sell;
    const baseValue = isBuy ? party?.buyBase : party?.sellBase;
    if (!Number.isFinite(value)) return NO_DECISION_ESTIMATE;
    const gain = takeGain(order.kind, value, order.price);
    const baseEdge = Number.isFinite(baseValue)
      ? takeGain(order.kind, baseValue, order.price)
      : null;
    return {
      gain,
      fillChance: 1,
      conditionalGain: gain,
      baseEdge,
      bonusEdge: baseEdge === null ? null : gain - baseEdge,
    };
  }

  // A resting estimate applies only to the exact price the model previewed, and never
  // to a quote that would cross the book.
  function restingDecisionEstimate(order, market, quoteSide, preview) {
    const crossing = quoteSide && crossesBook(market, quoteSide, order.price);
    if (preview?.price !== order.price || crossing) return NO_DECISION_ESTIMATE;
    return {
      gain: preview.ev,
      fillChance: preview.pFill,
      conditionalGain: preview.conditionalEdge,
      baseEdge: preview.conditionalBaseEdge,
      bonusEdge: preview.conditionalBonusEdge,
    };
  }

  function decisionHorizonSeconds(isTake, quoteSide) {
    if (isTake) return 0;
    return quoteSide ? RESTING_HORIZON_SECONDS : null;
  }

  // ── Market panel markup (built once at mount) ──────────────────────────

  const BASE_FAIR_HINT =
    '10 × goal probability, including opponent evidence; excludes the leader bonus.';
  const SIGNALS_HINT =
    'Opponent evidence adjustment in chips per card, relative to the cards-only fair value.' +
    ' Already included in Base fair.';
  const TAKE_FAIR_HINT = 'Base fair: 10 × current goal probability; excludes the leader bonus.';

  // Shortcut keys 1–8 run across the panels: buy then sell for each suit.
  function marketPanelMarkup(suit, suitIndex) {
    const takeSides = COLUMNS.map((column, columnIndex) =>
      takeSideMarkup(suit, column, suitIndex * COLUMNS.length + columnIndex + 1),
    ).join('');
    const quoteStacks = COLUMNS.map((column) => quoteStackMarkup(suit, column)).join('');
    return [
      `<section class="ff-market" data-suit="${suit.id}" aria-label="${suit.name} live market">`,
      '<div class="ff-market-heading">',
      '<div class="ff-market-name">' +
        `<span class="ff-symbol ff-suit-icon ${suitColorClass(suit.id)}">${suit.symbol}</span>` +
        `${suit.name}</div>`,
      '<div class="ff-market-numbers"><span>Held <b data-value="held">—</b></span>' +
        '<span>Last <b data-value="last">—</b></span></div>',
      '</div>',
      '<div class="ff-market-model">',
      '<span>Goal <b data-value="goal">—</b></span>',
      `<span class="ff-fair-value" title="${BASE_FAIR_HINT}">` +
        'Base fair <b data-value="fair">—</b></span>',
      `<span title="${SIGNALS_HINT}">Signals <b data-value="flow-value">—</b></span>`,
      '</div>',
      '<svg class="ff-chart" role="img"' +
        ` aria-label="${suit.name} player accumulation by trade sequence"></svg>`,
      '<div class="ff-chart-meta"><span data-value="fills">No fills yet</span>' +
        '<span class="ff-flow-summary" data-value="flow-summary"></span></div>',
      `<div class="ff-execution">${takeSides}</div>`,
      `<div class="ff-quoting">${quoteStacks}</div>`,
      '</section>',
    ].join('');
  }

  function takeSideMarkup(suit, column, shortcut) {
    const { action, bookSide } = column;
    return [
      `<div class="ff-side" data-quote="${bookSide}" data-direction="${action}">`,
      '<div class="ff-counterparty">',
      `<span data-value="${bookSide}">${column.bookName} —</span>`,
      `<span class="ff-book-owner" data-book-owner="${bookSide}" data-state="empty">` +
        '<i aria-hidden="true"></i>' +
        `<span data-value="${column.bookOwner}">No ${bookSide}</span></span>`,
      '</div>',
      `<button type="button" class="ff-take ff-${action}" data-action="${action}"` +
        ` data-shortcut="${shortcut}" aria-keyshortcuts="${shortcut}" data-id="${suit.id}"` +
        ` disabled aria-label="${column.actionName} one ${suit.name}">`,
      `<span data-value="${action}-label">${column.takeLabel} <kbd>${shortcut}</kbd></span>`,
      `<span class="ff-take-fair" title="${TAKE_FAIR_HINT}">` +
        `Base fair <b data-value="${action}-fair">—</b></span>`,
      `<span class="ff-price" data-value="${action}-price">—</span>`,
      '</button>',
      '<div class="ff-after">' +
        `<b data-value="${action}-edge" class="ff-model-edge">—</b>` +
        `<span data-value="after-${action}">—</span></div>`,
      '</div>',
    ].join('');
  }

  function quoteStackMarkup(suit, column) {
    const { action, quoteSide } = column;
    const presets = column.presets.map((price) => presetMarkup(suit, column, price)).join('');
    return [
      `<div class="ff-quote-stack" data-quote="${quoteSide}" data-direction="${action}">`,
      `<div class="ff-post-heading">Post ${action} order <span>${quoteSide}</span></div>`,
      '<div class="ff-quote-presets" role="group"' +
        ` aria-label="${suit.name} ${quoteSide} presets">${presets}</div>`,
      quoteFormMarkup(suit, column),
      `<div class="ff-resting-estimate" data-resting="${quoteSide}">` +
        `<span data-value="rest-${quoteSide}-price">${column.quickLabel} @ —</span>` +
        `<span data-value="rest-${quoteSide}-fill">Fill — / ${RESTING_HORIZON_SECONDS}s</span>` +
        `<b data-value="rest-${quoteSide}-edge">Gain if filled —</b></div>`,
      '</div>',
    ].join('');
  }

  function presetMarkup(suit, { orderKind, quoteSide }, price) {
    return (
      `<button type="button" class="ff-preset" data-preset="${orderKind}" data-id="${suit.id}"` +
      ` data-price="${price}" aria-label="Post ${suit.name} ${quoteSide} at ${price} chips"` +
      ` title="Post ${quoteSide} at ${price} chips" disabled>${price}</button>`
    );
  }

  function quoteFormMarkup(suit, column) {
    const { action, quoteSide, orderKind } = column;
    const hint = `Post your ${quoteSide} to ${action} one card; another player must trade with you`;
    return [
      `<form class="ff-quote-form" data-quote="${quoteSide}" data-id="${suit.id}"` +
        ` data-kind="${orderKind}" aria-label="Post ${suit.name} ${quoteSide}"` +
        ` title="${hint}">`,
      `<input type="number" min="1" step="1" required placeholder="Your ${quoteSide}"` +
        ` aria-label="${suit.name} ${quoteSide} price">`,
      `<button type="submit" class="ff-post" data-kind="${orderKind}">Post ↵</button>`,
      `<button type="button" class="ff-quick" data-quick="${orderKind}" data-id="${suit.id}"` +
        ` aria-label="${column.quickVerb} ${suit.name} ${quoteSide} by one" disabled>` +
        `${column.quickStep}</button>`,
      `<button type="button" class="ff-cancel" data-cancel="${orderKind}" data-id="${suit.id}"` +
        ` aria-label="Cancel ${suit.name} ${quoteSide}" title="Cancel your ${quoteSide}"` +
        ' disabled>×</button>',
      '</form>',
    ].join('');
  }

  // ── Account, flow and tape markup ──────────────────────────────────────

  function playerLegendMarkup(snapshot) {
    const keys = snapshot.players.map(
      (player) =>
        `<span class="ff-buyer-key"><i style="background:${escapeHtml(player.color)}"></i>` +
        `${escapeHtml(displayName(player.name, snapshot.self))}</span>`,
    );
    return '<span>Player colors · filled = buy · hollow = sell</span>' + keys.join('');
  }

  function inventoryMarkup(snapshot) {
    const ownNet = snapshot.net[0];
    return snapshot.markets
      .map((market, suitIndex) => {
        const net = ownNet[suitIndex];
        return (
          '<div class="ff-inventory-item">' +
          `<span>${suitIcon(market)} <span class="ff-suit-name">${market.name}</span></span>` +
          `<div><strong>${market.held}</strong>` +
          `<small class="${signClass(net)}">Δ ${signedCount(net)}</small></div>` +
          '</div>'
        );
      })
      .join('');
  }

  function flowTableMarkup(snapshot) {
    return snapshot.players
      .map((player, playerIndex) => {
        const name = escapeHtml(player.name);
        const netCells = snapshot.net[playerIndex]
          .map((net, suitIndex) => {
            const hint =
              `${name}: net ${signedCount(net)} ${SUITS[suitIndex].name} since the deal.` +
              ' Purchases minus sales; not total holdings.';
            return `<td class="${signClass(net)}" title="${hint}">${signedCount(net)}</td>`;
          })
          .join('');
        return (
          '<tr><td>' +
          `<span class="ff-flow-player" title="${name} · matches chart and quote colors">` +
          '<i aria-hidden="true"' +
          ` style="background:${escapeHtml(player.color || 'var(--ff-dim)')}"></i>` +
          `<span>${escapeHtml(displayName(player.name, snapshot.self))}</span></span>` +
          `</td>${netCells}</tr>`
        );
      })
      .join('');
  }

  function tradeTapeMarkup(snapshot) {
    const rows = snapshot.trades
      .slice(-RECENT_TRADE_LIMIT)
      .reverse()
      .map((trade, age) => tradeRowMarkup(snapshot, trade, snapshot.trades.length - age))
      .join('');
    return rows || '<div class="ff-empty">Waiting for the first trade</div>';
  }

  function tradeRowMarkup(snapshot, trade, tradeNumber) {
    const suit = suitById(trade.suit);
    const buyer = escapeHtml(trade.b);
    const seller = escapeHtml(trade.s);
    return [
      '<div class="ff-trade-row"' +
        ` title="${buyer} bought one ${suit.name} from ${seller} at ${trade.p} chips">`,
      `<span class="ff-trade-index">#${tradeNumber}</span>`,
      `<span class="ff-trade-suit" title="${suit.name}">${suitIcon(suit)}</span>`,
      tradePartyMarkup(snapshot, 'Buyer', trade.b),
      '<span class="ff-trade-arrow" aria-label="bought from">←</span>',
      tradePartyMarkup(snapshot, 'Seller', trade.s),
      `<span class="ff-trade-price">@ <b>${trade.p}</b></span>`,
      '</div>',
    ].join('');
  }

  function tradePartyMarkup(snapshot, role, name) {
    const color = playerByName(snapshot, name)?.color;
    return (
      `<span class="ff-trade-party" title="${role}: ${escapeHtml(name)}">` +
      `<i style="background:${escapeHtml(color)}"></i>` +
      `<span class="ff-party-name">${escapeHtml(shortName(name, snapshot.self))}</span></span>`
    );
  }

  function flowSummaryText(summary, self) {
    const leaders = summary.largestAccumulators;
    const lead = leaders[0];
    const leadText = lead ? `${shortName(lead.name, self)} +${lead.net}` : 'None';
    const tied = leaders.length > 1 ? ' tied' : '';
    return `Opp ${signedCount(summary.opponentNet)} · Top net ${leadText}${tied}`;
  }

  function flowSummaryTitle(summary) {
    const leaders = summary.largestAccumulators;
    const names = leaders.map((leader) => `${leader.name} +${leader.net}`).join(', ');
    return [
      `All-player net: ${summary.totalNet}.`,
      'Every purchase has a matching sale.',
      `Opponents combined: ${signedCount(summary.opponentNet)} cards,` +
        ' exactly the opposite of your net change; not an independent sentiment signal.',
      `Largest net accumulator${leaders.length > 1 ? 's' : ''}: ${names || 'none'}.`,
      'Net changes are not total holdings.',
    ].join(' ');
  }

  // ── Book and estimate text ─────────────────────────────────────────────

  // The best quote on one side of the book, as the take column needs to describe it.
  function bookQuote(snapshot, market, column) {
    const ownerName = market[column.bookOwner];
    const price = market[column.bookSide];
    return {
      side: column.bookSide,
      price,
      hasQuote: Number.isFinite(price),
      owner: playerByName(snapshot, ownerName),
      isOwn: ownerName === snapshot.self,
    };
  }

  function bookOwnerLabel(quote) {
    if (!quote.hasQuote) return `No ${quote.side}`;
    if (quote.isOwn) return 'YOU · TOP';
    return quote.owner?.name || 'Unknown owner';
  }

  function bookBadgeState(quote, live) {
    if (!quote.hasQuote) return 'empty';
    if (!live) return 'stale';
    return quote.isOwn ? 'own' : 'live';
  }

  function bookBadgeTitle(quote, live) {
    if (!quote.hasQuote) return `No ${quote.side} currently quoted`;
    const freshness = live ? 'Best' : 'Last observed best';
    const owner = quote.owner?.name || 'unknown owner';
    return `${freshness} ${quote.side}: ${owner} at ${quote.price} chips`;
  }

  function takeButtonTitle(quote, action) {
    if (!quote.hasQuote) return `No ${quote.side} available`;
    if (quote.isOwn) return `Your best ${quote.side}: ${quote.price} chips`;
    const direction = action === 'buy' ? 'Buy from' : 'Sell to';
    return `${direction} ${quote.owner?.name || 'unknown owner'} at ${quote.price} chips`;
  }

  function quickButtonTitle(market, orderKind) {
    const isBid = orderKind === 'bid';
    const quoted = isBid ? market.bid : market.ask;
    const improved = isBid ? market.bid + 1 : market.ask - 1;
    return `Post ${isBid ? 'bid' : 'ask'} at ${quoted === null ? NO_VALUE : improved}`;
  }

  function presetTitle(busy, blockReason, orderKind, price) {
    if (busy) return 'That order is still awaiting Figgie.';
    return blockReason || `Post ${columnForOrder(orderKind).quoteSide} at ${price} chips`;
  }

  const NO_RESTING_ESTIMATE = {
    state: 'unavailable',
    fill: `Fill — / ${RESTING_HORIZON_SECONDS}s`,
    gain: 'Gain if filled —',
    gainClass: 'ff-zero',
    bonusDependent: false,
    title:
      'No current estimate. Enter a competitive quote or wait for a current model;' +
      ' behind-book fill probabilities are not estimated.',
  };

  // What the row under a quote form shows: a crossing warning, the model's fill estimate
  // for exactly this price, or nothing.
  function restingEstimateView(column, price, crossing, estimate, oppositeIsOwn) {
    if (crossing) return crossingQuoteView(column, price, oppositeIsOwn);
    if (estimate) return estimatedQuoteView(column, price, estimate);
    return NO_RESTING_ESTIMATE;
  }

  function crossingQuoteView({ quoteSide, bookSide, actionName }, price, oppositeIsOwn) {
    const advice = oppositeIsOwn
      ? 'Move or cancel your opposite quote first.'
      : `Use ${actionName} now to see the immediate-trade estimate.`;
    return {
      state: 'crossing',
      fill: `Crosses ${bookSide}`,
      gain: oppositeIsOwn ? 'Move your opposite quote first' : `Use ${actionName} now`,
      gainClass: 'ff-zero',
      bonusDependent: false,
      title:
        `Your ${quoteSide} at ${price} crosses the current ${bookSide}.` +
        ` A resting fill forecast does not apply. ${advice}`,
    };
  }

  function estimatedQuoteView(column, price, estimate) {
    const bonusDependent =
      estimate.conditionalEdge > 0 &&
      Number.isFinite(estimate.conditionalBaseEdge) &&
      estimate.conditionalBaseEdge < 0;
    return {
      state: 'estimated',
      fill: `Fill ~${percent(estimate.pFill, 0)} / ${RESTING_HORIZON_SECONDS}s`,
      gain: `Gain if filled ${signedChipsOrDash(estimate.conditionalEdge)}`,
      gainClass: signClassOrZero(estimate.conditionalEdge),
      bonusDependent,
      title: restingEstimateTitle(column, price, estimate, bonusDependent),
    };
  }

  function restingEstimateTitle(column, price, estimate, bonusDependent) {
    const flags =
      (estimate.provisional ? 'PROVISIONAL. ' : '') + (bonusDependent ? 'BONUS DEPENDENT. ' : '');
    const counterparties = estimate.counterparties
      .map((party) => `${party.name} ${percent(party.probability, 0)}`)
      .join(', ');
    const sentences = [
      `Posting ${column.action}s one card at ${price} only if another player accepts.`,
      `Gain if filled: base-card edge ${chips(estimate.conditionalBaseEdge)}` +
        ` + bonus change ${chips(estimate.conditionalBonusEdge)}` +
        ` = ${chips(estimate.conditionalEdge)} chips.`,
      'These components condition on who fills the order.',
      `Fill-weighted order EV: ${chips(estimate.ev)} chips, including no fill;` +
        ` ${percent(estimate.pFill)} fill chance.`,
      `${estimate.scope}.`,
      'Not realized P&L.',
      `${estimate.observedFills.toFixed(0)} observed fills /` +
        ` ${estimate.exposureSeconds.toFixed(0)} quote-seconds.`,
      `Counterparties: ${counterparties}.`,
    ];
    return flags + sentences.join(' ');
  }

  function signalsTitle(estimate, signalChips) {
    if (!estimate) return 'Opponent adjustment in chips per card, already included in Base fair.';
    const { probability, structuralProbability } = estimate;
    const shiftPoints = signedChips(100 * (probability - structuralProbability));
    return [
      `Opponent behavior shifts goal probability from ${percent(structuralProbability)}` +
        ` (cards only) to ${percent(probability)}, or ${shiftPoints} percentage points.`,
      `Signals ${signedChips(signalChips)} is that change in chips per card.`,
      'Already included in Base fair; it is not card flow or an extra premium.',
    ].join(' ');
  }

  function fairValueTitle(estimate, signalChips) {
    if (!estimate) return 'Waiting for a current model.';
    const cardsOnlyFair = chips(CHIPS_PER_GOAL_CARD * estimate.structuralProbability);
    return [
      `Cards-only fair ${cardsOnlyFair} + opponent evidence ${signedChips(signalChips)}` +
        ` = base fair ${chips(estimate.base)} chips per card.`,
      `This is 10 × ${percent(estimate.probability)} goal probability;` +
        ' excludes the leader bonus.',
      'Signals are already included, not an extra price premium.',
    ].join(' ');
  }

  function takeEdgeTitle(edge, baseEdge, bonusEdge, bonusDependent) {
    if (edge === null) return 'Waiting for an executable quote and current model.';
    const sentences = [
      `Base-card edge ${chips(baseEdge)} + bonus change ${chips(bonusEdge)}` +
        ` = ${chips(edge)} chips per filled card.`,
      'Buying conditions on the named seller having a card,' +
        ' so its base value may differ from the general fair value.',
      'Bonus changes are uncertain.',
      'Assumes immediate settlement; excludes future resale.',
      'This is not realized P&L.',
    ];
    return (bonusDependent ? 'BONUS DEPENDENT. ' : '') + sentences.join(' ');
  }

  // ── Model panel markup and text ────────────────────────────────────────

  function modelConfidenceText(model) {
    if (!model?.behavior) return 'Waiting for opponent model';
    const flags =
      (model.behavior.provisional ? 'PROVISIONAL · ' : '') +
      (model.recordingCoverageIncomplete ? 'Recording gap · ' : '');
    return (
      `${flags}${model.metrics?.rounds || 0} scored rounds` +
      ` · ${model.behavior.observations} behavior observations`
    );
  }

  function modelConfidenceTitle(model) {
    let title = model?.metrics?.rounds
      ? `Round-averaged Brier: opponent ${model.metrics.opponentBrier.toFixed(3)},` +
        ` cards-only ${model.metrics.baselineBrier.toFixed(3)}. Lower is better.` +
        ' Saved live predictions before the result; historical model versions are included.'
      : 'Policy priors are assumptions, not a validated accuracy claim.' +
        ' Cards-only baseline remains available.';
    const validation = model?.behavior?.validation;
    if (validation) {
      const scope = model.behavior.goalCalibration?.active
        ? validation.goalCalibration?.scope || validation.scope
        : validation.scope;
      title += ' ' + scope;
    }
    if (model?.bonusMetrics?.rounds) {
      title +=
        ` Bonus payout MAE: ${model.bonusMetrics.bonusMae.toFixed(2)} chips across` +
        ` ${model.bonusMetrics.rounds} official rounds in this opponent group,` +
        ' measured at each saved inventory checkpoint.';
    }
    return title;
  }

  const PENDING_GOAL_ODDS = {
    percentText: NO_VALUE,
    fillPercent: 0,
    baselineText: 'Computing',
    shiftClass: '',
    shiftText: '',
    samplingNote: '',
  };

  // Goal probability against the cards-only baseline, with the opponent-evidence shift.
  function goalOdds(suitEstimate) {
    const baseline = suitEstimate.structuralProbability ?? suitEstimate.handProbability;
    const shiftPoints = (suitEstimate.probability - baseline) * 100;
    const samplingNote = suitEstimate.probabilityError
      ? '<div class="ff-model-footnote">' +
        `MC 95% ±${(suitEstimate.probabilityError * 100).toFixed(1)} pp</div>`
      : '';
    return {
      percentText: percent(suitEstimate.probability),
      fillPercent: suitEstimate.probability * 100,
      baselineText: `Cards ${percent(baseline)}`,
      shiftClass: signClass(shiftPoints),
      shiftText: `${shiftPoints < 0 ? '−' : '+'}${Math.abs(shiftPoints).toFixed(1)} pp`,
      samplingNote,
    };
  }

  function goalOddsMarkup(suit, suitEstimate) {
    const odds = suitEstimate ? goalOdds(suitEstimate) : PENDING_GOAL_ODDS;
    return [
      '<div class="ff-odds-item">',
      '<div class="ff-odds-heading">' +
        `<span>${suitIcon(suit)} ${suit.name}</span><b>${odds.percentText}</b></div>`,
      '<div class="ff-odds-track">' +
        `<div class="ff-odds-fill" style="width:${odds.fillPercent}%"></div></div>`,
      `<div class="ff-odds-delta"><span>${odds.baselineText}</span>` +
        `<span class="${odds.shiftClass}">${odds.shiftText}</span></div>`,
      odds.samplingNote,
      '</div>',
    ].join('');
  }

  function modelPriceRowMarkup(suit, estimate) {
    return (
      `<tr><td>${suitIcon(suit)}</td><td>${chips(estimate?.base)}</td>` +
      `<td>${chips(estimate?.buy)}</td><td>${chips(estimate?.sell)}</td></tr>`
    );
  }

  // ── P&L markup and text ────────────────────────────────────────────────

  function pnlExplanation(pnl, isFinal, roundEnded) {
    if (isFinal) return `Net trading cash + settlement − ante. ${pnl.source}.`;
    if (roundEnded) return 'Net profit stays estimated until the settled bank can be reconciled.';
    return (
      'Net trading cash + estimated settlement − ante.' +
      ' Includes the leader bonus; estimates can change as beliefs change.'
    );
  }

  const PNL_SCENARIO_TABLE_HEAD =
    '<thead><tr><th>Goal</th>' +
    '<th title="Net P&amp;L if this suit wins but you receive no leader bonus.' +
    ' Conservative base-card payout only; no future trades.">No bonus</th>' +
    '<th>If wins</th>' +
    '<th title="Goal probability × conditional net P&amp;L.' +
    ' The four shares sum to estimated round P&amp;L, apart from rounding.">EV share</th>' +
    '</tr></thead>';

  function pnlScenarioTableMarkup(pnl, held) {
    const rows = pnl.goalScenarios
      .map((scenario, suitIndex) =>
        pnlScenarioRowMarkup(pnl, scenario, SUITS[suitIndex], held[suitIndex]),
      )
      .join('');
    return (
      '<table class="ff-scenario-table">' +
      `${PNL_SCENARIO_TABLE_HEAD}<tbody>${rows}</tbody>` +
      '</table>'
    );
  }

  function pnlScenarioRowMarkup(pnl, scenario, suit, heldCount) {
    return [
      `<tr class="ff-pnl-scenario" data-goal="${suit.id}">`,
      `<td title="${suit.name}">${suitIcon(suit)}</td>`,
      pnlScenarioCell('base', scenario.noBonusPnl, noBonusTitle(pnl, suit, heldCount)),
      pnlScenarioCell('raw', scenario.pnl, ifWinsTitle(pnl, scenario, suit)),
      pnlScenarioCell('weighted', scenario.weightedPnl, evShareTitle(scenario)),
      '</tr>',
    ].join('');
  }

  function pnlScenarioCell(kind, value, title) {
    return (
      `<td title="${escapeHtml(title)}">` +
      `<b class="ff-scenario-${kind} ${signClassOrZero(value)}">${signedChipsOrDash(value)}</b>` +
      '</td>'
    );
  }

  function noBonusTitle(pnl, suit, heldCount) {
    return (
      `If ${suit.name} wins: cash flow ${chips(pnl.netCash)} − ante ${chips(pnl.ante)}` +
      ` + 10 × ${heldCount} cards. Excludes all bonus; this conservative scenario` +
      ' may be below the feasible minimum if a bonus is already secured.'
    );
  }

  function ifWinsTitle(pnl, scenario, suit) {
    const bonusOdds = Number.isFinite(scenario.soloProbability)
      ? ` Conditional bonus odds: sole leader ${percent(scenario.soloProbability)},` +
        ` tied leader ${percent(scenario.tieProbability)},` +
        ` no bonus ${percent(scenario.noBonusProbability)}.`
      : '';
    return ifWinsSettlementText(pnl, scenario, suit) + bonusOdds;
  }

  function ifWinsSettlementText(pnl, scenario, suit) {
    if (!Number.isFinite(scenario.pnl)) {
      return (
        'Waiting for a current model for this inventory.' +
        ' A dash means unavailable, not zero probability.'
      );
    }
    return [
      `If ${suit.name} is the goal and the round settles now:` +
        ` net trading cash ${chips(pnl.netCash)}` +
        ` + conditional settlement ${chips(scenario.settlement)} − ante ${chips(pnl.ante)}.`,
      `Includes estimated leader bonus ${chips(scenario.bonus)};` +
        ' hidden opponent inventories remain uncertain.',
      'No future trades.',
      'This is a conditional estimate, not a guaranteed payout.',
    ].join(' ');
  }

  function evShareTitle(scenario) {
    if (!Number.isFinite(scenario.weightedPnl)) return 'Waiting for a current model.';
    if (scenario.probability === 0) {
      return 'Zero goal probability contributes zero to expected net round P&L.';
    }
    return (
      `${percent(scenario.probability)} × ${signedChips(scenario.pnl)}` +
      ` = ${signedChips(scenario.weightedPnl)} chips of expected net round P&L.` +
      ' This is a weighted contribution, not the payout if the suit wins.'
    );
  }

  // ── The mounted view ───────────────────────────────────────────────────

  function mount(shadow, bridge) {
    const root = shadow.getElementById('figgie-fast');
    const send = (message) => bridge.send(message);

    // ── Element access ───────────────────────────────────────────────────

    const elementsById = new Map();
    const $ = (id) => {
      if (!elementsById.has(id)) elementsById.set(id, shadow.getElementById(id));
      return elementsById.get(id);
    };

    // Market controls stay mounted so quote updates never replace focused inputs.
    // That also lets every lookup inside a panel or form be made once and remembered.
    const nodeCache = new WeakMap();
    const getNode = (parent, selector) => {
      let found = nodeCache.get(parent);
      if (!found) {
        found = new Map();
        nodeCache.set(parent, found);
      }
      if (!found.has(selector)) found.set(selector, parent.querySelector(selector));
      return found.get(selector);
    };
    const valueNode = (panel, key) => getNode(panel, `[data-value="${key}"]`);
    const takeButton = (panel, action) => getNode(panel, `[data-action="${action}"]`);
    const draftInput = (panel, quoteSide) => getNode(panel, DRAFT_INPUT[quoteSide]);

    const setText = (node, value) => {
      const text = String(value);
      if (node.textContent !== text) node.textContent = text;
    };
    const setValue = (panel, key, value) => setText(valueNode(panel, key), value);
    const setBusy = (button, busy) => button.setAttribute('aria-busy', String(busy));
    const markPending = (button) => {
      button.disabled = true;
      setBusy(button, true);
    };

    // ── One-time layout ──────────────────────────────────────────────────

    dockFlowAndDiagnostics();
    // Mounted before the hotkey listener is registered, so that while the learning lab is
    // open its own key handler sees every key first.
    const trainingUI = globalThis.FiggieTrainingUI?.mount(shadow, { send });
    $('ff-markets').innerHTML = SUITS.map(marketPanelMarkup).join('');

    const panels = new Map(
      [...root.querySelectorAll('.ff-market')].map((panel) => [panel.dataset.suit, panel]),
    );
    const quoteForms = [...root.querySelectorAll('.ff-quote-form')];
    const draftInputs = quoteForms.map((form) => getNode(form, 'input'));
    const presetButtons = new Map(
      [...panels].map(([suitId, panel]) => [suitId, [...panel.querySelectorAll('[data-preset]')]]),
    );
    const diagnosticsPanel = $('diagnostics').closest('details');

    // The bundled markup lists player flow and diagnostics last; the live layout docks
    // the flow above the notice and folds diagnostics into the model panel.
    function dockFlowAndDiagnostics() {
      const dock = root.querySelector('.ff-lower');
      const tape = dock.querySelector('.ff-actions');
      const flow = dock.querySelector('.ff-flow');
      dock.classList.add('ff-main-dock');
      dock.setAttribute('aria-label', 'Player flow and recent trades');
      flow.setAttribute('aria-label', 'Live player card deltas');
      tape.classList.add('ff-main-tape');
      tape.setAttribute('aria-label', 'Recent live trades');
      root.insertBefore(dock, $('ff-notice'));
      root.querySelector('.ff-model-panel').append(root.querySelector('.diagnostics'));
    }

    // ── State ────────────────────────────────────────────────────────────

    // The game as last reported by the bridge. A zero timestamp means the source is down.
    let snapshot = null;
    let lastSourceUpdateAt = 0;

    // Trade-history versions. Bumping one invalidates everything derived from that history.
    let historyVersion = 0;
    const suitHistoryVersions = { s: 0, c: 0, d: 0, h: 0 };
    let preparedFlow = null;
    let preparedFlowKey = '';

    // What each region last rendered. A region is rebuilt only when its key changes.
    const regionKeys = new Map();
    const marketStates = new Map();
    const summarizedFlowKeys = new Map();
    const chartDataKeys = new Map();
    const chartDrawKeys = new Map();
    let pnlKey = null;
    let chartFlowKey = '';

    // Work deferred to the next animation frame or timer.
    let renderScheduled = false;
    let drawScheduled = false;
    let drawAfterResize = false;
    let diagnosticsTimer = null;

    // The model in use. It is current only while its evidence key matches `evidenceKey`,
    // the key of the newest request; `lastRequestKey` also covers quotes and drafts.
    let model = null;
    let evidenceKey = '';
    let lastRequestKey = '';

    // Model requests: one job is in flight at a time and only the newest one waits.
    let queuedJob = null;
    let modelBusy = false;
    let modelJobTimer = null;
    let lastModelSentAt = 0;
    let modelJobCount = 0;
    let inFlight = { roundKey: '', evidenceKey: '', requestKey: '' };

    // Round facts acknowledged by the journal.
    let lastRecordedRevision = -1;
    let recordedPnl = null;
    let practiceRoundKey = '';

    // Orders awaiting a result from the bridge, by command id.
    const pendingOrders = new Map();
    let lastCommandId = 0;
    // The command captured on pointerdown. The click that follows sends the quote the user
    // saw when pressing, so the bridge can reject it if the book has moved since.
    let pressed = null;

    // ── Current state ────────────────────────────────────────────────────

    function isLive() {
      return (
        snapshot?.status === 'live' && Date.now() - lastSourceUpdateAt < LIVE_SOURCE_TIMEOUT_MS
      );
    }

    function modelIsFresh() {
      return model && model.roundKey === snapshot?.roundKey && model.evidenceKey === evidenceKey;
    }

    const freshModel = () => (modelIsFresh() ? model : null);
    const isPracticeRound = () => practiceRoundKey === snapshot?.roundKey;
    const marketById = (suitId) => snapshot.markets.find((market) => market.id === suitId);
    const playersKey = () =>
      JSON.stringify([
        snapshot.self,
        snapshot.players.map((player) => [player.name, player.color]),
      ]);

    const trainingState = () => ({
      fresh: Boolean(modelIsFresh() && model.requestEvidenceKey === lastRequestKey),
      live: isLive(),
    });

    function pendingLanesFor(suitId) {
      return [...pendingOrders.values()]
        .filter((command) => command.suit === suitId)
        .map((command) => orderLane(command.kind));
    }

    function showNotice(text, isError = false) {
      $('ff-notice').textContent = text;
      $('ff-notice').classList.toggle('ff-negative', isError);
    }

    function clearDrafts() {
      draftInputs.forEach((input) => {
        if (input.value !== '') input.value = '';
      });
    }

    function presetBlockReason(market, orderKind, price) {
      const column = columnForOrder(orderKind);
      const isBid = orderKind === 'bid';
      if (!isLive()) return WAIT_FOR_LIVE_NOTICE;
      if (!canPost(market, orderKind)) return `Figgie disabled this ${column.quoteSide} field.`;
      if (isBid && price > snapshot.cash) return 'Insufficient game chips.';
      if (!isBid && market.held < 1) return 'You have no cards in this suit.';
      if (crossesBook(market, column.quoteSide, price)) {
        return `This price crosses the ${column.bookSide}. Use ${column.actionName} now.`;
      }
      return '';
    }

    // ── Rendering ────────────────────────────────────────────────────────

    function renderHtml(id, key, buildMarkup) {
      if (regionKeys.get(id) === key) return;
      regionKeys.set(id, key);
      $(id).innerHTML = buildMarkup();
    }

    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        render();
      });
    }

    function render() {
      if (!snapshot) return;
      trainingUI?.update(snapshot, model, trainingState());
      syncPlayerRows();
      const playerKey = playersKey();
      const flowKey = historyVersion + '|' + playerKey;
      prepareFlow(flowKey);
      renderAccount(playerKey);
      renderInventory();
      snapshot.markets.forEach((market, suitIndex) => renderMarket(market, suitIndex, playerKey));
      renderFlowTable(playerKey);
      renderTradeTape(flowKey);
      renderModel();
      renderPnl();
      if (chartFlowKey !== flowKey) {
        chartFlowKey = flowKey;
        scheduleDraw();
      }
      scheduleDiagnostics();
    }

    function syncPlayerRows() {
      const rows = String(snapshot.players.length);
      if (root.style.getPropertyValue('--ff-player-rows') !== rows) {
        root.style.setProperty('--ff-player-rows', rows);
      }
    }

    // Four charts and four summaries share one pass over the trade history.
    function prepareFlow(flowKey) {
      if (preparedFlowKey === flowKey) return;
      preparedFlowKey = flowKey;
      preparedFlow = globalThis.FiggieFlowChart?.prepare?.(snapshot);
    }

    function renderAccount(playerKey) {
      const cardCount = snapshot.held.reduce((sum, count) => sum + count, 0);
      setText($('cash'), snapshot.cash);
      setText($('cards'), cardCount);
      renderSession();
      setText($('inventory-total'), `${cardCount} cards`);
      renderHtml('buyer-legend', playerKey, () => playerLegendMarkup(snapshot));
      setText($('connection'), connectionLabel());
      $('connection').className = isLive() ? 'ff-positive' : 'ff-negative';
    }

    function renderSession() {
      setText($('session'), `R${snapshot.round} · ${snapshot.timer} · ${snapshot.self}`);
    }

    function connectionLabel() {
      if (isLive()) return LIVE_SOURCE_LABEL;
      return snapshot.status === 'ended' ? 'Round ended' : 'Source paused';
    }

    function renderInventory() {
      renderHtml('ff-inventory-items', JSON.stringify([snapshot.held, snapshot.net[0]]), () =>
        inventoryMarkup(snapshot),
      );
    }

    function renderFlowTable(playerKey) {
      renderHtml('flow', JSON.stringify([playerKey, snapshot.net]), () =>
        flowTableMarkup(snapshot),
      );
    }

    function renderTradeTape(flowKey) {
      renderHtml('recent-trades', flowKey, () => tradeTapeMarkup(snapshot));
    }

    // ── Rendering: market panels ─────────────────────────────────────────

    // A panel is repainted only when something it displays has changed. Draft prices count:
    // the resting estimate follows what is typed.
    function renderMarket(market, suitIndex, playerKey) {
      const panel = panels.get(market.id);
      const suitFlowKey = suitHistoryVersions[market.id] + '|' + playerKey;
      const currentModel = freshModel();
      const pendingLanes = pendingLanesFor(market.id);
      const state = [
        currentModel,
        isLive(),
        playerKey,
        suitFlowKey,
        snapshot.cash,
        market.held,
        market.bid,
        market.ask,
        market.buyer,
        market.seller,
        market.canBuy,
        market.canSell,
        market.canBid,
        market.canOffer,
        market.canRaiseBid,
        market.canLowerAsk,
        market.canCancelBid,
        market.canCancelOffer,
        market.fills.length,
        market.fills.at(-1)?.p,
        pendingLanes.join(','),
        draftInput(panel, 'bid').value,
        draftInput(panel, 'ask').value,
      ];
      if (sameValues(marketStates.get(market.id), state)) return;
      marketStates.set(market.id, state);

      const suitEstimate = currentModel ? currentModel.bySuit[suitIndex] : null;
      const estimate = counterpartyEstimate(suitEstimate, market);
      renderTradeFacts(panel, market);
      renderFlowSummary(panel, market, suitFlowKey);
      renderBookPrices(panel, market);
      renderTakeButtons(panel, market, pendingLanes);
      for (const column of COLUMNS) renderBookSide(panel, market, column);
      for (const orderKind of ORDER_KINDS) {
        renderQuoteControls(panel, market, orderKind, pendingLanes.includes(orderKind));
      }
      renderPresets(market, pendingLanes);
      for (const column of COLUMNS) renderRestingEstimate(panel, market, column);
      renderFairValue(panel, estimate);
      for (const column of COLUMNS) renderTakeEdge(panel, market, estimate, column);
    }

    function renderTradeFacts(panel, market) {
      setValue(panel, 'held', market.held);
      setValue(panel, 'last', market.fills.at(-1)?.p ?? NO_VALUE);
      setValue(panel, 'fills', `${market.fills.length} trades`);
    }

    function renderFlowSummary(panel, market, suitFlowKey) {
      if (summarizedFlowKeys.get(market.id) === suitFlowKey) return;
      summarizedFlowKeys.set(market.id, suitFlowKey);
      const summary = globalThis.FiggieFlowChart?.summarize(snapshot, market.id, preparedFlow);
      const node = valueNode(panel, 'flow-summary');
      if (!summary) {
        node.textContent = '';
        return;
      }
      node.textContent = flowSummaryText(summary, snapshot.self);
      node.title = flowSummaryTitle(summary);
    }

    function renderBookPrices(panel, market) {
      setValue(panel, 'bid', `Best bid ${market.bid ?? NO_VALUE}`);
      setValue(panel, 'ask', `Best ask ${market.ask ?? NO_VALUE}`);
      setValue(panel, 'sell-price', market.bid ?? NO_VALUE);
      setValue(panel, 'buy-price', market.ask ?? NO_VALUE);
    }

    function renderTakeButtons(panel, market, pendingLanes) {
      for (const action of ['sell', 'buy']) {
        const button = takeButton(panel, action);
        const busy = pendingLanes.includes(action);
        button.disabled = !isLive() || !canTake(market, action) || busy;
        setBusy(button, busy);
      }
    }

    // Who owns the quote this column trades against, and what taking it would do.
    function renderBookSide(panel, market, column) {
      const { action, bookSide } = column;
      const quote = bookQuote(snapshot, market, column);
      const live = isLive();
      const button = takeButton(panel, action);
      const badge = getNode(panel, `[data-book-owner="${bookSide}"]`);
      const badgeTitle = bookBadgeTitle(quote, live);
      const ownerColor = quote.hasQuote && quote.owner ? quote.owner.color : 'var(--ff-dim)';

      setValue(panel, column.bookOwner, bookOwnerLabel(quote));
      badge.dataset.state = bookBadgeState(quote, live);
      if (badge.style.getPropertyValue('--ff-owner-color') !== ownerColor) {
        badge.style.setProperty('--ff-owner-color', ownerColor);
      }
      badge.title = badgeTitle;
      badge.setAttribute('aria-label', badgeTitle);
      button.title = takeButtonTitle(quote, action);
      button.classList.toggle('ff-own', quote.isOwn);
      renderTakeLabel(panel, button, quote.isOwn ? `Your ${bookSide}` : column.takeLabel);

      const cardsAfter = market.held + (action === 'buy' ? 1 : -1);
      const available = live && canTake(market, action);
      setValue(panel, `after-${action}`, available ? `→ ${cardsAfter} cards` : NO_VALUE);
    }

    function renderTakeLabel(panel, button, label) {
      const node = valueNode(panel, `${button.dataset.action}-label`);
      if (node.dataset.label === label) return;
      node.dataset.label = label;
      node.innerHTML = `${label} <kbd>${button.dataset.shortcut}</kbd>`;
    }

    function renderQuoteControls(panel, market, orderKind, busy) {
      const form = getNode(panel, `form[data-kind="${orderKind}"]`);
      const input = getNode(form, 'input');
      const postButton = getNode(form, 'button');
      const quick = getNode(form, '[data-quick]');
      const cancel = getNode(form, '[data-cancel]');
      input.disabled = !isLive() || !canPost(market, orderKind);
      postButton.disabled = input.disabled || busy;
      setBusy(postButton, busy);
      quick.disabled = !isLive() || busy || !canImprove(market, orderKind);
      cancel.disabled = !isLive() || busy || !canCancel(market, orderKind);
      quick.title = quickButtonTitle(market, orderKind);
      setBusy(quick, busy);
      setBusy(cancel, busy);
    }

    function renderPresets(market, pendingLanes) {
      for (const button of presetButtons.get(market.id)) {
        const orderKind = button.dataset.preset;
        const price = Number(button.dataset.price);
        const blockReason = presetBlockReason(market, orderKind, price);
        const busy = pendingLanes.includes(orderKind);
        button.disabled = Boolean(blockReason) || busy;
        setBusy(button, busy);
        button.title = presetTitle(busy, blockReason, orderKind, price);
      }
    }

    function renderRestingEstimate(panel, market, column) {
      const { quoteSide } = column;
      const draft = draftInput(panel, quoteSide).value;
      const price = restingPrice(market, quoteSide, draft);
      const crossing = isLive() && Number.isFinite(price) && crossesBook(market, quoteSide, price);
      const candidate = modelIsFresh() && isLive() ? model.resting?.[market.id]?.[quoteSide] : null;
      const estimate = !crossing && candidate && candidate.price === price ? candidate : null;
      const oppositeIsOwn = market[column.bookOwner] === snapshot.self;
      const view = restingEstimateView(column, price, crossing, estimate, oppositeIsOwn);
      const row = getNode(panel, `[data-resting="${quoteSide}"]`);
      const gainNode = valueNode(panel, `rest-${quoteSide}-edge`);
      const priceLabel = draft !== '' ? 'Your ' + quoteSide : column.quickLabel;

      setValue(panel, `rest-${quoteSide}-price`, `${priceLabel} @ ${price ?? NO_VALUE}`);
      setValue(panel, `rest-${quoteSide}-fill`, view.fill);
      setValue(panel, `rest-${quoteSide}-edge`, view.gain);
      gainNode.className = view.gainClass;
      row.dataset.state = view.state;
      gainNode.dataset.bonusDependent = String(view.bonusDependent);
      row.title = view.title;
    }

    function renderFairValue(panel, estimate) {
      const baseFair = chips(estimate?.base);
      const signalChips = estimate
        ? CHIPS_PER_GOAL_CARD * (estimate.probability - estimate.structuralProbability)
        : null;
      const signalNode = valueNode(panel, 'flow-value');
      setValue(panel, 'goal', estimate ? percent(estimate.probability) : NO_VALUE);
      setValue(panel, 'fair', baseFair);
      setValue(panel, 'buy-fair', baseFair);
      setValue(panel, 'sell-fair', baseFair);
      setValue(panel, 'flow-value', signedChipsOrDash(signalChips));
      signalNode.className = signClassOrZero(signalChips);
      signalNode.parentElement.title = signalsTitle(estimate, signalChips);
      getNode(panel, '.ff-fair-value').title = fairValueTitle(estimate, signalChips);
    }

    // Gain from taking the quote now: the counterparty-specific value against its price.
    function renderTakeEdge(panel, market, estimate, column) {
      const { action } = column;
      const price = market[column.bookSide];
      const value = estimate?.[action];
      const available = isLive() && canTake(market, action);
      const edge =
        available && Number.isFinite(value) && Number.isFinite(price)
          ? takeGain(action, value, price)
          : null;
      const party = estimate?.counterparties?.[market[column.bookOwner]];
      const baseValue = action === 'buy' ? party?.buyBase : party?.sellBase;
      const baseEdge =
        edge !== null && Number.isFinite(baseValue) ? takeGain(action, baseValue, price) : null;
      const bonusEdge = baseEdge !== null ? edge - baseEdge : null;
      const bonusDependent = edge > 0 && baseEdge !== null && baseEdge < 0;
      const node = valueNode(panel, `${action}-edge`);
      node.textContent = edge === null ? NO_VALUE : `Gain if filled ${signedChips(edge)}`;
      node.className = `ff-model-edge ${edge === null ? 'ff-zero' : signClass(edge)}`;
      node.dataset.bonusDependent = String(bonusDependent);
      node.title = takeEdgeTitle(edge, baseEdge, bonusEdge, bonusDependent);
    }

    // ── Rendering: model panel ───────────────────────────────────────────

    function renderModel() {
      const owners = snapshot.markets.map((market) => market.buyer + '|' + market.seller).join(',');
      const key = [snapshot.status, evidenceKey, model, modelBusy, owners];
      if (sameValues(regionKeys.get('model'), key)) return;
      regionKeys.set('model', key);

      const roundEnded = snapshot.status === 'ended';
      $('goal-odds-caption').textContent = roundEnded
        ? 'Goal probabilities · pre-result'
        : 'Goal-suit probabilities';
      $('model-kind').textContent = modelKindLabel();
      $('model-confidence').textContent = modelConfidenceText(model);
      $('model-confidence').title = modelConfidenceTitle(model);
      $('starting-hand').textContent = snapshot.startingHand
        .map((count, suitIndex) => `${count}${SUITS[suitIndex].symbol}`)
        .join(' · ');
      $('evidence').textContent =
        `${snapshot.trades.length} observed fills · ${snapshot.players.length} players`;
      renderHtml('ff-model-odds', model, () =>
        SUITS.map((suit, suitIndex) => goalOddsMarkup(suit, model?.bySuit[suitIndex])).join(''),
      );
      renderModelPrices(owners);
      renderExpectedPayout();
    }

    function modelKindLabel() {
      if (!modelIsFresh() || modelBusy || !model) return MODEL_UPDATING_LABEL;
      return `${model.mode} · ${model.stateCount.toLocaleString()} worlds`;
    }

    function renderModelPrices(owners) {
      const currentModel = freshModel();
      const key = [currentModel, owners];
      if (sameValues(regionKeys.get('model-prices'), key)) return;
      regionKeys.set('model-prices', key);
      $('ff-model-prices').innerHTML = SUITS.map((suit, suitIndex) => {
        const suitEstimate = currentModel ? currentModel.bySuit[suitIndex] : null;
        const estimate = counterpartyEstimate(suitEstimate, snapshot.markets[suitIndex]);
        return modelPriceRowMarkup(suit, estimate);
      }).join('');
    }

    function renderExpectedPayout() {
      const currentModel = freshModel();
      const expected = (field) => chips(currentModel ? currentModel[field] : null);
      $('ff-inventory-ev').textContent = expected('expectedPayout');
      $('ff-payout-ev').textContent = expected('expectedPayout');
      $('ff-base-ev').textContent = expected('expectedBase');
      $('ff-bonus-ev').textContent = expected('expectedBonus');
    }

    // ── Rendering: P&L panel ─────────────────────────────────────────────

    function renderPnl() {
      if (!snapshot) return;
      const journal = recordedPnl?.roundKey === snapshot.roundKey ? recordedPnl : null;
      const result = snapshot.roundResult;
      const key = [
        historyVersion,
        freshModel(),
        snapshot.status,
        snapshot.cash,
        snapshot.players.length,
        snapshot.held.join(','),
        result?.verified,
        result?.source,
        result?.settledProfit,
        result?.settledBank,
        result?.goal,
        journal?.actualPnl,
        journal?.actualPayout,
        journal?.openingBank,
        journal?.endingBank,
        journal?.source,
        journal?.settlementPending,
      ];
      if (sameValues(pnlKey, key)) return;
      pnlKey = key;

      const pnl = FiggiePnl.summary(snapshot, freshModel());
      if (journal && !Number.isFinite(pnl.actualPnl)) {
        for (const field of JOURNAL_PNL_FIELDS) pnl[field] = journal[field];
      }
      renderPnlTotals(pnl);
      renderPnlScenarios(pnl);
    }

    function renderPnlTotals(pnl) {
      const isFinal = Number.isFinite(pnl.actualPnl);
      const roundEnded = snapshot.status === 'ended';
      const value = isFinal ? pnl.actualPnl : pnl.estimatedPnl;
      const explanation = pnlExplanation(pnl, isFinal, roundEnded);
      $('round-pnl-label').textContent = isFinal ? 'Round P&L final' : 'Round P&L est.';
      $('round-pnl').textContent = signedChipsOrDash(value);
      $('round-pnl').className = signClassOrZero(value);
      $('inventory-valuation-label').textContent = isFinal
        ? 'Settlement received'
        : 'Settlement est.';
      if (isFinal) $('ff-inventory-ev').textContent = chips(pnl.actualPayout);
      $('pnl-state').textContent = isFinal ? 'Final' : 'Est.';
      $('pnl-total').textContent = signedChipsOrDash(value);
      $('pnl-total').className = signClassOrZero(value);
      $('round-pnl').title = explanation;
      $('pnl-total').title = explanation;
      $('pnl-scenarios-state').textContent = roundEnded ? 'Pre-result est.' : 'Est. · settle now';
    }

    function renderPnlScenarios(pnl) {
      renderHtml('pnl-scenarios', JSON.stringify([pnl.goalScenarios, snapshot.status]), () =>
        pnlScenarioTableMarkup(pnl, snapshot.held),
      );
    }

    // ── Rendering: diagnostics ───────────────────────────────────────────

    // Diagnostics are serialized only while the panel is open, at most once per delay.
    function scheduleDiagnostics() {
      if (!diagnosticsPanel.open || diagnosticsTimer) return;
      diagnosticsTimer = setTimeout(() => {
        diagnosticsTimer = null;
        if (diagnosticsPanel.open && snapshot) renderDiagnostics();
      }, DIAGNOSTICS_REFRESH_DELAY_MS);
    }

    function onDiagnosticsToggle() {
      if (diagnosticsPanel.open && snapshot) {
        renderDiagnostics();
      } else if (diagnosticsTimer) {
        clearTimeout(diagnosticsTimer);
        diagnosticsTimer = null;
      }
    }

    function renderDiagnostics() {
      const report = {
        round: snapshot.round,
        timer: snapshot.timer,
        serial: snapshot.serial,
        self: snapshot.self,
        cash: snapshot.cash,
        held: snapshot.held,
        startingHand: snapshot.startingHand,
        players: snapshot.players.map((player) => player.name),
        trades: snapshot.trades.length,
        quotes: snapshot.markets.map((market) => ({
          suit: market.id,
          bid: market.bid,
          ask: market.ask,
          buyer: market.buyer,
          seller: market.seller,
          canBuy: market.canBuy,
          canSell: market.canSell,
        })),
        model: model && {
          version: model.version,
          mode: model.mode,
          states: model.stateCount,
          probabilities: model.bySuit.map((suit) => suit.probability),
          baseline: model.baseline?.probabilities,
          behavior: model.behavior,
          computeMs: model.computeMs,
          metrics: model.metrics,
          bonusMetrics: model.bonusMetrics,
          inventoryEvidence: model.inventoryEvidence,
          inventoryCalibration: model.inventoryCalibration,
          resting: model.resting,
          recordingCoverageIncomplete: model.recordingCoverageIncomplete,
        },
      };
      $('diagnostics').value = JSON.stringify(report, null, 2);
    }

    // ── Rendering: flow charts ───────────────────────────────────────────

    function scheduleDraw(resized = false) {
      drawAfterResize = drawAfterResize || resized;
      if (drawScheduled) return;
      drawScheduled = true;
      requestAnimationFrame(() => {
        drawScheduled = false;
        const forced = drawAfterResize;
        drawAfterResize = false;
        drawCharts(forced);
      });
    }

    function drawCharts(resized = false) {
      if (!snapshot || !globalThis.FiggieFlowChart) return;
      const playerKey = playersKey();
      snapshot.markets.forEach((market) => drawChart(market.id, playerKey, resized));
    }

    // Unchanged charts return before measuring, so they cost no layout read.
    function drawChart(suitId, playerKey, resized) {
      const dataKey = suitHistoryVersions[suitId] + '|' + playerKey;
      if (!resized && chartDataKeys.get(suitId) === dataKey) return;
      const svg = getNode(panels.get(suitId), 'svg');
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (width < MIN_CHART_WIDTH_PX || height < MIN_CHART_HEIGHT_PX) return;
      const drawKey = [width, height, dataKey].join('|');
      chartDataKeys.set(suitId, dataKey);
      if (chartDrawKeys.get(suitId) === drawKey) return;
      chartDrawKeys.set(suitId, drawKey);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.innerHTML = FiggieFlowChart.render(snapshot, suitId, {
        width,
        height,
        prepared: preparedFlow,
      });
    }

    // ── Model requests ───────────────────────────────────────────────────

    // The evidence key changes only with the deal, the players or the trade history, and
    // decides whether the current model can still be shown. The request key also covers
    // quote-only updates and draft prices, which refine a model without invalidating it.
    function requestModel() {
      const nextEvidenceKey = JSON.stringify([
        snapshot.roundKey,
        snapshot.startingHand,
        snapshot.players.map((player) => player.name),
        historyVersion,
        snapshot.training || null,
      ]);
      const quotePrices = draftQuotePrices();
      const opponentEnabled = $('opponent-model').checked;
      const requestKey = JSON.stringify([
        nextEvidenceKey,
        snapshot.analysisRevision || 0,
        opponentEnabled,
        quotePrices,
      ]);
      if (requestKey === lastRequestKey) return;
      lastRequestKey = requestKey;
      const roundChanged = model && model.roundKey !== snapshot.roundKey;
      evidenceKey = nextEvidenceKey;
      if (roundChanged) model = null;
      queuedJob = {
        key: nextEvidenceKey,
        requestEvidenceKey: requestKey,
        snapshot,
        opponentEnabled,
        quotePrices,
      };
      if (!modelIsFresh()) $('model-kind').textContent = MODEL_UPDATING_LABEL;
      scheduleModel();
    }

    function draftQuotePrices() {
      const quotePrices = {};
      for (const form of quoteForms) {
        const price = draftPrice(getNode(form, 'input').value);
        if (price === null) continue;
        quotePrices[form.dataset.id] ||= {};
        quotePrices[form.dataset.id][form.dataset.quote] = price;
      }
      return quotePrices;
    }

    // The worker waits for its matching in-memory observation; disk commits do not gate inference.
    // Jobs are spaced out, and a request made while one is in flight waits for the reply.
    function scheduleModel() {
      if (modelBusy || modelJobTimer || !queuedJob) return;
      const sinceLastJob = Date.now() - lastModelSentAt;
      modelJobTimer = setTimeout(
        () => {
          modelJobTimer = null;
          postModel();
        },
        Math.max(0, MODEL_REQUEST_MIN_INTERVAL_MS - sinceLastJob),
      );
    }

    function postModel() {
      if (!queuedJob || modelBusy) return;
      const job = queuedJob;
      queuedJob = null;
      modelBusy = true;
      inFlight = {
        roundKey: job.snapshot.roundKey,
        evidenceKey: job.key,
        requestKey: job.requestEvidenceKey,
      };
      lastModelSentAt = Date.now();
      sendModelJob({
        id: ++modelJobCount,
        key: job.key,
        snapshot: job.snapshot,
        opponentEnabled: job.opponentEnabled,
        quotePrices: job.quotePrices,
      });
    }

    function sendModelJob(job) {
      try {
        chrome.runtime.sendMessage({ type: 'figgie-model', job }, (response) => {
          if (chrome.runtime.lastError) {
            onModelFailure();
          } else {
            onModelReply(response);
          }
        });
      } catch {
        onModelFailure();
      }
    }

    function onModelReply(response) {
      modelBusy = false;
      const reply = response || {};
      if (reply.recording) updateRecording(reply.recording);
      // A reply computed for an earlier round or trade history must not restore stale prices.
      const forCurrentEvidence =
        inFlight.roundKey === snapshot?.roundKey && inFlight.evidenceKey === evidenceKey;
      if (forCurrentEvidence) applyModelReply(reply);
      scheduleModel();
    }

    function applyModelReply(reply) {
      // A newer queued observation will provide the next model.
      if (reply.superseded) return;
      if (reply.error) {
        showNotice(`Model paused: ${reply.error}`, true);
        $('model-kind').textContent = 'Model paused';
        return;
      }
      if (!reply.model) return;
      model = {
        ...reply.model,
        receivedAt: Date.now(),
        roundKey: snapshot.roundKey,
        evidenceKey: inFlight.evidenceKey,
        requestEvidenceKey: inFlight.requestKey,
      };
      render();
    }

    function onModelFailure() {
      modelBusy = false;
      showNotice('Model unavailable. Current Figgie quotes still drive manual trading.', true);
      if (queuedJob) scheduleModel();
    }

    function onOpponentModelToggle() {
      lastRequestKey = '';
      if (snapshot) requestModel();
    }

    // ── Recording and export ─────────────────────────────────────────────

    function updateRecording(recording) {
      applyRecordedRoundFacts(recording);
      scheduleModel();
      renderRecordingStatus(recording);
    }

    // Disk acknowledgements can arrive after newer in-memory model summaries.
    // Keep round facts monotonic; the storage status still reports every ACK.
    function applyRecordedRoundFacts(recording) {
      const revision = Number.isFinite(recording.observedRevision)
        ? recording.observedRevision
        : null;
      const currentRound = Boolean(snapshot && recording.roundKey === snapshot.roundKey);
      const upToDate =
        revision === null ? lastRecordedRevision < 0 : revision >= lastRecordedRevision;
      if (!currentRound || !upToDate) return;
      if (revision !== null) lastRecordedRevision = revision;
      trainingUI?.recording(recording);
      if (recording.practice) practiceRoundKey = recording.roundKey;
      if (recording.pnl?.roundKey === snapshot.roundKey) {
        recordedPnl = recording.pnl;
        renderPnl();
      }
    }

    function renderRecordingStatus(recording) {
      const state = $('recording-state');
      const pendingEvents = recording.pendingEvents || 0;
      const coverage = recording.coverage || 'Local recording';
      const practiceTag = recording.practice ? ' · practice' : '';
      state.textContent = recording.error
        ? 'REC ERROR'
        : `REC${practiceTag} · ${recording.events ?? 0} events`;
      state.className = recording.error ? 'ff-negative' : 'ff-positive';
      state.title =
        recording.error || `${pendingEvents} events awaiting local storage. ${coverage}`;
      $('recording-details').textContent =
        recording.error ||
        `${recording.roundId || 'No round yet'} · ${recording.events || 0} events` +
          ` · ${pendingEvents} pending`;
    }

    function runtimeRequest(message) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError?.message || response?.error;
          if (error) {
            reject(Error(error));
          } else {
            resolve(response);
          }
        });
      });
    }

    async function exportRecording(allRounds) {
      try {
        showNotice('Exporting recordings…');
        const response = await FiggieRecordingExport.read(
          runtimeRequest,
          allRounds ? 'all' : undefined,
        );
        const blob = new Blob(response.parts, { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = response.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_LIFETIME_MS);
        showNotice('Recording exported. Source observations and model predictions are included.');
      } catch (error) {
        showNotice(error.message, true);
      }
    }

    async function recordRevealedGoal() {
      const goal = $('revealed-goal').value;
      if (!goal || snapshot?.status !== 'ended') {
        return showNotice('Record the revealed goal after the round ends.', true);
      }
      try {
        const response = await runtimeRequest({
          type: 'figgie-reveal',
          result: { goal, source: 'user-confirmed', verified: false },
        });
        updateRecording(response.recording);
        $('round-result-state').textContent = isPracticeRound()
          ? 'Practice goal recorded; excluded from normal calibration.'
          : 'Goal recorded for forward calibration.';
      } catch (error) {
        showNotice(error.message, true);
      }
    }

    // ── Orders ───────────────────────────────────────────────────────────

    function takeCommand(market, action) {
      const isBuy = action === 'buy';
      return {
        suit: market.id,
        kind: action,
        price: isBuy ? market.ask : market.bid,
        signature: snapshot.signature,
        roundKey: snapshot.roundKey,
        tradeCount: snapshot.trades.length,
        owner: isBuy ? market.seller : market.buyer,
      };
    }

    function quickCommand(button) {
      const market = marketById(button.dataset.id);
      const orderKind = button.dataset.quick || button.dataset.cancel;
      const isBid = orderKind === 'bid';
      const isCancel = Boolean(button.dataset.cancel);
      const quoted = isBid ? market.bid : market.ask;
      const improved = isBid ? market.bid + 1 : market.ask - 1;
      const improveKind = isBid ? 'raise-bid' : 'lower-ask';
      return {
        suit: market.id,
        kind: isCancel ? `cancel-${orderKind}` : improveKind,
        price: isCancel ? quoted : improved,
        owner: isBid ? market.buyer : market.seller,
        tradeCount: snapshot.trades.length,
        roundKey: snapshot.roundKey,
      };
    }

    function presetCommand(button) {
      return {
        suit: button.dataset.id,
        kind: button.dataset.preset,
        price: Number(button.dataset.price),
        roundKey: snapshot.roundKey,
        tradeCount: snapshot.trades.length,
        restingOnly: true,
      };
    }

    // Returns the command captured when this button was pressed, if that press still stands.
    function claimPress(button) {
      if (pressed?.button !== button) return null;
      const command = pressed;
      pressed = null;
      delete command.button;
      return command;
    }

    function take(suitId, action) {
      if (!isLive()) return showNotice('Source is stale or round ended. Wait for Figgie.', true);
      const market = marketById(suitId);
      if (!canTake(market, action)) return;
      dispatch(takeCommand(market, action));
    }

    function postQuote(form) {
      const input = getNode(form, 'input');
      if (getNode(form, '.ff-post').disabled) return;
      if (!isLive()) return showNotice(WAIT_FOR_LIVE_NOTICE, true);
      const price = draftPrice(input.value);
      if (price === null || (form.dataset.kind === 'bid' && price > snapshot.cash)) {
        input.reportValidity();
        return showNotice('Enter a valid whole-chip price.', true);
      }
      dispatch({
        suit: form.dataset.id,
        kind: form.dataset.kind,
        price,
        signature: snapshot.signature,
        roundKey: snapshot.roundKey,
        tradeCount: snapshot.trades.length,
      });
    }

    // Send first; disable the affected lane immediately and paint secondary data on the next frame.
    function dispatch(order) {
      const lane = orderLane(order.kind);
      if (pendingLanesFor(order.suit).includes(lane)) return;
      const id = ++lastCommandId;
      const command = { ...order, decision: decisionSnapshot(order) };
      pendingOrders.set(id, command);
      marketStates.delete(command.suit);
      markLanePending(command.suit, lane);
      send({ type: 'command', id, command });
      scheduleRender();
      showNotice(`Sending ${command.kind} ${suitById(command.suit).symbol} at ${command.price}…`);
    }

    function markLanePending(suitId, lane) {
      const panel = panels.get(suitId);
      if (lane === 'buy' || lane === 'sell') {
        markPending(takeButton(panel, lane));
        return;
      }
      const form = getNode(panel, `form[data-kind="${lane}"]`);
      if (form) {
        for (const selector of ['button', '[data-quick]', '[data-cancel]']) {
          markPending(getNode(form, selector));
        }
      }
      for (const button of presetButtons.get(suitId)) {
        if (button.dataset.preset === lane) markPending(button);
      }
    }

    // What the model said when the order was sent. The bridge journals it with the command.
    function decisionSnapshot(order) {
      if (!modelIsFresh()) return null;
      const suitIndex = SUITS.findIndex((suit) => suit.id === order.suit);
      const market = snapshot.markets[suitIndex];
      const suitEstimate = model.bySuit[suitIndex];
      const isTake = ['buy', 'sell'].includes(order.kind);
      const quoteSide = quoteSideOfOrder(order.kind);
      const preview = quoteSide ? model.resting?.[market.id]?.[quoteSide] : null;
      const estimate = isTake
        ? takeDecisionEstimate(order, market, suitEstimate)
        : restingDecisionEstimate(order, market, quoteSide, preview);
      const { conditionalGain, baseEdge } = estimate;
      return {
        at: Date.now(),
        modelVersion: model.version,
        practice: Boolean(snapshot.training?.enabled),
        afterPeek: Boolean(trainingUI?.hasPeeked()),
        modelAgeMs: Math.max(0, Date.now() - model.receivedAt),
        mode: model.mode,
        goalProbabilities: model.bySuit.map((suit) => suit.probability),
        cardsOnly: model.baseline?.probabilities,
        baseFair: suitEstimate.base,
        opponentAdjustment:
          CHIPS_PER_GOAL_CARD * (suitEstimate.probability - suitEstimate.structuralProbability),
        price: order.price,
        action: order.kind,
        estimatedGain: estimate.gain,
        fillChance: estimate.fillChance,
        conditionalGain,
        baseEdge,
        bonusEdge: estimate.bonusEdge,
        bonusDependent: conditionalGain > 0 && Number.isFinite(baseEdge) && baseEdge < 0,
        horizonSeconds: decisionHorizonSeconds(isTake, quoteSide),
        expectedSettlement: model.expectedPayout,
      };
    }

    // ── Input: takes ─────────────────────────────────────────────────────

    function onTakePress(event) {
      const button = event.target.closest('[data-action]');
      if (!button || !snapshot) return;
      const market = marketById(button.dataset.id);
      pressed = { button, ...takeCommand(market, button.dataset.action) };
    }

    function onTakeClick(event) {
      if (announceFill(event)) return;
      const button = event.target.closest('[data-action]');
      if (!button || button.disabled) return;
      const command = claimPress(button);
      if (!command) {
        take(button.dataset.id, button.dataset.action);
      } else if (isLive()) {
        dispatch(command);
      }
    }

    // Clicking a fill mark describes that trade in the notice.
    // Returns whether the click was on a mark.
    function announceFill(event) {
      const mark = event.target.closest('[data-fill]');
      if (!mark || !snapshot) return false;
      const market = marketById(mark.closest('.ff-market').dataset.suit);
      const fill = market.fills[Number(mark.dataset.fill)];
      if (fill) {
        showNotice(`${market.symbol} ${fill.b} bought from ${fill.s} at ${fill.p} chips.`);
      }
      return true;
    }

    // ── Input: quick raise, lower and cancel ─────────────────────────────

    function onQuickPress(event) {
      const button = event.target.closest('[data-quick],[data-cancel]');
      if (!button || !snapshot) return;
      pressed = { button, ...quickCommand(button) };
    }

    function onQuickClick(event) {
      const button = event.target.closest('[data-quick],[data-cancel]');
      if (!button || button.disabled || !snapshot) return;
      event.preventDefault();
      dispatch(claimPress(button) ?? quickCommand(button));
    }

    // ── Input: presets ───────────────────────────────────────────────────

    // Presets post the displayed fixed price directly;
    // a changing book must never turn one into a take.
    function onPresetPress(event) {
      const button = event.target.closest('[data-preset]');
      if (!button || button.disabled || !snapshot) return;
      pressed = { button, ...presetCommand(button) };
    }

    function onPresetClick(event) {
      const button = event.target.closest('[data-preset]');
      if (!button || button.disabled || !snapshot) return;
      event.preventDefault();
      const command = claimPress(button) ?? presetCommand(button);
      pressed = null;
      const marketMoved =
        command.roundKey !== snapshot.roundKey || command.tradeCount !== snapshot.trades.length;
      if (marketMoved) {
        return showNotice('Market reset. Review the refreshed quote before submitting.', true);
      }
      const blockReason = presetBlockReason(marketById(command.suit), command.kind, command.price);
      if (blockReason) return showNotice(blockReason, true);
      dispatch(command);
    }

    // ── Input: custom quotes ─────────────────────────────────────────────

    function wireQuoteForm(form) {
      const input = getNode(form, 'input');
      const submit = (event) => {
        event.preventDefault();
        postQuote(form);
      };
      input.addEventListener('input', () => {
        if (!snapshot) return;
        requestModel();
        render();
      });
      form.addEventListener('submit', submit);
      getNode(form, 'button').addEventListener('click', submit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit(event);
      });
    }

    // ── Input: keyboard ──────────────────────────────────────────────────

    // Capture before Figgie's native hotkeys, including when focus is on the page body.
    function onTradeHotkey(event) {
      if (shadow.host.style.display === 'none' || !TRADE_HOTKEY.test(event.key)) return;
      if (trainingUI?.isOpen()) {
        event.stopImmediatePropagation();
        return;
      }
      const editing = event.composedPath().some((node) => node?.matches?.(TEXT_ENTRY));
      if (editing || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!$('ff-keys').checked || event.repeat) return;
      const button = root.querySelector(`[data-shortcut="${event.key}"]`);
      if (button && !button.disabled) take(button.dataset.id, button.dataset.action);
    }

    // ── Messages from the bridge ─────────────────────────────────────────

    function receive(message) {
      switch (message.type) {
        case 'snapshot':
          onSnapshot(message.snapshot);
          break;
        case 'heartbeat':
          onHeartbeat(message);
          break;
        case 'fault':
          onSourceDown(message.message, true);
          break;
        case 'waiting':
          onSourceDown(message.reason, false);
          break;
        case 'recording':
          updateRecording(message.recording);
          break;
        case 'round-result':
          onRoundResult(message.result);
          break;
        case 'order':
        case 'reject':
          onOrderResult(message);
          break;
        case 'ack':
          if (pendingOrders.has(message.id)) showNotice(message.message);
          break;
      }
    }

    function onSnapshot(next) {
      lastSourceUpdateAt = Date.now();
      const before = snapshot;
      snapshot = next;
      if (!sameHistory(before, snapshot)) bumpHistoryVersions(before, snapshot);
      const newRound = !before || before.roundKey !== snapshot.roundKey;
      if (newRound || before.trades.length !== snapshot.trades.length) clearDrafts();
      if (newRound) resetForNewRound();
      requestModel();
      render();
    }

    // Only the suits whose trades changed are invalidated, so the other charts are not redrawn.
    function bumpHistoryVersions(before, after) {
      historyVersion++;
      if (before?.roundKey !== after.roundKey) {
        for (const suitId in suitHistoryVersions) suitHistoryVersions[suitId]++;
        return;
      }
      const length = Math.max(before.trades.length, after.trades.length);
      for (let i = 0; i < length; i++) {
        const old = before.trades[i];
        const current = after.trades[i];
        if (old && current && sameTrade(old, current)) continue;
        if (old && old.suit in suitHistoryVersions) suitHistoryVersions[old.suit]++;
        if (current && current.suit in suitHistoryVersions) suitHistoryVersions[current.suit]++;
      }
    }

    function resetForNewRound() {
      recordedPnl = null;
      lastRecordedRevision = -1;
      practiceRoundKey = '';
      pendingOrders.clear();
      regionKeys.clear();
      chartDrawKeys.clear();
      chartDataKeys.clear();
      marketStates.clear();
      summarizedFlowKeys.clear();
      pnlKey = null;
      showNotice(NEW_ROUND_NOTICE);
    }

    // Heartbeats carry only the clock and status, so they repaint just the session line
    // unless the source had gone stale.
    function onHeartbeat(heartbeat) {
      const wasStale = !isLive();
      lastSourceUpdateAt = Date.now();
      if (!snapshot) return;
      snapshot.timer = heartbeat.timer;
      snapshot.status = heartbeat.status;
      snapshot.analysisRevision = heartbeat.analysisRevision ?? snapshot.analysisRevision;
      requestModel();
      renderSession();
      trainingUI?.update(snapshot, model, trainingState());
      if (wasStale) render();
    }

    function onSourceDown(text, isError) {
      lastSourceUpdateAt = 0;
      showNotice(text, isError);
      render();
    }

    function onRoundResult(result) {
      const saved = isPracticeRound()
        ? 'Saved as practice; excluded from calibration.'
        : 'Saved for calibration.';
      $('round-result-state').textContent =
        `Revealed goal: ${suitById(result.goal)?.name}. ${saved}`;
    }

    function onOrderResult(result) {
      pendingOrders.delete(result.id);
      showNotice(result.message, result.type === 'reject' || result.state === 'unconfirmed');
      render();
    }

    function refreshSourceAge() {
      const ageSeconds = Math.max(0, (Date.now() - lastSourceUpdateAt) / 1000);
      $('update-state').textContent = lastSourceUpdateAt
        ? `Source update ${ageSeconds.toFixed(1)}s ago`
        : 'Waiting for source';
      // The source turns stale on time alone, without any message to trigger a render.
      if (snapshot && !isLive() && $('connection').textContent === LIVE_SOURCE_LABEL) render();
    }

    // ── Start ────────────────────────────────────────────────────────────

    diagnosticsPanel.addEventListener('toggle', onDiagnosticsToggle);
    $('opponent-model').addEventListener('change', onOpponentModelToggle);
    $('export-recording').addEventListener('click', () => exportRecording(false));
    $('export-all-recordings').addEventListener('click', () => exportRecording(true));
    $('save-revealed-goal').addEventListener('click', recordRevealedGoal);
    root.addEventListener('pointerdown', onTakePress);
    root.addEventListener('click', onTakeClick);
    root.addEventListener('pointerdown', onQuickPress);
    root.addEventListener('click', onQuickClick);
    root.addEventListener('pointerdown', onPresetPress);
    root.addEventListener('click', onPresetClick);
    quoteForms.forEach(wireQuoteForm);
    document.addEventListener('keydown', onTradeHotkey, true);
    root.addEventListener('keydown', (event) => event.stopPropagation());
    $('show-figgie').addEventListener('click', () => send({ type: 'show-original' }));
    setInterval(refreshSourceAge, SOURCE_AGE_REFRESH_INTERVAL_MS);
    new ResizeObserver(() => scheduleDraw(true)).observe($('ff-markets'));
    send({ type: 'ready' });
    return { receive };
  }

  globalThis.FiggieTerminalUI = { mount };
})();
