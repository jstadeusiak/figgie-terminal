const model = figgieBayes(markets);
const money = (value) => (value === null ? '—' : value.toFixed(2));
const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}`;
const signClass = (value) =>
  value > 1e-8 ? 'ff-positive' : value < -1e-8 ? 'ff-negative' : 'ff-zero';
function renderModel() {
  $('#ff-inventory-items').innerHTML = markets
    .map((s, i) => {
      const delta = model.net[0][i];
      return `<div class="ff-inventory-item"><span>${s.symbol} ${s.name}</span><div><strong>${model.currentInventory[i]}</strong><small class="${signClass(delta)}">Δ ${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)}</small></div></div>`;
    })
    .join('');
  $('#ff-inventory-ev').textContent = money(model.expectedPayout);
  $('#ff-payout-ev').textContent = money(model.expectedPayout);
  $('#ff-base-ev').textContent = money(model.expectedBase);
  $('#ff-bonus-ev').textContent = money(model.expectedBonus);
  $('#ff-model-evidence').textContent =
    `18 fills; ${model.stateCount.toLocaleString()} weighted feasible deals across 12 deck layouts.`;
  $('#ff-model-odds').innerHTML = markets
    .map((s, i) => {
      const result = model.bySuit[i];
      const percent = result.probability * 100;
      const delta = (result.probability - result.handProbability) * 100;
      return `<div class="ff-odds-item"><div class="ff-odds-heading"><span>${s.symbol} ${s.name}</span><b>${percent.toFixed(1)}%</b></div><div class="ff-odds-track" role="meter" aria-label="${s.name} goal probability" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(2)}"><div class="ff-odds-fill" style="width:${percent}%"></div></div><div class="ff-odds-delta"><span>Deal ${(result.handProbability * 100).toFixed(1)}%</span><span class="${signClass(delta)}">${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} pp</span></div></div>`;
    })
    .join('');
  $('#ff-model-prices').innerHTML = markets
    .map((s, i) => {
      const result = model.bySuit[i];
      return `<tr><td>${s.symbol}</td><td>${money(result.base)}</td><td>${money(result.buy)}</td><td>${money(result.sell)}</td></tr>`;
    })
    .join('');
  root.querySelectorAll('.ff-flow tbody td:not(:first-child)').forEach((cell) => {
    const value = Number(cell.textContent.replace('−', '-'));
    cell.classList.add(signClass(value));
  });
  root.querySelectorAll('.ff-market').forEach((panel, i) => {
    const s = markets[i];
    const result = model.bySuit[i];
    const line = document.createElement('div');
    line.className = 'ff-market-model';
    line.innerHTML = `<span>Goal <b>${(result.probability * 100).toFixed(1)}%</b></span><span>Buy cap <b>${money(result.buy)}</b></span><span>Sell floor <b>${money(result.sell)}</b></span>`;
    panel.querySelector('.ff-market-heading').after(line);
    const sellEdge = result.sell === null ? null : s.bid - result.sell;
    const buyEdge = result.buy === null ? null : result.buy - s.ask;
    panel.querySelectorAll('.ff-after')[0].innerHTML =
      result.sell === null
        ? 'Your working bid'
        : `<span>Hold ${s.held - 1}</span><b class="ff-model-edge ${signClass(sellEdge)}">Edge ${signed(sellEdge)}</b>`;
    panel.querySelectorAll('.ff-after')[1].innerHTML =
      `<span>Hold ${s.held + 1}</span><b class="ff-model-edge ${signClass(buyEdge)}">Edge ${signed(buyEdge)}</b>`;
  });
}
renderModel();
