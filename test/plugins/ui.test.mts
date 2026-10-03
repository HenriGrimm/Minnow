import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  MutationObserver: win.MutationObserver, localStorage: win.localStorage,
  requestAnimationFrame: (fn: FrameRequestCallback) => win.setTimeout(() => fn(0), 0),
});
const originalFetch = globalThis.fetch;
const toolCalls: unknown[][] = [];
mock.module('../../src/tools/client.ts', { namedExports: { executeTool: async (...args: unknown[]) => { toolCalls.push(args); return { content: 'done' }; } } });
mock.module('../../src/skills/client.ts', { namedExports: { getSkillCatalog: () => [{ id: 'build-plugin' }] } });
mock.module('../../src/ui/preview-electron-visibility.ts', { namedExports: { registerChromePopover: () => {}, unregisterChromePopover: () => {} } });
mock.module('../../src/plugins/usage.ts', { namedExports: {
  getPluginChatUsage: () => null,
  getPluginWorkspaceUsage: () => ({ totals: { totalTokens: 0 } }),
  subscribePluginChatUsage: (fn: (value: null) => void) => { fn(null); return () => {}; },
  subscribePluginWorkspaceUsage: () => () => {},
} });
const { createPluginUiContext } = await import('../../src/plugins/ui-context.ts');
const { createPluginUiRuntime } = await import('../../src/plugins/ui-runtime.ts');
const { buildMenuItems, listMenuContributorIds } = await import('../../src/ui/menu-registry.ts');
const { listCommands } = await import('../../src/ui/command-registry.ts');
const { getAppById, isAppId, listReleasedApps } = await import('../../src/os/app-registry.ts');
const { listRailApps } = await import('../../src/os/app-preferences.ts');
const { launchInstance, getForegroundAppId } = await import('../../src/os/instances.ts');
const { getSlashCommandCatalog, dispatchPluginSlashCommand, isPluginSlashCommand } = await import('../../src/chat/slash-commands/registry.ts');
after(async () => { globalThis.fetch = originalFetch; mock.restoreAll(); await win.happyDOM.abort(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const dom = () => { document.body.innerHTML = '<div id="osAppsLayer"></div><div id="metric"><span id="tps" data-plugin-slot="chat.throughput">20</span></div>'; };

test('trusted UI adds DOM, apps, menus and commands, then revokes them with cleanup', async () => {
  dom();
  const owner = createPluginUiContext('metrics', 'release', ['read']);
  let cleanupCount = 0;
  owner.context.mountSlot('chat.throughput', () => {
    const node = document.createElement('span');
    node.textContent = ' · 100 total';
    return { element: node, dispose: () => { cleanupCount++; } };
  });
  assert.match(document.getElementById('tps')!.textContent!, /100 total/);
  // The host can replace a metric's children or the entire surface.
  document.getElementById('tps')!.textContent = '30';
  await settle();
  assert.equal(cleanupCount, 1);
  assert.match(document.getElementById('tps')!.textContent!, /100 total/);
  document.getElementById('metric')!.innerHTML = '<span id="tps" data-plugin-slot="chat.throughput">40</span>';
  await settle();
  assert.equal(cleanupCount, 2);
  assert.match(document.getElementById('tps')!.textContent!, /100 total/);

  let mounts = 0;
  let appCleanup = 0;
  const app = owner.context.registerApp({ id: 'usage', name: 'Usage' }, root => {
    mounts++;
    root.textContent = 'Token totals';
    return () => { appCleanup++; };
  });
  assert.equal(isAppId(app.id), true);
  assert.ok(listReleasedApps().some(row => row.id === app.id));
  assert.ok(listRailApps().some(row => row.id === app.id));
  await Promise.all([getAppById(app.id)!.open!(), getAppById(app.id)!.open!()]);
  assert.equal(mounts, 1);
  assert.equal(document.getElementById(`osAppLayer-${app.id}`)!.textContent, 'Token totals');
  launchInstance(app.id);
  assert.equal(getForegroundAppId(), app.id);

  let selections = 0;
  owner.context.registerMenu('usage', () => [{ id: 'open', label: 'Usage', onSelect: () => { selections++; } }], { kinds: ['menubar.plugins', 'app.rail'] });
  const item = buildMenuItems({ kind: 'menubar.plugins' })[0];
  assert.equal(item.label, 'Usage');
  assert.equal(buildMenuItems({ kind: 'unrelated' }).length, 0);
  if (!('onSelect' in item)) throw new Error('Expected action');
  item.onSelect();
  owner.context.registerCommand({ id: 'usage', title: 'Usage', group: 'Plugins', run: () => { selections++; } });
  const command = listCommands().find(c => c.id === 'plugin-metrics:command:usage')!;
  command.run();
  assert.equal(selections, 2);
  let slashArgs = '';
  owner.context.registerSlashCommand({ id: 'tokens', alias: 'tokens', label: 'Tokens', description: 'Show tokens', run: input => { slashArgs = input.args; } });
  assert.ok(getSlashCommandCatalog().some(command => command.insertion === '/tokens '));
  assert.equal(isPluginSlashCommand('/tokens output only'), true);
  assert.equal(await dispatchPluginSlashCommand('/tokens output only', { chatId: 'chat', workspacePath: '/repo' }), true);
  assert.equal(slashArgs, 'output only');
  assert.equal(await dispatchPluginSlashCommand('/plugin-metrics--tokens input', { chatId: 'chat', workspacePath: '/repo' }), true);
  assert.equal(slashArgs, 'input');
  assert.throws(() => owner.context.registerSlashCommand({ id: 'bad', alias: 'compact', label: 'Bad', description: 'Bad', run: () => {} }), /alias/);
  assert.throws(() => owner.context.registerSlashCommand({ id: 'bad_skill', alias: 'build-plugin', label: 'Bad', description: 'Bad', run: () => {} }), /alias/);
  owner.dispose(); owner.dispose();
  assert.equal(cleanupCount, 3);
  assert.equal(appCleanup, 1);
  assert.equal(isAppId(app.id), false);
  assert.equal(getForegroundAppId(), null);
  assert.equal(document.getElementById(`osAppLayer-${app.id}`), null);
  assert.equal(listMenuContributorIds().length, 0);
  assert.equal(listCommands().length, 0);
  assert.equal(isPluginSlashCommand('/tokens'), false);
  assert.equal(await dispatchPluginSlashCommand('/plugin-metrics--tokens', { chatId: 'chat', workspacePath: '/repo' }), false);
  assert.throws(() => item.onSelect(), /no longer active/);
  assert.throws(() => command.run(), /no longer active/);
});

test('tool calls stay permission-dispatched and release-pinned; foreign and stale calls fail', async () => {
  dom();
  const owner = createPluginUiContext('tools', 'one', ['read']);
  globalThis.fetch = async () => Response.json({ packages: [{ id: 'tools', enabled: true, release: 'one' }] });
  await assert.rejects(owner.context.callTool('execute_command'), /only its plugin/);
  assert.equal(await owner.context.callTool('read', { path: 'test' }), 'done');
  assert.equal(toolCalls[0][0], 'plugin__tools__read');
  assert.equal((toolCalls[0][2] as { pluginRelease: string }).pluginRelease, 'one');
  globalThis.fetch = async () => Response.json({ packages: [{ id: 'tools', enabled: true, release: 'two' }] });
  await assert.rejects(owner.context.callTool('read'), /Plugin changed/);
  owner.dispose();
  await assert.rejects(owner.context.callTool('read'), /no longer active/);
  assert.equal(toolCalls.length, 1);
});

test('runtime reloads and disables UI; broken activation rolls back only that plugin', async () => {
  dom();
  let packages = [{ id: 'live', enabled: true, release: 'one', ui: { entry: 'ui.mjs' } }];
  globalThis.fetch = async input => String(input).endsWith('/packages')
    ? Response.json({ revision: 1, packages })
    : Response.json({ code: packages[0].release, release: packages[0].release, tools: [] });
  const activated: string[] = [];
  const disposed: string[] = [];
  const runtime = createPluginUiRuntime(async code => ({ default: ctx => {
    activated.push(code);
    ctx.mount('#metric', () => {
      const node = document.createElement('b'); node.textContent = code; return node;
    });
    ctx.onCleanup(() => { disposed.push(code); });
    if (code === 'broken') throw new Error('Test activation failed');
  } }));
  await runtime.refresh();
  await runtime.refresh();
  assert.deepEqual(activated, ['one']);
  packages[0].release = 'two';
  await runtime.refresh();
  assert.deepEqual(disposed, ['one']);
  assert.equal(document.querySelector('#metric b')!.textContent, 'two');
  packages[0].release = 'broken';
  await runtime.refresh();
  assert.deepEqual(disposed, ['one', 'two', 'broken']);
  assert.equal(document.querySelector('#metric b'), null);
  assert.match(runtime.status('live')!, /activation failed/);
  await runtime.refresh();
  assert.deepEqual(activated, ['one', 'two', 'broken']);
  packages[0].release = 'fixed';
  await runtime.refresh();
  assert.equal(runtime.status('live'), null);
  packages[0].enabled = false;
  await runtime.refresh();
  assert.equal(document.querySelector('#metric b'), null);
  assert.deepEqual(disposed, ['one', 'two', 'broken', 'fixed']);
  runtime.stop();
});

test('a release disabled during module loading never activates; stop cleans late async cleanup', async () => {
  dom();
  let enabled = true;
  globalThis.fetch = async input => String(input).endsWith('/packages')
    ? Response.json({ revision: 1, packages: [{ id: 'race', enabled, release: 'one', ui: { entry: 'ui.mjs' } }] })
    : Response.json({ code: '', release: 'one', tools: [] });
  let called = false;
  const revoked = createPluginUiRuntime(async () => {
    enabled = false;
    return { default: () => { called = true; } };
  });
  await revoked.refresh();
  assert.equal(called, false);
  revoked.stop();

  enabled = true;
  let finish: (cleanup: () => void) => void = () => {};
  let ready: () => void = () => {};
  const activated = new Promise<void>(resolve => { ready = resolve; });
  let cleaned = 0;
  const runtime = createPluginUiRuntime(async () => ({ default: ctx => {
    ctx.mount('#metric', () => document.createElement('b'));
    ready();
    return new Promise<() => void>(resolve => { finish = resolve; });
  } }));
  const refresh = runtime.refresh();
  await activated;
  runtime.stop();
  assert.equal(document.querySelector('#metric b'), null);
  finish(() => { cleaned++; });
  await refresh;
  assert.equal(cleaned, 1);
});
