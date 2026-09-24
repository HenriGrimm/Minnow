import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resetSecretBoxCacheForTests } from '../../server/security/secret-box.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';
import { scaffoldPackage } from '../../server/plugins/authoring.js';
import { connectionSettings, executePackageTool, inspectPackage, listPackages, managePackage, packageSkillFiles, packageTools, panelContent } from '../../server/plugins/manager.js';
import { validateManifest, relativeFile } from '../../server/plugins/manifest.js';
import { blockPlanModeWrite } from '../../server/tools/plan-write-guard.js';
import { getSkillById } from '../../server/skills/scan.js';

let temp;
const previousHome = process.env.MINNOW_HOME;
const scope = fn => runWithToolContext(fn, { workspaceRoot: temp });
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-packages-'));
  process.env.MINNOW_HOME = path.join(temp, 'home');
  resetMinnowHomeCache(); resetSecretBoxCacheForTests();
});
after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache(); resetSecretBoxCacheForTests();
  await fs.rm(temp, { recursive: true, force: true });
});

test('scaffold, inspect, install, dispatch, invalid update rollback and live reload', async () => scope(async () => {
  const created = await scaffoldPackage({ id: 'hello', path: 'hello' });
  assert.equal(created.installed, false);
  assert.equal((await inspectPackage('hello')).manifest.id, 'hello');
  await managePackage({ action: 'install', path: 'hello' });
  const oldRelease = (await panelContent('hello', 'main')).release;
  assert.ok((await packageTools()).some(t => t.function.name === 'plugin__hello__greet'));
  assert.equal(JSON.parse(await executePackageTool('plugin__hello__greet', { name: 'Ada' })).message, 'Hello, Ada!');
  await assert.rejects(executePackageTool('plugin__hello__greet', {}), /Invalid tool arguments/);
  await fs.writeFile(path.join(temp, 'hello/greet.mjs'), 'export default broken syntax');
  await assert.rejects(managePackage({ action: 'reload', id: 'hello' }));
  assert.equal(JSON.parse(await executePackageTool('plugin__hello__greet', { name: 'Ada' })).message, 'Hello, Ada!');
  await fs.writeFile(path.join(temp, 'hello/greet.mjs'), 'export default () => "new release";');
  const inspected = await inspectPackage('hello');
  await assert.rejects(managePackage({ action: 'reload', id: 'hello', digest: 'stale' }), /changed after review/);
  await managePackage({ action: 'reload', id: 'hello', digest: inspected.digest });
  assert.equal(await executePackageTool('plugin__hello__greet', { name: 'Ada' }), 'new release');
  await assert.rejects(executePackageTool('plugin__hello__greet', { name: 'Ada' }, { pluginRelease: oldRelease }), /Reopen this panel/);
  await managePackage({ action: 'disable', id: 'hello' });
  assert.equal((await packageTools()).length, 0);
  await assert.rejects(executePackageTool('plugin__hello__greet', { name: 'Ada' }), /disabled/);
  await assert.rejects(panelContent('hello', 'main'), /disabled/);
  assert.equal((await listPackages()).packages[0].enabled, false);
  await managePackage({ action: 'enable', id: 'hello' });
  assert.match((await panelContent('hello', 'main')).html, /minnow.callTool/);
}));

