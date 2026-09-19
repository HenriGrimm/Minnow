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
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;

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
});
