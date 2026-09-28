/** Pure cascade helpers for Reset and Rewind. No I/O. */

/**
 * Task ids currently skipped because something in `seedIds` blocked them.
 * Repeats until the set is stable so a chain of skips is included.
 *
 * @param {import('./types').BoardState} state
 * @param {Iterable<string>} seedIds
 * @returns {string[]} in declared task order
 */
export function withSkippedDependents(state, seedIds) {
  const ids = new Set();
  for (const id of seedIds) {
    const trimmed = String(id ?? '').trim();
    if (trimmed) ids.add(trimmed);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of state.tasks.values()) {
      if (ids.has(task.id)) continue;
      if (task.skippedBy && ids.has(task.skippedBy)) {
        ids.add(task.id);
        changed = true;
      }
    }
  }
  return state.taskOrder.filter((id) => ids.has(id));
}

/**
 * True when Reset would have something to wipe on this card.
 * Merged cards are never Reset; use Rewind.
 *
 * @param {import('./types').BoardState} state
 * @param {import('./types').TaskState} task
 * @returns {boolean}
 */
export function hasRunDebris(state, task) {
  if (!task || task.mergedSha !== null) return false;
  if (task.attempts.length > 0) return true;
  if (task.abandonedReason !== null) return true;
  if (task.skippedBy !== null) return true;
  if (task.waived) return true;
  if (task.mergeConflicts && task.mergeConflicts.length > 0) return true;
  return state.mergeQueue.includes(task.id);
}

/**
 * Tasks Reset should wipe. Refuses a merged card.
 *
 * @param {import('./types').BoardState} state
 * @param {string} taskId
 * @returns {{ ok: true, taskIds: string[] } | { ok: false, error: string, taskIds: string[] }}
 */
export function resetTargets(state, taskId) {
  const id = String(taskId ?? '').trim();
  const task = state.tasks.get(id);
  if (!task) return { ok: false, error: 'no such task', taskIds: [] };
  if (task.mergedSha !== null) {
    return { ok: false, error: 'this task is merged; use Rewind', taskIds: [] };
  }
  return { ok: true, taskIds: withSkippedDependents(state, [id]) };
}

/**
 * Last merge.succeeded index for a task, or -1.
 *
 * @param {readonly Record<string, unknown>[]} events
 * @param {string} taskId
 * @returns {number}
 */
function lastMergeSucceededIndex(events, taskId) {
  let index = -1;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event?.type === 'merge.succeeded' && String(event.taskId ?? '') === taskId) {
      index = i;
    }
  }
  return index;
}

/**
 * Integration tip to restore: the merge event's beforeSha, else the previous
 * merge.succeeded sha on the board.
 *
 * @param {readonly Record<string, unknown>[]} events
 * @param {number} mergeIndex
 * @returns {string | null}
 */
export function beforeShaForMerge(events, mergeIndex) {
  const merge = events[mergeIndex];
  const tagged = typeof merge?.beforeSha === 'string' ? merge.beforeSha.trim() : '';
  if (tagged) return tagged;
  for (let i = mergeIndex - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'merge.succeeded') continue;
    const sha = typeof event.sha === 'string' ? event.sha.trim() : '';
    if (sha) return sha;
  }
  return null;
}

/**
 * Tasks Rewind should wipe, and the integration sha to restore.
 *
 * @param {import('./types').BoardState} state
 * @param {Iterable<unknown>} events
 * @param {string} fromTaskId
 * @returns {{ ok: true, fromTaskId: string, beforeSha: string, taskIds: string[] }
 *   | { ok: false, error: string, taskIds: string[], beforeSha: null }}
 */
export function rewindCascade(state, events, fromTaskId) {
  const id = String(fromTaskId ?? '').trim();
  const task = state.tasks.get(id);
  if (!task) {
    return { ok: false, error: 'no such task', taskIds: [], beforeSha: null };
  }
  if (task.mergedSha === null) {
    return { ok: false, error: 'this task is not merged; use Reset', taskIds: [], beforeSha: null };
  }

  /** @type {Record<string, unknown>[]} */
  const list = [];
  for (const raw of events ?? []) {
    if (raw && typeof raw === 'object') list.push(/** @type {Record<string, unknown>} */ (raw));
  }

  const mergeIndex = lastMergeSucceededIndex(list, id);
  if (mergeIndex < 0) {
    return { ok: false, error: 'no merge.succeeded for this task', taskIds: [], beforeSha: null };
  }
  const beforeSha = beforeShaForMerge(list, mergeIndex);
  if (!beforeSha) {
    return { ok: false, error: 'no integration sha to restore', taskIds: [], beforeSha: null };
  }

  const ids = new Set([id]);
  for (let i = mergeIndex + 1; i < list.length; i += 1) {
    const event = list[i];
    const type = event.type;
    const taskId = typeof event.taskId === 'string' ? event.taskId : '';
    if (!taskId) continue;
    if (type === 'merge.succeeded' || type === 'task.attempt.started') ids.add(taskId);
  }
  for (const queued of state.mergeQueue) ids.add(queued);
  for (const live of state.tasks.values()) {
    if (live.attempts.some((attempt) => !attempt.ended)) ids.add(live.id);
  }

  return {
    ok: true,
    fromTaskId: id,
    beforeSha,
    taskIds: withSkippedDependents(state, ids),
  };
}
