const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
if (!file) throw Error('Usage: node research/check-figgie-model.cjs TERMINAL_PREVIEW.html');
const html = fs.readFileSync(file, 'utf8');
const markets = vm.runInNewContext(
  '(' + html.match(/const markets=(\[.*?\]);\nconst saved=/s)[1] + ')',
);
const engine = vm.runInNewContext(
  fs.readFileSync('research/figgie-model.js', 'utf8') + ';figgieBayes',
);
const close = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const model = engine(markets);
close(
  model.bySuit.reduce((n, s) => n + s.probability, 0),
  1,
);
close(
  model.configurations.reduce((n, s) => n + s.probability, 0),
  1,
);
close(model.expectedPayout, model.expectedBase + model.expectedBonus);
close(
  model.bySuit.reduce((n, s) => n + s.holding, 0),
  model.expectedPayout,
);
assert.deepEqual(Array.from(model.currentInventory), [4, 4, 2, 2]);
for (let s = 0; s < 4; s++)
  close(
    model.net.reduce((n, row) => n + row[s], 0),
    0,
  );
assert.equal(model.bySuit[1].sell, null);
assert(model.bySuit.every((s) => s.buy >= 0 && (s.sell === null || s.sell >= 0)));
for (const config of model.configurations) {
  assert.deepEqual(
    Array.from(config.deck).sort((a, b) => a - b),
    [8, 10, 10, 12],
  );
  assert(config.deck[config.goal] < 12);
  assert.equal(config.deck[config.goal ^ 1], 12);
}
// With no trade constraints, summing every feasible opponent deal must recover
// the multivariate-hypergeometric posterior from the starting hand alone.
const atDeal = engine(markets.map((s) => ({ ...s, fills: [] })));
atDeal.bySuit.forEach((s) => close(s.probability, s.handProbability));
// Prices and final revealed hands are not inputs to this constraint model.
const alteredPrices = engine(
  markets.map((s) => ({ ...s, bid: 50, ask: 90, fills: s.fills.map((f) => ({ ...f, p: 99 })) })),
);
alteredPrices.bySuit.forEach((s, i) => {
  close(s.probability, model.bySuit[i].probability);
  close(s.buy, model.bySuit[i].buy);
});
// The embedded engine and the independently loaded engine must agree.
const embedded = html.match(/function figgieBayes\(markets\) \{[\s\S]*?\n\}\n/)[0];
const inPage = vm.runInNewContext(embedded + ';figgieBayes')(markets);
inPage.bySuit.forEach((s, i) => close(s.probability, model.bySuit[i].probability));
console.log(
  JSON.stringify(
    {
      checks: 'passed',
      feasibleDeals: model.stateCount,
      goalPercent: model.bySuit.map((s) => +(s.probability * 100).toFixed(2)),
      buyCaps: model.bySuit.map((s) => +s.buy.toFixed(2)),
      payoutEV: +model.expectedPayout.toFixed(2),
    },
    null,
    2,
  ),
);
