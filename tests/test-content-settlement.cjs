/* Exercise real content.refresh against the real background dispatcher. Only the
   DOM adapter/view and Chrome transport are stubbed; worker storage uses the
   shared background test harness. No extension session or user data is touched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { start, db, copy } = require('./background-harness.cjs');
const IDS = ['s', 'c', 'd', 'h'];
const names = ['You', 'Bot-A', 'Bot-B', 'Bot-C'];
function round(number, goal) {
  const g = IDS.indexOf(goal);
  const hand = g === 0 ? [4, 4, 1, 1] : [1, 1, 4, 4];
  const profits = { You: 50, 'Bot-A': 50, 'Bot-B': -50, 'Bot-C': -50 };
  const banks = Object.fromEntries(names.map((name) => [name, 400 + profits[name]]));
  const result = {
    goal,
    verified: true,
    source: 'official-round-rankings',
    profits,
    banks,
    settledProfit: profits.You,
    settledBank: banks.You,
  };
  const live = {
    status: 'live',
    self: 'You',
    room: 'Content regression',
    round: number,
    roundKey: 'content-round-' + number,
    signature: 'content-round-' + number + '-live',
    cash: 350,
    held: hand,
    startingHand: hand,
    players: names.map((name) => ({ name, cards: 10, cash: 350 })),
    trades: [],
    net: names.map(() => [0, 0, 0, 0]),
    timer: '3:00',
    context: { botDifficulty: 'Medium' },
    markets: IDS.map((id) => ({ id, bid: null, ask: null, buyer: null, seller: null })),
  };
  const ended = copy(live);
  ended.status = 'ended';
  ended.signature = 'content-round-' + number + '-ended';
  ended.timer = '0:00';
  ended.cash = banks.You;
  ended.roundResult = result;
  ended.players.forEach((p) => (p.cash = banks[p.name]));
  return { live, ended, result };
}
(async () => {
  db.rounds.clear();
  db.events.clear();
  db.learning.clear();
  const first = round(1, 's');
  const second = round(2, 'h');
  const packets = [];
  const settlementReads = [];
  const pending = new Set();
  let current = first.live;
  let sendWorker = start();
  let tick;
  let now = Date.now();
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'https://www.figgie.com/play/',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  w.Date.now = () => now;
  w.setInterval = (fn) => {
    tick = fn;
    return 1;
  };
  w.requestAnimationFrame = () => 1;
  w.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  w.FiggieTerminalAssets = { css: '', html: '' };
  w.FiggieTerminalUI = { mount: () => ({ receive() {} }) };
  w.FiggieAdapter = {
    read: () => ({ ...copy(current), refs: new Map() }),
    readContext: () => ({ botDifficulty: 'Medium' }),
    readSettlement: (document, previous) => {
      if (current.status !== 'ended') return null;
      settlementReads.push({
        expected: current.roundKey,
        roundKey: previous.roundKey,
        status: previous.status,
        signature: previous.signature,
      });
      assert.equal(previous.roundKey, current.roundKey, 'settlement must use the current round');
      assert.equal(previous.status, 'ended', 'lastSnapshot must update before settlement capture');
      assert.equal(previous.signature, current.signature, 'settlement must use the final snapshot');
      return copy(current.roundResult);
    },
  };
  w.chrome = {
    runtime: {
      sendMessage(message, callback) {
        packets.push(copy(message));
        const task = sendWorker(copy(message)).then((response) => {
          assert(!response.error, response.error);
          callback(response);
        });
        pending.add(task);
        task.finally(() => pending.delete(task));
      },
    },
  };
  async function drain() {
    while (pending.size) await Promise.all([...pending]);
    await Promise.resolve();
  }
  async function refresh(snapshot) {
    current = snapshot;
    now += 1500;
    tick();
    await drain();
  }
  function recordItems(from) {
    return packets
      .slice(from)
      .filter((p) => p.type === 'figgie-record')
      .flatMap((p) => p.batch);
  }
  try {
    w.eval(fs.readFileSync('extension/content.js', 'utf8'));
    assert.equal(typeof tick, 'function');
    await drain();
    for (const [index, r] of [first, second].entries()) {
      if (index) await refresh(r.live);
      const before = [...db.rounds.values()].find(
        (row) => row.snapshot.roundKey === r.live.roundKey,
      );
      assert(before, 'live round recorded');
      const model = await sendWorker({
        type: 'figgie-model',
        job: { id: index + 1, snapshot: r.live },
      });
      assert(!model.error, model.error);
      await sendWorker({ type: 'figgie-record-status' }); // Persist the live forecast before restarting its worker.
      sendWorker = start();
      const from = packets.length;
      await refresh(r.ended);
      const items = recordItems(from);
      const observe = items.findIndex(
        (item) => item.kind === 'observe' && item.snapshot.status === 'ended',
      );
      const reveal = items.findIndex((item) => item.kind === 'reveal');
      assert(
        observe >= 0 && reveal > observe,
        'ended observation must precede native reveal across transport packets',
      );
      assert.equal(items[observe].snapshot.roundKey, r.live.roundKey);
      assert.equal(items[reveal].result.goal, r.result.goal);
      const saved = db.rounds.get(before.id);
      assert.equal(
        saved.revealed?.goal,
        r.result.goal,
        'fresh worker persists the correct revealed goal',
      );
      assert.equal(saved.pendingSettlement, null);
      const scored = (kind) =>
        [...db.events.values()].filter((e) => e.roundId === before.id && e.kind === kind);
      assert.equal(scored('round_score').length, 1);
      assert.equal(scored('bonus_score').length, 1);
      // A repeated ended refresh cannot duplicate the durable result or metrics.
      await refresh(r.ended);
      assert.equal(scored('round_score').length, 1);
      assert.equal(scored('bonus_score').length, 1);
    }
    assert.equal(settlementReads.length, 4);
    assert.equal(db.learning.get('global').bonusMetrics.rounds, 2);
    console.log(
      JSON.stringify(
        {
          content: 'real refresh function',
          worker: 'restarted immediately before each end transition',
          ordering: 'ended observe before native reveal',
          identity: 'two different current rounds and goals preserved',
          persistence: 'one goal and bonus score per round, no pending settlement',
        },
        null,
        2,
      ),
    );
  } finally {
    dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
