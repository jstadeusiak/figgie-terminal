/*
 * Goal calibration. Combines the physical goal probabilities with the
 * behavioral ones into the probabilities the model reports, and reweights the
 * sampled worlds to match.
 *
 * Goal-only: reweight worlds before pricing; never edit UI fairs.
 */
(function (scope) {
  'use strict';

  const SUIT_COUNT = 4;
  // How far the sum of a probability vector may be from one.
  const SUM_TOLERANCE = 1e-8;
  const POLICY_KINDS = ['likelihood-power', 'additive', 'raw'];

  const sum = (values) => values.reduce((total, value) => total + value, 0);

  // Returns the vector, or throws unless it holds four probabilities summing to one.
  function requireProbabilities(values, name) {
    const isVector =
      Array.isArray(values) &&
      values.length === SUIT_COUNT &&
      values.every((value) => Number.isFinite(value) && value >= 0);
    if (!isVector) throw Error(name + ' must contain four finite nonnegative probabilities');
    if (Math.abs(sum(values) - 1) > SUM_TOLERANCE) throw Error(name + ' must sum to one');
    return values;
  }

  // The goal probabilities to report. `structural` are the physical ones, `raw`
  // the behavioral posterior. The policy turns the behavioral ones into a
  // signal, and `blend` is the weight that signal gets against the physical ones.
  function targetProbabilities(structural, raw, policy, blend) {
    const physical = requireProbabilities(structural, 'Structural probabilities');
    const behavior = requireProbabilities(raw, 'Behavior probabilities');
    if (!Number.isFinite(blend) || blend < 0 || blend > 1) {
      throw Error('Goal signal blend must be in [0, 1]');
    }
    if (!policy || !POLICY_KINDS.includes(policy.kind)) throw Error('Unknown goal signal policy');
    if (policy.kind === 'raw' && blend !== 1) {
      throw Error('Raw goal signal policy requires explicit blend 1');
    }
    const strength = policy.kind === 'raw' ? 1 : policy.strength;
    if (!Number.isFinite(strength) || strength < 0) {
      throw Error('Goal signal strength must be finite and nonnegative');
    }
    if (behavior.some((probability, goal) => physical[goal] === 0 && probability !== 0)) {
      throw Error('Behavior assigns mass to an impossible goal');
    }

    // Keep the uncalibrated policy an exact algebraic match to existing mixtures.
    const agrees = physical.every((probability, goal) => probability === behavior[goal]);
    if (blend === 0 || agrees) return physical.slice();
    const usesBehaviorAsIs =
      policy.kind === 'raw' || (policy.kind === 'likelihood-power' && strength === 1);
    if (usesBehaviorAsIs) {
      return physical.map(
        (probability, goal) => (1 - blend) * probability + blend * behavior[goal],
      );
    }
    if (strength === 0) return physical.slice();

    const logits = physical.map((probability, goal) =>
      signalLogit(policy.kind, strength, probability, behavior[goal]),
    );
    if (logits.some((logit) => Number.isNaN(logit) || logit === Infinity)) {
      throw Error('Goal signal logits are not finite');
    }
    const largest = Math.max(...logits);
    if (!Number.isFinite(largest)) throw Error('Goal signal has no feasible mass');
    const unnormalized = logits.map((logit) => Math.exp(logit - largest));
    const total = sum(unnormalized);
    return physical.map(
      (probability, goal) => (1 - blend) * probability + (blend * unnormalized[goal]) / total,
    );
  }

  // The unnormalized log probability of one goal's signal. An impossible goal
  // stays impossible under either policy.
  function signalLogit(kind, strength, physical, behavior) {
    if (physical === 0) return -Infinity;
    // Additive: the behavioral shift in probability, scaled.
    if (kind !== 'likelihood-power') return Math.log(physical) + strength * (behavior - physical);
    // Likelihood power: the behavioral likelihood ratio, raised to `strength`.
    if (behavior === 0) return -Infinity;
    return Math.log(physical) + strength * (Math.log(behavior) - Math.log(physical));
  }

  // Rescales the world weights so that each goal's total is its target
  // probability. The distribution of worlds within a goal is unchanged.
  function reweight(worlds, weights, target) {
    requireProbabilities(target, 'Target probabilities');
    if (!Array.isArray(worlds) || !weights || weights.length !== worlds.length) {
      throw Error('Worlds and weights must align');
    }
    const goalMass = [0, 0, 0, 0];
    for (let index = 0; index < worlds.length; index++) {
      const goal = worlds[index].goal;
      const weight = weights[index];
      const isGoal = Number.isInteger(goal) && goal >= 0 && goal < SUIT_COUNT;
      if (!isGoal || !Number.isFinite(weight) || weight < 0) {
        throw Error('Invalid weighted goal world');
      }
      goalMass[goal] += weight;
    }
    if (Math.abs(sum(goalMass) - 1) > SUM_TOLERANCE) throw Error('World weights must sum to one');
    for (let goal = 0; goal < SUIT_COUNT; goal++) {
      if (goalMass[goal] === 0 && target[goal] > 0) {
        throw Error('Target assigns mass to an unsupported goal');
      }
    }
    // Division before multiplication avoids overflow for tiny supported goal mass.
    return Array.from(weights, (weight, index) => {
      const goal = worlds[index].goal;
      return goalMass[goal] > 0 ? (weight / goalMass[goal]) * target[goal] : 0;
    });
  }

  scope.FiggieGoalSignal = { targetProbabilities, reweight };
  if (typeof module !== 'undefined') module.exports = scope.FiggieGoalSignal;
})(globalThis);
