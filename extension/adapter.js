/*
 * Visible-DOM adapter. Reads the game Figgie has rendered on the page (players,
 * hands, quotes, trade history, round results) and validates it into a snapshot.
 * No cookies, credentials, React internals, or network access.
 */
(function (scope) {
  'use strict';

  // Figgie draws a suit in two ways. Hands shown in full use a playing card: an
  // SVG whose id starts with `card`. Everything else uses a small suit icon: an
  // SVG recognized by its `viewBox`.
  const SUITS = [
    { id: 's', name: 'Spades', symbol: '♠', card: 'spades_card_', viewBox: '0 0 48.89 60' },
    { id: 'c', name: 'Clubs', symbol: '♣', card: 'clubs_card_', viewBox: '0 0 51.84 59.86' },
    { id: 'd', name: 'Diamonds', symbol: '♦', card: 'diamonds_card_', viewBox: '0 0 40.62 60.03' },
    { id: 'h', name: 'Hearts', symbol: '♥', card: 'hearts_card_', viewBox: '0 0 55.87 59.69' },
  ];

  // A deck has 40 cards in suits of 8, 10, 10 and 12, dealt evenly to 4 or 5 players.
  const DECK_SIZE = 40;
  const SUIT_SIZES = [8, 10, 10, 12];
  const LARGEST_SUIT_SIZE = 12;
  const PLAYER_COUNTS = [4, 5];

  // How far up the tree a search for an enclosing element may go.
  const MAX_ANCESTOR_DEPTH = 12;
  const MAX_SUIT_GROUP_DEPTH = 10;

  // Figgie marks every piece of text, and every text input, with dir="auto".
  const TEXT_SELECTOR = '[dir="auto"]';
  const PRESSABLE_SELECTOR = '[tabindex="0"]';
  const PRICE_INPUT_SELECTOR = 'input[inputmode="numeric"]';
  const CHIP_ID_PREFIX = 'chip_';
  const CARD_BACK_ID_PREFIX = 'purple_cards_';
  const CHIP_SELECTOR = `svg[id^="${CHIP_ID_PREFIX}"]`;
  const CARD_BACK_SELECTOR = `svg[id^="${CARD_BACK_ID_PREFIX}"]`;
  const HAND_CARD_SELECTOR = SUITS.map(cardIconSelector).join(',');
  const CANCEL_ICON_SELECTOR = 'svg[id^="gameplay_btn_cancel_"]';
  const OUTSIDE_HISTORY_SELECTOR = `input, ${CARD_BACK_SELECTOR}, ${CHIP_SELECTOR}`;

  // The two sides of a quote row. `takeLabel` names the button that trades
  // against the resting quote; `improveIcon` is the arrow that moves your own
  // quote one chip closer to the other side.
  const BID_SIDE = { takeLabel: 'SELL', improveIcon: 'svg[id^="gameplay_btn_up_"]' };
  const ASK_SIDE = { takeLabel: 'BUY', improveIcon: 'svg[id^="gameplay_btn_down_"]' };

  // Texts as Figgie renders them.
  const ROUND_ENDED_TEXT =
    /^(round (?:has )?ended|end of round rankings|round results|round over)$/i;
  const REVIEW_TEXT = /^review(?: round)?$/i;
  const NEXT_ROUND_TEXT = /^(?:new|next) round$/i;
  const RESULT_PANEL_TEXT = /^(End of round rankings|Goal Suit|Your Starting Hand)$/;
  const CONNECTION_TROUBLE_TEXT =
    /^(disconnected|reconnecting|connection lost|connecting to server)/i;
  const ANTE_TEXT = /^Ante Up!$/i;
  const COUNTDOWN_TEXT = /^Game starts in/;
  const ROUND_TEXT = /^Round\s+\d+$/;
  const TIMER_TEXT = /^\d+:\d\d$/;
  const ROOM_TEXT = /'s game$/;
  const WHOLE_NUMBER = /^\d+$/;
  const SIGNED_NUMBER = /^[+-]\d+$/;
  const LEADING_COUNT = /^\d+(?:\s|$)/;
  const BANK_TEXT = /^\d+(?:\.\d+)?$/;
  const PROFIT_TEXT = /^[+-]?\d+(?:\.\d+)?$/;

  const TRADE_HISTORY_HEADING = 'Buyer';
  const RANKINGS_HEADING = 'End of round rankings';
  const GOAL_SUIT_LABEL = 'Goal Suit';
  const BOT_DIFFICULTY_LABEL = 'Bot Difficulty';
  const BOT_DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

  const VISIBLE_HANDS_SOURCE = 'visible-live-hands';
  const REVEALED_HANDS_SOURCE = 'revealed-hands';
  const RANKINGS_SOURCE = 'official-round-rankings';

  // Round profits are zero-sum. A larger imbalance means the rankings are
  // still being rendered.
  const PROFIT_SUM_TOLERANCE = 0.05;

  // The market fields that make up the snapshot signature, in signature order.
  const QUOTE_SIGNATURE_FIELDS = [
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

  // Your name, once known, per page. It keeps your tile identified when
  // practice mode draws other players' tiles the same way as yours.
  const selfByDocument = new WeakMap();

  // Returns a snapshot of the game, or `{ status: 'waiting', reason }` while
  // there is no game on the page to read. Throws when a game is there but
  // cannot be read consistently, as happens in the middle of a page update.
  function read(document) {
    const root = document.getElementById('root');
    if (!root) return waiting('Waiting for Figgie.');
    const textNodes = textElements(root);
    const texts = textNodes.map(trimmedText);
    const ended = hasRoundEnded(texts);

    const quoteRows = findQuoteRows(root);
    if (quoteRows.length !== SUITS.length) return waiting('Open or start a game in Figgie.');
    const tradingArea = findTradingArea(root, quoteRows);
    const resultMarkers = textNodes.filter((node, index) => RESULT_PANEL_TEXT.test(texts[index]));
    const seats = findPlayerTiles(tradingArea, resultMarkers).map(readSeat);

    // Practice (Learning) mode shows other players' hands during play. When it
    // does, a failed read is returned as a waiting snapshot with invalid
    // training truth instead of thrown, so the caller still learns that hands
    // were exposed.
    const handsExposed = !ended && showsOtherHands(seats);
    try {
      return readGame({ document, root, textNodes, texts, ended, quoteRows, seats, handsExposed });
    } catch (error) {
      if (!handsExposed) throw error;
      const reason = error.message || 'Waiting for consistent visible hands.';
      return { ...waiting(reason), training: invalidTraining(reason) };
    }
  }

  function readGame({ document, root, textNodes, texts, ended, quoteRows, seats, handsExposed }) {
    const selfSeat = findSelfSeat(document, seats);
    if (!selfSeat) {
      if (handsExposed) throw Error('Waiting for your complete visible hand.');
      return waiting('Waiting for your hand.');
    }
    const { self, cash, held } = readOwnPosition(selfSeat);

    // You are always the first player.
    const orderedSeats = [selfSeat, ...seats.filter((seat) => seat !== selfSeat)];
    const players = orderedSeats.map((seat, index) => readPlayer(seat, index === 0));
    if (!isCompletePlayerList(players)) {
      if (!handsExposed) throw Error('Player list is incomplete.');
      return {
        ...waiting('Player list is incomplete.'),
        training: invalidTraining('Waiting for four or five distinct visible player panels.'),
      };
    }
    const names = players.map((player) => player.name);

    const trades = readTradeHistory(root, textNodes, names);
    const net = netFlow(trades, names);
    const dealSize = DECK_SIZE / players.length;
    const startingHand = reconstructStartingHand(held, net[0], dealSize);
    const flowMismatch = hasFlowMismatch(players, net);
    if (flowMismatch && !handsExposed) {
      throw Error('Trade history and player flow disagree; waiting for a complete update.');
    }
    fillMissingCardCounts(players, net, dealSize);
    const training = handsExposed
      ? readTrainingTruth(players, orderedSeats, net, trades, flowMismatch)
      : undefined;
    selfByDocument.set(document, self);

    const { markets, refs } = readMarkets(quoteRows, players, trades, { self, cash, held });
    const room = texts.find((text) => ROOM_TEXT.test(text)) || 'Figgie';
    const round = readRoundNumber(texts);
    const roundKey = [room, round, ...names].join('|');
    const roundResult = ended ? readRankings(document, { self, players }) : null;
    return {
      status: gameStatus(ended, texts),
      antePending: texts.some((text) => ANTE_TEXT.test(text) || COUNTDOWN_TEXT.test(text)),
      roundResult,
      ...(training ? { training } : {}),
      self,
      cash,
      held,
      startingHand,
      players,
      net,
      markets,
      trades,
      round,
      timer: texts.find((text) => TIMER_TEXT.test(text)) || '',
      room,
      roundKey,
      signature: signatureOf({ roundKey, cash, held, trades, roundResult, training, markets }),
      refs,
    };
  }

  function waiting(reason) {
    return { status: 'waiting', reason };
  }

  // ── Finding the table ──────────────────────────────────────────────────

  // Each suit has one quote row: the nearest box around a price input that
  // holds exactly two inputs, the bid and the offer.
  function findQuoteRows(root) {
    const priceInputs = Array.from(root.querySelectorAll('input')).filter(
      (input) => input.getAttribute('inputmode') === 'numeric',
    );
    const holdsBothInputs = (element) => element.querySelectorAll('input').length === 2;
    const rows = priceInputs.map((input) => closestWhere(input.parentElement, holdsBothInputs));
    return unique(rows.filter(Boolean));
  }

  // Scope discovery to the native trading area: the smallest box that holds
  // every quote row and a hand drawn as cards. The native self tile uses
  // stacked card SVGs; opponent tiles retain a purple back plus small suit
  // rows even when Learning reveals their numeric hands (client 1943/1944).
  function findTradingArea(root, quoteRows) {
    let area = quoteRows[0];
    while (area !== root && !quoteRows.every((row) => area.contains(row))) {
      area = area.parentElement;
    }
    while (area !== root && !area.querySelector(HAND_CARD_SELECTOR)) {
      area = area.parentElement;
    }
    return area;
  }

  function findPlayerTiles(tradingArea, resultMarkers) {
    const chips = Array.from(tradingArea.querySelectorAll(CHIP_SELECTOR));
    const tiles = unique(chips.map(findPlayerTile).filter(Boolean));
    return tiles.filter((tile) => !isInResultPanel(tile, tradingArea, resultMarkers));
  }

  // A player tile is the nearest box around a chip icon that holds exactly one
  // chip, no input, and a hand: a card back, a card icon, or all four suit icons.
  function findPlayerTile(chip) {
    return closestWhere(chip.parentElement, (element) => {
      const nodes = Array.from(element.querySelectorAll('svg,input'));
      if (nodes.some((node) => node.tagName === 'INPUT')) return false;
      if (nodes.filter((node) => hasIdPrefix(node, CHIP_ID_PREFIX)).length !== 1) return false;
      return (
        nodes.some(isHandIcon) ||
        SUITS.every((suit) => nodes.some((node) => isSuitIcon(node, suit)))
      );
    });
  }

  function isHandIcon(icon) {
    return hasIdPrefix(icon, CARD_BACK_ID_PREFIX) || SUITS.some((suit) => isCardIcon(icon, suit));
  }

  // Result screens repeat the player tiles under their own headings. A tile
  // belongs to one when, climbing towards the trading area, a result heading
  // comes into view before any quote input does.
  function isInResultPanel(tile, tradingArea, resultMarkers) {
    if (!resultMarkers.length) return false;
    for (let element = tile; element && element !== tradingArea; element = element.parentElement) {
      if (element.querySelector(PRICE_INPUT_SELECTOR)) return false;
      if (resultMarkers.some((marker) => element.contains(marker))) return true;
    }
    return false;
  }

  // A seat is everything read from one player tile.
  function readSeat(tile) {
    const hand = readVisibleHand(tile);
    const header = findHeader(tile);
    return { tile, hand, header, headerTexts: leafTexts(header) };
  }

  // The header is the nearest box around the chip icon that holds at least two
  // texts. Its first text is the player's name and its last the chip balance.
  function findHeader(tile) {
    const chip = tile.querySelector(CHIP_SELECTOR);
    return closestWhere(chip.parentElement, (element) => leafTexts(element).length >= 2);
  }

  // Reads the hand a tile shows: per suit, the count and the net change beside
  // it. `isShown` is true when the tile displays a hand at all, drawn as cards
  // or with at least one count filled in; `isComplete` when all four counts
  // are valid.
  function readVisibleHand(tile) {
    const icons = Array.from(tile.querySelectorAll('svg'));
    const cardIcons = SUITS.map((suit) => icons.find((icon) => isCardIcon(icon, suit)));
    const usesCardIcons = cardIcons.some(Boolean);
    const matchesSuit = usesCardIcons ? isCardIcon : isSuitIcon;
    const suitIcons = usesCardIcons
      ? cardIcons
      : SUITS.map((suit) => icons.find((icon) => isSuitIcon(icon, suit)));
    const counts = [];
    const netChanges = [];
    let isShown = usesCardIcons;
    for (const icon of suitIcons) {
      const group = findSuitGroup(icon, tile, matchesSuit);
      const texts = group ? textElements(group).map(trimmedText) : [];
      // Native opponent rows always reserve the first text slot for the count:
      // blank in concealed play, numeric when Learning exposes their hands.
      const countText = texts[0] ?? '';
      if (countText !== '') isShown = true;
      counts.push(wholeNumber(countText));
      const netChange = texts.slice(1).find((text) => SIGNED_NUMBER.test(text));
      netChanges.push(netChange ? Number(netChange) : 0);
    }
    return {
      usesCardIcons,
      hasEveryCardIcon: cardIcons.every(Boolean),
      isShown,
      counts,
      netChanges,
      isComplete: counts.every(isSuitCount),
    };
  }

  // Finds the box that holds one suit's icon together with its texts. The
  // climb stops at the tile, and gives up once a second suit comes into view:
  // the icon then has no text of its own.
  function findSuitGroup(icon, tile, matchesSuit) {
    let element = icon?.parentElement;
    for (let depth = 0; element && element !== tile && depth < MAX_SUIT_GROUP_DEPTH; depth++) {
      const icons = Array.from(element.querySelectorAll('svg'));
      const suitsInView = SUITS.filter((suit) => icons.some((svg) => matchesSuit(svg, suit)));
      if (suitsInView.length > 1) return null;
      if (element.querySelector(TEXT_SELECTOR)) return element;
      element = element.parentElement;
    }
    return null;
  }

  // In ordinary play only your own tile shows a hand. A second hand drawn as
  // cards, or a count in a tile's suit rows, means other hands are on display.
  function showsOtherHands(seats) {
    const cardHands = seats.filter((seat) => seat.hand.usesCardIcons);
    return (
      cardHands.length > 1 || seats.some((seat) => !seat.hand.usesCardIcons && seat.hand.isShown)
    );
  }

  // ── Players ────────────────────────────────────────────────────────────

  // Your tile is the one drawn with all four card icons. If several are, prefer
  // the name identified on an earlier read of this page.
  function findSelfSeat(document, seats) {
    const candidates = seats.filter((seat) => seat.hand.hasEveryCardIcon);
    const knownSelf = selfByDocument.get(document);
    return candidates.find((seat) => seat.headerTexts[0] === knownSelf) || candidates[0];
  }

  function readOwnPosition(seat) {
    const cash = wholeNumber(seat.headerTexts.at(-1));
    if (cash === null) throw Error('Your chip balance could not be read.');
    if (!seat.hand.isComplete) throw Error('Cannot read your complete suit inventory.');
    return { self: seat.headerTexts[0], cash, held: seat.hand.counts };
  }

  // Concealed/full totals are public. Never attach opponent hand arrays to
  // players: exposed training truth lives only under snapshot.training.
  function readPlayer(seat, isSelf) {
    return {
      name: seat.headerTexts[0],
      color: getComputedStyle(seat.header).backgroundColor,
      cash: wholeNumber(seat.headerTexts.at(-1)),
      observedNet: isSelf ? null : seat.hand.netChanges,
      cards: isSelf ? sum(seat.hand.counts) : readOpponentCardCount(seat),
    };
  }

  function readOpponentCardCount(seat) {
    if (!seat.tile.querySelector(CARD_BACK_SELECTOR)) {
      return seat.hand.isComplete ? sum(seat.hand.counts) : null;
    }
    // The first two texts are the header's name and chip balance. The next
    // number is the total shown beside the card back.
    const texts = leafTexts(seat.tile);
    const total = texts.find((text, index) => index > 1 && WHOLE_NUMBER.test(text));
    return Number(total ?? NaN);
  }

  function isCompletePlayerList(players) {
    const names = new Set(players.map((player) => player.name));
    return PLAYER_COUNTS.includes(players.length) && names.size === players.length;
  }

  // A tile without a card back or readable counts shows no total. Everyone is
  // dealt the same number of cards, so the trade history supplies it.
  function fillMissingCardCounts(players, net, dealSize) {
    players.forEach((player, index) => {
      if (player.cards === null) player.cards = dealSize + sum(net[index]);
    });
  }

  // ── Trade history ──────────────────────────────────────────────────────

  // Returns the trades oldest first, in the compact shape the rest of the
  // extension records: b(uyer), s(eller), suit id, p(rice).
  function readTradeHistory(root, textNodes, names) {
    const history = findTradeHistory(root, textNodes);
    const seenRows = new Set();
    const latestFirst = [];
    for (const icon of history.querySelectorAll('svg')) {
      const suit = suitOf(icon);
      if (!suit) continue;
      const row = findTradeRow(icon, names);
      if (!row || seenRows.has(row.element)) continue;
      const [buyer, seller, priceText] = row.texts;
      const price = wholeNumber(priceText);
      const isKnownPair = names.includes(buyer) && names.includes(seller) && buyer !== seller;
      if (!isKnownPair || price === null) throw Error('Unrecognized trade history row.');
      seenRows.add(row.element);
      latestFirst.push({ b: buyer, s: seller, suit: suit.id, p: price });
    }
    return latestFirst.reverse();
  }

  // Starts at the "Buyer" column heading and grows to the largest box that
  // still holds nothing but trade history: no input, card back, or chip.
  function findTradeHistory(root, textNodes) {
    const heading = textNodes.find((node) => node.textContent === TRADE_HISTORY_HEADING);
    if (!heading) throw Error('Trade history is not available.');
    let history = heading.parentElement;
    let parent = history.parentElement;
    while (parent && parent !== root && !parent.querySelector(OUTSIDE_HISTORY_SELECTOR)) {
      history = parent;
      parent = parent.parentElement;
    }
    return history;
  }

  // A trade row is the nearest box around a suit icon that holds exactly three
  // texts: two player names (buyer, then seller) and the price.
  function findTradeRow(icon, names) {
    let texts;
    const element = closestWhere(icon.parentElement, (candidate) => {
      texts = leafTexts(candidate);
      return texts.length === 3 && names.includes(texts[0]) && names.includes(texts[1]);
    });
    return element ? { element, texts } : null;
  }

  // Cards each player has gained (+) or given up (-) per suit since the deal,
  // replayed from the trade history. Rows follow `names`, columns follow SUITS.
  function netFlow(trades, names) {
    const net = names.map(() => SUITS.map(() => 0));
    for (const trade of trades) {
      const suitIndex = suitIndexOf(trade.suit);
      net[names.indexOf(trade.b)][suitIndex]++;
      net[names.indexOf(trade.s)][suitIndex]--;
    }
    return net;
  }

  // Your dealt hand is what you hold now with your own trades undone. If that
  // is not a hand that could have been dealt, the tile and the history are out
  // of step.
  function reconstructStartingHand(held, ownNet, dealSize) {
    const startingHand = held.map((count, suitIndex) => count - ownNet[suitIndex]);
    if (!isLegalDeal(startingHand, dealSize)) {
      throw Error('Waiting for consistent hand and history; model paused.');
    }
    return startingHand;
  }

  // Opponent tiles show their own running net per suit. It must agree with the
  // trade history, or one of the two has not finished updating.
  function hasFlowMismatch(players, net) {
    return players.some((player, index) => {
      if (index === 0) return false; // Your own tile shows no net.
      return player.observedNet.some((change, suitIndex) => change !== net[index][suitIndex]);
    });
  }

  // ── Training truth (practice mode) ─────────────────────────────────────

  // Every hand is visible, so the whole deal can be reconstructed and checked.
  // Anything inconsistent is reported as invalid, with the reason, and exposes
  // no hands.
  function readTrainingTruth(players, seats, net, trades, flowMismatch) {
    if (flowMismatch) return invalidTraining('Trade history and visible player flow disagree.');
    if (seats.some((seat) => !seat.hand.isShown || !seat.hand.isComplete)) {
      return invalidTraining('Waiting for complete numeric hands for every player.');
    }
    const dealSize = DECK_SIZE / players.length;
    const hands = {};
    const startingHands = {};
    for (const [index, player] of players.entries()) {
      const hand = seats[index].hand.counts.slice();
      const dealt = hand.map((count, suitIndex) => count - net[index][suitIndex]);
      if (sum(hand) !== player.cards) {
        return invalidTraining('Visible hands and public card totals disagree.');
      }
      if (!isLegalDeal(dealt, dealSize)) {
        return invalidTraining('Visible hands do not reconstruct legal dealt hands.');
      }
      hands[player.name] = hand;
      startingHands[player.name] = dealt;
    }
    const deckTotals = suitTotals(players.map((player) => hands[player.name]));
    if (!isLegalDeck(deckTotals)) {
      return invalidTraining('Visible hands do not form a legal 40-card deck.');
    }
    if (!canReplayTrades(startingHands, trades)) {
      return invalidTraining('Visible hands conflict with the executed trade sequence.');
    }
    return {
      enabled: true,
      handsVisible: true,
      valid: true,
      source: VISIBLE_HANDS_SOURCE,
      hands,
      startingHands,
      deckTotals,
    };
  }

  // Final holdings can add up even when the history is impossible, so replay
  // it: nobody can sell a card they did not hold at that moment.
  function canReplayTrades(startingHands, trades) {
    const inventory = {};
    for (const [name, hand] of Object.entries(startingHands)) inventory[name] = hand.slice();
    for (const trade of trades) {
      const suitIndex = suitIndexOf(trade.suit);
      if (inventory[trade.s][suitIndex] < 1) return false;
      inventory[trade.s][suitIndex]--;
      inventory[trade.b][suitIndex]++;
    }
    return true;
  }

  function invalidTraining(reason) {
    return {
      enabled: true,
      handsVisible: true,
      valid: false,
      source: VISIBLE_HANDS_SOURCE,
      reason,
    };
  }

  // ── Markets ────────────────────────────────────────────────────────────

  // Returns one market per suit, plus `refs`: the live inputs and buttons of
  // each quote row, which the content script uses to act on the page.
  function readMarkets(quoteRows, players, trades, own) {
    const rowBySuit = groupQuoteRowsBySuit(quoteRows);
    const refs = new Map();
    const markets = SUITS.map((suit, index) => {
      const row = rowBySuit.get(suit.id);
      if (!row) throw Error(`Cannot identify ${suit.name} quote row.`);
      const [bidInput, askInput] = Array.from(row.querySelectorAll('input'));
      const bid = readQuoteSide(row, bidInput, BID_SIDE, players);
      const ask = readQuoteSide(row, askInput, ASK_SIDE, players);
      refs.set(suit.id, { bid, ask });
      return describeMarket(suit, bid, ask, own, own.held[index], trades);
    });
    return { markets, refs };
  }

  function groupQuoteRowsBySuit(quoteRows) {
    const rowBySuit = new Map();
    for (const row of quoteRows) {
      for (const icon of row.querySelectorAll('svg')) {
        const suit = suitOf(icon);
        if (suit && !rowBySuit.has(suit.id)) rowBySuit.set(suit.id, row);
      }
    }
    return rowBySuit;
  }

  function readQuoteSide(row, input, side, players) {
    const panel = closestWhere(input.parentElement, (element) => element.parentElement === row);
    if (!panel) throw Error('Quote layout changed.');
    const textNodes = textElements(panel);
    const prices = textNodes.map((node) => wholeNumber(trimmedText(node)));
    const price = prices.find((value) => value !== null) ?? null;
    const owner = price === null ? null : findQuoteOwner(panel, players);
    const takeLabel = textNodes.find((node) => node.textContent === side.takeLabel);
    return {
      price,
      owner,
      input,
      button: pressableAround(takeLabel),
      panel,
      quick: pressableAround(panel.querySelector(side.improveIcon)),
      cancel: pressableAround(panel.querySelector(CANCEL_ICON_SELECTOR)),
    };
  }

  // A resting quote is tinted with its owner's color, either on the panel
  // itself or on an element inside it.
  function findQuoteOwner(panel, players) {
    const tinted = [panel, ...panel.querySelectorAll('[style*="background-color"]')];
    const colors = tinted.map((element) => getComputedStyle(element).backgroundColor);
    return players.find((player) => colors.includes(player.color))?.name || null;
  }

  function pressableAround(element) {
    return element?.closest(PRESSABLE_SELECTOR);
  }

  function describeMarket(suit, bid, ask, { self, cash }, heldCount, trades) {
    return {
      ...suit,
      held: heldCount,
      bid: bid.price,
      ask: ask.price,
      buyer: bid.owner,
      seller: ask.owner,
      canSell: Boolean(bid.button && bid.owner && bid.owner !== self && heldCount > 0),
      canBuy: Boolean(ask.button && ask.owner && ask.owner !== self && cash >= ask.price),
      canBid: !bid.input.disabled,
      canOffer: !ask.input.disabled && heldCount > 0,
      canRaiseBid: Boolean(bid.quick && bid.price !== null && cash >= bid.price + 1),
      canLowerAsk: Boolean(ask.quick && ask.price > 1 && heldCount > 0),
      canCancelBid: Boolean(bid.cancel && bid.owner === self),
      canCancelOffer: Boolean(ask.cancel && ask.owner === self),
      fills: trades.filter((trade) => trade.suit === suit.id),
    };
  }

  // ── Round state ────────────────────────────────────────────────────────

  // The results screen announces itself with a heading, or with its pair of
  // "Review" and "New round" buttons.
  function hasRoundEnded(texts) {
    return (
      texts.some((text) => ROUND_ENDED_TEXT.test(text)) ||
      (texts.some((text) => REVIEW_TEXT.test(text)) &&
        texts.some((text) => NEXT_ROUND_TEXT.test(text)))
    );
  }

  function gameStatus(ended, texts) {
    if (ended) return 'ended';
    return texts.some((text) => CONNECTION_TROUBLE_TEXT.test(text)) ? 'paused' : 'live';
  }

  function readRoundNumber(texts) {
    const label = texts.find((text) => ROUND_TEXT.test(text)) || '';
    return Number(label.match(/\d+/)?.[0]);
  }

  // Consumers compare signatures to tell whether anything they act on changed.
  function signatureOf({ roundKey, cash, held, trades, roundResult, training, markets }) {
    return JSON.stringify({
      roundKey,
      cash,
      held,
      trades,
      roundResult,
      training,
      quotes: markets.map((market) => QUOTE_SIGNATURE_FIELDS.map((field) => market[field])),
    });
  }

  // ── Context ────────────────────────────────────────────────────────────

  // The bot difficulty is the last one named beside its label, when shown.
  function readContext(document) {
    const root = document.getElementById('root');
    if (!root) return {};
    const label = findByText(textElements(root), BOT_DIFFICULTY_LABEL);
    const values = label ? leafTexts(label.parentElement) : [];
    return {
      botDifficulty: values.filter((text) => BOT_DIFFICULTIES.includes(text)).at(-1) || null,
    };
  }

  // ── Round results ──────────────────────────────────────────────────────

  // Reads the result of the round described by `previous`, the last snapshot
  // of that round: the official rankings if shown, else the revealed hands.
  function readSettlement(document, previous) {
    if (!previous) return null;
    const root = document.getElementById('root');
    if (!root) return null;
    const textNodes = textElements(root);
    if (!hasRoundEnded(textNodes.map(trimmedText))) return null;
    return readRankings(document, previous) || readRevealedHands(textNodes, previous);
  }

  // Without rankings, the goal suit follows from everyone's revealed final
  // hand, provided the hands add up to a legal deck.
  function readRevealedHands(textNodes, previous) {
    const finalHands = {};
    for (const player of previous.players) {
      const tile = findRevealedTile(findByText(textNodes, player.name));
      if (!tile) return null;
      const hand = SUITS.map((suit) => readRevealedCount(tile, suit));
      if (!hand.every(isSuitCount)) return null;
      finalHands[player.name] = hand;
    }
    const deckTotals = suitTotals(Object.values(finalHands));
    if (sum(deckTotals) !== DECK_SIZE || !isLegalDeck(deckTotals)) return null;
    return {
      goal: goalSuitOf(deckTotals).id,
      finalHands,
      deckTotals,
      verified: true,
      source: REVEALED_HANDS_SOURCE,
    };
  }

  // A revealed tile is the nearest box around a player's name that holds one
  // chip and all four card icons.
  function findRevealedTile(nameNode) {
    return closestWhere(
      nameNode,
      (element) =>
        element.querySelectorAll(CHIP_SELECTOR).length === 1 &&
        SUITS.every((suit) => element.querySelector(cardIconSelector(suit))),
    );
  }

  // The count is the number that starts a text beside the suit's card icon.
  function readRevealedCount(tile, suit) {
    const startsWithCount = (text) => LEADING_COUNT.test(text);
    const icon = tile.querySelector(cardIconSelector(suit));
    const group = closestWhere(icon.parentElement, (element) =>
      leafTexts(element).some(startsWithCount),
    );
    if (!group) return NaN;
    return Number(leafTexts(group).find(startsWithCount).match(/^\d+/)[0]);
  }

  // SUITS lists same-colored suits side by side (♠♣, ♦♥), so flipping the
  // lowest bit of an index gives the other suit of that color. The goal suit
  // is the same color as the 12-card suit.
  function goalSuitOf(deckTotals) {
    return SUITS[deckTotals.indexOf(LARGEST_SUIT_SIZE) ^ 1];
  }

  // Reads the official end-of-round rankings: the goal suit and every
  // player's final bank and round profit.
  function readRankings(document, previous) {
    const root = document.getElementById('root');
    if (!root || !previous) return null;
    const textNodes = textElements(root);
    const heading = findByText(textNodes, RANKINGS_HEADING);
    const goalLabel = findByText(textNodes, GOAL_SUIT_LABEL);
    if (!heading || !goalLabel) return null;
    const panel = closestWhere(heading, (element) =>
      isRankingsPanel(element, goalLabel, previous.players),
    );
    if (!panel) return null;
    const goal = suitOf(goalLabel.parentElement.querySelector('svg'));
    if (!goal) return null;

    const panelTextNodes = textElements(panel);
    const profits = {};
    const banks = {};
    for (const player of previous.players) {
      const row = findRankingRow(panelTextNodes, player.name);
      if (!row) return null;
      const [, bank, profit] = leafTexts(row);
      banks[player.name] = Number(bank);
      profits[player.name] = Number(profit);
    }
    if (Math.abs(sum(Object.values(profits))) > PROFIT_SUM_TOLERANCE) return null;
    return {
      goal: goal.id,
      settledProfit: profits[previous.self],
      settledBank: banks[previous.self],
      profits,
      banks,
      verified: true,
      source: RANKINGS_SOURCE,
    };
  }

  // The rankings panel holds the goal suit and one chip and name per player.
  function isRankingsPanel(element, goalLabel, players) {
    if (!element.contains(goalLabel)) return false;
    if (element.querySelectorAll(CHIP_SELECTOR).length !== players.length) return false;
    const texts = leafTexts(element);
    return players.every((player) => texts.includes(player.name));
  }

  // A ranking row holds one chip and exactly three texts: the player's name,
  // final bank, and round profit. The name must appear once in the panel.
  function findRankingRow(panelTextNodes, name) {
    const nameNodes = panelTextNodes.filter((node) => trimmedText(node) === name);
    if (nameNodes.length !== 1) return null;
    return closestWhere(nameNodes[0], (element) => {
      const texts = leafTexts(element);
      return (
        element.querySelectorAll(CHIP_SELECTOR).length === 1 &&
        texts.length === 3 &&
        texts[0] === name &&
        BANK_TEXT.test(texts[1]) &&
        PROFIT_TEXT.test(texts[2])
      );
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function textElements(container) {
    return Array.from(container.querySelectorAll(TEXT_SELECTOR));
  }

  function trimmedText(element) {
    return element.textContent.trim();
  }

  function findByText(elements, text) {
    return elements.find((element) => trimmedText(element) === text);
  }

  // The non-empty texts inside a container, in document order. Inputs are
  // marked like text but hold none, so they are skipped.
  function leafTexts(container) {
    return textElements(container)
      .filter((element) => element.tagName !== 'INPUT')
      .map(trimmedText)
      .filter(Boolean);
  }

  // Like Element.closest, but with a predicate: returns `start` or its nearest
  // ancestor that satisfies it, looking at no more than MAX_ANCESTOR_DEPTH elements.
  function closestWhere(start, predicate) {
    let element = start;
    for (let depth = 0; element && depth < MAX_ANCESTOR_DEPTH; depth++) {
      if (predicate(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function hasIdPrefix(element, prefix) {
    return (element.id || '').startsWith(prefix);
  }

  function isCardIcon(icon, suit) {
    return hasIdPrefix(icon, suit.card);
  }

  function isSuitIcon(icon, suit) {
    return icon.getAttribute('viewBox') === suit.viewBox;
  }

  function cardIconSelector(suit) {
    return `svg[id^="${suit.card}"]`;
  }

  function suitOf(icon) {
    return SUITS.find((suit) => isSuitIcon(icon, suit));
  }

  // Hands, net flows, and deck totals are arrays in SUITS order.
  function suitIndexOf(id) {
    return SUITS.findIndex((suit) => suit.id === id);
  }

  function suitTotals(hands) {
    return SUITS.map((_, suitIndex) => sum(hands.map((hand) => hand[suitIndex])));
  }

  // Parses a count, price, or chip balance. Anything else is null.
  function wholeNumber(text) {
    return WHOLE_NUMBER.test(text || '') ? Number(text) : null;
  }

  // Nobody can hold more cards of a suit than the largest suit has.
  function isSuitCount(value) {
    return Number.isInteger(value) && value >= 0 && value <= LARGEST_SUIT_SIZE;
  }

  function isLegalDeal(hand, dealSize) {
    return hand.every(isSuitCount) && sum(hand) === dealSize;
  }

  function isLegalDeck(deckTotals) {
    const ascending = deckTotals.slice().sort((a, b) => a - b);
    return ascending.join(',') === SUIT_SIZES.join(',');
  }

  function sum(values) {
    return values.reduce((total, value) => total + value, 0);
  }

  function unique(items) {
    return [...new Set(items)];
  }

  scope.FiggieAdapter = { read, SUITS, readContext, readSettlement, readRankings };
  if (typeof module !== 'undefined') module.exports = scope.FiggieAdapter;
})(globalThis);
