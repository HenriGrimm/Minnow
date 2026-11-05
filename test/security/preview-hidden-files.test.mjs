import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runWithToolContext } from '../../server/runtime/path-access.js';
import { createPreviewAccessMiddleware, startIsolatedPreviewHost, stopIsolatedPreviewHost } from '../../server/preview/isolated-host.js';

test('a preview grant hides encoded hidden paths and links into hidden directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-preview-hidden-'));
  t.after(async () => {
    await stopIsolatedPreviewHost();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, '.private'));
  await fs.writeFile(path.join(root, '.private', 'note.txt'), 'secret');
  await fs.writeFile(path.join(root, 'open.txt'), 'visible');
  await fs.symlink(path.join(root, '.private'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await startIsolatedPreviewHost();
  let grant;
  await runWithToolContext(() => createPreviewAccessMiddleware()(
    { url: '/api/preview/access', method: 'GET', headers: {host: 'localhost'} },
    { setHeader() {}, end(value) { grant = JSON.parse(value); } }, () => assert.fail('unexpected route'),
  ), { workspaceRoot: root });
  const base = grant.origin + '/p/' + grant.token + '/api/preview/file/';
  for (const name of ['.private/note.txt', 'x%5C.private%5Cnote.txt', 'alias/note.txt']) {
    assert.equal((await fetch(base + name)).status, 403, name);
  }
  assert.equal(await (await fetch(base + 'open.txt')).text(), 'visible');
});
