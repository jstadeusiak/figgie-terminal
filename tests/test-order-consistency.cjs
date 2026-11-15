const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, boxes, colors, text, icon } = require('./figgie-fixture.cjs');
const { inferFiggie } = require('./reference-model.js');
const dom = setup();
const win = dom.window;
const doc = win.document;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jobs = [];
let observedTradeCount = 0;
async function waitFor(condition, description) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`);
    await pause(5);
  }
}
function addOpponentFill() {
  const row = doc.createElement('div');
  row.innerHTML = text('Bot-Moth') + icon('', boxes[3]) + text('Bot-Rabbit') + text(2);
  doc.getElementById('history-rows').prepend(row);
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
}
(async () => {
  win.ResizeObserver = class {
    observe() {}
  };
  win.chrome = {
    runtime: {
      sendMessage(message, reply) {
        if (message.type !== 'figgie-model') {
          for (const item of message.batch || [])
            if (item.snapshot) observedTradeCount = item.snapshot.trades.length;
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
        jobs.push({ job: message.job, reply });
      },
    },
  };
  for (const file of ['pnl.js', 'ui-assets.js', 'flow-chart.js', 'ui.js', 'content.js'])
    win.eval(fs.readFileSync('extension/' + file, 'utf8'));
  const ui = doc.getElementById('figgie-terminal-host').shadowRoot;
  const complete = () => {
    const { job, reply } = jobs.shift();
    const s = job.snapshot;
    const result = inferFiggie(s.markets, {
      hand: s.startingHand,
      players: s.players.map((p) => p.name),
    });
    reply({ id: job.id, model: result });
    return result;
  };
  await waitFor(() => jobs.length > 0, 'the initial model request');
  assert.equal(jobs.length, 1);
  const initialTradeCount = jobs[0].job.snapshot.trades.length;
  complete();
  assert.notEqual(ui.querySelector('[data-suit=s] [data-value=fair]').textContent, '—');
  const submitted = [];
  for (const id of ['c', 'h']) {
    const input = doc.querySelector(`[data-row=${id}] input`);
    const priceNode = doc.querySelector(`[data-row=${id}]`).firstElementChild.firstElementChild;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        submitted.push([id, input.value]);
        priceNode.style.backgroundColor = colors[0];
        priceNode.firstElementChild.textContent = input.value;
      }
    });
    const field = ui.querySelector(`form[data-id=${id}][data-kind=bid] input`);
    field.value = '4';
    field.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
  }
  await waitFor(() => submitted.length === 2, 'both native quote submissions');
  assert.deepEqual(
    submitted,
    [
      ['c', '4'],
      ['h', '4'],
    ],
    'different suits can post within one frame',
  );
  await waitFor(() => jobs.length > 0, 'the quote-update model request');
  assert.equal(jobs[0].job.snapshot.trades.length, initialTradeCount);
  const ask = ui.querySelector('form[data-id=s][data-kind=offer] input');
  ask.value = '9';
  let staleSubmissions = 0;
  doc
    .querySelectorAll('[data-row=s] input')[1]
    .addEventListener('keydown', () => staleSubmissions++);
  ask.dispatchEvent(
    new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
  );
  addOpponentFill();
  await waitFor(
    () => /Market reset/.test(ui.getElementById('ff-notice').textContent),
    'the stale order rejection',
  );
  assert.equal(staleSubmissions, 0, 'a passive order cannot cross a market reset');
  await waitFor(
    () => observedTradeCount === initialTradeCount + 1,
    'the post-reset source observation',
  );
  assert.equal(ui.getElementById('model-kind').textContent, 'Updating…');
  for (const key of ['fair', 'buy-fair', 'sell-fair'])
    assert.equal(
      ui.querySelector(`[data-suit=s] [data-value=${key}]`).textContent,
      '—',
      'all fair values pause with stale evidence',
    );
  assert.equal(ui.querySelector('[data-suit=s] [data-value=buy-edge]').textContent, '—');
  assert.equal(ui.getElementById('ff-inventory-ev').textContent, '—');
  assert.equal(
    ui.querySelector('[data-suit=s] [data-value=rest-bid-edge]').textContent,
    'Use Buy now',
  );
  assert(
    [...ui.querySelectorAll('.ff-quote-form input')].every((n) => n.value === ''),
    'reset clears all fields',
  );
  complete();
  assert.equal(
    ui.querySelector('[data-suit=s] [data-value=fair]').textContent,
    '—',
    'a pre-reset model response cannot restore stale prices',
  );
  await waitFor(() => jobs.length > 0, 'the post-reset model request');
  assert.equal(jobs[0].job.snapshot.trades.length, initialTradeCount + 1);
  complete();
  for (const key of ['fair', 'buy-fair', 'sell-fair'])
    assert.notEqual(
      ui.querySelector(`[data-suit=s] [data-value=${key}]`).textContent,
      '—',
      'all fair values recover together',
    );
  assert.notEqual(ui.getElementById('ff-inventory-ev').textContent, '—');
  win.close();
  console.log(
    JSON.stringify(
      {
        parallelQuoteEntry: 'both suits submitted',
        quoteOnlyModelReuse: 'passed',
        stalePassiveOrder: 'rejected',
        staleModelPrices: 'hidden while updating',
        freshModelPrices: 'restored',
        resetDrafts: 'cleared',
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
