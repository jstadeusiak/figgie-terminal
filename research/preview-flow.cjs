// Local-only visual QA; synthetic five-player flow and a recorded four-player view.
const http = require('http');
const fs = require('fs');
const path = require('path');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
const port = Number(process.env.FIGGIE_QA_PORT || 8767);
const folder = path.resolve('extension');
const rows = fs
  .readFileSync('outputs/model-review-recent-2026-10-27/recordings.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const m = rows.find((e) => e.id === 'round-1793155317616-a642f154' && e.kind === 'round_metadata');
const events = rows.filter((e) => e.roundId === m.id).sort((a, b) => a.seq - b.seq);
const last = J.livePredictions(events).at(-1);
const prefix = events.filter((e) => e.seq < last.seq);
const four = J.replay(prefix);
const journal = J.restore({ ...m, snapshot: four }, prefix);
const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
const engines = {};
Object.assign(four, {
  room: 'Local QA replay',
  roundKey: 'qa-four',
  timer: '1:00',
  recordingRequired: false,
});
const five = JSON.parse(JSON.stringify(four));
five.self = 'You';
five.players = ['You', 'Bot-Jaguar', 'Bot-Crab', 'Bot-Shark', 'Bot-Lynx'].map((name, i) => ({
  name,
  cash: 300,
  color: ['#2773de', '#1aa77b', '#ef4043', '#efa823', '#a98be9'][i],
}));
five.startingHand = [2, 2, 2, 2];
five.trades = [
  { suit: 's', b: 'You', s: 'Bot-Jaguar', p: 5 },
  { suit: 's', b: 'You', s: 'Bot-Jaguar', p: 6 },
  { suit: 'c', b: 'Bot-Crab', s: 'You', p: 8 },
  { suit: 'h', b: 'You', s: 'Bot-Shark', p: 3 },
  { suit: 'd', b: 'Bot-Lynx', s: 'Bot-Crab', p: 7 },
  { suit: 's', b: 'Bot-Crab', s: 'Bot-Shark', p: 4 },
];
five.held = [4, 1, 2, 3];
five.roundKey = 'qa-five';
five.net = B.physical(five).net;
five.cash = 294;
five.players.forEach((p, i) => (p.cards = 8 + five.net[i].reduce((a, b) => a + b, 0)));
five.markets.forEach((v, i) =>
  Object.assign(v, {
    held: five.held[i],
    bid: 3,
    ask: 8,
    buyer: 'Bot-Crab',
    seller: 'Bot-Jaguar',
    canBuy: true,
    canSell: true,
    canBid: true,
    canOffer: true,
    canRaiseBid: true,
    canLowerAsk: true,
    canCancelBid: false,
    canCancelOffer: false,
    fills: five.trades.filter((t) => t.suit === v.id),
  }),
);
function html(s) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Figgie main flow · local QA</title></head><body style="margin:0;background:#142126"><div id="figgie-terminal-host" style="height:100vh"></div><script src="/pnl.js"></script><script src="/ui-assets.js"></script><script src="/flow-chart.js"></script><script src="/ui.js"></script><script>const s=${JSON.stringify(s)};window.chrome={runtime:{sendMessage(m,reply){fetch('/model',{method:'POST',body:JSON.stringify(m)}).then(r=>r.json()).then(reply);}}};const h=document.getElementById('figgie-terminal-host'),r=h.attachShadow({mode:'open'});r.innerHTML='<style>'+FiggieTerminalAssets.css+'</style>'+FiggieTerminalAssets.html;const ui=FiggieTerminalUI.mount(r,{send(m){if(m.type==='command')ui.receive({type:'reject',id:m.id,message:'Local QA: trading disabled'});}});ui.receive({type:'snapshot',snapshot:s});r.getElementById('show-figgie').textContent='QA · ${s.players.length} players';setInterval(()=>ui.receive({type:'snapshot',snapshot:s}),1000);</script></body></html>`;
}
http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/model') {
      let body = '';
      for await (const p of req) body += p;
      const m = JSON.parse(body);
      const n = m.job.snapshot.players.length;
      const e = (engines[n] ||= new B.BeliefEngine());
      const model = e.infer(m.job.snapshot, n === 4 ? journal.evidence : [], {
        ...prior,
        forceBaseline: !m.job.opponentEnabled,
        quotePrices: m.job.quotePrices,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: m.job.id, model }));
      return;
    }
    if (u.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html(u.searchParams.get('players') === '5' ? five : four));
      return;
    }
    const name = u.pathname.slice(1);
    if (!['pnl.js', 'ui-assets.js', 'flow-chart.js', 'ui.js'].includes(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(folder, name)));
  })
  .listen(port, '127.0.0.1', () =>
    console.log('Local QA: http://127.0.0.1:' + port + '/?players=4 and ?players=5'),
  );
