import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { LibraryModel } from '../../src/models/library.ts';
import type { ServeRecord } from '../../src/models/api-client.ts';

function ggufModel(overrides: Partial<LibraryModel> = {}): LibraryModel {
  return {
    id: 'gguf:test/model:weights/model-Q4_K_M.gguf',
    name: 'model-Q4_K_M',
    repoId: 'test/model',
    publisher: 'test',
    producerSlug: 'meta',
    producerName: 'Meta',
    producerLogoId: 'meta',
    format: 'GGUF',
    quant: 'Q4_K_M',
    arch: 'llama',
    domain: 'chat',
    paramsB: 7,
    contextLength: 8192,
    capabilities: [],
    sizeBytes: 4_000_000_000,
    path: '/tmp/model-Q4_K_M.gguf',
    fileName: 'model-Q4_K_M.gguf',
    source: 'downloaded',
    servable: true,
    incomplete: false,
    isMoe: false,
    ...overrides,
  };
}

describe('models inspector footer', () => {
  const frames: FrameRequestCallback[] = [];
  const flush = () => { while (frames.length) frames.shift()!(0); };
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;
    window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };

    document.body.innerHTML = `
      <main id="modelsView" class="models-page is-workbench">
        <aside id="modelsInspector"></aside>
      </main>
    `;
  });

  afterEach(() => {
    flush();
    document.body.innerHTML = '';
  });

  test('shows Load model for a servable GGUF row', async () => {
    const { initInspector, showModelInInspector } = await import('../../src/ui/models/inspector.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    const model = ggufModel();
    getModelsState().library = [model];
    initInspector();
    showModelInInspector(model.id, 'load');

    const btn = document.querySelector<HTMLButtonElement>(
      '.models-inspector__footer .models-btn--primary',
    );
    assert.ok(btn, 'footer should include a primary Load button');
    assert.equal(btn?.textContent, 'Load model');
    assert.ok(document.querySelector('.models-inspector__footer'));
    assert.ok(
      document.querySelector('.models-launch-memory.models-launch-memory-hint'),
      'Load tab should show the launch memory occupancy cluster',
    );
  });

  test('shows Eject when the model is already running', async () => {
    const { initInspector, showModelInInspector } = await import('../../src/ui/models/inspector.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    const model = ggufModel();
    getModelsState().library = [model];
    getModelsState().serves = [
      {
        id: 'serve-1',
        modelPath: model.path!,
        modelLabel: model.name,
        providerId: 'llama-cpp-local',
        baseUrl: 'http://127.0.0.1:8081/v1',
        status: 'running',
        runtime: 'llama-cpp',
      },
    ];
    initInspector();
    showModelInInspector(model.id, 'load');

    const eject = document.querySelector<HTMLButtonElement>(
      '.models-inspector__footer .models-btn--danger',
    );
    assert.ok(eject);
    assert.equal(eject?.textContent, 'Eject');
    assert.equal(
      document.querySelector('.models-inspector__footer .models-btn--primary'),
      null,
    );
  });

  test('telemetry and reconciliation retain focused inference inputs and unsaved values', async () => {
    const { initInspector, showModelInInspector } = await import('../../src/ui/models/inspector.ts');
    const { getModelsState, selectServe } = await import('../../src/ui/models/store.ts');
    const state = getModelsState();
    const model = ggufModel();
    state.selectedId = null;
    state.selectedServeId = null;
    state.library = [model];
    state.loads = [];
    state.serves = [{
      id: 'serve-live', modelPath: model.path!, modelLabel: model.name,
      providerId: 'llama-cpp-local', baseUrl: 'http://127.0.0.1:8081/v1',
      status: 'running', runtime: 'llama-cpp',
    } as ServeRecord];
    initInspector();
    showModelInInspector(model.id, 'inference');
    flush();
    const body = document.querySelector<HTMLElement>('.models-inspector__body')!;
    const input = body.querySelector<HTMLInputElement>('input')!;
    assert.ok(input);
    input.focus();
    input.value = '0.37';
    body.scrollTop = 84;

    state.activity.set('serve-live', {
      serveId: 'serve-live', modelLabel: model.name, libraryId: model.id,
      updatedAt: Date.now(), available: true, stale: false, queued: 1, slots: [],
    });
    state.serves = state.serves.map((serve) => ({ ...serve }));
    selectServe('serve-live');
    flush();

    assert.equal(document.querySelector('.models-inspector__body'), body);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, '0.37');
    assert.equal(body.scrollTop, 84);

    state.serves[0].status = 'stopped';
    selectServe('serve-live');
    flush();
    assert.notEqual(document.querySelector('.models-inspector__body'), body);
    assert.equal(document.querySelector('.models-inspector__footer .models-btn--primary')?.textContent, 'Load model');
  });
});
