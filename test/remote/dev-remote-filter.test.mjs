import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createServer as createVite } from 'vite';
import { createDevRemoteHandler, createDevRemotePathPolicy, isDevClientImport } from '../../server/remote/dev-remote-filter.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-dev-remote-')));
for (const dir of ['src', 'node_modules', 'public/icons', 'server', 'documentation']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
for (const file of ['server.js', 'package.json', 'AGENTS.md', 'index.html', '.DS_Store', '.env', 'public/manifest.json', 'public/sw.js']) {
  fs.writeFileSync(path.join(root, file), file === 'package.json' ? '{}' : '');
}
fs.writeFileSync(path.join(root, 'public/icons/icon-192.png'), '');
const viteFsRoot = '/@fs/' + root.replaceAll('\\', '/');
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('dev remote path policy', () => {
  const allowed = createDevRemotePathPolicy({ root });

  test('lets through what the SPA loads', () => {
    for (const p of [
      '/',
      '/index.html',
      '/api/auth/me',
      '/src/main.ts',
      '/node_modules/.vite/deps/qrcode.js',
      `${viteFsRoot}/node_modules/.vite/deps/chunk.js`,
      '/@vite/client',
      `${viteFsRoot}/src/main.ts`,
      `${viteFsRoot}/node_modules/pkg/index.js`,
      '/manifest.json',
      '/sw.js',
      '/icons/icon-192.png',
    ]) {
      assert.equal(allowed(p), true, p);
    }
  });

  test('keeps the rest of the checkout and dotfiles private', () => {
    fs.writeFileSync(path.join(root, 'after-start.txt'), 'private');
    for (const p of [
      '/.DS_Store',
      '/.env',
      '/.git/config',
      '/src/.secret',
      '/node_modules/.bin/vite',
      '/src/.vite/x.js',
      '/server.js',
      '/SeRvEr.Js',
      '/after-start.txt',
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

  test('deep links go to the shell without handing a private filename to Vite', () => {
    const seen = [];
    const handler = createDevRemoteHandler(() => assert.fail('private path reached Vite'), {
      root, serveShell: req => seen.push(req.url),
    });
    for (const url of ['/connect', '/settings/network']) {
      handler({ url, method: 'GET', headers: { accept: 'text/html' } }, {});
    }
    assert.deepEqual(seen, ['/connect', '/settings/network']);
  });

  test('Vite fallback serves the client import graph and rejects private files, including module ID aliases', async () => {
    fs.writeFileSync(path.join(root, 'server/private.js'), 'export default "private"');
    fs.writeFileSync(path.join(root, 'server/shared.js'), 'export default "shared"');
    fs.writeFileSync(path.join(root, 'src/importer.js'), "import '../server/shared.js'; import 'virtual:fixture';");
    const vite = await createVite({ root, configFile: false, logLevel: 'silent', appType: 'custom',
      plugins: [{ name: 'fixture-virtual', resolveId: id => id === 'virtual:fixture' ? '\0' + id : undefined,
        load: id => id === '\0virtual:fixture' ? 'export default 1' : undefined }],
      server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
    const server = http.createServer(createDevRemoteHandler(vite.middlewares, { root,
      isImportedModule: pathname => isDevClientImport(vite.environments.client.moduleGraph, pathname, root),
    }));
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      fs.writeFileSync(path.join(root, 'new-secret.txt'), 'private');
      // A desktop visit puts even an unimported file in Vite's cache.
      await vite.transformRequest('/server/private.js');
      for (const file of ['/new-secret.txt', '/SeRvEr.Js', '/server/private.js', '/@id/server/private.js',
        '/@id//server/private.js?raw', '/@id/' + root.replaceAll('\\', '/') + '/server/private.js?raw']) {
        assert.equal((await fetch(base + file)).status, 404);
      }
      const importer = await fetch(base + '/src/importer.js');
      assert.equal(importer.status, 200);
      const source = await importer.text();
      for (const imported of ['/server/shared.js', '/@id/__x00__virtual:fixture']) {
        assert.ok(source.includes(imported), imported);
        assert.equal((await fetch(base + imported)).status, 200, imported);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await vite.close();
    }
  });
});
