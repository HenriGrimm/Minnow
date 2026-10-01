/**
 * `minnow backup` and `minnow restore` — the same engine as Settings → General →
 * Backup and restore, run directly against the Minnow home with no server.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMinnowHome } from '../config/home.js';
import { readDevHostState, isDevHostProcessAlive } from '../runtime/dev-host-state.js';
import { readLiveHost } from '../runtime/host-lock.js';
import {
  BACKUP_CATEGORIES,
  CREDENTIALS_CATEGORY,
  NEVER_BACKED_UP,
  allCategoryIds,
  normalizeCategoryIds,
} from './catalog.js';
import { BackupError, backupFileName, createBackup } from './export.js';
import { BACKUP_FILE_EXTENSION } from './format.js';
import { measureCategories } from './plan.js';
import {
  cancelPendingRestore,
  inspectBackup,
  listBackupsInFolder,
  scheduleRollback,
  stageRestore,
} from './restore.js';
import { applyPendingRestore } from './restore-apply.js';
import { defaultBackupDir, readBackupSettings, recordExport } from './settings.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BACKUP_HELP = `Usage: minnow backup [options]

Write one backup file of the Minnow data folder.

Options:
  --out <path>             Folder or file to write. Default: ${defaultBackupDir()}
  --passphrase-env <VAR>   Encrypt with the passphrase in this environment variable.
                           Required to include credentials and the encryption key.
  --include <ids>          Comma-separated categories to back up (replaces the saved selection)
  --exclude <ids>          Comma-separated categories to leave out
  --list                   Show the categories and their sizes, then exit
  --json                   Print the result as JSON
  -h, --help               Show this help

Without --passphrase-env the backup is not encrypted, and credentials, the
encryption key and scheduled-job prompts are left out of it.
`;

const RESTORE_HELP = `Usage: minnow restore <backup-file | folder> [options]

Restore a backup. The backup is unpacked and verified beside your data first;
existing data is moved to pre-restore/ inside the Minnow data folder, never
overwritten.

Options:
  --passphrase-env <VAR>   Passphrase for an encrypted backup
  --only <ids>             Comma-separated categories to restore (default: all in the backup)
  --yes                    Restore without this command's preview-only stop
  --stage-only             Unpack and verify, but apply at the next Minnow start
  --undo                   Undo the last restore
  --cancel                 Drop a restore that is waiting for a restart
  --json                   Print the result as JSON
  -h, --help               Show this help

Given a folder, the newest backup in it is used. If Minnow is running, the
restore is applied the next time it starts.
`;

/**
 * @param {string[]} argv
 * @param {Set<string>} valueFlags flags that take a value
 */
function parseArgs(argv, valueFlags) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new BackupError(`--${name} needs a value.`, 'usage');
        }
        flags[name] = value;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** @param {string | boolean | undefined} value */
function splitIds(value) {
  if (typeof value !== 'string') return null;
  const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !allCategoryIds().includes(id));
  if (unknown.length) {
    throw new BackupError(
      `Unknown category: ${unknown.join(', ')}. Known: ${allCategoryIds().join(', ')}.`,
      'usage',
    );
  }
  return ids;
}

