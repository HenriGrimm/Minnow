/**
 * Backup → wipe → restore, checked through the stores the app reads with.
 * Covers the MIN-16 acceptance cases: an encrypted backup restores chats,
 * Brain, issues, providers and scheduled jobs intact into an empty home, and a
 * plaintext backup carries neither `.key` nor any usable secret.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, describe, test } from 'node:test';

import { createBackup } from '../../server/backup/export.js';
import { readArchiveHeader } from '../../server/backup/format.js';
import { inspectBackup, stageRestore } from '../../server/backup/restore.js';
import { applyPendingRestore, readPendingRestore } from '../../server/backup/restore-apply.js';
import {
  CHAT_ID,
  CHAT_MESSAGE,
  FAST_KDF,
  JOB_PROMPT,
  MCP_ENV_SECRET,
  PASSPHRASE,
  PROVIDER_SECRET,
  SEARCH_SECRET,
  cleanupTempDirs,
  homeHas,
  makeChat,
  makeState,
  makeTempDir,
  readAllEntries,
  readChats,
  readHomeFile,
  readJobs,
  readProviderSecret,
  seedHome,
  useHome,
  writeHomeFile,
} from './helpers.mjs';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { writeWholeSessionState } from '../../server/config/sessions-repo.js';

after(cleanupTempDirs);

/** Stage and apply in one step, the way a restart would. */
async function restoreInto(home, archivePath, options = {}) {
  const staged = await stageRestore({ home, archivePath, ...options });
  const applied = applyPendingRestore({ home });
  assert.equal(applied.applied, true, applied.error);
  return staged;
}

describe('encrypted backup round trip', () => {
  test('restores chats, Brain, issues, providers and scheduled jobs into an empty home', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'full.mnbak');
    const sourceKey = await readHomeFile(source, '.key');

    const result = await createBackup({ home: source, outPath: out, passphrase: PASSPHRASE, kdf: FAST_KDF });
    assert.equal(result.encrypted, true);
    assert.equal(result.includesCredentials, true);

    // "Wipe": a brand-new home that has never seen this data or this key.
    const target = await makeTempDir('backup-dst');
    const staged = await restoreInto(target, out, { passphrase: PASSPHRASE });
    assert.equal(staged.restartRequired, true);
    assert.equal(readPendingRestore(target), null);

    assert.deepEqual(readChats(target), [
      { id: CHAT_ID, name: 'Tide tables', messages: [CHAT_MESSAGE, `Reply to: ${CHAT_MESSAGE}`] },
    ]);
    assert.match(await readHomeFile(target, 'brain/pages/facts/harbour.md'), /ferry leaves at nine/);
    assert.match(await readHomeFile(target, 'memory/notes.json'), /remember the ferry/);
    assert.match(await readHomeFile(target, 'issues/state.json'), /Back up the harbour log/);
    assert.match(await readHomeFile(target, 'boards/harbour/journal.jsonl'), /run\.started/);

    assert.equal(await readHomeFile(target, '.key'), sourceKey);
    assert.equal(await readProviderSecret(target), PROVIDER_SECRET);
    assert.equal(JSON.parse(await readHomeFile(target, 'search.json')).keys.braveApiKey, SEARCH_SECRET);

    const jobs = await readJobs(target);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].prompt, JOB_PROMPT);
  });

  test('leaves caches, logs, worktrees and dependency folders out', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'full.mnbak');
    await createBackup({ home: source, outPath: out, passphrase: PASSPHRASE, kdf: FAST_KDF });

    const { entries } = await readAllEntries(out, PASSPHRASE);
    const paths = [...entries.keys()];
    for (const banned of [
      'logs/',
      'browser-profiles/',
      'screenshots/',
      'worktrees/',
      'sessions/snapshots/',
      'brain/code/',
      'workspace/node_modules/',
      'session-token',
    ]) {
      assert.equal(paths.some((p) => p.startsWith(banned)), false, `${banned} must not be archived`);
    }
    assert.ok(paths.includes('sessions/sessions.db'));
    assert.ok(paths.includes('workspace/notes.txt'));
    assert.equal(paths.some((p) => p.endsWith('-wal') || p.endsWith('-shm')), false);
  });

  test('header previews the backup without the passphrase', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'full.mnbak');
    await createBackup({ home: source, outPath: out, passphrase: PASSPHRASE, kdf: FAST_KDF, appRoot: process.cwd() });

    const preview = await inspectBackup({ archivePath: out, appVersion: '0.0.1' });
    assert.equal(preview.encrypted, true);
    assert.equal(preview.includesCredentials, true);
    assert.equal(preview.passphraseOk, null);
    assert.ok(preview.categories.find((row) => row.id === 'chats')?.files >= 1);
    assert.ok(preview.warnings.some((warning) => /newer than the 0\.0\.1/.test(warning)));

    assert.equal((await inspectBackup({ archivePath: out, passphrase: 'not the passphrase' })).passphraseOk, false);
    assert.equal((await inspectBackup({ archivePath: out, passphrase: PASSPHRASE })).passphraseOk, true);
  });

  test('default scrypt cost round-trips', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'default-kdf.mnbak');
    await createBackup({ home: source, outPath: out, passphrase: PASSPHRASE, categories: ['issues'] });
    const { header } = await readArchiveHeader(out);
    assert.equal(header.kdf.N, 1 << 17);
    const { entries } = await readAllEntries(out, PASSPHRASE);
    assert.ok(entries.has('issues/state.json'));
  });
});

