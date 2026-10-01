/**
 * The boot-time swap: nothing is overwritten, a failure unwinds to the home that
 * was there, and a restore can be undone or cancelled.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { createBackup } from '../../server/backup/export.js';
import {
  cancelPendingRestore,
  describeRestoreState,
  discardPreRestoreData,
  retryPendingRestore,
  scheduleRollback,
  stageRestore,
} from '../../server/backup/restore.js';
import {
  MAX_APPLY_ATTEMPTS,
  applyPendingRestore,
  readLastRestore,
  readPendingRestore,
} from '../../server/backup/restore-apply.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { writeWholeSessionState } from '../../server/config/sessions-repo.js';
import {
  CHAT_ID,
  CHAT_MESSAGE,
  FAST_KDF,
  JOB_PROMPT,
  PASSPHRASE,
  PROVIDER_SECRET,
  cleanupTempDirs,
  homeHas,
  makeChat,
  makeState,
  makeTempDir,
  readChats,
  readHomeFile,
  readJobs,
  readProviderSecret,
  seedHome,
  useHome,
  writeHomeFile,
} from './helpers.mjs';

after(cleanupTempDirs);

const LATER_CHAT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A home, a backup of it, and then changes made after the backup. */
async function homeWithOlderBackup(options = {}) {
  const home = await seedHome(await makeTempDir('apply-home'));
  const out = path.join(await makeTempDir('apply-out'), 'backup.mnbak');
  await createBackup({ home, outPath: out, passphrase: options.passphrase, kdf: FAST_KDF });

  useHome(home);
  writeWholeSessionState(
    makeState([
      makeChat(CHAT_ID, 'Tide tables', [CHAT_MESSAGE]),
      makeChat(LATER_CHAT_ID, 'Later chat', ['Written after the backup']),
    ]),
  );
  closeSessionsDb();
  await writeHomeFile(home, 'brain/pages/facts/later.md', '# Later\n');
  return { home, out };
}

describe('staging', () => {
  test('changes nothing in the live home until the swap', async () => {
    const { home, out } = await homeWithOlderBackup();
    const staged = await stageRestore({ home, archivePath: out });

    assert.equal(readChats(home).length, 2, 'the live chats are still the current ones');
    assert.equal(await homeHas(home, 'brain/pages/facts/later.md'), true);
    const pending = readPendingRestore(home);
    assert.equal(pending.id, staged.id);
    assert.equal(pending.kind, 'restore');

    const state = await describeRestoreState(home);
    assert.equal(state.pending.id, staged.id);
    assert.equal(state.last, null);
  });

  test('a second restore is refused while one is waiting', async () => {
    const { home, out } = await homeWithOlderBackup();
    await stageRestore({ home, archivePath: out });
    await assert.rejects(() => stageRestore({ home, archivePath: out }), /already waiting for a restart/);
  });

  test('cancelling removes the staged copy and the marker', async () => {
    const { home, out } = await homeWithOlderBackup();
    await stageRestore({ home, archivePath: out });
    assert.deepEqual(await cancelPendingRestore(home), { cancelled: true, kind: 'restore' });
    assert.equal(readPendingRestore(home), null);
    assert.equal(await homeHas(home, 'restore-staging'), false);
    assert.equal(applyPendingRestore({ home }).applied, false);
    assert.equal(readChats(home).length, 2);
  });
});

