import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createCodexRpc } from '../../server/generations/codex-app-server/rpc.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url));
const invocation = { command: process.execPath, argsPrefix: [fixture], env: process.env };

test('bidirectional RPC keeps stdin open and correlates out-of-order and split UTF-8 responses', async () => {
  const rpc = createCodexRpc(invocation);
  try {
    await rpc.initialize();
    assert.deepEqual(await Promise.all([
      rpc.request('echo', { delay: 30, value: 1 }), rpc.request('echo', { value: 2 }), rpc.request('split'),
    ]), [{ delay: 30, value: 1 }, { value: 2 }, 'hé🐟']);
    assert.equal(rpc.snapshot().pending, 0);
  } finally { await rpc.close(); }
});

test('native requests are delivered once while pending and answered once', async () => {
  const requests = [];
  const rpc = createCodexRpc(invocation, { onRequest: row => requests.push(row) });
  try {
    await rpc.request('call');
    assert.equal(requests.length, 1);
    const answered = new Promise(resolve => {
      const unsubscribe = rpc.subscribe(row => {
        if (row.method === 'fixture/answered') { unsubscribe(); resolve(row.params); }
      });
    });
    await rpc.respond('native-1', { success: true });
    assert.deepEqual(await answered, { id: 'native-1', result: { success: true } });
    await assert.rejects(rpc.respond('native-1', {}), /already answered/);
  } finally { await rpc.close(); }
});

test('server request identity conflicts and aggregate queue limits fail closed', async () => {
  for (const [method, message] of [['conflict', /reused a pending/], ['server-flood', /size limit/]]) {
    const rpc = createCodexRpc(invocation, { maxBytes: 1024, onRequest: () => {} });
    try {
      await rpc.initialize();
      await assert.rejects(rpc.request(method), message);
      assert.equal(rpc.snapshot().serverRequests, 0);
    } finally { await rpc.close(); }
  }
});

test('backpressure bounds queued writes and shutdown settles blocked callers', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough({ highWaterMark: 1 });
  const rpc = createCodexRpc(invocation, { spawn: () => child, maxBytes: 1024 });
  const requests = Array.from({ length: 4 }, () => rpc.request('echo', { text: 'x'.repeat(350) }));
  const result = Promise.allSettled(requests);
  // Fake a closed blocked child. Real spawned processes use process-tree kill.
  child.emit('close');
  assert.ok((await result).every(row => row.status === 'rejected'));
  assert.equal(rpc.snapshot().pending, 0);
  assert.equal(rpc.snapshot().queuedBytes, 0);
  await rpc.close();
});

test('unserializable requests reject without leaving timers or pending entries', async () => {
  const rpc = createCodexRpc(invocation);
  try {
    await rpc.initialize();
    const cycle = {}; cycle.self = cycle;
    await assert.rejects(rpc.request('echo', cycle), /not JSON serializable/);
    assert.equal(rpc.snapshot().pending, 0);
    assert.deepEqual(await rpc.request('echo', { valid: true }), { valid: true });
  } finally { await rpc.close(); }
});

test('concurrent replies cannot acknowledge one native request twice', async () => {
  const rpc = createCodexRpc(invocation, { onRequest: () => {} });
  try {
    await rpc.request('call');
    const first = rpc.respond('native-1', { success: true });
    await assert.rejects(rpc.respond('native-1', { success: true }), /already answered/);
    await first;
  } finally { await rpc.close(); }
});

test('unknown native permission requests receive no authority', async () => {
  const rpc = createCodexRpc(invocation);
  try {
    const answered = new Promise(resolve => {
      rpc.subscribe(row => { if (row.method === 'fixture/answered') resolve(row.params); });
    });
    await rpc.request('call');
    assert.equal((await answered).error.code, -32601);
    assert.equal(rpc.snapshot().serverRequests, 0);
  } finally { await rpc.close(); }
});

test('timeouts, queued cancellation, pending limits and process exit settle every caller', async () => {
  const rpc = createCodexRpc(invocation, { maxPending: 2 });
  try {
    await rpc.initialize();
    await assert.rejects(rpc.request('hang', {}, { timeoutMs: 30 }), /timed out/);
    const controller = new AbortController();
    const cancelled = rpc.request('hang', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    const one = rpc.request('hang');
    const two = rpc.request('exit');
    await assert.rejects(rpc.request('echo'), /pending request limit/);
    const results = await Promise.allSettled([one, two]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(rpc.snapshot().pending, 0);
  } finally { await rpc.close(); }
});

test('oversized records and write queues fail without leaked callers', async () => {
  for (const method of ['large', 'echo']) {
    const rpc = createCodexRpc(invocation, { maxBytes: 1024 });
    try {
      await rpc.initialize();
      await assert.rejects(rpc.request(method, method === 'echo' ? { data: 'x'.repeat(5000) } : {}), /size limit/);
      assert.equal(rpc.snapshot().pending, 0);
    } finally { await rpc.close(); }
  }
});

test('spawn failure and explicit shutdown reject pending requests', async () => {
  const broken = createCodexRpc({ command: 'minnow-nonexistent-codex-binary', argsPrefix: [] });
  await assert.rejects(broken.initialize());
  await broken.close();
  const rpc = createCodexRpc(invocation);
  const pending = rpc.request('hang');
  const result = assert.rejects(pending, /closed/);
  await rpc.close();
  await result;
  assert.equal(rpc.snapshot().pending, 0);
});
