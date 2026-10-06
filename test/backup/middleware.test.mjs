/**
 * /api/backup/* — host-only access and the export → inspect → restore flow the
 * Settings page drives.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { resetBackupJobsForTests } from '../../server/backup/jobs.js';
import { createBackupMiddleware } from '../../server/backup/middleware.js';
import { readPendingRestore } from '../../server/backup/restore-apply.js';
import {
  PASSPHRASE,
  cleanupTempDirs,
  homeHas,
  makeTempDir,
  readAllEntries,
  seedHome,
  useHome,
} from './helpers.mjs';

/** @type {http.Server} */
let server;
/** @type {string} */
let baseUrl;
/** Auth the fake gate attaches to the next request. */
let authKind = 'host';

before(async () => {
  const middleware = createBackupMiddleware();
  server = http.createServer((req, res) => {
    req.minnowAuth = authKind ? { kind: authKind } : undefined;
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end('passed through');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupTempDirs();
});

beforeEach(() => {
  authKind = 'host';
  resetBackupJobsForTests();
});

async function api(method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitForJob(id) {
  for (let i = 0; i < 400; i += 1) {
    const { body } = await api('GET', `/api/backup/jobs/${id}`);
    if (body.job.status !== 'running') return body.job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('job did not finish');
}

describe('access', () => {
  test('a paired device token is refused on every route', async () => {
    await seedHome(await makeTempDir('api-home'));
    authKind = 'device';
    for (const [method, route] of [
      ['GET', '/api/backup/status'],
      ['POST', '/api/backup/export'],
      ['POST', '/api/backup/restore'],
      ['PUT', '/api/backup/settings'],
    ]) {
      const { status, body } = await api(method, route, method === 'GET' ? undefined : {});
      assert.equal(status, 403, `${method} ${route}`);
      assert.equal(body.error, 'Host session required');
    }
  });

  test('other routes pass through untouched', async () => {
    const res = await fetch(`${baseUrl}/api/scheduler/ping`);
    assert.equal(await res.text(), 'passed through');
  });
});

describe('status and settings', () => {
  test('describes categories, defaults and restore state without leaking the passphrase', async () => {
    const home = await seedHome(await makeTempDir('api-home'));
    const dest = await makeTempDir('api-dest');
    const saved = await api('PUT', '/api/backup/settings', {
      categories: ['chats', 'brain', 'credentials'],
      schedule: { destDir: dest, keep: 5, frequency: 'weekly', passphrase: PASSPHRASE, enabled: true },
    });
    assert.equal(saved.status, 200);

    const { status, body } = await api('GET', '/api/backup/status');
    assert.equal(status, 200);
    assert.equal(body.home, home);
    assert.equal(body.fileExtension, '.mnbak');
    assert.deepEqual(body.settings.categories, ['credentials', 'chats', 'brain']);
    assert.equal(body.settings.schedule.hasPassphrase, true);
    assert.equal(body.settings.schedule.keep, 5);
    assert.equal(JSON.stringify(body).includes(PASSPHRASE), false);
    assert.equal(JSON.stringify(body).includes('ciphertext'), false);
    assert.deepEqual(body.restore, { pending: null, last: null });
    assert.ok(body.categories.find((category) => category.id === 'credentials').requiresPassphrase);
    assert.ok(path.isAbsolute(body.defaultDir));
    assert.equal(path.resolve(body.defaultDir).startsWith(path.resolve(home)), false);

    const sizes = await api('GET', '/api/backup/sizes');
    assert.ok(sizes.body.categories.find((row) => row.id === 'chats').bytes > 0);
  });

  test('validation errors come back as 400 with a readable message', async () => {
    const home = await seedHome(await makeTempDir('api-home'));
    const inside = await api('PUT', '/api/backup/settings', { schedule: { destDir: path.join(home, 'backups') } });
    assert.equal(inside.status, 400);
    assert.match(inside.body.error, /outside the Minnow data folder/);
    assert.equal(inside.body.code, 'dest_inside_home');
  });
});

describe('export, inspect and restore', () => {
  test('runs the whole flow as jobs the page can poll', async () => {
    await seedHome(await makeTempDir('api-home'));
    const dest = await makeTempDir('api-dest');

    const started = await api('POST', '/api/backup/export', { destDir: dest, passphrase: PASSPHRASE });
    assert.equal(started.status, 202);
    assert.equal(started.body.job.kind, 'export');
    const exported = await waitForJob(started.body.job.id);
    assert.equal(exported.status, 'done', exported.error);
    assert.equal(exported.result.encrypted, true);
    assert.ok(exported.progress.totalFiles > 0);
    const { entries } = await readAllEntries(exported.result.file, PASSPHRASE);
    assert.ok(entries.has('.key'));

    const status = await api('GET', '/api/backup/status');
    assert.equal(status.body.settings.lastExport.file, exported.result.file);
    assert.equal(status.body.settings.lastDestDir, dest);

    const listed = await api('POST', '/api/backup/list', { dir: dest });
    assert.equal(listed.body.backups.length, 1);
    assert.equal(listed.body.backups[0].encrypted, true);

    // A folder is accepted wherever a file is: its newest backup is meant.
    const preview = await api('POST', '/api/backup/inspect', { path: dest, passphrase: PASSPHRASE });
    assert.equal(preview.body.backup.passphraseOk, true);
    assert.equal(preview.body.backup.file, exported.result.file);

    // Restore into a different, empty home.
    const target = await makeTempDir('api-dst');
    useHome(target);
    const wrong = await api('POST', '/api/backup/restore', { path: exported.result.file, passphrase: 'nope nope nope' });
    const failed = await waitForJob(wrong.body.job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'bad_passphrase');
    assert.equal(readPendingRestore(target), null);

    const restore = await api('POST', '/api/backup/restore', {
      path: exported.result.file,
      passphrase: PASSPHRASE,
      categories: ['chats', 'issues'],
    });
    const staged = await waitForJob(restore.body.job.id);
    assert.equal(staged.status, 'done', staged.error);
    assert.equal(staged.result.restartRequired, true);
    assert.deepEqual(staged.result.categories, ['chats', 'issues']);

    const pending = await api('GET', '/api/backup/status');
    assert.equal(pending.body.restore.pending.kind, 'restore');
    assert.equal(await homeHas(target, 'sessions/sessions.db'), false, 'nothing is swapped before a restart');

    const again = await api('POST', '/api/backup/restore', { path: exported.result.file, passphrase: PASSPHRASE });
    const refused = await waitForJob(again.body.job.id);
    assert.equal(refused.errorCode, 'restore_pending');

    const cancelled = await api('POST', '/api/backup/restore/cancel');
    assert.equal(cancelled.body.cancelled, true);
    assert.equal(readPendingRestore(target), null);
  });

  test('refuses a second job while one is running', async () => {
    await seedHome(await makeTempDir('api-home'));
    const dest = await makeTempDir('api-dest');
    const first = await api('POST', '/api/backup/export', { destDir: dest, passphrase: PASSPHRASE });
    const second = await api('POST', '/api/backup/export', { destDir: dest });
    assert.equal(first.status, 202);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'busy');
    await waitForJob(first.body.job.id);
  });

  test('rejects a relative path, a missing file and an empty folder', async () => {
    await seedHome(await makeTempDir('api-home'));
    const empty = await makeTempDir('api-empty');
    assert.equal((await api('POST', '/api/backup/inspect', { path: 'backup.mnbak' })).status, 400);
    assert.equal((await api('POST', '/api/backup/inspect', { path: path.join(empty, 'gone.mnbak') })).status, 404);
    const none = await api('POST', '/api/backup/inspect', { path: empty });
    assert.equal(none.status, 404);
    assert.match(none.body.error, /no Minnow backups/);
    assert.equal((await api('POST', '/api/backup/export', { destDir: '' })).status, 400);
  });
});
