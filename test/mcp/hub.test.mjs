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
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

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
  let host = http.createServer(app);
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${host.address().port}`;
  const headers = { 'X-Minnow-Token': token, 'X-Minnow-Workspace': workspace };
  const clients = [];
  let existingStdio;
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
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { 'X-Minnow-Token': token } })).status, 406);
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
  await t.test('MCP edits and comments mark linked content pending for GitHub sync', async () => {
    await updateIssuesResource(state => {
      const row = state.issues.find(row => row.id === issue.id);
      row.github = { number: 1, url: 'https://github.com/example/repo/issues/1',
        syncedAt: row.updatedAt + 10_000, localUpdatedAt: row.updatedAt + 10_000, localChangedAt: row.updatedAt + 10_000 };
      return state;
    });
    const before = json(await call('issue_get', { issue_id: issue.id }));
    const edited = json(await call('issue_edit', { issue_id: issue.id, description: 'Changed through MCP' }));
    assert.ok(edited.github.localChangedAt > before.github.localUpdatedAt);
    assert.equal(edited.github.localChangedAt, edited.updatedAt);
    assert.equal(edited.github.localUpdatedAt, before.github.localUpdatedAt);
    const noop = json(await call('issue_edit', { issue_id: issue.id, description: edited.description }));
    assert.equal(noop.github.localChangedAt, edited.github.localChangedAt);
    json(await call('issue_comment', { issue_id: issue.id, body: 'Do not discard on mirror sync' }));
    const commented = json(await call('issue_get', { issue_id: issue.id }));
    assert.equal(commented.github.localChangedAt, commented.updatedAt);
    assert.ok(commented.github.localChangedAt > edited.github.localChangedAt);
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
    assert.equal(saved.issues[0].comments.length, baseline.issues[0].comments.length + 1);
    const collision = structuredClone(baseline);
    collision.issues.push({ ...created[0], title: 'Conflicting creation' });
    const merged = await mergeIssuesResource(baseline, collision);
    assert.equal(merged.issues.find(card => card.id === created[0].id)?.title, created[0].title);
    const rekeyed = merged.issues.find(card => card.title === 'Conflicting creation');
    assert.ok(rekeyed);
    assert.notEqual(rekeyed.id, created[0].id);
    assert.equal(new Set(merged.issues.map(card => card.id)).size, merged.issues.length);
  });
  await t.test('Brain round trip and read-only enforcement', async () => {
    const writeTool = (await client.listTools()).tools.find(tool => tool.name === 'brain_write_page');
    assert.ok(writeTool.inputSchema.properties.expectedRevision);
    assert.notEqual((await call('brain_write_page', { path: 'facts/mcp-test.md', title: 'MCP fact', body: 'External agents share this knowledge.' })).isError, true);
    const page = await call('brain_read_page', { path: 'facts/mcp-test.md' });
    assert.match(page.content[0].text, /External agents share this knowledge/);
    const revision = page.content[0].text.match(/^revision: ([a-f0-9]{64})$/m)?.[1];
    assert.ok(revision);
    assert.notEqual((await call('brain_write_page', {
      path: 'facts/mcp-test.md', title: 'MCP fact', body: 'Updated knowledge.', expectedRevision: revision,
    })).isError, true);
    const stale = await call('brain_write_page', {
      path: 'facts/mcp-test.md', title: 'MCP fact', body: 'Stale knowledge.', expectedRevision: revision,
    });
    assert.equal(stale.isError, true);
    assert.match((await call('brain_read_page', { path: 'facts/mcp-test.md' })).content[0].text, /Updated knowledge\./);
    assert.equal((await call('brain_write_page', { path: '../../escape.md', title: 'Escape', body: 'No' })).isError, true);
    const readOnly = await clientFor(workspace, '?readOnly=1');
    const names = (await readOnly.listTools()).tools.map(tool => tool.name);
    assert.ok(!names.includes('issue_create'));
    assert.ok(!names.includes('brain_write_page'));
    assert.equal((await readOnly.callTool({ name: 'issue_create', arguments: { title: 'No' } })).isError, true);
  });
  await t.test('stdio CLI interoperates with a real SDK client', async () => {
    const stdio = new Client({ name: 'external-agent', version: '1' });
    existingStdio = stdio;
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
  await t.test('one agent credential routes concurrent calls without workspace configuration', async () => {
    const response = await fetch(`${base}/api/mcp/hub/connections`, {
      method: 'POST', headers: { 'X-Minnow-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mobile agent', access: 'write' }),
    });
    assert.equal(response.status, 201);
    const { token: agentToken, connection } = await response.json();
    assert.equal(connection.workspace, null);
    const agent = new Client({ name: 'mobile-agent', version: '1' });
    clients.push(agent);
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/hub`), {
      requestInit: { headers: { 'X-Minnow-Token': agentToken } },
    }));
    assert.ok((await agent.listTools()).tools.find(tool => tool.name === 'issue_create').inputSchema.properties.workspace_path);
    const invoke = (name, args) => agent.callTool({ name, arguments: args });
    assert.equal((await invoke('issue_create', { title: 'Missing workspace' })).isError, true);
    assert.equal((await invoke('issue_create', { title: 'Relative', workspace_path: '.' })).isError, true);
    assert.equal((await invoke('issue_create', { title: 'Unknown', workspace_path: path.join(home, 'unknown') })).isError, true);
    const [first, second] = await Promise.all([
      invoke('issue_create', { title: 'Agent first', workspace_path: workspace }).then(json),
      invoke('issue_create', { title: 'Agent second', workspace_path: otherWorkspace }).then(json),
    ]);
    assert.equal(json(await invoke('issue_get', { issue_id: first.id, workspace_path: workspace })).title, 'Agent first');
    assert.equal(json(await invoke('issue_get', { issue_id: second.id, workspace_path: otherWorkspace })).title, 'Agent second');
    assert.equal((await invoke('issue_get', { issue_id: first.id, workspace_path: otherWorkspace })).isError, true);
    assert.equal((await fetch(`${base}/api/config/ping`, { headers: { 'X-Minnow-Token': agentToken } })).status, 401);
    const scopedList = await (await fetch(`${base}/api/mcp/hub/connections`, { headers: { ...headers, 'X-Minnow-Workspace': otherWorkspace } })).json();
    assert.ok(scopedList.connections.some(row => row.id === connection.id));
    const { createPage } = await import('../../server/brain/store.js');
    const { brainWorkspaceKeyFromPath } = await import('../../server/brain/paths.js');
    await createPage({ relPath: `workspaces/${brainWorkspaceKeyFromPath(workspace)}/scope-proof.md`, title: 'MCPscopeproof first', body: 'MCPscopeproof first-workspace knowledge.' });
    await createPage({ relPath: `workspaces/${brainWorkspaceKeyFromPath(otherWorkspace)}/scope-proof.md`, title: 'MCPscopeproof second', body: 'MCPscopeproof second-workspace knowledge.' });
    const searches = await Promise.all([workspace, otherWorkspace].map(workspace_path => invoke('brain_search', { query: 'MCPscopeproof', workspace_path })));
    for (const result of searches) assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(searches[0].content[0].text, /first-workspace knowledge/);
    assert.doesNotMatch(searches[0].content[0].text, /second-workspace knowledge/);
    assert.match(searches[1].content[0].text, /second-workspace knowledge/);
    assert.doesNotMatch(searches[1].content[0].text, /first-workspace knowledge/);
    const readResponse = await fetch(`${base}/api/mcp/hub/connections`, {
      method: 'POST', headers: { 'X-Minnow-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mobile reader', access: 'read' }),
    });
    const { token: readToken } = await readResponse.json();
    const reader = new Client({ name: 'mobile-reader', version: '1' });
    clients.push(reader);
    await reader.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/hub?readOnly=0`), {
      requestInit: { headers: { 'X-Minnow-Token': readToken } },
    }));
    assert.ok(!(await reader.listTools()).tools.some(tool => tool.name === 'issue_create'));
    assert.equal((await reader.callTool({ name: 'issue_create', arguments: { title: 'Denied', workspace_path: otherWorkspace } })).isError, true);
    await fetch(`${base}/api/mcp/hub/connections?id=${connection.id}`, { method: 'DELETE', headers });
    await assert.rejects(agent.listTools());
  });
  await t.test('stdio follows changing agent roots and rejects ambiguous roots', async () => {
    let roots = [{ uri: pathToFileURL(workspace).href }];
    const agent = new Client({ name: 'root-agent', version: '1' }, { capabilities: { roots: { listChanged: true } } });
    agent.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
    clients.push(agent);
    await agent.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('bin/minnow.mjs'), 'mcp', '--base-url', base],
      env: { ...process.env, MINNOW_HOME: home }, stderr: 'pipe' }));
    const invoke = (args = {}) => agent.callTool({ name: 'issue_get', arguments: { issue_id: issue.id, ...args } });
    assert.equal(json(await invoke()).id, issue.id);
    roots = [{ uri: pathToFileURL(otherWorkspace).href }];
    assert.equal((await invoke()).isError, true);
    roots.push({ uri: pathToFileURL(workspace).href });
    assert.match((await invoke()).content[0].text, /multiple or no workspace roots/);
    assert.equal(json(await invoke({ workspace_path: workspace })).id, issue.id);
    roots = [];
    assert.equal((await invoke()).isError, true);
  });
  await t.test('stdio uses the agent launch directory when roots are unsupported', async () => {
    const agent = new Client({ name: 'cwd-agent', version: '1' });
    clients.push(agent);
    await agent.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('bin/minnow.mjs'), 'mcp', '--base-url', base], cwd: workspace,
      env: { ...process.env, MINNOW_HOME: home }, stderr: 'pipe' }));
    assert.equal(json(await agent.callTool({ name: 'issue_get', arguments: { issue_id: issue.id } })).id, issue.id);
  });
  await t.test('persistent capabilities survive restart and enforce scope, access and revocation', async () => {
    const { resetSessionTokenCache } = await import('../../server/runtime/session-token.js');
    const endpoint = `${base}/api/mcp/hub/connections`;
    const create = async (body, authHeaders = headers) => fetch(endpoint, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspaceScope: 'workspace' }),
    });
    const { createDevice } = await import('../../server/auth/device-store.js');
    const device = createDevice('Companion');
    const deviceHeaders = { ...headers, 'X-Minnow-Token': device.token };
    assert.equal((await fetch(endpoint, { headers: deviceHeaders })).status, 403);
    assert.equal((await create({ name: 'Device-created', access: 'write' }, deviceHeaders)).status, 403);
    assert.equal((await fetch(`${endpoint}?id=anything`, { method: 'DELETE', headers: deviceHeaders })).status, 403);
    assert.equal((await create({ name: 'bad', access: 'admin' })).status, 400);
    assert.equal((await create({ name: ' ', access: 'read' })).status, 400);
    const created = await create({ name: 'External reader', access: 'read', workspace: otherWorkspace });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const { token: persistentToken, connection } = await created.json();
    const capabilityHeaders = { ...headers, 'X-Minnow-Token': persistentToken };
    const reader = new Client({ name: 'persistent-reader', version: '1' });
    clients.push(reader);
    await reader.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/hub?readOnly=0`), { requestInit: { headers: capabilityHeaders } }));
    const names = (await reader.listTools()).tools.map(tool => tool.name);
    assert.ok(!names.includes('issue_create'));
    assert.ok(!names.includes('brain_write_page'));
    assert.equal((await reader.callTool({ name: 'issue_create', arguments: { title: 'Denied' } })).isError, true);
    assert.equal((await reader.callTool({ name: 'issue_list', arguments: { workspace_path: otherWorkspace } })).isError, true);
    assert.equal((await reader.callTool({ name: 'brain_write_page', arguments: { path: 'facts/denied.md', title: 'Denied', body: 'Denied' } })).isError, true);
    for (const route of ['/api/config/ping', '/api/mcp/hub/info', '/api/mcp/hub/connections', '/api/streams/ws']) {
      assert.equal((await fetch(`${base}${route}`, { headers: capabilityHeaders })).status, 401);
    }
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { ...capabilityHeaders, 'X-Minnow-Workspace': otherWorkspace } })).status, 401);
    assert.equal((await fetch(`${base}/api/mcp/hub?workspace=${encodeURIComponent(otherWorkspace)}`, { headers: { 'X-Minnow-Token': persistentToken } })).status, 401);
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { 'X-Minnow-Token': persistentToken } })).status, 401);
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { ...capabilityHeaders, Origin: 'https://evil.example' } })).status, 403);
    const listed = await (await fetch(endpoint, { headers })).json();
    assert.ok(listed.connections[0].lastUsedAt);
    assert.ok(!JSON.stringify(listed).includes(persistentToken));
    assert.ok(!JSON.stringify(listed).includes('tokenHash'));
    const disk = await fs.readFile(path.join(home, 'auth', 'mcp-connections.json'), 'utf8');
    assert.ok(!disk.includes(persistentToken));
    assert.match(disk, /tokenHash/);
    // Restart the HTTP host on the same port and rotate its per-boot session token.
    const port = host.address().port;
    host.closeAllConnections();
    await new Promise(resolve => host.close(resolve));
    resetSessionTokenCache();
    const newHostToken = getSessionToken();
    assert.notEqual(newHostToken, token);
    host = http.createServer(app);
    await new Promise(resolve => host.listen(port, '127.0.0.1', resolve));
    assert.ok((await reader.listTools()).tools.some(tool => tool.name === 'issue_get'));
    assert.ok((await existingStdio.listTools()).tools.some(tool => tool.name === 'issue_get'), 'existing stdio reads the rotated token without reconnecting');
    assert.equal((await fetch(`${base}/api/mcp/hub/info`, { headers })).status, 401);
    const currentHeaders = { ...headers, 'X-Minnow-Token': newHostToken };
    // Stdio continues to read the newly rotated token file.
    const bridge = new Client({ name: 'after-restart', version: '1' });
    clients.push(bridge);
    await bridge.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/minnow.mjs'), 'mcp', '--base-url', base, '--workspace', workspace], env: { ...process.env, MINNOW_HOME: home }, stderr: 'pipe' }));
    assert.ok((await bridge.listTools()).tools.some(tool => tool.name === 'issue_create'));
    const replaced = await (await create({ replaceId: connection.id, access: 'write', workspace: otherWorkspace }, currentHeaders)).json();
    assert.equal(replaced.connection.access, 'read');
    assert.notEqual(replaced.token, persistentToken);
    await assert.rejects(reader.listTools());
    const newReader = new Client({ name: 'replacement', version: '1' });
    clients.push(newReader);
    await newReader.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/hub`), { requestInit: { headers: { ...capabilityHeaders, 'X-Minnow-Token': replaced.token } } }));
    assert.ok(!(await newReader.listTools()).tools.some(tool => tool.name === 'issue_create'));
    assert.equal((await fetch(`${endpoint}?id=${connection.id}`, { method: 'DELETE', headers: { ...currentHeaders, 'X-Minnow-Workspace': otherWorkspace } })).status, 404);
    assert.equal((await fetch(`${endpoint}?id=${connection.id}`, { method: 'DELETE', headers: currentHeaders })).status, 200);
    await assert.rejects(newReader.listTools());
    assert.equal((await fetch(`${base}/api/mcp/hub`, { headers: { ...capabilityHeaders, 'X-Minnow-Token': replaced.token } })).status, 401);
    const writerResult = await create({ name: 'Writer', access: 'write' }, currentHeaders);
    const writerToken = (await writerResult.json()).token;
    const writer = new Client({ name: 'persistent-writer', version: '1' });
    clients.push(writer);
    await writer.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/hub`), { requestInit: { headers: { ...headers, 'X-Minnow-Token': writerToken } } }));
    assert.notEqual((await writer.callTool({ name: 'issue_create', arguments: { title: 'Persistent writer' } })).isError, true);
  });
});
