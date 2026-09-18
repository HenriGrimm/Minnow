import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { openAgentBrowserRuntime } from '../../src/tools/agent-browser-runtime.ts';

describe('foreground agent browser runtime', () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  test('acknowledges Guide only after the row enters a runner boundary and unregisters after ack', async () => {
    const requests: string[] = [];
    globalThis.EventSource = class {
      constructor() { throw new Error('Chat guides must not reserve an HTTP stream'); }
    } as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/runtime/register')) {
        return new Response(JSON.stringify({ runtimeToken: 'runtime-token' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/guides')) {
        return Response.json({ guides: [{
          id: 'guide-1', tabId: 'tab-1', message: 'Check this button.',
          elementSummary: 'button “Submit”', url: 'http://localhost/form',
        }] });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const runtime = await openAgentBrowserRuntime({ chatId: 'chat', runId: 'turn', agentId: 'main' });
    assert.ok(runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests.some((url) => url.endsWith('/ack')), false);

    const rows = runtime.drainMessages();
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /Check this button/);
    assert.match(rows[0].content, /button “Submit”/);
    await runtime.close();
    assert.match(requests.at(-2) ?? '', /\/ack$/);
    assert.match(requests.at(-1) ?? '', /\/unregister$/);
  });
  test('stopping one project turn cancels its pending poll without stopping the other', async () => {
    const signals: AbortSignal[] = [];
    let nextToken = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/register')) return Response.json({ runtimeToken: `turn-${++nextToken}` });
      if (url.endsWith('/guides')) {
        const signal = init!.signal!;
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    const first = await openAgentBrowserRuntime({ chatId: 'project-a', runId: 'turn-a', agentId: 'main' });
    const second = await openAgentBrowserRuntime({ chatId: 'project-b', runId: 'turn-b', agentId: 'main' });
    assert.ok(first && second);
    try {
      assert.equal(signals.length, 2);
      await first.close();
      assert.equal(signals[0].aborted, true);
      assert.equal(signals[1].aborted, false);
    } finally {
      await first.close();
      await second.close();
    }
    assert.equal(signals[1].aborted, true);
  });

});
