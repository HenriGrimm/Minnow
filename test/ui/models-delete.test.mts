import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { CachedModelRow, ServeRecord } from '../../src/models/api-client.ts';

mock.module('../../src/api/stream-event-source.ts', {
  namedExports: { StreamEventSource: class {
    addEventListener() {}
    close() {}
  } },
});

const { buildLibrary } = await import('../../src/models/library.ts');
const { getModelsState, refreshModels, teardownModelsStore } = await import('../../src/ui/models/store.ts');
const { render } = await import('../../src/ui/models/library-panel.ts');
const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
let cached: CachedModelRow[];
let requests: Array<{ libraryId: string; modelPath: string }>;
let failDelete: boolean;
const previousFetch = globalThis.fetch;

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`UI operation did not settle: ${document.getElementById('sText')?.textContent}`);
}

beforeEach(async () => {
  const { Window } = await import('happy-dom');
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.HTMLInputElement = win.HTMLInputElement;
  globalThis.requestAnimationFrame = (cb) => { cb(0); return 1; };
  resetAppDialogForTests();
  document.body.innerHTML = '<div id="modelsInstalledBody"></div><div id="sDot"></div><div id="sText"></div>';
  requests = [];
  failDelete = false;
  cached = [{
    repo_id: 'test/delete', path: '/models/test--delete', size_bytes: 192, nb_files: 2,
    has_incomplete: false, is_gguf: true, status: 'downloaded',
    gguf_files: [
      { name: 'Model-7B-Q4_K_M.gguf', rel_path: 'Model-7B-Q4_K_M.gguf', quant: 'Q4_K_M', role: 'model', size_bytes: 64 },
      { name: 'Model-7B-Q8_0.gguf', rel_path: 'Model-7B-Q8_0.gguf', quant: 'Q8_0', role: 'model', size_bytes: 128 },
    ],
  }];
  const state = getModelsState();
  state.library = await buildLibrary(cached);
  state.serves = [];
  state.loads = [];
  state.selectedId = state.library[0].id;
  state.selectedServeId = null;
  state.scanning = false;
  state.error = null;
  // Avoid the asynchronous hardware probe during post-delete refresh.
  state.hardware = { backend: 'cuda' } as typeof state.hardware;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'DELETE') {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (failDelete) return Response.json({ error: 'Permission denied deleting weights' }, { status: 400 });
      cached[0].gguf_files = cached[0].gguf_files?.filter((f) => body.libraryId !== `gguf:test/delete:${f.rel_path}`);
      return Response.json({ deleted: true });
    }
    if (url === '/api/models/cached') return Response.json({ models: cached });
    if (url === '/api/models/installed') return Response.json({ artifacts: [], downloads: [] });
    if (url === '/api/models/serve') return Response.json({ serves: [] });
    if (url === '/api/models/runtimes') return Response.json({});
    return Response.json({});
  };
  render();
});

afterEach(() => {
  resetAppDialogForTests();
  teardownModelsStore();
  globalThis.fetch = previousFetch;
  document.body.innerHTML = '';
});

function deleteButton(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>('.models-row__actions [aria-label^="Delete "]');
  assert.ok(btn);
  return btn;
}

async function answerDialog(action: 'cancel' | 'confirm'): Promise<void> {
  await waitFor(() => Boolean(document.querySelector('[data-dialog-action="confirm"]')));
  document.querySelector<HTMLButtonElement>(`[data-dialog-action="${action}"]`)!.click();
}

test('cancel preserves the model and makes no delete request', async () => {
  const selected = getModelsState().selectedId;
  deleteButton().click();
  await answerDialog('cancel');
  await waitFor(() => !deleteButton().disabled);
  assert.equal(requests.length, 0);
  assert.equal(getModelsState().library.length, 2);
  assert.equal(getModelsState().selectedId, selected);
});

test('confirmation identifies the chosen quantization and path, then removes only that variant', async () => {
  const quant = document.querySelector<HTMLSelectElement>('.models-row__quant-select')!;
  quant.value = 'gguf:test/delete:Model-7B-Q8_0.gguf';
  quant.dispatchEvent(new window.Event('change'));
  deleteButton().click();
  await waitFor(() => Boolean(document.querySelector('[data-dialog-action="confirm"]')));
  const message = document.querySelector('.app-dialog-panel__message')?.textContent ?? '';
  assert.match(message, /Q8_0/);
  assert.match(message, /\/models\/test--delete\/Model-7B-Q8_0.gguf/);
  await answerDialog('confirm');
  await waitFor(() => document.getElementById('sText')?.textContent === 'Model deleted');
  assert.deepEqual(requests, [{ libraryId: quant.value, modelPath: '/models/test--delete/Model-7B-Q8_0.gguf' }]);
  assert.equal(getModelsState().library.length, 1);
  assert.equal(getModelsState().library[0].quant, 'Q4_K_M');
  assert.equal(getModelsState().selectedId, null);
  assert.equal(getModelsState().selectedServeId, null);
});

test('delete failures keep the model visible and report the server error', async () => {
  failDelete = true;
  deleteButton().click();
  await answerDialog('confirm');
  await waitFor(() => document.getElementById('sText')?.textContent === 'Permission denied deleting weights');
  assert.equal(getModelsState().library.length, 2);
  assert.equal(deleteButton().disabled, false);
});

test('loaded models retain Eject and explain why deletion is disabled', async () => {
  const model = getModelsState().library[0];
  getModelsState().serves = [{ modelPath: model.path!, status: 'running' }] as ServeRecord[];
  render();
  assert.equal(deleteButton().disabled, true);
  assert.match(deleteButton().title, /Eject/);
  assert.match(document.querySelector('.models-row__actions')?.textContent ?? '', /Eject/);
});

test('keyboard activation of a delete button does not select its row', async () => {
  getModelsState().selectedId = null;
  render();
  deleteButton().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(getModelsState().selectedId, null);
});

test('refresh keeps an unavailable MTPLX model selected for inspection', async () => {
  cached = [{
    repo_id: 'test/mtplx', path: '/models/test--mtplx', size_bytes: 192, nb_files: 2,
    has_incomplete: true, mlx_root: '/models/test--mtplx', mtplx_root: '/models/test--mtplx',
    mtplx_validated: false,
  }];
  getModelsState().selectedId = 'mtplx:test/mtplx';
  await refreshModels({ hardware: false });
  assert.equal(getModelsState().selectedId, 'mtplx:test/mtplx');
  assert.equal(getModelsState().library[0].servable, false);
});

test('refresh clears both inspector identities when the selected model disappears', async () => {
  getModelsState().selectedServeId = 'missing-serve';
  cached = [];
  await refreshModels({ hardware: false });
  assert.equal(getModelsState().selectedId, null);
  assert.equal(getModelsState().selectedServeId, null);
});
