/** Fold journal events into board state. */

import { validateEvent } from './events.js';

// ── Empty state ──────────────────────────────────────────────────────────────

/**
 * Product default for the first `board.started` when the caller omits N.
 */
export const DEFAULT_BOARD_CONCURRENCY = 2;

/**
 * The state of a board with no journal at all.
 * @returns {import('./types').BoardState}
 */
export function emptyState() {
  return {
    boardId: '',
    name: '',
    planPath: '',
    workspacePath: null,
    waves: [],
    status: 'created',
    concurrency: 1,
    tasks: new Map(),
    taskOrder: [],
    mergeQueue: [],
    integrationSha: null,
    model: null,
    finalTest: null,
    finished: false,
    stopReason: null,
    runSummary: null,
    rerun: null,
  };
}

// ── Fold ─────────────────────────────────────────────────────────────────────

/**
 * Fold events into an existing state, in place, and recompute phases.
 * @param {import('./types').BoardState} state
 * @param {Iterable<unknown>} events
 * @returns {import('./types').BoardState}
 */
export function foldInto(state, events) {
  if (!events || typeof (/** @type {any} */ (events)[Symbol.iterator]) !== 'function') {
    for (const task of state.tasks.values()) task.phase = phaseOf(state, task);
    return state;
  }

  for (const raw of events) {
    const checked = validateEvent(raw);
    if (!checked.ok || !checked.known) continue;
    apply(state, /** @type {any} */ (checked.event));
  }

  for (const task of state.tasks.values()) task.phase = phaseOf(state, task);
  return state;
}

/**
 * Fold a journal into board state.
 *
 * @param {Iterable<unknown>} events
 * @returns {import('./types').BoardState}
 */
