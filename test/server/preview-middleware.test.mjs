/**
 * Preview API — ping and workspace file streaming.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { request as httpRequestNode } from 'node:http';
import { handlePreviewRequest } from '../../server/preview/middleware.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import { isResolvedPathUnderRoot } from '../../server/workspace/safe-path.js';

function httpRequest(baseUrl, method, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const r = httpRequestNode(url, { method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = { raw };
        }
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function resolveSafePath(userPath) {
  const workspaceRoot = process.env.MINNOW_WORKSPACE;
  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(workspaceRoot, userPath);
  if (!isResolvedPathUnderRoot(resolved, workspaceRoot)) {
    throw new Error('outside workspace');
  }
  return resolved;
}

async function startPreviewServer() {
  const server = createServer(async (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handled = await handlePreviewRequest(req, res, parsed.pathname, parsed.searchParams, {
      resolveSafePath,
      runWithPathAccess: (fn) => fn(),
    });
    if (!handled) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('preview middleware', () => {
  let workspaceDir;
  let server;
  let baseUrl;

  before(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-preview-'));
    await fs.writeFile(
      path.join(workspaceDir, 'index.html'),
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body>Hello</body></html>',
      'utf8',
    );
    await fs.writeFile(path.join(workspaceDir, 'style.css'), 'body { color: red; }', 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'UPPER.HTML'), '<script>window.ran=true</script>', 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    process.env.MINNOW_WORKSPACE = workspaceDir;
    await setWorkspaceRoot(workspaceDir);
    await initWorkspaceRoot();
    ({ server, baseUrl } = await startPreviewServer());
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MINNOW_WORKSPACE;
    await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('GET /api/preview/ping returns ok', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/preview/ping');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  test('GET /api/preview/file/index.html serves HTML', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/preview/file/index.html');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Hello/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-disposition'], 'attachment');
    assert.match(res.headers['content-security-policy'], /sandbox/);
    // Browser preview injects <base> so relative assets resolve under the preview API.
    assert.match(res.body, /<base\s/i);
  });

  test('GET /api/preview/file/index.html?raw=1 skips base injection for editor loads', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/preview/file/index.html?raw=1');
    assert.equal(res.status, 200);
    assert.match(res.body, /Hello/);
    assert.doesNotMatch(res.body, /<base\s/i);
  });

  test('main-origin active documents retain sandbox protection', async () => {
    const html = await httpRequest(baseUrl, 'GET', '/api/preview/file/UPPER.HTML');
    assert.equal(html.headers['content-disposition'], 'attachment');
    assert.match(html.headers['content-security-policy'], /sandbox/);
    const svg = await httpRequest(baseUrl, 'GET', '/api/preview/file/icon.svg');
    assert.equal(svg.headers['content-disposition'], 'attachment');
    assert.match(svg.headers['content-security-policy'], /sandbox/);
  });

  test('GET /api/preview/file/style.css serves CSS', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/preview/file/style.css');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/css/);
    assert.match(res.body, /color: red/);
  });

  test('missing workspace file is 404', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/preview/file/no-such-file.md?raw=1');
    assert.equal(res.status, 404);
    assert.match(res.json.error, /ENOENT/);
  });

  test('rejects path traversal', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/preview/file/..%2F..%2Fetc%2Fpasswd');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /outside|workspace/i);
  });

  test('blocks node_modules paths', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      '/api/preview/file/node_modules/foo/index.js',
    );
    assert.equal(res.status, 403);
    assert.match(res.json.error, /blocked/i);
  });
});

describe('preview middleware workspaceRoot override', () => {
  let homeDir;
  let workspaceDir;
  let server;
  let baseUrl;
  let desktopRoot;

  before(async () => {
    const { setTestHome, rmTestHome } = await import('../config/test-helpers.js');
    const { ensureMinnowLayout } = await import('../../server/config/home.js');
    const { ensureScratchWorkspaceRegistered, getScratchWorkspacePath } = await import(
      '../../server/workspace/root.js'
    );
    const { resolveSafePath, runWithPathAccess } = await import('../../server/runtime/path-access.js');
    const { initWorkspaceRoot, setWorkspaceRoot } = await import('../../server/workspace/root.js');

    homeDir = setTestHome(process.env, 'minnow-test-preview-workspace-root');
    await ensureMinnowLayout();
    await ensureScratchWorkspaceRegistered();
    desktopRoot = getScratchWorkspacePath();
    await fs.writeFile(path.join(desktopRoot, 'desktop-only.txt'), 'desktop workspace file\n', 'utf8');

    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-preview-code-'));
    await fs.writeFile(path.join(workspaceDir, 'code-only.txt'), 'code workspace file\n', 'utf8');
    process.env.MINNOW_WORKSPACE = workspaceDir;
    await setWorkspaceRoot(workspaceDir);
    await initWorkspaceRoot();

    server = createServer(async (req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const handled = await handlePreviewRequest(req, res, parsed.pathname, parsed.searchParams, {
        resolveSafePath,
        runWithPathAccess,
      });
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MINNOW_WORKSPACE;
    const { rmTestHome } = await import('../config/test-helpers.js');
    await rmTestHome(homeDir);
    await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('GET /api/preview/file serves from desktop workspace when workspaceRoot is set', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      `/api/preview/file/desktop-only.txt?workspaceRoot=${encodeURIComponent(desktopRoot)}`,
    );
    assert.equal(res.status, 200);
    assert.match(res.body, /desktop workspace file/);
  });

  test('rejects disallowed workspaceRoot', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      `/api/preview/file/desktop-only.txt?workspaceRoot=${encodeURIComponent('/tmp/not-allowed')}`,
    );
    assert.equal(res.status, 400);
    assert.match(res.json.error, /allowlist/i);
  });
});