describe('plaintext backup', () => {
  test('contains no .key and no usable secret', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'plain.mnbak');
    const key = (await readHomeFile(source, '.key')).trim();

    const result = await createBackup({ home: source, outPath: out });
    assert.equal(result.encrypted, false);
    assert.equal(result.includesCredentials, false);
    assert.equal(result.credentialsOmitted, 2, 'the provider secret and scheduler.json are reported as left out');

    const { header, entries } = await readAllEntries(out);
    assert.equal(header.includesCredentials, false);
    for (const banned of ['.key', 'providers/openrouter/secrets.json', 'scheduler.json']) {
      assert.equal(entries.has(banned), false, `${banned} must not be in a plaintext backup`);
    }
    assert.ok(entries.has('providers/openrouter/profile.json'), 'the provider profile itself is kept');

    // Byte-level proof over the whole decompressed payload, not just named entries.
    const raw = await fs.readFile(out);
    const { payloadOffset } = await readArchiveHeader(out);
    const payload = zlib.gunzipSync(raw.subarray(payloadOffset));
    for (const secret of [key, PROVIDER_SECRET, SEARCH_SECRET, MCP_ENV_SECRET, JOB_PROMPT]) {
      assert.equal(payload.includes(Buffer.from(secret)), false, `payload leaks ${secret.slice(0, 8)}…`);
      assert.equal(raw.includes(Buffer.from(secret)), false);
    }
    assert.equal(payload.includes(Buffer.from('"encrypted": true')), false, 'no secret-box envelopes either');

    // Blanked, not dropped: the files still restore as valid config.
    assert.equal(JSON.parse(entries.get('search.json').content.toString()).keys.braveApiKey, '');
    assert.equal(
      JSON.parse(entries.get('mcp.json').content.toString()).servers.github.env.GITHUB_TOKEN,
      '',
    );
    assert.deepEqual(header.redacted['search.json'], [['keys', 'braveApiKey']]);
  });

  test('refuses to include credentials without a passphrase', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'plain.mnbak');
    const { planBackup } = await import('../../server/backup/plan.js');
    const plan = await planBackup({ home: source, includeCredentials: true });
    await assert.rejects(
      () => createBackup({ home: source, outPath: out, plan }),
      /only saved in passphrase-protected backups/,
    );
    await assert.rejects(() => fs.stat(out), /ENOENT/);
  });

  test('restoring it keeps the credentials already on this computer', async () => {
    const home = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'plain.mnbak');
    await createBackup({ home, outPath: out });

    // Life goes on after the backup: a new chat, and a rotated search key.
    useHome(home);
    writeWholeSessionState(
      makeState([
        makeChat(CHAT_ID, 'Tide tables', [CHAT_MESSAGE]),
        makeChat('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Later chat', ['Written after the backup']),
      ]),
    );
    closeSessionsDb();
    await writeHomeFile(
      home,
      'search.json',
      JSON.stringify({ provider: 'brave', keys: { braveApiKey: 'ROTATED-KEY', tavilyApiKey: '' } }),
    );

    await restoreInto(home, out);

    assert.deepEqual(
      readChats(home).map((chat) => chat.name),
      ['Tide tables'],
      'chats go back to the backup',
    );
    assert.equal(await readProviderSecret(home), PROVIDER_SECRET, 'encrypted provider key survives');
    assert.equal((await readJobs(home))[0].prompt, JOB_PROMPT, 'scheduler.json is untouched');
    assert.equal(
      JSON.parse(await readHomeFile(home, 'search.json')).keys.braveApiKey,
      'ROTATED-KEY',
      'a blanked key is refilled from the file being replaced',
    );
    assert.equal(await readHomeFile(home, 'brain/code/index.db'), 'regenerable code index');
    assert.equal(await homeHas(home, 'sessions/snapshots'), false, 'old snapshots do not follow the restored DB');
  });
});

describe('selective restore', () => {
  test('restores only the chosen categories', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'full.mnbak');
    await createBackup({ home: source, outPath: out, passphrase: PASSPHRASE, kdf: FAST_KDF });

    const target = await makeTempDir('backup-dst');
    await writeHomeFile(target, 'issues/state.json', '{"version":3,"issues":[]}');
    const staged = await restoreInto(target, out, { passphrase: PASSPHRASE, categories: ['brain'] });
    assert.deepEqual(staged.categories, ['brain']);

    assert.equal(await homeHas(target, 'brain/pages/facts/harbour.md'), true);
    assert.equal(await homeHas(target, 'sessions/sessions.db'), false);
    assert.equal(await homeHas(target, '.key'), false);
    assert.equal(await readHomeFile(target, 'issues/state.json'), '{"version":3,"issues":[]}');
  });

  test('credentials alone bring every secret, wherever it lives', async () => {
    const source = await seedHome(await makeTempDir('backup-src'));
    const out = path.join(await makeTempDir('backup-out'), 'creds.mnbak');
    await createBackup({
      home: source,
      outPath: out,
      passphrase: PASSPHRASE,
      kdf: FAST_KDF,
      categories: ['credentials'],
    });
    const { entries } = await readAllEntries(out, PASSPHRASE);
    assert.deepEqual([...entries.keys()].sort(), ['.key', 'providers/openrouter/secrets.json', 'scheduler.json']);

    // A home with its own provider profile: the secret lands beside it, the profile stays.
    const target = await makeTempDir('backup-dst');
    await writeHomeFile(target, 'providers/openrouter/profile.json', '{"id":"openrouter","label":"Mine"}');
    await restoreInto(target, out, { passphrase: PASSPHRASE });
    assert.equal(await readProviderSecret(target), PROVIDER_SECRET);
    assert.match(await readHomeFile(target, 'providers/openrouter/profile.json'), /"Mine"/);
  });
});
