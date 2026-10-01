/**
 * Backup preferences and scheduled-snapshot state in ~/.minnow/backup.json.
 * The snapshot passphrase is sealed with the secret box, like scheduler prompts.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getMinnowHome } from '../config/home.js';
import {
  decryptSecretPayload,
  encryptSecretPayload,
  isEncryptedSecretPayload,
} from '../security/secret-box.js';
import { defaultCategoryIds, normalizeCategoryIds } from './catalog.js';
import { assertUsablePassphrase, BackupError, isPathInside } from './export.js';

export const SNAPSHOT_FREQUENCIES = /** @type {const} */ (['daily', 'weekly']);
export const SNAPSHOT_KEEP_MIN = 1;
export const SNAPSHOT_KEEP_MAX = 60;
export const SNAPSHOT_KEEP_DEFAULT = 7;

const FREQUENCY_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

/** Serialize writes so the tick and the API cannot clobber each other. */
let writeQueue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function backupSettingsPath() {
  return path.join(getMinnowHome(), 'backup.json');
}

/** Where backups go until the user picks a folder. Always outside the Minnow home. */
export function defaultBackupDir() {
  const documents = path.join(os.homedir(), 'Documents');
  const base = fs.existsSync(documents) ? documents : os.homedir();
  return path.join(base, 'Minnow Backups');
}

/** @param {'daily' | 'weekly'} frequency */
export function snapshotIntervalMs(frequency) {
  return FREQUENCY_MS[frequency] ?? FREQUENCY_MS.daily;
}

function defaultSettings() {
  return {
    version: 1,
    categories: defaultCategoryIds(),
    lastDestDir: '',
    schedule: {
      enabled: false,
      frequency: /** @type {'daily' | 'weekly'} */ ('daily'),
      destDir: '',
      keep: SNAPSHOT_KEEP_DEFAULT,
      passphraseEnc: /** @type {object | null} */ (null),
    },
    state: {
      lastRunAt: /** @type {string | null} */ (null),
      lastSuccessAt: /** @type {string | null} */ (null),
      lastStatus: /** @type {'ok' | 'skipped' | 'failed' | null} */ (null),
      lastError: '',
      lastFile: '',
      lastFingerprint: '',
      nextRunAt: /** @type {string | null} */ (null),
      failures: 0,
    },
    lastExport: /** @type {null | { at: string, file: string, archiveBytes: number, encrypted: boolean, kind: 'manual' | 'scheduled' }} */ (null),
  };
}

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} raw
 * @returns {ReturnType<typeof defaultSettings>}
 */
function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!isObject(raw)) return base;
  const input = /** @type {Record<string, any>} */ (raw);
  const schedule = isObject(input.schedule) ? input.schedule : {};
  const state = isObject(input.state) ? input.state : {};
  const keep = Number(schedule.keep);
  return {
    version: 1,
    categories: normalizeCategoryIds(input.categories),
    lastDestDir: typeof input.lastDestDir === 'string' ? input.lastDestDir : '',
    schedule: {
      enabled: schedule.enabled === true,
      frequency: SNAPSHOT_FREQUENCIES.includes(schedule.frequency) ? schedule.frequency : 'daily',
      destDir: typeof schedule.destDir === 'string' ? schedule.destDir : '',
      keep: Number.isInteger(keep)
        ? Math.min(SNAPSHOT_KEEP_MAX, Math.max(SNAPSHOT_KEEP_MIN, keep))
        : SNAPSHOT_KEEP_DEFAULT,
      passphraseEnc: isEncryptedSecretPayload(schedule.passphraseEnc) ? schedule.passphraseEnc : null,
    },
    state: {
      lastRunAt: typeof state.lastRunAt === 'string' ? state.lastRunAt : null,
      lastSuccessAt: typeof state.lastSuccessAt === 'string' ? state.lastSuccessAt : null,
      lastStatus: ['ok', 'skipped', 'failed'].includes(state.lastStatus) ? state.lastStatus : null,
      lastError: typeof state.lastError === 'string' ? state.lastError : '',
      lastFile: typeof state.lastFile === 'string' ? state.lastFile : '',
      lastFingerprint: typeof state.lastFingerprint === 'string' ? state.lastFingerprint : '',
      nextRunAt: typeof state.nextRunAt === 'string' ? state.nextRunAt : null,
      failures: Number.isInteger(state.failures) && state.failures > 0 ? state.failures : 0,
    },
    lastExport:
      isObject(input.lastExport) && typeof input.lastExport.file === 'string'
        ? {
            at: String(input.lastExport.at ?? ''),
            file: input.lastExport.file,
            archiveBytes: Number(input.lastExport.archiveBytes) || 0,
            encrypted: input.lastExport.encrypted === true,
            kind: input.lastExport.kind === 'scheduled' ? 'scheduled' : 'manual',
          }
        : null,
  };
}

async function readUnlocked() {
  try {
    return normalizeSettings(JSON.parse(await fsp.readFile(backupSettingsPath(), 'utf8')));
  } catch {
    return defaultSettings();
  }
}

