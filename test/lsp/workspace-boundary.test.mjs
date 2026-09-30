import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer, request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import { getLspDiagnostics } from '../../server/lsp/manager.js';
import { createLspMiddleware } from '../../server/lsp/middleware.js';
import { pathAccessStore } from '../../server/runtime/path-access.js';

let baseDir;
let root;
let outside;
let server;
let baseUrl;

function httpRequest(method, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const req = request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-lsp-boundary-'));
  root = path.join(baseDir, 'project');
  outside = path.join(baseDir, 'project-sibling');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const home = path.join(baseDir, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'lsp.json'), '{"enabled":true,"lsp":{}}');
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  invalidateLspConfigCache();

  const middleware = createLspMiddleware(root);
  server = createServer((req, res) => middleware(req, res, () => {
    res.statusCode = 404;
    res.end();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  invalidateLspConfigCache();
  if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
});

test('all file-scoped LSP routes reject sibling and traversal paths', async () => {
  const escapedPaths = [path.join(outside, 'file.ts'), '../project-sibling/file.ts'];
  const routes = [
    '/api/lsp/diagnostics', '/api/lsp/notify', '/api/lsp/completion',
    '/api/lsp/hover', '/api/lsp/definition', '/api/lsp/signature',
    '/api/lsp/format', '/api/lsp/format-range', '/api/lsp/diagnostics-structured',
    '/api/lsp/document-symbols', '/api/lsp/call-hierarchy', '/api/lsp/resolve',
  ];
  for (const escapedPath of escapedPaths) {
    for (const route of routes) {
      const result = await httpRequest('POST', route, { path: escapedPath });
      assert.equal(result.status, 400, `${route}: ${escapedPath}`);
      assert.equal(result.body.error, 'Path outside project');
    }
    const getResult = await httpRequest(
      'GET',
      `/api/lsp/document-symbols?path=${encodeURIComponent(escapedPath)}`,
    );
    assert.equal(getResult.status, 400);
    assert.equal(getResult.body.error, 'Path outside project');
  }
});

test('LSP routes and direct diagnostics reject symlink escapes', async (t) => {
  const link = path.join(root, 'linked');
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      t.skip('Creating symlinks requires elevated privileges');
      return;
    }
    throw err;
  }
  const escapedPath = 'linked/file.ts';
  const result = await httpRequest('POST', '/api/lsp/diagnostics', { path: escapedPath });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Path outside project');
  const direct = await pathAccessStore.run(
    { workspaceRootOverride: root },
    () => getLspDiagnostics(escapedPath),
  );
  assert.equal(direct, 'Error: Path outside project.');
});
