/**
 * The production **board** graph injected into `createEngine`.: the reconcile loop must not statically import `core/plan.js` or.
 */

import {
  buildIntegrationFixTask,
  isReadyForFinalTest,
  isRunComplete,
  manualStart,
  pendingAbandonments,
  pendingEnqueues,
  pendingSkips,
  plan,
  reopenTargets,
} from './core/plan.js';
import { DEFAULT_BOARD_CONCURRENCY, foldInto } from './core/derive.js';
import { makeEvent } from './core/events.js';
import {
  BOARD_GIT_INITIALIZED_TYPE,
  integrationBranch,
  liveWorktreePaths,
  reconcileOrphanWorktrees,
  WORKTREE_DISCARDED_TYPE,
} from './worktree-lifecycle.js';
import { captureWorktreeDiff, detectAttemptOverflow } from './touches.js';
import {
  defaultComplete,
  formatMechanicalReport,
  journalHasReport,
  REPORT_EVENT_TYPE,
  writeEndOfRunReport,
} from './report.js';

/**
 * Roles the engine journals as task attempts.
 * @param {string} role
 * @returns {boolean}
 */
export function isBoardAgentRole(role) {
  return role === 'builder' || role === 'tester';
}

/**
 * A one-line description of how the run went, for `run.finished`.
 * @param {import('./core/types').BoardState} state
 * @returns {string}
 */
