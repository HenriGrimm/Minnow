/**
 * One backup operation at a time, with progress the UI can poll.
 *
 * Exporting and staging a restore both walk large parts of the home; running
 * two at once would double the disk load and let a restore stage data an
 * export is still reading.
 */

import { randomUUID } from 'node:crypto';

import { BackupError } from './export.js';

/**
 * @typedef {{
 *   id: string,
 *   kind: 'export' | 'snapshot' | 'restore',
 *   status: 'running' | 'done' | 'failed',
 *   startedAt: string,
 *   finishedAt: string | null,
 *   progress: { bytes: number, totalBytes: number, files: number, totalFiles: number },
 *   result: unknown,
 *   error: string,
 *   errorCode: string,
 * }} BackupJob
 */

/** @type {BackupJob | null} */
let current = null;

/** Finished jobs kept long enough for the UI to read their outcome. */
const RECENT_LIMIT = 8;
/** @type {Map<string, BackupJob>} */
const recent = new Map();

/** @param {BackupJob} job */
function remember(job) {
  recent.set(job.id, job);
  while (recent.size > RECENT_LIMIT) {
    recent.delete(/** @type {string} */ (recent.keys().next().value));
  }
}

export function isBackupBusy() {
  return current !== null;
}

/** @returns {BackupJob | null} */
export function getRunningBackupJob() {
  return current;
}

/**
 * @param {string} id
 * @returns {BackupJob | null}
 */
export function getBackupJob(id) {
  if (current?.id === id) return current;
  return recent.get(id) ?? null;
}

/**
 * Start a job and return immediately; the caller polls it by id.
 * @param {BackupJob['kind']} kind
 * @param {(onProgress: (progress: BackupJob['progress']) => void) => Promise<unknown>} run
 * @returns {{ job: BackupJob, done: Promise<BackupJob> }}
 */
export function startBackupJob(kind, run) {
  if (current) {
    throw new BackupError('Another backup or restore is still running.', 'busy');
  }
  /** @type {BackupJob} */
  const job = {
    id: randomUUID(),
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { bytes: 0, totalBytes: 0, files: 0, totalFiles: 0 },
    result: null,
    error: '',
    errorCode: '',
  };
  current = job;

  const done = (async () => {
    try {
      job.result = await run((progress) => {
        job.progress = progress;
      });
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.errorCode = String(/** @type {{ code?: unknown }} */ (err)?.code ?? 'error');
    } finally {
      job.finishedAt = new Date().toISOString();
      current = null;
      remember(job);
    }
    return job;
  })();

  return { job, done };
}

/** Reset job state (tests only). */
export function resetBackupJobsForTests() {
  current = null;
  recent.clear();
}
