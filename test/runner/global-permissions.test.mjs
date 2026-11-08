import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson, updateConfigJson, writeConfigJson } from '../../server/config/store.js';
import { getPermissionLevelFromConfig, getFilesystemAccessFromConfig } from '../../server/config/tool-security.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import { createInProcessToolDispatch, executeInProcessTool } from '../../server/runner/tool-dispatch.js';
import { getPluginToolDefinitions, reloadPlugins } from '../../server/tools/loader.js';
import { addChatPermissionGrant, resetChatPermissionGrantsForTests } from '../../server/chats/permission-grants.js';

let home, cwd;
const previousHome = process.env.MINNOW_HOME;
const setLevel = permissionLevel => updateConfigJson('config.json', config => ({ ...config, toolSecurity: { permissionLevel } }));

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-global-permissions-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  await ensureMinnowLayout();
  cwd = path.join(home, 'project');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'read.txt'), 'project text');
  await initWorkspaceRoot();
  await setWorkspaceRoot(cwd);
  await fs.cp(path.resolve('test/fixtures/plugin-tools/echo'), path.join(home, 'tools/echo'), { recursive: true });
  // All old controls, including Off, must be inert even before the next settings save.
  await writeConfigJson('tools.json', {
    enabled: { read_file: false, save_file: false },
    permissions: { default: { read_file: 'off', save_file: 'off', plugin__echo__ping: 'off', plugin_manage: 'off' } },
  });
  await reloadPlugins();
});

after(async () => {
  resetChatPermissionGrantsForTests();
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

test('built-ins and discovered plugin tools follow each global level despite legacy Off', async () => {
  assert.ok((await getPluginToolDefinitions()).some(tool => tool.function.name === 'plugin__echo__ping'));
  for (const level of ['manual', 'auto', 'full']) {
    await setLevel(level);
    assert.match((await executeInProcessTool('read_file', { path: 'read.txt' }, { cwd })).content, /project text/);
    const edit = await executeInProcessTool('save_file', { path: `${level}.txt`, content: level }, { cwd });
    const plugin = await executeInProcessTool('plugin__echo__ping', {}, { cwd });
    if (level === 'manual') assert.match(edit.content, /needs approval/);
    else assert.equal(await fs.readFile(path.join(cwd, `${level}.txt`), 'utf8'), level);
    if (level === 'full') assert.equal(plugin.content, 'pong');
    else assert.match(plugin.content, /needs approval/);
  }
});

test('the attempt dispatch used by Boards and sub-agents captures a ceiling and reads live revocations', async () => {
  await setLevel('manual');
  const manual = createInProcessToolDispatch({ cwd });
  await manual.execute('read_file', { path: 'read.txt' });
  await setLevel('full');
  assert.match((await manual.execute('save_file', { path: 'denied.txt', content: 'no' })).content, /needs approval/);
  const full = createInProcessToolDispatch({ cwd });
  assert.equal((await full.execute('plugin__echo__ping', {})).content, 'pong');
  await setLevel('manual');
  assert.match((await full.execute('plugin__echo__ping', {})).content, /needs approval/);
  await assert.rejects(fs.access(path.join(cwd, 'denied.txt')));
});

test('parent chat grants and exact interactive approval work without a per-tool grant', async () => {
  await setLevel('manual');
  addChatPermissionGrant('parent', 'edit:workspace');
  const child = createInProcessToolDispatch({ cwd, activityChatId: 'parent' });
  await child.execute('save_file', { path: 'child.txt', content: 'inherited grant' });
  assert.equal(await fs.readFile(path.join(cwd, 'child.txt'), 'utf8'), 'inherited grant');
  assert.equal((await executeInProcessTool('plugin__echo__ping', {}, { cwd, interactiveApproval: true })).content, 'pong');
});

test('Full access and approval cannot bypass turn clamps, the secret floor, or role tool restrictions', async () => {
  await setLevel('full');
  const readOnly = createInProcessToolDispatch({ cwd, turnClamp: 'read-only', interactiveApproval: true });
  assert.match((await readOnly.execute('save_file', { path: 'blocked.txt', content: 'no' })).content, /Error:/);
  const key = path.join(cwd, '.minnow', '.key');
  await fs.mkdir(path.dirname(key));
  await fs.writeFile(key, 'test secret');
  assert.match((await executeInProcessTool('read_file', { path: key }, { cwd, interactiveApproval: true })).content, /Error:/);
  assert.match((await executeInProcessTool('save_file', { path: 'blocked.txt', content: 'no' }, { cwd, allowedToolNames: ['read_file'] })).content, /not in the allowed set/);
  await assert.rejects(fs.access(path.join(cwd, 'blocked.txt')));
  assert.equal((await readConfigJson('config.json')).toolSecurity.permissionLevel, 'full');
});


test('legacy Full disk flags cannot widen the default global Auto mode', async () => {
  await updateConfigJson('config.json', config => ({ ...config, toolSecurity: { filesystemAccess: 'full' } }));
  assert.equal(await getPermissionLevelFromConfig(), 'auto');
  assert.equal(await getFilesystemAccessFromConfig(), 'workspace');
});

test('Auto and exact Manual approval authorize outside reads without weakening an explicit workspace ceiling', async () => {
  const outside = path.join(home, 'outside.txt');
  await fs.writeFile(outside, 'outside read');
  await setLevel('auto');
  assert.match((await executeInProcessTool('read_file', { path: outside }, { cwd })).content, /outside read/);
  const edit = await executeInProcessTool('save_file', { path: outside, content: 'unauthorized' }, { cwd });
  assert.match(edit.content, /needs approval/);
  await setLevel('manual');
  assert.match((await executeInProcessTool('read_file', { path: outside }, { cwd })).content, /needs approval/);
  assert.match((await executeInProcessTool('read_file', { path: outside }, { cwd, interactiveApproval: true })).content, /outside read/);
  assert.match((await executeInProcessTool('read_file', { path: outside }, {
    cwd, interactiveApproval: true, filesystemAccessCeiling: 'workspace',
  })).content, /outside the workspace/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside read');
});
