import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createAgentCliBridge, buildAgentCliToolCatalog } from '../../server/generations/agent-cli/bridge.js';
import { startMcpShim } from '../../server/generations/agent-cli/mcp-shim.mjs';
import { getUpstreamAgentForTests } from '../../server/generations/upstream-fetch.js';

async function fixture(t, onCall = () => {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'minnow-cli-bridge-test-'));
  const tools = buildAgentCliToolCatalog({ tools: [{ type: 'function', function: {
    name: 'plugin.read/file', description: 'Read one file', parameters: { type: 'object', properties: { path: { type: 'string' } } },
  } }] });
  const bridge = await createAgentCliBridge({ tools, tempDir, onCall });
  t.after(async () => { await bridge.close(); await rm(tempDir, { recursive: true, force: true }); });
  const env = bridge.config.env;
  const request = (payload, headers = {}, url = env.MINNOW_CLI_BRIDGE_URL) => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${env.MINNOW_CLI_BRIDGE_TOKEN}`, ...headers }, body: JSON.stringify(payload),
  });
  return { bridge, tools, env, request };
}

test('bridge rejects wrong credentials, browser origins, paths and tools outside the generation catalog', async t => {
  let calls = 0;
  const { request, env } = await fixture(t, () => { calls++; });
  assert.equal((await request({}, { authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await request({}, { origin: 'http://localhost' })).status, 403);
  assert.equal((await request({}, {}, env.MINNOW_CLI_BRIDGE_URL + '/other')).status, 403);
  assert.equal((await request({ name: 'execute_command', arguments: {} })).status, 400);
  assert.equal((await request({ name: 'tool_0_plugin_read_file', arguments: [] })).status, 400);
  assert.equal(calls, 0);
});

test('bridge preserves parallel calls and returns no execution result', async t => {
  const calls = [];
  let resolveCalls;
  const called = new Promise(resolve => { resolveCalls = resolve; });
  const { bridge, tools, request } = await fixture(t, call => {
    calls.push(call);
    if (calls.length === 2) resolveCalls();
  });
  let settled = false;
  const first = request({ name: tools[0].name, arguments: { path: 'sample.ts' } }).finally(() => { settled = true; });
  const closedRequest = assert.rejects(first);
  const second = request({ name: tools[0].name, arguments: { path: 'other.ts' } });
  const closedSecond = assert.rejects(second);
  await called;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.match(calls[0].id, /^call_/);
  assert.equal(calls[0].function.name, 'plugin.read/file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'sample.ts' });
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { path: 'other.ts' });
  assert.equal(settled, false);
  await bridge.close();
  await closedRequest;
  await closedSecond;
});

test('bridge returns approved tool results and accepts another batch', async t => {
  const calls = [];
  const { bridge, tools, request } = await fixture(t, call => calls.push(call));
  for (let round = 0; round < 2; round += 1) {
    const pending = request({ name: tools[0].name, arguments: { path: `file-${round}` } });
    while (calls.length <= round) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(bridge.resolveCall(calls[round].id, `contents-${round}`), true);
    assert.deepEqual(await (await pending).json(), { content: [{ type: 'text', text: `contents-${round}` }] });
    bridge.resetBatch();
  }
});

test('bridge bounds tool-call payloads before handing off', async t => {
  let calls = 0;
  const { request, tools } = await fixture(t, () => { calls++; });
  assert.equal((await request({ name: tools[0].name, arguments: { text: 'x'.repeat(1024 * 1024) } })).status, 413);
  assert.equal(calls, 0);
});

test('bridge caps an independent handoff batch at eight calls', async t => {
  let resolveCalls;
  let count = 0;
  const received = new Promise(resolve => { resolveCalls = resolve; });
  const { bridge, tools, request } = await fixture(t, () => {
    count += 1;
    if (count === 8) resolveCalls();
  });
  const pending = Array.from({ length: 8 }, (_, index) =>
    assert.rejects(request({ name: tools[0].name, arguments: { path: `file-${index}` } })));
  await received;
  assert.equal((await request({ name: tools[0].name, arguments: { path: 'ninth' } })).status, 409);
  await bridge.close();
  await Promise.all(pending);
});

test('stdio shim negotiates MCP, publishes only supplied tools, and handles malformed requests without crashing', async t => {
  const { env, tools } = await fixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  const replies = new Map();
  const waiters = new Map();
  output.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      replies.set(message.id, message);
      waiters.get(message.id)?.(message);
    }
  });
  const next = id => replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise(resolve => waiters.set(id, resolve));
  const shim = startMcpShim({ env, input, output, fetchImpl: () => { throw new Error('No tool should execute.'); } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  input.write('null\n');
  assert.equal((await next(null)).error.code, -32600);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  assert.equal((await next(1)).result.protocolVersion, '2025-11-25');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  assert.deepEqual((await next(2)).result.tools.map(tool => tool.name), tools.map(tool => tool.name));
  assert.ok(!('originalName' in replies.get(2).result.tools[0]));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'execute_command', arguments: {} } }) + '\n');
  assert.equal((await next(3)).error.code, -32602);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) + '\n');
  assert.deepEqual((await next(4)).result, {});
});

test('stdio handoffs use the timeout-free transport, deliver a delayed answer, and abort on stdin close', async t => {
  const calls = [];
  const { bridge, env, tools } = await fixture(t, call => calls.push(call));
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  output.on('data', chunk => replies.push(JSON.parse(chunk.toString())));
  const nativeFetch = globalThis.fetch;
  let handoffSignal;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.dispatcher, getUpstreamAgentForTests());
    handoffSignal = init.signal;
    return nativeFetch(url, init);
  });
  const shim = startMcpShim({ env, input, output });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  const send = (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const until = async predicate => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate());
  };
  send(1, 'tools/call', { name: tools[0].name, arguments: {} });
  await until(() => calls.length === 1);
  // The CLI can still ping while its tool request waits for the user's answer.
  send(2, 'ping');
  await until(() => replies.some(reply => reply.id === 2));
  assert.equal(replies.some(reply => reply.id === 1), false);
  assert.equal(bridge.resolveCall(calls[0].id, 'Late answer'), true);
  await until(() => replies.some(reply => reply.id === 1));
  assert.deepEqual(replies.find(reply => reply.id === 1).result.content, [{ type: 'text', text: 'Late answer' }]);
  bridge.resetBatch();
  send(3, 'tools/call', { name: tools[0].name, arguments: {} });
  await until(() => calls.length === 2);
  input.end();
  await until(() => handoffSignal.aborted);
  assert.equal(replies.some(reply => reply.id === 3), false);
});
