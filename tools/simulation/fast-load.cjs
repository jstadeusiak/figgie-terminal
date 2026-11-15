'use strict';
// Equivalent archived modules in the host realm, with explicit private globals.
// Avoids VM-context built-in lookup overhead without importing mutable live fits.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Registry = require('../model-registry.cjs');
function load(version) {
  const [entry] = Registry.verify(version);
  const folder = path.resolve(__dirname, '../../models', entry.version);
  const cache = new Map();
  if (!entry) throw Error('Unknown model ' + version);
  const scope = { console, performance, Date, setTimeout, clearTimeout, crypto: crypto.webcrypto };
  function localRequire(name, from = folder) {
    if (!name.startsWith('./') && !name.startsWith('../'))
      throw Error('Unexpected model dependency: ' + name);
    const file = path.resolve(from, name);
    if (!file.startsWith(folder + path.sep)) throw Error('Dependency escapes model archive');
    const relative = path.relative(folder, file);
    if (!Object.hasOwn(entry.files, relative))
      throw Error('Unverified model dependency: ' + relative);
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    if (hash !== entry.files[relative])
      throw Error('Archived model changed during load: ' + relative);
    const module = { exports: {} };
    cache.set(file, module);
    const run = vm.compileFunction(
      source.toString('utf8'),
      ['exports', 'require', 'module', '__filename', '__dirname', 'globalThis', 'performance'],
      { filename: file },
    );
    run(
      module.exports,
      (dep) => localRequire(dep, path.dirname(file)),
      module,
      file,
      path.dirname(file),
      scope,
      performance,
    );
    return module.exports;
  }
  const Belief = localRequire('./belief.js');
  const Journal = localRequire('./journal.js');
  const Training = localRequire('./training.js');
  const Pnl = localRequire('./pnl.js');
  const Bonus = localRequire('./bonus-score.js');
  if (Belief.VERSION !== version) throw Error('Archived engine version mismatch');
  return { entry, Belief, Journal, Training, Pnl, Bonus };
}
module.exports = { load };
