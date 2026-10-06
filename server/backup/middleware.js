/**
 * Backup & restore REST API (/api/backup/*).
 *
 * Host session only: these routes read the whole home, write to any folder the
 * user names, and can replace the profile, so a paired LAN device token is never
 * enough.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { getMinnowHome } from '../config/home.js';
import { getAppRoot, isAppRootPackaged } from '../workspace/root.js';
import { BACKUP_CATEGORIES, CREDENTIALS_CATEGORY, normalizeCategoryIds } from './catalog.js';
import { BackupError, backupFileName, createBackup } from './export.js';
import { BACKUP_FILE_EXTENSION, BackupFormatError, MIN_PASSPHRASE_LENGTH } from './format.js';
import { getBackupJob, getRunningBackupJob, startBackupJob } from './jobs.js';
import { measureCategories } from './plan.js';
import {
  cancelPendingRestore,
  describeRestoreState,
  discardPreRestoreData,
  inspectBackup,
  listBackupsInFolder,
  retryPendingRestore,
  scheduleRollback,
  stageRestore,
} from './restore.js';
import { runScheduledSnapshot } from './schedule.js';
import {
  SNAPSHOT_KEEP_MAX,
  SNAPSHOT_KEEP_MIN,
  assertUsableBackupDir,
  defaultBackupDir,
  readBackupSettings,
  recordExport,
  toPublicBackupSettings,
  updateBackupSettings,
} from './settings.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new BackupError('Request body too large', 'bad_request'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new BackupError('Invalid JSON body', 'bad_request'));
      }
    });
    req.on('error', reject);
  });
}

/** Cached once per process: the version never changes while running. */
let appVersionPromise = null;

function readAppVersion() {
  appVersionPromise ??= fsp
    .readFile(path.join(getAppRoot(), 'package.json'), 'utf8')
    .then((raw) => String(JSON.parse(raw).version ?? ''))
    .catch(() => '');
  return appVersionPromise;
}

/** @param {import('./jobs.js').BackupJob | null} job */
function toPublicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
    errorCode: job.errorCode,
  };
}

/**
 * Resolve a user-supplied path to a backup file: either the file itself or a
 * folder, in which case its newest backup is meant.
 * @param {unknown} input
 */
async function resolveArchivePath(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || !path.isAbsolute(raw)) {
    throw new BackupError('Enter the full path of a backup file.', 'bad_request');
  }
  let stat;
  try {
    stat = await fsp.stat(raw);
  } catch {
    throw new BackupError('That backup file was not found.', 'not_found');
  }
  if (!stat.isDirectory()) return raw;
  const [newest] = await listBackupsInFolder(raw);
  if (!newest) throw new BackupError('That folder has no Minnow backups in it.', 'not_found');
  return newest.file;
}

async function buildStatus() {
  const home = getMinnowHome();
  const [settings, restore] = await Promise.all([readBackupSettings(), describeRestoreState(home)]);
  return {
    home,
    // Only the installed app owns its server, so only it can restart in place.
    packaged: isAppRootPackaged(),
    defaultDir: defaultBackupDir(),
    fileExtension: BACKUP_FILE_EXTENSION,
    minPassphraseLength: MIN_PASSPHRASE_LENGTH,
    keepRange: { min: SNAPSHOT_KEEP_MIN, max: SNAPSHOT_KEEP_MAX },
    credentialsCategory: CREDENTIALS_CATEGORY,
    categories: BACKUP_CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      defaultOn: category.defaultOn,
      requiresPassphrase: category.requiresPassphrase === true,
    })),
    settings: toPublicBackupSettings(settings),
    restore,
    job: toPublicJob(getRunningBackupJob()),
  };
}

/** @param {unknown} err */
function errorStatus(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;
  if (code === 'busy' || code === 'restore_pending') return 409;
  if (code === 'not_found') return 404;
  if (err instanceof BackupError || err instanceof BackupFormatError) return 400;
  return 500;
}

