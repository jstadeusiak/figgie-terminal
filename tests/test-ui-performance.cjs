const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { JSDOM } = require('jsdom');
const { fixture, model } = require('./learning-fixture.cjs');
const baselineDirectory = process.env.FIGGIE_UI_BASELINE_DIR;
const baseline = Boolean(baselineDirectory);
const dom = new JSDOM('<div id="host"></div>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://www.figgie.com/play/',
});
const w = dom.window;
const doc = w.document;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const copy = (x) => JSON.parse(JSON.stringify(x));
(async () => {
  const s = fixture();
  delete s.training;
  s.context = { botDifficulty: 'Medium' };
  s.analysisRevision = 1;
  if (!baseline) s.recordingRequired = true;
  for (let i = 0; i < 80; i++) {
    const t = {
      suit: ['s', 'c', 'd', 'h'][i % 4],
      b: i % 8 < 4 ? 'Bot-Lynx' : 'Bot-Deer',
      s: i % 8 < 4 ? 'Bot-Deer' : 'Bot-Lynx',
      p: 3,
    };
    s.trades.push(t);
    s.markets[i % 4].fills.push(t);
  }
  const m = model(s);
  const jobs = [];
  const commands = [];
  let tally = null;
  const stat = (key) => {
    if (tally) tally[key] = (tally[key] || 0) + 1;
  };
  for (const proto of [w.Element.prototype, w.DocumentFragment.prototype, w.Document.prototype])
    for (const name of ['querySelector', 'querySelectorAll']) {
      const old = proto[name];
      proto[name] = function (...args) {
        stat('queries');
        return old.apply(this, args);
      };
    }
  const inner = Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML');
  Object.defineProperty(w.Element.prototype, 'innerHTML', {
    ...inner,
    set(v) {
      stat('htmlWrites');
      return inner.set.call(this, v);
    },
  });
  const val = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(w.HTMLTextAreaElement.prototype, 'value', {
    ...val,
    set(v) {
      if (this.id === 'diagnostics') {
        stat('diagnosticsWrites');
        if (tally) tally.diagnosticsBytes = (tally.diagnosticsBytes || 0) + v.length;
      }
      return val.set.call(this, v);
    },
  });
  const stringify = w.JSON.stringify;
  w.JSON.stringify = function (...args) {
    const text = stringify.apply(this, args);
    stat('stringifies');
    if (tally) tally.stringifyBytes = (tally.stringifyBytes || 0) + (text?.length || 0);
    return text;
  };
  Object.defineProperty(w.SVGElement.prototype, 'clientWidth', {
    get() {
      stat('layoutReads');
      return 380;
    },
  });
  Object.defineProperty(w.SVGElement.prototype, 'clientHeight', {
    get() {
      stat('layoutReads');
      return 90;
    },
  });
  w.ResizeObserver = class {
    observe() {}
  };
  w.chrome = {
    runtime: {
      sendMessage(message, reply) {
        if (message.type === 'figgie-model') jobs.push({ message, reply });
      },
    },
  };
  for (const f of ['pnl.js', 'ui-assets.js', 'flow-chart.js', 'training-ui.js', 'ui.js'])
    w.eval(
      fs.readFileSync(
        baseline && ['flow-chart.js', 'training-ui.js', 'ui.js'].includes(f)
          ? path.join(baselineDirectory, f)
          : 'extension/' + f,
        'utf8',
      ),
    );
  for (const name of ['render', 'summarize']) {
    const fn = w.FiggieFlowChart[name];
    w.FiggieFlowChart[name] = (...args) => {
      stat('flow' + name);
      return fn(...args);
    };
  }
  const shadow = doc.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' + w.FiggieTerminalAssets.css + '</style>' + w.FiggieTerminalAssets.html;
  const ui = w.FiggieTerminalUI.mount(shadow, {
    send: (e) => {
      if (e.type === 'command')
        commands.push({ at: performance.now(), event: e, workBeforeSend: { ...tally } });
    },
  });
  const q = (x) => shadow.querySelector(x);
  ui.receive({ type: 'snapshot', snapshot: s });
  await pause(20);
  assert.equal(jobs.length, 1);
  jobs.shift().reply({ model: m });
  await pause(25);
  const field = q('form[data-id="c"][data-kind="bid"] input');
  field.value = '3';
  field.focus();
  tally = {};
  let start = performance.now();
  for (let i = 0; i < 60; i++) {
    const x = copy(s);
    x.analysisRevision = i + 2;
    x.signature = 'quote-' + i;
    x.markets[0].ask = 7 + (i % 3);
    ui.receive({ type: 'snapshot', snapshot: x });
  }
  await pause(25);
  const quotes = { ...tally, elapsedMs: performance.now() - start };
  assert.equal(field.value, '3');
  assert.equal(shadow.activeElement, field, 'quote rendering preserves draft focus');
  tally = {};
  start = performance.now();
  q('[data-action="buy"][data-id="s"]').click();
  const order = {
    ...tally,
    elapsedMs: performance.now() - start,
    beforeSend: commands.at(-1)?.workBeforeSend,
  };
  assert.equal(commands.length, 1, 'manual action dispatched once');
  assert(q('[data-action="buy"][data-id="s"]').disabled, 'pending action disabled immediately');
  ui.receive({ type: 'reject', id: commands[0].event.id, message: 'test rejection' });
  assert(
    !q('[data-action="buy"][data-id="s"]').disabled,
    'fast rejection re-enables lane before deferred repaint',
  );
  tally = {};
  start = performance.now();
  for (let i = 0; i < 60; i++)
    ui.receive({ type: 'heartbeat', timer: '2:30', status: 'live', analysisRevision: 61 });
  await pause(25);
  const heartbeat = { ...tally, elapsedMs: performance.now() - start };
  if (!baseline && jobs.length) {
    const updated = copy(s);
    updated.analysisRevision = 70;
    updated.markets[0].ask = 10;
    ui.receive({ type: 'snapshot', snapshot: updated });
    jobs.shift().reply({ superseded: true, error: 'Model snapshot was superseded' });
    assert(
      !q('#ff-notice').textContent.includes('Model paused'),
      'superseded work does not flash a failure',
    );
    await pause(150);
    assert.equal(jobs.length, 1);
    assert.equal(
      jobs[0].message.job.snapshot.analysisRevision,
      70,
      'newest job reaches worker without a durable record ACK',
    );
  }
  tally = {};
  // A fill invalidates fair values and clears drafts synchronously, before a model reply.
  const filled = copy(s);
  filled.analysisRevision = 100;
  filled.signature = 'fill';
  const t = { suit: 'h', b: 'Bot-Lynx', s: 'Bot-Deer', p: 2 };
  filled.trades.push(t);
  filled.markets[3].fills.push(t);
  filled.net[1][3]++;
  filled.net[2][3]--;
  ui.receive({ type: 'snapshot', snapshot: filled });
  assert.equal(field.value, '');
  assert.equal(q('[data-suit="s"] [data-value="fair"]').textContent, '—');
  ui.receive({ type: 'fault', message: 'offline' });
  assert(
    [...shadow.querySelectorAll('[data-action]')].every((b) => b.disabled),
    'stale source disables execution synchronously',
  );
  await pause(25);
  const fill = { ...tally };
  if (!baseline) {
    assert.equal(fill.flowrender, 1, 'only changed suit chart repaints after one fill');
    assert.equal(fill.layoutReads, 2, 'unchanged charts avoid layout reads');
  }
  tally = null;
  await pause(140);
  assert(jobs.length <= 1, 'single in-flight model');
  if (jobs.length) {
    jobs.shift().reply({ model: m });
    await pause(150);
    assert(jobs.length <= 1, 'only newest queued model is sent');
    if (jobs.length) assert.equal(jobs[0].message.job.snapshot.analysisRevision, 100);
  }
  if (!baseline) {
    assert.equal(quotes.diagnosticsWrites || 0, 0, 'closed diagnostics are not serialized');
    assert.equal(quotes.flowrender || 0, 0, 'quote-only updates do not redraw unchanged charts');
    assert.equal(quotes.flowsummarize || 0, 0, 'quote-only updates do not rescan unchanged flow');
    assert.equal(
      order.beforeSend?.htmlWrites || 0,
      0,
      'command sends before nonessential HTML rendering',
    );
    assert((quotes.queries || 0) < 2500, 'static DOM lookup budget');
  }
  const prepared = w.FiggieFlowChart.prepare?.(filled);
  if (prepared)
    for (const id of ['s', 'c', 'd', 'h'])
      assert.equal(
        w.FiggieFlowChart.render(filled, id, { prepared }),
        w.FiggieFlowChart.render(filled, id),
        'shared preparation preserves chart output',
      );
  const details = q('#diagnostics').closest('details');
  details.open = true;
  await pause(10);
  assert.equal(
    JSON.parse(q('#diagnostics').value).self,
    s.self,
    'diagnostics populate when opened',
  );
  details.open = false;
  if (!baseline) {
    const ended = copy(filled);
    ended.status = 'ended';
    ended.analysisRevision = 110;
    ended.cash = 267;
    ended.roundResult = {
      verified: true,
      source: 'official-round-rankings',
      settledProfit: 17,
      settledBank: 267,
      goal: 's',
    };
    ui.receive({ type: 'snapshot', snapshot: ended });
    const finalPnl = {
      roundKey: ended.roundKey,
      actualPnl: 17,
      actualPayout: 67,
      source: 'Official round result',
      settlementPending: false,
    };
    ui.receive({
      type: 'recording',
      recording: {
        roundKey: ended.roundKey,
        observedRevision: 110,
        pnl: finalPnl,
        events: 200,
        pendingEvents: 8,
      },
    });
    assert.equal(q('#pnl-total').textContent, '+17.00');
    ui.receive({
      type: 'recording',
      recording: {
        roundKey: ended.roundKey,
        observedRevision: 109,
        pnl: { ...finalPnl, actualPnl: null, actualPayout: null },
        practice: true,
        events: 190,
        pendingEvents: 0,
        error: 'disk test',
      },
    });
    assert.equal(q('#pnl-total').textContent, '+17.00', 'late ACK cannot erase a newer final P&L');
    assert.equal(q('#pnl-state').textContent, 'Final');
    assert.equal(
      q('#recording-state').textContent,
      'REC ERROR',
      'stale round facts do not suppress storage failures',
    );
    const next = copy(s);
    next.roundKey = 'next-round';
    next.analysisRevision = 1;
    ui.receive({ type: 'snapshot', snapshot: next });
    ui.receive({
      type: 'recording',
      recording: {
        roundKey: next.roundKey,
        observedRevision: 1,
        pnl: { ...finalPnl, roundKey: next.roundKey, actualPnl: 9 },
        events: 1,
      },
    });
    assert.equal(q('#pnl-total').textContent, '+9.00', 'record revision resets with a new round');
    ui.receive({
      type: 'recording',
      recording: {
        roundKey: ended.roundKey,
        observedRevision: 999,
        pnl: finalPnl,
        practice: true,
        events: 201,
        pendingEvents: 0,
      },
    });
    assert.equal(
      q('#pnl-total').textContent,
      '+9.00',
      'previous-round ACK cannot replace current accounting',
    );
    ui.receive({
      type: 'recording',
      recording: {
        roundKey: next.roundKey,
        observedRevision: 2,
        pnl: { ...finalPnl, roundKey: next.roundKey, actualPnl: 10 },
        events: 2,
      },
    });
    assert.equal(
      q('#pnl-total').textContent,
      '+10.00',
      'old-round revision does not block current updates',
    );
    ui.receive({ type: 'snapshot', snapshot: ended });
    ui.receive({
      type: 'recording',
      recording: {
        roundKey: ended.roundKey,
        observedRevision: 109,
        pnl: { ...finalPnl, actualPnl: null, actualPayout: null },
        events: 190,
      },
    });
    assert.equal(
      q('#pnl-total').textContent,
      '+17.00',
      'official snapshot beats an initial lagging journal summary too',
    );
  }
  console.log(
    JSON.stringify(
      { mode: baseline ? 'before' : 'after', quotes, order, heartbeat, fill },
      null,
      2,
    ),
  );
  w.close();
})().catch((e) => {
  w.close();
  console.error(e);
  process.exitCode = 1;
});
