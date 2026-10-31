import { foldInto, isTerminal } from './derive.js';
import { makeEvent, SUB_AGENT_ROLE } from './events.js';
import { pendingAbandonments, plan as planWithCaps, defaultCaps } from './plan.js';

/**
 * @param {string} role
 * @returns {boolean}
 */
export function isSubAgentRole(role) {
  return role === SUB_AGENT_ROLE;
}

/**
 * @param {import('./types').AgentsState} state
 * @returns {Record<string, unknown>[]}
 */
export function impliedEvents(state) {
  /** @type {Record<string, unknown>[]} */
  const decisions = [];
  for (const { runId, reason, evidence } of pendingAbandonments(state)) {
    decisions.push(makeEvent('run.abandoned', { runId, reason, evidence }));
  }
  return decisions;
}

/**
 * @param {import('./types').AgentsState} state
 * @param {string} attemptId
 * @returns {boolean}
 */
export function isAlreadyEnded(state, attemptId) {
  for (const run of state.runs.values()) {
    for (const attempt of run.attempts) {
      if (attempt.attemptId === attemptId) return attempt.ended;
    }
  }
  return false;
}

/**
 * @param {import('./types').AgentsState} state
 * @param {Set<string>} live
 * @param {Set<string>} buffered
 * @returns {Record<string, unknown>[]}
 */
export function reapVanished(state, live, buffered) {
  /** @type {Record<string, unknown>[]} */
  const ended = [];
  for (const run of state.runs.values()) {
    if (isTerminal(run)) continue;
    for (const attempt of run.attempts) {
      if (attempt.ended) continue;
      if (live.has(attempt.attemptId)) continue;
      if (buffered.has(attempt.attemptId)) continue;
      const cancelled = run.cancelledReason !== null;
      ended.push(
        makeEvent('attempt.ended', {
          runId: run.runId,
          attemptId: attempt.attemptId,
          outcome: 'crashed',
          summary: cancelled
            ? 'the user cancelled this run'
            : 'the process was no longer running',
        }),
      );
    }
  }
  return ended;
}

/**
 * `eventsForStart` maps onto `attempt.started`. `want.taskId` is the runId.
 *
 * @param {{ taskId: string | null, role: string, seedKind?: string }} want
 * @param {{ attemptId: string, model?: { providerId: string, id: string } }} handle
 * @returns {Record<string, unknown>[]}
 */
export function eventsForStart(want, handle) {
  if (!isSubAgentRole(want.role) || !want.taskId) return [];
  const seedKind = want.seedKind ?? 'initial';
  /** @type {Record<string, unknown>} */
  const payload = {
    runId: want.taskId,
    attemptId: handle.attemptId,
    seed: { kind: seedKind },
    seedKind,
  };
  if (handle.model && handle.model.providerId && handle.model.id) {
    payload.model = { providerId: handle.model.providerId, id: handle.model.id };
  }
  if (handle.executionId) payload.executionId = handle.executionId;
  if (handle.commandId) payload.commandId = handle.commandId;
  return [makeEvent('attempt.started', payload)];
}

/**
 * `eventsForAttemptEnd` maps onto `attempt.ended`.
 *
 * @param {{
 *   attemptId: string,
 *   taskId: string | null,
 *   role: string,
 *   outcome: string,
 *   summary?: string,
 *   evidence?: Record<string, unknown>,
 *   usage?: Record<string, number>,
 * }} end
 * @returns {Record<string, unknown>[]}
 */
export function eventsForAttemptEnd(end) {
  if (!isSubAgentRole(end.role) || !end.taskId) return [];
  /** @type {Record<string, unknown>} */
  const payload = {
    runId: end.taskId,
    attemptId: end.attemptId,
    outcome: end.outcome,
  };
  if (end.resolvedModel) payload.resolvedModel = end.resolvedModel;
  if (end.summary !== undefined) payload.summary = end.summary;
  if (end.evidence !== undefined) payload.evidence = end.evidence;
  if (end.usage !== undefined) payload.usage = end.usage;
  if (end.executionId) payload.executionId = end.executionId;
  if (end.resultMessageId) payload.resultMessageId = end.resultMessageId;
  return [...(end.evidence?.childChatId && end.evidence?.stopped === true
    ? [makeEvent('run.cancelled', { runId: end.taskId, reason: 'user' })] : []), makeEvent('attempt.ended', payload)];
}

/**
 * @param {import('./types').Caps} [caps]
 * @returns {import('../orchestrator/engine.js').Graph}
 */
export function createSubAgentGraph(caps = defaultCaps()) {
  return {
    foldInto,
    plan: (state) => planWithCaps(state, caps),
    impliedEvents,
    isAgentRole: isSubAgentRole,
    isAlreadyEnded,
    reapVanished,
    eventsForStart,
    eventsForAttemptEnd,
    defaultConcurrency: caps.globalMaxConcurrent,
  };
}

/**
 * @type {import('../orchestrator/engine.js').Graph}
 */
export const subAgentGraph = createSubAgentGraph();
