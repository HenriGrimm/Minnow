/** Pure three-way merge of an edited plan file into a live board. No I/O. */

import { taskEditBlocker } from './task-edit.js';

/** Fields a re-sync carries, in the order they are reported. */
const SYNC_FIELDS = /** @type {const} */ ([
  'title',
  'build',
  'test',
  'accept',
  'touches',
  'wave',
  'dependsOn',
]);

/**
 * @typedef {{
 *   title: string,
 *   build: string | null,
 *   test: string | null,
 *   accept: string | null,
 *   touches: string[],
 *   wave: number,
 *   dependsOn: string[],
 * }} Spec
 */

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
  return value == null || value === '' ? null : String(value);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function list(value) {
  return Array.isArray(value) ? value.map(String) : [];
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
    touches: list(declared.touches),
    wave: Number.isFinite(declared.wave) ? Number(declared.wave) : 1,
    dependsOn: list(declared.dependsOn),
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
    wave: task.wave,
    dependsOn: task.dependsOn,
  };
}

/**
 * Dependencies compare as sets; every other list keeps its order.
 * @param {string} field
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function same(field, a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const [x, y] = field === 'dependsOn' ? [[...a].sort(), [...b].sort()] : [a, b];
    return x.length === y.length && x.every((value, i) => value === y[i]);
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
      const next = specOf({ ...spec, ...changes });
      for (const field of SYNC_FIELDS) {
        if (field in changes) /** @type {any} */ (spec)[field] = next[field];
      }
    }
  }
  return base;
}

/**
 * First dependency cycle in the graph, as a path, or null.
 * @param {Map<string, string[]>} deps
 * @returns {string[] | null}
 */
function findCycle(deps) {
  /** @type {Map<string, 'open' | 'done'>} */
  const mark = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @param {string} id @returns {string[] | null} */
  const visit = (id) => {
    if (mark.get(id) === 'done') return null;
    if (mark.get(id) === 'open') return [...stack.slice(stack.indexOf(id)), id];
    mark.set(id, 'open');
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    mark.set(id, 'done');
    return null;
  };
  for (const id of deps.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * What re-syncing the plan would do to the board.
 *
 * Per field: the plan wins where the board still matches the base, the board
 * wins where only the board changed, and a field both sides changed
 * differently is a conflict that keeps the board's value. Running, queued and
 * merged cards take nothing. Cards dropped from the plan stay (Abandon removes
 * work, not a re-sync). The graph after the sync must have every dependency on
 * the board and no cycle, or nothing applies.
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
    missing: [],
    errors: [],
  };

  const planIds = new Set(planTasks.map((t) => String(t.id)));
  const newIds = new Set([...planIds].filter((id) => !state.tasks.has(id)));
  /** @type {Array<{ n: number, name: string }>} */
  const newWaves = [];
  /** @param {number} n */
  const noteWave = (n) => {
    if (state.waves.some((w) => w.n === n) || newWaves.some((w) => w.n === n)) return undefined;
    const wave = { n, name: String(planWaves.find((w) => w.n === n)?.name ?? '') };
    newWaves.push(wave);
    return wave;
  };

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
    /** @type {Record<string, unknown>} */
    const changes = {};
    /** @type {string[]} */
    const conflicted = [];
    for (const field of SYNC_FIELDS) {
      if (same(field, plan[field], board[field])) continue;
      if (same(field, board[field], from[field])) changes[field] = plan[field];
      else if (!same(field, plan[field], from[field])) conflicted.push(field);
    }
    if (changes.touches) {
      changes.touchesExpanded = Array.isArray(planned.touchesExpanded)
        ? planned.touchesExpanded.map(String)
        : null;
      changes.emptyTouchesGlobs = list(planned.emptyTouchesGlobs);
    }
    if (conflicted.length > 0) out.conflicts.push({ taskId: id, fields: conflicted });

    const fields = SYNC_FIELDS.filter((f) => f in changes);
    if (fields.length === 0) continue;
    const reason = taskEditBlocker(state, id);
    if (reason) {
      out.blocked.push({ taskId: id, fields, reason });
      continue;
    }
    const wave = typeof changes.wave === 'number' ? noteWave(changes.wave) : undefined;
    out.updates.push({
      taskId: id,
      changes: /** @type {import('./types').TaskEditChanges} */ (changes),
      fields,
      ...(wave ? { wave } : {}),
    });
  }

  for (const planned of planTasks) {
    const id = String(planned.id);
    if (!newIds.has(id)) continue;
    const wave = noteWave(Number(planned.wave));
    out.adds.push({ task: { ...planned }, ...(wave ? { wave } : {}) });
  }

  for (const id of state.taskOrder) {
    if (base.has(id) && !planIds.has(id)) out.missing.push(id);
  }

  // Check the graph the board would have, not the plan's: dropped and held
  // cards keep their current edges.
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const [id, task] of state.tasks) graph.set(id, task.dependsOn);
  for (const update of out.updates) {
    if (update.changes.dependsOn) graph.set(update.taskId, update.changes.dependsOn);
  }
  for (const { task } of out.adds) graph.set(String(task.id), list(task.dependsOn));
  for (const [id, deps] of graph) {
    const unknown = deps.filter((dep) => !graph.has(dep));
    if (unknown.length > 0) {
      out.errors.push(`${id} depends on ${unknown.join(', ')}, which is not on the board or in the plan`);
    }
  }
  const cycle = findCycle(graph);
  if (cycle) out.errors.push(`the dependencies would loop: ${cycle.join(' → ')}`);
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
