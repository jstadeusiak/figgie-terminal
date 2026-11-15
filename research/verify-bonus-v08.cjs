/* Shipping v0.8 verification against frozen v0.7 and existing matched labels. */
const fs = require('node:fs');
const B7 = require('../extension/belief-v0.7.js');
const B8 = require('../extension/belief.js');
const J = require('../extension/journal.js');
const root = 'outputs/model-review-v08/';
const source = root + 'recordings-combined.ndjson';
const rows = fs.readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse);
const audit = JSON.parse(fs.readFileSync(root + 'bonus-prospective.json'));
const old = JSON.parse(fs.readFileSync(root + 'bonus-old.json'));
const metas = new Map(rows.filter((e) => e.kind === 'round_metadata').map((m) => [m.id, m]));
const events = new Map([...metas.keys()].map((id) => [id, []]));
for (const row of rows) if (events.has(row.roundId)) events.get(row.roundId).push(row);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => sum(a) / a.length;
const close = (a, b) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
function inputs(id, seq) {
  const meta = metas.get(id);
  const prefix = events.get(id).filter((e) => e.seq < seq);
  const s = J.replay(prefix);
  const j = J.restore({ ...meta, snapshot: s, revealed: null }, prefix);
  const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
  return { s, e: j.evidence, prior };
}
function check(v, message) {
  if (!v) throw Error(message);
}
function payoff(counts, pot) {
  const max = Math.max(...counts);
  return counts[0] * 10 + (counts[0] === max ? pot / counts.filter((v) => v === max).length : 0);
}
function consistency(model, engine, s) {
  check(close(sum(model.bySuit.map((v) => v.probability)), 1), 'Goal mass');
  check(close(sum(model.bySuit.map((v) => v.holding)), model.expectedPayout), 'Payout by goals');
  check(close(model.expectedBase + model.expectedBonus, model.expectedPayout), 'Base + bonus');
  for (const [g, v] of model.bySuit.entries()) {
    if (v.probability > 0) {
      check(close(v.conditionalPayout * v.probability, v.holding), 'Conditional payout');
      check(close(v.conditionalBonus + 10 * s.held[g], v.conditionalPayout), 'Conditional bonus');
      check(v.conditionalPayout >= v.conditionalPayoutFloor - 1e-7, 'Hard payout floor');
      check(
        close(
          v.conditionalSoloProbability +
            v.conditionalTieProbability +
            v.conditionalNoBonusProbability,
          1,
        ),
        'Bonus classes',
      );
    }
    for (let actor = 1; actor < s.players.length; actor++) {
      const cp = v.counterparties[s.players[actor].name];
      let mass = 0;
      let buy = 0;
      let sell = 0;
      engine.latest.worlds.forEach((w, i) => {
        const weight = engine.latest.weights[i];
        if (w.initial[actor][g] + engine.state.net[actor][g] > 0) {
          mass += weight;
          if (w.goal === g) {
            const before = w.initial.map((r, a) => r[g] + engine.state.net[a][g]);
            const after = before.slice();
            after[0]++;
            after[actor]--;
            buy += weight * (payoff(after, w.bonus) - payoff(before, w.bonus));
          }
        }
        if (s.held[g] > 0 && w.goal === g) {
          const before = w.initial.map((r, a) => r[g] + engine.state.net[a][g]);
          const after = before.slice();
          after[0]--;
          after[actor]++;
          sell += weight * (payoff(before, w.bonus) - payoff(after, w.bonus));
        }
      });
      check(close(cp.hasCardProbability, mass), 'Counterparty stock conditioning');
      if (mass) {
        check(close(cp.buy, buy / mass), 'Buy value uses same weights');
        check(close(cp.buyBase + cp.buyBonus, cp.buy), 'Buy components');
      }
      check(close(cp.sell, sell), 'Sell value uses same weights');
      check(close(cp.sellBase + cp.sellBonus, cp.sell), 'Sell components');
    }
  }
  for (const book of [model.resting, model.actualBook])
    for (const m of Object.values(book))
      for (const q of Object.values(m)) {
        check(q.pFill >= 0 && q.pFill <= 1, 'Fill probability');
        if (q.pFill) {
          check(close(q.ev, q.pFill * q.conditionalEdge), 'Resting expected edge');
          check(
            close(q.conditionalBaseEdge + q.conditionalBonusEdge, q.conditionalEdge),
            'Resting components',
          );
          check(close(sum(q.counterparties.map((v) => v.probability)), 1), 'Resting party mass');
          check(
            close(
              sum(q.counterparties.map((v) => v.probability * (v.conditionalEdge || 0))),
              q.conditionalEdge,
            ),
            'Resting party edge',
          );
        }
      }
}
function metrics(points) {
  return Object.fromEntries(
    ['v7', 'v8'].map((k) => [
      k,
      {
        bias: mean(points.map((p) => p[k].bonus - p.truth.bonus)),
        mae: mean(points.map((p) => Math.abs(p[k].bonus - p.truth.bonus))),
        mse: mean(points.map((p) => (p[k].bonus - p.truth.bonus) ** 2)),
        categoryBrier: mean(
          points.map((p) =>
            sum(
              ['solo', 'tie', 'none'].map((c) => (p[k][c] - Number(p.truth.category === c)) ** 2),
            ),
          ),
        ),
        leaderBrier: mean(
          points.map((p) => (p[k].leader - Number(p.truth.category !== 'none')) ** 2),
        ),
      },
    ]),
  );
}
function compact(v) {
  return {
    bonus: v.conditionalBonus,
    solo: v.conditionalSoloProbability,
    tie: v.conditionalTieProbability,
    none: v.conditionalNoBonusProbability,
    leader: v.conditionalLeaderProbability,
    goal: v.probability,
  };
}
function aggregate(report) {
  return Object.fromEntries(
    ['v7', 'v8'].map((k) => [
      k,
      {
        rounds: report.length,
        checkpoints: sum(report.map((r) => r.points.length)),
        ...Object.fromEntries(
          ['bias', 'mae', 'mse', 'categoryBrier', 'leaderBrier'].map((m) => [
            m,
            mean(report.map((r) => r.metrics[k][m])),
          ]),
        ),
      },
    ]),
  );
}
if (process.argv.includes('--benchmark')) {
  const selected = audit.report
    .filter((_, i) => i % 2 === 0)
    .flatMap((r) =>
      [0, Math.floor(r.points.length / 2), r.points.length - 1].map((i) => ({
        id: r.id,
        seq: r.points[i].seq,
      })),
    );
  const samples = [];
  // Each paired checkpoint measures a cold rebuild and a repeated warm update;
  // alternate order to reduce JIT/order bias. Validation runs outside timings.
  for (let i = 0; i < selected.length; i++) {
    const p = selected[i];
    const input = inputs(p.id, p.seq);
    const result = { ...p, trades: input.s.trades.length, evidence: input.e.length };
    for (const key of i % 2 ? ['v8', 'v7'] : ['v7', 'v8']) {
      const engine = new { v7: B7, v8: B8 }[key].BeliefEngine();
      let start = performance.now();
      engine.infer(input.s, input.e, input.prior);
      const cold = performance.now() - start;
      start = performance.now();
      const model = engine.infer(input.s, input.e, input.prior);
      const warm = performance.now() - start;
      consistency(model, engine, input.s);
      result[key] = {
        coldMs: cold,
        warmMs: warm,
        states: model.stateCount,
        restingQuotes: Object.values(model.resting).reduce((n, v) => n + Object.keys(v).length, 0),
        actualQuotes: Object.values(model.actualBook).reduce(
          (n, v) => n + Object.keys(v).length,
          0,
        ),
      };
    }
    samples.push(result);
  }
  const stats = (values) => {
    const a = values.slice().sort((x, y) => x - y);
    return {
      median: a[Math.floor(a.length * 0.5)],
      p95: a[Math.floor(a.length * 0.95)],
      max: a.at(-1),
      mean: mean(a),
    };
  };
  const result = {
    version: B8.VERSION,
    checkpoints: samples.length,
    method:
      'Full inference including resting and actual quotes; matched30 checkpoints; cold rebuild and warm repeated update. Alternating version order. EV invariants checked outside timing.',
    consistencyChecks:
      'Passed: goal mass, payout decomposition, floors, category mass, same-world direct buy/sell transfer values, resting fill-adjusted decomposition and counterparties.',
    metrics: Object.fromEntries(
      ['v7', 'v8'].map((k) => [
        k,
        {
          cold: stats(samples.map((s) => s[k].coldMs)),
          warm: stats(samples.map((s) => s[k].warmMs)),
        },
      ]),
    ),
    samples,
  };
  fs.writeFileSync(root + 'bonus-performance.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
} else {
  const report = [];
  let maxFrozenDifference = 0;
  for (const [cohort, rs] of [
    ['new20', audit.report],
    ['old20', old.report],
  ])
    for (const r of rs) {
      const e7 = new B7.BeliefEngine({ skipPricing: true });
      const e8 = new B8.BeliefEngine({ skipPricing: true });
      const points = [];
      for (const p of r.points) {
        const input = inputs(r.id, p.seq);
        const a = e7.infer(input.s, input.e, input.prior);
        const b = e8.infer(input.s, input.e, input.prior);
        const g = B7.IDS.indexOf(r.goal);
        maxFrozenDifference = Math.max(
          maxFrozenDifference,
          Math.abs(a.bySuit[g].conditionalBonus - p.v7.bonus),
        );
        points.push({
          seq: p.seq,
          truth: p.truth,
          v7: compact(a.bySuit[g]),
          v8: compact(b.bySuit[g]),
        });
      }
      report.push({ cohort, id: r.id, points, metrics: metrics(points) });
      console.log('Verified', cohort, r.id);
    }
  const newRounds = report.filter((r) => r.cohort === 'new20');
  const oldRounds = report.filter((r) => r.cohort === 'old20');
  const result = {
    source,
    version: B8.VERSION,
    maxFrozenDifference,
    new20: aggregate(newRounds),
    first14: aggregate(newRounds.slice(0, 14)),
    latest6: aggregate(newRounds.slice(14)),
    old20: aggregate(oldRounds),
    report,
  };
  fs.writeFileSync(root + 'bonus-production-check.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, report: undefined }, null, 2));
  check(maxFrozenDifference < 1e-8, 'Frozen v7 replay drift');
}
