const fs = require('fs');
const J = require('../extension/journal.js');
const New = require('../extension/belief.js').BeliefEngine;
const Old = require('../extension/belief-v0.4.js').BeliefEngine;
const rows = fs
  .readFileSync('outputs/model-review-recent-2026-10-27/recordings-latest.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const m = rows.filter((e) => e.kind === 'round_metadata' && e.revealed).at(-1);
const es = rows.filter((e) => e.roundId === m.id).sort((a, b) => a.seq - b.seq);
const event = J.livePredictions(es).at(-1);
const prefix = es.filter((e) => e.seq < event.seq);
const s = J.replay(prefix);
const prior = prefix.findLast((e) => e.kind === 'learning_prior').learning;
const j = J.restore({ ...m, snapshot: s }, prefix);
const old = new Old();
const current = new New();
old.infer(s, j.evidence, prior);
current.infer(s, j.evidence, prior);
const times = { old: [], current: [] };
let error = 0;
for (let i = 0; i < 20; i++) {
  const before = old.infer(s, j.evidence, prior);
  const after = current.infer(s, j.evidence, prior);
  times.old.push(before.computeMs);
  times.current.push(after.computeMs);
  before.scoringProbabilities.forEach(
    (p, k) => (error = Math.max(error, Math.abs(p - after.scoringProbabilities[k]))),
  );
}
const stats = (a) => ({
  mean: a.reduce((a, b) => a + b, 0) / a.length,
  median: a.slice().sort((a, b) => a - b)[Math.floor(a.length / 2)],
  max: Math.max(...a),
});
const out = {
  round: m.id,
  old: stats(times.old),
  current: stats(times.current),
  maxDisplayedProbabilityChange: error,
  worlds: current.pool.worlds.length,
  cachedEpisodes: current.eventLogCache.size,
};
fs.writeFileSync(
  'outputs/model-review-recent-2026-10-27/performance-v05.json',
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify(out, null, 2));
