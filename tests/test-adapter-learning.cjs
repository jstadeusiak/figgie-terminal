const assert = require('node:assert/strict');
const { setup, names, colors, cards, boxes, text, icon } = require('./figgie-fixture.cjs');
const clone = (value) => JSON.parse(JSON.stringify(value));
const four = [
  [2, 4, 4, 0],
  [4, 1, 2, 3],
  [3, 2, 2, 3],
  [3, 1, 2, 4],
];
const five = [
  [2, 2, 2, 2],
  [3, 1, 2, 2],
  [3, 1, 2, 2],
  [2, 2, 2, 2],
  [2, 2, 2, 2],
];
const allNames = [...names, 'Bot-Fox'];
const allColors = [...colors, 'rgb(165, 91, 205)'];
const trade = { b: 'Alice', s: 'Bot-Cougar', suit: 0, p: 1 };
const signed = (n) => (n > 0 ? '+' + n : n < 0 ? String(n) : ' ');
function game({ initial = four, visible = true, full = false, trades = [trade] } = {}) {
  const dom = setup();
  const doc = dom.window.document;
  const root = doc.getElementById('root');
  const n = initial.length;
  const net = initial.map(() => [0, 0, 0, 0]);
  const held = clone(initial);
  for (const t of trades) {
    const b = allNames.indexOf(t.b);
    const s = allNames.indexOf(t.s);
    net[b][t.suit]++;
    net[s][t.suit]--;
    held[b][t.suit]++;
    held[s][t.suit]--;
  }
  const original = Array.from(root.children).filter(
    (el) => el.tagName === 'SECTION' && el.querySelector('svg[id^="chip_"]'),
  );
  const header = (i) =>
    `<header style="background-color:${allColors[i]}">${text(allNames[i])}<div>${icon('chip_desktop_svg__a')}${text(i === 0 ? 299 : 300)}</div></header>`;
  const suitRows = (i, isFull) =>
    held[i]
      .map(
        (value, s) =>
          `<div data-hand-suit="${s}">${isFull ? text(value) + icon(cards[s] + '_card_desktop_svg__a', '0 0 60 90') : text(visible ? value : ' ') + icon('', boxes[s])}${text(signed(net[i][s]))}</div>`,
      )
      .join('');
  const panels = [];
  for (let i = 0; i < n; i++) {
    const panel = doc.createElement('section');
    panel.dataset.player = allNames[i];
    panel.innerHTML =
      header(i) +
      (i > 0 && !full
        ? icon('purple_cards_desktop_svg__a') + text(held[i].reduce((a, b) => a + b, 0))
        : '') +
      `<div>${suitRows(i, i === 0 || full)}</div>`;
    original[0].before(panel);
    panels.push(panel);
  }
  original.forEach((el) => el.remove());
  doc.getElementById('history-rows').innerHTML = trades
    .slice()
    .reverse()
    .map((t) => `<div>${text(t.b)}${icon('', boxes[t.suit])}${text(t.s)}${text(t.p)}</div>`)
    .join('');
  const read = () => dom.window.FiggieAdapter.read(doc);
  return { dom, doc, root, panels, initial, held, net, read };
}
function cleanInvalid(snapshot) {
  assert.equal(snapshot.training?.enabled, true);
  assert.equal(snapshot.training.handsVisible, true);
  assert.equal(snapshot.training.valid, false);
  assert.equal(typeof snapshot.training.reason, 'string');
  assert(snapshot.training.reason.length > 0);
  for (const key of ['hands', 'startingHands', 'deckTotals', 'goal'])
    assert.equal(
      Object.hasOwn(snapshot.training, key),
      false,
      'invalid truth must not expose ' + key,
    );
}
function complete(g) {
  const snapshot = g.read();
  const expectedNames = allNames.slice(0, g.initial.length);
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.self, 'Alice');
  assert.deepEqual(clone(snapshot.held), g.held[0]);
  assert.equal(snapshot.training.enabled, true);
  assert.equal(snapshot.training.handsVisible, true);
  assert.equal(snapshot.training.valid, true);
  assert.equal(snapshot.training.source, 'visible-live-hands');
  assert.deepEqual(clone(snapshot.players.map((p) => p.name)), expectedNames);
  assert.deepEqual(
    clone(snapshot.players.map((p) => p.color)),
    allColors.slice(0, g.initial.length),
  );
  assert.deepEqual(
    clone(snapshot.players.map((p) => p.cards)),
    g.held.map((row) => row.reduce((a, b) => a + b, 0)),
  );
  assert.deepEqual(clone(snapshot.players.slice(1).map((p) => p.observedNet)), g.net.slice(1));
  assert.deepEqual(
    clone(snapshot.training.hands),
    Object.fromEntries(expectedNames.map((name, i) => [name, g.held[i]])),
  );
  assert.deepEqual(
    clone(snapshot.training.startingHands),
    Object.fromEntries(expectedNames.map((name, i) => [name, g.initial[i]])),
  );
  assert.deepEqual(clone(snapshot.training.deckTotals), [12, 8, 10, 10]);
  for (const p of snapshot.players)
    for (const key of ['hand', 'held', 'hands', 'startingHand', 'startingHands'])
      assert.equal(Object.hasOwn(p, key), false, 'opponent truth must remain namespaced');
  return snapshot;
}

