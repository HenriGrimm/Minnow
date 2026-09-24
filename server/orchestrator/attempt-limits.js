/** Caps for one real agent attempt. */

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
