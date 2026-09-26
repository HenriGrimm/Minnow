/**
 * Periodic tick loop that dispatches due scheduled jobs.
 */

import { listJobs, getStoredJobById, recoverSchedulerJobs } from './store.js';
import {
  runStoredJob,
  getActiveRunCount,
  MAX_CONCURRENT_RUNS,
  recoverInterruptedSchedulerRuns,
} from './runner.js';

/** Poll interval for due jobs. */
export const TICK_INTERVAL_MS = 15_000;

/** A larger timer gap means the machine likely slept or the event loop stalled. */
export const SCHEDULER_RECOVERY_GAP_MS = TICK_INTERVAL_MS * 3;

/** @type {NodeJS.Timeout | null} */
let tickTimer = null;

/** Prevent overlapping tick handlers. */
let ticking = false;

let lastTickAt = null;

let runtimeState = {
  startedAt: null,
  lastTickAt: null,
  nextCheckAt: null,
  lastRecoveryAt: null,
  lastRecoveryReason: null,
  catchUpQueued: 0,
  catchUpRunsStarted: 0,
  missedSkipped: 0,
  interruptedRunsRecovered: 0,
};

/**
 * Apply restart/wake recovery without replaying every missed interval.
 * @param {'startup' | 'wake' | 'timer_gap'} reason
 * @param {Date} now
 */
async function recoverSchedulerRuntime(reason, now) {
  const recovery = await recoverSchedulerJobs({
    now,
    clearInterrupted: reason === 'startup',
  });
  const interruptedRunsRecovered = await recoverInterruptedSchedulerRuns(
    recovery.recoveredJobIds,
    now,
  );
  runtimeState = {
    ...runtimeState,
    lastRecoveryAt: now.toISOString(),
    lastRecoveryReason: reason,
    catchUpQueued: recovery.catchUpDue,
    catchUpRunsStarted: 0,
    missedSkipped: recovery.missedSkipped,
    interruptedRunsRecovered,
  };
  return { ...recovery, interruptedRunsRecovered };
}

/**
 * Find enabled jobs whose next run is due and start them.
 * @param {{ baseUrl?: string; now?: Date; recoveryReason?: 'startup' | 'wake' | 'timer_gap'; skipGapRecovery?: boolean; runJob?: typeof runStoredJob; activeRunCount?: typeof getActiveRunCount }} [options]
 */
export async function runSchedulerTick(options = {}) {
  if (ticking) {
    return { dispatched: 0, skipped: 'tick_in_progress' };
  }

  ticking = true;
  let dispatched = 0;
  try {
    const now = options.now ?? new Date();
    const tickGap = lastTickAt == null ? 0 : now.getTime() - lastTickAt;
    const recoveryReason = options.recoveryReason
      ?? (!options.skipGapRecovery && tickGap > SCHEDULER_RECOVERY_GAP_MS ? 'timer_gap' : null);
    if (recoveryReason) {
      await recoverSchedulerRuntime(recoveryReason, now);
    }
    lastTickAt = now.getTime();
    runtimeState.lastTickAt = now.toISOString();
    runtimeState.nextCheckAt = new Date(now.getTime() + TICK_INTERVAL_MS).toISOString();

    const runJob = options.runJob ?? runStoredJob;
    const activeRunCount = options.activeRunCount ?? getActiveRunCount;
    const jobs = await listJobs();
    for (const job of jobs) {
      if (!job.enabled || job.running) {
        continue;
      }
      if (!job.nextRunAt) {
        continue;
      }
      if (new Date(job.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
        break;
      }

      const stored = await getStoredJobById(job.id);
      if (!stored || stored.running) {
        continue;
      }

      const result = await runJob(stored, { baseUrl: options.baseUrl });
      if (result.started) {
        dispatched += 1;
      }
    }
  } finally {
    ticking = false;
  }

  if (dispatched > 0 && runtimeState.catchUpQueued > 0) {
    const catchUpsStarted = Math.min(dispatched, runtimeState.catchUpQueued);
    runtimeState.catchUpQueued -= catchUpsStarted;
    runtimeState.catchUpRunsStarted += catchUpsStarted;
  }

  return { dispatched };
}

/**
 * Start the scheduler tick loop after server bootstrap.
 * @param {{ baseUrl?: string; intervalMs?: number }} [options]
 */
export async function startSchedulerTickLoop(options = {}) {
  if (tickTimer) {
    return;
  }

  const intervalMs = options.intervalMs ?? TICK_INTERVAL_MS;
  const baseUrl = options.baseUrl;
  const startedAt = new Date();
  runtimeState = {
    ...runtimeState,
    startedAt: startedAt.toISOString(),
  };
  await recoverSchedulerRuntime('startup', startedAt);

  const tick = (skipGapRecovery = false) => {
    void runSchedulerTick({ baseUrl, skipGapRecovery }).catch((err) => {
      console.warn('[scheduler] tick failed:', err instanceof Error ? err.message : err);
    });
  };

  tickTimer = setInterval(() => tick(false), intervalMs);
  if (typeof tickTimer.unref === 'function') {
    tickTimer.unref();
  }
  tick(true);
}

/** Stop tick loop and clear timer (tests / shutdown). */
export function stopSchedulerTickLoop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  runtimeState.nextCheckAt = null;
}

/** Run recovery immediately after an explicit operating-system wake event. */
export async function wakeScheduler(options = {}) {
  return runSchedulerTick({
    baseUrl: options.baseUrl,
    now: options.now ?? new Date(),
    recoveryReason: 'wake',
  });
}

/** Runtime details for Scheduler UI and diagnostics. */
export function getSchedulerRuntimeStatus() {
  return {
    active: Boolean(tickTimer),
    tickIntervalMs: TICK_INTERVAL_MS,
    ...runtimeState,
  };
}

/** Reset module-local timing state between deterministic tests. */
export function resetSchedulerTickForTests() {
  stopSchedulerTickLoop();
  ticking = false;
  lastTickAt = null;
  runtimeState = {
    startedAt: null,
    lastTickAt: null,
    nextCheckAt: null,
    lastRecoveryAt: null,
    lastRecoveryReason: null,
    catchUpQueued: 0,
    catchUpRunsStarted: 0,
    missedSkipped: 0,
    interruptedRunsRecovered: 0,
  };
}
