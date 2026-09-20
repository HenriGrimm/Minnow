import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import connect from 'connect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP hub: authenticated HTTP and stdio share live workspace Issues and Brain', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-mcp-hub-'));
  process.env.MINNOW_HOME = home;
  const { createAuthMiddleware } = await import('../../server/runtime/auth-middleware.js');
  const { createWorkspaceScopeMiddleware } = await import('../../server/runtime/workspace-scope-middleware.js');
  const { createMcpHubMiddleware } = await import('../../server/mcp-hub/middleware.js');
  const { createConfigMiddleware } = await import('../../server/config/middleware.js');
  const { getSessionToken } = await import('../../server/runtime/session-token.js');
  const { openWorkspace } = await import('../../server/workspace/open-workspaces.js');
  const { readResource, mergeIssuesResource, updateIssuesResource } = await import('../../server/config/store.js');
  const workspace = openWorkspace(path.join(home, 'project'));
  const otherWorkspace = openWorkspace(path.join(home, 'other'));
  await fs.mkdir(workspace);
  await fs.mkdir(otherWorkspace);
  const token = getSessionToken();
  const app = connect().use(createAuthMiddleware()).use(createWorkspaceScopeMiddleware()).use(createMcpHubMiddleware()).use(createConfigMiddleware());
  const host = http.createServer(app);
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${host.address().port}`;
  const headers = { 'X-Minnow-Token': token, 'X-Minnow-Workspace': workspace };
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    host.closeAllConnections();
    await new Promise(resolve => host.close(resolve));
    const { closeCodeDbForTests } = await import('../../server/brain/code/schema.js');
    closeCodeDbForTests();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function clientFor(ws = workspace, suffix = '') {
    const client = new Client({ name: 'test-agent', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/hub${suffix}`), {
      requestInit: { headers: { ...headers, 'X-Minnow-Workspace': ws } },
    }));
    return client;
  }
  const client = await clientFor();
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const json = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };

  await t.test('auth, origin and explicit workspace gates', async () => {
    assert.equal((await fetch(`${base}/api/mcp/hub`)).status, 401);
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { 'X-Minnow-Token': token } })).status, 400);
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { ...headers, 'X-Minnow-Workspace': path.join(home, 'unknown') } })).status, 400);
  });
  await t.test('settings metadata is authenticated, workspace-bound and contains no credential', async () => {
    assert.equal((await fetch(`${base}/api/mcp/hub/info`)).status, 401);
    const response = await fetch(`${base}/api/mcp/hub/info`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.ok(!body.includes(token));
    const info = JSON.parse(body);
    assert.equal(info.workspace, workspace);
    assert.ok(info.tools.some(tool => tool.name === 'issue_create' && !tool.readOnly));
    assert.equal(info.stdio.cliPath, path.resolve('bin/minnow.mjs'));
    assert.equal(info.stdio.home, home);
  });
  await t.test('curated schemas and runtime validation', async () => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('brain_write_page'));
    assert.ok(names.includes('issue_create'));
    assert.ok(names.includes('minnow_docs_search'));
    assert.ok(!names.includes('execute_command'));
    assert.equal((await call('execute_command', { command: 'echo unsafe' })).isError, true);
    assert.equal((await call('issue_create', { title: ' ' })).isError, true);
    assert.equal((await call('issue_create', { title: 'bad', workspacePath: otherWorkspace })).isError, true);
    assert.equal((await call('issue_list', { limit: -1 })).isError, true);
  });
  let issue;
  await t.test('create, edit, comment, pagination, taxonomy and isolation', async () => {
    issue = json(await call('issue_create', { title: 'Shared task', description: 'From MCP' }));
    assert.equal(issue.source, 'agent');
    const taxonomy = json(await call('issue_taxonomy'));
    assert.ok(taxonomy.statuses.some(row => row.id === issue.status));
    assert.equal(json(await call('issue_list', { query: 'shared' })).total, 1);
    assert.equal(json(await call('issue_list', { offset: 1 })).issues.length, 0);
    const edited = json(await call('issue_edit', { issue_id: issue.id, title: 'Edited task', expected_updated_at: issue.updatedAt }));
    assert.equal(edited.title, 'Edited task');
    assert.equal((await call('issue_edit', { issue_id: issue.id, title: 'Stale', expected_updated_at: issue.updatedAt })).isError, true);
    assert.equal((await call('issue_edit', { issue_id: issue.id, status: 'invalid' })).isError, true);
    json(await call('issue_comment', { issue_id: issue.id, body: 'Working on it', author: 'Test agent' }));
    assert.equal(json(await call('issue_get', { issue_id: issue.id })).comments[0].authorKind, 'agent');
    const other = await clientFor(otherWorkspace);
    assert.equal(json(await other.callTool({ name: 'issue_list', arguments: {} })).total, 0);
    assert.equal((await other.callTool({ name: 'issue_edit', arguments: { issue_id: issue.id, title: 'Cross workspace' } })).isError, true);
    assert.equal((await other.callTool({ name: 'issue_get', arguments: { issue_id: issue.id } })).isError, true);
    await updateIssuesResource(state => ({ ...state, projects: [{ id: 'project-1', name: 'Shared project', createdAt: 1, updatedAt: 1 }] }));
    assert.equal(json(await call('issue_projects'))[0].id, 'project-1');
    assert.equal(json(await call('issue_edit', { issue_id: issue.id, project_id: 'project-1' })).projectId, 'project-1');
    assert.equal(json(await call('issue_edit', { issue_id: issue.id, project_id: null })).projectId, undefined);
  });
  await t.test('concurrent creation and stale renderer saves preserve independent changes', async () => {
    const baseline = await readResource('issues');
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => call('issue_create', { title: `Concurrent ${i}` }).then(json)));
    assert.equal(new Set(created.map(row => row.id)).size, 12);
    const local = structuredClone(baseline);
    local.issues[0].description = 'Unsaved renderer description';
    local.issues[0].updatedAt = Date.now() + 100;
    await call('issue_comment', { issue_id: issue.id, body: 'Concurrent comment' });
    const response = await fetch(`${base}/api/config/issues`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ base: baseline, state: local }) });
    assert.equal(response.status, 200);
    const saved = (await response.json()).data;
    assert.equal(saved.issues.length, 13);
    assert.equal(saved.issues[0].description, 'Unsaved renderer description');
    assert.equal(saved.issues[0].comments.length, 2);
    const collision = structuredClone(baseline);
    collision.issues.push({ ...created[0], title: 'Conflicting creation' });
    await assert.rejects(mergeIssuesResource(baseline, collision), /Issue ID/);
  });
  await t.test('Brain round trip and read-only enforcement', async () => {
    assert.notEqual((await call('brain_write_page', { path: 'facts/mcp-test.md', title: 'MCP fact', body: 'External agents share this knowledge.' })).isError, true);
    const page = await call('brain_read_page', { path: 'facts/mcp-test.md' });
    assert.match(page.content[0].text, /External agents share this knowledge/);
    assert.equal((await call('brain_write_page', { path: '../../escape.md', title: 'Escape', body: 'No' })).isError, true);
    const readOnly = await clientFor(workspace, '?readOnly=1');
    const names = (await readOnly.listTools()).tools.map(tool => tool.name);
    assert.ok(!names.includes('issue_create'));
    assert.ok(!names.includes('brain_write_page'));
    assert.equal((await readOnly.callTool({ name: 'issue_create', arguments: { title: 'No' } })).isError, true);
  });
  await t.test('stdio CLI interoperates with a real SDK client', async () => {
    const stdio = new Client({ name: 'external-agent', version: '1' });
    clients.push(stdio);
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/minnow.mjs'), 'mcp', '--base-url', base, '--workspace', workspace, '--read-only'], env: { ...process.env, MINNOW_HOME: home }, stderr: 'pipe' }));
    assert.ok((await stdio.listTools()).tools.some(tool => tool.name === 'brain_read_page'));
    assert.equal(json(await stdio.callTool({ name: 'issue_get', arguments: { issue_id: issue.id } })).title, 'Edited task');
  });
  await t.test('concurrent Brain writes retain every page and log entry', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call('brain_write_page', {
      path: `facts/concurrent-${i}.md`, title: `Concurrent ${i}`, body: `Knowledge ${i}`,
    })));
    for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result));
    const { listPages } = await import('../../server/brain/store.js');
    assert.equal((await listPages()).filter(page => page.path.startsWith('facts/concurrent-')).length, 8);
    const logs = await Promise.all(Array.from({ length: 8 }, (_, i) => call('brain_append_log', { entry: `external-progress-${i}` })));
    for (const result of logs) assert.notEqual(result.isError, true);
    const log = await fs.readFile(path.join(home, 'brain', 'log.md'), 'utf8');
    for (let i = 0; i < 8; i++) assert.ok(log.includes(`external-progress-${i}`));
  });
});
