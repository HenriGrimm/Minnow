import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { HeadlessGenerationError } from '../../src/headless/generation-terminal.ts';
import { streamHeadlessTurn, type ActiveHeadlessGeneration } from '../../src/headless/runner.ts';
import { installHeadlessFetch } from '../../src/headless/server-context.ts';

test('interrupting a headless stream cancels its backend generation', async () => {
  const upstream = new AbortController();
  let status = 'running';
  let cancelCount = 0;
  let streamStarted!: () => void;
  const streamReady = new Promise<void>((resolve) => { streamStarted = resolve; });
  let streamResponse: import('node:http').ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/api/generations' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"generationId":"long-running"}');
      return;
    }
    if (req.url === '/api/generations/long-running/stream' && req.method === 'GET') {
      streamResponse = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Working"}}]}\n\n');
      streamStarted();
      return;
    }
    if (req.url === '/api/generations/long-running/cancel' && req.method === 'POST') {
      cancelCount += 1;
      upstream.abort();
      status = 'cancelled';
      streamResponse?.end('event: end\ndata: {"status":"cancelled"}\n\n');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.url === '/api/generations/long-running' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  const restoreFetch = installHeadlessFetch(`http://127.0.0.1:${address.port}`);
  try {
    const controller = new AbortController();
    let active: ActiveHeadlessGeneration | null = null;
    const turn = streamHeadlessTurn('test-provider', {}, controller.signal, (generation) => {
      active = generation;
    });
    await streamReady;
    assert.equal(active?.generationId, 'long-running');
    controller.abort();
    await assert.rejects(turn, (error: unknown) => {
      assert.ok(error instanceof HeadlessGenerationError);
      assert.equal(error.status, 'cancelled');
      return true;
    });
    assert.equal(active, null);
    assert.equal(cancelCount, 1);
    assert.equal(upstream.signal.aborted, true);
    const response = await fetch('/api/generations/long-running');
    assert.deepEqual(await response.json(), { status: 'cancelled' });
  } finally {
    restoreFetch();
    streamResponse?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