/** @param {ReturnType<typeof defaultSettings>} settings */
async function writeUnlocked(settings) {
  const filePath = backupSettingsPath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

/** Stored settings, including the sealed passphrase. Server-side callers only. */
export function readBackupSettings() {
  return readUnlocked();
}

/**
 * Settings as the UI sees them: the passphrase becomes a flag.
 * @param {ReturnType<typeof defaultSettings>} settings
 */
export function toPublicBackupSettings(settings) {
  const { passphraseEnc, ...schedule } = settings.schedule;
  return {
    categories: settings.categories,
    lastDestDir: settings.lastDestDir,
    schedule: { ...schedule, hasPassphrase: Boolean(passphraseEnc) },
    state: settings.state,
    lastExport: settings.lastExport,
  };
}

/**
 * Throw unless `dir` is an absolute folder path outside the Minnow home.
 * @param {string} dir
 */
export function assertUsableBackupDir(dir) {
  if (!dir || !path.isAbsolute(dir)) {
    throw new BackupError('Choose a folder for backups.', 'bad_dest');
  }
  if (isPathInside(getMinnowHome(), dir)) {
    throw new BackupError(
      'Choose a folder outside the Minnow data folder. A backup stored beside the data it protects is lost with it.',
      'dest_inside_home',
    );
  }
}

/**
 * Apply a settings change from the UI or CLI.
 * `passphrase`: a string sets it, `null` clears it, `undefined` leaves it.
 * @param {{
 *   categories?: string[],
 *   lastDestDir?: string,
 *   schedule?: { enabled?: boolean, frequency?: string, destDir?: string, keep?: number, passphrase?: string | null },
 * }} patch
 * @param {{ now?: Date }} [options]
 */
export function updateBackupSettings(patch, options = {}) {
  return withWriteLock(async () => {
    const now = options.now ?? new Date();
    const settings = await readUnlocked();

    if (patch.categories !== undefined) {
      const next = normalizeCategoryIds(patch.categories, []);
      if (next.length === 0) {
        throw new BackupError('Choose at least one thing to back up.', 'empty');
      }
      settings.categories = next;
    }
    if (typeof patch.lastDestDir === 'string') settings.lastDestDir = patch.lastDestDir;

    const schedule = patch.schedule;
    if (schedule) {
      if (schedule.frequency !== undefined) {
        if (!SNAPSHOT_FREQUENCIES.includes(/** @type {any} */ (schedule.frequency))) {
          throw new BackupError('Snapshots run daily or weekly.', 'bad_schedule');
        }
        settings.schedule.frequency = /** @type {'daily' | 'weekly'} */ (schedule.frequency);
      }
      if (schedule.keep !== undefined) {
        const keep = Number(schedule.keep);
        if (!Number.isInteger(keep) || keep < SNAPSHOT_KEEP_MIN || keep > SNAPSHOT_KEEP_MAX) {
          throw new BackupError(
            `Keep between ${SNAPSHOT_KEEP_MIN} and ${SNAPSHOT_KEEP_MAX} snapshots.`,
            'bad_schedule',
          );
        }
        settings.schedule.keep = keep;
      }
      if (schedule.destDir !== undefined) {
        const dir = String(schedule.destDir).trim();
        if (dir) assertUsableBackupDir(dir);
        settings.schedule.destDir = dir ? path.resolve(dir) : '';
      }
      if (schedule.passphrase === null) {
        settings.schedule.passphraseEnc = null;
      } else if (typeof schedule.passphrase === 'string') {
        assertUsablePassphrase(schedule.passphrase);
        settings.schedule.passphraseEnc = await encryptSecretPayload(schedule.passphrase);
      }
      if (schedule.enabled !== undefined) {
        const enabling = schedule.enabled === true && !settings.schedule.enabled;
        settings.schedule.enabled = schedule.enabled === true;
        if (enabling) {
          // Take the first snapshot soon rather than a full interval from now.
          settings.state.nextRunAt = now.toISOString();
          settings.state.failures = 0;
        }
      }
      if (settings.schedule.enabled && !settings.schedule.destDir) {
        throw new BackupError('Choose a folder for scheduled snapshots first.', 'bad_dest');
      }
    }

    await writeUnlocked(settings);
    return settings;
  });
}

/** The snapshot passphrase in the clear, or '' when none is saved. */
export async function readSchedulePassphrase() {
  const settings = await readUnlocked();
  if (!settings.schedule.passphraseEnc) return '';
  return decryptSecretPayload(settings.schedule.passphraseEnc);
}

/**
 * @param {Partial<ReturnType<typeof defaultSettings>['state']>} patch
 */
export function updateScheduleState(patch) {
  return withWriteLock(async () => {
    const settings = await readUnlocked();
    settings.state = { ...settings.state, ...patch };
    await writeUnlocked(settings);
    return settings;
  });
}

/**
 * @param {{ at: string, file: string, archiveBytes: number, encrypted: boolean, kind: 'manual' | 'scheduled' }} entry
 */
export function recordExport(entry) {
  return withWriteLock(async () => {
    const settings = await readUnlocked();
    settings.lastExport = entry;
    if (entry.kind === 'manual') settings.lastDestDir = path.dirname(entry.file);
    await writeUnlocked(settings);
    return settings;
  });
}
