/**
 * `minnow backup` / `minnow restore` — argument handling, the preview-only
 * default, and applying versus deferring when a Minnow host is running.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import { runBackupCli, runRestoreCli } from '../../server/backup/cli.js';
import { readPendingRestore } from '../../server/backup/restore-apply.js';
import {
  CHAT_MESSAGE,
  PASSPHRASE,
  PROVIDER_SECRET,
  cleanupTempDirs,
  homeHas,
  makeTempDir,
  readAllEntries,
  readChats,
  readProviderSecret,
  seedHome,
  useHome,
  writeHomeFile,
} from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

after(() => {
  delete process.env.MINNOW_TEST_BACKUP_PASSPHRASE;
  return cleanupTempDirs();
});

/** Run a CLI entry point and capture what it printed. */
async function run(fn, argv) {
  let output = '';
  const code = await fn(argv, { out: (text) => (output += text) });
  return { code, output };
}

async function backupFilesIn(dir) {
  return (await fs.readdir(dir)).filter((name) => name.endsWith('.mnbak'));
}

describe('minnow backup', () => {
  test('writes an encrypted backup with the passphrase from the environment', async () => {
    const home = await seedHome(await makeTempDir('cli-home'));
    const dest = await makeTempDir('cli-dest');
    process.env.MINNOW_TEST_BACKUP_PASSPHRASE = PASSPHRASE;

    const { code, output } = await run(runBackupCli, [
      '--out',
      dest,
      '--passphrase-env',
      'MINNOW_TEST_BACKUP_PASSPHRASE',
    ]);
    assert.equal(code, 0);
    assert.match(output, /Backup written: .*minnow-backup-.*\.mnbak/);
    assert.match(output, /, encrypted/);
    assert.equal(output.includes(PASSPHRASE), false);

    const [name] = await backupFilesIn(dest);
    const { entries } = await readAllEntries(path.join(dest, name), PASSPHRASE);
    assert.ok(entries.has('.key'));
    assert.ok(entries.has('sessions/sessions.db'));
    void home;
  });

  test('without a passphrase it says credentials were left out', async () => {
    await seedHome(await makeTempDir('cli-home'));
    const out = path.join(await makeTempDir('cli-dest'), 'named.mnbak');
    const { output } = await run(runBackupCli, ['--out', out]);
    assert.match(output, /not encrypted/);
    assert.match(output, /Credentials and the encryption key were left out \(2 files\): pass --passphrase-env/);
    const { entries } = await readAllEntries(out);
    assert.equal(entries.has('.key'), false);
  });

  test('--include and --exclude narrow what is written', async () => {
    await seedHome(await makeTempDir('cli-home'));
    const out = path.join(await makeTempDir('cli-dest'), 'narrow.mnbak');
    await run(runBackupCli, ['--out', out, '--include', 'issues,brain,chats', '--exclude', 'chats', '--json']);
    const { header } = await readAllEntries(out);
    assert.deepEqual(header.categories.map((row) => row.id), ['brain', 'issues']);
  });

  test('--list reports sizes without writing anything', async () => {
    await seedHome(await makeTempDir('cli-home'));
    const { code, output } = await run(runBackupCli, ['--list']);
    assert.equal(code, 0);
    assert.match(output, /chats\s+[\d.]+ (B|KB|MB)\s+Chats and usage history/);
    assert.match(output, /models\s+0 B\s+Downloaded models \(off by default\)/);
    assert.match(output, /Never backed up: .*logs.*worktrees/);
  });

  test('rejects an unknown category and an unset passphrase variable', async () => {
    await seedHome(await makeTempDir('cli-home'));
    await assert.rejects(() => run(runBackupCli, ['--include', 'emails']), /Unknown category: emails/);
    await assert.rejects(
      () => run(runBackupCli, ['--passphrase-env', 'MINNOW_TEST_UNSET_VARIABLE']),
      /MINNOW_TEST_UNSET_VARIABLE is empty or not set/,
    );
  });

  test('refuses a destination inside the Minnow home', async () => {
    const home = await seedHome(await makeTempDir('cli-home'));
    await assert.rejects(
      () => run(runBackupCli, ['--out', path.join(home, 'backups')]),
      /outside the Minnow data folder/,
    );
  });
});

