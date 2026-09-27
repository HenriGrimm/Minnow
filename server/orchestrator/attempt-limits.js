/** Caps for one real agent attempt. */

/**
 * Default wall-clock ceiling for one board builder/tester attempt. Settings →
 * Autopilot (`autopilot.attemptWallClockMs`) overrides it; `0` turns it off.
 * Hitting it ends the attempt as `timeout`, which the policy table retries.
 */
export const ATTEMPT_WALL_CLOCK_MS = 240 * 60 * 1000;

/** Smallest non-zero board attempt wall clock Settings accepts. */
export const ATTEMPT_WALL_CLOCK_MIN_MS = 5 * 60 * 1000;

/** Largest board attempt wall clock Settings accepts. */
export const ATTEMPT_WALL_CLOCK_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize a stored board attempt wall clock. `0` means no cap; anything else
 * is clamped to the accepted range; junk falls back to the default.
 * @param {unknown} value
 * @returns {number}
 */
export function clampAttemptWallClockMs(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) {
    return ATTEMPT_WALL_CLOCK_MS;
  }
  if (n <= 0) return 0;
  return Math.min(ATTEMPT_WALL_CLOCK_MAX_MS, Math.max(ATTEMPT_WALL_CLOCK_MIN_MS, Math.round(n)));
}

/**
 * How long an attempt waits out an unreachable model server (a local server
 * restarting or reloading) before the round fails and the attempt crashes.
 */
export const ATTEMPT_PROVIDER_WAIT_MS = 10 * 60 * 1000;

/**
 * An unattended attempt that gets the same result from the same call this many
 * times is stuck; it ends as crashed so recovery can take over.
 */
export const ATTEMPT_MAX_REPEATED_TOOL_CALLS = 8;

/**
 * Model rounds before a Tester is asked for its verdict. It starts from the
 * builder's report and diff, so most verdicts land well inside this.
 */
export const TESTER_VERDICT_ROUNDS = 30;

/**
 * Hard ceiling on Tester model rounds. Past the verdict checkpoints; a tester
 * this far in is re-surveying, not verifying.
 */
export const TESTER_MAX_ROUNDS = 80;

/**
 * @param {{ maxTurns?: number, wallClockMs?: number, providerWaitMs?: number, maxRepeatedToolCalls?: number }} [overrides]
 * @returns {{ maxTurns?: number, wallClockMs?: number, providerWaitMs: number, maxRepeatedToolCalls: number }}
 */
export function attemptLimits(overrides = {}) {
  /** @type {{ maxTurns?: number, wallClockMs?: number, providerWaitMs: number, maxRepeatedToolCalls: number }} */
  const limits = {
    providerWaitMs:
      typeof overrides.providerWaitMs === 'number' && overrides.providerWaitMs >= 0
        ? overrides.providerWaitMs
        : ATTEMPT_PROVIDER_WAIT_MS,
    maxRepeatedToolCalls:
      typeof overrides.maxRepeatedToolCalls === 'number' && overrides.maxRepeatedToolCalls > 0
        ? overrides.maxRepeatedToolCalls
        : ATTEMPT_MAX_REPEATED_TOOL_CALLS,
  };
  if (typeof overrides.wallClockMs === 'number' && overrides.wallClockMs > 0) {
    limits.wallClockMs = overrides.wallClockMs;
  }
  if (typeof overrides.maxTurns === 'number' && overrides.maxTurns > 0) {
    limits.maxTurns = overrides.maxTurns;
  }
  return limits;
}
