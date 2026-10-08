import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { githubArchive } from './github-fixture.mjs';
import { after, before, test } from 'node:test';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson, updateConfigJson } from '../../server/config/store.js';
import { resetSecretBoxCacheForTests } from '../../server/security/secret-box.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import { handlePluginsRequest } from '../../server/tools/middleware.js';
import { createToolsMiddleware } from '../../server/runtime/tools-middleware.js';
import { executeInProcessTool } from '../../server/runner/tool-dispatch.js';

let home;
let workspace;
let server;
let base;
const previousHome = process.env.MINNOW_HOME;
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-package-api-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache(); resetSecretBoxCacheForTests();
  await ensureMinnowLayout();
  workspace = path.join(home, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await initWorkspaceRoot();
  await setWorkspaceRoot(workspace);
  const tools = createToolsMiddleware();
  server = http.createServer((req, res) => {
    void handlePluginsRequest(req, res, new URL(req.url, 'http://localhost').pathname)
      .then(handled => { if (!handled) void tools(req, res, () => { res.statusCode = 404; res.end(); }); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache(); resetSecretBoxCacheForTests();
  await fs.rm(home, { recursive: true, force: true });
});
async function request(endpoint, body, method = 'POST') {
  const response = await fetch(base + endpoint, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const packages = '/api/plugins/packages';
const permission = mode => updateConfigJson('tools.json', config => {
  config.permissions.default.plugin__api_demo__greet = mode;
  return config;
});

test('package HTTP lifecycle shares tool discovery, dispatch and permission guards', async () => {
  const scaffold = await request(packages + '/manage', { action: 'scaffold', id: 'api-demo', path: 'plugin' });
  assert.equal(scaffold.status, 200);
  const review = await request(packages + '/inspect', { path: 'plugin' });
  assert.equal(review.status, 200);
  const install = await request(packages + '/manage', { action: 'install', path: 'plugin', digest: review.body.digest });
  assert.equal(install.status, 200);
  assert.equal((await request(packages)).body.packages[0].enabled, true);
  const name = 'plugin__api_demo__greet';
  const definitions = () => request('/api/plugins/tools');
  assert.ok((await definitions()).body.tools.some(t => t.function.name === name));
  const panel = await request(packages + '/api-demo/panels/main');
  const call = extra => request('/api/tools', { name, args: { name: 'Ada' }, workspaceRoot: workspace, ...extra });
  assert.match((await call()).body.result, /Hello, Ada!/);
  assert.match((await call({ pluginRelease: 'stale' })).body.result, /Reopen this panel/);
  assert.match((await executeInProcessTool(name, { name: 'Ada' }, { cwd: workspace })).content, /requires? Full permission/);
  await permission('off');
  assert.equal((await definitions()).body.tools.some(t => t.function.name === name), false);
  assert.match((await call()).body.result, /disabled in Settings/);
  await permission('full');
  assert.match((await executeInProcessTool(name, { name: 'Ada' }, { cwd: workspace })).content, /Hello, Ada!/);
  const management = await executeInProcessTool('plugin_manage', { action: 'disable', id: 'api-demo' }, { cwd: workspace });
  assert.match(management.content, /requires Full permission/);
  const plan = await request('/api/tools', { name: 'plugin_manage', args: { action: 'disable', id: 'api-demo' }, modeId: 'plan' });
  assert.match(plan.body.result, /Plan mode/);
  assert.equal((await request(packages + '/manage', { action: 'disable', id: 'api-demo' })).status, 200);
  assert.match((await call({ pluginRelease: panel.body.release })).body.result, /disabled/);
  assert.equal((await request(packages + '/api-demo/panels/main')).status, 400);
  assert.equal((await request(packages + '/manage', { action: 'enable', id: 'api-demo' })).status, 200);
  assert.match((await call()).body.result, /Hello, Ada!/);
  assert.equal((await request(packages + '/manage', { action: 'remove', id: 'api-demo' })).status, 200);
  assert.deepEqual((await request(packages)).body.packages, []);
  assert.equal((await readConfigJson('tools.json')).permissions.default[name], undefined);
  await permission('full'); // Simulate a permission left by removal in an older release.
  assert.equal((await request(packages + '/manage', { action: 'install', path: 'plugin' })).status, 200);
  assert.equal((await readConfigJson('tools.json')).permissions.default[name], undefined);
  assert.match((await executeInProcessTool(name, { name: 'Ada' }, { cwd: workspace })).content, /requires? Full permission/);
});

test('package routes reject malformed input, unknown actions and traversal', async () => {
  assert.equal((await request(packages + '/inspect', { path: '../..' })).status, 400);
  assert.equal((await request(packages + '/manage', { action: 'invalid', id: 'api-demo' })).status, 400);
  assert.equal((await request(packages + '/api-demo/connections', { connections: { unknown: {} } }, 'PUT')).status, 400);
  assert.equal((await request(packages + '/missing')).status, 404);
  const response = await fetch(base + packages + '/inspect', { method: 'POST', body: '{' });
  assert.equal(response.status, 400);
});

test('UI entry HTTP route pins the release and never returns saved connections', async () => {
  const manifestPath = path.join(workspace, 'plugin/plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  manifest.ui = { entry: 'ui.mjs' };
  manifest.connections = [{ id: 'service', label: 'Service', fields: [{ id: 'token', label: 'Token', secret: true }] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(workspace, 'plugin/ui.mjs'), 'export default ctx => ctx.onCleanup(() => {});');
  assert.equal((await request(packages + '/manage', { action: 'reload', id: 'api-demo' })).status, 200);
  await request(packages + '/api-demo/connections', { connections: { service: { token: 'test-secret' } } }, 'PUT');
  const installed = (await request(packages)).body.packages[0];
  const entry = await request(`${packages}/api-demo/ui/${installed.release}`);
  assert.equal(entry.status, 200);
  assert.match(entry.body.code, /export default/);
  assert.doesNotMatch(JSON.stringify(entry.body), /test-secret/);
  assert.equal((await request(`${packages}/api-demo/ui/${'a'.repeat(36)}`)).status, 400);
  await request(packages + '/manage', { action: 'disable', id: 'api-demo' });
  assert.equal((await request(`${packages}/api-demo/ui/${installed.release}`)).status, 400);
});

test('Settings can import and reload a folder outside the workspace without widening tool access', async () => {
  const folder = path.join(home, 'external-plugin');
  await fs.mkdir(folder);
  await fs.mkdir(path.join(folder, '.git'));
  await fs.writeFile(path.join(folder, '.git/config'), 'not part of the plugin');
  const manifest = { apiVersion: 1, id: 'external-demo', name: 'External demo', description: 'A local plugin', version: '1.0.0', ui: { entry: 'ui.mjs' } };
  await fs.writeFile(path.join(folder, 'plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(folder, 'ui.mjs'), 'export default () => {};');
  assert.equal((await request(packages + '/inspect', { path: folder })).status, 400);
  const review = await request(packages + '/inspect', { source: folder });
  assert.equal(review.status, 200);
  const install = () => request(packages + '/manage', { action: 'install', source: review.body.source, digest: review.body.digest });
  await fs.writeFile(path.join(folder, 'ui.mjs'), 'export default () => "changed";');
  assert.match((await install()).body.error, /changed after review/);
  await fs.writeFile(path.join(folder, 'ui.mjs'), 'export default () => {};');
  assert.equal((await install()).status, 200);
  await fs.writeFile(path.join(folder, 'ui.mjs'), 'broken syntax');
  assert.equal((await request(packages + '/manage', { action: 'reload', id: manifest.id })).status, 400);
  assert.equal((await request(packages)).body.packages.find(p => p.id === manifest.id).version, '1.0.0');
  await fs.writeFile(path.join(folder, 'ui.mjs'), 'export default () => {};');
  manifest.version = '1.0.1';
  await fs.writeFile(path.join(folder, 'plugin.json'), JSON.stringify(manifest));
  assert.equal((await request(packages + '/manage', { action: 'reload', id: manifest.id })).status, 200);
  assert.equal((await request(packages)).body.packages.find(p => p.id === manifest.id).version, '1.0.1');
  assert.equal((await request(packages + '/manage', { action: 'remove', id: manifest.id })).status, 200);
});

test('GitHub HTTP install pins the reviewed commit and reload fetches the original source again', async t => {
  const nativeFetch = globalThis.fetch;
  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  let head = first;
  let unavailable = false;
  const source = 'https://github.com/owner/plugin';
  t.mock.method(dns, 'lookup', async () => [{ address: '140.82.112.3', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith(base)) return nativeFetch(url, options);
    if (unavailable) return new Response('', { status: 503 });
    assert.ok(url.startsWith('https://codeload.github.com/'));
    const commit = url.endsWith('/HEAD') ? head : url.split('/').at(-1);
    const manifest = { apiVersion: 1, id: 'github-demo', name: 'GitHub demo', description: 'A remote plugin', version: commit === first ? '1.0.0' : '1.0.1', ui: { entry: 'ui.mjs' } };
    const files = { 'plugin.json': JSON.stringify(manifest), 'ui.mjs': 'export default () => {};' };
    return new Response(githubArchive(Object.entries(files).map(([name, bytes]) => ({ name, bytes })), { commit }));
  });
  const review = await request(packages + '/inspect', { source });
  assert.equal(review.status, 200);
  assert.equal(review.body.commit, first);
  head = second;
  assert.equal((await request(packages + '/manage', { action: 'install', source, commit: review.body.commit, digest: review.body.digest })).status, 200);
  const installed = async () => (await request(packages)).body.packages.find(p => p.id === 'github-demo');
  assert.equal((await installed()).version, '1.0.0');
  assert.equal((await installed()).source, source);
  assert.equal((await request(packages + '/manage', { action: 'reload', id: 'github-demo' })).status, 200);
  assert.equal((await installed()).version, '1.0.1');
  const release = (await installed()).release;
  unavailable = true;
  assert.equal((await request(packages + '/manage', { action: 'reload', id: 'github-demo' })).status, 400);
  assert.equal((await installed()).release, release);
  assert.equal((await request(packages + '/manage', { action: 'remove', id: 'github-demo' })).status, 200);
});