describe('minnow restore', () => {
  async function backedUpHome() {
    await seedHome(await makeTempDir('cli-src'));
    const dest = await makeTempDir('cli-dest');
    process.env.MINNOW_TEST_BACKUP_PASSPHRASE = PASSPHRASE;
    await run(runBackupCli, ['--out', dest, '--passphrase-env', 'MINNOW_TEST_BACKUP_PASSPHRASE']);
    return dest;
  }

  test('previews by default and changes nothing', async () => {
    const dest = await backedUpHome();
    const target = await makeTempDir('cli-dst');
    useHome(target);

    const { code, output } = await run(runRestoreCli, [dest]);
    assert.equal(code, 0);
    assert.match(output, /encrypted/);
    assert.match(output, /chats\s+.*Chats and usage history/);
    assert.match(output, /Nothing was changed\. Run again with --yes to restore\./);
    assert.deepEqual(await fs.readdir(target), []);
  });

  test('--yes restores into an empty home and applies at once when Minnow is not running', async () => {
    const dest = await backedUpHome();
    const target = await makeTempDir('cli-dst');
    useHome(target);

    const { code, output } = await run(runRestoreCli, [
      dest,
      '--yes',
      '--passphrase-env',
      'MINNOW_TEST_BACKUP_PASSPHRASE',
    ]);
    assert.equal(code, 0);
    assert.match(output, /Restored \d+ files/);
    assert.equal(readPendingRestore(target), null);
    assert.equal(readChats(target)[0].messages[0], CHAT_MESSAGE);
    assert.equal(await readProviderSecret(target), PROVIDER_SECRET);
  });

  test('defers to the next start when a Minnow host has the home open', async () => {
    const dest = await backedUpHome();
    const target = await makeTempDir('cli-dst');
    useHome(target);
    // A live host: any other running process will do for the pid check.
    await writeHomeFile(
      target,
      'run/host.json',
      JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }),
    );

    const { output } = await run(runRestoreCli, [
      dest,
      '--yes',
      '--passphrase-env',
      'MINNOW_TEST_BACKUP_PASSPHRASE',
    ]);
    assert.match(output, /Minnow is running: restart Minnow to finish the restore/);
    assert.equal(readPendingRestore(target).kind, 'restore');
    assert.equal(await homeHas(target, 'sessions/sessions.db'), false);

    const cancelled = await run(runRestoreCli, ['--cancel']);
    assert.match(cancelled.output, /Pending restore cancelled/);
    assert.equal(readPendingRestore(target), null);
  });

  test('--only restores a subset and --undo puts the previous data back', async () => {
    const dest = await backedUpHome();
    const target = await makeTempDir('cli-dst');
    useHome(target);
    await writeHomeFile(target, 'issues/state.json', '{"version":3,"issues":[]}');

    await run(runRestoreCli, [dest, '--yes', '--only', 'issues', '--passphrase-env', 'MINNOW_TEST_BACKUP_PASSPHRASE']);
    assert.match(await fs.readFile(path.join(target, 'issues', 'state.json'), 'utf8'), /harbour log/);
    assert.equal(await homeHas(target, 'sessions/sessions.db'), false);

    const undone = await run(runRestoreCli, ['--undo']);
    assert.match(undone.output, /Restore undone/);
    assert.equal(await fs.readFile(path.join(target, 'issues', 'state.json'), 'utf8'), '{"version":3,"issues":[]}');
  });

  test('a wrong passphrase fails before anything is staged', async () => {
    const dest = await backedUpHome();
    const target = await makeTempDir('cli-dst');
    useHome(target);
    process.env.MINNOW_TEST_BACKUP_PASSPHRASE = 'not the passphrase';
    await assert.rejects(
      () => run(runRestoreCli, [dest, '--yes', '--passphrase-env', 'MINNOW_TEST_BACKUP_PASSPHRASE']),
      /Wrong passphrase/,
    );
    assert.equal(readPendingRestore(target), null);
    assert.equal(await homeHas(target, 'restore-staging'), false);
  });
});

describe('bin/minnow.mjs', () => {
  test('routes backup and restore, and reports failures with a non-zero exit', async () => {
    const home = await seedHome(await makeTempDir('cli-home'));
    const out = path.join(await makeTempDir('cli-dest'), 'bin.mnbak');
    const bin = path.join(REPO_ROOT, 'bin', 'minnow.mjs');
    const env = { ...process.env, MINNOW_HOME: home };

    const ok = spawnSync(process.execPath, [bin, 'backup', '--out', out, '--include', 'issues'], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Backup written/);

    const help = spawnSync(process.execPath, [bin, 'restore', '--help'], { env, encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: minnow restore/);

    const bad = spawnSync(process.execPath, [bin, 'restore', path.join(home, 'missing.mnbak')], { env, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /minnow restore: Not found/);
  });
});
