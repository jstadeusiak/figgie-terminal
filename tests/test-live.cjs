const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const folder = 'extension/';
const { inferFiggie } = require('./reference-model.js');
const { setup, names, colors, ids, cards, boxes, text, icon } = require('./figgie-fixture.cjs');
const dom = setup();
const read = () => dom.window.FiggieAdapter.read(dom.window.document);
const snapshot = read();
assert.equal(snapshot.status, 'live');
assert.equal(snapshot.self, 'Alice');
assert.equal(snapshot.cash, 299);
assert.deepEqual(Array.from(snapshot.held), [3, 4, 4, 0]);
assert.deepEqual(Array.from(snapshot.startingHand), [2, 4, 4, 0]);
assert.equal(snapshot.trades.length, 1);
assert.equal(snapshot.markets[0].seller, 'Bot-Cougar');
assert.equal(snapshot.markets[0].buyer, 'Bot-Moth');
assert.equal(snapshot.markets[0].canBuy, true);
assert.equal(snapshot.markets[0].canSell, true);
assert.equal(snapshot.markets[3].canOffer, false);
// Equal-price repeated trades are separate events, and missing histories fail reconciliation.
const rows = dom.window.document.getElementById('history-rows');
rows.append(rows.firstElementChild.cloneNode(true));
assert.throws(read, /flow disagree|consistent hand/);
rows.lastElementChild.remove();
const model = inferFiggie(snapshot.markets, { hand: snapshot.startingHand, players: names });
assert(Math.abs(model.bySuit.reduce((n, s) => n + s.probability, 0) - 1) < 1e-9);
assert.equal(model.mode, 'Exact');
assert.deepEqual(Array.from(model.currentInventory), [3, 4, 4, 0]);
const fiveNames = ['Alice', 'B', 'C', 'D', 'E'];
const five = ids.map((id) => ({ id, buyer: 'B', seller: 'C', fills: [] }));
const fiveModel = inferFiggie(five, { hand: [2, 2, 2, 2], players: fiveNames });
assert.equal(fiveModel.mode, 'Sampled');
assert.equal(fiveModel.stateCount, 8000);
assert(fiveModel.bySuit.every((s) => Math.abs(s.probability - 0.25) < 0.025));
// Counterparty prices remain identical when opponent rows are permuted.
const permutedNames = [names[0], names[2], names[1], names[3]];
const permuted = inferFiggie(snapshot.markets, {
  hand: snapshot.startingHand,
  players: permutedNames,
});
model.bySuit.forEach((s, i) => {
  for (const name of names.slice(1)) {
    for (const side of ['buy', 'sell'])
      assert(
        Math.abs(s.counterparties[name][side] - permuted.bySuit[i].counterparties[name][side]) <
          1e-7,
      );
  }
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const win = dom.window;
  const doc = win.document;
  win.ResizeObserver = class {
    observe() {}
  };
  let modelJobs = 0;
  win.chrome = {
    runtime: {
      id: 'testextension',
      sendMessage(message, reply) {
        if (message.type !== 'figgie-model') {
          reply?.({
            recording: {
              events: 1,
              pendingEvents: 0,
              observedRevision: Math.max(
                0,
                ...(message.batch || []).map((x) => x.snapshot?.analysisRevision || 0),
              ),
            },
          });
          return;
        }
        modelJobs++;
        setTimeout(() => {
          try {
            reply({
              id: message.job.id,
              model: inferFiggie(message.job.snapshot.markets, {
                hand: message.job.snapshot.startingHand,
                players: message.job.snapshot.players.map((p) => p.name),
              }),
            });
          } catch (error) {
            reply({ id: message.job.id, error: error.message });
          }
        }, 0);
      },
    },
  };
  win.eval(fs.readFileSync(folder + 'pnl.js', 'utf8'));
  win.eval(fs.readFileSync(folder + 'ui-assets.js', 'utf8'));
  win.eval(fs.readFileSync(folder + 'flow-chart.js', 'utf8'));
  win.eval(fs.readFileSync(folder + 'ui.js', 'utf8'));
  win.eval(fs.readFileSync(folder + 'content.js', 'utf8'));
  await pause(180);
  const host = doc.getElementById('figgie-terminal-host');
  const ui = host.shadowRoot;
  assert.equal(host.style.display, 'block');
  assert.equal(doc.getElementById('root').style.opacity, '0');
  assert.equal(ui.getElementById('cash').textContent, '299');
  assert.equal(ui.querySelectorAll('.ff-market').length, 4);
  assert.equal(ui.querySelectorAll('.ff-buyer-key').length, 4);
  assert.equal(ui.getElementById('ff-payout-ev').textContent, model.expectedPayout.toFixed(2));
  assert.equal(modelJobs, 1);
  const stableInventory = ui.getElementById('ff-inventory-items').firstElementChild;
  assert(!ui.querySelector('.ff-model-panel').contains(ui.querySelector('.ff-flow')));
  assert.equal(ui.querySelector('.ff-main-dock').parentElement, ui.getElementById('figgie-fast'));
  assert.equal(ui.querySelectorAll('.ff-main-dock #flow tr').length, 4);
  assert.equal(ui.querySelector('.ff-main-tape').parentElement, ui.querySelector('.ff-main-dock'));
  assert.equal(ui.querySelector('.ff-execution [data-action]').dataset.action, 'buy');
  for (const panel of ui.querySelectorAll('.ff-market')) {
    assert.deepEqual(
      [...panel.querySelectorAll('.ff-side')].map((n) => n.dataset.quote),
      ['ask', 'bid'],
    );
    assert.deepEqual(
      [...panel.querySelectorAll('.ff-quote-form')].map((n) => n.dataset.quote),
      ['bid', 'ask'],
    );
    assert.deepEqual(
      [...panel.querySelectorAll('.ff-quote-form')].map((n) => n.dataset.kind),
      ['bid', 'offer'],
    );
    assert.deepEqual(
      [...panel.querySelectorAll('.ff-quote-form input')].map((n) => n.placeholder),
      ['Your bid', 'Your ask'],
    );
    assert.equal(panel.querySelector('[data-value=seller]').textContent, 'Bot-Cougar');
    assert.equal(panel.querySelector('[data-value=buyer]').textContent, 'Bot-Moth');
    assert.equal(
      panel.querySelector('[data-book-owner=ask]').style.getPropertyValue('--ff-owner-color'),
      colors[1],
    );
    assert.equal(
      panel.querySelector('[data-book-owner=bid]').style.getPropertyValue('--ff-owner-color'),
      colors[2],
    );
  }
  assert.equal(ui.querySelector('[data-suit="h"] [data-value="sell-edge"]').textContent, '—');
  assert(ui.querySelector('[data-suit="h"] form[data-kind="offer"] input').disabled);
  assert.equal(
    ui.querySelector('.ff-market[data-suit="d"] .ff-symbol').classList.contains('ff-suit-red'),
    true,
  );
  assert.equal(
    ui.querySelector('.ff-market[data-suit="s"] .ff-symbol').classList.contains('ff-suit-black'),
    true,
  );
  assert.equal(ui.querySelector('.ff-trade-row .ff-trade-party .ff-party-name').textContent, 'You');
  let clicks = 0;
  doc.querySelector('[data-source="s-buy"]').addEventListener('click', () => clicks++);
  const buy = ui.querySelector('[data-id="s"][data-action="buy"]');
  buy.click();
  await pause(30);
  assert.equal(clicks, 1);
  buy.click();
  await pause(30);
  assert.equal(clicks, 1);
  assert(buy.disabled);
  assert.equal(buy.getAttribute('aria-busy'), 'true');
  const realNow = win.Date.now;
  let offset = 0;
  win.Date.now = () => realNow() + offset;
  offset = 2600;
  await pause(300);
  assert.equal(clicks, 1, 'unconfirmed orders must never auto-retry');
  assert(!buy.disabled);
  assert(ui.getElementById('ff-notice').textContent.includes('No visible confirmation'));
  offset = 0;
  buy.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
  doc.querySelector('[data-row="s"]').lastElementChild.querySelector('[dir="auto"]').textContent =
    '4';
  await pause(100);
  assert(modelJobs >= 1, 'behavioral updates must remain asynchronous');
  assert.equal(ui.getElementById('ff-inventory-items').firstElementChild, stableInventory);
  buy.click();
  await pause(40);
  assert.equal(clicks, 1);
  assert(ui.getElementById('ff-notice').textContent.includes('Quote changed'));
  let submitted = null;
  const sourceInput = snapshot.refs.get('c').bid.input;
  sourceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitted = sourceInput.value;
  });
  const input = ui.querySelector('form[data-id="c"][data-kind="bid"] input');
  input.focus();
  input.value = '6';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await pause(70);
  assert.equal(submitted, '6');
  const ownBid = doc.querySelector('[data-row="c"]').firstElementChild.firstElementChild;
  ownBid.style.backgroundColor = colors[0];
  ownBid.firstElementChild.textContent = '6';
  await pause(50);
  assert(ui.getElementById('ff-notice').textContent.includes('is live'));
  assert.equal(ui.querySelector('[data-suit=c] [data-value=buyer]').textContent, 'YOU · TOP');
  assert.equal(ui.querySelector('[data-suit=c] [data-book-owner=bid]').dataset.state, 'own');
  for (const price of ['7', '6']) {
    input.value = price;
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await pause(30);
    assert.equal(submitted, price, 'quotes can be changed back without waiting for a trade');
    ownBid.firstElementChild.textContent = price;
    await pause(40);
  }
  assert.equal(ui.activeElement, input);
  assert.equal(input.value, '6');
  // Quick controls use the native arrows/cancel, with owner and fresh-price guards.
  let raised = 0;
  let lowered = 0;
  let cancelled = 0;
  const nativeBid = doc.querySelector('[data-source="c-raise"]');
  nativeBid.addEventListener('click', () => {
    raised++;
    ownBid.firstElementChild.textContent = String(Number(ownBid.firstElementChild.textContent) + 1);
  });
  const quickBid = ui.querySelector('[data-id="c"][data-quick="bid"]');
  assert(!quickBid.disabled);
  quickBid.click();
  await pause(60);
  assert.equal(raised, 1);
  assert.equal(ownBid.firstElementChild.textContent, '7');
  doc.querySelector('[data-source="c-cancel-bid"]').addEventListener('click', () => {
    cancelled++;
    ownBid.firstElementChild.textContent = '';
  });
  const cancelBid = ui.querySelector('[data-id="c"][data-cancel="bid"]');
  assert(!cancelBid.disabled);
  cancelBid.click();
  await pause(60);
  assert.equal(cancelled, 1);
  assert(cancelBid.disabled);
  assert(ui.getElementById('ff-notice').textContent.includes('cleared'));
  assert.equal(ui.querySelector('[data-suit=c] [data-book-owner=bid]').dataset.state, 'empty');
  assert.equal(ui.querySelector('[data-suit=c] [data-value=buyer]').textContent, 'No bid');
  const askPanel = doc.querySelector('[data-row="d"]').lastElementChild;
  const askPrice = askPanel.firstElementChild;
  doc.querySelector('[data-source="d-lower"]').addEventListener('click', () => {
    lowered++;
    askPrice.style.backgroundColor = colors[0];
    askPrice.firstElementChild.textContent = String(
      Number(askPrice.firstElementChild.textContent) - 1,
    );
  });
  const quickAsk = ui.querySelector('[data-id="d"][data-quick="offer"]');
  assert(!quickAsk.disabled);
  quickAsk.click();
  await pause(60);
  assert.equal(lowered, 1);
  assert.equal(askPrice.firstElementChild.textContent, '2');
  const ownAskButton = ui.querySelector('[data-suit="d"] [data-action="buy"]');
  assert(ownAskButton.disabled);
  assert(ownAskButton.classList.contains('ff-own'));
  assert(ownAskButton.textContent.includes('Your ask'));
  assert.equal(ui.querySelector('[data-suit="d"] [data-value="buy-edge"]').textContent, '—');
  assert(
    ui.querySelector('[data-id="s"][data-cancel="offer"]').disabled,
    'cannot cancel another player quote',
  );
  const staleQuick = ui.querySelector('[data-id="s"][data-quick="bid"]');
  staleQuick.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
  doc.querySelector(
    '[data-row="s"]',
  ).firstElementChild.firstElementChild.firstElementChild.textContent = '5';
  await pause(50);
  staleQuick.click();
  await pause(40);
  assert(ui.getElementById('ff-notice').textContent.includes('changed'));
  const spadesBid = doc.querySelector('[data-row=s]').firstElementChild.firstElementChild;
  const samePrice = spadesBid.firstElementChild.textContent;
  spadesBid.style.backgroundColor = colors[3];
  await pause(50);
  assert.equal(spadesBid.firstElementChild.textContent, samePrice);
  assert.equal(ui.querySelector('[data-suit=s] [data-value=buyer]').textContent, 'Bot-Rabbit');
  assert.equal(
    ui
      .querySelector('[data-suit=s] [data-book-owner=bid]')
      .style.getPropertyValue('--ff-owner-color'),
    colors[3],
  );
  // An incomplete source update must pause trading without hiding the terminal.
  doc.getElementById('history-rows').append(rows.firstElementChild.cloneNode(true));
  await pause(100);
  assert.equal(host.style.display, 'block');
  assert(buy.disabled);
  assert.equal(ui.querySelector('[data-suit="s"] [data-value="buy-edge"]').textContent, '—');
  assert.equal(ui.querySelector('[data-suit=s] [data-book-owner=ask]').dataset.state, 'stale');
  doc.getElementById('history-rows').lastElementChild.remove();
  await pause(100);
  assert.equal(host.style.display, 'block');
  assert.equal(input.value, '6');
  assert.equal(ui.activeElement, input);
  ui.getElementById('ff-keys').checked = true;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: '8', bubbles: true }));
  await pause(20);
  assert.equal(clicks, 1);
  // Page messages cannot trigger actions through the isolated closure bridge.
  win.dispatchEvent(
    new win.MessageEvent('message', {
      origin: 'https://www.figgie.com',
      source: win,
      data: {
        channel: 'figgie-terminal',
        type: 'command',
        id: 99,
        command: { kind: 'buy', suit: 's', price: 4 },
      },
    }),
  );
  await pause(20);
  assert.equal(clicks, 1);
  ui.getElementById('show-figgie').click();
  await pause(20);
  assert.equal(host.style.display, 'none');
  const oldRoot = doc.getElementById('root');
  const newRoot = oldRoot.cloneNode(true);
  newRoot.querySelector('[dir="auto"]').textContent = "Next room's game";
  oldRoot.replaceWith(newRoot);
  await pause(300);
  assert.equal(
    host.style.display,
    'block',
    'new game auto-activates after source root replacement',
  );
  const connection = doc.createElement('div');
  connection.dir = 'auto';
  connection.textContent = 'Reconnecting';
  newRoot.append(connection);
  await pause(70);
  assert(buy.disabled);
  assert(ui.getElementById('connection').textContent.includes('paused'));
  connection.remove();
  await pause(70);
  assert(!buy.disabled);
  offset = 6000;
  await pause(300);
  assert(buy.disabled, 'frozen server clock must pause execution');
  offset = 0;
  await pause(300);
  assert(!buy.disabled);
  dom.window.close();
  console.log(
    JSON.stringify(
      {
        adapter: 'passed',
        quoteOwnership: 'passed',
        historyReconciliation: 'passed',
        staleQuotes: 'rejected',
        duplicateTakes: 'rejected',
        controlledQuoteEntry: 'passed',
        isolatedBridge: 'passed',
        stableVisibility: 'passed',
        quoteColumnAlignment: 'all four suits passed',
        bookOwnerBadges: 'all suits/color/own/empty/stale passed',
        ownerOnlyUpdates: 'passed',
        ownQuoteSymmetry: 'passed',
        unavailableTradeEdges: 'hidden',
        quickBidAsk: 'native arrows passed',
        quickCancel: 'owner guarded',
        quickStalePrice: 'rejected',
        orderConfirmation: 'passed',
        pendingTimeout: 'passed without retry',
        automaticGameActivation: 'passed',
        rootReplacement: 'passed',
        connectionWatchdog: 'passed',
        quoteOnlyModelReuse: 'passed',
        counterpartyValuations: 'permutation checked',
        draftFocus: 'preserved',
        fourPlayerModel: model.mode,
        fivePlayerModel: fiveModel.mode,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  dom.window.close();
  console.error(error);
  process.exitCode = 1;
});
