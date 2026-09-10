/** Pure scheduler: plan(state) returns Desired[]. */

import { deadEnded, lastEndedAttempt, readyTasks, retryBudgetUsed } from './derive.js';
import { bundleAbandonmentEvidence } from './evidence.js';
import { decide, wantsSameWorktree } from './policy.js';

// ── Task actions ─────────────────────────────────────────────────────────────

/**
 * What should happen to a task that has nothing in flight.
 * @param {import('./types').BoardState} state
 * @param {string} taskId
 * @returns {import('./types').NextAction}
 */
export function nextAction(state, taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return { kind: 'none' };
  if (task.phase === 'merged' || task.phase === 'abandoned' || task.phase === 'skipped') {
    return { kind: 'none' };
  }
  if (task.attempts.some((a) => !a.ended)) return { kind: 'none' };

  const last = lastEndedAttempt(task);
  if (!last) {
    const seedKind = task.reopened ? 'integration-fix' : 'initial';
    return { kind: 'start', role: 'builder', seedKind, sameWorktree: false };
  }

  const action = decide({
    role: last.role,
    outcome: last.outcome ?? 'no_report',
    attemptCount: retryBudgetUsed(state, taskId, last.role) - 1,
    summary: last.summary,
    evidence: last.evidence,
  });

  if (action.kind === 'retry') {
    return {
      kind: 'start',
      role: action.role,
      seedKind: action.seedKind,
      sameWorktree: action.sameWorktree,
    };
  }
  if (action.kind === 'advance') {
    if (action.to === 'tester') {
      return { kind: 'start', role: 'tester', seedKind: 'initial', sameWorktree: false };
    }
    if (action.to === 'merge') return { kind: 'enqueue' };
    return { kind: 'none' };
  }
  return {
    kind: 'abandon',
    reason: action.reason,
    evidence: bundleAbandonmentEvidence(task, action),
  };
}

/**
 * What a hand-started task should begin, if anything.
 * @param {import('./types').BoardState} state
 * @param {string} taskId
 * @param {ReadonlyArray<{ taskId: string | null, role: string }>} running
 * @returns {import('./types').NextAction}
 */
export function manualStart(state, taskId, running = []) {
  if (!state) return { kind: 'none' };
  const task = state.tasks.get(taskId);
  if (!task) return { kind: 'none' };

  if (!readyTasks(state).includes(taskId)) return { kind: 'none' };
  if (running.some((r) => r.taskId === taskId)) return { kind: 'none' };
  for (const other of running) {
    if (other.taskId === null || other.taskId === taskId) continue;
    const against = state.tasks.get(other.taskId);
    if (against && footprintsClash(task, against)) return { kind: 'none' };
  }

  const next = nextAction(state, taskId);
  return next.kind === 'start' ? next : { kind: 'none' };
}

/**
 * Tasks whose tester has passed but which are not yet on the merge queue.
 * @param {import('./types').BoardState} state
 * @returns {string[]} in scheduling order
 */
export function pendingEnqueues(state) {
  return orderedTaskIds(state).filter((id) => nextAction(state, id).kind === 'enqueue');
}

/**
 * Tasks the policy table has given up on.
 * @param {import('./types').BoardState} state
 * @returns {Array<{ taskId: string, reason: string, evidence: import('./types').Evidence }>}
 */
