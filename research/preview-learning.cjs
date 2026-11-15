const http = require('http');
const fs = require('fs');
const path = require('path');
const { fixture, model } = require('../tests/learning-fixture.cjs');
const folder = path.resolve('extension');
const cache = {};
function html(n) {
  const s = fixture(n);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Figgie learning lab · local QA</title></head><body style="margin:0;background:#142126"><div id="figgie-terminal-host" style="height:100vh"></div>${['pnl.js', 'ui-assets.js', 'flow-chart.js', 'training-ui.js', 'ui.js'].map((f) => '<script src="/' + f + '"></script>').join('')}<script>const s=${JSON.stringify(s)};window.chrome={runtime:{sendMessage(m,cb){fetch('/model?n=${n}').then(r=>r.json()).then(cb);}}};const h=document.getElementById('figgie-terminal-host'),r=h.attachShadow({mode:'open'});r.innerHTML='<style>'+FiggieTerminalAssets.css+'</style>'+FiggieTerminalAssets.html;const ui=FiggieTerminalUI.mount(r,{send(m){if(m.type==='command')ui.receive({type:'reject',id:m.id,message:'Local QA: trading disabled'});}});ui.receive({type:'snapshot',snapshot:s});setInterval(()=>ui.receive({type:'heartbeat',timer:s.timer,status:'live'}),1000);</script></body></html>`;
}
http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const n = u.searchParams.get('n') === '5' ? 5 : 4;
    if (u.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(html(n));
    }
    if (u.pathname === '/model') {
      cache[n] ||= model(fixture(n));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ model: cache[n] }));
    }
    const name = u.pathname.slice(1);
    if (!['pnl.js', 'ui-assets.js', 'flow-chart.js', 'training-ui.js', 'ui.js'].includes(name)) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(folder, name)));
  })
  .listen(8772, '127.0.0.1', () => console.log('Local learning QA: http://127.0.0.1:8772/?n=4'));
