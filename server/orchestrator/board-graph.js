/**
 * The production **board** graph injected into `createEngine`.: the reconcile loop must not statically import `core/plan.js` or.
 */

import fs from 'node:fs/promises';
import { cleanupCompletedRecovery } from './checkpoint.js';
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
import { boardFailure } from './failure.js';
import { FINAL_REPAIR_LIMIT, recoverySpent, recoveryHold } from './core/recovery.js';
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
  persistReport,
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
  if (state.recoveryVersion) {
    if (state.finalTest && state.finalTest.evidence?.integrationSha !== state.integrationSha && !state.recoveryHolds['final:']) {
      const failure = boardFailure({ message: 'Integration changed after verification; running the required checks again.', failure: { category: 'interrupted' } }, 0);
      return [makeEvent('recovery.held', { hold: recoveryHold(state, { role: 'final', failure, now: 0 }) })];
    }
    const spent = recoverySpent(state);
    if (spent >= state.recoveryLimits.board && !state.recoveryHolds['preflight:']) {
      const failure = boardFailure({ outcome: 'blocked', message: 'Board recovery budget-exhausted. Increase the recovery limit in Settings before continuing; all work is retained.' }, 0);
      return [makeEvent('recovery.held', { hold: recoveryHold(state, { role: 'preflight', stage: 'budget', failure, now: 0 }) })];
    }
    for (const task of state.tasks.values()) {
      const last = [...task.attempts].reverse().find((attempt) => attempt.ended && !attempt.retired);
      const failure = last?.evidence?.failure;
      if (!last || task.mergedSha || task.waived || task.abandonedReason || !failure || failure.category === 'implementation') continue;
      if (state.recoveryHistory.some((hold) => hold.attemptId === last.attemptId)) continue;
      decisions.push(makeEvent('recovery.held', { hold: recoveryHold(state, { taskId: task.id, role: last.role, failure, now: failure.observedAt ?? 0, attemptId: last.attemptId }) }));
    }
    if (decisions.length) return decisions;
  }
  for (const { taskId, reason, evidence } of pendingAbandonments(state)) {
    if (state.recoveryVersion) {
      const failure = boardFailure({ outcome: 'blocked', message: `${reason}: ${evidence.summary ?? 'Repeated repairs did not resolve this task. Review the task diagnosis.'}` }, 0);
      decisions.push(makeEvent('recovery.held', { hold: recoveryHold(state, { taskId, role: 'builder', failure, now: 0 }) }));
    } else decisions.push(makeEvent('task.abandoned', { taskId, reason, evidence }));
  }
  for (const { taskId, blockedBy } of state.recoveryVersion ? [] : pendingSkips(state)) {
    decisions.push(makeEvent('task.skipped', { taskId, blockedBy }));
  }
  for (const taskId of pendingEnqueues(state)) {
    decisions.push(makeEvent('merge.enqueued', { taskId }));
  }
  if (state.recoveryVersion && state.finalTest?.outcome === 'fail' && !state.recoveryHolds['final:']) {
    const failure = state.finalTest.evidence?.failure ?? boardFailure({ outcome: 'fail', summary: state.finalTest.evidence?.output || state.finalTest.runInstructions }, 0);
    if (failure.category !== 'implementation' || state.finalRepairs.length >= (state.recoveryLimits?.final ?? FINAL_REPAIR_LIMIT)) {
      decisions.push(makeEvent('recovery.held', { hold: recoveryHold(state, { role: 'final', failure: { ...failure, ...(failure.category === 'implementation' ? { category: 'prerequisite', message: `Final repair budget-exhausted. Increase final repair rounds in Settings. Last failure: ${failure.message}` } : {}) }, now: failure.observedAt ?? 0 }) }));
    } else {
      const fix = buildIntegrationFixTask(state);
      const baseId = `AUTO-FIX-${state.finalRepairs.length + 1}-${(state.integrationSha || failure.fingerprint).slice(0, 8)}`;
      fix.task.id = baseId;
      let suffix = 1;
      while (state.tasks.has(fix.task.id) && state.tasks.get(fix.task.id).buildSpec !== fix.task.build) fix.task.id = `${baseId}-${++suffix}`;
      if (!state.tasks.has(fix.task.id)) decisions.push(makeEvent('task.added', { task: fix.task, wave: fix.wave }));
      decisions.push(makeEvent('final.repair.created', { taskId: fix.task.id, fingerprint: failure.fingerprint }));
    }
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
    makeEvent('run.finished', { summary: `${boardRunSummary(state)}${[...state.tasks.values()].some((task) => task.waived) ? '; completed with explicit waivers' : ''}` }),
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
export function boardReapVanished(state, live, buffered, now = 0) {
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
          // Minnow restarted or the board was stopped under it — an
          // interruption, so it resumes without spending retry budget.
          evidence: { interrupted: true, ...(state.recoveryVersion ? { failure: { ...boardFailure({ outcome: 'crashed', message: 'the process was no longer running', evidence: { interrupted: true } }, now), observedAt: now } } : {}) },
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
  if (state.recoveryVersion && !['pass', 'rebased'].includes(end.outcome)) {
    const failure = { ...boardFailure(end, ctx.now ?? Date.now()), observedAt: ctx.now ?? Date.now() };
    end = { ...end, evidence: { ...(end.evidence ?? {}), failure } };
  }
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
        ...(end.speed === undefined ? {} : { speed: end.speed }),
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
    // Keep the reason the merge failed. Without it the journal records only an
    // empty file list, which reads identically for a real conflict and for a
    // worktree that was never there.
    /** @type {Record<string, unknown>} */
    const mergeSummary =
      typeof end.summary === 'string' && end.summary ? { summary: end.summary } : {};
    if (end.outcome === 'rebased') {
      events.push(makeEvent('merge.rebased', { taskId: end.taskId, sha: end.sha, ...mergeExtra }));
    } else if (end.outcome === 'pass') {
      events.push(
        makeEvent('merge.succeeded', {
          taskId: end.taskId,
          sha: end.sha ?? 'unknown',
          ...mergeExtra,
        }),
      );
    } else if (end.outcome === 'merge_failed') {
      events.push(
        makeEvent('merge.failed', {
          taskId: end.taskId,
          reason: end.reason ?? 'unknown',
          ...mergeExtra,
          ...mergeSummary,
        }),
      );
    } else {
      events.push(
        makeEvent('merge.conflicted', {
          taskId: end.taskId,
          files: end.files ?? [],
          ...mergeExtra,
          ...mergeSummary,
        }),
      );
    }
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
  const failure = end.evidence?.failure;
  if (state.recoveryVersion && end.outcome !== 'pass' && end.role !== 'final' && failure && failure.category !== 'implementation') {
    events.push(makeEvent('recovery.held', { hold: recoveryHold(state, { taskId: end.taskId, role: end.role, failure, now: failure.observedAt, attemptId: end.attemptId }) }));
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
  // Recovery may need bytes from any unfinished checkout. Explicit Reset/Delete
  // still owns disposal; boot must not turn an interruption into data loss.
  if (ctx.state.recoveryVersion) {
    if (ctx.state.status === 'running' && ctx.state.workspacePath && !ctx.state.recoveryHolds['preflight:']) {
      let exists = false;
      try { exists = (await fs.stat(ctx.state.workspacePath)).isDirectory(); } catch {}
      if (!exists) {
        const now = Date.now();
        return [makeEvent('recovery.held', { hold: {
          ...recoveryHold(ctx.state, { role: 'preflight', stage: 'preflight', failure: boardFailure({ outcome: 'blocked', message: 'The recorded workspace is unavailable. Restore or reconnect that folder to continue.' }, now), now }), probe: true,
        } })];
      }
    }
    return [];
  }
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
 *   signal?: AbortSignal,
 * }} ctx
 * @returns {Promise<{ relativePath: string, usedFallback: boolean } | null>}
 */
export async function boardWriteReport(ctx) {
  if (journalHasReport(ctx.events)) return null;
  const stoppedEarly = ctx.state.stopReason === 'user' || ctx.state.stopReason === 'quota';
  if (!ctx.state.finished && !stoppedEarly) return null;
  const result = await writeEndOfRunReport({
    boardId: ctx.id,
    events: ctx.events,
    state: ctx.state,
    complete: ctx.complete,
    persist: async (boardId, markdown) => {
      ctx.signal?.throwIfAborted();
      return persistReport(boardId, markdown);
    },
  });
  return { relativePath: result.relativePath, usedFallback: result.usedFallback };
}

/**
 * Production graph: boards.
 * @type {import('./engine.js').Graph}
 */
export const boardGraph = {
  onFinished: ({ id, state }) => cleanupCompletedRecovery(id, state),
  recoveryEnabled: true,
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
