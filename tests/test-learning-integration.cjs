/* Real native-DOM adapter, content bridge, trading UI, Learning UI, analytics,
   and background dispatcher. Only Chrome transport, timers, and durable storage
   are controlled locally; this test never connects to a browser or user data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, boxes } = require('./figgie-fixture.cjs');
const { start, db, copy } = require('./background-harness.cjs');
const hands = [
  [3, 4, 4, 0],
  [3, 1, 2, 3],
  [3, 2, 2, 3],
  [3, 1, 2, 4],
];
const alternate = [
  [3, 4, 4, 0],
  [1, 3, 2, 3],
  [1, 4, 2, 3],
  [3, 1, 2, 4],
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot({ visible = true, partial = false } = {}) {
  db.rounds.clear();
  db.events.clear();
  db.learning.clear();
  const dom = setup();
  const w = dom.window;
  const doc = w.document;
  const root = doc.getElementById('root');
  const panels = Array.from(root.children).filter(
    (el) => el.tagName === 'SECTION' && el.querySelector('svg[id^="chip_"]'),
  );
  const ownCount = panels[0]
    .querySelector('svg[id^="spades_card_"]')
    .parentElement.querySelector('[dir="auto"]');
  function expose(visible, table = hands) {
    for (let i = 1; i < panels.length; i++)
      for (let k = 0; k < 4; k++) {
        const svg = Array.from(panels[i].querySelectorAll('svg')).find(
          (el) => el.getAttribute('viewBox') === boxes[k],
        );
        svg.parentElement.querySelector('[dir="auto"]').textContent = visible
          ? String(table[i][k])
          : ' ';
      }
  }
  expose(visible);
  if (partial) ownCount.textContent = '?';
  let worker = start();
  let now = Date.now();
  const intervals = new Map();
  const pending = new Set();
  const packets = [];
  const responses = [];
  const errors = [];
  w.Date.now = () => now;
  w.setInterval = (fn, ms) => {
    intervals.set(ms, fn);
    return ms;
  };
  w.clearInterval = () => {};
  w.requestAnimationFrame = () => 1;
  w.cancelAnimationFrame = () => {};
  w.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  w.addEventListener('error', (event) => errors.push(event.error || Error(event.message)));
  w.chrome = {
    runtime: {
      sendMessage(message, callback) {
        packets.push(copy(message));
        const task = worker(copy(message))
          .then((response) => {
            if (response.error) throw Error(response.error);
            responses.push({ type: message.type, response: copy(response) });
            callback(response);
          })
          .catch((error) => {
            errors.push(error);
            callback({ error: error.message });
          });
        pending.add(task);
        task.finally(() => pending.delete(task));
      },
    },
  };
  async function drain() {
    // Real UI scheduling is a bounded 120 ms debounce; let both it and queued
    // content messages settle, then await every background response.
    for (let n = 0; n < 3; n++) {
      await Promise.resolve();
      if (pending.size) await Promise.all([...pending]);
      await pause(140);
    }
    while (pending.size) await Promise.all([...pending]);
    if (errors.length) throw errors[0];
  }
  for (const file of [
    'pnl.js',
    'ui-assets.js',
    'flow-chart.js',
    'training-ui.js',
    'ui.js',
    'content.js',
  ])
    w.eval(fs.readFileSync('extension/' + file, 'utf8'));
  await drain();
  const shadow = doc.getElementById('figgie-terminal-host').shadowRoot;
  return {
    dom,
    w,
    doc,
    shadow,
    packets,
    responses,
    expose,
    ownCount,
    drain,
    q: (selector) => shadow.querySelector(selector),
    read: () => w.FiggieAdapter.read(doc),
    model: () => responses.filter((row) => row.type === 'figgie-model').at(-1)?.response.model,
    events: () => [...db.events.values()],
    saved: () => [...db.rounds.values()].at(-1),
    restart() {
      worker = start();
    },
    async refresh() {
      now += 1500;
      intervals.get(250)();
      await drain();
    },
    async click(selector) {
      const element = shadow.querySelector(selector);
      assert(element, 'missing ' + selector);
      assert(!element.disabled, 'disabled ' + selector);
      element.click();
      await drain();
    },
    close() {
      dom.window.close();
    },
  };
}

(async () => {
  let h = await boot();
  try {
    const initial = h.read();
    const initialModel = h.model();
    assert.equal(initial.training.valid, true);
    assert.equal(initialModel.training.exactGoal, 'c');
    assert.equal(h.saved().practice, true);
    assert.equal(h.saved().revealed, null);
    assert(!h.q('#ff-learning').hidden);
    const blind = copy(initialModel.bySuit.map((row) => row.probability));
    assert(blind.some((p) => p > 0 && p < 1));
    await h.click('#ff-learning');
    assert(!h.q('#ff-learn-body').textContent.includes('Actual goal'));
    h.q('#ff-learn-reason').value = 'Compare the accumulation with the private deal.';
    await h.click('[data-learn="save"]');
    const prediction = h.events().find((e) => e.kind === 'training_prediction');
    assert(prediction);
    assert.equal(prediction.practice, true);
    assert.equal(prediction.afterPeek, false);
    assert.equal(prediction.checkpointCaptured, true);
    assert.equal(prediction.trainingTruth, undefined);
    assert.equal(prediction.serverBlindModel.training, undefined);
    assert.deepEqual(prediction.userProbabilities, [0.25, 0.25, 0.25, 0.25]);
    assert.deepEqual(prediction.blindProbabilities, blind);
    assert(!h.q('#ff-learn-body').textContent.includes('Actual goal'));
    const frozen = h.q('#ff-learn-body').innerHTML;
    h.expose(true, alternate);
    await h.refresh();
    assert.equal(h.model().training.exactGoal, 's');
    assert.deepEqual(
      copy(h.model().bySuit.map((row) => row.probability)),
      blind,
      'changed private truth cannot enter normal trading inference',
    );
    assert.equal(
      h.q('#ff-learn-body').innerHTML,
      frozen,
      'live hand changes cannot rewrite a locked checkpoint',
    );
    await h.click('[data-learn="all"]');
    assert(h.q('#ff-learn-body').textContent.includes('Actual goal'));
    assert.equal(h.q('.ff-learn-hands tbody').children.length, 4);
    const peek = h.events().find((e) => e.kind === 'training_peek');
    assert(peek);
    assert.equal(
      peek.trainingTruth.exactGoal,
      'c',
      'persisted peek must use the frozen checkpoint, not newer visible truth',
    );
    assert.equal(peek.trainingScores.user.goalProbability, 0.25);
    assert.equal(h.saved().practicePeeked, true);
    assert.equal(h.saved().revealed, null);
    await h.click('[data-learn="continue"]');
    assert(h.q('.ff-learning-overlay').hidden);
    assert(h.events().some((e) => e.kind === 'training_continue'));
    h.expose(false);
    h.restart();
    await h.refresh();
    assert.equal(h.saved().practice, true);
    assert.equal(h.saved().practicePeeked, true);
    assert.equal(h.model().training.available, false);
    assert(
      !h.q('#ff-learning').hidden,
      'practice launcher survives hiding hands and worker restart',
    );
    assert(!h.events().some((e) => ['round_score', 'bonus_score'].includes(e.kind)));
    assert.equal(db.learning.get('global').metrics.rounds, 0);
  } finally {
    h.close();
  }

  // Exposure can be detected before a complete source snapshot exists. It must
  // mark the next usable round even when the hands become concealed first.
  h = await boot({ visible: true, partial: true });
  try {
    const partial = h.read();
    assert.equal(partial.status, 'waiting');
    assert.equal(partial.training.valid, false);
    assert.equal(db.rounds.size, 0);
    h.expose(false);
    h.ownCount.textContent = '3';
    await h.refresh();
    assert.equal(h.read().training, undefined);
    assert.equal(h.saved().practice, true);
    assert.equal(h.saved().snapshot.context.learningExposure, true);
    assert.equal(h.model().training.available, false);
    assert(h.events().some((e) => e.kind === 'practice_mode'));
    assert(!h.events().some((e) => e.kind === 'training_peek'));
  } finally {
    h.close();
  }

  // A partial exposure during an existing concealed round must mark that round
  // immediately, before another complete snapshot/model is available.
  h = await boot({ visible: false });
  try {
    const id = h.saved().id;
    assert.equal(h.saved().practice, false);
    assert(h.q('#ff-learning').hidden);
    h.expose(true);
    h.ownCount.textContent = '?';
    await h.refresh();
    assert.equal(h.read().status, 'waiting');
    assert.equal(h.saved().id, id);
    assert.equal(h.saved().practice, true);
    assert(
      h
        .events()
        .some((e) => e.kind === 'training_exposure' && e.roundKey === h.saved().snapshot.roundKey),
    );
    h.expose(false);
    h.ownCount.textContent = '3';
    h.restart();
    await h.refresh();
    assert.equal(h.saved().id, id);
    assert.equal(h.saved().practice, true);
    assert.equal(h.saved().snapshot.context.learningExposure, true);
    assert.equal(h.model().training.available, false);
    assert(!h.q('#ff-learning').hidden);
  } finally {
    h.close();
  }
  console.log(
    'PASS Learning integration: real native DOM → content → trading/Learning UI → background; prediction/peek/continue persistence, frozen truth, blind-model isolation, worker restart, and both partial-exposure practice paths.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
