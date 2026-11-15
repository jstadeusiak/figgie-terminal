/* Prospective bonus audit of rounds recorded after v0.7 shipped. Revealed goal
   counts are evaluation labels only. Inference sees the historical prefix and
   its recorded learning prior, never a future fill or settlement. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const B6 = require('../extension/belief-v0.6.js');
const B = require('../extension/belief-v0.7.js');
const J = require('../extension/journal.js');
const Score = require('../extension/bonus-score.js');
const source = 'outputs/model-review-v08/recordings-combined.ndjson';
const out =
  'outputs/model-review-v08/bonus-' + (process.env.BONUS_PHASE || 'prospective') + '.json';
const rows = fs.readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse);
const newIds = new Set(require('../outputs/model-review-v08/sources.json').newRoundIds);
const ids = B.IDS;
const phase = process.env.BONUS_PHASE;
const selected =
  phase === 'old'
    ? new Set(require('../outputs/model-review-v08/sources.json').oldRoundIds)
    : newIds;
let metas = rows
  .filter(
    (r) =>
      r.kind === 'round_metadata' && selected.has(r.id) && r.id !== 'round-1793144490477-e7c5a184',
  )
  .sort((a, b) => a.id.localeCompare(b.id));
if (phase)
  metas = metas.filter(
    (m) =>
      m.revealed?.verified &&
      m.revealed.source === 'official-round-rankings' &&
      m.snapshot.players.length === 4 &&
      m.snapshot.context?.botDifficulty === 'Medium',
  );
if (phase === 'train') metas = metas.slice(0, 14);
if (phase === 'validation') metas = metas.slice(14);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : null);
const close = (a, b) => Math.abs(a - b) < 1e-6;
function noInventoryModule() {
  const filename = path.resolve('extension/belief-v0.7.js');
  const original = fs.readFileSync(filename, 'utf8');
  const source = original.replace(
    'if(inventoryFit){const adjusted=inventoryWeights',
    'if(false&&inventoryFit){const adjusted=inventoryWeights',
  );
  if (source === original) throw Error('No inventory intervention failed');
  const m = new Module(filename);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(source, filename);
  return m.exports;
}
const N = noInventoryModule();
function recover(m) {
  const s = m.snapshot;
  const r = m.revealed;
  const g = ids.indexOf(r?.goal);
  const names = s.players.map((p) => p.name);
  const n = names.length;
  const size = 40 / n;
  if (
    g < 0 ||
    !r?.verified ||
    r.source !== 'official-round-rankings' ||
    !names.every((x) => Number.isFinite(r.profits?.[x])) ||
    !close(sum(Object.values(r.profits)), 0)
  )
    return { reason: 'No complete official goal/payout vector' };
  const state = B.physical(s);
  const cash = names.map(() => 0);
  for (const t of s.trades) {
    cash[names.indexOf(t.b)] -= t.p;
    cash[names.indexOf(t.s)] += t.p;
  }
  const payout = names.map((name, i) => r.profits[name] - cash[i] + 200 / n);
  if (payout.some((v) => v < -1e-6) || !close(sum(payout), 200))
    return { reason: 'Payouts do not reconcile' };
  function feasible(initial, total) {
    for (const d of B.DECKS.filter((d) => d.goal === g && d.deck[g] === total)) {
      if (s.startingHand.some((v, i) => v > d.deck[i])) continue;
      if (
        initial.some((v, i) => v < state.minimum[i][g] || v > size) ||
        initial[0] !== s.startingHand[g]
      )
        continue;
      if (
        initial.some(
          (v, i) => i > 0 && size - v - sum(state.minimum[i].filter((_, k) => k !== g)) < 0,
        )
      )
        continue;
      if (
        d.deck.some(
          (v, k) =>
            k !== g && v - s.startingHand[k] - sum(state.minimum.slice(1).map((row) => row[k])) < 0,
        )
      )
        continue;
      return true;
    }
    return false;
  }
  const candidates = [];
  for (const total of [8, 10]) {
    const counts = [];
    function rec(i, left) {
      if (i === n) {
        if (left) return;
        const max = Math.max(...counts);
        const ties = counts.filter((v) => v === max).length;
        const bonus = 200 - total * 10;
        if (!counts.every((c, j) => close(10 * c + (c === max ? bonus / ties : 0), payout[j])))
          return;
        const initial = counts.map((v, j) => v - state.net[j][g]);
        if (!feasible(initial, total)) return;
        candidates.push({ total, bonus, counts: counts.slice(), initial });
        return;
      }
      const cap = Math.min(left, s.players[i].cards ?? left);
      for (let c = 0; c <= cap; c++) {
        if (i === 0 && c !== s.held[g]) continue;
        counts[i] = c;
        rec(i + 1, left - c);
      }
    }
    rec(0, total);
  }
  return candidates.length
    ? { goal: g, names, payout, cash, candidates }
    : { reason: 'No physical counts reproduce official payouts', payout };
}
function truthAt(recovered, s) {
  const state = B.physical(s);
  const vals = recovered.candidates.map((c) => {
    const counts = c.initial.map((v, i) => v + state.net[i][recovered.goal]);
    if (counts.some((v) => v < 0)) return null;
    const max = Math.max(...counts);
    const ties = counts.filter((v) => v === max).length;
    const lead = counts[0] === max;
    return {
      bonus: lead ? c.bonus / ties : 0,
      category: lead ? (ties === 1 ? 'solo' : 'tie') : 'none',
      counts,
      deck: c.total,
    };
  });
  if (vals.some((v) => !v)) return null;
  return vals.every((v) => close(v.bonus, vals[0].bonus) && v.category === vals[0].category)
    ? {
        bonus: vals[0].bonus,
        category: vals[0].category,
        possibleCounts: vals.map((v) => v.counts),
        possibleDecks: vals.map((v) => v.deck),
      }
    : null;
}
function compact(v) {
  return {
    bonus: v.conditionalBonus,
    leader: v.conditionalLeaderProbability,
    solo: v.conditionalSoloProbability,
    tie: v.conditionalTieProbability,
    none: v.conditionalNoBonusProbability,
    goal: v.probability,
    floor: v.conditionalPayoutFloor,
  };
}
function weighted(engine, g, weights, candidates) {
  let mass = 0;
  let bonus = 0;
  let bonusShare = 0;
  let solo = 0;
  let tie = 0;
  let none = 0;
  let jointTruth = 0;
  let deck8 = 0;
  let squared = 0;
  const meanInitial = engine.state.names.map(() => 0);
  const maxInitial = engine.state.names.map(() => 0);
  engine.latest.worlds.forEach((w, i) => {
    if (w.goal !== g) return;
    const counts = w.initial.map((row, a) => row[g] + engine.state.net[a][g]);
    const max = Math.max(...counts);
    const ties = counts.filter((v) => v === max).length;
    const lead = counts[0] === max;
    const wt = weights[i];
    mass += wt;
    squared += wt * wt;
    if (lead) {
      bonus += (wt * w.bonus) / ties;
      bonusShare += wt / ties;
      if (ties === 1) solo += wt;
      else tie += wt;
    } else none += wt;
    if (w.bonus === 120) deck8 += wt;
    w.initial.forEach((row, a) => (meanInitial[a] += wt * row[g]));
    if (candidates.some((c) => w.initial.every((row, a) => row[g] === c.initial[a])))
      jointTruth += wt;
  });
  return {
    bonus: bonus / mass,
    bonusShare: bonusShare / mass,
    leader: (solo + tie) / mass,
    solo: solo / mass,
    tie: tie / mass,
    none: none / mass,
    effective: (mass * mass) / squared,
    meanInitial: meanInitial.map((v) => v / mass),
    jointTruth: jointTruth / mass,
    deck8: deck8 / mass,
  };
}
// Single new candidate: replace present positive net with historical peak positive net.
// Lambda .8 and ESS floor64 unchanged; no additional fitted coefficient.
function peakAcquisition(snapshot) {
  const names = snapshot.players.map((p) => p.name);
  const net = names.map(() => [0, 0, 0, 0]);
  const peak = names.map(() => [0, 0, 0, 0]);
  for (const t of snapshot.trades) {
    const a = names.indexOf(t.s);
    const b = names.indexOf(t.b);
    const g = ids.indexOf(t.suit);
    net[a][g]--;
    net[b][g]++;
    peak[b][g] = Math.max(peak[b][g], net[b][g]);
  }
  return peak;
}
const MODEL_KEYS = ['saved', 'v7', 'v6', 'noInventory', 'halfStrength', ...(phase ? ['peak'] : [])];
function metrics(points, key) {
  const good = points.filter((p) => p[key] && Number.isFinite(p[key].bonus));
  return {
    n: good.length,
    bias: avg(good.map((p) => p[key].bonus - p.truth.bonus)),
    mae: avg(good.map((p) => Math.abs(p[key].bonus - p.truth.bonus))),
    mse: avg(good.map((p) => (p[key].bonus - p.truth.bonus) ** 2)),
    leaderBrier: avg(
      good
        .filter((p) => Number.isFinite(p[key].leader))
        .map((p) => (p[key].leader - Number(p.truth.category !== 'none')) ** 2),
    ),
    categoryBrier: avg(
      good
        .filter((p) => Number.isFinite(p[key].solo))
        .map((p) =>
          sum(
            ['solo', 'tie', 'none'].map((k) => (p[key][k] - Number(p.truth.category === k)) ** 2),
          ),
        ),
    ),
  };
}
function aggregate(rs, filter = () => true) {
  return Object.fromEntries(
    MODEL_KEYS.map((k) => {
      const ms = rs.map((r) => metrics(r.points.filter(filter), k)).filter((m) => m.n);
      return [
        k,
        {
          rounds: ms.length,
          checkpoints: sum(ms.map((m) => m.n)),
          ...Object.fromEntries(
            ['bias', 'mae', 'mse', 'leaderBrier', 'categoryBrier'].map((metric) => [
              metric,
              avg(ms.map((m) => m[metric]).filter(Number.isFinite)),
            ]),
          ),
        },
      ];
    }),
  );
}
const report = [];
const excluded = [];
let maxSavedDifference = 0;
let maxGoalMarginalDifference = 0;
for (const m of metas) {
  const r = recover(m);
  if (r.reason) {
    excluded.push({ id: m.id, reason: r.reason });
    continue;
  }
  const es = rows.filter((e) => e.roundId === m.id).sort((a, b) => a.seq - b.seq);
  const validation = Score.auditRound({ ...m, events: es });
  const predictions = J.livePredictions(es);
  const engines = {
    v7: new B.BeliefEngine({ skipPricing: true }),
    v6: new B6.BeliefEngine({ skipPricing: true }),
    noInventory: new N.BeliefEngine({ skipPricing: true }),
  };
  const points = [];
  for (const p of predictions) {
    const prefix = es.filter((e) => e.seq < p.seq);
    const s = J.replay(prefix);
    if (!s || s.trades.length !== p.tradeCount) continue;
    const truth = truthAt(r, s);
    if (!truth) continue;
    const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
    const j = J.restore({ ...m, snapshot: s, revealed: null }, prefix);
    const models = {};
    for (const [k, engine] of Object.entries(engines))
      models[k] = engine.infer(s, j.evidence, prior);
    const saved = p.goalScenarios?.find((v) => v.suit === ids[r.goal]);
    const half = B.inventoryWeights(
      engines.noInventory.latest.worlds,
      engines.noInventory.latest.weights,
      engines.noInventory.state.net,
      0.4,
      64,
    );
    const values = Object.fromEntries(
      Object.entries(models).map(([k, v]) => [k, compact(v.bySuit[r.goal])]),
    );
    const peakStarted = performance.now();
    const peakNet = phase ? peakAcquisition(s) : null;
    const peak = phase
      ? B.inventoryWeights(
          engines.noInventory.latest.worlds,
          engines.noInventory.latest.weights,
          peakNet,
          0.8,
          64,
        )
      : null;
    const peakMs = performance.now() - peakStarted;
    if (saved)
      maxSavedDifference = Math.max(maxSavedDifference, Math.abs(saved.bonus - values.v7.bonus));
    models.v7.bySuit.forEach(
      (v, i) =>
        (maxGoalMarginalDifference = Math.max(
          maxGoalMarginalDifference,
          Math.abs(v.probability - models.noInventory.bySuit[i].probability),
        )),
    );
    points.push({
      seq: p.seq,
      at: p.at,
      timer: s.timer,
      tradeCount: p.tradeCount,
      finalInventory: p.tradeCount === m.snapshot.trades.length,
      held: s.held[r.goal],
      net: engines.v7.state.net.map((v) => v[r.goal]),
      truth,
      ...values,
      saved: saved
        ? {
            bonus: saved.bonus,
            leader: saved.leaderProbability,
            solo: saved.soloProbability,
            tie: saved.tieProbability,
            none: saved.noBonusProbability,
            goal: saved.probability,
          }
        : null,
      halfStrength: weighted(engines.noInventory, r.goal, half.weights, r.candidates),
      inventory: weighted(engines.v7, r.goal, engines.v7.latest.weights, r.candidates),
      inventoryBefore: weighted(
        engines.noInventory,
        r.goal,
        engines.noInventory.latest.weights,
        r.candidates,
      ),
      ...(peak
        ? {
            peak: weighted(engines.noInventory, r.goal, peak.weights, r.candidates),
            peakNet: peakNet.map((v) => v[r.goal]),
            peakMs,
            peakCalibration: peak.goals,
          }
        : {}),
      inventoryDiagnostics: models.v7.inventoryCalibration,
      askEvidence: models.v7.inventoryEvidence,
    });
  }
  const round = {
    id: m.id,
    at: es[0]?.at,
    difficulty: m.snapshot.context?.botDifficulty,
    goal: ids[r.goal],
    finalTradeCount: m.snapshot.trades.length,
    finalCounts: r.candidates,
    profits: m.revealed.profits,
    officialPayouts: r.payout,
    validation,
    recordedScore: es.find((e) => e.kind === 'bonus_score'),
    points,
    metrics: Object.fromEntries(MODEL_KEYS.map((k) => [k, metrics(points, k)])),
  };
  report.push(round);
  console.log(
    'Prospective bonus',
    report.length,
    m.id,
    points.length,
    'MAE',
    round.metrics.v7.mae.toFixed(3),
    'v6',
    round.metrics.v6.mae.toFixed(3),
  );
}
report.sort((a, b) => a.at - b.at);
const byHeld = Object.fromEntries(
  Array.from({ length: 11 }, (_, n) => [n, aggregate(report, (p) => p.held === n)]),
);
const byOutcome = Object.fromEntries(
  ['solo', 'tie', 'none'].map((k) => [k, aggregate(report, (p) => p.truth.category === k)]),
);
const result = {
  source,
  phase: phase || 'prospective',
  candidate: phase
    ? 'Same lambda .8 and ESS64, historical peak positive net acquisition per actor/suit instead of current positive net; no new fitted parameter.'
    : null,
  version: B.VERSION,
  method:
    'Primary v7 comparison uses newly recorded rounds excluded from v7 fitting. Phase train uses the first14 new official rounds, validation the reserved latest6, old the20 older Medium rounds. Peak candidate is a new retrospective hypothesis, not prospectively validated. Conditional actual-goal bonus is evaluated at identical prefix inventory; reconstruction supplies evaluation labels only. Equal round weight. HalfStrength is the previously considered v07 alternative, not a newly fitted parameter.',
  maxSavedDifference,
  maxGoalMarginalDifference,
  rounds: report.length,
  excluded,
  all: aggregate(report),
  firstTen: aggregate(report.slice(0, 10)),
  lastTen: aggregate(report.slice(10)),
  finalMatched: aggregate(report, (p) => p.finalInventory),
  byHeld,
  byOutcome,
  report,
};
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    { ...result, report: undefined, byHeld: undefined, byOutcome: undefined },
    null,
    2,
  ),
);
