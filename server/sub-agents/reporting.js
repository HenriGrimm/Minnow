export const SUB_AGENT_COMPLETION_GUIDANCE = 'Submit your final report when finished. Use outcome "pass" for completed work, "fail" for an unsuccessful assessment, or "blocked" for missing prerequisites. Include negative findings, failed checks, and validation limitations in the report. A valid final report completes this agent run regardless of its assessment; only execution errors, timeouts, or cancellation determine whether the run failed or stopped. Do not repeat a completed review merely because it found defects or an earlier tool call failed.';

/** A delivered assessment is a completed run, even when the assessment is negative. */
export function subAgentCompletionResult(result) {
  if (!['fail', 'blocked'].includes(result?.outcome) || typeof result.summary !== 'string' || result.failure) return result;
  return { ...result, outcome: 'pass', reportedOutcome: result.outcome,
    evidence: [...(result.evidence ?? []), `Reported assessment: ${result.outcome}.`, ...(result.blockers ?? []), ...(result.needs ?? [])],
  };
}
