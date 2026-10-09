import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { mock } from 'node:test';

// Keep the UI fixture independent of the transport; wire tests cover the real socket.
mock.module('../../src/api/stream-event-source.ts', {
  namedExports: { StreamEventSource: class {
    constructor(url: string) { return new globalThis.EventSource(url); }
  } },
});
import type { ServeRecord } from '../../src/models/api-client.ts';
import type { ServeActivity } from '../../src/models/api-client.ts';
import type { LoadProgress } from '../../src/ui/models/store.ts';

function sampleLoad(overrides: Partial<LoadProgress> = {}): LoadProgress {
  return {
    serveId: 'serve-load-1',
    modelId: 'gguf:acme/model:weights/model-Q4_K_M.gguf',
    percent: null,
    phase: 'Starting runtime',
    phaseKey: 'spawning',
    etaMs: null,
    bytesTotal: 4_000_000_000,
    startedAt: 1_700_000_000_000,
    error: null,
    ...overrides,
  };
}

function sampleStartingServe(overrides: Partial<ServeRecord> = {}): ServeRecord {
  return {
    id: 'serve-load-1',
    runtime: 'llama-cpp',
    modelPath: '/models/qwen.gguf',
    modelLabel: 'Qwen',
    port: 8085,
    baseUrl: 'http://127.0.0.1:8085',
    providerId: 'llama-cpp-local',
    status: 'starting',
    runId: null,
    pid: null,
    error: null,
    startedAt: 1_700_000_000_000,
    stoppedAt: null,
    llamaSettings: null,
    mlxSettings: null,
    libraryId: null,
    exitCode: null,
    failure: null,
    ...overrides,
  };
}

