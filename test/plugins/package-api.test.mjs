import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
