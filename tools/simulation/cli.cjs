#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { evaluate } = require('./evaluate.cjs');
function parse(args) {
  const result = {};
  const names = {
    games: 'games',
    players: 'players',
    seed: 'seed',
    steps: 'steps',
    samples: 'samples',
    checkpoints: 'checkpoints',
    noise: 'noise',
    brownian: 'brownian',
    'opponent-samples': 'opponentSamples',
    'max-price': 'maxPrice',
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' || key === '-h') {
      result.help = true;
      continue;
    }
    if (key === '--quiet') {
      result.quiet = true;
      continue;
    }
    if (key === '--homogeneous') {
      result.heterogeneous = false;
      continue;
    }
    if (key === '--baseline-version' || key === '--candidate-version') {
      const value = args[++i];
      if (!/^\d+\.\d+\.\d+$/.test(value || '')) throw Error(`${key} requires major.minor.patch`);
      result[key === '--baseline-version' ? 'baselineVersion' : 'candidateVersion'] = value;
      continue;
    }
    if (key === '--difficulty' || key === '--out') {
      result[key.slice(2)] = args[++i];
      if (!result[key.slice(2)]) throw Error(`Missing value for ${key}`);
      continue;
    }
    if (!key.startsWith('--') || !Object.hasOwn(names, key.slice(2)))
      throw Error(`Unknown option ${key}`);
    const value = Number(args[++i]);
    if (!Number.isFinite(value)) throw Error(`Invalid value for ${key}`);
    result[names[key.slice(2)]] = value;
  }
  for (const key of [
    'seed',
    'games',
    'players',
    'steps',
    'samples',
    'checkpoints',
    'opponentSamples',
    'maxPrice',
  ])
    if (
      result[key] !== undefined &&
      (!Number.isInteger(result[key]) || result[key] < (key === 'seed' ? 0 : 1))
    )
      throw Error(`${key} must be a positive integer`);
  if (result.noise < 0 || result.brownian < 0 || result.brownian > 1)
    throw Error('noise >= 0 and brownian in [0,1] are required');
  return result;
}
function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node tools/simulation/cli.cjs [options]
  --games 20 --players 4 --seed 1101 --steps 240 --checkpoints 5
  --samples 128 --opponent-samples 12
  --baseline-version VERSION --candidate-version VERSION
  --difficulty easy|medium|hard --noise 1 --brownian 0 --max-price 50
  --homogeneous       use private-value policies instead of varied styles
  --out result.json   write JSON to a file; otherwise print it
  --quiet             suppress progress on stderr

Version flags select verified immutable model archives, preserving their
defaults unless --samples or --opponent-samples is explicitly supplied.
Without version flags: frozen v0.10 versus current candidate, 128/12 samples.
Independent policies generate the same public path for both forecasters.
PnL is descriptive policy PnL, not a model profit comparison.`);
    return;
  }
  const result = evaluate({
    ...options,
    onProgress: options.quiet
      ? null
      : ({ game, games, trades }) => {
          if (game === 1 || game % 5 === 0 || game === games)
            process.stderr.write(`Simulated ${game}/${games} rounds (${trades} fills in latest)\n`);
        },
  });
  const json = JSON.stringify(result, null, 2) + '\n';
  if (options.out) {
    const file = path.resolve(options.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json);
    process.stderr.write(`Saved ${file}\n`);
  } else process.stdout.write(json);
}
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
module.exports = { parse };
