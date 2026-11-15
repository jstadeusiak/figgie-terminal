const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, boxes, text, icon } = require('./figgie-fixture.cjs');
const dom = setup();
const win = dom.window;
const doc = win.document;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  // Give every suit inventory so all eight native actions can be tested.
  doc
    .querySelector('svg[id^="diamonds_card_"]')
    .parentElement.querySelector('[dir=auto]').textContent = '3';
  doc
    .querySelector('svg[id^="hearts_card_"]')
    .parentElement.querySelector('[dir=auto]').textContent = '1';
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
  for (const file of ['pnl.js', 'ui-assets.js', 'flow-chart.js', 'ui.js', 'content.js'])
    win.eval(fs.readFileSync('extension/' + file, 'utf8'));
  await pause(40);
  const host = doc.getElementById('figgie-terminal-host');
  const ui = host.shadowRoot;
  const enabled = ui.getElementById('ff-keys');
  const seen = [];
  for (const suit of ['s', 'c', 'd', 'h'])
    for (const side of ['buy', 'sell'])
      doc
        .querySelector(`[data-source="${suit}-${side}"]`)
        .addEventListener('click', () => seen.push(`${suit}-${side}`));
  const press = (key, options = {}, target = doc.body) =>
    target.dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key,
        bubbles: true,
        composed: true,
        cancelable: true,
        ...options,
      }),
    );
  assert.deepEqual(
    [...ui.querySelectorAll('.ff-take kbd')].map((n) => n.textContent),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
  );
  assert.deepEqual(
    [...ui.querySelectorAll('.ff-take')].map((n) => n.getAttribute('aria-keyshortcuts')),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
  );
  assert(
    [...ui.querySelectorAll('.ff-quote-form input')].every((n) => n.value === ''),
    'all price inputs start blank',
  );
  let nativeHotkeys = 0;
  doc.addEventListener('keydown', () => nativeHotkeys++);
  press('1');
  await pause(10);
  assert.equal(seen.length, 0, 'disabled toggle blocks execution');
  assert.equal(nativeHotkeys, 0, 'native hotkeys cannot leak through overlay');
  enabled.checked = true;
  const input = ui.querySelector('.ff-quote-form input');
  input.focus();
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8']) press(key, {}, input);
  assert.equal(seen.length, 0, 'typing prices must never trade');
  for (const options of [
    { repeat: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
  ])
    press('1', options);
  assert.equal(seen.length, 0, 'repeat/modifiers/composition must never trade');
  input.blur();
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    press(key);
    await pause(10);
  }
  assert.deepEqual(
    seen,
    ['s-buy', 's-sell', 'c-buy', 'c-sell', 'd-buy', 'd-sell', 'h-buy', 'h-sell'],
    'all shortcuts reach the correct original Figgie control',
  );
  // An ordinary quote update keeps drafts. A market reset clears every field, even a focused one.
  const inputs = [...ui.querySelectorAll('.ff-quote-form input')];
  inputs.forEach((n) => (n.value = '88'));
  input.focus();
  doc.querySelector(
    '[data-row="s"]',
  ).firstElementChild.firstElementChild.firstElementChild.textContent = '5';
  await pause(50);
  assert(
    inputs.every((n) => n.value === '88'),
    'quote refresh preserves drafts',
  );
  const historyRow = doc.createElement('div');
  historyRow.innerHTML = text('Bot-Moth') + icon('', boxes[3]) + text('Bot-Rabbit') + text(2);
  doc.getElementById('history-rows').prepend(historyRow);
  for (const [name, delta] of [
    ['Bot-Moth', '+1'],
    ['Bot-Rabbit', '-1'],
  ]) {
    const header = [...doc.querySelectorAll('header')].find((n) => n.textContent.startsWith(name));
    const card = header.parentElement;
    card.querySelector(`svg[viewBox="${boxes[3]}"]`).parentElement.lastElementChild.textContent =
      delta;
  }
  await pause(60);
  assert(
    inputs.every((n) => n.value === ''),
    'a new fill clears all eight drafts',
  );
  assert.equal(ui.activeElement, input, 'reset keeps keyboard focus');
  inputs.forEach((n) => (n.value = '77'));
  [...doc.querySelectorAll('#root [dir=auto]')].find(
    (n) => n.textContent === 'Round 1',
  ).textContent = 'Round 2';
  await pause(60);
  assert(
    inputs.every((n) => n.value === ''),
    'new round clears drafts',
  );
  const connection = doc.createElement('div');
  connection.dir = 'auto';
  connection.textContent = 'Reconnecting';
  doc.getElementById('root').append(connection);
  await pause(50);
  press('1');
  await pause(10);
  assert.equal(seen.length, 8, 'disconnected shortcuts cannot execute');
  ui.getElementById('show-figgie').click();
  await pause(10);
  press('1');
  await pause(10);
  assert.equal(seen.length, 8);
  assert(nativeHotkeys > 0, 'native keys are restored when showing Figgie');
  console.log(
    JSON.stringify(
      {
        shortcutOrder: '1–8 in visual order',
        nativeActions: seen,
        bodyFocus: 'passed',
        typingModifiersRepeat: 'blocked',
        nativeShortcutIsolation: 'passed',
        draftsOnFill: 'cleared all eight',
        draftsOnRound: 'cleared',
        quoteOnlyDrafts: 'preserved',
        disconnectedKeys: 'blocked',
      },
      null,
      2,
    ),
  );
  win.close();
})().catch((error) => {
  win.close();
  console.error(error);
  process.exitCode = 1;
});
