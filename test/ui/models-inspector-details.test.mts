import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import type { LibraryModel } from '../../src/models/library.ts';
import type { ServeRecord } from '../../src/models/api-client.ts';
import { setLibraryInferencePrefsForTests } from '../../src/config/library-inference-meta.ts';
import { initInspector, showModelInInspector, showServeInInspector } from '../../src/ui/models/inspector.ts';
import { closeLoadSettingsPopover } from '../../src/ui/models/load-settings-popover.ts';
import { getModelsState } from '../../src/ui/models/store.ts';
import { mtplxLoadedWithRows } from '../../src/models/mtplx-loaded-with.ts';

const model: LibraryModel = {
  id: 'gguf:fixture/model:model.gguf', name: 'Fixture model', repoId: 'fixture/model',
  publisher: 'fixture', producerSlug: 'qwen', producerName: 'Qwen', producerLogoId: 'qwen',
  format: 'GGUF', quant: 'Q4_K_M', arch: 'qwen', domain: 'chat', paramsB: 9,
  contextLength: 32768, capabilities: ['tools', 'tool_use', 'reasoning', 'vision', 'code', 'audio'],
  sizeBytes: 5e9, path: '/fixture/model.gguf', fileName: 'model.gguf', source: 'downloaded',
  servable: true, incomplete: false, isMoe: false,
};
const serve = (overrides: Partial<ServeRecord> = {}): ServeRecord => ({
  id: 'fixture-serve', modelPath: model.path!, modelLabel: model.name, libraryId: model.id,
  runtime: 'llama-cpp', status: 'running', baseUrl: 'http://127.0.0.1:8080/v1', port: 8080,
  providerId: 'llama-cpp-local', runId: 'fixture-run', pid: 1, startedAt: 1,
  stoppedAt: null, error: null, llamaSettings: { ctx: 8192, parallel: 2 }, ...overrides,
});
const originalFetch = globalThis.fetch;

beforeEach(() => {
  const window = new Window();
  globalThis.window = window as never;
  globalThis.document = window.document as never;
  globalThis.localStorage = window.localStorage;
  document.body.innerHTML = `<main id="modelsView" class="models-page is-workbench">
    <button id="btnModelsInspector" aria-expanded="true">Toggle details</button>
    <aside id="modelsInspector" class="models-inspector"></aside></main>`;
  const state = getModelsState();
  state.library = [model]; state.serves = [serve()]; state.loads = [];
  state.selectedId = null; state.selectedServeId = null;
  setLibraryInferencePrefsForTests({ byLibraryId: { [model.id]: { temperature: 0.4 } }, chatModelAliases: {} });
  globalThis.fetch = async () => Response.json({});
});

afterEach(() => {
  closeLoadSettingsPopover();
  document.body.innerHTML = '';
  globalThis.fetch = originalFetch;
});

function button(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent === label);
  assert.ok(button, label);
  return button;
}

test('Overview exposes useful facts, connection controls, and every unique capability without launch forms', () => {
  showModelInInspector(model.id);
  assert.deepEqual(Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent), ['Overview', 'Inference']);
  const selected = document.querySelector('[role="tab"][aria-selected="true"]')!;
  const panel = document.getElementById(selected.getAttribute('aria-controls')!)!;
  assert.equal(panel.getAttribute('aria-labelledby'), selected.id);
  assert.match(document.querySelector('.models-details__state')!.textContent!, /Running.*llama.cpp/);
  assert.ok(button('Load settings'));
  assert.ok(button('Eject'));
  assert.ok(document.querySelector('[aria-label="Copy base URL"]'));
  assert.ok(document.querySelector('[aria-label="Copy model identifier"]'));
  assert.deepEqual(Array.from(document.querySelectorAll('.models-details__capability-list li')).map((item) => item.textContent),
    ['Tools', 'Reasoning', 'Vision', 'Code', 'Audio']);
  assert.equal(document.querySelector('input, select'), null);
  const files = Array.from(document.querySelectorAll('details')).find((item) => item.querySelector('summary')?.textContent === 'Model & files')!;
  assert.equal(files.open, false);
  assert.ok(files.querySelector('[aria-label="Copy file path"]'));
});

test('tabs support arrow keys and expose explanations linked to inference fields', async () => {
  showModelInInspector(model.id);
  document.getElementById('modelsInspectorTab-info')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await Promise.resolve();
  assert.equal(document.activeElement?.id, 'modelsInspectorTab-inference');
  const input = document.getElementById('models-inference-temperature') as HTMLInputElement;
  assert.equal(input.value, '0.4');
  assert.ok(document.getElementById(input.getAttribute('aria-describedby')!));
  assert.equal(document.querySelector('details'), null, 'runtime snapshots belong in Overview');
  document.getElementById('modelsInspectorTab-inference')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await Promise.resolve();
  assert.equal(document.activeElement?.id, 'modelsInspectorTab-info');
});

