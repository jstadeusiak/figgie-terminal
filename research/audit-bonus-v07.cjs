/* Offline bonus audit. Reconstructs only evaluation labels from official payouts;
   hidden final counts never enter forecast replay or its prior. */
const fs = require('fs');
const path = require('path');
const B = require('../extension/belief-v0.6.js');
const J = require('../extension/journal.js');
const source = process.argv[2] || 'outputs/trading-review-2026-10-27/recordings-combined.ndjson';
const out = process.argv[3] || 'outputs/model-review-v07/bonus-audit.json';
const rows = fs.readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse);
const ids = B.IDS;
const skip = new Set(['round-1793144490477-e7c5a184']);
const metas = rows
  .filter((r) => r.kind === 'round_metadata' && !skip.has(r.id))
  .sort((a, b) => a.base - b.base);
const events = new Map(metas.map((m) => [m.id, []]));
for (const r of rows) if (events.has(r.roundId)) events.get(r.roundId).push(r);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : null);
const variantMode = process.env.BONUS_VARIANTS === '1';
function directionalModule() {
  const Module = require('module');
  const filename = path.resolve('extension/belief-v0.6.js');
  let source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('function reservation(');
  const end = source.indexOf('function eventLogs(', start);
  const replacement = `const bonusReservationCache=new Map();
function expectedPrivateBonus(initial,actor,s,context,buy){
 const n=context.names?.length||4,size=40/n,net=context.net||[],own=initial[s]+(net[actor]?.[s]||0),others=Array.from({length:n},(_,i)=>i).filter(i=>i!==actor),flows=others.map(i=>net[i]?.[s]||0);
 if(!buy&&own<1)return 0;
 const key=initial.join(',')+'|'+s+'|'+own+'|'+flows.join(',')+'|'+buy;if(bonusReservationCache.has(key))return bonusReservationCache.get(key);
 const cfg=DECKS.map(d=>({...d,w:d.deck.reduce((v,k,i)=>v*C(k,initial[i]),1)})),total=sum(cfg.map(d=>d.w));let value=0;
 for(const totalGoal of [8,10]){const prior=sum(cfg.filter(d=>d.goal===s&&d.deck[s]===totalGoal).map(d=>d.w))/total;if(!prior)continue;const bonus=200-10*totalGoal,remaining=totalGoal-initial[s],row=[],k=n-1;let weighted=0,mass=0;
  function rec(i,left,w){if(i===k){if(left)return;const counts=[own,...row.map((v,j)=>v+flows[j])],before=payout(counts,bonus)-10*own;let delta=0,possible=0;for(let j=1;j<n;j++){if(buy&&counts[j]<1)continue;const after=counts.slice();after[0]+=buy?1:-1;after[j]+=buy?-1:1;const later=payout(after,bonus)-10*after[0];delta+=buy?later-before:before-later;possible++;}if(possible){weighted+=w*delta/possible;mass+=w;}return;}
   for(let v=Math.max(0,-flows[i]);v<=Math.min(size,left);v++){row[i]=v;rec(i+1,left-v,w*C(size,v));}}
  rec(0,remaining,1);if(mass)value+=prior*weighted/mass;
 }
 if(bonusReservationCache.size>50000)bonusReservationCache.clear();bonusReservationCache.set(key,value);return value;
}
function reservation(initial,actor,s,context,style){
 const belief=privateBelief(initial),q=belief.goals[s],qty=initial[s]+(context.net?.[actor]?.[s]||0);
 if(style===2)return Math.max(1,context.anchor||5)-.25*(qty-3);
 return 10*q+(style===1?expectedPrivateBonus(initial,actor,s,context,context.buy!==false):0);
}
`;
  source = source.slice(0, start) + replacement + source.slice(end);
  source = source.replace(
    'ctx={...context,net:event.net,anchor:event.anchor}',
    'ctx={...context,net:event.net,anchor:event.anchor,buy}',
  );
  const modified = new Module(filename);
  modified.filename = filename;
  modified.paths = Module._nodeModulePaths(path.dirname(filename));
  modified._compile(source, filename);
  return modified.exports;
}
const DB = variantMode ? directionalModule() : null;
function askModule() {
  const Module = require('module');
  const filename = path.resolve('extension/belief-v0.6.js');
  let source = fs.readFileSync(filename, 'utf8');
  source = source
    .replace(
      'build(snapshot){\n  const state=physical(snapshot),key=',
      `build(snapshot,events=[]){
  const state=physical(snapshot);
  for(const e of events){if(e.kind!=='quote'||e.direction!=='sell'||e.recovered)continue;const actor=state.names.indexOf(e.actor),s=IDS.indexOf(e.suit),net=e.net?.[actor]?.[s];if(actor<=0||s<0||!Number.isInteger(net))continue;state.minimum[actor][s]=Math.max(state.minimum[actor][s],1-net);}
  const key=`,
    )
    .replace('this.build(snapshot);', 'this.build(snapshot,events);');
  const modified = new Module(filename);
  modified.filename = filename;
  modified.paths = Module._nodeModulePaths(path.dirname(filename));
  modified._compile(source, filename);
  return modified.exports;
}
const AB = variantMode ? askModule() : null;
const CONCENTRATION = [0.1, 0.2, 0.4, 0.8];
// Proposed runtime helper: preserves each goal's marginal; the optional guard
// blends toward original conditional worlds only if effective support falls <64.
function inventoryWeights(worlds, weights, net, strength, minEffective = 64) {
  const started = performance.now();
  const mass = [0, 0, 0, 0];
  const maxScore = [-Infinity, -Infinity, -Infinity, -Infinity];
  const scores = worlds.map(
    (w) =>
      strength *
      sum(w.initial.slice(1).map((row, a) => Math.max(0, net[a + 1][w.goal]) * row[w.goal])),
  );
  worlds.forEach((w, i) => {
    mass[w.goal] += weights[i];
    maxScore[w.goal] = Math.max(maxScore[w.goal], scores[i]);
  });
  const norm = [0, 0, 0, 0];
  const raw = worlds.map((w, i) => {
    const x = weights[i] * Math.exp(scores[i] - maxScore[w.goal]);
    norm[w.goal] += x;
    return x;
  });
  const p2 = [0, 0, 0, 0];
  const q2 = [0, 0, 0, 0];
  const pq = [0, 0, 0, 0];
  worlds.forEach((w, i) => {
    const g = w.goal;
    const p = weights[i] / mass[g];
    const q = raw[i] / norm[g];
    p2[g] += p * p;
    q2[g] += q * q;
    pq[g] += p * q;
  });
  const blends = mass.map((m, g) => {
    if (!m || !minEffective) return 1;
    const target = Math.min(minEffective, 1 / p2[g]);
    if (1 / q2[g] >= target) return 1;
    const a = q2[g] + p2[g] - 2 * pq[g];
    const b = 2 * (pq[g] - p2[g]);
    const c = p2[g] - 1 / target;
    return a > 1e-15
      ? Math.max(0, Math.min(1, (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a)))
      : 0;
  });
  const after2 = [0, 0, 0, 0];
  const maximum = [0, 0, 0, 0];
  const result = worlds.map((w, i) => {
    const g = w.goal;
    const p = weights[i] / mass[g];
    const q = raw[i] / norm[g];
    const v = p + blends[g] * (q - p);
    after2[g] += v * v;
    maximum[g] = Math.max(maximum[g], v);
    return mass[g] * v;
  });
  return {
    weights: result,
    computeMs: performance.now() - started,
    goals: mass.map((m, g) => ({
      goal: g,
      probability: m,
      effectiveBefore: m ? 1 / p2[g] : null,
      effectiveAfter: m ? 1 / after2[g] : null,
      calibrationBlend: blends[g],
      maxConditionalWeight: maximum[g],
    })),
  };
}
function bonusFromWeights(engine, g, weights) {
  let mass = 0;
  let bonus = 0;
  let solo = 0;
  let tie = 0;
  let none = 0;
  engine.latest.worlds.forEach((w, i) => {
    if (w.goal !== g) return;
    const counts = w.initial.map((row, a) => row[g] + engine.state.net[a][g]);
    const max = Math.max(...counts);
    const ties = counts.filter((v) => v === max).length;
    const lead = counts[0] === max;
    const wt = weights[i];
    mass += wt;
    if (lead) {
      bonus += (wt * w.bonus) / ties;
      if (ties === 1) solo += wt;
      else tie += wt;
    } else none += wt;
  });
  return {
    bonus: bonus / mass,
    leader: (solo + tie) / mass,
    solo: solo / mass,
    tie: tie / mass,
    none: none / mass,
  };
}

