import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { openReef, suspendReef } from '../../src/ui/reef-page.ts';
import type { ReefApp } from '../../src/reef/types.ts';

test('Reef shows a live agent stream during sustained SSE activity, reconnects and restores it', async () => {
  const dom = new Window();
  globalThis.window = dom as unknown as Window & typeof globalThis;
  globalThis.document = dom.document as unknown as Document;
  globalThis.HTMLElement = dom.HTMLElement as unknown as typeof HTMLElement;
  const previousStorage = globalThis.localStorage, previousFetch = globalThis.fetch;
  globalThis.localStorage = dom.localStorage;
  const now = Date.now();
  const app: ReefApp = {
    version: 1, templateVersion: 1, id: '33333333-3333-3333-3333-333333333333',
    name: 'Timer', description: 'A focus timer', modelId: 'test-model', createdAt: now,
    updatedAt: now, status: 'planning', release: null, exports: [], chatIds: [], messages: [],
    runs: [{ id: 'run-1', prompt: 'Make a timer', state: 'planning', progress: 10,
      createdAt: now - 60000, startedAt: now - 60000, lastActivityAt: now,
      agentLog: '', log: 'Initialized repository', attempt: 0, chatIds: [] }],
  };
  let events: ReadableStreamDefaultController<Uint8Array> | undefined, detailReads = 0;
  let delayedRead = false, releaseRead: (() => void) | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.includes('/events?')) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          events = controller;
          options?.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith(`/apps/${app.id}`)) {
      detailReads++;
      const snapshot = structuredClone(app);
      if (delayedRead) { delayedRead = false; await new Promise<void>(resolve => { releaseRead = resolve; }); }
      return Response.json({ ...snapshot, workspacePath: '/apps/timer' });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let eventId = 0;
  function notify() { events!.enqueue(new TextEncoder().encode(`id: ${++eventId}\ndata: {}\n\n`)); }
  try {
    await openReef(app.id); await pause(0);
    assert.equal(document.querySelector('.reef-orb-stage')!.textContent, 'Planning');
    assert.match(document.querySelector('.reef-orb-meta')!.textContent!, /^1m 00s/);
    const peek = document.querySelector<HTMLDetailsElement>('.reef-peek')!;
    assert.equal(peek.open, false, 'the agent transcript stays backstage until asked for');
    peek.open = true; peek.dispatchEvent(new dom.Event('toggle'));
    assert.match(document.querySelector('.reef-agent-stream')!.textContent!, /Waiting for the model/);
    for (let i = 0; i < 10; i++) {
      app.runs[0].agentLog += `Token ${i}. `; app.runs[0].lastActivityAt = Date.now();
      notify(); await pause(50);
      if (i === 5) assert.ok(detailReads > 1, 'continuous tokens must not postpone all refreshes');
    }
    await pause(300);
    assert.equal(document.querySelector('.reef-agent-stream')!.textContent, app.runs[0].agentLog);
    assert.equal(document.querySelector('.reef-build-log')!.textContent, 'Initialized repository');
    delayedRead = true; notify(); await pause(250);
    app.runs[0].agentLog += 'Final token'; notify(); await pause(250);
    releaseRead!(); await pause(50);
    assert.match(document.querySelector('.reef-agent-stream')!.textContent!, /Final token$/, 'events during an in-flight refresh must trigger another read');
    events!.close(); await pause(0);
    assert.match(document.querySelector('.reef-orb-meta')!.textContent!, /Reconnecting/);
    app.runs[0].agentLog += ' Recovered without navigation';
    // No activity notifications on the replacement stream: snapshots still recover.
    await pause(5200);
    assert.match(document.querySelector('.reef-agent-stream')!.textContent!, /Recovered without navigation$/);
    await openReef(app.id); await pause(0);
    assert.match(document.querySelector('.reef-agent-stream')!.textContent!, /Recovered without navigation$/);
    app.status = app.runs[0].state = 'cancelled'; notify(); await pause(250);
    assert.equal(document.querySelector<HTMLElement>('.reef-orb-meta')!.hidden, true);
    assert.equal(document.querySelector('.reef-orb-headline')!.textContent, 'Build cancelled');
    assert.match(document.querySelector('.reef-agent-stream')!.textContent!, /Recovered without navigation$/);
  } finally {
    suspendReef(); globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; await dom.happyDOM.abort();
  }
});