test('a queued store redraw cannot replace the focused tab after selecting a model', async () => {
  const frames: FrameRequestCallback[] = [];
  window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  // Leave cancelled callbacks queued to check that the render revision is guarded too.
  window.cancelAnimationFrame = () => {};
  initInspector();
  while (frames.length) frames.shift()!(0);
  showModelInInspector(model.id);
  await Promise.resolve();
  const tab = document.getElementById('modelsInspectorTab-info');
  assert.equal(document.activeElement, tab);
  while (frames.length) frames.shift()!(0);
  assert.equal(document.getElementById('modelsInspectorTab-info'), tab);
  assert.equal(document.activeElement, tab);
});

test('Load settings opens the popover and returns to the same tab and initiating action', async () => {
  showModelInInspector(model.id, 'inference');
  await Promise.resolve();
  const settings = button('Load settings');
  settings.focus(); settings.click();
  assert.ok(document.querySelector('.models-load-popover #modelsInspector'));
  assert.equal(document.getElementById('modelsInspector')!.classList.contains('models-inspector--details'), false);
  closeLoadSettingsPopover();
  assert.equal(document.querySelector('.models-load-popover'), null);
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, 'Inference');
  assert.equal(document.activeElement?.id, 'modelsInspectorLoadSettings');
  assert.equal((document.getElementById('models-inference-temperature') as HTMLInputElement).value, '0.4');
});

test('the close control collapses details and returns focus to the page toggle', () => {
  showModelInInspector(model.id);
  document.querySelector<HTMLButtonElement>('[aria-label="Close model details"]')!.click();
  assert.equal(document.getElementById('btnModelsInspector')!.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement?.id, 'btnModelsInspector');
  assert.equal(localStorage.getItem('minnow.models.inspector'), '0');
});

test('unregistered MTPLX sessions retain connection and readable runtime details', () => {
  const state = getModelsState();
  state.library = [];
  state.serves = [serve({ runtime: 'mtplx', ownership: 'external', mtplxSettings: {
    context_window: 32768, depth: 3, paged_kv_quantization: 'q4', default_temperature: 0, env: { API_KEY: 'fixture-secret' },
  } })];
  showServeInInspector('fixture-serve');
  assert.ok(document.querySelector('[aria-label="Copy base URL"]'));
  const snapshot = document.querySelector('details')!;
  assert.match(snapshot.textContent!, /Context window.*32,768 tokens/);
  assert.match(snapshot.textContent!, /KV quantization.*q4/);
  assert.match(snapshot.textContent!, /leaves it running/);
  assert.doesNotMatch(snapshot.textContent!, /fixture-secret|context_window/);
  assert.equal(document.querySelector('pre'), null);
  assert.ok(button('Eject'));
  state.serves[0].status = 'stopped';
  showServeInInspector('fixture-serve');
  assert.equal(document.querySelector('.models-inspector__footer button'), null);
});

test('failed runtimes show remediation and retry without presenting a ready connection', () => {
  getModelsState().serves = [serve({ status: 'crashed', error: 'Out of memory',
    failure: { title: 'Not enough memory', detail: 'Context allocation failed', remediation: 'Reduce context', suggestedSettings: { ctx: 4096 } } as ServeRecord['failure'] })];
  showModelInInspector(model.id);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /Reduce context/);
  assert.equal(document.querySelector('[aria-label="Copy base URL"]'), null);
  assert.ok(button('Retry with suggested settings'));
});

test('incomplete models explain availability and do not offer launch actions', () => {
  getModelsState().library = [{ ...model, incomplete: true, servable: false, unavailableReason: 'Missing model shard' }];
  getModelsState().serves = [];
  showModelInInspector(model.id);
  assert.match(document.querySelector('.models-details__notice')!.textContent!, /Missing model shard/);
  assert.equal(document.querySelector('.models-inspector__footer button'), null);
});

test('MTPLX snapshots preserve explicit zero and false values, units, and omit empty settings', () => {
  assert.deepEqual(mtplxLoadedWithRows(undefined), []);
  assert.deepEqual(mtplxLoadedWithRows({ default_temperature: 0, allow_swap: false, idle_ttl_ms: 0, env: {}, extra_args: [] }), [
    { label: 'Allow swap', value: 'Off' }, { label: 'Temperature', value: '0' }, { label: 'Unload when idle', value: 'Never' },
  ]);
});
