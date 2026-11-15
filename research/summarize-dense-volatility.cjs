#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '../outputs/volatility-review-2026-10-30');
const input = require(path.join(OUT, 'dense-volatility.json'));
const { summarizePath } = require('./audit-dense-volatility.cjs');
function regularGrid(points, ms) {
  if (points.length < 2) return points;
  const out = [points[0]];
  let cursor = 0;
  let previous = 0;
  for (let at = points[0].at + ms; at <= points.at(-1).at; at += ms) {
    while (cursor + 1 < points.length && points[cursor + 1].at <= at) cursor++;
    const p = points[cursor];
    const between = points.slice(previous + 1, cursor + 1);
    const structuralJumpPp =
      100 * Math.max(...p.structural.map((v, s) => Math.abs(v - out.at(-1).structural[s])));
    const newFills = between.flatMap((p) => p.newFills);
    const newQuotes = between.flatMap((p) => p.newQuotes);
    const selectedAdded = between.reduce((n, p) => n + p.selectedAdded, 0);
    const selectedRemoved = between.reduce((n, p) => n + p.selectedRemoved, 0);
    out.push({
      ...p,
      at,
      newFills,
      newQuotes,
      selectedAdded,
      selectedRemoved,
      structuralJumpPp,
      poolChanged: between.some((p) => p.poolChanged),
      coverageGap: between.some((p) => p.coverageGap),
      kind: newFills.length
        ? 'fill'
        : structuralJumpPp > 1e-6
          ? 'inventory-bound-without-fill'
          : newQuotes.length
            ? 'quotes-only'
            : selectedAdded || selectedRemoved
              ? 'evidence-change'
              : 'unchanged',
    });
    previous = cursor;
  }
  return out;
}
const activeComplete = input.rounds.filter((r) => r.goal && r.points.some((p) => p.active));
const report = {
  source: 'dense-volatility.json',
  method:
    'Causal fixed wall-clock grid, carrying the last reconstructed forecast available at each tick. These are sensitivity diagnostics for UI coalescing, not an exact display trace. Aggregate scores weight each completed active round equally. Unknown-outcome segments contribute volatility only; the two-point transient segment is omitted.',
  activeCompletedRoundCount: activeComplete.length,
  goalScores: Object.fromEntries(
    ['v012', 'v013', 'lr8'].map((v) => [
      v,
      Object.fromEntries(
        ['brier', 'logLoss', 'goalP', 'correct'].map((k) => [
          k,
          activeComplete.reduce((sum, r) => sum + r.properScores[v].clockWeighted[k], 0) /
            activeComplete.length,
        ]),
      ),
    ]),
  ),
  rounds: input.rounds
    .filter((r) => r.points.length > 100)
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      context: r.context,
      grids: Object.fromEntries(
        [120, 1000].map((ms) => [ms, summarizePath(regularGrid(r.points, ms), [])]),
      ),
    })),
};
fs.writeFileSync(path.join(OUT, 'dense-volatility-grid.json'), JSON.stringify(report) + '\n');
console.log(
  JSON.stringify(
    report.rounds.map((r) => ({
      id: r.id,
      grids: Object.fromEntries(
        Object.entries(r.grids).map(([ms, models]) => [
          ms,
          Object.fromEntries(
            Object.entries(models).map(([v, s]) => [
              v,
              {
                tvPerMinute: s.totalVariationPpPerMinute,
                flips: s.favoriteFlips,
                jumps5: s.jumpsAtLeast5Pp,
                jumps10: s.jumpsAtLeast10Pp,
                maxJump: s.maxJumpPp,
              },
            ]),
          ),
        ]),
      ),
    })),
    null,
    2,
  ),
);
