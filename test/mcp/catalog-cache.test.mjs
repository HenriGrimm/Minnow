import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { listEnabledMcpTools, listMcpToolCatalog, callMcpTool, reloadMcp, refreshMcpServer,
  getMcpCatalogRevision, subscribeMcpCatalogChanges, listServers, ensureMcpSeed } from '../../server/mcp/registry.js';
import { createMcpMiddleware } from '../../server/mcp/middleware.js';

// Real stdio protocol, including pagination and list-change notifications.
const fixture = `
  const fs = require('node:fs');
  const readline = require('node:readline');
  const [events, control] = process.argv.slice(1);
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    fs.appendFileSync(events, request.method + '\\n');
    const state = JSON.parse(fs.readFileSync(control, 'utf8'));
    if (request.method === 'initialize' && !state.failInitialize) {
      send({ id: request.id, result: { protocolVersion: request.params.protocolVersion,
        capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'cache-fixture', version: '1' } } });
    } else if (request.method === 'tools/list' && !state.failList) {
      const page = request.params?.cursor ? 2 : 1;
      if (page === 1 && state.changeDuringList) {
        fs.writeFileSync(control, JSON.stringify({ version: state.version + 1 }));
        send({ method: 'notifications/tools/list_changed' });
      }
      send({ id: request.id, result: { tools: [{ name: 'tool_' + (state.version || 1) + '_' + page,
        inputSchema: { type: 'object' } }], ...(page === 1 ? { nextCursor: 'second' } : {}) } });
    } else if (request.method === 'tools/call') {
      if (!state.noNotifications) send({ method: 'notifications/tools/list_changed' });
      send({ id: request.id, result: { content: [{ type: 'text', text: 'changed' }] } });
      if (request.params.arguments?.disconnect) setImmediate(() => process.exit(0));
    } else send({ id: request.id, error: { code: -32603, message: 'fixture unavailable' } });
  });
`;

