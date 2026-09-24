/** How long an attempt waits out an unreachable model server, in milliseconds. */
export const ATTEMPT_PROVIDER_WAIT_MS: number;

/** Identical call+result repeats that end an unattended attempt. */
export const ATTEMPT_MAX_REPEATED_TOOL_CALLS: number;

/** Model rounds before a Tester is asked for its verdict. */
export const TESTER_VERDICT_ROUNDS: number;

/** Hard ceiling on Tester model rounds. */
export const TESTER_MAX_ROUNDS: number;

/** Merge overrides onto the production defaults. No default wall clock or `maxTurns`. */
export function attemptLimits(overrides?: {
  maxTurns?: number;
  wallClockMs?: number;
  providerWaitMs?: number;
  maxRepeatedToolCalls?: number;
}): { maxTurns?: number; wallClockMs?: number; providerWaitMs: number; maxRepeatedToolCalls: number };
