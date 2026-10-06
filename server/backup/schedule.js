/**
 * Scheduled snapshots: a daily or weekly backup into a folder the user chose,
 * rotated to the newest N.
 *
 * Runs on its own light timer rather than as a Scheduler job: Scheduler jobs are
 * headless agent runs that need a model and the CLI, and a snapshot needs
 * neither. Failures go through the Scheduler's notification queue, so a failed
 * snapshot always reaches the bell.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { getMinnowHome } from '../config/home.js';
import { enqueueSchedulerNotification } from '../scheduler/delivery.js';
import { getAppRoot } from '../workspace/root.js';
import { CREDENTIALS_CATEGORY } from './catalog.js';
import { BackupError, backupFileName, createBackup } from './export.js';
import { BACKUP_FILE_EXTENSION, looksLikeBackup } from './format.js';
import { isBackupBusy, startBackupJob } from './jobs.js';
import { fingerprintPlan, planBackup } from './plan.js';
import {
  assertUsableBackupDir,
  readBackupSettings,
  readSchedulePassphrase,
  recordExport,
  snapshotIntervalMs,
  updateScheduleState,
} from './settings.js';

/** Notification row id shared by every snapshot alert. */
export const BACKUP_NOTIFICATION_JOB_ID = 'minnow-backup';

/** Leave startup alone: no scheduled snapshot this soon after the process starts. */
export const BOOT_GRACE_MS = 3 * 60 * 1000;

/** Wait this long before retrying after the first and second failure in a row. */
const RETRY_DELAYS_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000];

const SNAPSHOT_NAME_RE = /^minnow-snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mnbak$/;

/** How often the loop checks whether a snapshot is due. */
export const SCHEDULE_CHECK_INTERVAL_MS = 60 * 1000;

const processStartedAt = Date.now();

/** @type {NodeJS.Timeout | null} */
let loopTimer = null;

/**
 * Scheduled snapshots in a folder, newest first. Only files this feature named
 * and wrote are listed — manual backups in the same folder are never rotated.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listSnapshots(dir) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names.filter((n) => SNAPSHOT_NAME_RE.test(n)).sort().reverse()) {
    const file = path.join(dir, name);
    if (await looksLikeBackup(file)) files.push(file);
  }
  return files;
}

/**
 * Keep the newest `keep` snapshots, delete the rest.
 * @param {string} dir
 * @param {number} keep
 * @returns {Promise<string[]>} removed paths
 */
export async function rotateSnapshots(dir, keep) {
  const removed = [];
  for (const file of (await listSnapshots(dir)).slice(Math.max(1, keep))) {
    try {
      await fsp.rm(file, { force: true });
      removed.push(file);
    } catch {
      /* a snapshot that cannot be removed is retried on the next rotation */
    }
  }
  return removed;
}

/** Drop `.partial` files a crashed snapshot left in the folder. */
async function sweepPartials(dir) {
  try {
    for (const name of await fsp.readdir(dir)) {
      if (name.startsWith('minnow-snapshot-') && name.endsWith(`${BACKUP_FILE_EXTENSION}.partial`)) {
        await fsp.rm(path.join(dir, name), { force: true });
      }
    }
  } catch {
  }
}

/**
 * Take one scheduled snapshot now.
 *
 * @param {{
 *   now?: Date,
 *   force?: boolean,
 *   onProgress?: (progress: { bytes: number, totalBytes: number, files: number, totalFiles: number }) => void,
 * }} [options]
 * `force` skips the unchanged check (the "Back up now" button).
 * @returns {Promise<{ status: 'ok' | 'skipped' | 'failed', file?: string, error?: string, removed?: string[] }>}
 */
