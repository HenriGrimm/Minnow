import { attemptCount, DEFAULT_GLOBAL_MAX_CONCURRENT, DEFAULT_TYPE_MAX_CONCURRENT, isStoppedForScheduling, lastEndedAttempt } from './derive.js';
import { bundleAbandonmentEvidence } from './evidence.js';
import { SUB_AGENT_ROLE } from './events.js';
import { decide } from './policy.js';

/**
 * @returns {import('./types').Caps}
 */
export function defaultCaps() {
  return {
    globalMaxConcurrent: DEFAULT_GLOBAL_MAX_CONCURRENT,
    maxConcurrentByType: {},
  };
}

/**
 * @param {import('./types').AgentsState} state
 * @param {string} runId
 * @returns {import('./types').NextAction}
 */
export function nextAction(state, runId) {
  const run = state.runs.get(runId);
  if (!run) return { kind: 'none' };
  if (isStoppedForScheduling(run)) return { kind: 'none' };
  if (run.attempts.some((a) => !a.ended)) return { kind: 'none' };

  const last = lastEndedAttempt(run);
  if (!last) {
    return { kind: 'start', role: SUB_AGENT_ROLE, seedKind: 'initial' };
  }

  const action = decide({
    outcome: last.outcome ?? 'no_report',
    attemptCount: attemptCount(state, runId) - 1,
    summary: last.summary,
    evidence: last.evidence,
  });

  if (action.kind === 'retry') {
    return { kind: 'start', role: SUB_AGENT_ROLE, seedKind: action.seedKind };
  }
  if (action.kind === 'abandon') {
    return {
      kind: 'abandon',
      reason: action.reason,
      evidence: bundleAbandonmentEvidence(run, action),
    };
  }
  return { kind: 'none' };
}

/**
 * @param {import('./types').AgentsState} state
 * @returns {Array<{ runId: string, reason: string, evidence: Record<string, unknown> }>}
 */
export function pendingAbandonments(state) {
  /** @type {Array<{ runId: string, reason: string, evidence: Record<string, unknown> }>} */
  const out = [];
  if (!state) return out;
  for (const runId of state.runOrder) {
    const next = nextAction(state, runId);
    if (next.kind === 'abandon') out.push({ runId, reason: next.reason, evidence: next.evidence });
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function capOf(value, fallback) {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(0, /** @type {number} */ (value));
}

/**
 * Per-type cap for this run. Missing keys use the shipped default of 2.
 *
 * @param {import('./types').Caps | null | undefined} caps
 * @param {string} agentType
 * @returns {number}
 */
export function typeCap(caps, agentType) {
  const byType = caps?.maxConcurrentByType;
  if (byType && Number.isSafeInteger(byType[agentType])) {
    return capOf(byType[agentType], DEFAULT_TYPE_MAX_CONCURRENT);
  }
  return DEFAULT_TYPE_MAX_CONCURRENT;
}

/**
 * @param {import('./types').AgentsState} state
 * @param {import('./types').Caps} [caps]
 * @returns {import('./types').Desired[]}
 */
export function plan(state, caps = defaultCaps()) {
  if (!state) return [];

  const globalCap = capOf(caps.globalMaxConcurrent, DEFAULT_GLOBAL_MAX_CONCURRENT);
  // One FIFO assignment per durable conversation. A second queued assignment
  // cannot reserve a family slot while the first still owns that child.
  const firstByChild = new Map();
  for (const id of state.runOrder) {
    const run = state.runs.get(id);
    if (run?.childChatId && !['passed', 'abandoned', 'cancelled'].includes(run.phase) && !firstByChild.has(run.childChatId)) firstByChild.set(run.childChatId, id);
  }

  /** @type {import('./types').Desired[]} */
  const inFlight = [];
  for (const id of state.runOrder) {
    const run = state.runs.get(id);
    if (!run || isStoppedForScheduling(run)) continue;
    const open = run.attempts.find((a) => !a.ended);
    if (!open) continue;
    inFlight.push({
      taskId: id,
      role: SUB_AGENT_ROLE,
      seedKind: /** @type {import('./types').SeedKind} */ (open.seedKind ?? 'initial'),
    });
  }

  /** @type {import('./types').Desired[]} */
  const desired = [...inFlight];

  /** @type {Set<string>} */
  const occupied = new Set(inFlight.map((d) => d.taskId));
  /** @type {Map<string, number>} */
  const typeLive = new Map();
  for (const d of inFlight) {
    const agentType = state.runs.get(d.taskId)?.type ?? '';
    typeLive.set(agentType, (typeLive.get(agentType) ?? 0) + 1);
  }

  let globalStarted = 0;
  /** @type {Map<string, number>} */
  const typeStarted = new Map();

  for (const id of state.runOrder) {
    if (occupied.has(id)) continue;
    const run = state.runs.get(id);
    if (!run || isStoppedForScheduling(run)) continue;
    if (run.childChatId && firstByChild.get(run.childChatId) !== id) continue;
    if (run.attempts.some((a) => !a.ended)) continue;

    const next = nextAction(state, id);
    if (next.kind !== 'start') continue;

    const liveGlobal = inFlight.length + globalStarted;
    if (liveGlobal >= globalCap) continue;

    const liveType = (typeLive.get(run.type) ?? 0) + (typeStarted.get(run.type) ?? 0);
    if (liveType >= typeCap(caps, run.type)) continue;

    desired.push({ taskId: id, role: SUB_AGENT_ROLE, seedKind: next.seedKind });
    occupied.add(id);
    globalStarted += 1;
    typeStarted.set(run.type, (typeStarted.get(run.type) ?? 0) + 1);
  }

  return desired;
}
