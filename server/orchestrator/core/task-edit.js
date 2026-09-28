/** Pure rules for editing a task's spec on a live board. No I/O. */

/** Longest title a board edit accepts. Plan titles are one line. */
const MAX_TITLE = 200;

/** Fields a board edit may change. Graph shape (wave, dependsOn) is not one. */
export const EDITABLE_TASK_FIELDS = /** @type {const} */ (['title', 'build', 'test', 'accept', 'touches']);

/**
 * Check and canonicalise a raw edit body. Blank spec text clears the field.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, changes: import('./types').TaskEditChanges } | { ok: false, error: string }}
 */
export function normaliseTaskChanges(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'changes must be an object' };
  }
  const body = /** @type {Record<string, unknown>} */ (raw);
  const allowed = new Set(/** @type {readonly string[]} */ (EDITABLE_TASK_FIELDS));
  for (const key of Object.keys(body)) {
    if (body[key] !== undefined && !allowed.has(key)) {
      return { ok: false, error: `${key} cannot be edited on a board` };
    }
  }

  /** @type {import('./types').TaskEditChanges} */
  const changes = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return { ok: false, error: 'title must be a non-empty string' };
    }
    const title = body.title.trim().replace(/\s+/g, ' ');
    if (title.length > MAX_TITLE) {
      return { ok: false, error: `title must be at most ${MAX_TITLE} characters` };
    }
    changes.title = title;
  }
  for (const key of /** @type {const} */ (['build', 'test', 'accept'])) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      return { ok: false, error: `${key} must be a string or null` };
    }
    const text = typeof value === 'string' ? value.trim() : '';
    changes[key] = text ? text : null;
  }
  if (body.touches !== undefined) {
    if (!Array.isArray(body.touches) || !body.touches.every((t) => typeof t === 'string')) {
      return { ok: false, error: 'touches must be an array of strings' };
    }
    changes.touches = [...new Set(body.touches.map((t) => t.trim()).filter(Boolean))];
  }
  if (Object.keys(changes).length === 0) return { ok: false, error: 'nothing to change' };
  return { ok: true, changes };
}

/**
 * Why this task cannot be edited right now, or null when it can.
 * A running card would keep building from the old spec; a merged one has
 * already landed, so Rewind is the way back.
 *
 * @param {import('./types').BoardState} state
 * @param {string} taskId
 * @returns {string | null}
 */
export function taskEditBlocker(state, taskId) {
  const task = state.tasks.get(String(taskId ?? '').trim());
  if (!task) return 'no such task';
  if (task.mergedSha !== null) return 'this task is merged; Rewind it before editing';
  if (state.mergeQueue.includes(task.id)) {
    return 'this task is waiting to merge; wait for the merge before editing';
  }
  if (task.attempts.some((a) => !a.ended)) {
    return 'this task is running; wait for it or abandon it before editing';
  }
  return null;
}

/**
 * The subset of `changes` that differs from the task as it stands.
 *
 * @param {import('./types').TaskState} task
 * @param {import('./types').TaskEditChanges} changes
 * @returns {import('./types').TaskEditChanges}
 */
export function diffTaskChanges(task, changes) {
  /** @type {import('./types').TaskEditChanges} */
  const out = {};
  if (changes.title !== undefined && changes.title !== task.title) out.title = changes.title;
  if (changes.build !== undefined && changes.build !== task.buildSpec) out.build = changes.build;
  if (changes.test !== undefined && changes.test !== task.testSpec) out.test = changes.test;
  if (changes.accept !== undefined && changes.accept !== task.accept) out.accept = changes.accept;
  if (changes.touches !== undefined && !sameList(changes.touches, task.touches)) {
    out.touches = changes.touches;
    if (changes.touchesExpanded !== undefined) out.touchesExpanded = changes.touchesExpanded;
    if (changes.emptyTouchesGlobs !== undefined) out.emptyTouchesGlobs = changes.emptyTouchesGlobs;
  }
  return out;
}

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
function sameList(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