export function boardRunSummary(state) {
  let merged = 0;
  let abandoned = 0;
  let skipped = 0;
  for (const task of state.tasks.values()) {
    if (task.phase === 'merged') merged += 1;
    else if (task.phase === 'abandoned') abandoned += 1;
    else if (task.phase === 'skipped') skipped += 1;
  }
  const parts = [`${merged} merged`];
  if (abandoned > 0) parts.push(`${abandoned} abandoned`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (state.finalTest) parts.push(`final test ${state.finalTest.outcome}`);
  return parts.join(', ');
}

/**
 * Journal every decision the current board state already implies.
 *
 * @param {import('./core/types').BoardState} state
 * @returns {Record<string, unknown>[]}
 */
export function boardImpliedEvents(state) {
  /** @type {Record<string, unknown>[]} */
  const decisions = [];
  for (const { taskId, reason, evidence } of pendingAbandonments(state)) {
    decisions.push(makeEvent('task.abandoned', { taskId, reason, evidence }));
  }
  for (const { taskId, blockedBy } of pendingSkips(state)) {
    decisions.push(makeEvent('task.skipped', { taskId, blockedBy }));
  }
  for (const taskId of pendingEnqueues(state)) {
    decisions.push(makeEvent('merge.enqueued', { taskId }));
  }
  return decisions;
}

/**
 * @param {import('./core/types').BoardState} state
 * @returns {Record<string, unknown>[]}
 */
export function boardEventsForRunComplete(state) {
  let merged = 0;
  for (const task of state.tasks.values()) {
    if (task.phase === 'merged') merged += 1;
  }
  const reason =
    state.finalTest?.outcome === 'fail' || merged === 0 ? 'terminal' : 'complete';
  return [
    makeEvent('run.finished', { summary: boardRunSummary(state) }),
    makeEvent('board.stopped', { reason }),
  ];
}

/**
 * Has the fold already closed this attempt?
 *
 * @param {import('./core/types').BoardState} state
 * @param {string} attemptId
 * @returns {boolean}
 */
export function boardIsAlreadyEnded(state, attemptId) {
  for (const task of state.tasks.values()) {
    for (const attempt of task.attempts) {
      if (attempt.attemptId === attemptId) return attempt.ended;
    }
  }
  return false;
}

/**
 * Record attempts the journal says are open but that no longer exist.
 *
 * @param {import('./core/types').BoardState} state
 * @param {Set<string>} live
 * @param {Set<string>} buffered
 * @returns {Record<string, unknown>[]}
 */
export function boardReapVanished(state, live, buffered) {
  /** @type {Record<string, unknown>[]} */
  const ended = [];
  for (const task of state.tasks.values()) {
    for (const attempt of task.attempts) {
      if (attempt.ended) continue;
      if (!isBoardAgentRole(attempt.role)) continue;
      if (live.has(attempt.attemptId)) continue;
      if (buffered.has(attempt.attemptId)) continue;
      ended.push(
        makeEvent('task.attempt.ended', {
          taskId: task.id,
          attemptId: attempt.attemptId,
          role: attempt.role,
          outcome: 'crashed',
          summary: 'the process was no longer running',
        }),
      );
    }
  }
  return ended;
}

/**
 * @param {import('./core/types').Desired} want
 * @param {{ attemptId: string, worktree?: string, discarded?: Record<string, unknown>[], gitInitialized?: Record<string, unknown> }} handle
 * @returns {Record<string, unknown>[]}
 */
export function boardEventsForStart(want, handle) {
  if (!isBoardAgentRole(want.role)) return [];
  /** @type {Record<string, unknown>[]} */
  const events = [];
  if (Array.isArray(handle.discarded)) {
    for (const payload of handle.discarded) {
      events.push(makeEvent(WORKTREE_DISCARDED_TYPE, payload));
    }
  }
  if (handle.gitInitialized) {
    events.push(makeEvent(BOARD_GIT_INITIALIZED_TYPE, handle.gitInitialized));
  }
  events.push(
    makeEvent('task.attempt.started', {
      taskId: want.taskId,
      attemptId: handle.attemptId,
      role: want.role,
      ...(handle.worktree ? { worktree: handle.worktree } : {}),
      ...(want.seedKind ? { seedKind: want.seedKind } : {}),
    }),
  );
  return events;
}

/**
 * @param {{ gitInitialized?: Record<string, unknown> } | void} result
 * @returns {Record<string, unknown>[]}
 */
export function boardEventsForPreflight(result) {
  if (!result?.gitInitialized) return [];
  return [makeEvent(BOARD_GIT_INITIALIZED_TYPE, result.gitInitialized)];
}

/**
 * Map an AttemptEnd onto journal events (agent / merge / final / discarded).
 *
 * @param {import('./engine.js').AttemptEnd} end
 * @param {{ id: string, state: import('./core/types').BoardState }} ctx
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function boardEventsForAttemptEnd(end, ctx) {
  const { id, state } = ctx;
  /** @type {Record<string, unknown>[]} */
  const events = [];
  if (isBoardAgentRole(end.role)) {
    const task = end.taskId ? state.tasks.get(end.taskId) : undefined;
    const attempt = task?.attempts.find((a) => a.attemptId === end.attemptId);
    let evidence = end.evidence;
    const worktree = attempt?.worktree;
    if (worktree) {
      try {
        const diff = await captureWorktreeDiff(worktree, integrationBranch(id));
        if (diff) evidence = { ...(evidence ?? {}), diff };
      } catch (err) {
        console.warn(
          `[orchestrator] ${id}: attempt diff capture failed for ${end.attemptId}:`,
          /** @type {Error} */ (err)?.message ?? err,
        );
      }
    }
    events.push(
      makeEvent('task.attempt.ended', {
        taskId: end.taskId,
        attemptId: end.attemptId,
        role: end.role,
        outcome: end.outcome,
        ...(end.summary === undefined ? {} : { summary: end.summary }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(end.usage === undefined ? {} : { usage: end.usage }),
      }),
    );
    if (end.outcome === 'pass' && end.role === 'builder' && end.taskId) {
      try {
        const overflow = await detectAttemptOverflow({
          worktree: attempt?.worktree,
          declared: task?.touches ?? [],
          baseRef: integrationBranch(id),
        });
        if (overflow) {
          events.push(
            makeEvent('touches.overflow', {
              taskId: end.taskId,
              attemptId: end.attemptId,
              declared: overflow.declared,
              actual: overflow.actual,
            }),
          );
        }
      } catch (err) {
        console.warn(
          `[orchestrator] ${id}: touches overflow check failed for ${end.attemptId}:`,
          /** @type {Error} */ (err)?.message ?? err,
        );
      }
    }
  } else if (end.role === 'merge') {
    /** @type {Record<string, unknown>} */
    const mergeExtra =
      typeof end.beforeSha === 'string' && end.beforeSha ? { beforeSha: end.beforeSha } : {};
    events.push(
      end.outcome === 'pass'
        ? makeEvent('merge.succeeded', {
            taskId: end.taskId,
            sha: end.sha ?? 'unknown',
            ...mergeExtra,
          })
        : makeEvent('merge.conflicted', {
            taskId: end.taskId,
            files: end.files ?? [],
            ...(end.summary === undefined ? {} : { summary: end.summary }),
            ...mergeExtra,
          }),
    );
  } else if (end.role === 'final') {
    events.push(
      makeEvent('final.test.ended', {
        outcome: end.outcome === 'pass' ? 'pass' : 'fail',
        ...(end.runInstructions === undefined ? {} : { runInstructions: end.runInstructions }),
        ...(end.evidence === undefined ? {} : { evidence: end.evidence }),
      }),
    );
  }
  if (end.discarded) {
    events.push(makeEvent(WORKTREE_DISCARDED_TYPE, end.discarded));
  }
  return events;
}

/**
 * Reclaim orphan worktrees on load. Live paths come from open journal attempts.
 *
 * @param {{ id: string, state: import('./core/types').BoardState }} ctx
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function boardOnLoad(ctx) {
  try {
    const result = await reconcileOrphanWorktrees({
      boardId: ctx.id,
      livePaths: liveWorktreePaths(ctx.state),
    });
    if (result.discarded.length === 0) return [];
    return result.discarded.map((payload) => makeEvent(WORKTREE_DISCARDED_TYPE, payload));
  } catch (err) {
    console.warn(
      `[orchestrator] ${ctx.id}: worktree reconcile failed:`,
      /** @type {Error} */ (err)?.message ?? err,
    );
    return [];
  }
}

