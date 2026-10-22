/** Deterministic recovery state. All clocks and observations arrive as events. */
export const RECOVERY_VERSION = 1;
export const FINAL_REPAIR_LIMIT = 3;
export const TASK_REPAIR_LIMIT = 5;
export const OPERATIONAL_CATEGORIES = ['quota', 'rate_limit', 'unavailable', 'capacity', 'interrupted', 'context', 'protocol'];

export function recoveryKey(taskId, role) { return `${role}:${taskId ?? ''}`; }
export function recoverySpent(state) {
  return state.recoveryFailures?.length ?? 0;
}

export function held(state, taskId, role) {
  if (!state.recoveryVersion) return false;
  return Object.values(state.recoveryHolds).some((hold) =>
    hold.key === 'preflight:' || hold.key === recoveryKey(taskId, role) ||
    (role !== 'merge' && role !== 'final' && hold.resource && hold.resource === `${state.model?.providerId ?? ''}:${state.model?.id ?? ''}`));
}

export function recoveryHold(state, { taskId = null, role, failure, now, stage = 'attempt', attemptId }) {
  const key = recoveryKey(taskId, role);
  const observations = state.recoveryHistory.filter((item) => item.key === key && item.failure.fingerprint === failure.fingerprint && item.revision === state.recoveryRevision);
  const count = observations.length + 1;
  const attention = ['authentication', 'prerequisite', 'verification'].includes(failure.category) ||
    (failure.category === 'protocol' && (!failure.omitField || count >= 2)) ||
    (failure.category === 'environment' && count >= 2) ||
    (failure.category === 'context' && count >= 3) ||
    (count >= 6 && !['quota', 'rate_limit', 'unavailable', 'capacity'].includes(failure.category));
  const delay = failure.category === 'quota' ? 15 * 60_000 : Math.min(300_000, 5_000 * 2 ** Math.min(count - 1, 6));
  return {
    key, taskId, role, stage, failure, count, attention, observedAt: now,
    revision: state.recoveryRevision,
    ...(attemptId ? { attemptId } : {}),
    retryAt: failure.retryAt ?? now + delay + (failure.jitterMs ?? 0),
    ...(OPERATIONAL_CATEGORIES.includes(failure.category) && ['provider', 'family', 'model'].includes(failure.scope)
      ? { resource: `${state.model?.providerId ?? ''}:${state.model?.id ?? ''}` } : {}),
  };
}