export function derive(events) {
  return foldInto(emptyState(), events);
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * @param {import('./types').BoardState} state
 * @param {any} event
 * @returns {void}
 */
function apply(state, event) {
  switch (event.type) {
    case 'board.created': {
      state.boardId = event.boardId;
      state.planPath = event.planPath;
      if (typeof event.name === 'string') state.name = event.name;
      if (typeof event.workspacePath === 'string' && event.workspacePath.trim()) {
        state.workspacePath = event.workspacePath;
      }
      state.waves = event.waves.map((w) => ({ n: Number(w.n), name: String(w.name ?? '') }));
      for (const declared of event.tasks) {
        const id = String(declared.id ?? '');
        if (!id || state.tasks.has(id)) continue;
        state.tasks.set(id, newTask(id, declared));
        state.taskOrder.push(id);
      }
      return;
    }

    case 'board.started': {
      state.status = 'running';
      state.concurrency = event.concurrency;
      state.stopReason = null;
      return;
    }

    case 'board.stopped': {
      state.status = 'stopped';
      state.stopReason = event.reason;
      for (const task of state.tasks.values()) {
        for (const attempt of task.attempts) {
          if (!attempt.ended) attempt.manual = false;
        }
      }
      return;
    }

    case 'task.attempt.started': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      if (task.attempts.some((a) => a.attemptId === event.attemptId)) return;
      task.attempts.push({
        attemptId: event.attemptId,
        role: event.role,
        worktree: event.worktree ?? null,
        seedKind: event.seedKind ?? null,
        ended: false,
        outcome: null,
        summary: null,
        evidence: null,
        manual: state.status !== 'running',
        retired: false,
      });
      return;
    }

    case 'task.attempt.ended': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      let attempt = task.attempts.find((a) => a.attemptId === event.attemptId);
      if (!attempt) {
        attempt = {
          attemptId: event.attemptId,
          role: event.role,
          worktree: null,
          seedKind: null,
          ended: false,
          outcome: null,
          summary: null,
          evidence: null,
          manual: false,
          retired: false,
        };
        task.attempts.push(attempt);
      }
      if (attempt.ended) return;
      attempt.ended = true;
      attempt.outcome = event.outcome;
      attempt.summary = event.summary ?? null;
      attempt.evidence = event.evidence ?? null;
      return;
    }

    case 'merge.enqueued': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      if (!state.mergeQueue.includes(event.taskId)) state.mergeQueue.push(event.taskId);
      if (!task.attempts.some((a) => a.role === 'merge' && !a.ended)) {
        task.attempts.push(mergeAttempt(task));
      }
      return;
    }

    case 'merge.succeeded': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      state.mergeQueue = state.mergeQueue.filter((id) => id !== event.taskId);
      closeMergeAttempt(task, 'pass');
      task.mergedSha = event.sha;
      task.mergeConflicts = null;
      state.integrationSha = event.sha;
      return;
    }

    case 'merge.conflicted': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      state.mergeQueue = state.mergeQueue.filter((id) => id !== event.taskId);
      closeMergeAttempt(task, 'conflicted', event.summary);
      task.mergeConflicts = [...event.files];
      task.mergeFailure = null;
      return;
    }

    case 'merge.failed': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      state.mergeQueue = state.mergeQueue.filter((id) => id !== event.taskId);
      closeMergeAttempt(task, 'merge_failed');
      // Deliberately not mergeConflicts: nothing here is a conflicting file, and
      // seeding a rebase off this list is what sent the last run in circles.
      task.mergeConflicts = null;
      task.mergeFailure = { reason: event.reason, summary: event.summary ?? null };
      return;
    }

    case 'task.abandoned': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      state.mergeQueue = state.mergeQueue.filter((id) => id !== event.taskId);
      task.abandonedReason = event.reason;
      task.abandonedEvidence = event.evidence ?? null;
      return;
    }

    case 'task.skipped': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      state.mergeQueue = state.mergeQueue.filter((id) => id !== event.taskId);
      task.skippedBy = event.blockedBy;
      return;
    }

    case 'touches.overflow': {
      const task = state.tasks.get(event.taskId);
      if (!task) return;
      task.touchesOverflow.push({
        attemptId: event.attemptId,
        declared: [...event.declared],
        actual: [...event.actual],
      });
      return;
    }

    case 'final.test.ended': {
      state.finalTest = {
        outcome: event.outcome,
        runInstructions: event.runInstructions ?? null,
        evidence: event.evidence ?? null,
      };
      return;
    }

    case 'run.finished': {
      state.finished = true;
      state.runSummary = event.summary;
      return;
    }

    case 'board.model.set': {
      state.model = {
        providerId: event.providerId,
        id: event.id,
        reasoning: typeof event.reasoning === 'string' && event.reasoning ? event.reasoning : null,
      };
      return;
    }

    case 'board.renamed': {
      state.name = event.name;
      return;
    }

    case 'task.added': {
      const declared = event.task && typeof event.task === 'object' ? event.task : null;
      const id = declared ? String(declared.id ?? '') : '';
      if (!id || state.tasks.has(id)) return;
      state.tasks.set(id, newTask(id, declared));
      state.taskOrder.push(id);
      const wave = event.wave;
      if (wave && typeof wave === 'object') {
        const n = Number(wave.n);
        if (Number.isFinite(n) && !state.waves.some((w) => w.n === n)) {
          state.waves = [...state.waves, { n, name: String(wave.name ?? '') }];
        }
      }
      return;
    }

    case 'board.reopened': {
      const n = (state.rerun?.n ?? 0) + 1;
      const taskIds = Array.isArray(event.taskIds) ? event.taskIds.map(String) : [];
      state.rerun = {
        n,
        reason: String(event.reason ?? ''),
        taskIds: [...taskIds],
        previousFinalTest: state.finalTest,
      };
      reopenBoard(state);
      for (const id of taskIds) {
        const task = state.tasks.get(id);
        if (!task || task.mergedSha !== null) continue;
        task.reopened = {
          n,
          from:
            task.abandonedReason ??
            (task.skippedBy ? `stranded by ${task.skippedBy}` : null),
        };
        task.abandonedReason = null;
        task.abandonedEvidence = null;
        task.skippedBy = null;
        task.mergeConflicts = null;
        task.mergeFailure = null;
        for (const attempt of task.attempts) {
          if (attempt.ended) attempt.retired = true;
        }
      }
      return;
    }

    case 'task.reset': {
      reopenBoard(state);
      const taskIds = Array.isArray(event.taskIds) ? event.taskIds.map(String) : [];
      for (const id of taskIds) {
        const task = state.tasks.get(id);
        // A merged card is Rewind's job. A stray reset line must not unmerge it.
        if (!task || task.mergedSha !== null) continue;
        wipeTaskRuntime(state, task);
      }
      return;
    }

    case 'board.rewound': {
      reopenBoard(state);
      const beforeSha =
        typeof event.beforeSha === 'string' && event.beforeSha.trim()
          ? event.beforeSha.trim()
          : null;
      if (beforeSha) state.integrationSha = beforeSha;
      const taskIds = Array.isArray(event.taskIds) ? event.taskIds.map(String) : [];
      for (const id of taskIds) {
        const task = state.tasks.get(id);
        if (!task) continue;
        wipeTaskRuntime(state, task);
      }
      return;
    }

  }
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * A merge has no agent and so no `task.attempt.started` line.
 * @param {import('./types').TaskState} task
 * @returns {import('./types').Attempt}
 */
