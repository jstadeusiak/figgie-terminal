const assert = require('node:assert/strict');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { fixture, model } = require('./learning-fixture.cjs');
const dom = new JSDOM('<div id="host"></div>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://www.figgie.com/play/',
});
const w = dom.window;
const doc = w.document;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const events = [];
  const s = fixture();
  const m = model(s);
  let reply = null;
  w.ResizeObserver = class {
    observe() {}
  };
  w.chrome = {
    runtime: {
      sendMessage(message, cb) {
        if (message.type === 'figgie-model') reply = () => cb({ model: m });
      },
    },
  };
  for (const f of ['pnl.js', 'ui-assets.js', 'flow-chart.js', 'training-ui.js', 'ui.js'])
    w.eval(fs.readFileSync('extension/' + f, 'utf8'));
  const shadow = doc.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' + w.FiggieTerminalAssets.css + '</style>' + w.FiggieTerminalAssets.html;
  const ui = w.FiggieTerminalUI.mount(shadow, { send: (e) => events.push(e) });
  const q = (x) => shadow.querySelector(x);
  const click = (x) => q(x).click();
  ui.receive({ type: 'snapshot', snapshot: s });
  await pause(140);
  reply();
  assert(!q('#ff-learning').hidden);
  click('#ff-learning');
  assert(!q('.ff-learning-overlay').hidden);
  assert(!q('#ff-learn-body').textContent.includes('Actual goal'));
  assert(!q('#ff-learn-body').textContent.includes('12 cards across'));
  q('#ff-keys').checked = true;
  doc.body.dispatchEvent(
    new w.KeyboardEvent('keydown', { key: '1', bubbles: true, composed: true, cancelable: true }),
  );
  assert(!events.some((e) => e.type === 'command'), 'dialog blocks trade hotkeys');
  const input = q('[data-prob="0"]');
  input.value = '30';
  click('[data-learn="save"]');
  assert(q('#ff-learn-error').textContent.includes('100%'));
  assert(!events.some((e) => e.kind === 'training_prediction'));
  input.value = '25';
  q('#ff-learn-count').value = '3';
  q('#ff-learn-suit').value = '1';
  q('#ff-learn-reason').value = 'Lynx keeps buying clubs.';
  click('[data-learn="save"]');
  assert.equal(events.filter((e) => e.kind === 'training_prediction').length, 1);
  const prediction = events.find((e) => e.kind === 'training_prediction').data;
  assert(!prediction.truth);
  assert(!prediction.afterPeek);
  assert.equal(
    prediction.userProbabilities.reduce((a, b) => a + b, 0),
    1,
  );
  assert(q('#ff-learn-body').textContent.includes('Blind trading model'));
  assert(!q('#ff-learn-body').textContent.includes('Actual goal'));
  assert.equal(q('.ff-learn-hands tbody').children.length, 1);
  click('[data-reveal="Bot-Lynx"]');
  assert(q('#ff-learn-body').textContent.includes('Your hand + 1 revealed'));
  assert(q('#ff-learn-body').textContent.includes('actually'));
  assert.equal(q('.ff-learn-hands tbody').children.length, 2);
  assert(!q('#ff-learn-body').textContent.includes('Actual goal'));
  click('[data-learn="all"]');
  assert(q('#ff-learn-body').textContent.includes('Actual goal'));
  assert(q('#ff-learn-body').textContent.includes('+53.00'));
  assert.equal(q('.ff-learn-hands tbody').children.length, 4);
  assert(q('#ff-learn-body').textContent.includes('Brier loss'));
  const before = q('#ff-learn-body').innerHTML;
  ui.receive({ type: 'heartbeat', timer: '1:59', status: 'live' });
  assert.equal(q('#ff-learn-body').innerHTML, before, 'checkpoint remains frozen');
  assert(q('#ff-learn-live').textContent.includes('1:59'));
  click('[data-learn="continue"]');
  assert(q('.ff-learning-overlay').hidden);
  click('#ff-learning');
  click('[data-learn="new"]');
  assert(q('#ff-learn-body').textContent.includes('After a peek'));
  assert(!q('#ff-learn-body').textContent.includes('Actual goal'));
  ui.receive({ type: 'fault', message: 'Test disconnect' });
  assert(q('[data-learn="save"]').disabled, 'stale source cannot freeze checkpoint');
  const next = fixture();
  next.roundKey = 'next-round';
  ui.receive({ type: 'snapshot', snapshot: next });
  assert(q('.ff-learning-overlay').hidden, 'new round closes old checkpoint');
  click('#ff-learning');
  assert(q('#ff-learn-body').textContent.includes('Before your first terminal peek'));
  ui.receive({ type: 'recording', recording: { roundKey: 'old-round', practicePeeked: true } });
  click('[data-learn="close"]');
  click('#ff-learning');
  assert(
    !q('#ff-learn-body').textContent.includes('After a peek'),
    'old record cannot contaminate new round',
  );
  ui.receive({
    type: 'recording',
    recording: { roundKey: next.roundKey, practice: true, practicePeeked: true },
  });
  click('[data-learn="close"]');
  click('#ff-learning');
  assert(q('#ff-learn-body').textContent.includes('After a peek'), 'peek marker restored');
  doc.body.dispatchEvent(
    new w.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  assert(q('.ff-learning-overlay').hidden);
  const normal = fixture();
  normal.roundKey = 'concealed';
  delete normal.training;
  ui.receive({ type: 'snapshot', snapshot: normal });
  assert(q('#ff-learning').hidden, 'normal rounds keep original layout');
  console.log(
    'PASS training UI: no truth before peek, partial/full reveal, frozen checkpoint, inventory feedback, validation, hotkey isolation, stale-source guard, new-round reset, durable peek restoration, concealed-round isolation.',
  );
  w.close();
})().catch((e) => {
  w.close();
  console.error(e);
  process.exitCode = 1;
});
