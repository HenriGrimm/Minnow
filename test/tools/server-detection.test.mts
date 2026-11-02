import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { detectLocalServer, getLocalServerAvailable } from '../../src/tools/client.ts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setLocalServerAvailable(false);
});

test('boot detects a healthy local server without waiting on stalled external discovery', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/tools/ping') return Response.json({ ok: true });
    // Neither the MCP nor plugin request observes the health probe's signal.
    return new Promise<Response>(() => {});
  }) as typeof fetch;

  const available = await Promise.race([
    detectLocalServer({ refreshTools: false }),
    new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 100)),
  ]);
  assert.equal(available, true);
  assert.equal(getLocalServerAvailable(), true);
  assert.deepEqual(requests, ['/api/tools/ping']);
});

test('ordinary detection still waits for the tool catalogs callers depend on', async () => {
  let releaseMcp!: () => void;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/tools/ping') return Response.json({ ok: true });
    if (path === '/api/mcp/tools') {
      await new Promise<void>((resolve) => { releaseMcp = resolve; });
    }
    return Response.json({ tools: [] });
  }) as typeof fetch;

  let settled = false;
  const pending = detectLocalServer().then((value) => { settled = true; return value; });
  // Wait for discovery to start without depending on response parsing timing.
  for (let i = 0; i < 20 && !releaseMcp; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(typeof releaseMcp, 'function');
  assert.equal(settled, false);
  releaseMcp();
  assert.equal(await pending, true);
  assert.deepEqual(requests.sort(), ['/api/mcp/tools', '/api/plugins/tools', '/api/tools/ping']);
});

test('boot still reports an unhealthy or unreachable local server as unavailable', async () => {
  for (const response of [Response.json({ ok: false }), new Response('', { status: 503 }), null]) {
    setLocalServerAvailable(true);
    globalThis.fetch = (async () => {
      if (!response) throw new TypeError('Failed to fetch');
      return response;
    }) as typeof fetch;
    assert.equal(await detectLocalServer({ refreshTools: false }), false);
    assert.equal(getLocalServerAvailable(), false);
  }
});