function mergeAttempt(task) {
  const n = task.attempts.filter((a) => a.role === 'merge').length;
  return {
    attemptId: `merge#${task.id}#${n + 1}`,
    role: 'merge',
    worktree: null,
    seedKind: null,
    ended: false,
    outcome: null,
    summary: null,
    evidence: null,
    manual: false,
    retired: false,
  };
}

/**
 * @param {import('./types').TaskState} task
 * @param {'pass' | 'conflicted' | 'merge_failed'} outcome
 * @param {string} [summary]
 * @returns {void}
 */
function closeMergeAttempt(task, outcome, summary) {
  let attempt = task.attempts.find((a) => a.role === 'merge' && !a.ended);
  if (!attempt) {
    attempt = mergeAttempt(task);
    task.attempts.push(attempt);
  }
  attempt.ended = true;
  attempt.outcome = outcome;
  attempt.summary = summary ?? null;
}

/**
 * Clear run-end flags so a finished board can start work again.
 * @param {import('./types').BoardState} state
 * @returns {void}
 */
function reopenBoard(state) {
  state.finalTest = null;
  state.finished = false;
  state.runSummary = null;
}

/**
 * Wipe everything Reset/Rewind throw away. Spec fields stay.
 * @param {import('./types').BoardState} state
 * @param {import('./types').TaskState} task
 * @returns {void}
 */
function wipeTaskRuntime(state, task) {
  state.mergeQueue = state.mergeQueue.filter((id) => id !== task.id);
  task.attempts = [];
  task.outcome = null;
  task.abandonedReason = null;
  task.abandonedEvidence = null;
  task.skippedBy = null;
  task.mergedSha = null;
  task.mergeConflicts = null;
  task.mergeFailure = null;
  task.touchesOverflow = [];
  task.reopened = null;
}

/**
 * @param {string} id
 * @param {any} declared
 * @returns {import('./types').TaskState}
 */
function newTask(id, declared) {
  return {
    id,
    title: String(declared.title ?? id),
    wave: Number.isFinite(declared.wave) ? Number(declared.wave) : 1,
    dependsOn: Array.isArray(declared.dependsOn) ? declared.dependsOn.map(String) : [],
    touches: Array.isArray(declared.touches) ? declared.touches.map(String) : [],
    touchesExpanded: Array.isArray(declared.touchesExpanded)
      ? [...new Set(declared.touchesExpanded.map(String))].sort()
      : null,
    emptyTouchesGlobs: Array.isArray(declared.emptyTouchesGlobs)
      ? declared.emptyTouchesGlobs.map(String)
      : [],
    buildSpec: declared.build == null ? null : String(declared.build),
    testSpec: declared.test == null ? null : String(declared.test),
    accept: declared.accept == null ? null : String(declared.accept),
    phase: 'idle',
    attempts: [],
    outcome: null,
    abandonedReason: null,
    abandonedEvidence: null,
    skippedBy: null,
    mergedSha: null,
    mergeConflicts: null,
    mergeFailure: null,
    touchesOverflow: [],
    reopened: null,
  };
}

// ── Phases ───────────────────────────────────────────────────────────────────

/**
 * @param {import('./types').BoardState} state
 * @param {import('./types').TaskState} task
 * @returns {import('./types').TaskPhase}
 */
function phaseOf(state, task) {
  task.outcome = lastEndedAttempt(task)?.outcome ?? null;
  if (task.abandonedReason !== null) return 'abandoned';
  if (task.skippedBy !== null) return 'skipped';
  if (task.mergedSha !== null) return 'merged';
  if (state.mergeQueue.includes(task.id)) return 'merging';
  const open = task.attempts.find((a) => !a.ended);
  if (open) {
    if (open.role === 'builder') return 'building';
    if (open.role === 'tester') return 'testing';
    return 'merging';
  }
  return 'idle';
}

/**
 * The most recent attempt that finished, or undefined if none has.
 *
 * @param {import('./types').TaskState} task
 * @returns {import('./types').Attempt | undefined}
 */
export function lastEndedAttempt(task) {
  for (let i = task.attempts.length - 1; i >= 0; i -= 1) {
    const attempt = task.attempts[i];
    if (attempt.ended && !attempt.retired) return attempt;
  }
  return undefined;
}

/**
 * How many attempts of a role have *finished* for a task.
 * @param {import('./types').BoardState} state
 * @param {string} taskId
 * @param {import('./types').Role} role
 * @returns {number}
 */