describe('applying', () => {
  test('moves the previous data aside instead of overwriting it', async () => {
    const { home, out } = await homeWithOlderBackup();
    const staged = await stageRestore({ home, archivePath: out });
    assert.deepEqual(applyPendingRestore({ home }), { applied: true, kind: 'restore', id: staged.id });

    assert.deepEqual(readChats(home).map((chat) => chat.name), ['Tide tables']);
    assert.equal(await homeHas(home, 'brain/pages/facts/later.md'), false);

    const parked = path.join(home, 'pre-restore', staged.id);
    assert.equal(await homeHas(parked, 'sessions/sessions.db'), true, 'the replaced chats are kept');
    assert.equal(await homeHas(parked, 'brain/pages/facts/later.md'), true);
    assert.equal(await homeHas(home, 'restore-staging'), false, 'staging is cleaned up');

    const last = readLastRestore(home);
    assert.equal(last.id, staged.id);
    assert.equal(last.rolledBackAt, null);
    const state = await describeRestoreState(home);
    assert.equal(state.last.canUndo, true);
    assert.ok(state.last.previousDataBytes > 0);
  });

  test('is a no-op when nothing is pending', async () => {
    const home = await makeTempDir('apply-empty');
    assert.deepEqual(applyPendingRestore({ home }), { applied: false });
  });

  test('a failure half-way puts every folder back and records the error', async () => {
    const { home, out } = await homeWithOlderBackup();
    const staged = await stageRestore({ home, archivePath: out });

    // Make one swap impossible: the parking spot for `issues` is already a
    // non-empty folder, so renaming the live folder onto it fails after earlier
    // roots have already been swapped.
    const blocker = path.join(home, 'pre-restore', staged.id, 'issues', 'in-the-way');
    await fs.mkdir(blocker, { recursive: true });
    await fs.writeFile(path.join(blocker, 'file'), 'x');

    const result = applyPendingRestore({ home });
    assert.equal(result.applied, false);
    assert.ok(result.error);

    assert.equal(readChats(home).length, 2, 'chats swapped before the failure are back');
    assert.equal(await homeHas(home, 'brain/pages/facts/later.md'), true);
    assert.match(await readHomeFile(home, 'issues/state.json'), /harbour log/);
    assert.equal(readLastRestore(home), null);

    const pending = readPendingRestore(home);
    assert.equal(pending.attempts, 1);
    assert.equal(pending.failed, false);
    assert.equal(pending.lastError, result.error);
    assert.equal(await homeHas(home, `restore-staging/${staged.id}/tree/sessions/sessions.db`), true);

    // Clear the obstacle: the same pending restore goes through on the next start.
    await fs.rm(path.join(home, 'pre-restore'), { recursive: true, force: true });
    assert.equal(applyPendingRestore({ home }).applied, true);
    assert.deepEqual(readChats(home).map((chat) => chat.name), ['Tide tables']);
  });

  test('stops retrying after repeated failures, and can be retried by hand', async () => {
    const { home, out } = await homeWithOlderBackup();
    const staged = await stageRestore({ home, archivePath: out });
    const blocker = path.join(home, 'pre-restore', staged.id, 'issues', 'in-the-way');
    await fs.mkdir(blocker, { recursive: true });
    await fs.writeFile(path.join(blocker, 'file'), 'x');

    for (let attempt = 1; attempt <= MAX_APPLY_ATTEMPTS; attempt += 1) {
      assert.equal(applyPendingRestore({ home }).applied, false);
    }
    assert.equal(readPendingRestore(home).failed, true);
    assert.deepEqual(applyPendingRestore({ home }), { applied: false }, 'a failed restore is left alone');
    assert.equal((await describeRestoreState(home)).pending.failed, true);

    await fs.rm(path.join(home, 'pre-restore'), { recursive: true, force: true });
    await retryPendingRestore(home);
    assert.equal(applyPendingRestore({ home }).applied, true);
  });
});

describe('undoing', () => {
  test('puts the previous data back and removes the parked copy', async () => {
    const { home, out } = await homeWithOlderBackup();
    const staged = await stageRestore({ home, archivePath: out });
    applyPendingRestore({ home });
    assert.equal(readChats(home).length, 1);

    assert.deepEqual(await scheduleRollback(home), { id: staged.id, restartRequired: true });
    assert.equal(readChats(home).length, 1, 'nothing moves until the next start');
    assert.deepEqual(applyPendingRestore({ home }), { applied: true, kind: 'rollback', id: staged.id });

    assert.deepEqual(readChats(home).map((chat) => chat.name).sort(), ['Later chat', 'Tide tables']);
    assert.equal(await homeHas(home, 'brain/pages/facts/later.md'), true);
    assert.equal(await readHomeFile(home, 'brain/code/index.db'), 'regenerable code index');
    assert.equal(await readProviderSecret(home), PROVIDER_SECRET);
    assert.equal(await homeHas(home, 'pre-restore'), false);

    const state = await describeRestoreState(home);
    assert.equal(state.last.canUndo, false);
    assert.ok(state.last.rolledBackAt);
    await assert.rejects(() => scheduleRollback(home), /no restore to undo/);
  });

  test('removes what a restore created in an empty home', async () => {
    const source = await seedHome(await makeTempDir('apply-src'));
    const out = path.join(await makeTempDir('apply-out'), 'backup.mnbak');
    await createBackup({ home: source, outPath: out, categories: ['issues', 'brain'] });

    const target = await makeTempDir('apply-dst');
    await writeHomeFile(target, 'brain/pages/facts/mine.md', '# Mine\n');
    await stageRestore({ home: target, archivePath: out });
    applyPendingRestore({ home: target });
    assert.equal(await homeHas(target, 'issues/state.json'), true);

    await scheduleRollback(target);
    assert.equal(applyPendingRestore({ home: target }).applied, true);
    assert.equal(await homeHas(target, 'issues'), false, 'a folder the restore created is taken back out');
    assert.equal(await readHomeFile(target, 'brain/pages/facts/mine.md'), '# Mine\n');
  });

  test('discarding the previous data makes undo unavailable', async () => {
    const { home, out } = await homeWithOlderBackup();
    await stageRestore({ home, archivePath: out });
    applyPendingRestore({ home });

    assert.deepEqual(await discardPreRestoreData(home), { removed: true });
    assert.equal(await homeHas(home, 'pre-restore'), false);
    assert.equal((await describeRestoreState(home)).last.canUndo, false);
    await assert.rejects(() => scheduleRollback(home), /no restore to undo/);
    assert.deepEqual(readChats(home).map((chat) => chat.name), ['Tide tables'], 'the restored data stays');
  });
});

