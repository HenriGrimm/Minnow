import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Window } from 'happy-dom';
import { buildHubConfig, type McpHubInfo } from '../../src/mcp/hub-config.ts';

let workspace = 'C:/Projects/example';
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => workspace } });
mock.module('../../src/api/session-token.ts', { namedExports: { getSessionToken: () => 'test-private-token' } });
const { renderMcpHubSettingsSection } = await import('../../src/ui/settings-mcp-hub.ts');
const info: McpHubInfo = {
  workspace, endpoint: '/api/mcp/hub', stdio: { command: 'node', cliPath: 'C:/Minnow/bin/minnow.mjs', home: 'C:/Minnow data' },
  tools: [{ name: 'issue_get', description: 'Read issue', readOnly: true }, { name: 'issue_create', description: 'Create issue', readOnly: false }],
};

test('hub settings: configuration, read-only, clipboard, failures and workspace changes', async () => {
  const win = new Window({ url: 'http://localhost:9479' });
  const before = { document: globalThis.document, window: globalThis.window, navigator: globalThis.navigator, fetch: globalThis.fetch };
  let copied = '';
  Object.assign(globalThis, { document: win.document, window: win });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied = text; } } } });
  globalThis.fetch = async () => new Response(JSON.stringify(info));
  try {
    document.body.innerHTML = '<div id="settingsMcpHubBody"></div>';
    await renderMcpHubSettingsSection();
    assert.match(document.body.textContent!, /Ready to connect/);
    assert.ok(!document.body.textContent!.includes('test-private-token'));
    assert.match(document.querySelector('pre')!.textContent!, /localhost:9479/);
    const access = document.querySelector<HTMLSelectElement>('#mcpHubAccess')!;
    access.value = 'read';
    access.dispatchEvent(new win.Event('change') as unknown as Event);
    assert.equal(document.querySelectorAll('.mcp-hub-tool').length, 1);
    assert.match(document.querySelector('pre')!.textContent!, /readOnly=1/);
    const copy = document.querySelector<HTMLButtonElement>('.mcp-hub-actions button')!;
    copy.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(JSON.parse(copied).mcpServers.minnow.headers['X-Minnow-Token'], 'test-private-token');
    assert.equal(copy.disabled, false);
    const method = document.querySelector<HTMLSelectElement>('#mcpHubTransport')!;
    method.value = 'stdio';
    method.dispatchEvent(new win.Event('change') as unknown as Event);
    copy.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(JSON.parse(copied).mcpServers.minnow.args.includes('--read-only'));
    assert.equal(JSON.parse(copied).mcpServers.minnow.env.MINNOW_HOME, 'C:/Minnow data');
    assert.ok(!copied.includes('test-private-token'));
    workspace = '/new-workspace';
    copy.click();
    assert.match(document.body.textContent!, /Workspace changed/);
    workspace = '';
    await renderMcpHubSettingsSection();
    assert.match(document.body.textContent!, /Open a project folder/);
    assert.equal(document.querySelector('.mcp-hub-actions'), null);
    workspace = info.workspace;
    globalThis.fetch = async () => new Response('unavailable', { status: 404 });
    await renderMcpHubSettingsSection();
    assert.match(document.body.textContent!, /Open or restart Minnow/);
    globalThis.fetch = async () => new Response(JSON.stringify({ ...info, stdio: null }));
    await renderMcpHubSettingsSection();
    assert.equal(document.querySelectorAll('#mcpHubTransport option').length, 1);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('denied'); } } } });
    document.querySelector<HTMLButtonElement>('.mcp-hub-actions button')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(document.body.textContent!, /Could not copy/);
    assert.equal(document.querySelector<HTMLButtonElement>('.mcp-hub-actions button')!.disabled, false);
  } finally {
    Object.assign(globalThis, { document: before.document, window: before.window, fetch: before.fetch });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: before.navigator });
    await win.happyDOM.close();
  }
});

test('hub configuration preserves spaces, port and workspace; rejects remote stdio', () => {
  const config = JSON.parse(buildHubConfig(info, 'http://localhost:9499', 'stdio', false, 'private'));
  assert.deepEqual(config.mcpServers.minnow.args, ['C:/Minnow/bin/minnow.mjs', 'mcp', '--workspace', info.workspace, '--base-url', 'http://localhost:9499']);
  assert.throws(() => buildHubConfig(info, 'https://remote.example', 'stdio', false, 'private'), /Use HTTP/);
});