describe('models local server loading card', () => {
  const previousEventSource = globalThis.EventSource;
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;
    globalThis.EventSource = class {
      onmessage = null;
      close() {}
    } as unknown as typeof EventSource;

    document.body.innerHTML = `
      <section id="modelsSection-server" class="is-active">
        <div id="modelsServerBody"></div>
      </section>
    `;
  });

  afterEach(async () => {
    const { teardownServerSection } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    teardownServerSection();
    getModelsState().loads.length = 0;
    getModelsState().serves.length = 0;
    getModelsState().activity.clear();
    globalThis.EventSource = previousEventSource;
    document.body.innerHTML = '';
  });

  test('progress ticks keep the same spinner node', async () => {
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    getModelsState().loads = [sampleLoad()];
    render();

    const spinner = document.querySelector('.models-spinner');
    assert.ok(spinner, 'loading chip should include a spinner');
    assert.equal(document.querySelector('.models-loaded__state-label')?.textContent, 'Loading');

    getModelsState().loads[0].percent = 42;
    getModelsState().loads[0].phase = 'Loading weights';
    render();

    assert.equal(document.querySelector('.models-spinner'), spinner);
    assert.equal(document.querySelector('.models-loaded__state-label')?.textContent, 'Loading 42%');
    const fill = document.querySelector('.models-progress__fill') as HTMLElement | null;
    assert.ok(fill);
    assert.equal(fill?.classList.contains('is-indeterminate'), false);
    assert.equal(fill?.style.getPropertyValue('--progress'), '0.42');
    assert.match(document.querySelector('.models-loaded__meta')?.textContent ?? '', /Loading weights/);
  });

  test('a failed load rebuilds the card instead of patching', async () => {
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    getModelsState().loads = [sampleLoad({ percent: 12 })];
    render();
    assert.ok(document.querySelector('.models-spinner'));

    getModelsState().loads[0].error = 'Runtime crashed';
    getModelsState().loads[0].percent = 12;
    render();

    assert.equal(document.querySelector('.models-spinner'), null);
    assert.equal(document.querySelector('.models-loaded__state')?.textContent, 'Failed');
  });

  test('runId appearing during a patched load reconnects the runtime log stream', async () => {
    // Eject-then-reload opens EventSource on llama-starting (no runId). Load-card
    // patches must rebind once spawn assigns the log file, or the pane stays empty.
    const urls: string[] = [];
    class FakeEventSource {
      url: string;
      onmessage: ((msg: MessageEvent) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        urls.push(url);
      }
      close() {}
    }
    const previous = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    (window as unknown as { EventSource: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;

    try {
      const { render } = await import('../../src/ui/models/server-panel.ts');
      const { getModelsState } = await import('../../src/ui/models/store.ts');

      const serve = sampleStartingServe();
      getModelsState().loads = [sampleLoad()];
      getModelsState().serves = [serve];
      render();
      const openedBeforeRunId = urls.length;
      assert.ok(openedBeforeRunId >= 1, 'first paint should follow the starting serve');

      serve.runId = 'run-after-spawn';
      render();
      assert.ok(
        urls.length > openedBeforeRunId,
        'a patched tick must reopen the stream once runId exists',
      );
    } finally {
      globalThis.EventSource = previous;
    }
  });

  test('runtime output preserves history and completed rows while streaming partial tokens', async () => {
    let source: { onmessage: ((msg: MessageEvent) => void) | null } | undefined;
    class FakeEventSource {
      onmessage: ((msg: MessageEvent) => void) | null = null;
      constructor() { source = this; }
      close() {}
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    getModelsState().serves = [sampleStartingServe({ runId: 'run-tokens' })];
    render();
    const emit = (text: string, initial = false) => {
      source?.onmessage?.({ data: JSON.stringify({ text, initial }) } as MessageEvent);
    };
    const history = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    emit(history.join('\n') + '\n\nnext token: hel', true);
    const body = document.getElementById('modelsLogBody')!;
    const first = body.firstElementChild;
    assert.equal(body.children.length, 602);
    emit('lo\nsrv update_slots: all slots are idle\n');
    assert.equal(body.firstElementChild, first);
    assert.equal(body.children[601].textContent, 'next token: hello');
    assert.equal(body.children[602].textContent, 'srv update_slots: all slots are idle');
    emit('fresh run\n', true);
    assert.equal(body.firstElementChild?.textContent, 'fresh run');
    assert.equal(body.children.length, 2);
  });

  test('live activity patches cards while keeping focus, spinners and log scroll', async () => {
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    const state = getModelsState();
    const serve = sampleStartingServe({ status: 'running', runId: 'run-1' });
    const activity: ServeActivity = {
      serveId: serve.id, modelLabel: serve.modelLabel, libraryId: null,
      available: true, stale: false, queued: 0, updatedAt: Date.now(),
      slots: [{ id: 0, taskId: 1, state: 'generating', promptProcessed: 0,
        promptCached: 0, decoded: 10, remaining: null, tokensPerSecond: 20 }],
    };
    state.serves = [serve];
    state.activity.set(serve.id, activity);
    render();
    const card = document.querySelector('.models-loaded');
    const spinner = card?.querySelector('.models-spinner');
    const eject = card?.querySelector<HTMLButtonElement>('.models-btn--danger');
    const log = document.getElementById('modelsLogBody')!;
    log.scrollTop = 37;
    eject!.focus();

    activity.slots[0].decoded = 25;
    activity.slots[0].tokensPerSecond = 30;
    state.serves = [{ ...serve }];
    state.selectedServeId = serve.id;
    render();

    assert.equal(document.querySelector('.models-loaded'), card);
    assert.equal(card?.querySelector('.models-spinner'), spinner);
    assert.equal(document.activeElement, eject);
    assert.equal(document.getElementById('modelsLogBody'), log);
    assert.equal(log.scrollTop, 37);
    assert.equal(card?.classList.contains('is-selected'), true);
    assert.match(card?.querySelector('.models-loaded__state')?.textContent ?? '', /GEN 25 tok/);
    assert.match(card?.querySelector('.models-loaded__facts')?.textContent ?? '', /30.0 tok\/s/);

    activity.slots[0].state = 'idle';
    render();
    assert.equal(card?.querySelector('.models-loaded__state')?.textContent, 'Ready');
    assert.equal(card?.querySelector('.models-spinner'), null);
    assert.equal(document.activeElement, eject);

    state.serves = [{ ...serve, status: 'stopped' }];
    render();
    assert.equal(document.querySelector('.models-loaded'), null);
    assert.match(document.querySelector('.models-status-bar__label')?.textContent ?? '', /Stopped/);
  });

  test('MTPLX metrics keep performance details expanded', async () => {
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    const state = getModelsState();
    const serve = sampleStartingServe({ status: 'running', runtime: 'mtplx' });
    const activity: ServeActivity = {
      serveId: serve.id, modelLabel: serve.modelLabel, libraryId: null,
      available: true, stale: false, queued: 0, updatedAt: Date.now(), slots: [],
      mtplx: { activeRequests: 1, latest: { decode_tok_s: 10, accepted_by_depth: [5] } },
    };
    state.serves = [serve];
    state.activity.set(serve.id, activity);
    render();
    const details = document.querySelector<HTMLDetailsElement>('.models-loaded details')!;
    details.open = true;
    activity.mtplx!.latest = { decode_tok_s: 15, accepted_by_depth: [9] };
    render();
    assert.equal(document.querySelector('.models-loaded details'), details);
    assert.equal(details.open, true);
    assert.match(details.querySelector('pre')?.textContent ?? '', /9/);
    assert.match(document.querySelector('.models-loaded__facts')?.textContent ?? '', /15.0 tok\/s/);
  });

  test('a second model completing its load updates the list during another load', async () => {
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    const state = getModelsState();
    state.loads = [sampleLoad()];
    state.serves = [sampleStartingServe(), sampleStartingServe({ id: 'serve-2' })];
    render();
    state.serves[1].status = 'running';
    render();
    assert.equal(document.querySelectorAll('.models-loaded').length, 2);
    assert.equal(document.querySelectorAll('.models-loaded.is-loading').length, 1);
  });

  test('keyboard selection follows the session log and connection without remounting telemetry', async () => {
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    const state = getModelsState();
    state.selectedServeId = null;
    state.serves = [sampleStartingServe({ status: 'running' }), sampleStartingServe({
      id: 'serve-second', status: 'running', modelLabel: 'Second model', port: 8086, baseUrl: 'http://127.0.0.1:8086',
    })];
    render();
    const card = document.querySelector<HTMLElement>('[data-serve-id="serve-second"].models-loaded')!;
    const log = document.getElementById('modelsLogBody');
    card.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(state.selectedServeId, 'serve-second');
    assert.equal(document.querySelector('.models-logs select')?.getAttribute('aria-label'), 'Log source');
    assert.equal((document.querySelector('.models-logs select') as HTMLSelectElement).value, 'serve-second');
    assert.match(document.querySelector('.models-server-connection')?.textContent ?? '', /127\.0\.0\.1:8086/);
    assert.equal(document.querySelector('[data-serve-id="serve-second"].models-loaded'), card);
    assert.equal(document.getElementById('modelsLogBody'), log);
  });

  test('a crashed runtime remains available as a log source', async () => {
    const { render } = await import('../../src/ui/models/server-panel.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    getModelsState().serves = [sampleStartingServe({ status: 'crashed', runId: 'crashed-run' })];
    render();
    assert.match(document.querySelector('.models-status-bar__label')?.textContent ?? '', /Crashed/);
    assert.equal(document.querySelector('.models-server-connection')?.getAttribute('data-serve-id'), '');
    assert.match(document.getElementById('modelsLogBody')?.textContent ?? '', /Waiting for runtime output/);
  });
});
