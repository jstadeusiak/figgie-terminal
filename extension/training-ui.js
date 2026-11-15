/*
 * Learning lab: the practice panel offered when a round exposes every player's hand.
 *
 * The player locks a goal prediction, then peeks at hands one at a time and compares
 * the prediction with the blind trading model and the exact deal odds. Each locked
 * prediction is a frozen checkpoint: later game updates never rewrite it.
 *
 * Learning checkpoints are separate from the live, concealed-hand trading model.
 */
(() => {
  'use strict';

  const SUIT_IDS = ['s', 'c', 'd', 'h'];
  const SUIT_NAMES = ['Spades', 'Clubs', 'Diamonds', 'Hearts'];
  const SUIT_GLYPHS = ['♠', '♣', '♦', '♥'];
  const FIRST_RED_SUIT_INDEX = 2;

  const DEFAULT_PROBABILITY_PERCENT = 25;
  const PROBABILITY_TOTAL_PERCENT = 100;
  const PROBABILITY_TOTAL_TOLERANCE_PERCENT = 0.01;
  // One suit has 12 cards in every deal; the goal is the other suit of the same color.
  const LONG_SUIT_CARDS = 12;

  const FALLBACK_PLAYER_COLOR = '#9aacb1';
  const SAFE_COLOR = /(^#[\da-f]{3,8}$)|(^rgba?\(\s*[\d.,%\s]+\)$)/i;
  const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const FOCUSABLE = 'button,input,select,textarea,summary,[tabindex]';
  const TEXT_ENTRY = 'input,textarea,select';
  const TRADE_HOTKEY = /^[1-8]$/;

  // ── Formatting ─────────────────────────────────────────────────────────

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
  const percent = (probability) =>
    Number.isFinite(probability) ? (100 * probability).toFixed(1) + '%' : '—';
  const deepCopy = (value) => JSON.parse(JSON.stringify(value));
  const totalLabel = (totalPercent) => `Total ${totalPercent.toFixed(1)}% · must equal 100%`;

  function signedChips(amount) {
    if (!Number.isFinite(amount)) return '—';
    return (amount < 0 ? '−' : '+') + Math.abs(amount).toFixed(2);
  }

  function suitGlyph(suitIndex) {
    const color = suitIndex >= FIRST_RED_SUIT_INDEX ? 'ff-suit-red' : '';
    return `<span class="ff-learn-suit ${color}">${SUIT_GLYPHS[suitIndex]}</span>`;
  }

  const percentCells = (probabilities) =>
    probabilities.map((probability) => `<td>${percent(probability)}</td>`).join('');
  const disabledIf = (condition) => (condition ? 'disabled' : '');

  function playerBadge(checkpoint, name) {
    const color = (checkpoint?.colors || {})[name];
    const background = SAFE_COLOR.test(color || '') ? color : FALLBACK_PLAYER_COLOR;
    const label = name === checkpoint?.self ? 'You' : name;
    return (
      `<span class="ff-learn-player"><i style="background:${background}"></i>` +
      `${escapeHtml(label)}</span>`
    );
  }

  // Squared error against the outcome that happened; lower is better.
  function brierLoss(probabilities, goalIndex) {
    return probabilities.reduce(
      (loss, probability, suitIndex) => loss + (probability - Number(suitIndex === goalIndex)) ** 2,
      0,
    );
  }

  // ── Dialog shell ───────────────────────────────────────────────────────

  const DIALOG_MARKUP = [
    '<section class="ff-learning-dialog" role="dialog" aria-modal="true"' +
      ' aria-labelledby="ff-learning-title" tabindex="-1">',
    '<header>',
    '<div><span class="ff-learn-eyebrow">LEARNING · SHOW CARDS</span>' +
      '<h2 id="ff-learning-title">Predict → Peek → Continue</h2></div>',
    '<button type="button" data-learn="close" aria-label="Close learning lab">×</button>',
    '</header>',
    '<div class="ff-learn-clock">The game clock keeps running.' +
      ' Trade shortcuts are off while this panel is open.</div>',
    '<div id="ff-learn-body"></div>',
    '<footer><span id="ff-learn-live" role="status"></span>' +
      '<button type="button" data-learn="continue">Continue playing</button></footer>',
    '</section>',
  ].join('');

  function createLaunchButton() {
    const launch = document.createElement('button');
    launch.id = 'ff-learning';
    launch.type = 'button';
    launch.textContent = 'Learning lab';
    launch.hidden = true;
    return launch;
  }

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'ff-learning-overlay';
    overlay.hidden = true;
    overlay.innerHTML = DIALOG_MARKUP;
    return overlay;
  }

  // ── Step 1: prediction form ────────────────────────────────────────────

  function predictionMarkup(opponents, peeked) {
    const timing = peeked ? 'After a peek · practice only' : 'Before your first terminal peek';
    const peekWarning = peeked
      ? '<p class="ff-learn-warning">You have already seen another hand this round.' +
        ' These predictions are for practice, not blind accuracy.</p>'
      : '';
    const initialTotal = totalLabel(SUIT_NAMES.length * DEFAULT_PROBABILITY_PERCENT);
    return [
      `<div class="ff-learn-step"><b>1 · Make your prediction</b><span>${timing}</span></div>`,
      '<p>Assign the chance that each suit is the goal.' +
        ' Think about your deal, who is accumulating, and who is willing to sell.</p>',
      peekWarning,
      '<form id="ff-learn-form">',
      `<div class="ff-learn-prob-inputs">${SUIT_NAMES.map(probabilityInput).join('')}</div>`,
      `<div class="ff-learn-total" id="ff-learn-total">${initialTotal}</div>`,
      inventoryGuessFields(opponents),
      '<label class="ff-learn-reason">What is your read? <span>Optional</span>' +
        '<textarea id="ff-learn-reason" rows="2" maxlength="500"' +
        ' placeholder="Who is buying, and what might their starting hand suggest?"></textarea>' +
        '</label>',
      '<div class="ff-learn-save">' +
        '<button type="submit" data-learn="save">Lock prediction & compare</button>' +
        '<span id="ff-learn-availability"></span></div>',
      '<div id="ff-learn-error" role="alert"></div>',
      '</form>',
      '<p class="ff-learn-small">The main terminal keeps using your hand and public trading only.' +
        ' Revealed hands never feed the normal model.' +
        ' Learning recordings are excluded from normal calibration.</p>',
    ].join('');
  }

  function probabilityInput(suitName, suitIndex) {
    return (
      `<label>${suitGlyph(suitIndex)} ${suitName}<span>` +
      `<input type="number" min="0" max="100" step="0.1" value="${DEFAULT_PROBABILITY_PERCENT}"` +
      ` data-prob="${suitIndex}" aria-label="${suitName} goal probability percent" required>` +
      ' %</span></label>'
    );
  }

  function inventoryGuessFields(opponents) {
    const playerOptions = opponents
      .map(({ name }) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join('');
    const suitOptions = SUIT_NAMES.map(
      (suitName, suitIndex) =>
        `<option value="${suitIndex}">${SUIT_GLYPHS[suitIndex]} ${suitName}</option>`,
    ).join('');
    return [
      '<details class="ff-learn-guess">',
      '<summary>Optional: predict an opponent’s inventory</summary>',
      '<div class="ff-learn-guess-fields">',
      `<label>Player<select id="ff-learn-opponent">${playerOptions}</select></label>`,
      `<label>Suit<select id="ff-learn-suit">${suitOptions}</select></label>`,
      '<label>Cards now<input id="ff-learn-count" type="number" min="0" max="12" step="1"' +
        ' placeholder="0–12"></label>',
      '</div>',
      '</details>',
    ].join('');
  }

  // A checkpoint freezes everything the comparison needs, so the review cannot drift as
  // the live game moves on. `truth` holds the revealed hands and never leaves this panel.
  function createCheckpoint({ snapshot, model }, prediction, afterPeek) {
    return {
      at: Date.now(),
      roundKey: snapshot.roundKey,
      sourceRevision: snapshot.analysisRevision,
      tradeCount: snapshot.trades.length,
      timer: snapshot.timer,
      self: snapshot.self,
      userProbabilities: prediction.probabilities,
      blindProbabilities: model.bySuit.map((suit) => suit.probability),
      modelVersion: model.version,
      opponentGuess: prediction.opponentGuess,
      reason: prediction.reason,
      afterPeek,
      truth: deepCopy(model.training),
      blind: deepCopy({
        bySuit: model.bySuit,
        expectedPayout: model.expectedPayout,
        expectedBonus: model.expectedBonus,
      }),
      markets: snapshot.markets.map((market) => ({
        id: market.id,
        bid: market.bid,
        ask: market.ask,
        buyer: market.buyer,
        seller: market.seller,
        canBuy: market.canBuy,
        canSell: market.canSell,
      })),
      colors: Object.fromEntries(snapshot.players.map((player) => [player.name, player.color])),
    };
  }

  // ── Step 2: peek and compare ───────────────────────────────────────────

  function comparisonMarkup(checkpoint, revealed) {
    const truth = checkpoint.truth;
    const allRevealed = truth.players.every((player) => revealed.has(player.name));
    const goalIndex = SUIT_IDS.indexOf(truth.exactGoal);
    const timing = checkpoint.afterPeek ? 'After-peek practice' : 'Prediction locked';
    const timeLeft = `${escapeHtml(checkpoint.timer)} remaining`;
    return [
      '<div class="ff-learn-step"><b>2 · Peek & compare</b>' +
        `<span>${timing} · trade #${checkpoint.tradeCount} · ${timeLeft}</span></div>`,
      '<p class="ff-learn-small">This checkpoint is frozen.' +
        ' Reveal one player at a time to see how the deal probabilities change.</p>',
      revealButtons(checkpoint, revealed, allRevealed),
      goalProbabilityTable(checkpoint, revealed, allRevealed),
      '<p class="ff-learn-small">The revealed-hands row is an exact calculation under the deal' +
        ' rules using only those starting hands. It excludes trading signals.' +
        ' With all hands, the goal is certain.</p>',
      allRevealed ? brierScores(checkpoint, goalIndex) : '',
      revealedHandsTable(checkpoint, revealed),
      '<p class="ff-learn-small">Each row uses only that player’s starting hand.' +
        ' These are possible beliefs under the deal rules,' +
        ' not their actual thoughts or bot policy.</p>',
      inventoryGuessFeedback(checkpoint, revealed),
      allRevealed ? settlementMarkup(checkpoint) : '',
      reflectionMarkup(checkpoint, allRevealed, goalIndex),
      '<button type="button" data-learn="new">New checkpoint</button>',
    ].join('');
  }

  function revealButtons(checkpoint, revealed, allRevealed) {
    const peekButtons = checkpoint.truth.players
      .filter((player) => player.name !== checkpoint.self)
      .map(({ name }) => {
        const isRevealed = revealed.has(name);
        return (
          `<button type="button" data-reveal="${escapeHtml(name)}" ${disabledIf(isRevealed)}>` +
          `${playerBadge(checkpoint, name)} ${isRevealed ? 'revealed' : '· Peek'}</button>`
        );
      })
      .join('');
    return (
      `<div class="ff-learn-reveals">${peekButtons}` +
      `<button type="button" data-learn="all" ${disabledIf(allRevealed)}>Reveal all</button>` +
      '</div>'
    );
  }

  // Exact goal odds given the starting hands revealed so far. The model precomputes one
  // entry per combination of revealed players, keyed by a bit mask over the player order.
  function revealedHandOdds(truth, revealed, allRevealed) {
    const mask = truth.players.reduce(
      (bits, player, playerIndex) => bits + (revealed.has(player.name) ? 2 ** playerIndex : 0),
      0,
    );
    const known = truth.knownHandSets?.[mask];
    if (known?.probabilities) return known.probabilities;
    if (revealed.size === 1) return truth.probabilityTable.selfHand;
    return allRevealed ? truth.exactProbabilities : null;
  }

  function goalProbabilityTable(checkpoint, revealed, allRevealed) {
    const truth = checkpoint.truth;
    const odds = revealedHandOdds(truth, revealed, allRevealed);
    const suitHeadings = SUIT_NAMES.map(
      (suitName, suitIndex) => `<th>${suitGlyph(suitIndex)} ${suitName}</th>`,
    ).join('');
    const actualGoalRow = allRevealed
      ? '<tr class="ff-learn-actual"><th>Actual goal</th>' +
        `${percentCells(truth.exactProbabilities)}</tr>`
      : '';
    return [
      '<div class="ff-learn-scroll"><table class="ff-learn-table">',
      '<caption>Goal probabilities</caption>',
      `<thead><tr><th>Source</th>${suitHeadings}</tr></thead>`,
      '<tbody>',
      `<tr><th>Your prediction</th>${percentCells(checkpoint.userProbabilities)}</tr>`,
      `<tr><th>Blind trading model</th>${percentCells(checkpoint.blindProbabilities)}</tr>`,
      `<tr class="ff-learn-known"><th>Your hand + ${revealed.size - 1} revealed</th>` +
        `${percentCells(SUIT_NAMES.map((_, suitIndex) => odds?.[suitIndex]))}</tr>`,
      actualGoalRow,
      '</tbody>',
      '</table></div>',
    ].join('');
  }

  function brierScores(checkpoint, goalIndex) {
    const yours = brierLoss(checkpoint.userProbabilities, goalIndex).toFixed(3);
    const models = brierLoss(checkpoint.blindProbabilities, goalIndex).toFixed(3);
    return (
      '<div class="ff-learn-score">' +
      `<b>Actual goal ${suitGlyph(goalIndex)} ${SUIT_NAMES[goalIndex]}</b>` +
      `<span>Brier loss · yours ${yours} · model ${models}` +
      '<small>Lower is better. One outcome does not establish calibration.</small></span>' +
      '</div>'
    );
  }

  function revealedHandsTable(checkpoint, revealed) {
    const oddsHeadings = SUIT_NAMES.map(
      (_, suitIndex) => `<th>${suitGlyph(suitIndex)} odds</th>`,
    ).join('');
    const rows = checkpoint.truth.players
      .filter((player) => revealed.has(player.name))
      .map(
        (player) =>
          `<tr><th>${playerBadge(checkpoint, player.name)}</th>` +
          `<td><span>${player.startingHand.join(' · ')}</span><br>` +
          `<b>${player.currentHand.join(' · ')}</b></td>` +
          `${percentCells(player.handOdds)}</tr>`,
      )
      .join('');
    return [
      '<div class="ff-learn-scroll"><table class="ff-learn-table ff-learn-hands">',
      '<caption>What each player could infer from their own deal</caption>',
      '<thead><tr><th>Player</th><th>Dealt / now<br>♠ · ♣ · ♦ · ♥</th>' +
        `${oddsHeadings}</tr></thead>`,
      `<tbody>${rows}</tbody>`,
      '</table></div>',
    ].join('');
  }

  function inventoryGuessFeedback(checkpoint, revealed) {
    const guess = checkpoint.opponentGuess;
    if (!guess || !revealed.has(guess.name)) return '';
    const opponent = checkpoint.truth.players.find((player) => player.name === guess.name);
    const suitIndex = SUIT_IDS.indexOf(guess.suit);
    return (
      '<p class="ff-learn-feedback">Inventory check: ' +
      `${playerBadge(checkpoint, guess.name)} ${suitGlyph(suitIndex)} — ` +
      `you guessed <b>${guess.count}</b>; ` +
      `actually <b>${opponent.currentHand[suitIndex]}</b> at this checkpoint.</p>`
    );
  }

  function settlementMarkup(checkpoint) {
    const { settlement, roundPnl, bySuit } = checkpoint.truth;
    const pnlClass = roundPnl.settleNowPnl >= 0 ? 'ff-positive' : 'ff-negative';
    const bonusVerb = settlement.tieCount > 1 ? 'split' : 'gets';
    const tradeRows = bySuit
      .map((exact, suitIndex) => frozenTradeRow(checkpoint, exact, suitIndex))
      .join('');
    return [
      '<div class="ff-learn-payoff">',
      '<div><span>Your exact net P&L · settle now</span>' +
        `<strong class="${pnlClass}">${signedChips(roundPnl.settleNowPnl)}</strong>` +
        `<small>Trading cash ${signedChips(roundPnl.netCash)}` +
        ` + payout ${settlement.total.toFixed(2)}` +
        ` − ante ${roundPnl.ante.toFixed(2)}</small></div>`,
      '<div><span>Leader bonus</span>' +
        `<strong>${settlement.bonus.toFixed(2)}</strong>` +
        `<small>${escapeHtml(settlement.leaders.join(' + '))} ${bonusVerb}` +
        ` the ${settlement.bonusPool}-chip pool.` +
        ` Your base payout: ${settlement.base.toFixed(2)}.</small></div>`,
      '</div>',
      '<div class="ff-learn-scroll"><table class="ff-learn-table">',
      '<caption>One-card trades at the checkpoint · model / exact gain</caption>',
      '<thead><tr><th>Suit</th>' +
        '<th>Buy at ask<br><small>Blind / exact</small></th>' +
        '<th>Sell at bid<br><small>Blind / exact</small></th></tr></thead>',
      `<tbody>${tradeRows}</tbody>`,
      '</table></div>',
      '<p class="ff-learn-small">Exact gains include the price and the bonus change caused by' +
        ' that transfer. They assume immediate settlement, with no later trades.' +
        ' These frozen quotes are for study, not live order buttons.</p>',
    ].join('');
  }

  // Blind gain is what the trading model expected; exact gain uses the revealed hands.
  function frozenTradeRow(checkpoint, exact, suitIndex) {
    const market = checkpoint.markets[suitIndex];
    const counterparties = checkpoint.blind.bySuit[suitIndex].counterparties;
    const buyValue = counterparties?.[market.seller]?.buy;
    const sellValue = counterparties?.[market.buyer]?.sell;
    const blindBuyGain = Number.isFinite(buyValue) ? buyValue - market.ask : null;
    const blindSellGain = Number.isFinite(sellValue) ? market.bid - sellValue : null;
    const buyCell = market.canBuy
      ? `${signedChips(blindBuyGain)} / <b>${signedChips(exact.buyEdge)}</b>` +
        `<small>From ${escapeHtml(market.seller)} @ ${market.ask}</small>`
      : '—';
    const sellCell = market.canSell
      ? `${signedChips(blindSellGain)} / <b>${signedChips(exact.sellEdge)}</b>` +
        `<small>To ${escapeHtml(market.buyer)} @ ${market.bid}</small>`
      : '—';
    return (
      `<tr><th>${suitGlyph(suitIndex)} ${SUIT_NAMES[suitIndex]}</th>` +
      `<td>${buyCell}</td><td>${sellCell}</td></tr>`
    );
  }

  function reflectionMarkup(checkpoint, allRevealed, goalIndex) {
    const pattern = allRevealed
      ? lessonText(checkpoint, goalIndex)
      : 'Before revealing the next player:' +
        ' use their net purchases and sales to guess their current holdings.' +
        ' Then compare their starting hand’s odds with the direction they traded.';
    const { reason } = checkpoint;
    const read = reason ? `<p>Your read: “${escapeHtml(reason)}”</p>` : '';
    return `<div class="ff-learn-reflect"><b>Pattern to practice</b><p>${pattern}</p>${read}</div>`;
  }

  function lessonText(checkpoint, goalIndex) {
    const truth = checkpoint.truth;
    const longSuitIndex = truth.deckTotals.indexOf(LONG_SUIT_CARDS);
    const self = truth.players.find((player) => player.name === checkpoint.self);
    const leaders = truth.settlement.leaders;
    const leadership = leaders.length > 1 ? 'are tied for the lead' : 'is the leader';
    return [
      `${SUIT_NAMES[longSuitIndex]} has ${LONG_SUIT_CARDS} cards across the table,` +
        ` so the other suit of that color, ${SUIT_NAMES[goalIndex]}, is the goal.`,
      `You hold ${self.currentHand[goalIndex]} goal cards.`,
      `${escapeHtml(leaders.join(' and '))} ${leadership}.`,
      'Compare a trade’s base-card value with its bonus change:' +
        ' buying from the leader can change both inventories at once.',
      'After a full peek, the goal is known for the rest of this round.',
    ].join(' ');
  }

  // ── Panel ──────────────────────────────────────────────────────────────

  function mount(shadow, options) {
    const send = options.send;
    const root = shadow.getElementById('figgie-fast');
    const launch = createLaunchButton();
    root.querySelector('.ff-header').insertBefore(launch, shadow.getElementById('show-figgie'));
    const overlay = createOverlay();
    root.append(overlay);
    const body = overlay.querySelector('#ff-learn-body');
    const dialog = overlay.querySelector('[role=dialog]');
    const liveNote = overlay.querySelector('#ff-learn-live');

    // The most recent { snapshot, model, fresh, live } pushed by the terminal.
    let latest = null;
    // Round facts. They reset when the round key changes.
    let roundKey = null;
    let practiceRound = false;
    let peeked = false;
    // The locked prediction under review, and the players whose hands are showing.
    let checkpoint = null;
    let revealed = new Set();
    let focusBeforeOpen = null;

    const emit = (kind, data) => send({ type: 'training-event', kind, data });

    // A checkpoint needs visible hands and a model computed from exactly this snapshot.
    const readyToCapture = () =>
      latest?.fresh &&
      latest?.live &&
      latest.model?.training?.available &&
      latest.model.training.roundKey === latest.snapshot.roundKey &&
      latest.model.training.asOfTradeCount === latest.snapshot.trades.length;

    function sourceLabel() {
      if (latest.snapshot.status === 'ended') return 'Round ended';
      return latest.live ? 'Live game' : 'Source paused';
    }

    function updateStatus() {
      if (!latest || overlay.hidden) return;
      const { round, timer } = latest.snapshot;
      const reviewing = checkpoint ? ' · Reviewing trade #' + checkpoint.tradeCount : '';
      liveNote.textContent = `R${round} · ${timer} · ${sourceLabel()}${reviewing}`;
      const save = body.querySelector('[data-learn="save"]');
      if (save) save.disabled = !readyToCapture();
      const availability = body.querySelector('#ff-learn-availability');
      if (availability) {
        availability.textContent = readyToCapture()
          ? 'Ready to capture this decision.'
          : latest.model?.training?.reason ||
            'Waiting for complete visible hands and a current model.';
      }
    }

    function showPredictionForm() {
      checkpoint = null;
      revealed.clear();
      const players = latest?.snapshot.players || [];
      const opponents = players.filter((player) => player.name !== latest.snapshot.self);
      body.innerHTML = predictionMarkup(opponents, peeked);
      updateStatus();
    }

    function showComparison() {
      if (!checkpoint) return;
      body.innerHTML = comparisonMarkup(checkpoint, revealed);
      updateStatus();
    }

    // Returns null, after explaining why in the form, when the entries are not usable.
    function readPredictionForm() {
      const error = body.querySelector('#ff-learn-error');
      const inputs = [...body.querySelectorAll('[data-prob]')];
      const percentages = inputs.map((input) => Number(input.value));
      const total = percentages.reduce((sum, value) => sum + value, 0);
      const incomplete = inputs.some((input) => input.value === '' || !input.checkValidity());
      const offTotal =
        Math.abs(total - PROBABILITY_TOTAL_PERCENT) > PROBABILITY_TOTAL_TOLERANCE_PERCENT;
      if (incomplete || offTotal) {
        error.textContent = 'Enter four probabilities between 0 and 100 that total 100%.';
        return null;
      }
      const count = body.querySelector('#ff-learn-count');
      const opponentGuess =
        count.value === ''
          ? null
          : {
              name: body.querySelector('#ff-learn-opponent').value,
              suit: SUIT_IDS[Number(body.querySelector('#ff-learn-suit').value)],
              count: Number(count.value),
            };
      if (opponentGuess && !count.checkValidity()) {
        error.textContent = 'Use a whole-card inventory guess from 0 to 12.';
        return null;
      }
      return {
        probabilities: percentages.map((value) => value / total),
        opponentGuess,
        reason: body.querySelector('#ff-learn-reason').value.trim(),
      };
    }

    function lockPrediction(event) {
      event?.preventDefault();
      if (!readyToCapture()) return updateStatus();
      const prediction = readPredictionForm();
      if (!prediction) return;
      checkpoint = createCheckpoint(latest, prediction, peeked);
      revealed = new Set([latest.snapshot.self]);
      // Only the prediction is recorded; revealed hands and display data stay in this panel.
      const { truth, blind, markets, colors, self, ...data } = checkpoint;
      emit('training_prediction', data);
      showComparison();
      body.querySelector('[data-learn="all"]')?.focus();
    }

    function reveal(names) {
      if (!checkpoint) return;
      for (const name of names) revealed.add(name);
      peeked = true;
      emit('training_peek', {
        roundKey,
        checkpointAt: checkpoint.at,
        tradeCount: checkpoint.tradeCount,
        revealedPlayers: [...revealed],
        fullyRevealed: checkpoint.truth.players.every((player) => revealed.has(player.name)),
      });
      showComparison();
    }

    function openDialog() {
      focusBeforeOpen = shadow.activeElement;
      overlay.hidden = false;
      root.classList.add('ff-learning-open');
      if (checkpoint) {
        showComparison();
      } else {
        showPredictionForm();
      }
      dialog.focus();
    }

    function closeDialog() {
      if (overlay.hidden) return;
      emit('training_continue', {
        roundKey,
        checkpointAt: checkpoint?.at || null,
        afterPeek: peeked,
      });
      overlay.hidden = true;
      root.classList.remove('ff-learning-open');
      if (focusBeforeOpen?.isConnected) {
        focusBeforeOpen.focus();
      } else {
        launch.focus();
      }
    }

    function focusableElements() {
      return [...overlay.querySelectorAll(FOCUSABLE)].filter((element) => {
        const details = element.closest('details');
        const inClosedDetails = details && element.tagName !== 'SUMMARY' && !details.open;
        return !element.disabled && !element.closest('[hidden]') && !inClosedDetails;
      });
    }

    // Tab order wraps around inside the dialog.
    function nextFocusTarget(backward) {
      const elements = focusableElements();
      const current = elements.indexOf(shadow.activeElement);
      const previous = current <= 0 ? elements.length - 1 : current - 1;
      const next = (current + 1) % elements.length;
      return elements[backward ? previous : next];
    }

    function onSubmit(event) {
      if (event.target.id === 'ff-learn-form') lockPrediction(event);
    }

    function onInput(event) {
      if (!event.target.matches('[data-prob]')) return;
      const total = [...body.querySelectorAll('[data-prob]')].reduce(
        (sum, input) => sum + Number(input.value),
        0,
      );
      body.querySelector('#ff-learn-total').textContent = totalLabel(total);
    }

    function onClick(event) {
      const revealButton = event.target.closest('[data-reveal]');
      if (revealButton && !revealButton.disabled) return reveal([revealButton.dataset.reveal]);
      const button = event.target.closest('[data-learn]');
      if (!button || button.disabled) return;
      const action = button.dataset.learn;
      if (['close', 'continue'].includes(action)) closeDialog();
      if (action === 'all') reveal(checkpoint.truth.players.map((player) => player.name));
      if (action === 'new') {
        showPredictionForm();
        body.querySelector('input')?.focus();
      }
    }

    // Trap focus and all native trading hotkeys while the learning dialog is open.
    function onKeydown(event) {
      if (overlay.hidden || shadow.host.style.display === 'none') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeDialog();
        return;
      }
      if (event.key === 'Tab') {
        const target = nextFocusTarget(event.shiftKey);
        event.preventDefault();
        event.stopImmediatePropagation();
        target?.focus();
        return;
      }
      if (TRADE_HOTKEY.test(event.key)) {
        const editing = event.composedPath().some((node) => node?.matches?.(TEXT_ENTRY));
        if (!editing) event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    launch.addEventListener('click', openDialog);
    overlay.addEventListener('submit', onSubmit);
    overlay.addEventListener('input', onInput);
    overlay.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown, true);

    return {
      isOpen: () => !overlay.hidden,
      hasPeeked: () => peeked,
      update(snapshot, model, state = {}) {
        if (!snapshot) return;
        if (roundKey !== snapshot.roundKey) {
          if (!overlay.hidden) closeDialog();
          roundKey = snapshot.roundKey;
          checkpoint = null;
          revealed.clear();
          peeked = false;
          practiceRound = false;
        }
        latest = { snapshot, model, ...state };
        practiceRound = practiceRound || Boolean(snapshot.training?.enabled);
        launch.hidden = !practiceRound;
        updateStatus();
      },
      // Restores the round's practice markers from the journal, e.g. after a worker restart.
      recording(recording) {
        if (recording.roundKey && recording.roundKey !== roundKey) return;
        practiceRound = practiceRound || Boolean(recording.practice);
        peeked = peeked || Boolean(recording.practicePeeked);
        launch.hidden = !practiceRound;
      },
    };
  }

  globalThis.FiggieTrainingUI = { mount };
})();
