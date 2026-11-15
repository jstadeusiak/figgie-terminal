const assert = require('node:assert/strict');
const { setup, names, text, icon, boxes } = require('./figgie-fixture.cjs');
const dom = setup();
const doc = dom.window.document;
const A = dom.window.FiggieAdapter;
const raw = A.read(doc);
const result = doc.createElement('section');
result.innerHTML =
  `<div>${icon('', boxes[3])}${text('Goal Suit')}</div>${text('End of round rankings')}` +
  names
    .map(
      (name, i) =>
        `<section><header>${text(name)}${icon('chip_desktop_svg__a')}${text(i === 0 ? 299 : 317)}${text(i === 0 ? '-51' : '+17')}</header></section>`,
    )
    .join('');
assert.equal(A.readSettlement(doc, raw), null);
doc.getElementById('root').append(result);
const ranked = A.readSettlement(doc, raw);
assert.equal(ranked.goal, 'h');
assert.equal(ranked.settledProfit, -51);
assert.equal(ranked.settledBank, 299);
assert.equal(ranked.source, 'official-round-rankings');
assert.equal(A.read(doc).roundResult.settledProfit, -51);
result.querySelectorAll('header')[1].lastElementChild.textContent = '+18';
assert.equal(A.readRankings(doc, raw), null, 'non-zero-sum partial result is rejected');
dom.window.close();
console.log('Official goal + round P&L: scoped, zero-sum validated, available only at results.');