export function pendingAbandonments(state) {
  /** @type {Array<{ taskId: string, reason: string, evidence: import('./types').Evidence }>} */
  const out = [];
  for (const taskId of orderedTaskIds(state)) {
    const next = nextAction(state, taskId);
    if (next.kind === 'abandon') out.push({ taskId, reason: next.reason, evidence: next.evidence });
  }
  return out;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/**
 * Which attempts should be running right now.
 * @param {import('./types').BoardState} state
 * @returns {import('./types').Desired[]}
 */
export function plan(state) {
  if (!state) return [];
  if (state.status !== 'running') return manualDesires(state);

  /** @type {import('./types').Desired[]} */
  const desired = [];

  const head = state.mergeQueue[0];
  if (head !== undefined && state.tasks.has(head)) {
    desired.push({ taskId: head, role: 'merge', seedKind: 'rebase', sameWorktree: false });
  }

  const cap = Number.isSafeInteger(state.concurrency) ? Math.max(0, state.concurrency) : 1;
  const ordered = orderedTaskIds(state);

  /** @type {import('./types').Desired[]} */
  const running = [];
  for (const id of ordered) {
    const open = state.tasks.get(id)?.attempts.find((a) => !a.ended && a.role !== 'merge');
    if (open) {
      running.push({
        taskId: id,
        role: open.role,
        seedKind: open.seedKind ?? 'initial',
        sameWorktree: wantsSameWorktree(open.seedKind),
      });
    }
  }

  desired.push(...running);

  /** @type {string[]} */
  const occupied = running.map((d) => d.taskId);
  const ready = new Set(readyTasks(state));

  for (const id of ordered) {
    if (desired.filter((d) => d.role !== 'merge').length >= cap) break;
    if (!ready.has(id) || occupied.includes(id)) continue;
    const task = state.tasks.get(id);
    if (!task) continue;
    const next = nextAction(state, id);
    if (next.kind !== 'start') continue;
    const clashes = occupied.some((other) => {
      const against = state.tasks.get(other);
      return against ? footprintsClash(task, against) : false;
    });
    if (clashes) continue;
    desired.push({
      taskId: id,
      role: next.role,
      seedKind: next.seedKind,
      sameWorktree: next.sameWorktree,
    });
    occupied.push(id);
  }

  if (desired.length === 0 && isReadyForFinalTest(state)) {
    desired.push({ taskId: null, role: 'final', seedKind: 'initial', sameWorktree: false });
  }

  return desired;
}

/**
 * What a stopped board still wants: the attempts a human started by hand.
 * @param {import('./types').BoardState} state
 * @returns {import('./types').Desired[]}
 */
function manualDesires(state) {
  /** @type {import('./types').Desired[]} */
  const desired = [];
  for (const id of orderedTaskIds(state)) {
    const open = state.tasks.get(id)?.attempts.find((a) => !a.ended && a.role !== 'merge');
    if (!open || !open.manual) continue;
    desired.push({
      taskId: id,
      role: open.role,
      seedKind: open.seedKind ?? 'initial',
      sameWorktree: wantsSameWorktree(open.seedKind),
    });
  }
  return desired;
}

// ── Completion ───────────────────────────────────────────────────────────────

/**
 * Has the board finished everything it can, with the final verification still outstanding?
 * @param {import('./types').BoardState} state
 * @returns {boolean}
 */
export function isReadyForFinalTest(state) {
  if (!state || state.tasks.size === 0) return false;
  if (state.finalTest !== null || state.finished) return false;
  if (state.mergeQueue.length > 0) return false;
  let merged = 0;
  for (const task of state.tasks.values()) {
    if (task.phase === 'merged') merged += 1;
    else if (task.phase !== 'abandoned' && task.phase !== 'skipped') return false;
  }
  return merged > 0;
}

/**
 * Has the run finished everything it is ever going to do?
 * @param {import('./types').BoardState} state
 * @returns {boolean}
 */
export function isRunComplete(state) {
  if (!state || state.finished) return false;
  if (state.tasks.size === 0) return false;
  if (state.mergeQueue.length > 0) return false;

  let merged = 0;
  for (const task of state.tasks.values()) {
    if (task.phase === 'merged') merged += 1;
    else if (task.phase !== 'abandoned' && task.phase !== 'skipped') return false;
  }
  if (merged > 0 && state.finalTest === null) return false;
  return true;
}

// ── Reopen ───────────────────────────────────────────────────────────────────

/**
 * Task ids a rerun should reopen, in `orderedTaskIds` order.
 * @param {import('./types').BoardState} state
 * @param {readonly string[]} [requested]
 * @returns {string[]}
 */
export function reopenTargets(state, requested) {
  if (!state) return [];
  const seed = Array.isArray(requested) && requested.length > 0
    ? requested.map(String)
    : [...state.tasks.values()]
        .filter((task) => task.phase === 'abandoned' || task.phase === 'skipped')
        .map((task) => task.id);

  const set = new Set();
  for (const id of seed) {
    const task = state.tasks.get(id);
    if (!task || task.mergedSha !== null) continue;
    if (task.phase === 'abandoned' || task.phase === 'skipped') set.add(id);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const task of state.tasks.values()) {
      if (set.has(task.id) || task.phase !== 'skipped' || task.mergedSha !== null) continue;
      if (task.dependsOn.some((dep) => set.has(dep))) {
        set.add(task.id);
        grew = true;
      }
    }
  }
  return orderedTaskIds(state).filter((id) => set.has(id));
}