export async function runScheduledSnapshot(options = {}) {
  const now = options.now ?? new Date();
  const settings = await readBackupSettings();
  const { schedule, state } = settings;
  const interval = snapshotIntervalMs(schedule.frequency);

  try {
    assertUsableBackupDir(schedule.destDir);
    try {
      await fsp.mkdir(schedule.destDir, { recursive: true });
    } catch (err) {
      // An unplugged drive or a signed-out sync folder, in words rather than an errno.
      throw new BackupError(
        `The snapshot folder is not available: ${schedule.destDir} (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'}).`,
        'dest_unavailable',
      );
    }
    await sweepPartials(schedule.destDir);

    const passphrase = await readSchedulePassphrase();
    const includeCredentials = Boolean(passphrase) && settings.categories.includes(CREDENTIALS_CATEGORY);
    const home = getMinnowHome();
    const plan = await planBackup({ home, categories: settings.categories, includeCredentials });
    const fingerprint = await fingerprintPlan(plan);

    const existing = await listSnapshots(schedule.destDir);
    if (!options.force && fingerprint === state.lastFingerprint && existing.length > 0) {
      await updateScheduleState({
        lastRunAt: now.toISOString(),
        lastSuccessAt: now.toISOString(),
        lastStatus: 'skipped',
        lastError: '',
        failures: 0,
        nextRunAt: new Date(now.getTime() + interval).toISOString(),
      });
      return { status: 'skipped' };
    }

    const outPath = path.join(schedule.destDir, backupFileName('snapshot', now));
    const result = await createBackup({
      home,
      outPath,
      categories: settings.categories,
      passphrase: passphrase || undefined,
      appRoot: getAppRoot(),
      label: 'Scheduled snapshot',
      plan,
      onProgress: options.onProgress,
    });
    const removed = await rotateSnapshots(schedule.destDir, schedule.keep);

    await updateScheduleState({
      lastRunAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      lastStatus: 'ok',
      lastError: '',
      lastFile: result.file,
      lastFingerprint: fingerprint,
      failures: 0,
      nextRunAt: new Date(now.getTime() + interval).toISOString(),
    });
    await recordExport({
      at: now.toISOString(),
      file: result.file,
      archiveBytes: result.archiveBytes,
      encrypted: result.encrypted,
      kind: 'scheduled',
    });
    return { status: 'ok', file: result.file, removed };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failures = state.failures + 1;
    const retryIn = RETRY_DELAYS_MS[failures - 1] ?? interval;
    await updateScheduleState({
      lastRunAt: now.toISOString(),
      lastStatus: 'failed',
      lastError: error,
      failures,
      nextRunAt: new Date(now.getTime() + Math.min(retryIn, interval)).toISOString(),
    }).catch(() => {});
    await enqueueSchedulerNotification({
      jobId: BACKUP_NOTIFICATION_JOB_ID,
      label: 'Backup',
      message: `Scheduled snapshot failed: ${error.slice(0, 240)}`,
    }).catch((notifyErr) => {
      console.warn('[backup] could not queue the failure notification:', notifyErr);
    });
    console.warn('[backup] scheduled snapshot failed:', error);
    return { status: 'failed', error };
  }
}

/**
 * One pass of the loop. Starts a snapshot when one is due and nothing else is
 * running; returns without waiting for it to finish.
 * @param {{ now?: Date, bootGraceMs?: number }} [options]
 * @returns {Promise<{ started: boolean, reason?: string, done?: Promise<unknown> }>}
 */
export async function runBackupScheduleTick(options = {}) {
  const now = options.now ?? new Date();
  const grace = options.bootGraceMs ?? BOOT_GRACE_MS;
  // Wall clock on purpose: the grace period is about this process, not `now`.
  if (Date.now() - processStartedAt < grace) return { started: false, reason: 'boot_grace' };
  if (isBackupBusy()) return { started: false, reason: 'busy' };

  const { schedule, state } = await readBackupSettings();
  if (!schedule.enabled) return { started: false, reason: 'disabled' };
  if (state.nextRunAt && new Date(state.nextRunAt).getTime() > now.getTime()) {
    return { started: false, reason: 'not_due' };
  }

  const { done } = startBackupJob('snapshot', (onProgress) => runScheduledSnapshot({ now, onProgress }));
  return { started: true, done };
}

/**
 * Start checking for due snapshots. Idempotent; the timer never keeps the
 * process alive.
 * @param {{ intervalMs?: number }} [options]
 */
export function startBackupScheduleLoop(options = {}) {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    void runBackupScheduleTick().catch((err) => {
      console.warn('[backup] schedule check failed:', err instanceof Error ? err.message : err);
    });
  }, options.intervalMs ?? SCHEDULE_CHECK_INTERVAL_MS);
  if (typeof loopTimer.unref === 'function') loopTimer.unref();
}

/** Stop the loop (tests / shutdown). */
export function stopBackupScheduleLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}