export function createBackupMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/backup')) {
      next();
      return;
    }
    if (req.minnowAuth?.kind !== 'host') {
      sendJson(res, 403, { error: 'Host session required' });
      return;
    }

    try {
      const home = getMinnowHome();

      if (url === '/api/backup/status' && req.method === 'GET') {
        sendJson(res, 200, await buildStatus());
        return;
      }

      // Walks every category, so it is separate from the status the page polls.
      if (url === '/api/backup/sizes' && req.method === 'GET') {
        sendJson(res, 200, { categories: await measureCategories(home) });
        return;
      }

      if (url === '/api/backup/settings' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const settings = await updateBackupSettings({
          categories: body.categories,
          schedule: body.schedule,
        });
        sendJson(res, 200, { settings: toPublicBackupSettings(settings) });
        return;
      }

      if (url === '/api/backup/export' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const destDir = typeof body.destDir === 'string' ? body.destDir.trim() : '';
        assertUsableBackupDir(destDir);
        const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
        const stored = await readBackupSettings();
        const categories = normalizeCategoryIds(body.categories, stored.categories);
        const outPath = path.join(path.resolve(destDir), backupFileName('backup'));
        const { job } = startBackupJob('export', async (onProgress) => {
          const result = await createBackup({
            home,
            outPath,
            categories,
            passphrase: passphrase || undefined,
            appRoot: getAppRoot(),
            onProgress,
          });
          await recordExport({
            at: new Date().toISOString(),
            file: result.file,
            archiveBytes: result.archiveBytes,
            encrypted: result.encrypted,
            kind: 'manual',
          });
          return result;
        });
        sendJson(res, 202, { job: toPublicJob(job) });
        return;
      }

      if (url === '/api/backup/snapshot' && req.method === 'POST') {
        const { job } = startBackupJob('snapshot', (onProgress) =>
          runScheduledSnapshot({ force: true, onProgress }).then((result) => {
            if (result.status === 'failed') throw new BackupError(result.error ?? 'Snapshot failed');
            return result;
          }),
        );
        sendJson(res, 202, { job: toPublicJob(job) });
        return;
      }

      const jobMatch = url.match(/^\/api\/backup\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === 'GET') {
        const job = getBackupJob(decodeURIComponent(jobMatch[1]));
        if (!job) {
          sendJson(res, 404, { error: 'Job not found' });
          return;
        }
        sendJson(res, 200, { job: toPublicJob(job) });
        return;
      }

      if (url === '/api/backup/list' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
        if (!dir || !path.isAbsolute(dir)) {
          throw new BackupError('Choose a folder to look in.', 'bad_request');
        }
        sendJson(res, 200, { dir, backups: await listBackupsInFolder(dir) });
        return;
      }

      if (url === '/api/backup/inspect' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const archivePath = await resolveArchivePath(body.path);
        const preview = await inspectBackup({
          archivePath,
          passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined,
          appVersion: await readAppVersion(),
        });
        sendJson(res, 200, { backup: preview });
        return;
      }

      if (url === '/api/backup/restore' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const archivePath = await resolveArchivePath(body.path);
        const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
        const categories = Array.isArray(body.categories) ? body.categories.map(String) : undefined;
        const appVersion = await readAppVersion();
        const { job } = startBackupJob('restore', (onProgress) =>
          stageRestore({ home, archivePath, passphrase, categories, appVersion, onProgress }),
        );
        sendJson(res, 202, { job: toPublicJob(job) });
        return;
      }

      if (url === '/api/backup/restore/cancel' && req.method === 'POST') {
        sendJson(res, 200, await cancelPendingRestore(home));
        return;
      }

      if (url === '/api/backup/restore/retry' && req.method === 'POST') {
        sendJson(res, 200, await retryPendingRestore(home));
        return;
      }

      if (url === '/api/backup/restore/undo' && req.method === 'POST') {
        sendJson(res, 200, await scheduleRollback(home));
        return;
      }

      if (url === '/api/backup/restore/discard-previous' && req.method === 'POST') {
        sendJson(res, 200, await discardPreRestoreData(home));
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /** @type {{ code?: unknown }} */ (err)?.code;
      sendJson(res, errorStatus(err), { error: message, code: typeof code === 'string' ? code : undefined });
    }
  };
}
