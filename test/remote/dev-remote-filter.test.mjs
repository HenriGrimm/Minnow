import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createDevRemoteHandler, createDevRemotePathPolicy } from '../../server/remote/dev-remote-filter.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-dev-remote-'));
for (const dir of ['src', 'node_modules', 'public/icons', 'server', 'documentation']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
for (const file of ['server.js', 'package.json', 'AGENTS.md', 'index.html', '.DS_Store', '.env', 'public/manifest.json', 'public/sw.js']) {
  fs.writeFileSync(path.join(root, file), '');
}
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('dev remote path policy', () => {
  const allowed = createDevRemotePathPolicy({ root });

  test('lets through what the SPA loads', () => {
    for (const p of [
      '/',
      '/connect',
      '/index.html',
      '/api/auth/me',
      '/src/main.ts',
      '/node_modules/.vite/deps/qrcode.js',
      `/@fs${root}/node_modules/.vite/deps/chunk.js`,
      '/@vite/client',
      '/@id/__x00__virtual',
      `/@fs${root}/src/main.ts`,
      `/@fs${root}/node_modules/pkg/index.js`,
      '/manifest.json',
      '/sw.js',
      '/icons/icon-192.png',
    ]) {
      assert.equal(allowed(p), true, p);
    }
  });

  test('keeps the rest of the checkout and dotfiles private', () => {
    for (const p of [
      '/.DS_Store',
      '/.env',
      '/.git/config',
      '/src/.secret',
      '/node_modules/.bin/vite',
      '/src/.vite/x.js',
      '/server.js',
      '/server/auth/pairing.js',
      '/package.json',
      '/AGENTS.md',
      '/documentation/README.md',
      `/@fs${root}/server.js`,
      '/@fs/etc/hosts',
      `/@fs${root}/src/../server.js`,
      '/src/%2e%2e/server.js',
      '/%E0%A4%A',
    ]) {
      assert.equal(allowed(p), false, p);
    }
  });

  test('files the SPA imports from elsewhere in the checkout load; their neighbours stay private', () => {
    const imported = new Set(['/server/tools/tavily-options.js']);
    const policy = createDevRemotePathPolicy({ root, isImportedModule: (p) => imported.has(p) });
    assert.equal(policy('/server/tools/tavily-options.js'), true);
    assert.equal(policy('/server/auth/pairing.js'), false);
    assert.equal(policy('/server/.env'), false);
  });

  test('answers blocked paths with 404 without calling Vite', () => {
    const seen = [];
    const handler = createDevRemoteHandler((req) => seen.push(req.url), { root });
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
    handler(/** @type {any} */ ({ url: '/.DS_Store?import' }), /** @type {any} */ (res));
    assert.equal(res.statusCode, 404);
    handler(/** @type {any} */ ({ url: '/src/main.ts?t=1' }), /** @type {any} */ ({}));
    assert.deepEqual(seen, ['/src/main.ts?t=1']);
  });
});