test('MCP discovery only refreshes on notification, configuration, explicit refresh or reload', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-mcp-cache-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  const events = path.join(home, 'events');
  const control = path.join(home, 'control.json');
  const indexPath = path.join(home, 'mcp.json');
  const config = { command: process.execPath, args: ['-e', fixture, events, control] };
  const writeConfig = () => fs.writeFile(indexPath, JSON.stringify({ mcpServers: { cache: config } }));
  const count = async method => (await fs.readFile(events, 'utf8')).split('\n').filter(line => line === method).length;
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const changes = [];
  const unsubscribe = subscribeMcpCatalogChanges(revision => changes.push(revision));
  try {
    await fs.writeFile(control, '{}');
    await writeConfig();
    await reloadMcp();
    const listings = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      i % 2 ? listEnabledMcpTools() : listMcpToolCatalog()));
    assert.equal(await count('initialize'), 1);
    assert.equal(await count('tools/list'), 2, 'initial connection must not discover twice');
    assert.equal(listings[0][0].tools.length, 2);
    assert.ok(listings[1].some(row => row.function.name === 'mcp__cache__tool_1_2'));
    await listEnabledMcpTools();
    assert.equal(await count('tools/list'), 2);

    await fs.writeFile(control, JSON.stringify({ version: 2 }));
    const revision = getMcpCatalogRevision();
    assert.equal(await callMcpTool('mcp__cache__tool_1_1', {}), 'changed');
    assert.notEqual(getMcpCatalogRevision(), revision);
    assert.equal(changes.at(-1), getMcpCatalogRevision());
    assert.ok((await listEnabledMcpTools()).some(row => row.function.name === 'mcp__cache__tool_2_2'));
    assert.equal(await count('tools/list'), 4, 'notification invalidates all pages immediately');

    clock += 24 * 60 * 60 * 1000;
    await Promise.all([listEnabledMcpTools(), listMcpToolCatalog(), listEnabledMcpTools()]);
    assert.equal(await count('tools/list'), 4, 'elapsed time never triggers discovery');

    await fs.writeFile(control, JSON.stringify({ failList: true }));
    await callMcpTool('mcp__cache__tool_2_1', {});
    await Promise.all([listEnabledMcpTools(), listMcpToolCatalog()]);
    clock += 24 * 60 * 60 * 1000;
    await listEnabledMcpTools();
    assert.equal(await count('tools/list'), 5, 'failed discovery waits for a change or explicit retry');
    assert.equal(warnings.length, 1, 'unchanged errors are reported once');

    await fs.writeFile(control, '{}');
    await refreshMcpServer('cache');
    await listEnabledMcpTools();
    assert.equal(await count('tools/list'), 7, 'explicit retry clears a failed listing');
    await reloadMcp();
    assert.ok((await listEnabledMcpTools()).some(row => row.function.name === 'mcp__cache__tool_1_2'));
    assert.equal(await count('tools/list'), 9, 'reload clears catalog freshness');
    config.disabled = true;
    await writeConfig();
    assert.deepEqual((await listEnabledMcpTools()).map(row => row.function.name), ['mcp__minnow__add_servers']);
    assert.match(await callMcpTool('mcp__cache__tool_1_1', {}), /disabled/);
    assert.equal(await count('tools/list'), 9, 'disable is checked independently of the catalog cache');

    delete config.disabled;
    await writeConfig();
    await reloadMcp();
    await fs.writeFile(control, JSON.stringify({ failInitialize: true }));
    const before = await count('initialize');
    await Promise.all([listEnabledMcpTools(), listMcpToolCatalog()]);
    await listEnabledMcpTools();
    assert.equal(await count('initialize'), before + 1, 'failed connections are shared');
    clock += 24 * 60 * 60 * 1000;
    await listEnabledMcpTools();
    assert.equal(await count('initialize'), before + 1, 'failed connections never retry on elapsed time');
    config.args.push('changed-config');
    await writeConfig();
    await listEnabledMcpTools();
    assert.equal(await count('initialize'), before + 2, 'changed configuration retries discovery');
    await refreshMcpServer('cache');
    await listEnabledMcpTools();
    assert.equal(await count('initialize'), before + 3, 'explicit refresh retries failed connections');

    await fs.writeFile(control, JSON.stringify({ noNotifications: true }));
    await refreshMcpServer('cache');
    await listEnabledMcpTools();
    const beforeSilentChange = await count('tools/list');
    await fs.writeFile(control, JSON.stringify({ noNotifications: true, version: 3 }));
    await callMcpTool('mcp__cache__tool_1_1', {});
    await listEnabledMcpTools();
    assert.equal(await count('tools/list'), beforeSilentChange, 'non-notifying servers retain their catalog');
    await refreshMcpServer('cache');
    assert.ok((await listEnabledMcpTools()).some(row => row.function.name === 'mcp__cache__tool_3_2'));

    const disconnected = new Promise(resolve => {
      const stop = subscribeMcpCatalogChanges(() => { stop(); resolve(); });
    });
    await callMcpTool('mcp__cache__tool_3_1', { disconnect: true });
    await disconnected;
    assert.equal((await listServers())[0].connected, false);
    const beforeReconnect = await count('tools/list');
    await listEnabledMcpTools();
    assert.equal(await count('tools/list'), beforeReconnect + 2, 'a disconnected client rediscovers on connection');

    await fs.writeFile(control, JSON.stringify({ version: 4, changeDuringList: true }));
    await refreshMcpServer('cache');
    const beforeInFlightChange = await count('tools/list');
    const afterChange = await Promise.all([listEnabledMcpTools(), listMcpToolCatalog()]);
    assert.equal(await count('tools/list'), beforeInFlightChange + 4, 'a notification during pagination refreshes once more');
    assert.deepEqual(afterChange[1][0].tools.map(tool => tool.name), ['tool_5_1', 'tool_5_2']);

    const peerEvents = path.join(home, 'peer-events');
    await fs.writeFile(indexPath, JSON.stringify({ mcpServers: {
      cache: config,
      peer: { command: process.execPath, args: ['-e', fixture, peerEvents, control] },
    } }));
    await listEnabledMcpTools();
    const peerBefore = await fs.readFile(peerEvents, 'utf8');
    await refreshMcpServer('cache');
    assert.equal((await listServers()).find(server => server.id === 'peer').connected, true);
    await listEnabledMcpTools();
    assert.equal(await fs.readFile(peerEvents, 'utf8'), peerBefore, 'refreshing one server leaves its peer connected and cached');
  } finally {
    unsubscribe();
    await reloadMcp();
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('MCP events publish revisions without discovery and expose an explicit server refresh', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-mcp-events-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  class Response extends EventEmitter {
    chunks = [];
    writableLength = 0;
    writeHead(status) { this.statusCode = status; }
    setHeader() {}
    write(chunk) { this.chunks.push(chunk); }
    end(chunk) { if (chunk) this.write(chunk); }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const middleware = createMcpMiddleware();
  const stream = new Response();
  const route = async (url, method = 'GET') => {
    const response = new Response();
    await middleware({ url, method }, response, () => assert.fail('Unexpected next middleware'));
    return response;
  };
  try {
    await ensureMcpSeed();
    await fs.writeFile(path.join(home, 'mcp.json'), JSON.stringify({ servers: { fixture: { enabled: true } } }));
    await reloadMcp();
    await middleware({ url: '/api/mcp/events', method: 'GET' }, stream, () => assert.fail());
    assert.equal(stream.statusCode, 200);
    assert.deepEqual(JSON.parse(stream.chunks[0].slice(6)), { revision: getMcpCatalogRevision() });
    assert.equal((await listServers())[0].connected, false, 'subscribing must not discover tools');
    const tools = await route('/api/mcp/tools');
    assert.equal(JSON.parse(tools.chunks[0]).revision, getMcpCatalogRevision());
    assert.ok(JSON.parse(tools.chunks[0]).tools.some(tool => tool.function.name === 'mcp__fixture__echo'));
    assert.equal((await listServers())[0].connected, true);
    assert.equal(stream.chunks.length, 1, 'unchanged reads produce no events');
    const retry = await route('/api/mcp/servers/fixture/refresh', 'POST');
    assert.equal(retry.statusCode, 200);
    assert.equal(stream.chunks.length, 2);
    assert.equal((await listServers())[0].connected, false);
    assert.equal((await route('/api/mcp/servers/missing/refresh', 'POST')).statusCode, 400);
    stream.destroy();
    await reloadMcp();
    assert.equal(stream.chunks.length, 2, 'closed subscriptions stop receiving revisions');
  } finally {
    stream.destroy();
    await reloadMcp();
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  }
});
