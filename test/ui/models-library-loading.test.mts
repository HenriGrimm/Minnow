import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { ServeRecord } from '../../src/models/api-client.ts';
import type { LibraryModel } from '../../src/models/library.ts';
import type { LoadProgress, ModelsState } from '../../src/ui/models/store.ts';

const state: ModelsState = {
  library: [], serves: [], loads: [], downloads: [], activity: new Map(),
  hardware: null, runtimes: null, selectedId: null, selectedServeId: null,
  scanning: false, error: null,
};
const getModelsState = () => state;
mock.module('../../src/ui/models/store.ts', {
  namedExports: {
    getModelsState,
    serveForModel: (model: LibraryModel) => state.serves.find((serve) => serve.modelPath === model.path),
    loadForModel: (model: LibraryModel) => state.loads.find((load) => load.modelId === model.id),
    isDeletingModel: () => false,
    deleteModel: async () => {}, loadModel: async () => {}, refreshModels: async () => {},
    unloadServe: async () => {}, subscribeModelsStore: () => () => {},
  },
});
mock.module('../../src/ui/status.ts', {
  namedExports: { setStatus() {} },
});
mock.module('../../src/ui/app-dialog.ts', {
  namedExports: { appConfirm: async () => false },
});
mock.module('../../src/ui/models/runtime-install-prompt.ts', {
  namedExports: { ensureRuntimeForModel: async () => true },
});
mock.module('../../src/ui/models/inspector.ts', {
  namedExports: {
    settingsFor: () => ({}), showModelInInspector() {}, showServeInInspector() {},
    initInspector() {}, render() {}, showInspectorTab() {},
  },
});

const { buildLibrary } = await import('../../src/models/library.ts');
const { render } = await import('../../src/ui/models/library-panel.ts');

beforeEach(async () => {
  const { Window } = await import('happy-dom');
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.HTMLInputElement = win.HTMLInputElement;
  document.body.innerHTML = '<div id="modelsInstalledBody"></div>';

  const state = getModelsState();
  state.library = await buildLibrary([{
    repo_id: 'test/loading', path: '/models/test--loading', size_bytes: 192, nb_files: 2,
    has_incomplete: false, is_gguf: true, status: 'downloaded',
    gguf_files: [
      { name: 'Model-7B-Q4_K_M.gguf', rel_path: 'Model-7B-Q4_K_M.gguf', quant: 'Q4_K_M', role: 'model', size_bytes: 64 },
      { name: 'Model-7B-Q8_0.gguf', rel_path: 'Model-7B-Q8_0.gguf', quant: 'Q8_0', role: 'model', size_bytes: 128 },
    ],
  }, {
    repo_id: 'test/idle', path: '/models/test--idle', size_bytes: 64, nb_files: 1,
    has_incomplete: false, is_gguf: true, status: 'downloaded',
    gguf_files: [
      { name: 'Idle-7B-Q4_K_M.gguf', rel_path: 'Idle-7B-Q4_K_M.gguf', quant: 'Q4_K_M', role: 'model', size_bytes: 64 },
    ],
  }]);
  const model = state.library[0];
  state.serves = [{
    id: 'serve-loading', runtime: 'llama-cpp', modelPath: model.path,
    modelLabel: model.name, libraryId: model.id, status: 'starting',
  } as ServeRecord];
  state.loads = [{
    serveId: 'serve-loading', modelId: model.id, percent: 12, phase: 'Loading weights',
    phaseKey: 'weights', etaMs: 10000, bytesTotal: model.sizeBytes,
    startedAt: Date.now(), error: null,
  } as LoadProgress];
  state.activity.clear();
  state.selectedId = null;
  state.selectedServeId = null;
  state.scanning = false;
  state.error = null;
  state.hardware = { backend: 'cuda' } as typeof state.hardware;
  render();
});

afterEach(() => {
  const state = getModelsState();
  state.loads = [];
  state.serves = [];
  state.activity.clear();
  document.body.innerHTML = '';
});

test('loading ticks retain every row, focused quantization and loading label', () => {
  const rows = Array.from(document.querySelectorAll('.models-row'));
  const quant = document.querySelector<HTMLSelectElement>('.models-row__quant-select')!;
  const label = document.querySelector('.models-row__loading');
  quant.focus();

  const load = getModelsState().loads[0];
  for (let tick = 0; tick < 8; tick++) {
    load.percent = 20 + tick;
    load.etaMs = 9000 - tick * 250;
    if (tick > 3) load.phase = 'Creating context';
    render();
  }

  assert.ok(rows.every((row, index) => document.querySelectorAll('.models-row')[index] === row),
    'progress must not replace hovered rows');
  assert.ok(document.activeElement === quant, 'quantization must retain keyboard focus');
  assert.ok(document.querySelector('.models-row__loading') === label, 'loading label must stay mounted');
  assert.equal(label?.textContent, 'Creating context');
});

test('unrelated downloads and serve metadata keep the library rows mounted', () => {
  const row = document.querySelector('.models-row');
  const state = getModelsState();
  state.serves[0].runId = 'run-after-spawn';
  state.selectedServeId = 'serve-loading';
  state.downloads = [...state.downloads];
  render();
  assert.ok(document.querySelector('.models-row') === row, 'unrelated updates must not replace rows');
});

test('finishing or failing a load refreshes row actions and status counts', () => {
  const state = getModelsState();
  state.loads = [];
  state.serves[0].status = 'running';
  render();
  assert.equal(document.querySelector('.models-row__loading'), null);
  assert.match(document.querySelector('.models-row.is-loaded')?.textContent ?? '', /Loaded.*Eject/s);
  const loaded = document.querySelectorAll('.models-library-tabs__count')[1];
  assert.equal(loaded.textContent, '1');

  state.serves[0].status = 'error';
  state.serves[0].failure = { suggestedSettings: { ctx: 4096 } } as ServeRecord['failure'];
  render();
  assert.equal(document.querySelector('.models-row.is-loaded'), null);
  assert.match(document.querySelector('.models-row__loaded-badge')?.textContent ?? '', /Error/);
  assert.match(document.querySelector('.models-row__actions')?.textContent ?? '', /Retry with suggested settings/);
  assert.equal(document.querySelectorAll('.models-library-tabs__count')[2].textContent, '1');
});

test('filters and library changes still redraw during loading', () => {
  const search = document.querySelector<HTMLInputElement>('.models-search__input')!;
  search.value = 'Idle';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('.models-row').length, 1);
  assert.match(document.querySelector('.models-row__name')?.textContent ?? '', /Idle/);
  const nextSearch = document.querySelector<HTMLInputElement>('.models-search__input')!;
  nextSearch.value = '';
  nextSearch.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('.models-row').length, 2);

  getModelsState().library = getModelsState().library.filter((model) => model.repoId !== 'test/idle');
  render();
  assert.equal(document.querySelectorAll('.models-row').length, 1);
});

test('the same state renders into a new mount', () => {
  document.body.innerHTML = '<div id="modelsInstalledBody"></div>';
  render();
  assert.equal(document.querySelectorAll('.models-row').length, 2);
  assert.equal(document.querySelector('.models-row__loading')?.textContent, 'Loading weights');
});
