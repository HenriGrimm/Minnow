/**
 * Live SSE channel for Super Plan research progress and activity.
 *
 * Deliberately *not* journal events: the fold is a pure function of the
 * journal, and replay must not depend on timestamps or token deltas. This bus
 * is the parallel, non-durable channel the renderer subscribes to while a run
 * is live — turn deltas, tool calls, stage milestones. Nothing here is ever
 * written to `~/.minnow/superplan/<runId>/journal.jsonl`.
 */

/**
 * @typedef {object} SuperPlanLiveEvent
 * @property {string} [key] opaque routing key; omitted on run events
 * @property {string} runId
 * @property {string} stage  the pipeline stage the activity belongs to
 * @property {import('../runner/run-turn').TurnEvent} event
 */

/** @type {Map<string, Set<(payload: SuperPlanLiveEvent) => void>>} */
const listeners = new Map();

/**
 * @param {{ key?: string, runId: string }} payload
 * @returns {string}
 */
function routingKey(payload) {
  return payload.key ?? payload.runId;
}

/**
 * @param {string} runId
 * @param {(payload: SuperPlanLiveEvent) => void} handler
 * @returns {() => void}
 */
export function subscribeLive(runId, handler) {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) listeners.delete(runId);
  };
}

/**
 * @param {SuperPlanLiveEvent} payload
 * @returns {void}
 */
export function emitLive(payload) {
  const set = listeners.get(routingKey(payload));
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch {
    }
  }
}
