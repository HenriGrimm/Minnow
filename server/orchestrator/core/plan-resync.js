/** Pure three-way merge of an edited plan file into a live board. No I/O. */

import { taskEditBlocker } from './task-edit.js';

/** Spec fields a re-sync carries, in the order they are reported. */
const SPEC_FIELDS = /** @type {const} */ (['title', 'build', 'test', 'accept', 'touches']);

/**
 * @typedef {{ title: string, build: string | null, test: string | null, accept: string | null, touches: string[] }} Spec
 */

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
  return value == null || value === '' ? null : String(value);
}

/**
 * @param {Record<string, unknown>} declared a plan task or a journaled one
 * @returns {Spec}
 */
function specOf(declared) {
  return {
    title: String(declared.title ?? declared.id ?? ''),
    build: text(declared.build),
    test: text(declared.test),
    accept: text(declared.accept),
    touches: Array.isArray(declared.touches) ? declared.touches.map(String) : [],
  };
}

/**
 * @param {import('./types').TaskState} task
 * @returns {Spec}
 */
function specOfTask(task) {
  return {
    title: task.title,
    build: task.buildSpec,
    test: task.testSpec,
    accept: task.accept,
    touches: task.touches,
  };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function same(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
}

/**
 * The spec each plan-sourced card had when it last came from the plan: its
 * `board.created` (or plan `task.added`) declaration, plus every earlier
 * re-sync. Cards the engine added (a FIX task) have no base.
 *
 * @param {Iterable<unknown>} events
 * @returns {Map<string, Spec>}
 */
export function planBaseSpecs(events) {
  /** @type {Map<string, Spec>} */
  const base = new Map();
  for (const raw of events ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const event = /** @type {Record<string, any>} */ (raw);
    if (event.type === 'board.created' && Array.isArray(event.tasks)) {
      for (const declared of event.tasks) {
        const id = String(declared?.id ?? '');
        if (id && !base.has(id)) base.set(id, specOf(declared));
      }
    } else if (event.type === 'task.added' && event.source === 'plan' && event.task) {
      const id = String(event.task.id ?? '');
      if (id && !base.has(id)) base.set(id, specOf(event.task));
    } else if (event.type === 'task.updated' && event.reason === 'plan') {
      const spec = base.get(String(event.taskId ?? ''));
      const changes = event.changes && typeof event.changes === 'object' ? event.changes : {};
      if (!spec) continue;
      for (const field of SPEC_FIELDS) {
        if (!(field in changes)) continue;
        if (field === 'touches') spec.touches = Array.isArray(changes.touches) ? changes.touches.map(String) : [];
        else if (field === 'title') spec.title = String(changes.title ?? spec.title);
        else spec[field] = text(changes[field]);
      }
    }
  }
  return base;
}

/**
 * What re-syncing the plan would do to the board.
 *
 * Per spec field: the plan wins where the board still matches the base, the
 * board wins where only the board changed, and a field both sides changed
 * differently is a conflict that keeps the board's value. Wave and
 * dependencies never change on a live board, and cards dropped from the plan
 * stay (Abandon removes work, not a re-sync).
 *
 * @param {import('./types').BoardState} state
 * @param {Iterable<unknown>} events the board's journal
 * @param {ReadonlyArray<Record<string, any>>} planTasks parsed, with touches expanded
 * @param {ReadonlyArray<{ n: number, name: string }>} planWaves
 * @returns {import('./types').PlanResync}
 */
export function planResync(state, events, planTasks, planWaves) {
  const base = planBaseSpecs(events);
  /** @type {import('./types').PlanResync} */
  const out = {
    updates: [],
    adds: [],
    conflicts: [],
    blocked: [],
    graph: [],
    missing: [],
    errors: [],
  };

  const planIds = new Set(planTasks.map((t) => String(t.id)));
  const newIds = new Set([...planIds].filter((id) => !state.tasks.has(id)));

  for (const planned of planTasks) {
    const id = String(planned.id);
    const task = state.tasks.get(id);
    if (!task) continue;
    const from = base.get(id);
    if (!from) {
      out.errors.push(`${id} is already on the board as a task the plan did not create; rename it in the plan`);
      continue;
    }

    const plan = specOf(planned);
    const board = specOfTask(task);
    /** @type {import('./types').TaskEditChanges} */
    const changes = {};
    /** @type {string[]} */
    const conflicted = [];
    for (const field of SPEC_FIELDS) {
      if (same(plan[field], board[field])) continue;
      if (same(board[field], from[field])) {
        /** @type {any} */ (changes)[field] = plan[field];
      } else if (!same(plan[field], from[field])) {
        conflicted.push(field);
      }
    }
    if (changes.touches) {
      changes.touchesExpanded = Array.isArray(planned.touchesExpanded)
        ? planned.touchesExpanded.map(String)
        : null;
      changes.emptyTouchesGlobs = Array.isArray(planned.emptyTouchesGlobs)
        ? planned.emptyTouchesGlobs.map(String)
        : [];
    }
    if (conflicted.length > 0) out.conflicts.push({ taskId: id, fields: conflicted });

    const fields = SPEC_FIELDS.filter((f) => f in changes);
    if (fields.length > 0) {
      const reason = taskEditBlocker(state, id);
      if (reason) out.blocked.push({ taskId: id, fields, reason });
      else out.updates.push({ taskId: id, changes, fields });
    }

    /** @type {string[]} */
    const graph = [];
    if (Number(planned.wave) !== task.wave) graph.push('wave');
    const deps = Array.isArray(planned.dependsOn) ? planned.dependsOn.map(String) : [];
    if (!same([...deps].sort(), [...task.dependsOn].sort())) graph.push('dependsOn');
    if (graph.length > 0) out.graph.push({ taskId: id, fields: graph });
  }

  for (const planned of planTasks) {
    const id = String(planned.id);
    if (!newIds.has(id)) continue;
    const deps = Array.isArray(planned.dependsOn) ? planned.dependsOn.map(String) : [];
    const unknown = deps.filter((dep) => !state.tasks.has(dep) && !newIds.has(dep));
    if (unknown.length > 0) {
      out.errors.push(`${id} depends on ${unknown.join(', ')}, which is not on the board or in the plan`);
      continue;
    }
    const n = Number(planned.wave);
    const wave = state.waves.some((w) => w.n === n)
      ? undefined
      : { n, name: String(planWaves.find((w) => w.n === n)?.name ?? '') };
    out.adds.push({ task: { ...planned }, ...(wave ? { wave } : {}) });
  }

  for (const id of state.taskOrder) {
    if (base.has(id) && !planIds.has(id)) out.missing.push(id);
  }
  return out;
}

/**
 * True when applying the re-sync would journal anything.
 * @param {import('./types').PlanResync} result
 * @returns {boolean}
 */
export function resyncHasWork(result) {
  return result.updates.length > 0 || result.adds.length > 0;
}
