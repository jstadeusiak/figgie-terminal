#!/usr/bin/env node
/* Local rating evidence only; deliberately does not fit a formula to sparse intervals. */
const fs = require('node:fs');
const R = require('../extension/ratings.js');
const files = process.argv.slice(2);
if (!files.length) {
  console.error(
    'Usage: node tools/analyze-ratings.cjs exported-recording.ndjson [more-exports.ndjson]',
  );
  process.exit(1);
}
const rows = files.flatMap((file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw Error(`${file}:${i + 1}: invalid NDJSON`);
      }
    }),
);
const observations = rows.filter((r) => r.kind === 'rating_observation');
const rounds = [
  ...new Map(rows.filter((r) => r.kind === 'round_metadata').map((r) => [r.id, r])).values(),
];
const intervals = R.intervals(observations, rounds);
console.log(
  JSON.stringify(
    {
      observations: new Set(observations.map((o) => o.id)).size,
      intervals,
      singleRoundCandidates: intervals.filter((i) => i.attribution === 'single-round-candidate')
        .length,
      formula: null,
      limitation:
        'Visible snapshots cannot establish server update timing or unobserved opponent ratings. Collect paired Statistics snapshots, then compare candidate formulas on later held-out rounds.',
    },
    null,
    2,
  ),
);
