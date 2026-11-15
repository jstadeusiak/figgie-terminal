const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { setup, text, icon, boxes, colors } = require('./figgie-fixture.cjs');
const clone = (value) => JSON.parse(JSON.stringify(value));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source = fs.readFileSync('extension/content.js', 'utf8');
function longHistory(doc, pairs) {
  const rows = doc.getElementById('history-rows');
  for (let i = 0; i < pairs; i++)
    rows.insertAdjacentHTML(
      'beforeend',
      `<div>${text('Bot-Moth')}${icon('', boxes[0])}${text('Bot-Rabbit')}${text(3)}</div><div>${text('Bot-Rabbit')}${icon('', boxes[0])}${text('Bot-Moth')}${text(4)}</div>`,
    );
}
function profile(adapterFile, pairs) {
  const dom = setup();
  const w = dom.window;
  const doc = w.document;
  longHistory(doc, pairs);
  if (adapterFile) w.eval(fs.readFileSync(adapterFile, 'utf8'));
  let queries = 0;
  for (const method of ['querySelector', 'querySelectorAll']) {
    const original = w.Element.prototype[method];
    w.Element.prototype[method] = function (...args) {
      queries++;
      return original.apply(this, args);
    };
  }
  for (let i = 0; i < 6; i++) w.FiggieAdapter.read(doc);
  queries = 0;
  const timings = [];
  let snapshot;
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    snapshot = w.FiggieAdapter.read(doc);
    timings.push(performance.now() - started);
  }
  const { refs, ...plain } = snapshot;
  timings.sort((a, b) => a - b);
  const result = {
    trades: 1 + pairs * 2,
    medianMs: timings[15],
    p95Ms: timings[28],
    selectorsPerRead: queries / 30,
    snapshot: clone(plain),
  };
  dom.window.close();
  return result;
}
async function harness() {
  const dom = setup();
  const w = dom.window;
  const doc = w.document;
  const frames = new Map();
  const packets = [];
  const messages = [];
  const trace = [];
  const pending = [];
  let nextFrame = 0;
  let observer;
  let tick;
  let bridge;
  let now = Date.now();
  let autoAck = true;
  let reads = 0;
  const originalRead = w.FiggieAdapter.read;
  w.FiggieAdapter.read = (...args) => {
    reads++;
    return originalRead(...args);
  };
  w.Date.now = () => now;
  w.setInterval = (fn, ms) => {
    if (ms === 250) tick = fn;
    return ms;
  };
  w.clearInterval = () => {};
  w.requestAnimationFrame = (fn) => {
    const id = ++nextFrame;
    frames.set(id, fn);
    return id;
  };
  w.cancelAnimationFrame = (id) => frames.delete(id);
  w.MutationObserver = class {
    constructor(fn) {
      observer = fn;
    }
    observe() {}
    disconnect() {}
  };
  w.FiggieTerminalAssets = { css: '', html: '' };
  w.FiggieTerminalUI = {
    mount(shadow, value) {
      bridge = value;
      bridge.send({ type: 'ready' });
      return {
        receive(message) {
          messages.push(message);
          trace.push(message.type);
        },
      };
    },
  };
  function acknowledge(packet, response) {
    if (packet.done) return;
    packet.done = true;
    packet.callback(
      response || {
        recording: {
          observedRevision: Math.max(
            0,
            ...packet.message.batch
              .filter((e) => e.kind === 'observe')
              .map((e) => e.snapshot.analysisRevision),
          ),
          events: packet.message.batch.at(-1).seq,
        },
      },
    );
  }
  w.chrome = {
    runtime: {
      sendMessage(message, callback) {
        trace.push('ipc:' + message.type);
        const packet = { message: clone(message), callback, done: false };
        packets.push(packet);
        pending.push(packet);
        if (autoAck) queueMicrotask(() => acknowledge(packet));
      },
    },
  };
  async function drain() {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }
  function mutate(records) {
    observer(records);
  }
  async function frame() {
    const entries = [...frames.entries()];
    frames.clear();
    for (const [, fn] of entries) fn();
    await drain();
  }
  function changeText(node, value) {
    node.textContent = value;
    mutate([{ type: 'characterData', target: node.firstChild }]);
  }
  function newFill({ own = false } = {}) {
    const rows = doc.getElementById('history-rows');
    rows.insertAdjacentHTML(
      'afterbegin',
      `<div>${text(own ? 'Alice' : 'Bot-Moth')}${icon('', boxes[1])}${text('Bot-Cougar')}${text(3)}</div>`,
    );
    const tiles = Array.from(doc.getElementById('root').children).filter(
      (el) => el.tagName === 'SECTION' && el.querySelector('svg[id^="chip_"]'),
    );
    const cougar = tiles[1];
    const cougarRow = Array.from(cougar.querySelectorAll('svg')).find(
      (el) => el.getAttribute('viewBox') === boxes[1],
    ).parentElement;
    cougarRow.lastElementChild.textContent = '-1';
    cougar.querySelector('svg[id^="purple_cards_"]').nextElementSibling.textContent = '8';
    if (own)
      tiles[0]
        .querySelector('svg[id^="clubs_card_"]')
        .parentElement.querySelector('[dir="auto"]').textContent = '5';
    else {
      const moth = tiles[2];
      const mothRow = Array.from(moth.querySelectorAll('svg')).find(
        (el) => el.getAttribute('viewBox') === boxes[1],
      ).parentElement;
      mothRow.lastElementChild.textContent = '+1';
      moth.querySelector('svg[id^="purple_cards_"]').nextElementSibling.textContent = '11';
    }
    mutate([{ type: 'childList', target: rows }]);
  }
  w.eval(source);
  await drain();
  trace.length = 0;
  return {
    dom,
    w,
    doc,
    frames,
    packets,
    messages,
    trace,
    pending,
    read: () => originalRead(doc),
    reads: () => reads,
    drain,
    frame,
    mutate,
    changeText,
    newFill,
    acknowledge,
    setAutoAck(value) {
      autoAck = value;
    },
    command(command, id = 1) {
      bridge.send({ type: 'command', id, command });
    },
    async watchdog(ms = 250) {
      now += ms;
      tick();
      await drain();
    },
    close() {
      dom.window.close();
    },
  };
}
(async () => {
  const baselineArg = process.argv.find((arg) => arg.startsWith('--baseline='));
  const benchmarks = [];
  for (const pairs of [0, 25, 100]) {
    const current = profile(null, pairs);
    const before = baselineArg ? profile(baselineArg.slice(11), pairs) : null;
    assert(
      current.selectorsPerRead < 225 + current.trades,
      'DOM query budget must not grow with repeated whole-history scans',
    );
    if (before)
      assert.deepEqual(
        current.snapshot,
        before.snapshot,
        'optimized reader preserves the entire public snapshot',
      );
    delete current.snapshot;
    if (before) delete before.snapshot;
    benchmarks.push({ current, ...(before ? { before } : {}) });
  }
  let h = await harness();
  try {
    const animation = h.doc.querySelector('svg[id^="purple_cards_"]').parentElement;
    const before = h.reads();
    for (let i = 0; i < 60; i++) {
      const oldValue = animation.getAttribute('style');
      animation.setAttribute('style', `transform: translateY(${i}px); opacity: ${i / 60}`);
      h.mutate([{ type: 'attributes', attributeName: 'style', target: animation, oldValue }]);
      await h.frame();
    }
    assert.equal(h.reads(), before, '60 animation-only frames must not force 60 full reads');
    const owner = h.doc.querySelector('[data-row="s"]').lastElementChild.firstElementChild;
    const oldValue = owner.getAttribute('style');
    owner.style.backgroundColor = colors[3];
    h.mutate([{ type: 'attributes', attributeName: 'style', target: owner, oldValue }]);
    assert.equal(h.frames.size, 1);
    await h.frame();
    assert.equal(h.read().markets[0].seller, 'Bot-Rabbit');
    const s = h.read();
    let clicks = 0;
    s.refs.get('s').ask.button.addEventListener('click', () => {
      clicks++;
      h.trace.push('native-click');
    });
    h.trace.length = 0;
    h.command({
      kind: 'buy',
      suit: 's',
      price: s.markets[0].ask,
      owner: s.markets[0].seller,
      roundKey: s.roundKey,
      tradeCount: s.trades.length,
    });
    await h.drain();
    assert.equal(clicks, 1);
    assert(
      h.trace.indexOf('native-click') < h.trace.indexOf('ipc:figgie-record'),
      'native action precedes recording serialization',
    );
    assert(
      h.trace.indexOf('ack') < h.trace.indexOf('ipc:figgie-record'),
      'submission ACK precedes recording serialization',
    );
    const outcomeStart = h.messages.length;
    h.newFill();
    await h.frame();
    const outcome = h.messages.slice(outcomeStart).find((m) => m.type === 'order');
    assert.equal(outcome?.state, 'expired');
    assert.match(outcome.message, /Book reset/);
    assert.equal(clicks, 1, 'reset never retries the native action');
  } finally {
    h.close();
  }

  h = await harness();
  try {
    const s = h.read();
    const input = s.refs.get('c').bid.input;
    let enters = 0;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') enters++;
    });
    h.command({
      kind: 'bid',
      suit: 'c',
      price: 7,
      roundKey: s.roundKey,
      tradeCount: s.trades.length,
    });
    await h.drain();
    assert.equal(input.value, '7');
    assert.equal(enters, 0);
    h.newFill({ own: true });
    await h.frame();
    await h.drain();
    assert.equal(enters, 0, 'fill/reset during controlled-input frame prevents stale Enter');
    assert(
      h.messages.some(
        (m) => m.type === 'reject' && /Market changed before posting/.test(m.message),
      ),
    );
    assert(
      h.messages.some((m) => m.type === 'snapshot' && m.snapshot.trades.length === 2),
      'new fill reaches the view in the same refresh',
    );
  } finally {
    h.close();
  }

  h = await harness();
  try {
    h.setAutoAck(false);
    const firstPacket = h.packets.length;
    const price =
      h.doc.querySelector('[data-row="s"]').firstElementChild.firstElementChild.firstElementChild;
    for (let i = 0; i < 45; i++) {
      h.changeText(price, String(i + 10));
      await h.frame();
    }
    let open = h.pending.filter((packet) => !packet.done);
    assert.equal(open.length, 2, 'slow storage cannot create unbounded transport concurrency');
    assert(open[1].message.batch.length > open[0].message.batch.length);
    assert.deepEqual(
      open[1].message.batch.slice(0, open[0].message.batch.length),
      open[0].message.batch,
      'later packet retains unacknowledged prefix',
    );
    // Deliver the later write first, then an older error. Its durable prefix
    // covers both packets, so the obsolete error cannot regress REC state.
    h.acknowledge(open[1]);
    await h.drain();
    h.acknowledge(open[0], { error: 'obsolete failed first flight' });
    await h.drain();
    while ((open = h.pending.filter((packet) => !packet.done)).length) {
      for (const packet of open) h.acknowledge(packet);
      await h.drain();
    }
    const events = new Map();
    for (const packet of h.packets.slice(firstPacket))
      for (const event of packet.message.batch) events.set(event.seq, event);
    const observations = [...events.values()].filter((e) => e.kind === 'observe');
    assert.equal(
      observations.length,
      45,
      'all coalesced recording observations survive slow/out-of-order durability',
    );
    assert.deepEqual(
      observations.map((e) => e.snapshot.markets[0].bid).sort((a, b) => a - b),
      Array.from({ length: 45 }, (_, i) => i + 10),
    );
    assert(
      !h.messages.some(
        (m) => m.type === 'recording' && m.recording.error === 'obsolete failed first flight',
      ),
    );
    // A real uncovered failure must retain the exact prefix and retry it.
    const previousPackets = h.packets.length;
    h.changeText(price, '80');
    await h.frame();
    const failed = h.pending.find((packet) => !packet.done);
    h.acknowledge(failed, { error: 'simulated storage failure' });
    await h.drain();
    await pause(1050);
    await h.drain();
    const retry = h.pending.find((packet) => !packet.done);
    assert(retry);
    assert.deepEqual(retry.message.batch, failed.message.batch);
    h.acknowledge(retry);
    await h.drain();
    assert(h.packets.length >= previousPackets + 2);
  } finally {
    h.close();
  }
  console.log(
    JSON.stringify(
      {
        tests:
          'PASS: animation filtering, source ownership updates, action/ACK priority, take-reset expiration, post-frame stale guard, immediate fills, bounded lossless recording pipeline and retries',
        benchmarks,
        environment: 'JSDOM warm 30 reads per fixture; relative CPU proxy, not browser latency',
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
