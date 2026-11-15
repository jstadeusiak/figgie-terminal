#!/usr/bin/env node
'use strict';
/* Actual posted-quote diagnostics on fixed TRAIN seeds. Never inserts a trade. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Registry = require('../tools/model-registry.cjs');
const { runRound } = require('../tools/simulation/simulator.cjs');
const { transferValue } = require('../tools/simulation/evaluate.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/simulation-audit-2026-10-28');
const SIM = path.join(ROOT, 'tools/simulation');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const copy = (x) => JSON.parse(JSON.stringify(x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function resolve(quote, round) {
  const expires = quote.at + 10000;
  for (let i = quote.frame + 1; i < round.trace.length; i++) {
    const f = round.trace[i];
    const s = f.snapshot;
    const elapsed = (f.at - quote.at) / 1000;
    if (f.at > expires)
      return {
        filled: false,
        censored: false,
        reason: '10-second horizon',
        seconds: 10,
        realizedPayoff: 0,
      };
    const newTrades = s.trades.slice(quote.epoch);
    const hit = newTrades.find(
      (t) =>
        t.suit === quote.suit &&
        t.p === quote.price &&
        (quote.side === 'bid' ? t.b === quote.owner : t.s === quote.owner),
    );
    if (hit) {
      const peer = quote.truth.names.indexOf(quote.side === 'bid' ? hit.s : hit.b);
      const value = transferValue(
        quote.truth,
        0,
        peer,
        quote.suitIndex,
        quote.side === 'bid' ? 'buy' : 'sell',
      );
      return {
        filled: true,
        censored: false,
        reason: 'fill',
        seconds: elapsed,
        peer: quote.truth.names[peer],
        realizedPayoff: quote.side === 'bid' ? value - quote.price : quote.price - value,
      };
    }
    if (newTrades.length)
      return {
        filled: false,
        censored: false,
        reason: 'other trade reset',
        seconds: elapsed,
        realizedPayoff: 0,
      };
    if (s.status === 'ended')
      return { filled: false, censored: true, reason: 'round ended', seconds: elapsed };
    const m = s.markets[quote.suitIndex];
    const owner = m[quote.side === 'bid' ? 'buyer' : 'seller'];
    if (owner !== quote.owner || m[quote.side] !== quote.price) {
      const a = round.actions[f.step - 1];
      return {
        filled: false,
        censored: a?.actor === quote.owner,
        reason: a?.actor === quote.owner ? 'own replacement/cancel' : 'lost top of book',
        seconds: elapsed,
        ...(a?.actor === quote.owner ? {} : { realizedPayoff: 0 }),
      };
    }
    if (f.at === expires)
      return {
        filled: false,
        censored: false,
        reason: '10-second horizon',
        seconds: 10,
        realizedPayoff: 0,
      };
  }
  return { filled: false, censored: true, reason: 'observation ended', seconds: null };
}
function summary(points) {
  const usable = points.filter((p) => !p.censored);
  const rounds = [...new Set(usable.map((p) => p.game))];
  const byRound = rounds.map((game) => {
    const rows = usable.filter((p) => p.game === game);
    return {
      game,
      n: rows.length,
      predicted: mean(rows.map((p) => p.pFill)),
      observed: mean(rows.map((p) => +p.filled)),
      brier: mean(rows.map((p) => (p.pFill - Number(p.filled)) ** 2)),
      expectedPayoff: mean(rows.map((p) => p.expectedPayoff)),
      realizedPayoff: mean(rows.map((p) => p.realizedPayoff)),
      payoffMse: mean(rows.map((p) => (p.expectedPayoff - p.realizedPayoff) ** 2)),
    };
  });
  const bins = Array.from({ length: 10 }, (_, i) => {
    const rows = usable.filter((p) => Math.min(9, Math.floor(p.pFill * 10)) === i);
    return {
      from: i / 10,
      to: (i + 1) / 10,
      n: rows.length,
      predicted: mean(rows.map((p) => p.pFill)),
      observed: mean(rows.map((p) => +p.filled)),
    };
  }).filter((b) => b.n);
  return {
    opportunities: points.length,
    uncensored: usable.length,
    censored: points.length - usable.length,
    reasons: Object.fromEntries(
      [...new Set(points.map((p) => p.reason))].map((reason) => [
        reason,
        points.filter((p) => p.reason === reason).length,
      ]),
    ),
    opportunityWeighted: {
      predicted: mean(usable.map((p) => p.pFill)),
      observed: mean(usable.map((p) => +p.filled)),
      brier: mean(usable.map((p) => (p.pFill - Number(p.filled)) ** 2)),
      expectedPayoff: mean(usable.map((p) => p.expectedPayoff)),
      realizedPayoff: mean(usable.map((p) => p.realizedPayoff)),
    },
    equalRound: {
      rounds: rounds.length,
      predicted: mean(byRound.map((r) => r.predicted)),
      observed: mean(byRound.map((r) => r.observed)),
      brier: mean(byRound.map((r) => r.brier)),
      expectedPayoff: mean(byRound.map((r) => r.expectedPayoff)),
      realizedPayoff: mean(byRound.map((r) => r.realizedPayoff)),
      payoffRmse: byRound.length ? Math.sqrt(mean(byRound.map((r) => r.payoffMse))) : null,
    },
    bins,
    byRound,
  };
}
function run(options = {}) {
  const manifestPath =
    options.manifest || path.join(ROOT, 'outputs/simulation-review-2026-10-28/manifest.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const limit = options.limit || 24;
  const context = options.context || 'Medium';
  const games = manifest.games.filter((g) => g.partition === 'train').slice(0, limit);
  const release = Registry.load('0.11.0');
  const points = [];
  if (games.length !== limit) throw Error('Insufficient fixed training games');
  for (const [name, hash] of Object.entries(manifest.generatorHashes))
    if (sha(fs.readFileSync(path.join(SIM, name))) !== hash)
      throw Error('Generator changed after seed manifest');
  for (const game of games) {
    const journal = new release.Journal.RoundJournal(game.id, game.id);
    const engine = new release.Belief.BeliefEngine();
    const quotes = [];
    let previous = null;
    const round = runRound({
      ...game,
      steps: manifest.steps,
      onSnapshot(snapshot, truth, frame) {
        journal.observe(snapshot, frame.at);
        const fresh = [];
        for (let s = 0; s < 4; s++)
          for (const side of ['bid', 'ask']) {
            const m = snapshot.markets[s];
            const old = previous?.markets[s];
            const ownerKey = side === 'bid' ? 'buyer' : 'seller';
            if (m[ownerKey] !== snapshot.self || !Number.isFinite(m[side])) continue;
            if (
              old?.[ownerKey] === snapshot.self &&
              old[side] === m[side] &&
              previous.trades.length === snapshot.trades.length
            )
              continue;
            fresh.push({ m, s, side });
          }
        if (fresh.length) {
          const input = release.Training.blindSnapshot({
            ...snapshot,
            context: { ...snapshot.context, botDifficulty: context },
          });
          const model = engine.infer(input, journal.evidence, { rates: copy(journal.rates) });
          for (const { m, s, side } of fresh) {
            const forecast = model.actualBook?.[m.id]?.[side];
            if (!forecast) continue;
            quotes.push({
              game: game.id,
              seed: game.seed,
              players: game.players,
              heterogeneous: game.heterogeneous,
              regime: game.name,
              frame: frame.step,
              at: frame.at,
              epoch: snapshot.trades.length,
              suit: m.id,
              suitIndex: s,
              side,
              owner: snapshot.self,
              price: m[side],
              pFill: forecast.pFill,
              expectedPayoff: forecast.ev,
              conditionalEdge: forecast.conditionalEdge,
              rates: copy(journal.rates),
              truth: copy(truth),
            });
          }
        }
        previous = snapshot;
      },
    });
    for (const quote of quotes) {
      const outcome = resolve(quote, round);
      delete quote.truth;
      points.push({ ...quote, ...outcome, ownPolicy: round.policyTypes[0] });
    }
    process.stderr.write(`Fill diagnostic ${points.length} quotes after ${game.id}\n`);
  }
  const report = {
    schema: 1,
    createdAt: new Date().toISOString(),
    manifestSha256: sha(manifestBytes),
    generatorHashes: manifest.generatorHashes,
    model: { version: '0.11.0', bundleSha256: release.entry.bundleSha256 },
    options: {
      limit,
      context,
      steps: manifest.steps,
      ratePrior:
        'Only rates observed so far within each simulated round; no future/global-rate fit',
    },
    selectedTrainSeeds: games.map((g) => g.seed),
    summary: summary(points),
    bySide: Object.fromEntries(
      ['bid', 'ask'].map((side) => [side, summary(points.filter((p) => p.side === side))]),
    ),
    byStratum: Object.fromEntries(
      [...new Set(points.map((p) => [p.players, p.heterogeneous, p.regime].join('|')))].map(
        (key) => [
          key,
          summary(points.filter((p) => [p.players, p.heterogeneous, p.regime].join('|') === key)),
        ],
      ),
    ),
    points,
    limitations: [
      'Training seeds only; synthetic policy behavior does not validate native player fill calibration.',
      'Only actual newly posted own best quotes are forecast. No counterfactual quote or future trade is inserted.',
      'Observation stops at target fill, other-trade reset, lost top, or10 seconds. Own amendments/cancel and end-of-round are censored.',
      'Censoring by the own policy may be informative. Uncensored calibration is descriptive, without inverse-probability correction.',
      'Realized payoff is zero on completed no-fill opportunities; on fills it is the named transfer settle-now gain at the quoted price. This is not full-round strategy profit.',
      'Frame gaps/units follow generator clock. Baseline hazard priors here omit historical global fill-rate learning.',
    ],
  };
  fs.mkdirSync(OUT, { recursive: true });
  const output = options.out || path.join(OUT, 'actual-posted-fill-diagnostic.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  return { output, summary: report.summary, bySide: report.bySide };
}
module.exports = { resolve, summary, run };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--limit') options.limit = Number(args[++i]);
      else if (args[i] === '--context') options.context = args[++i];
      else if (args[i] === '--out') options.out = args[++i];
      else throw Error('Unknown argument ' + args[i]);
    }
    console.log(JSON.stringify(run(options), null, 2));
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
