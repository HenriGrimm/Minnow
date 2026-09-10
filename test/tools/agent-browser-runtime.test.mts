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
    let source: FakeEventSource | null = null;
    class FakeEventSource {
      listeners = new Map<string, (event: MessageEvent) => void>();
      constructor(readonly url: string) { source = this; }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }
      close() {}
      emit(type: string, data: unknown) {
        this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/runtime/register')) {
        return new Response(JSON.stringify({ runtimeToken: 'runtime-token' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const runtime = await openAgentBrowserRuntime({ chatId: 'chat', runId: 'turn', agentId: 'main' });
    assert.ok(runtime && source);
    source.emit('guide', {
      id: 'guide-1', tabId: 'tab-1', message: 'Check this button.',
      elementSummary: 'button “Submit”', url: 'http://localhost/form',
    });
    assert.equal(requests.some((url) => url.endsWith('/ack')), false);

    const rows = runtime.drainMessages();
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /Check this button/);
    assert.match(rows[0].content, /button “Submit”/);
    await runtime.close();
    assert.match(requests.at(-2) ?? '', /\/ack$/);
    assert.match(requests.at(-1) ?? '', /\/unregister$/);
  });
});
