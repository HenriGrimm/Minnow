/** Wall-clock ceiling per attempt, in milliseconds. */
export const ATTEMPT_WALL_CLOCK_MS: number;

/** How long an attempt waits out an unreachable model server, in milliseconds. */
export const ATTEMPT_PROVIDER_WAIT_MS: number;

/** Identical call+result repeats that end an unattended attempt. */
export const ATTEMPT_MAX_REPEATED_TOOL_CALLS: number;

/** Merge overrides onto the production defaults. No default `maxTurns`. */
export function attemptLimits(overrides?: {
  maxTurns?: number;
  wallClockMs?: number;
  providerWaitMs?: number;
  maxRepeatedToolCalls?: number;
}): { maxTurns?: number; wallClockMs: number; providerWaitMs: number; maxRepeatedToolCalls: number };
