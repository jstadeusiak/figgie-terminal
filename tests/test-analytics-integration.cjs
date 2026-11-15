const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup } = require('./figgie-fixture.cjs');
const { start, db } = require('./background-harness.cjs');
const dom = setup();
const win = dom.window;
const doc = win.document;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let send = start();
let latestModelJob;
async function waitFor(predicate, description) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert(performance.now() < deadline, `Timed out waiting for ${description}`);
    await pause(10);
  }
}
(async () => {
  const clock = [...doc.querySelectorAll('#root > [dir=auto]')].find((node) =>
    /^\d+:\d{2}$/.test(node.textContent),
  );
  let seconds = 120;
  clock.textContent = '2:00';
  // A frozen fixture clock triggers the real stalled-source guard after five seconds.
  win.setInterval(() => {
    seconds--;
    clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);
  for (const row of doc.querySelectorAll('[data-row]'))
    row.lastElementChild.firstElementChild.firstElementChild.textContent = '5';
  win.ResizeObserver = class {
    observe() {}
  };
  win.chrome = {
    runtime: {
      id: 'test',
      sendMessage(message, reply) {
        send(message).then((response) => {
          reply(response);
          if (message.type === 'figgie-model' && response.model) latestModelJob = message.job;
        });
      },
    },
  };
  for (const name of ['pnl.js', 'ui-assets.js', 'flow-chart.js', 'ui.js', 'content.js'])
    win.eval(fs.readFileSync('extension/' + name, 'utf8'));
  const ui = doc.getElementById('figgie-terminal-host').shadowRoot;
  await waitFor(
    () => latestModelJob && db.events.size > 0,
    'the initial model and durable recording',
  );
  const resultMenu = ui.getElementById('revealed-goal');
  assert.deepEqual(
    [...resultMenu.options].map((o) => o.value),
    ['', 's', 'c', 'd', 'h'],
  );
  for (const suit of ['s', 'c', 'd', 'h']) {
    resultMenu.value = suit;
    assert.equal(resultMenu.value, suit, 'every revealed suit is selectable');
  }
  resultMenu.value = '';
  assert(ui.getElementById('model-kind').textContent.includes('Opponent'));
  assert(ui.getElementById('recording-state').textContent.includes('REC ·'));
  assert(db.events.size > 0);
  const diagnosticsPanel = ui.getElementById('diagnostics').closest('details');
  diagnosticsPanel.open = true;
  function readDiagnostics() {
    // Diagnostics normally lag the live model by 250 ms; capture both in the same turn.
    diagnosticsPanel.dispatchEvent(new win.Event('toggle'));
    return JSON.parse(ui.getElementById('diagnostics').value);
  }
  const diagnostic = readDiagnostics().model;
  const first = diagnostic.probabilities;
  assert(ui.getElementById('model-confidence').textContent.includes('PROVISIONAL'));
  for (let i = 0; i < 4; i++) {
    const panel = ui.querySelector('[data-suit=' + ['s', 'c', 'd', 'h'][i] + ']');
    assert.equal(
      panel.querySelector('[data-value=fair]').textContent,
      (10 * diagnostic.probabilities[i]).toFixed(2),
      'fair value equals 10P(goal)',
    );
    const shift = 10 * (diagnostic.probabilities[i] - diagnostic.baseline[i]);
    assert.equal(
      panel.querySelector('[data-value=flow-value]').textContent,
      (shift < 0 ? '−' : '+') + Math.abs(shift).toFixed(2),
      'signals explain the adjustment, not an extra premium',
    );
  }
  assert(!('candidateProbabilities' in diagnostic.behavior), 'one live model');
  assert.equal(ui.querySelectorAll('.ff-scenario-base').length, 4);
  const resting = diagnostic.resting.s.bid;
  const displayedGain = ui.querySelector('[data-suit=s] [data-value=rest-bid-edge]').textContent;
  assert.equal(
    displayedGain,
    'Gain if filled ' +
      (resting.conditionalEdge < 0 ? '−' : '+') +
      Math.abs(resting.conditionalEdge).toFixed(2),
  );
  assert(ui.querySelector('[data-suit=s] [data-resting=bid]').title.includes('PROVISIONAL'));
  const native = doc.querySelector('[data-row=c]').firstElementChild.firstElementChild;
  native.firstElementChild.textContent = '13';
  await waitFor(
    () => latestModelJob.snapshot.markets.find((market) => market.id === 'c').bid === 13,
    'the changed quote to reach the model',
  );
  const second = readDiagnostics().model.probabilities;
  assert.notDeepEqual(first, second, 'quote prices update goal beliefs');
  assert([...db.events.values()].some((e) => e.kind === 'quote' && e.price === 13));
  const buyColumn = ui.querySelector('[data-suit=s] .ff-quoting .ff-quote-stack');
  assert.equal(buyColumn.dataset.quote, 'bid');
  assert.equal(buyColumn.dataset.direction, 'buy');
  const draft = buyColumn.querySelector('input');
  draft.value = '20';
  draft.dispatchEvent(new win.Event('input'));
  await waitFor(() => latestModelJob.quotePrices.s?.bid === 20, 'the bid draft model');
  assert.equal(readDiagnostics().model.resting.s.bid.price, 20);
  assert(
    ui
      .querySelector('[data-suit=s] [data-value=rest-bid-price]')
      .textContent.includes('Your bid @ 20'),
  );
  assert.equal(
    ui.querySelector('[data-suit=s] [data-value=rest-bid-fill]').textContent,
    'Crosses ask',
  );
  assert.equal(
    ui.querySelector('[data-suit=s] [data-value=rest-bid-edge]').textContent,
    'Use Buy now',
  );
  const askDraft = ui.querySelector('form[data-id=s][data-kind=offer] input');
  askDraft.value = '1';
  askDraft.dispatchEvent(new win.Event('input'));
  await waitFor(() => latestModelJob.quotePrices.s?.ask === 1, 'the ask draft model');
  assert.equal(
    ui.querySelector('[data-suit=s] [data-value=rest-ask-fill]').textContent,
    'Crosses bid',
  );
  assert.equal(
    ui.querySelector('[data-suit=s] [data-value=rest-ask-edge]').textContent,
    'Use Sell now',
  );
  askDraft.value = '';
  askDraft.dispatchEvent(new win.Event('input'));
  draft.value = '';
  draft.dispatchEvent(new win.Event('input'));
  await waitFor(() => !latestModelJob.quotePrices.s, 'the cleared drafts to reach the model');
  assert.notEqual(ui.getElementById('round-pnl').textContent, '—');
  assert.equal(ui.querySelector('.ff-pnl-panel dl'), null);
  assert.equal(ui.getElementById('pnl-state').textContent, 'Est.');
  assert.equal(ui.querySelectorAll('#pnl-scenarios [data-goal]').length, 4);
  assert([...ui.querySelectorAll('#pnl-scenarios b')].every((n) => n.textContent !== '—'));
  const exported = await send({ type: 'figgie-export', roundId: 'all' });
  assert(exported.text.includes('prediction'));
  assert(exported.text.includes('learning_prior'));
  send = start();
  native.firstElementChild.textContent = '14';
  await waitFor(
    () => latestModelJob.snapshot.markets.find((market) => market.id === 'c').bid === 14,
    'the restarted worker model',
  );
  assert(
    ui.getElementById('model-kind').textContent.includes('Opponent'),
    'new worker restores and resumes',
  );
  const toggle = ui.getElementById('opponent-model');
  toggle.checked = false;
  toggle.dispatchEvent(new win.Event('change'));
  await waitFor(() => latestModelJob.opponentEnabled === false, 'the cards-only model');
  assert(ui.getElementById('model-kind').textContent.includes('Cards only'));
  const fields = [...ui.querySelectorAll('.ff-quote-form input')];
  assert(
    fields.every((i) => i.value === ''),
    'recording/model updates do not refill drafts',
  );
  const gap = doc.createElement('div');
  gap.dir = 'auto';
  gap.textContent = 'Reconnecting';
  doc.getElementById('root').append(gap);
  await waitFor(() => ui.querySelector('[data-action=buy]').disabled, 'execution to pause');
  assert(ui.querySelector('[data-action=buy]').disabled);
  assert.equal(
    ui.querySelector('[data-suit=s] [data-value=rest-bid-edge]').textContent,
    'Gain if filled —',
  );
  gap.remove();
  await waitFor(() => !ui.querySelector('[data-action=buy]').disabled, 'execution to resume');
  assert(!ui.querySelector('[data-action=buy]').disabled);
  toggle.checked = true;
  toggle.dispatchEvent(new win.Event('change'));
  await waitFor(() => latestModelJob.opponentEnabled === true, 'the opponent model');
  assert(ui.getElementById('model-kind').textContent.includes('Opponent'));
  win.close();
  console.log(
    JSON.stringify(
      {
        realRuntimeFlow: 'recording + model + UI',
        durableJournal: 'events and prediction priors persisted',
        quoteSensitiveOdds: 'updated',
        restingEV: 'fill probability + selection',
        workerRestart: 'resumed',
        baselineToggle: 'works',
        drafts: 'stay blank',
        disconnect: 'execution + EV paused',
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
