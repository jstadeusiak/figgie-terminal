const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const folder = 'extension/';
const colors = ['rgb(39, 115, 222)', 'rgb(26, 167, 123)', 'rgb(239, 64, 67)', 'rgb(239, 168, 35)'];
const names = ['Alice', 'Bot-Cougar', 'Bot-Moth', 'Bot-Rabbit'];
const ids = ['s', 'c', 'd', 'h'];
const cards = ['spades', 'clubs', 'diamonds', 'hearts'];
const boxes = ['0 0 48.89 60', '0 0 51.84 59.86', '0 0 40.62 60.03', '0 0 55.87 59.69'];
const text = (value) => `<div dir="auto">${value}</div>`;
const icon = (id = '', box = '') => `<svg id="${id}" viewBox="${box}"></svg>`;
const delta = [
  [1, 0, 0, 0],
  [-1, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];
function fixture() {
  const header = (i) =>
    `<header style="background-color:${colors[i]}">${text(names[i])}<div>${icon('chip_desktop_svg__a')}${text(i === 0 ? 299 : 300)}</div></header>`;
  const self = `<section>${header(0)}<div>${[3, 4, 4, 0].map((n, s) => `<div>${text(n)}${icon(cards[s] + '_card_desktop_svg__a', '0 0 60 90')}</div>`).join('')}</div></section>`;
  const opponents = names
    .slice(1)
    .map((name, j) => {
      const i = j + 1;
      return `<section>${header(i)}${icon('purple_cards_desktop_svg__a')}${text(10 + delta[i].reduce((a, b) => a + b, 0))}${boxes.map((box, s) => `<div>${icon('', box)}${text(' ')}${text(delta[i][s] === 0 ? ' ' : delta[i][s] > 0 ? '+' + delta[i][s] : delta[i][s])}</div>`).join('')}</section>`;
    })
    .join('');
  const side = (s, kind, owner, price) =>
    `<div>${`<div style="background-color:${colors[owner]}">${text(price)}</div>`}<div tabindex="0" data-source="${ids[s]}-${kind === 'bid' ? 'raise' : 'lower'}">${icon('gameplay_btn_' + (kind === 'bid' ? 'up' : 'down') + '_desktop_svg__Layer_2')}</div><div tabindex="0" data-source="${ids[s]}-cancel-${kind}">${icon('gameplay_btn_cancel_desktop_svg__Layer_2')}</div><div><div><input inputmode="numeric" placeholder="${kind === 'bid' ? 'BID' : 'OFFER'}"></div><div tabindex="0" data-source="${ids[s]}-${kind === 'bid' ? 'sell' : 'buy'}">${text(kind === 'bid' ? 'SELL' : 'BUY')}</div></div></div>`;
  const quotes = ids
    .map(
      (id, s) =>
        `<section data-row="${id}">${side(s, 'bid', 2, 2)}${icon('', boxes[s])}${side(s, 'ask', 1, 3)}</section>`,
    )
    .join('');
  return `<div id="root">${text("Alice's game")}${text('Round 1')}${text('0:01')}${self}${opponents}<div>${quotes}</div><section id="history"><div>${text('Trade History')}<div>${text('Buyer')}${text('Suit')}${text('Seller')}${text('Price')}</div></div><div id="history-rows"><div>${text('Alice')}${icon('', boxes[0])}${text('Bot-Cougar')}${text(1)}</div></div></section></div>`;
}
function setup() {
  const dom = new JSDOM(fixture(), {
    url: 'https://www.figgie.com/play/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(fs.readFileSync(folder + 'adapter.js', 'utf8'));
  return dom;
}

module.exports = { setup, names, colors, ids, cards, boxes, text, icon, fixture };
