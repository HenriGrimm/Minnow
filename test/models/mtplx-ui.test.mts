import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Window } from 'happy-dom';
import { enginesForModel, defaultEngineFor } from '../../src/models/engine-support.ts';
import { buildLibrary, loadableLibrary, type LibraryModel } from '../../src/models/library.ts';
import { renderModelEngineSettings } from '../../src/ui/models/mtplx-load.ts';
import { getLibraryLaunchSettingsForId, saveLibraryLaunchSettings, setLibraryLaunchPrefsForTests } from '../../src/config/library-launch-meta.ts';

const win = new Window();
const prior = { document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
const row = { id: 'mtplx:Fixture/Model', name: 'Model', source: 'mtplx-cache', format: 'MLX', servable: true, incomplete: false, mtplxValidated: true } as LibraryModel;
const descriptor = { source: 'inspect', draft: { supported: true, minimum: 1, maximum: 2, default: 2 },
  contextWindow: { supported: true, minimum: 4096, maximum: 16384, default: 8192, step: 1024 },
  kvQuant: { supported: true, modes: ['off', 'q8'], restartRequired: true },
  reasoning: { supported: true, modes: ['on'], effortLevels: ['low'], defaultEffort: 'low' } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

before(() => {
  globalThis.document = win.document as unknown as Document;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: win.localStorage });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/mtplx/descriptor')) return Response.json(descriptor);
    if (String(url).includes('/mtplx/estimate')) return Response.json({ estimateGb: 8, budgetGb: 32, estimateSource: 'config-upper-bound' });
    if (String(url) === '/api/models/launch') {
      const payload = JSON.parse(String(options?.body));
      return Response.json({ byLibraryId: { [payload.libraryId]: payload.settings } });
    }
    throw new Error('Unexpected fixture request: ' + url);
  };
});
after(() => {
  globalThis.document = prior.document; globalThis.fetch = prior.fetch;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prior.localStorage });
  win.happyDOM.abort();
});

test('engine choices separate weight format from validated runtime support', () => {
  assert.deepEqual(enginesForModel(row), ['mtplx', 'mlx-lm']);
  assert.equal(defaultEngineFor(row), 'mtplx');
  assert.deepEqual(enginesForModel({ ...row, mtplxValidated: false }), []);
  assert.deepEqual(enginesForModel({ ...row, incomplete: true }), []);
  assert.deepEqual(enginesForModel({ ...row, source: 'hf-cache' }), ['mlx-lm']);
  assert.deepEqual(enginesForModel({ ...row, source: 'downloaded', format: 'GGUF' }), ['llama-cpp']);
});
test('library keeps MTPLX identity, MLX format, invalid reason and Metal visibility', async () => {
  const library = await buildLibrary([{ repo_id: 'Fixture/Model', path: '/cache', mtplx_root: '/cache/model', mlx_root: '/cache/model', mtplx_validated: false,
    mtplx_reason: 'Missing files: mtp.safetensors', has_incomplete: true, nb_files: 1, size_bytes: 100 }]);
  assert.equal(library[0].id, 'mtplx:Fixture/Model'); assert.equal(library[0].format, 'MLX');
  assert.equal(library[0].servable, false); assert.match(library[0].unavailableReason!, /mtp.safetensors/);
  assert.equal(loadableLibrary(library, { backend: 'metal' }).length, 1);
  assert.equal(loadableLibrary(library, { backend: 'cuda' }).length, 0);
});
test('load form uses descriptor bounds, preserves engine drafts and omits llama controls for MLX', async () => {
  setLibraryLaunchPrefsForTests({ byLibraryId: {} });
  const body = document.createElement('div'); document.body.append(body);
  const render = () => { body.replaceChildren(); renderModelEngineSettings(row, body, render); };
  render(); await settle();
  const field = (label: string) => [...body.querySelectorAll('label')].find((node) => node.firstElementChild?.textContent === label)?.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
  const depth = field('MTP depth') as HTMLInputElement;
  assert.equal(depth.max, '2'); assert.equal((field('Context window') as HTMLInputElement).step, '1024');
  assert.equal(body.textContent?.includes('q4'), false);
  depth.value = '6'; depth.dispatchEvent(new win.Event('change') as unknown as Event); await settle();
  assert.equal(depth.value, '2'); assert.match(body.textContent!, /adjusted to 2/);
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.depth, 2);
  const engine = field('Engine'); engine.value = 'mlx-lm'; engine.dispatchEvent(new win.Event('change') as unknown as Event); await settle();
  assert.equal(body.querySelectorAll('input').length, 0);
  assert.match(body.textContent!, /No llama.cpp settings apply/);
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.depth, 2);
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.ctx, undefined);
  body.remove();
});

test('rapid launch edits stay optimistic and persist in order', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ settings: unknown; release: () => void }> = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    await new Promise<void>((resolve) => requests.push({ settings: payload.settings, release: resolve }));
    return Response.json({ byLibraryId: { [payload.libraryId]: payload.settings } });
  };
  try {
    const first = saveLibraryLaunchSettings({ libraryId: row.id, settings: { engine: 'mtplx', mtplx: { depth: 1 } } });
    const second = saveLibraryLaunchSettings({ libraryId: row.id, settings: { engine: 'mtplx', mtplx: { depth: 2 } } });
    await settle(); assert.equal(requests.length, 1);
    requests[0].release(); await first; await settle();
    assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.depth, 2);
    assert.equal(requests.length, 2);
    requests[1].release(); await second;
    assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.depth, 2);
  } finally { globalThis.fetch = originalFetch; }
});