/**
 * Synthetic integration-fix task, derived entirely from state so replay reads back an identical record.
 * @param {import('./types').BoardState} state
 * @returns {{ task: import('./types').PlanTask, wave: import('./types').WaveRef }}
 */
export function buildIntegrationFixTask(state) {
  const n = (state.rerun?.n ?? 0) + 1;
  const nextWave = state.waves.reduce((max, wave) => (wave.n > max ? wave.n : max), 0) + 1;
  const failed =
    state.finalTest?.outcome === 'fail'
      ? state.finalTest
      : state.rerun?.previousFinalTest?.outcome === 'fail'
        ? state.rerun.previousFinalTest
        : null;
  const evidence = failed?.evidence && typeof failed.evidence === 'object' ? failed.evidence : {};
  const failedRung =
    typeof evidence.failedRung === 'string' && evidence.failedRung.trim()
      ? evidence.failedRung.trim()
      : '';
  const output =
    typeof evidence.output === 'string' && evidence.output.trim() ? evidence.output.trim() : '';
  const parsed = parseCommandCwd(failed?.runInstructions ?? '');
  const commandLine = parsed?.command ? `Command: ${parsed.command}` : '';
  const cwdLine = parsed?.cwd ? `cwd: ${parsed.cwd}` : '';
  const build = [
    failedRung
      ? `Fix the failing integration ${failedRung} rung.`
      : 'Fix the failure recorded by the final integration test.',
    commandLine,
    cwdLine,
    output ? `Output:\n${output}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    task: {
      id: `FIX-${n}`,
      title: 'Fix final integration test failure',
      wave: nextWave,
      dependsOn: [],
      touches: ['**/*'],
      build,
      test: 'Re-run the final integration test and confirm the failure is gone.',
      accept: 'The final integration test passes.',
      line: 0,
    },
    wave: { n: nextWave, name: 'Integration fix' },
  };
}

/**
 * Same shape as `parseRunInstructions` in final-test.js, inlined so this module stays inside `core/` (no I/O, no import outside the folder).
 * @param {string} text
 * @returns {{ command: string, cwd: string } | null}
 */
function parseCommandCwd(text) {
  const raw = String(text ?? '');
  const command = raw.match(/^command:\s*(.*)$/m)?.[1]?.trim();
  const cwd = raw.match(/^cwd:\s*(.*)$/m)?.[1]?.trim();
  if (!command || !cwd) return null;
  return { command, cwd };
}

// ── Order ────────────────────────────────────────────────────────────────────

/**
 * Tasks that can never run because something upstream was abandoned or skipped, and which are not yet recorded as skipped themselves.
 * @param {import('./types').BoardState} state
 * @returns {Array<{ taskId: string, blockedBy: string }>}
 */
export function pendingSkips(state) {
  /** @type {Array<{ taskId: string, blockedBy: string }>} */
  const out = [];
  if (!state) return out;
  const dead = deadEnded(state);
  for (const taskId of orderedTaskIds(state)) {
    const task = state.tasks.get(taskId);
    if (!task || !dead.has(taskId)) continue;
    if (task.phase === 'skipped' || task.phase === 'abandoned') continue;
    if (task.attempts.some((a) => !a.ended)) continue;
    out.push({ taskId, blockedBy: /** @type {string} */ (dead.get(taskId)) });
  }
  return out;
}

/**
 * Declared task order, stably keyed on wave first.
 * @param {import('./types').BoardState} state
 * @returns {string[]}
 */
export function orderedTaskIds(state) {
  return state.taskOrder
    .map((id, index) => ({ id, index, wave: state.tasks.get(id)?.wave ?? 0 }))
    .sort((a, b) => a.wave - b.wave || a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => entry.id);
}


// ── Path overlap ─────────────────────────────────────────────────────────────

/**
 * Do two tasks' scheduling footprints clash?
 * @param {{ touches?: readonly string[] | null, touchesExpanded?: readonly string[] | null }} a
 * @param {{ touches?: readonly string[] | null, touchesExpanded?: readonly string[] | null }} b
 * @returns {boolean}
 */
export function footprintsClash(a, b) {
  if (touchesOverlap(a?.touches ?? [], b?.touches ?? [])) return true;
  return expandedFilesOverlap(a?.touchesExpanded, b?.touchesExpanded);
}

/**
 * @param {readonly string[] | null | undefined} a
 * @param {readonly string[] | null | undefined} b
 * @returns {boolean}
 */
export function expandedFilesOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  const right = new Set(b.map(normalizeRepoPath));
  for (const file of a) {
    if (right.has(normalizeRepoPath(file))) return true;
  }
  return false;
}

/**
 * Match declared globs against a frozen file list.
 * @param {readonly string[]} globs
 * @param {readonly string[]} repoFiles
 * @returns {{ expanded: string[], emptyGlobs: string[] }}
 */
export function expandTouches(globs, repoFiles) {
  const files = (repoFiles ?? []).map(normalizeRepoPath).filter(Boolean);
  /** @type {string[]} */
  const emptyGlobs = [];
  /** @type {Set<string>} */
  const expanded = new Set();
  for (const glob of globs ?? []) {
    const pattern = String(glob);
    let hits = 0;
    for (const file of files) {
      if (pathMatchesGlob(file, pattern)) {
        expanded.add(file);
        hits += 1;
      }
    }
    if (hits === 0) emptyGlobs.push(pattern);
  }
  return { expanded: [...expanded].sort(), emptyGlobs };
}

/**
 * Paths from a worktree diff that sit outside the declared globs.
 *
 * @param {readonly string[]} declared
 * @param {readonly string[]} actual
 * @returns {string[]}
 */
export function overflowPaths(declared, actual) {
  const globs = declared ?? [];
  /** @type {string[]} */
  const extra = [];
  for (const file of actual ?? []) {
    const path = normalizeRepoPath(file);
    if (!path) continue;
    if (!globs.some((glob) => pathMatchesGlob(path, glob))) extra.push(path);
  }
  return extra.sort();
}

/**
 * Does this repo-relative path match a declared glob?
 * @param {string} file
 * @param {string} glob
 * @returns {boolean}
 */
export function pathMatchesGlob(file, glob) {
  return globsIntersect(normalizeRepoPath(file), String(glob));
}

/**
 * Repo-relative paths are compared with `/` so Windows worktrees and the journal agree.
 * @param {string} value
 * @returns {string}
 */
export function normalizeRepoPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * Do two declared footprints overlap?
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
export function touchesOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  for (const left of a) {
    for (const right of b) {
      if (globsIntersect(left, right)) return true;
    }
  }
  return false;
}

/**
 * Could these two globs match a common path?
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function globsIntersect(a, b) {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  /** @type {Map<string, boolean>} */
  const seen = new Map();

  /**
   * @param {number} i
   * @param {number} j
   * @returns {boolean}
   */
  const walk = (i, j) => {
    const key = `${i}:${j}`;
    const cached = seen.get(key);
    if (cached !== undefined) return cached;
    let result;
    if (i === left.length && j === right.length) {
      result = true;
    } else if (i < left.length && left[i] === '**') {
      result = walk(i + 1, j) || (j < right.length && walk(i, j + 1));
    } else if (j < right.length && right[j] === '**') {
      result = walk(i, j + 1) || (i < left.length && walk(i + 1, j));
    } else if (i < left.length && j < right.length) {
      result = segmentsIntersect(left[i], right[j]) && walk(i + 1, j + 1);
    } else {
      result = false;
    }
    seen.set(key, result);
    return result;
  };

  return walk(0, 0);
}

/**
 * Normalise a glob to path segments.
 * @param {string} glob
 * @returns {string[]}
 */
function segmentsOf(glob) {
  let normalised = String(glob).trim().replace(/\\/g, '/');
  while (normalised.startsWith('./')) normalised = normalised.slice(2);
  if (normalised.endsWith('/')) normalised += '**';
  return normalised.split('/').filter((segment) => segment.length > 0 && segment !== '.');
}

/**
 * One atom of a segment pattern: a literal char, a wildcard, or a character class.
 * @typedef {{ kind: 'star' } | { kind: 'any' } | { kind: 'char', ch: string }
 *          | { kind: 'class', negated: boolean, ranges: Array<[string, string]> }} Atom
 */

/**
 * @param {string} pattern
 * @returns {Atom[]}
 */
function atomsOf(pattern) {
  /** @type {Atom[]} */
  const atoms = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      atoms.push({ kind: 'star' });
      continue;
    }
    if (ch === '?') {
      atoms.push({ kind: 'any' });
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        atoms.push({ kind: 'char', ch });
        continue;
      }
      let body = pattern.slice(i + 1, close);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      /** @type {Array<[string, string]>} */
      const ranges = [];
      for (let k = 0; k < body.length; k += 1) {
        if (body[k + 1] === '-' && k + 2 < body.length) {
          ranges.push([body[k], body[k + 2]]);
          k += 2;
        } else {
          ranges.push([body[k], body[k]]);
        }
      }
      atoms.push({ kind: 'class', negated, ranges });
      i = close;
      continue;
    }
    atoms.push({ kind: 'char', ch });
  }
  return atoms;
}

/**
 * Could these two single-character atoms match the same character?
 *
 * @param {Atom} a
 * @param {Atom} b
 * @returns {boolean}
 */
function atomsOverlap(a, b) {
  if (a.kind === 'any' || b.kind === 'any') return true;
  if (a.kind === 'char' && b.kind === 'char') return a.ch === b.ch;
  if (a.kind === 'char' && b.kind === 'class') return classMatches(b, a.ch);
  if (a.kind === 'class' && b.kind === 'char') return classMatches(a, b.ch);
  if (a.kind === 'class' && b.kind === 'class') {
    if (a.negated && b.negated) return true;
    const positive = a.negated ? b : a;
    const other = a.negated ? a : b;
    for (const [lo, hi] of positive.ranges) {
      for (let code = lo.charCodeAt(0); code <= hi.charCodeAt(0); code += 1) {
        if (classMatches(other, String.fromCharCode(code))) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * @param {Extract<Atom, { kind: 'class' }>} atom
 * @param {string} ch
 * @returns {boolean}
 */
function classMatches(atom, ch) {
  let inside = false;
  for (const [lo, hi] of atom.ranges) {
    if (ch >= lo && ch <= hi) {
      inside = true;
      break;
    }
  }
  return atom.negated ? !inside : inside;
}

/**
 * Can these two single-segment patterns match a common component?
 * @param {string} p
 * @param {string} q
 * @returns {boolean}
 */
function segmentsIntersect(p, q) {
  const left = atomsOf(p);
  const right = atomsOf(q);
  /** @type {Map<number, boolean>} */
  const seen = new Map();

  /**
   * @param {number} i
   * @param {number} j
   * @returns {boolean}
   */
  const walk = (i, j) => {
    const key = i * (right.length + 1) + j;
    const cached = seen.get(key);
    if (cached !== undefined) return cached;
    let result;
    if (i === left.length && j === right.length) {
      result = true;
    } else if (i < left.length && left[i].kind === 'star') {
      result = walk(i + 1, j) || (j < right.length && walk(i, j + 1));
    } else if (j < right.length && right[j].kind === 'star') {
      result = walk(i, j + 1) || (i < left.length && walk(i + 1, j));
    } else if (i < left.length && j < right.length) {
      result = atomsOverlap(left[i], right[j]) && walk(i + 1, j + 1);
    } else {
      result = false;
    }
    seen.set(key, result);
    return result;
  };

  return walk(0, 0);
}
