import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setRequestIngress } from '../../server/network/ingress.js';
import { handleWorkspaceRequest } from '../../server/workspace/middleware.js';
import { isWorkspaceApp, openWorkspaceApp, resolveWorkspaceAppPath } from '../../server/workspace/open-in-app.js';

test('open-in accepts only named applications', async () => {
  assert.equal(isWorkspaceApp('cursor'), true);
  assert.equal(isWorkspaceApp('vscode'), true);
  assert.equal(isWorkspaceApp('finder'), true);
  assert.equal(isWorkspaceApp('sh'), false);
  assert.equal(isWorkspaceApp({ name: 'cursor' }), false);
  await assert.rejects(openWorkspaceApp('sh', '.'), /Unsupported application/);
});

test('open-in canonicalizes workspace paths and refuses symlink and parent escapes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-open-in-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  const checkout = path.join(workspace, 'nested');
  await fs.mkdir(checkout, { recursive: true });
  const outside = path.join(dir, 'outside.txt');
  await fs.writeFile(outside, 'fixture');
  await fs.symlink(outside, path.join(checkout, 'escape'), 'file');
  assert.equal(await resolveWorkspaceAppPath('.', undefined, workspace), await fs.realpath(workspace));
  assert.equal(await resolveWorkspaceAppPath('.', checkout, workspace), await fs.realpath(checkout));
  await assert.rejects(resolveWorkspaceAppPath('escape', checkout, workspace), /outside the workspace/);
  await assert.rejects(resolveWorkspaceAppPath(outside, undefined, workspace), /outside the workspace/);
});

test('LAN, Tailnet and Funnel cannot invoke the host app launcher', async () => {
  for (const ingress of ['lan', 'tailnet', 'funnel']) {
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
    setRequestIngress(req, ingress);
    let body;
    const res = { statusCode: 200, setHeader() {}, end(data) { body = JSON.parse(data); } };
    assert.equal(await handleWorkspaceRequest(req, res, '/api/workspace/open-in-app'), true);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(body, { ok: false, error: 'Open in is available on the host.' });
  }
});
