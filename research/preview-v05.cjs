const http = require('http');
const fs = require('fs');
const path = require('path');
const B = require('../extension/belief.js');
const J = require('../extension/journal.js');
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
const snapshot = J.replay(prefix);
const journal = J.restore({ ...m, snapshot }, prefix);
const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
const engine = new B.BeliefEngine();
snapshot.room = 'Local QA replay';
snapshot.roundKey = 'qa-preview';
snapshot.timer = '0:01';
snapshot.recordingRequired = false;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Figgie 0.5 · local QA replay</title></head><body style="margin:0;background:#142126"><div id="figgie-terminal-host" style="height:100vh"></div><script src="/pnl.js"></script><script src="/ui-assets.js"></script><script src="/ui.js"></script><script>
const s=${JSON.stringify(snapshot)};window.chrome={runtime:{sendMessage(message,reply){fetch('/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}).then(r=>r.json()).then(reply);}}};const host=document.getElementById('figgie-terminal-host'),shadow=host.attachShadow({mode:'open'});shadow.innerHTML='<style>'+FiggieTerminalAssets.css+'</style>'+FiggieTerminalAssets.html;const ui=FiggieTerminalUI.mount(shadow,{send(m){if(m.type==='command')ui.receive({type:'reject',id:m.id,message:'Local QA replay: trading disabled'});}});ui.receive({type:'snapshot',snapshot:s});shadow.getElementById('show-figgie').textContent='QA replay · v0.5';setInterval(()=>ui.receive({type:'snapshot',snapshot:s}),1000);
</script></body></html>`;
http
  .createServer(async (req, res) => {
    if (req.url === '/model') {
      let body = '';
      for await (const part of req) body += part;
      const message = JSON.parse(body);
      const model = engine.infer(message.job.snapshot, journal.evidence, {
        ...prior,
        forceBaseline: !message.job.opponentEnabled,
        quotePrices: message.job.quotePrices,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: message.job.id, model }));
      return;
    }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
      return;
    }
    const name = req.url.slice(1);
    if (!['pnl.js', 'ui-assets.js', 'ui.js'].includes(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(folder, name)));
  })
  .listen(8766, '127.0.0.1', () => console.log('QA replay http://127.0.0.1:8766'));
