import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { createDevRemoteBundle } from '../../server/remote/dev-remote-bundle.js';
import { createDevRemoteHandler } from '../../server/remote/dev-remote-filter.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-remote-bundle-'));
const root = path.join(tmp, 'app');
const outDir = path.join(tmp, 'out');
const script = path.join(tmp, 'fake-watch.mjs');
const savedHome = process.env.MINNOW_HOME;

fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'server.js'), '// private');
// Stands in for scripts/remote-bundle-watch.mjs: writes a build, reports it, waits for stdin to close.
fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
const outDir = process.argv[2];
setTimeout(() => {
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), '<!doctype html><html><head></head><body>bundled shell</body></html>');
  fs.writeFileSync(path.join(outDir, 'assets', 'app-abc123.js'), 'export const x = 1;'.repeat(200));
  fs.writeFileSync(path.join(outDir, 'sw.js'), 'self.x = 1;');
  process.stdout.write(JSON.stringify({ event: 'built', ms: 5 }) + '\\n');
}, 150);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);

function request(server, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

describe('dev remote bundle', () => {
  let bundle;
  let server;
  const liveCalls = [];

  before(async () => {
    process.env.MINNOW_HOME = path.join(tmp, 'home');
    bundle = createDevRemoteBundle({ root, outDir, script });
    const live = (req, res) => {
      liveCalls.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"live":true}');
    };
    server = http.createServer(createDevRemoteHandler(live, { root, bundle }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    bundle.stop();
    await new Promise((resolve) => server.close(resolve));
    if (savedHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the first page load waits for the build, then gets the bundled shell', async () => {
    assert.equal(bundle.isReady(), false);
    const res = await request(server, '/connect', { Accept: 'text/html' });
    assert.equal(res.status, 200);
    assert.match(res.body.toString(), /bundled shell/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(bundle.isReady(), true);
  });

  test('hashed assets are gzipped and cached as immutable; other files revalidate', async () => {
    const asset = await request(server, '/assets/app-abc123.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-encoding'], 'gzip');
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(asset.headers['content-type'], /javascript/);
    assert.match(zlib.gunzipSync(asset.body).toString(), /^export const x = 1;/);

    const sw = await request(server, '/sw.js');
    assert.equal(sw.headers['cache-control'], 'no-cache');
    assert.equal(sw.headers['content-encoding'], undefined);
    assert.equal(sw.body.toString(), 'self.x = 1;');
  });

  test('only the build output is reachable', async () => {
    for (const p of ['/server.js', '/src/main.ts', '/../app/server.js', '/%2e%2e/app/server.js', '/assets/missing.js']) {
      const res = await request(server, p);
      assert.equal(res.status, 404, p);
    }
  });

  test('API requests always reach the live server', async () => {
    const res = await request(server, '/api/auth/session');
    assert.deepEqual(JSON.parse(res.body.toString()), { live: true });
    assert.deepEqual(liveCalls, ['/api/auth/session']);
  });
});

describe('dev remote bundle fallback', () => {
  test('without a build in time, requests fall back to live modules', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-remote-bundle-never-'));
    const neverBuilds = path.join(dir, 'never.mjs');
    fs.writeFileSync(neverBuilds, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
    const appRoot = path.join(dir, 'app');
    fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true });
    const bundle = createDevRemoteBundle({ root: appRoot, outDir: path.join(dir, 'out'), script: neverBuilds });
    const waitFor = bundle.whenReady;
    bundle.whenReady = () => waitFor(200);
    const server = http.createServer(createDevRemoteHandler((req, res) => res.end(`live ${req.url}`), { root: appRoot, bundle }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await request(server, '/src/main.ts');
      assert.equal(res.body.toString(), 'live /src/main.ts');
    } finally {
      bundle.stop();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
