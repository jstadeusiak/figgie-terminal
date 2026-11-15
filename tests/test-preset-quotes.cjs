'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, boxes, colors, text, icon } = require('./figgie-fixture.cjs');
const dom = setup();
const win = dom.window;
const doc = win.document;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, description) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`);
    await pause(5);
  }
}
(async () => {
  const clock = [...doc.querySelectorAll('#root [dir=auto]')].find(
    (node) => node.textContent === '0:01',
  );
  let seconds = 120;
  clock.textContent = '2:00';
  win.setInterval(() => {
    seconds--;
    clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);
  doc
    .querySelector('svg[id^="hearts_card_"]')
    .parentElement.querySelector('[dir=auto]').textContent = '2';
  doc
    .querySelector('svg[id^="diamonds_card_"]')
    .parentElement.querySelector('[dir=auto]').textContent = '2';
  const native = (s, side) => {
    const row = doc.querySelector(`[data-row=${s}]`);
    const node = side === 'bid' ? row.firstElementChild : row.lastElementChild;
    return { input: node.querySelector('input'), quote: node.firstElementChild };
  };
  const book = (s, bid = 1, ask = 30) => {
    for (const [side, price] of [
      ['bid', bid],
      ['offer', ask],
    ]) {
      const n = native(s, side);
      n.quote.style.backgroundColor = colors[side === 'bid' ? 2 : 1];
      n.quote.firstElementChild.textContent = price;
    }
  };
  for (const s of ['s', 'c', 'd', 'h']) book(s);
  win.ResizeObserver = class {
    observe() {}
  };
  win.chrome = {
    runtime: {
      sendMessage(message, reply) {
        if (message.type !== 'figgie-model')
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
      },
    },
  };
  for (const file of ['pnl.js', 'ui-assets.js', 'flow-chart.js', 'ui.js'])
    win.eval(fs.readFileSync('extension/' + file, 'utf8'));
  const messages = [];
  const mount = win.FiggieTerminalUI.mount;
  let observedSnapshot;
  win.FiggieTerminalUI.mount = (...args) => {
    const view = mount(...args);
    return {
      ...view,
      receive(message) {
        view.receive(message);
        messages.push(message);
        if (message.type === 'snapshot') observedSnapshot = message.snapshot;
      },
    };
  };
  win.eval(fs.readFileSync('extension/content.js', 'utf8'));
  await waitFor(() => observedSnapshot, 'the initial source snapshot');
  const ui = doc.getElementById('figgie-terminal-host').shadowRoot;
  const posts = [];
  const takes = [];
  const quoteEchoes = [];
  const confirmations = () => messages.filter((m) => m.type === 'order' && m.state === 'confirmed');
  const rejections = () => messages.filter((m) => m.type === 'reject');
  const waitForBook = (s, bid = 1, ask = 30) =>
    waitFor(() => {
      const market = observedSnapshot.markets.find((m) => m.id === s);
      return (
        market.bid === bid &&
        market.ask === ask &&
        market.buyer === 'Bot-Moth' &&
        market.seller === 'Bot-Cougar'
      );
    }, `the ${s} book update`);
  for (const s of ['s', 'c', 'd', 'h'])
    for (const side of ['bid', 'offer']) {
      const n = native(s, side);
      n.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          const price = Number(n.input.value);
          posts.push({ suit: s, kind: side, price });
          quoteEchoes.push(() => {
            n.quote.style.backgroundColor = colors[0];
            n.quote.firstElementChild.textContent = price;
          });
        }
      });
    }
  for (const s of ['s', 'c', 'd', 'h'])
    for (const side of ['buy', 'sell'])
      doc
        .querySelector(`[data-source=${s}-${side}]`)
        .addEventListener('click', () => takes.push([s, side]));
  const preset = (s, side, price) =>
    ui.querySelector(`[data-preset=${side}][data-id=${s}][data-price="${price}"]`);
  assert.equal(ui.querySelectorAll('[data-preset]').length, 32);
  for (const s of ['s', 'c', 'd', 'h'])
    for (const [side, prices, quote] of [
      ['bid', [1, 2, 4, 8], 'bid'],
      ['offer', [16, 12, 10, 8], 'ask'],
    ]) {
      const group = ui.querySelector(
        `[data-suit=${s}] .ff-quote-stack[data-quote=${quote}] .ff-quote-presets`,
      );
      assert.deepEqual(
        [...group.querySelectorAll('button')].map((n) => Number(n.textContent)),
        prices,
      );
      for (const price of prices) {
        book(s);
        await waitForBook(s);
        const n = preset(s, side, price);
        assert(!n.disabled, `${s} ${side} ${price} should post: ${n.title}`);
        n.click();
        assert(
          [...group.querySelectorAll('button')].every((b) => b.disabled),
          'entire preset lane disables before next frame',
        );
        n.click();
        const submittedCount = confirmations().length + 1;
        await waitFor(() => posts.length === submittedCount, 'the native quote submission');
        assert.deepEqual(posts.at(-1), { suit: s, kind: side, price });
        if (submittedCount === 1) await pause(100);
        assert(
          [...group.querySelectorAll('button')].every((b) => b.disabled),
          'the lane stays pending until the native quote is observed',
        );
        quoteEchoes.shift()();
        await waitFor(
          () => confirmations().length === submittedCount,
          'the observed quote confirmation',
        );
      }
    }
  assert.equal(posts.length, 32, 'one native post per click; pending duplicate blocked');
  assert.deepEqual(takes, [], 'presets never invoke native takes');
  assert(
    [...ui.querySelectorAll('.ff-quote-form input')].every((n) => n.value === ''),
    'fixed presets leave custom drafts untouched',
  );
  // Crossing quotes, including equal prices, are unavailable before sending.
  book('s', 10, 4);
  await waitForBook('s', 10, 4);
  for (const price of [4, 8]) assert(preset('s', 'bid', price).disabled);
  for (const price of [10, 8]) assert(preset('s', 'offer', price).disabled);
  assert(!preset('s', 'offer', 12).disabled);
  // A quote can move after the UI snapshot but before the bridge reads the source.
  book('s');
  await waitForBook('s');
  const beforeBridgeRace = posts.length;
  const beforeBridgeRejections = rejections().length;
  native('s', 'offer').quote.firstElementChild.textContent = '4';
  preset('s', 'bid', 4).click();
  await waitFor(
    () => rejections().length === beforeBridgeRejections + 1,
    'the crossing-order rejection',
  );
  assert.equal(posts.length, beforeBridgeRace, 'bridge rejects a newly crossing fixed post');
  assert.match(ui.getElementById('ff-notice').textContent, /crosses the book/);
  // A change during the native controlled-input frame cannot turn a post into a take.
  book('s');
  await waitForBook('s');
  let crossingRace = true;
  const raceInput = native('s', 'bid').input;
  raceInput.addEventListener('input', () => {
    if (crossingRace) {
      crossingRace = false;
      native('s', 'offer').quote.firstElementChild.textContent = '4';
    }
  });
  const beforeRace = posts.length;
  const beforeInputRejections = rejections().length;
  preset('s', 'bid', 4).click();
  await waitFor(
    () => rejections().length === beforeInputRejections + 1,
    'the controlled-input crossing rejection',
  );
  assert.equal(posts.length, beforeRace, 'fresh opposite quote is checked before Enter');
  assert.match(ui.getElementById('ff-notice').textContent, /crosses the book/);
  // Cash changes refresh availability even when this suit's book does not change.
  book('s');
  const selfHeader = [...doc.querySelectorAll('header')].find((n) =>
    n.textContent.startsWith('Alice'),
  );
  selfHeader.querySelector('svg').nextElementSibling.textContent = '3';
  await waitFor(() => observedSnapshot.cash === 3, 'the cash decrease');
  assert(preset('s', 'bid', 4).disabled);
  assert(!preset('s', 'bid', 2).disabled);
  doc
    .querySelector('svg[id^="hearts_card_"]')
    .parentElement.querySelector('[dir=auto]').textContent = '0';
  doc
    .querySelector('svg[id^="diamonds_card_"]')
    .parentElement.querySelector('[dir=auto]').textContent = '4';
  await waitFor(() => observedSnapshot.held[3] === 0, 'the inventory decrease');
  assert(
    [...ui.querySelectorAll('[data-preset=offer][data-id=h]')].every((n) => n.disabled),
    'no inventory disables all asks',
  );
  selfHeader.querySelector('svg').nextElementSibling.textContent = '299';
  await waitFor(() => observedSnapshot.cash === 299, 'the cash restoration');
  const row = () => {
    const n = doc.createElement('div');
    n.innerHTML = text('Bot-Moth') + icon('', boxes[3]) + text('Bot-Rabbit') + text(2);
    doc.getElementById('history-rows').prepend(n);
    for (const [name, delta] of [
      ['Bot-Moth', '+1'],
      ['Bot-Rabbit', '-1'],
    ]) {
      const card = [...doc.querySelectorAll('header')].find((n) =>
        n.textContent.startsWith(name),
      ).parentElement;
      card.querySelector(`svg[viewBox="${boxes[3]}"]`).parentElement.lastElementChild.textContent =
        delta;
    }
  };
  const n = preset('s', 'bid', 2);
  n.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
  ui.querySelectorAll('.ff-quote-form input').forEach((n) => (n.value = '9'));
  const beforeFill = observedSnapshot.trades.length;
  row();
  await waitFor(() => observedSnapshot.trades.length === beforeFill + 1, 'the fill reset');
  n.click();
  assert.match(ui.getElementById('ff-notice').textContent, /Market reset/);
  assert.equal(posts.length, beforeRace, 'pointerdown across a fill is rejected');
  assert(
    [...ui.querySelectorAll('.ff-quote-form input')].every((n) => n.value === ''),
    'reset still clears every draft',
  );
  n.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
  const beforeRound = observedSnapshot.roundKey;
  [...doc.querySelectorAll('#root [dir=auto]')].find(
    (n) => n.textContent === 'Round 1',
  ).textContent = 'Round 2';
  await waitFor(() => observedSnapshot.roundKey !== beforeRound, 'the round reset');
  n.click();
  assert.match(ui.getElementById('ff-notice').textContent, /Market reset/);
  assert.equal(posts.length, beforeRace, 'pointerdown across a round boundary is rejected');
  const disconnected = doc.createElement('div');
  disconnected.dir = 'auto';
  disconnected.textContent = 'Reconnecting';
  doc.getElementById('root').append(disconnected);
  await waitFor(() => observedSnapshot.status !== 'live', 'the disconnected source');
  assert(
    [...ui.querySelectorAll('[data-preset]')].every((n) => n.disabled),
    'disconnect disables every preset',
  );
  win.close();
  console.log(
    JSON.stringify(
      {
        nativePosts: posts.length,
        buttonOrder: 'bid 1,2,4,8; ask 16,12,10,8',
        crossingAtClick: 'disabled',
        crossingDuringNativeInput: 'rejected',
        pendingLane: 'all presets disabled synchronously',
        cashAndInventory: 'enforced',
        fillAndRoundRace: 'rejected',
        resetDrafts: 'cleared',
        disconnect: 'disabled',
        accidentalTakes: takes.length,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  win.close();
  console.error(error);
  process.exitCode = 1;
});
