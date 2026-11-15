/*
 * Visible profile ratings. Reads the rating and lifetime statistics Figgie shows
 * on its Setup screen, validates stored observations, and describes the interval
 * between consecutive observations. As a content script it also hands each new
 * observation to the background worker to be saved.
 *
 * Visible profile statistics only. No game polling, account API, or rating
 * formula assumptions.
 */
(function (scope) {
  'use strict';

  // Statistic labels as Figgie displays them, and the field each is stored under.
  const LABELS = {
    'Current Match Rating': 'rating',
    'Consecutive Days Played': 'activeStreak',
    'Lifetime Rounds Played': 'lifetimeRounds',
    'Lifetime Rounds Won': 'lifetimeWins',
    'Longest Winning Streak': 'winningStreakDisplayed',
    'Longest Losing Streak': 'losingStreakDisplayed',
    'Lifetime Earnings': 'lifetimeProfit',
    'Highest Profit earned (in a round)': 'bestProfit',
    'Biggest loss (in a round)': 'worstProfit',
    'Number of Profitable Rounds': 'profitableRounds',
    'Lifetime Goal Suit Wins': 'goalWins',
    'Rounds played on Easy': 'roundsEasy',
    'Rounds played on Medium': 'roundsMedium',
    'Rounds played on Hard': 'roundsHard',
    'Total Trades Made': 'totalTrades',
    'Win/Loss Ratio': 'winLossRatio',
  };
  // The rating is stored beside the statistics, not among them.
  const STAT_KEYS = Object.values(LABELS).filter((key) => key !== 'rating');

  const SCHEMA = 1;
  const SOURCE = 'visible-statistics';
  const MAX_ID_LENGTH = 160;
  const MAX_NAME_LENGTH = 120;
  const MAX_TIMESTAMP = 8640000000000000; // The latest time a Date can represent.
  const MAX_MAGNITUDE = 1e12;
  const PROFIT_TOLERANCE = 1e-6;

  const SETUP_TITLE = 'Setup';
  const TEXT_SELECTOR = '[dir="auto"]';
  const HIDDEN_SELECTOR = '[hidden],[aria-hidden="true"]';

  // The status line is added to the recordings panel that content.js creates.
  const RECORDINGS_PANEL_ID = 'figgie-recordings-panel';
  const STATUS_ID = 'figgie-rating-status';
  const STATUS_STYLE = 'font-size:12px;line-height:1.4;color:#abc0c8;margin:8px 0';
  const POLL_INTERVAL_MS = 1000;
  const REPLY_TIMEOUT_MS = 8000;
  const RETRY_DELAY_MS = 3000;

  // Returns a clean copy of a well-formed observation, or null. Everything read
  // from the page, received by the worker, or loaded from storage goes through it.
  function validate(observation) {
    if (!isWellFormed(observation)) return null;
    const stats = copyKnownStats(observation.stats);
    if (!stats) return null;
    if (!Number.isSafeInteger(stats.lifetimeRounds) || stats.lifetimeRounds < 0) return null;
    return {
      id: observation.id,
      schema: SCHEMA,
      self: observation.self.trim(),
      at: observation.at,
      source: observation.source,
      rating: observation.rating,
      stats,
    };
  }

  function isWellFormed(observation) {
    return (
      Boolean(observation) &&
      observation.schema === SCHEMA &&
      observation.source === SOURCE &&
      isId(observation.id) &&
      isPlayerName(observation.self) &&
      isTimestamp(observation.at) &&
      isBoundedNumber(observation.rating) &&
      Boolean(observation.stats) &&
      typeof observation.stats === 'object'
    );
  }

  function isId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
  }

  function isPlayerName(name) {
    return typeof name === 'string' && name.trim().length > 0 && name.length <= MAX_NAME_LENGTH;
  }

  function isTimestamp(at) {
    return Number.isSafeInteger(at) && at > 0 && at <= MAX_TIMESTAMP;
  }

  function isBoundedNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_MAGNITUDE;
  }

  // Keeps the known statistics that are present. One malformed value rejects
  // the whole observation.
  function copyKnownStats(source) {
    const stats = {};
    for (const key of STAT_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      if (!isBoundedNumber(source[key])) return null;
      stats[key] = source[key];
    }
    return stats;
  }

  // Two observations with the same fingerprint show the same profile.
  function fingerprint(observation) {
    return JSON.stringify([
      observation.self,
      observation.rating,
      STAT_KEYS.map((key) => observation.stats[key] ?? null),
    ]);
  }

  // Reads the profile shown on the Setup screen, where the first input holds
  // your name. The id is a placeholder: the content script assigns the real
  // one when it queues the observation.
  function read(doc, at = Date.now()) {
    if (doc.title !== SETUP_TITLE) return null;
    const root = doc.getElementById('root');
    if (!root) return null;
    const { rating, ...stats } = readStatistics(root);
    const self = root.querySelector('input')?.value?.trim();
    return validate({ id: 'pending', schema: SCHEMA, self, at, source: SOURCE, rating, stats });
  }

  function readStatistics(root) {
    const values = {};
    for (const node of root.querySelectorAll(TEXT_SELECTOR)) {
      if (!isLeaf(node)) continue;
      const key = LABELS[normalizeLabel(node.textContent)];
      if (!key || node.closest(HIDDEN_SELECTOR)) continue;
      const value = readValueBeside(node);
      if (value !== null) values[key] = value;
    }
    return values;
  }

  // A statistic is a row with exactly two text leaves: its label and its value.
  function readValueBeside(label) {
    const row = label.parentElement;
    const others = [...row.querySelectorAll(TEXT_SELECTOR)].filter(
      (element) => element !== label && isLeaf(element),
    );
    return others.length === 1 ? parseNumber(others[0].textContent) : null;
  }

  function isLeaf(element) {
    return element.children.length === 0;
  }

  function normalizeLabel(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*:\s*$/, '');
  }

  // Figgie groups thousands with commas and writes negatives with a true minus
  // sign (U+2212). Anything that is not a plain number, such as "—", is null.
  function parseNumber(text) {
    const value = String(text || '')
      .trim()
      .replace(/,/g, '')
      .replace(/−/g, '-');
    return /^[+-]?\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
  }

  // Describes what changed between each pair of consecutive observations of
  // the same player, oldest interval first. A rating change is attributed to a
  // recorded round only when the player completed one round in the interval,
  // exactly one recorded round fits it, and that round's profit matches the
  // change in lifetime earnings.
  function intervals(observations, rounds = []) {
    const result = [];
    for (const [self, history] of profileHistories(observations)) {
      for (let index = 1; index < history.length; index++) {
        result.push(describeInterval(self, history[index - 1], history[index], rounds));
      }
    }
    return result.sort((a, b) => a.to - b.to);
  }

  // Groups valid observations by player, oldest first. Consecutive
  // observations of an unchanged profile collapse into the most recent one.
  function profileHistories(observations) {
    const histories = new Map();
    const seenIds = new Set();
    for (const raw of [...observations].sort((a, b) => a.at - b.at)) {
      const observation = validate(raw);
      if (!observation || seenIds.has(observation.id)) continue;
      seenIds.add(observation.id);
      const history = histories.get(observation.self) || [];
      const latest = history.at(-1);
      if (latest && fingerprint(latest) === fingerprint(observation)) {
        history[history.length - 1] = observation;
      } else {
        history.push(observation);
      }
      histories.set(observation.self, history);
    }
    return histories;
  }

  function describeInterval(self, before, after, rounds) {
    const roundCount = after.stats.lifetimeRounds - before.stats.lifetimeRounds;
    const candidates = candidateRounds(rounds, self, before.at, after.at);
    const statDeltas = statChanges(before.stats, after.stats);
    const round = candidates.length === 1 ? candidates[0] : null;
    const matched =
      roundCount === 1 &&
      round &&
      isSameProfit(statDeltas.lifetimeProfit, round.revealed.settledProfit);
    return {
      self,
      from: before.at,
      to: after.at,
      ratingBefore: before.rating,
      ratingAfter: after.rating,
      delta: after.rating - before.rating,
      roundCount,
      statDeltas,
      attribution: matched ? 'single-round-candidate' : 'interval-only',
      roundId: matched ? round.id : null,
      candidateRoundIds: candidates.map((candidate) => candidate.id),
      reason: attributionReason(matched, roundCount, round),
      round: matched ? roundSummary(round) : null,
    };
  }

  // Officially settled rounds this player finished after the first observation
  // and no later than the second, one entry per round id.
  function candidateRounds(rounds, self, from, to) {
    const finished = rounds.filter(
      (round) =>
        round.self === self &&
        round.revealed?.verified &&
        Number.isFinite(round.accounting?.endedAt) &&
        round.accounting.endedAt > from &&
        round.accounting.endedAt <= to,
    );
    return [...new Map(finished.map((round) => [round.id, round])).values()];
  }

  function statChanges(before, after) {
    const changes = {};
    for (const key of STAT_KEYS) {
      if (isBoundedNumber(before[key]) && isBoundedNumber(after[key])) {
        changes[key] = after[key] - before[key];
      }
    }
    return changes;
  }

  function isSameProfit(earningsChange, roundProfit) {
    return (
      isBoundedNumber(earningsChange) &&
      isBoundedNumber(roundProfit) &&
      Math.abs(earningsChange - roundProfit) < PROFIT_TOLERANCE
    );
  }

  function attributionReason(matched, roundCount, round) {
    if (matched) {
      return 'One official round and matching lifetime earnings change; server update timing still unverified.';
    }
    if (roundCount !== 1) return 'Lifetime round count does not isolate one round.';
    if (!round) return 'Exactly one official completed round is not available.';
    return 'Lifetime earnings change does not corroborate the round.';
  }

  function roundSummary(round) {
    return {
      profit: round.revealed.settledProfit,
      profits: round.revealed.profits,
      goal: round.revealed.goal,
      practice: Boolean(round.practice),
      botDifficulty: round.snapshot?.context?.botDifficulty || null,
    };
  }

  // Content script: watches the Setup screen and sends each new profile state
  // to the background worker, one at a time, until the worker confirms it.
  function recordVisibleRatings() {
    const unsaved = [];
    let lastQueued = '';
    let saved = null;
    let sending = false;
    let retryAt = 0;
    let attempt = 0;

    function tick() {
      // Setup is the only screen containing profile statistics. Active games incur no DOM scans.
      if (document.title === SETUP_TITLE) {
        queueIfChanged(read(document));
        showStatus();
      }
      sendNext();
    }

    function queueIfChanged(observation) {
      if (!observation) return;
      const shown = fingerprint(observation);
      if (shown === lastQueued) return;
      observation.id = crypto.randomUUID();
      unsaved.push(observation);
      lastQueued = shown;
    }

    // Sends the oldest unsaved observation. It keeps its id across retries, so
    // the worker can recognize a repeat of one it has already stored.
    function sendNext() {
      if (sending || !unsaved.length || Date.now() < retryAt) return;
      const observation = unsaved[0];
      const thisAttempt = ++attempt;
      sending = true;
      // Advancing `attempt` abandons this send: a reply that arrives after the
      // timeout no longer matches and is ignored.
      const timeout = setTimeout(() => {
        if (thisAttempt !== attempt) return;
        attempt++;
        retryLater();
      }, REPLY_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: 'figgie-rating-observation', observation }, (reply) => {
          // Read lastError even for a stale reply: Chrome logs an unchecked
          // error whenever a callback leaves it unread.
          const error = chrome.runtime.lastError;
          if (thisAttempt !== attempt) return;
          clearTimeout(timeout);
          sending = false;
          if (!error && reply?.ok && reply.id === observation.id) {
            saved = observation;
            unsaved.shift();
            retryAt = 0;
            showStatus();
            sendNext();
          } else {
            retryLater();
          }
        });
      } catch {
        clearTimeout(timeout);
        retryLater();
      }
    }

    function retryLater() {
      sending = false;
      retryAt = Date.now() + RETRY_DELAY_MS;
    }

    function showStatus() {
      const panel = document.getElementById(RECORDINGS_PANEL_ID);
      if (!panel) return;
      let status = panel.querySelector(`#${STATUS_ID}`);
      if (!status) {
        status = document.createElement('p');
        status.id = STATUS_ID;
        status.style.cssText = STATUS_STYLE;
        panel.appendChild(status);
      }
      const text = statusText();
      if (status.textContent !== text) status.textContent = text;
    }

    function statusText() {
      if (unsaved.length) return 'Saving visible rating statistics…';
      if (saved) {
        return `Rating ${saved.rating} saved at ${saved.stats.lifetimeRounds} lifetime rounds. Open Statistics after each round to capture the next change.`;
      }
      return 'Rating log: open Figgie’s Statistics after each round to capture rating changes.';
    }

    tick();
    setInterval(tick, POLL_INTERVAL_MS);
  }

  const api = { LABELS, validate, read, fingerprint, intervals };
  scope.FiggieRatings = api;
  if (typeof module !== 'undefined') module.exports = api;

  const isContentScript =
    typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage;
  if (isContentScript) recordVisibleRatings();
})(globalThis);
