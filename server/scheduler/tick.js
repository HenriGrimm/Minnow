/**
 * Periodic tick loop that dispatches due scheduled jobs.
 */

import { listJobs, getStoredJobById, recomputeAllNextRuns } from './store.js';
import { startStoredJob, getActiveRunCount, MAX_CONCURRENT_RUNS, recoverInterruptedSchedulerRuns } from './runner.js';

/** Poll interval for due jobs. */
export const TICK_INTERVAL_MS = 15_000;

/** @type {NodeJS.Timeout | null} */
let tickTimer = null;

/** Prevent overlapping tick handlers. */
let ticking = false;

/**
 * Find enabled jobs whose next run is due and start them.
 * @param {{ baseUrl?: string; now?: Date; spawn?: typeof import('node:child_process').spawn }} [options]
 */
export async function runSchedulerTick(options = {}) {
  if (ticking) {
    return { dispatched: 0, skipped: 'tick_in_progress' };
  }

  ticking = true;
  let dispatched = 0;
  try {
    const now = options.now ?? new Date();
    // Admit the oldest due run first, regardless of the store's label ordering.
    const jobs = (await listJobs()).sort((a, b) =>
      Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? '') || a.id.localeCompare(b.id));
    for (const job of jobs) {
      if (!job.enabled || job.running) {
        continue;
      }
      if (!job.nextRunAt) {
        continue;
      }
      const dueAt = new Date(job.nextRunAt).getTime();
      if (!Number.isFinite(dueAt) || dueAt > now.getTime()) {
        continue;
      }
      if (getActiveRunCount() >= MAX_CONCURRENT_RUNS) {
        break;
      }

      const stored = await getStoredJobById(job.id);
      const storedDueAt = stored?.nextRunAt ? new Date(stored.nextRunAt).getTime() : NaN;
      if (!stored || !stored.enabled || stored.running || !Number.isFinite(storedDueAt) || storedDueAt > now.getTime()) {
        continue;
      }

      try {
        const result = startStoredJob(stored, { baseUrl: options.baseUrl, spawn: options.spawn });
        if (result.started) {
          dispatched += 1;
        }
      } catch (err) {
        console.warn(
          '[scheduler] runStoredJob threw for job',
          job.id,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } finally {
    ticking = false;
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

  await recoverInterruptedSchedulerRuns();
  await recomputeAllNextRuns();

  const intervalMs = options.intervalMs ?? TICK_INTERVAL_MS;
  const baseUrl = options.baseUrl;

  const tick = () => {
    void runSchedulerTick({ baseUrl }).catch((err) => {
      console.warn('[scheduler] tick failed:', err instanceof Error ? err.message : err);
    });
  };

  tick();
  tickTimer = setInterval(tick, intervalMs);
  if (typeof tickTimer.unref === 'function') {
    tickTimer.unref();
  }
}

/** Stop tick loop and clear timer (tests / shutdown). */
export function stopSchedulerTickLoop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
