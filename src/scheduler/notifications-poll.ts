/**
 * Poll scheduler notifications and surface them via Minnow menubar badges.
 */

import { detectLocalServer } from '../tools/client';
import { isLocalServerAvailable } from '../tools/config';
import {
  ackSchedulerNotification,
  fetchSchedulerJobs,
  fetchSchedulerRuns,
  fetchSchedulerDefaultWorkspace,
  fetchSchedulerNotifications,
} from './client';

const POLL_INTERVAL_MS = 30_000;

/** `jobId` the server uses for scheduled-snapshot alerts (server/backup/schedule.js). */
const BACKUP_NOTIFICATION_JOB_ID = 'minnow-backup';

/** Notification ids already delivered this session (dedupe). */
const deliveredIds = new Set<string>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling: Promise<void> | null = null;

/** Deliver one notification to the settings app badge and ack on the server. */
async function deliverNotification(
  row: Awaited<ReturnType<typeof fetchSchedulerNotifications>>[number],
): Promise<void> {
  if (deliveredIds.has(row.id)) {
    return;
  }
  deliveredIds.add(row.id);

  const { pushNotification } = await import('../notifications/push');
  // Scheduled backup snapshots share this queue; their alerts belong to Settings.
  const fromBackup = row.jobId === BACKUP_NOTIFICATION_JOB_ID;
  pushNotification({
    kind: 'scheduler',
    title: fromBackup ? 'Backup' : row.label,
    activityId: row.runId ? `scheduler:${row.runId}` : undefined,
    jobId: fromBackup ? undefined : row.jobId,
    chatId: row.chatId,
    workspacePath: row.workspacePath,
    activityStatus: row.status === 'failed' || row.status === 'timeout' ? 'failed' : row.status === 'cancelled' ? 'stopped' : 'completed',
    silent: row.silent,
    preview: fromBackup ? row.message : `${row.label}: ${row.message}`,
    appId: fromBackup ? 'settings' : 'scheduler',
    dedupeKey: `scheduler:${row.id}`,
    os: fromBackup,
  });

  try {
    await ackSchedulerNotification(row.id);
  } catch {}
}

/** Single poll pass for unacked scheduler reminders. */
async function pollOnce(): Promise<void> {
  if (!isLocalServerAvailable()) {
    await detectLocalServer(); // recovery probe — only fires when already marked down
    if (!isLocalServerAvailable()) return;
  }

  try {
    const rows = await fetchSchedulerNotifications();
    for (const row of rows) {
      await deliverNotification(row);
    }
  } catch {}
}

/** Capture running jobs alongside queued outcomes without inventing a second runtime. */
async function pollRunningJobs(): Promise<void> {
  if (!isLocalServerAvailable()) return;
  const jobs = await fetchSchedulerJobs();
  const active = jobs.filter((job) => job.running);
  if (!active.length) return;
  const fallback = active.some((job) => !job.workspacePath) ? await fetchSchedulerDefaultWorkspace() : null;
  const { pushNotification } = await import('../notifications/push');
  await Promise.allSettled(active.map(async (job) => {
    const runs = await fetchSchedulerRuns(job.id);
    for (const run of runs.filter((candidate) => candidate.status === 'running')) {
      pushNotification({
        kind: 'scheduler', activityId: `scheduler:${run.id}`, activityStatus: 'running',
        jobId: job.id, chatId: run.chatId, workspacePath: job.workspacePath || fallback?.path,
        title: job.label, preview: 'Running scheduled job', appId: 'scheduler',
        createdAt: Date.parse(run.startedAt), dedupeKey: `scheduler-running:${run.id}`, silent: true,
      });
    }
  }));
}

export function pollSchedulerNotifications(): Promise<void> {
  if (polling) return polling;
  polling = pollOnce().then(() => pollRunningJobs()).catch(() => {}).finally(() => { polling = null; });
  return polling;
}

/** Start background polling while the SPA is open. */
export function startSchedulerNotificationPoll(): void {
  if (pollTimer) {
    return;
  }

  void pollSchedulerNotifications();
  pollTimer = setInterval(() => {
    void pollSchedulerNotifications();
  }, POLL_INTERVAL_MS);
}

/** Stop polling (tests). */
export function stopSchedulerNotificationPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