// Native concealed and Learning use the same purple backs; only count slots differ.
{
  const g = game({ visible: false });
  const s = g.read();
  assert.equal(s.training, undefined);
  assert.equal(s.self, 'Alice');
  assert.equal(s.players.length, 4);
  g.dom.window.close();
}
for (const options of [{}, { initial: five }, { full: true }, { initial: five, full: true }]) {
  const g = game(options);
  complete(g);
  g.dom.window.close();
}

for (const value of [' ', '?', '13', '-1']) {
  const g = game();
  g.panels[1].querySelector('[data-hand-suit="1"] [dir="auto"]').textContent = value;
  cleanInvalid(g.read());
  g.dom.window.close();
}
{
  const g = game();
  for (const row of g.panels[2].querySelectorAll('[data-hand-suit]'))
    row.querySelector('[dir="auto"]').textContent = ' ';
  cleanInvalid(g.read());
  g.dom.window.close();
}
{
  const g = game();
  g.panels[3].remove();
  const s = g.read();
  assert.equal(s.status, 'waiting');
  cleanInvalid(s);
  g.dom.window.close();
}
{
  const g = game();
  g.panels[0].querySelector('[data-hand-suit="0"] [dir="auto"]').textContent = '?';
  const s = g.read();
  assert.equal(s.status, 'waiting');
  cleanInvalid(s);
  g.dom.window.close();
}
{
  const g = game();
  g.panels[0].querySelector('[data-hand-suit="0"]').remove();
  const s = g.read();
  assert.equal(s.status, 'waiting');
  cleanInvalid(s);
  g.dom.window.close();
}
{
  const g = game();
  g.doc.getElementById('history-rows').replaceChildren();
  const s = g.read();
  assert.equal(s.status, 'waiting');
  cleanInvalid(s);
  assert.match(s.training.reason, /consistent hand and history/);
  g.dom.window.close();
}
{
  const g = game({
    initial: [
      [2, 4, 4, 0],
      [4, 1, 2, 3],
      [3, 2, 2, 3],
      [2, 1, 3, 4],
    ],
  });
  cleanInvalid(g.read());
  assert.match(g.read().training.reason, /legal 40-card deck/);
  g.dom.window.close();
}
{
  const g = game();
  g.panels[1].querySelector('[data-hand-suit="0"] [dir="auto"]').textContent = '4';
  cleanInvalid(g.read());
  assert.match(g.read().training.reason, /public card totals/);
  g.dom.window.close();
}
{
  // A globally legal deck with final holdings cannot excuse an impossible earlier sale.
  const initial = [
    [2, 4, 4, 0],
    [4, 1, 2, 3],
    [3, 2, 2, 3],
    [3, 1, 2, 4],
  ];
  const impossible = [
    { b: 'Bot-Cougar', s: 'Alice', suit: 3, p: 1 },
    { b: 'Alice', s: 'Bot-Cougar', suit: 3, p: 1 },
  ];
  const g = game({ initial, trades: impossible });
  cleanInvalid(g.read());
  assert.match(g.read().training.reason, /executed trade sequence/);
  g.dom.window.close();
}
{
  const g = game();
  g.panels[1].querySelector('[data-hand-suit="0"]').lastElementChild.textContent = '-2';
  cleanInvalid(g.read());
  assert.match(g.read().training.reason, /visible player flow/);
  g.dom.window.close();
}
{
  const g = game({ visible: false });
  g.panels[1].querySelector('[data-hand-suit="0"]').lastElementChild.textContent = '-2';
  assert.throws(g.read, /Trade history and player flow disagree/);
  g.dom.window.close();
}
for (const full of [false, true]) {
  const g = game({ full });
  g.root.insertAdjacentHTML('beforeend', text('Round ended'));
  const s = g.read();
  assert.equal(s.status, 'ended');
  assert.equal(s.training, undefined, 'ordinary results reveal must not activate learning');
  g.dom.window.close();
}
{
  const g = game();
  const duplicate = g.doc.createElement('section');
  duplicate.innerHTML =
    text('Your Starting Hand') + g.panels.map((panel) => panel.outerHTML).join('');
  g.root.prepend(duplicate);
  complete(g);
  g.dom.window.close();
}
{
  const g = game({ full: true });
  const first = complete(g);
  g.root.prepend(g.panels[2]);
  const s = g.read();
  assert.equal(
    s.self,
    'Alice',
    'remembered native self remains stable if visible opponent tiles move',
  );
  assert.deepEqual(clone(s.held), g.held[0]);
  assert.equal(s.training.valid, true);
  g.dom.window.close();
}
{
  const g = game();
  const first = complete(g);
  const a = g.panels[2];
  const b = g.panels[3];
  for (const [panel, s, value] of [
    [a, 1, 1],
    [a, 3, 4],
    [b, 1, 2],
    [b, 3, 3],
  ])
    panel.querySelector(`[data-hand-suit="${s}"] [dir="auto"]`).textContent = value;
  const second = g.read();
  assert.equal(second.training.valid, true);
  assert.notEqual(second.signature, first.signature, 'visible truth changes must notify consumers');
  g.dom.window.close();
}
console.log(
  'Learning adapter: native and full-card four/five-player hands, identity, truth validation, result isolation, and concealed regression pass.',
);