function concentrationModel(engine, g, snapshot, lambda) {
  const { worlds, weights } = engine.latest;
  const net = engine.state.net;
  let total = 0;
  let bonus = 0;
  let solo = 0;
  let tie = 0;
  let none = 0;
  let squared = 0;
  const scored = worlds
    .map((w, i) =>
      w.goal === g
        ? {
            w,
            i,
            score:
              lambda * sum(w.initial.slice(1).map((row, a) => Math.max(0, net[a + 1][g]) * row[g])),
          }
        : null,
    )
    .filter(Boolean);
  const max = Math.max(...scored.map((x) => x.score));
  for (const { w, i, score } of scored) {
    const wt = weights[i] * Math.exp(score - max);
    const counts = w.initial.map((row, a) => row[g] + net[a][g]);
    const highest = Math.max(...counts);
    const ties = counts.filter((c) => c === highest).length;
    const lead = counts[0] === highest;
    total += wt;
    squared += wt * wt;
    if (lead) {
      bonus += (wt * w.bonus) / ties;
      if (ties === 1) solo += wt;
      else tie += wt;
    } else none += wt;
  }
  return {
    bonus: bonus / total,
    leader: (solo + tie) / total,
    solo: solo / total,
    tie: tie / total,
    none: none / total,
    effectiveWorlds: (total * total) / squared,
  };
}

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
    Math.abs(sum(Object.values(r.profits))) > 1e-6
  )
    return { reason: 'No complete official goal/payout vector' };
  const net = B.physical(s);
  const cash = names.map(() => 0);
  for (const t of s.trades) {
    cash[names.indexOf(t.b)] -= t.p;
    cash[names.indexOf(t.s)] += t.p;
  }
  const payout = names.map((name, i) => r.profits[name] - cash[i] + 200 / n);
  if (payout.some((v) => v < -1e-6) || Math.abs(sum(payout) - 200) > 1e-6)
    return { reason: 'Payouts do not reconcile' };
  const candidates = [];
  for (const total of [8, 10]) {
    const counts = [];
    function rec(i, left) {
      if (i === n) {
        if (left) return;
        const max = Math.max(...counts);
        const ties = counts.filter((v) => v === max).length;
        const bonus = 200 - total * 10;
        if (
          !counts.every(
            (c, j) => Math.abs(10 * c + (c === max ? bonus / ties : 0) - payout[j]) < 1e-6,
          )
        )
          return;
        const initial = counts.map((v, j) => v - net.net[j][g]);
        if (initial.some((v, j) => v < net.minimum[j][g] || v > size)) return;
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
  const st = B.physical(s);
  const vals = recovered.candidates.map((c) => {
    const counts = c.initial.map((v, i) => v + st.net[i][recovered.goal]);
    if (counts.some((v) => v < 0)) return null;
    const max = Math.max(...counts);
    const ties = counts.filter((v) => v === max).length;
    const lead = counts[0] === max;
    const bonus = lead ? c.bonus / ties : 0;
    return {
      bonus,
      category: lead ? (ties === 1 ? 'solo' : 'tie') : 'none',
      counts,
      deck: c.total,
    };
  });
  if (vals.some((v) => !v)) return null;
  return vals.every((v) => v.bonus === vals[0].bonus && v.category === vals[0].category)
    ? vals[0]
    : null;
}
function metrics(points, key) {
  const good = points.filter((p) => p[key]);
  return {
    n: good.length,
    bias: avg(good.map((p) => p[key].bonus - p.truth.bonus)),
    mae: avg(good.map((p) => Math.abs(p[key].bonus - p.truth.bonus))),
    rmse: good.length ? Math.sqrt(avg(good.map((p) => (p[key].bonus - p.truth.bonus) ** 2))) : null,
    leaderBrier: avg(good.map((p) => (p[key].leader - Number(p.truth.category !== 'none')) ** 2)),
    categoryBrier: avg(
      good
        .filter((p) => p[key].solo !== undefined)
        .map((p) =>
          ['solo', 'tie', 'none'].reduce(
            (v, k) => v + (p[key][k] - Number(p.truth.category === k)) ** 2,
            0,
          ),
        ),
    ),
  };
}
function compact(v) {
  return {
    bonus: v.conditionalBonus,
    leader: v.conditionalLeaderProbability,
    solo: v.conditionalSoloProbability,
    tie: v.conditionalTieProbability,
    none: v.conditionalNoBonusProbability,
    goal: v.probability,
  };
}
const report = [];
const excluded = [];
for (const m of metas) {
  const r = recover(m);
  if (r.reason) {
    excluded.push({ id: m.id, reason: r.reason });
    continue;
  }
  const es = events.get(m.id).sort((a, b) => a.seq - b.seq);
  const predictions = J.livePredictions(es);
  const engine = new B.BeliefEngine({ skipPricing: true });
  const baseEngine = new B.BeliefEngine({ skipPricing: true });
  const directionalEngine = DB ? new DB.BeliefEngine({ skipPricing: true }) : null;
  const askEngine = AB ? new AB.BeliefEngine({ skipPricing: true }) : null;
  const strongEngine = variantMode
    ? new B.BeliefEngine({
        skipPricing: true,
        signalPolicy: { temperature: 1.2, quote: 0.2, consent: 0.12, cap: 5 },
      })
    : null;
  const points = [];
  for (const p of predictions) {
    const prefix = es.filter((e) => e.seq < p.seq);
    const s = J.replay(prefix);
    if (!s || s.trades.length !== p.tradeCount) continue;
    const truth = truthAt(r, s);
    if (!truth) continue;
    const prior = prefix.findLast((e) => e.kind === 'learning_prior')?.learning || {};
    const j = J.restore({ ...m, snapshot: s, revealed: null }, prefix);
    const current = engine.infer(s, j.evidence, prior);
    const base = baseEngine.infer(s, j.evidence, { ...prior, forceBaseline: true });
    const saved = p.goalScenarios?.find((v) => v.suit === ids[r.goal]);
    const directional = directionalEngine?.infer(s, j.evidence, prior);
    const strong = strongEngine?.infer(s, j.evidence, prior);
    const ask = askEngine?.infer(s, j.evidence, prior);
    const tilts = ask
      ? Object.fromEntries(
          [
            ['half', 0.4, 0],
            ['full', 0.8, 0],
            ['guarded', 0.8, 64],
          ].map(([key, strength, guard]) => [
            key,
            inventoryWeights(
              askEngine.latest.worlds,
              askEngine.latest.weights,
              askEngine.state.net,
              strength,
              guard,
            ),
          ]),
        )
      : null;
    points.push({
      seq: p.seq,
      at: p.at,
      timer: s.timer,
      tradeCount: p.tradeCount,
      finalInventory: p.tradeCount === m.snapshot.trades.length,
      held: s.held[r.goal],
      truth,
      current: compact(current.bySuit[r.goal]),
      ...(directional
        ? {
            directional: compact(directional.bySuit[r.goal]),
            strong: compact(strong.bySuit[r.goal]),
            ask: compact(ask.bySuit[r.goal]),
            askGuarded: bonusFromWeights(askEngine, r.goal, tilts.guarded.weights),
            inventoryDiagnostics: Object.fromEntries(
              Object.entries(tilts).map(([k, v]) => [
                k,
                { goals: v.goals, computeMs: v.computeMs },
              ]),
            ),
            ...Object.fromEntries(
              CONCENTRATION.map((a) => [
                'askConcentration' + a,
                concentrationModel(askEngine, r.goal, s, a),
              ]),
            ),
            ...Object.fromEntries(
              CONCENTRATION.map((a) => [
                'concentration' + a,
                concentrationModel(engine, r.goal, s, a),
              ]),
            ),
          }
        : {}),
      physical: compact(base.bySuit[r.goal]),
      saved: saved
        ? { bonus: saved.bonus, leader: saved.leaderProbability, goal: saved.probability }
        : null,
    });
  }
  const asks = es
    .filter(
      (e) => e.kind === 'quote' && e.side === 'ask' && e.suit === ids[r.goal] && e.owner && e.net,
    )
    .map((e) => {
      const actor = r.names.indexOf(e.owner);
      const qty = r.candidates.map((c) => c.initial[actor] + e.net[actor]?.[r.goal]);
      return {
        seq: e.seq,
        owner: e.owner,
        price: e.price,
        epoch: e.epoch,
        recovered: e.recovered,
        qty,
      };
    });
  report.push({
    asks,
    id: m.id,
    at: es[0]?.at,
    difficulty: m.snapshot.context?.botDifficulty,
    goal: ids[r.goal],
    finalTradeCount: m.snapshot.trades.length,
    finalCounts: r.candidates,
    candidates: r.candidates.length,
    officialPayouts: r.payout,
    points,
    metrics: Object.fromEntries(
      [
        'current',
        'physical',
        'saved',
        ...(variantMode
          ? [
              'directional',
              'strong',
              'ask',
              'askGuarded',
              ...CONCENTRATION.map((a) => 'concentration' + a),
              ...CONCENTRATION.map((a) => 'askConcentration' + a),
            ]
          : []),
      ].map((k) => [k, metrics(points, k)]),
    ),
    last: points.at(-1),
  });
  console.log('Bonus audit', report.length, m.id, points.length, r.candidates.length);
}
report.sort((a, b) => a.at - b.at);
function aggregate(rs, filter = () => true) {
  return Object.fromEntries(
    [
      'current',
      'physical',
      'saved',
      ...(variantMode
        ? [
            'directional',
            'strong',
            'ask',
            'askGuarded',
            ...CONCENTRATION.map((a) => 'concentration' + a),
            ...CONCENTRATION.map((a) => 'askConcentration' + a),
          ]
        : []),
    ].map((k) => {
      const ms = rs.map((r) => metrics(r.points.filter(filter), k)).filter((m) => m.n);
      return [
        k,
        {
          rounds: ms.length,
          checkpoints: sum(ms.map((m) => m.n)),
          ...Object.fromEntries(
            ['bias', 'mae', 'rmse', 'leaderBrier', 'categoryBrier'].map((metric) => [
              metric,
              avg(ms.map((m) => m[metric]).filter(Number.isFinite)),
            ]),
          ),
        },
      ];
    }),
  );
}
const bins = [
  [0, 0.1],
  [0.1, 0.5],
  [0.5, 0.9],
  [0.9, 1.000001],
].map(([lo, hi]) => {
  const points = report.flatMap((r) =>
    r.points.filter((p) => p.current.leader >= lo && p.current.leader < hi),
  );
  return {
    lo,
    hi,
    points: points.length,
    predicted: avg(points.map((p) => p.current.leader)),
    actual: avg(points.map((p) => Number(p.truth.category !== 'none'))),
  };
});
const askEvidence = {
  quotes: sum(report.map((r) => r.asks.length)),
  violations: report.flatMap((r) =>
    r.asks.filter((e) => e.qty.every((q) => q <= 0)).map((e) => ({ id: r.id, ...e })),
  ),
  ambiguous: report.flatMap((r) =>
    r.asks
      .filter((e) => e.qty.some((q) => q <= 0) && e.qty.some((q) => q > 0))
      .map((e) => ({ id: r.id, ...e })),
  ),
};
const result = {
  source,
  askEvidence,
  method:
    'Official profit − public net trading cash + ante reconstructs payout. Enumerate legal 8/10 goal count vectors matching all players. Reverse public net flow for each earlier checkpoint. Only agreed labels across possible allocations scored; no future labels enter replay. Each round equal weight.',
  rounds: report.length,
  excluded,
  all: aggregate(report),
  early: aggregate(report.slice(0, Math.max(0, report.length - 5))),
  latestFive: aggregate(report.slice(-5)),
  finalMatched: aggregate(report, (p) => p.finalInventory),
  leaderBins: bins,
  report,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, report: undefined, excluded: undefined }, null, 2));
