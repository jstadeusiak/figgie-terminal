const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const F = require('../extension/flow-chart.js');
const players = ['You', 'Bot-A', 'Bot-B', 'Bot-C', 'Bot-D'].map((name, i) => ({
  name,
  color: ['#3388ee', 'rgb(20, 170, 120)', '#ff6699', '#ccaa33', '#aa66cc'][i],
}));
function render(trades, n = 4, options = { width: 320, height: 74 }) {
  const snapshot = { self: 'You', players: players.slice(0, n), trades };
  const markup = F.render(snapshot, 's', options);
  const dom = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`);
  const doc = dom.window.document;
  return { snapshot, markup, doc, dom };
}
const trades = [
  { suit: 's', b: 'You', s: 'Bot-A', p: 4 },
  { suit: 'd', b: 'Bot-A', s: 'Bot-B', p: 3 },
  { suit: 's', b: 'Bot-A', s: 'You', p: 5 },
  { suit: 's', b: 'Bot-C', s: 'Bot-B', p: 6 },
  { suit: 's', b: 'Bot-C', s: 'Bot-B', p: 7 },
  { suit: 's', b: 'Bot-C', s: 'Bot-A', p: 8 },
];
for (const n of [4, 5])
  for (const width of [200, 320, 400]) {
    const { doc, dom } = render(trades, n, { width, height: n === 5 ? 86 : 74 });
    const lanes = [...doc.querySelectorAll('.ff-flow-lane')];
    assert.equal(lanes.length, n);
    assert.equal(
      lanes.reduce((a, g) => a + Number(g.dataset.net), 0),
      0,
      'all card transfers conserve inventory',
    );
    assert.deepEqual(
      lanes.slice(0, 4).map((g) => Number(g.dataset.net)),
      [0, -1, -2, 3],
    );
    assert.equal(
      lanes.reduce((a, g) => a + Number(g.dataset.buys), 0),
      5,
    );
    assert.equal(
      lanes.reduce((a, g) => a + Number(g.dataset.sells), 0),
      5,
    );
    const you = lanes[0];
    assert.equal(you.dataset.buys, '1');
    assert.equal(you.dataset.sells, '1');
    assert.match(
      you.querySelector('path').getAttribute('d'),
      /H[\d.]+V[\d.]+H[\d.]+V[\d.]+/,
      'a round trip must remain visible despite zero final net',
    );
    assert.equal(you.querySelectorAll('[data-direction="buy"]').length, 1);
    assert.equal(you.querySelectorAll('[data-direction="sell"]').length, 1);
    assert.equal(lanes[3].querySelectorAll('[data-direction="buy"]').length, 3);
    assert.equal(doc.querySelectorAll('.ff-flow-transfer').length, 10);
    assert.match(doc.querySelector('desc').textContent, /not total holdings/);
    assert.match(doc.querySelector('desc').textContent, /not elapsed time/);
    const tips = [...doc.querySelectorAll('.ff-flow-transfer title')].map((e) => e.textContent);
    assert(
      tips.some((t) => t.includes('trade 2 (round trade 3)') && t.includes('at 5 chips')),
      'suit and full round indices remain honest',
    );
    dom.window.close();
  }
const empty = render([], 5, { width: 200, height: 86 });
assert.equal(empty.doc.querySelectorAll('.ff-flow-path').length, 5);
assert.match(empty.markup, /No trades yet/);
assert(!empty.markup.includes('NaN'));
empty.dom.window.close();
const unsafe = F.render(
  {
    self: '<script>',
    players: [{ name: '<script>', color: 'url(https://example.com/p)' }, { name: 'A" onclick="x' }],
    trades: [],
  },
  's',
  { width: 200, height: 74 },
);
assert(!unsafe.includes('<script>'));
assert(!unsafe.includes('url('));
assert(unsafe.includes('&quot;'));
const original = JSON.stringify(trades);
F.render({ self: 'You', players, trades }, 's', { width: 200, height: 86 });
assert.equal(JSON.stringify(trades), original, 'renderer must not mutate snapshots');
for (const n of [4, 5]) {
  const snapshot = { self: 'You', players: players.slice(0, n), trades };
  const before = JSON.stringify(snapshot);
  const summary = F.summarize(snapshot, 's');
  assert.deepEqual(summary, {
    volume: 5,
    totalNet: 0,
    selfNet: 0,
    opponentNet: 0,
    largestAccumulators: [{ name: 'Bot-C', color: '#ccaa33', net: 3 }],
  });
  assert.equal(JSON.stringify(snapshot), before, 'flow summary must not mutate snapshots');
  const selfTrades = [
    { suit: 's', b: 'You', s: 'Bot-A', p: 4 },
    { suit: 's', b: 'You', s: 'Bot-C', p: 5 },
    { suit: 's', b: 'Bot-B', s: 'Bot-A', p: 6 },
  ];
  const buy = F.summarize({ ...snapshot, trades: selfTrades }, 's');
  assert.equal(buy.totalNet, 0);
  assert.equal(buy.selfNet, 2);
  assert.equal(buy.opponentNet, -buy.selfNet);
  assert.deepEqual(buy.largestAccumulators, [{ name: 'You', color: '#3388ee', net: 2 }]);
  const selling = F.summarize(
    { ...snapshot, trades: selfTrades.map((t) => ({ ...t, b: t.s, s: t.b })) },
    's',
  );
  assert.equal(selling.totalNet, 0);
  assert.equal(selling.selfNet, -2);
  assert.equal(selling.opponentNet, 2);
  const tied = F.summarize({ ...snapshot, trades: [selfTrades[0], selfTrades[2]] }, 's');
  assert.deepEqual(
    tied.largestAccumulators.map((p) => [p.name, p.net]),
    [
      ['You', 1],
      ['Bot-B', 1],
    ],
  );
  const roundTrip = F.summarize({ ...snapshot, trades: [trades[0], trades[2]] }, 's');
  assert.equal(roundTrip.volume, 2);
  assert.equal(roundTrip.totalNet, 0);
  assert.equal(roundTrip.opponentNet, 0);
  assert.deepEqual(roundTrip.largestAccumulators, []);
  const invalid = F.summarize(
    {
      ...snapshot,
      trades: [
        ...selfTrades,
        { suit: 's', b: 'You', s: 'You', p: 4 },
        { suit: 's', b: 'Unknown', s: 'You', p: 4 },
        { suit: 'c', b: 'You', s: 'Bot-A', p: 4 },
      ],
    },
    's',
  );
  assert.deepEqual(
    invalid,
    buy,
    'summaries and charts exclude self-transfers, unknown players and other suits',
  );
  assert.deepEqual(F.summarize({ ...snapshot, trades: [] }, 's'), {
    volume: 0,
    totalNet: 0,
    selfNet: 0,
    opponentNet: 0,
    largestAccumulators: [],
  });
}
assert.deepEqual(F.summarize(null, 's'), {
  volume: 0,
  totalNet: 0,
  selfNet: 0,
  opponentNet: 0,
  largestAccumulators: [],
});
console.log(
  'Flow totals: valid volume, conservation, opponent/self symmetry, positive leaders and ties, round trips, empty rounds, shared filtering and snapshot purity passed.',
);
console.log(
  'Player-flow charts: 4/5 players, shared scales, net conservation, round trips, accumulation, buy/sell marks, honest trade indices, escaping, empty rounds and pure rendering passed.',
);