export function attemptCount(state, taskId, role) {
  const task = state.tasks.get(taskId);
  if (!task) return 0;
  let n = 0;
  for (const attempt of task.attempts) {
    if (attempt.ended && !attempt.retired && attempt.role === role) n += 1;
  }
  return n;
}

/**
 * How much of a role's retry budget this task has spent.
 *
 * Only *failed* attempts spend it, and a pass clears the slate. The plain count
 * is the wrong input for the policy table: a task that builds green, tests
 * green, then comes back for a rebase after a merge conflict would arrive with
 * its budget already spent by those successes, and abandon on the first stumble
 * with no retry at all. A pass means the task reached a good state, so whatever
 * went wrong before it is stale history.
 *
 * @param {import('./types').BoardState} state
 * @param {string} taskId
 * @param {import('./types').Role} role
 * @returns {number} failed attempts of `role` since its last passing attempt
 */
export function retryBudgetUsed(state, taskId, role) {
  const task = state.tasks.get(taskId);
  if (!task) return 0;
  let n = 0;
  for (const attempt of task.attempts) {
    if (!attempt.ended || attempt.retired || attempt.role !== role) continue;
    if (attempt.outcome === 'pass') n = 0;
    else n += 1;
  }
  return n;
}

// ── Ready ────────────────────────────────────────────────────────────────────

/**
 * Tasks whose every dependency has merged and which are not themselves finished.
 * @param {import('./types').BoardState} state
 * @returns {string[]} in declared task order
 */
export function readyTasks(state) {
  /** @type {string[]} */
  const ready = [];
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (!task) continue;
    if (task.phase === 'merged' || task.phase === 'abandoned' || task.phase === 'skipped') continue;
    const blocked = task.dependsOn.some((dep) => state.tasks.get(dep)?.phase !== 'merged');
    if (!blocked) ready.push(id);
  }
  return ready;
}

/**
 * Walk an immediate broken dependency to the abandoned root.
 * @param {import('./types').BoardState} state
 * @param {string} startId
 * @param {Map<string, string>} immediate
 * @returns {string}
 */
function abandonedRootOf(state, startId, immediate) {
  const seen = new Set();
  let current = startId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const task = state.tasks.get(current);
    if (!task) return current;
    if (task.phase === 'abandoned') return current;
    if (task.phase === 'skipped' && task.skippedBy) {
      current = task.skippedBy;
      continue;
    }
    const next = immediate.get(current);
    if (next && next !== current) {
      current = next;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Tasks that can never run because something they depend on is abandoned, skipped, or missing.
 * @param {import('./types').BoardState} state
 * @returns {Map<string, string>} taskId -> the abandoned root that blocks it
 */
export function deadEnded(state) {
  /** @type {Map<string, string>} */
  const immediate = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of state.taskOrder) {
      const task = state.tasks.get(id);
      if (!task || immediate.has(id)) continue;
      if (task.phase === 'abandoned' || task.phase === 'skipped') continue;
      for (const dep of task.dependsOn) {
        const upstream = state.tasks.get(dep);
        const broken =
          !upstream ||
          upstream.phase === 'abandoned' ||
          upstream.phase === 'skipped' ||
          immediate.has(dep);
        if (broken) {
          immediate.set(id, dep);
          changed = true;
          break;
        }
      }
    }
  }

  for (const id of cyclicTasks(state, immediate)) {
    if (!immediate.has(id)) immediate.set(id, id);
  }

  /** @type {Map<string, string>} */
  const dead = new Map();
  for (const [id, blocker] of immediate) {
    dead.set(id, abandonedRootOf(state, blocker, immediate));
  }
  return dead;
}

/**
 * Task ids that can never become ready because they sit on, or behind, a dependency cycle among tasks that are still live.
 * @param {import('./types').BoardState} state
 * @param {Map<string, string>} dead  already-known dead ends, excluded
 * @returns {string[]} in declared order
 */
function cyclicTasks(state, dead) {
  /** @type {Set<string>} */
  const settled = new Set();
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (!task) continue;
    if (task.phase === 'merged' || task.phase === 'abandoned' || task.phase === 'skipped') {
      settled.add(id);
    }
  }

  /** @type {Set<string>} */
  const reachable = new Set(settled);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of state.taskOrder) {
      if (reachable.has(id) || dead.has(id)) continue;
      const task = state.tasks.get(id);
      if (!task) continue;
      if (task.dependsOn.every((dep) => reachable.has(dep))) {
        reachable.add(id);
        changed = true;
      }
    }
  }

  return state.taskOrder.filter(
    (id) => !reachable.has(id) && !dead.has(id) && state.tasks.has(id),
  );
}