test('connections are encrypted, redacted and injected only into handlers', async () => scope(async () => {
  const manifestPath = path.join(temp, 'hello/plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  manifest.connections = [{ id: 'service', label: 'Service', fields: [{ id: 'token', label: 'Token', secret: true, required: true }] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(temp, 'hello/greet.mjs'), 'export default (args, ctx) => ({configured: ctx.connections.service.token === "secret-value"});');
  await managePackage({ action: 'reload', id: 'hello' });
  await assert.rejects(executePackageTool('plugin__hello__greet', { name: 'Ada' }), /Configure Service/);
  const response = await connectionSettings('hello', { service: { token: 'secret-value' } });
  assert.equal(response.service.token.configured, true);
  assert.doesNotMatch(JSON.stringify(response), /secret-value/);
  assert.doesNotMatch(await fs.readFile(path.join(temp, 'home/plugins/connections/hello.json'), 'utf8'), /secret-value/);
  assert.deepEqual(JSON.parse(await executePackageTool('plugin__hello__greet', { name: 'Ada' })), { configured: true });
  assert.doesNotMatch(JSON.stringify(await listPackages()), /secret-value/);
  await assert.rejects(connectionSettings('hello', { service: { unknown: 'x' } }), /Invalid/);
}));

test('worker deadlines stop synchronous hangs without blocking the server', async () => scope(async () => {
  await scaffoldPackage({ id: 'hang', path: 'hang' });
  const file = path.join(temp, 'hang/plugin.json');
  const manifest = JSON.parse(await fs.readFile(file));
  manifest.tools[0].timeoutMs = 100;
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(path.join(temp, 'hang/greet.mjs'), 'export default () => { while(true) {} };');
  await managePackage({ action: 'install', path: 'hang' });
  const start = Date.now();
  await assert.rejects(executePackageTool('plugin__hang__greet', { name: 'Ada' }), /timed out/);
  assert.ok(Date.now() - start < 5000);
  await managePackage({ action: 'remove', id: 'hang' });
}));

test('caller cancellation terminates a running worker', async () => scope(async () => {
  await scaffoldPackage({ id: 'cancel', path: 'cancel' });
  await fs.writeFile(path.join(temp, 'cancel/greet.mjs'), 'export default () => new Promise(resolve => setTimeout(() => resolve("late"), 20000));');
  await managePackage({ action: 'install', path: 'cancel' });
  const controller = new AbortController();
  const pending = runWithToolContext(() => executePackageTool('plugin__cancel__greet', { name: 'Ada' }), { workspaceRoot: temp, abortSignal: controller.signal });
  const rejection = assert.rejects(pending, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 100));
  controller.abort();
  await rejection;
  await managePackage({ action: 'remove', id: 'cancel' });
}));

test('disable terminates running handlers; skills revoke; removal clears credentials', async () => scope(async () => {
  const file = path.join(temp, 'hello/plugin.json');
  const manifest = JSON.parse(await fs.readFile(file));
  manifest.skills = [{ id: 'helper', path: 'SKILL.md' }];
  await fs.writeFile(path.join(temp, 'hello/SKILL.md'), '---\nname: plugin-hello-helper\ndescription: Test helper\n---\nUse the hello tool.');
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(path.join(temp, 'hello/greet.mjs'), 'export default async () => { await new Promise(r => setTimeout(r, 20000)); return "late"; };');
  await managePackage({ action: 'reload', id: 'hello' });
  assert.equal((await packageSkillFiles())[0].id, 'plugin-hello-helper');
  const pending = executePackageTool('plugin__hello__greet', { name: 'Ada' });
  const rejection = assert.rejects(pending, /disabled|changed/);
  await new Promise(resolve => setTimeout(resolve, 100));
  await managePackage({ action: 'disable', id: 'hello' });
  await rejection;
  assert.equal((await packageSkillFiles()).length, 0);
  await managePackage({ action: 'remove', id: 'hello' });
  assert.equal((await listPackages()).packages.length, 0);
  await assert.rejects(fs.access(path.join(temp, 'home/plugins/connections/hello.json')));
}));

test('reject invalid manifests, path traversal, outside sources and duplicate installs', async () => scope(async () => {
  for (const unsafe of ['../x', 'a/../../x', '/tmp/x', 'C:/x', 'a\\x', 'con.txt', 'a./x']) assert.throws(() => relativeFile(unsafe));
  assert.throws(() => validateManifest({ apiVersion: 9 }), /Unsupported/);
  await assert.rejects(inspectPackage('../'), /outside/);
  await scaffoldPackage({ id: 'duplicate', path: 'duplicate' });
  const installs = await Promise.allSettled([managePackage({ action: 'install', path: 'duplicate' }), managePackage({ action: 'install', path: 'duplicate' })]);
  assert.equal(installs.filter(r => r.status === 'fulfilled').length, 1);
  await managePackage({ action: 'remove', id: 'duplicate' });
  assert.match(blockPlanModeWrite('plan', 'plugin_manage', { action: 'install' }), /Plan mode/);
}));

test('user skills with plugin-prefixed ids resolve without an installed package', async () => scope(async () => {
  const id = 'plugin-local-guide';
  const skillDir = path.join(temp, 'home', 'skills', id);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${id}\ndescription: Local guide\n---\nUser skill body.`);
  const skill = await getSkillById(temp, id);
  assert.equal(skill?.source, 'user');
  assert.equal(skill?.body, 'User skill body.');
}));