/**
 * Exactly one report per run, from this hook only.
 *
 * @param {{
 *   id: string,
 *   state: import('./core/types').BoardState,
 *   events: Record<string, unknown>[],
 *   complete: import('./report.js').ReportComplete,
 * }} ctx
 * @returns {Promise<{ relativePath: string, usedFallback: boolean } | null>}
 */
export async function boardWriteReport(ctx) {
  if (journalHasReport(ctx.events)) return null;
  const stoppedByUser = ctx.state.stopReason === 'user';
  if (!ctx.state.finished && !stoppedByUser) return null;
  const result = await writeEndOfRunReport({
    boardId: ctx.id,
    events: ctx.events,
    state: ctx.state,
    complete: ctx.complete,
  });
  return { relativePath: result.relativePath, usedFallback: result.usedFallback };
}

/**
 * Production graph: boards.
 * @type {import('./engine.js').Graph}
 */
export const boardGraph = {
  foldInto,
  plan,
  impliedEvents: boardImpliedEvents,
  isRunComplete,
  eventsForRunComplete: boardEventsForRunComplete,
  isAgentRole: isBoardAgentRole,
  isAlreadyEnded: boardIsAlreadyEnded,
  reapVanished: boardReapVanished,
  eventsForStart: boardEventsForStart,
  eventsForPreflight: boardEventsForPreflight,
  eventsForAttemptEnd: boardEventsForAttemptEnd,
  onLoad: boardOnLoad,
  writeReport: boardWriteReport,
  reportEventType: REPORT_EVENT_TYPE,
  hasReport: journalHasReport,
  formatReport: formatMechanicalReport,
  manualStart,
  reopenTargets,
  buildIntegrationFixTask,
  defaultConcurrency: DEFAULT_BOARD_CONCURRENCY,
};

export { isReadyForFinalTest, DEFAULT_BOARD_CONCURRENCY, defaultComplete, formatMechanicalReport };