describe('a second restore', () => {
  test('warns that the earlier set-aside data goes, and removes it when applied', async () => {
    const { home, out } = await homeWithOlderBackup();
    const first = await stageRestore({ home, archivePath: out });
    applyPendingRestore({ home });
    assert.equal(await homeHas(home, `pre-restore/${first.id}`), true);

    const second = await stageRestore({ home, archivePath: out });
    assert.ok(second.warnings.some((warning) => /previous restore is deleted when this one is applied/.test(warning)));
    assert.equal(await homeHas(home, `pre-restore/${first.id}`), true, 'still there until the swap');

    assert.equal(applyPendingRestore({ home }).applied, true);
    assert.equal(await homeHas(home, `pre-restore/${first.id}`), false);
    assert.equal(await homeHas(home, `pre-restore/${second.id}`), true);
    assert.equal((await describeRestoreState(home)).last.id, second.id);
  });
});

describe('a backup with a different encryption key', () => {
  test('says nothing on a fresh install, where no file is sealed with the local key', async () => {
    const other = await seedHome(await makeTempDir('apply-other'));
    const out = path.join(await makeTempDir('apply-out'), 'full.mnbak');
    await createBackup({ home: other, outPath: out, passphrase: PASSPHRASE, kdf: FAST_KDF });

    const fresh = await makeTempDir('apply-fresh');
    await writeHomeFile(fresh, '.key', `${Buffer.alloc(32, 7).toString('base64')}
`);
    const staged = await stageRestore({ home: fresh, archivePath: out, passphrase: PASSPHRASE });
    assert.deepEqual(staged.warnings, []);
    assert.equal(applyPendingRestore({ home: fresh }).applied, true);
    assert.equal(await readProviderSecret(fresh), PROVIDER_SECRET);
  });

  test('sets aside encrypted files the backup does not replace', async () => {
    // Another machine's backup, credentials only: its key, its provider secret.
    const other = await seedHome(await makeTempDir('apply-other'));
    const out = path.join(await makeTempDir('apply-out'), 'creds.mnbak');
    await createBackup({
      home: other,
      outPath: out,
      passphrase: PASSPHRASE,
      kdf: FAST_KDF,
      categories: ['credentials'],
    });

    // This machine has its own key, and a webhook secret the backup knows nothing about.
    const home = await seedHome(await makeTempDir('apply-home'));
    useHome(home);
    const { writeEncryptedJsonFile } = await import('../../server/security/secret-box.js');
    await writeEncryptedJsonFile(path.join(home, 'plugins', 'connections', 'local.json'), { token: 'local' });
    const ownKey = await readHomeFile(home, '.key');

    const staged = await stageRestore({ home, archivePath: out, passphrase: PASSPHRASE });
    assert.ok(staged.warnings.some((warning) => /different encryption key/.test(warning)));
    assert.equal(applyPendingRestore({ home }).applied, true);

    assert.notEqual(await readHomeFile(home, '.key'), ownKey);
    assert.equal(await readProviderSecret(home), PROVIDER_SECRET, 'restored secrets open with the restored key');
    assert.equal((await readJobs(home))[0].prompt, JOB_PROMPT);
    assert.equal(
      await homeHas(home, 'plugins/connections/local.json'),
      false,
      'a file sealed with the old key is parked, not left to fail on every read',
    );
    const last = readLastRestore(home);
    assert.equal(last.keyChanged, true);
    assert.deepEqual(last.setAside, ['plugins/connections/local.json']);
    assert.equal(await homeHas(home, `pre-restore/${staged.id}/plugins/connections/local.json`), true);

    // Undo brings the old key and everything sealed with it back.
    await scheduleRollback(home);
    assert.equal(applyPendingRestore({ home }).applied, true);
    assert.equal(await readHomeFile(home, '.key'), ownKey);
    assert.equal(await homeHas(home, 'plugins/connections/local.json'), true);
    assert.equal(await readProviderSecret(home), PROVIDER_SECRET);
  });
});
