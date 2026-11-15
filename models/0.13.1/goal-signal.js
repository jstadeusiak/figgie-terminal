/* Goal-only calibration. Reweight worlds before pricing; never edit UI fairs. */
(function (scope) {
  'use strict';
  const EPS = 1e-8;
  function vector(values, name) {
    if (
      !Array.isArray(values) ||
      values.length !== 4 ||
      values.some((x) => !Number.isFinite(x) || x < 0)
    )
      throw Error(name + ' must contain four finite nonnegative probabilities');
    const total = values.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > EPS) throw Error(name + ' must sum to one');
    return values;
  }
  function targetProbabilities(structural, raw, policy, blend) {
    const s = vector(structural, 'Structural probabilities'),
      b = vector(raw, 'Behavior probabilities');
    if (!Number.isFinite(blend) || blend < 0 || blend > 1)
      throw Error('Goal signal blend must be in [0, 1]');
    if (!policy || !['likelihood-power', 'additive', 'raw'].includes(policy.kind))
      throw Error('Unknown goal signal policy');
    if (policy.kind === 'raw' && blend !== 1)
      throw Error('Raw goal signal policy requires explicit blend 1');
    const strength = policy.kind === 'raw' ? 1 : policy.strength;
    if (!Number.isFinite(strength) || strength < 0)
      throw Error('Goal signal strength must be finite and nonnegative');
    if (b.some((x, g) => s[g] === 0 && x !== 0))
      throw Error('Behavior assigns mass to an impossible goal');
    // Keep the uncalibrated policy an exact algebraic match to existing mixtures.
    if (blend === 0 || s.every((x, g) => x === b[g])) return s.slice();
    if (policy.kind === 'raw' || (policy.kind === 'likelihood-power' && strength === 1))
      return s.map((x, g) => (1 - blend) * x + blend * b[g]);
    if (strength === 0) return s.slice();
    const logits = s.map((x, g) => {
      if (x === 0) return -Infinity;
      if (policy.kind === 'likelihood-power')
        return b[g] === 0 ? -Infinity : Math.log(x) + strength * (Math.log(b[g]) - Math.log(x));
      return Math.log(x) + strength * (b[g] - x);
    });
    if (logits.some((x) => Number.isNaN(x) || x === Infinity))
      throw Error('Goal signal logits are not finite');
    const max = Math.max(...logits);
    if (!Number.isFinite(max)) throw Error('Goal signal has no feasible mass');
    const q = logits.map((x) => Math.exp(x - max)),
      total = q.reduce((a, b) => a + b, 0);
    return s.map((x, g) => (1 - blend) * x + (blend * q[g]) / total);
  }
  function reweight(worlds, weights, target) {
    vector(target, 'Target probabilities');
    if (!Array.isArray(worlds) || !weights || weights.length !== worlds.length)
      throw Error('Worlds and weights must align');
    const mass = [0, 0, 0, 0];
    for (let i = 0; i < worlds.length; i++) {
      const g = worlds[i].goal,
        w = weights[i];
      if (!Number.isInteger(g) || g < 0 || g > 3 || !Number.isFinite(w) || w < 0)
        throw Error('Invalid weighted goal world');
      mass[g] += w;
    }
    if (Math.abs(mass.reduce((a, b) => a + b, 0) - 1) > EPS)
      throw Error('World weights must sum to one');
    for (let g = 0; g < 4; g++)
      if (mass[g] === 0 && target[g] > 0) throw Error('Target assigns mass to an unsupported goal');
    // Division before multiplication avoids overflow for tiny supported goal mass.
    return Array.from(weights, (w, i) => {
      const g = worlds[i].goal;
      return mass[g] > 0 ? (w / mass[g]) * target[g] : 0;
    });
  }
  const api = { targetProbabilities, reweight };
  scope.FiggieGoalSignal = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