/** @param {string | boolean | undefined} name */
function readPassphraseEnv(name) {
  if (typeof name !== 'string') return '';
  const value = process.env[name];
  if (!value) {
    throw new BackupError(`Environment variable ${name} is empty or not set.`, 'usage');
  }
  return value;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

async function readAppVersion() {
  try {
    return String(JSON.parse(await fsp.readFile(path.join(APP_ROOT, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/** True when a Minnow host has this home open. */
function minnowIsRunning() {
  if (readLiveHost()) return true;
  const dev = readDevHostState();
  return Boolean(dev && dev.pid !== process.pid && isDevHostProcessAlive(dev));
}

/**
 * @param {string[]} argv
 * @param {{ out?: (text: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function runBackupCli(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const { flags } = parseArgs(argv, new Set(['out', 'passphrase-env', 'include', 'exclude']));
  if (flags.help) {
    out(BACKUP_HELP);
    return 0;
  }

  const home = getMinnowHome();
  if (flags.list) {
    const sizes = new Map((await measureCategories(home)).map((row) => [row.id, row]));
    if (flags.json) {
      out(`${JSON.stringify({ home, categories: BACKUP_CATEGORIES.map((c) => ({ id: c.id, label: c.label, defaultOn: c.defaultOn, ...(sizes.get(c.id) ?? { files: 0, bytes: 0 }) })) }, null, 2)}\n`);
      return 0;
    }
    out(`Minnow data folder: ${home}\n\n`);
    for (const category of BACKUP_CATEGORIES) {
      const row = sizes.get(category.id) ?? { files: 0, bytes: 0 };
      const notes = [
        category.defaultOn ? '' : 'off by default',
        category.requiresPassphrase ? 'needs a passphrase' : '',
      ].filter(Boolean);
      out(
        `  ${category.id.padEnd(12)} ${formatBytes(row.bytes).padStart(9)}  ${category.label}` +
          `${notes.length ? ` (${notes.join(', ')})` : ''}\n`,
      );
    }
    out(`\nNever backed up: ${NEVER_BACKED_UP.join(', ')}\n`);
    return 0;
  }

  const passphrase = readPassphraseEnv(flags['passphrase-env']);
  const stored = await readBackupSettings();
  let categories = splitIds(flags.include) ?? stored.categories;
  const excluded = new Set(splitIds(flags.exclude) ?? []);
  categories = normalizeCategoryIds(categories).filter((id) => !excluded.has(id));

  let outPath = typeof flags.out === 'string' ? path.resolve(flags.out) : defaultBackupDir();
  if (!outPath.toLowerCase().endsWith(BACKUP_FILE_EXTENSION)) {
    outPath = path.join(outPath, backupFileName('backup'));
  }

  const result = await createBackup({
    home,
    outPath,
    categories,
    passphrase: passphrase || undefined,
    appRoot: APP_ROOT,
  });
  await recordExport({
    at: new Date().toISOString(),
    file: result.file,
    archiveBytes: result.archiveBytes,
    encrypted: result.encrypted,
    kind: 'manual',
  });

  if (flags.json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  out(`Backup written: ${result.file}\n`);
  out(`  ${result.files} files, ${formatBytes(result.bytes)} → ${formatBytes(result.archiveBytes)}`);
  out(result.encrypted ? ', encrypted\n' : ', not encrypted\n');
  if (!result.includesCredentials) {
    const wanted = categories.includes(CREDENTIALS_CATEGORY);
    out(
      wanted && !result.encrypted
        ? `  Credentials and the encryption key were left out (${result.credentialsOmitted} files): pass --passphrase-env to include them.\n`
        : '  Credentials and the encryption key are not in this backup.\n',
    );
  }
  return 0;
}

/**
 * @param {string[]} argv
 * @param {{ out?: (text: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function runRestoreCli(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const { flags, positional } = parseArgs(argv, new Set(['passphrase-env', 'only']));
  if (flags.help) {
    out(RESTORE_HELP);
    return 0;
  }

  const home = getMinnowHome();
  const running = minnowIsRunning();
  const finish = (staged) => {
    if (running || flags['stage-only']) {
      return { ...staged, applied: false, restartRequired: true };
    }
    const applied = applyPendingRestore({ home });
    if (!applied.applied) {
      throw new BackupError(
        `The restore is unpacked but could not be applied: ${applied.error ?? 'unknown error'}. ` +
          'Your data is unchanged. It is retried the next time Minnow starts.',
        'apply_failed',
      );
    }
    return { ...staged, applied: true, restartRequired: false };
  };
  const report = (result, done, waiting) => {
    if (flags.json) out(`${JSON.stringify(result, null, 2)}\n`);
    else out(result.applied ? done : waiting);
    return 0;
  };

  if (flags.cancel) {
    const result = await cancelPendingRestore(home);
    out(flags.json ? `${JSON.stringify(result)}\n` : result.cancelled ? 'Pending restore cancelled.\n' : 'Nothing was waiting.\n');
    return 0;
  }

  if (flags.undo) {
    const result = finish(await scheduleRollback(home));
    return report(
      result,
      'Restore undone. Your previous data is back in place.\n',
      'Undo is queued. Restart Minnow to finish.\n',
    );
  }

  if (positional.length !== 1) {
    out(RESTORE_HELP);
    return 2;
  }

  let archivePath = path.resolve(positional[0]);
  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat) throw new BackupError(`Not found: ${archivePath}`, 'not_found');
  if (stat.isDirectory()) {
    const [newest] = await listBackupsInFolder(archivePath);
    if (!newest) throw new BackupError(`No Minnow backups in ${archivePath}`, 'not_found');
    archivePath = newest.file;
  }

  const passphrase = readPassphraseEnv(flags['passphrase-env']);
  const appVersion = await readAppVersion();
  const preview = await inspectBackup({ archivePath, passphrase: passphrase || undefined, appVersion });
  const only = splitIds(flags.only);

  if (!flags.yes) {
    if (flags.json) {
      out(`${JSON.stringify({ preview, restored: false }, null, 2)}\n`);
      return 0;
    }
    out(`Backup: ${preview.file}\n`);
    out(`  Created ${preview.createdAt} by Minnow ${preview.appVersion || 'unknown'}`);
    out(preview.encrypted ? ', encrypted\n' : ', not encrypted\n');
    out(`  ${preview.totals.files} files, ${formatBytes(preview.totals.bytes)} unpacked\n\n`);
    for (const row of preview.categories) {
      const skipped = only && !only.includes(row.id) ? '  (not selected)' : '';
      out(`  ${row.id.padEnd(12)} ${formatBytes(row.bytes).padStart(9)}  ${row.label}${skipped}\n`);
    }
    for (const warning of preview.warnings) out(`\n  ! ${warning}\n`);
    if (preview.encrypted && preview.passphraseOk === false) out('\n  ! That passphrase does not open this backup.\n');
    out(`\nRestoring into: ${home}\nNothing was changed. Run again with --yes to restore.\n`);
    return 0;
  }

  const staged = await stageRestore({
    home,
    archivePath,
    passphrase: passphrase || undefined,
    categories: only ?? undefined,
    appVersion,
  });
  const result = finish(staged);
  if (!flags.json) {
    for (const warning of staged.warnings) out(`! ${warning}\n`);
  }
  return report(
    result,
    `Restored ${staged.files} files (${formatBytes(staged.bytes)}) into ${home}.\n` +
      'Your previous data is in pre-restore/ inside that folder; `minnow restore --undo` puts it back.\n',
    `Backup unpacked and verified (${staged.files} files). ` +
      `${running ? 'Minnow is running: restart' : 'Restart'} Minnow to finish the restore.\n`,
  );
}
