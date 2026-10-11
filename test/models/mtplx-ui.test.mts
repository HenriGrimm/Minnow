import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Window } from 'happy-dom';
import { enginesForModel, defaultEngineFor } from '../../src/models/engine-support.ts';
import { buildLibrary, loadableLibrary, type LibraryModel } from '../../src/models/library.ts';
import { renderModelEngineSettings } from '../../src/ui/models/mtplx-load.ts';
import { createLoadSettingsLayout } from '../../src/ui/models/load-settings-layout.ts';
import { getLibraryLaunchSettingsForId, saveLibraryLaunchSettings, setLibraryLaunchPrefsForTests } from '../../src/config/library-launch-meta.ts';

const win = new Window();
const prior = { document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
const row = { id: 'mtplx:Fixture/Model', name: 'Model', source: 'mtplx-cache', format: 'MLX', servable: true, incomplete: false, mtplxValidated: true } as LibraryModel;
const descriptor = { source: 'inspect', draft: { supported: true, minimum: 1, maximum: 2, default: 2 },
  contextWindow: { supported: true, minimum: 4096, maximum: 16384, default: 8192, step: 1024 },
  kvQuant: { supported: true, modes: ['off', 'q8'], restartRequired: true },
  reasoning: { supported: true, modes: ['on'], effortLevels: ['low'], defaultEffort: 'low' },
  loadDefaults: { profile: 'sustained', generation_mode: 'Model recommendation (MTP fallback)',
    depth: 1, context_window: 12288, paged_kv_quantization: 'off', reasoning: 'on', reasoning_effort: 'low',
    reasoning_parser: 'qwen3', preserve_thinking: 'auto (model history policy)', tool_prompt_mode: 'native',
    enable_thermal_poll: true, allow_swap: false, default_temperature: 0, default_presence_penalty: 0,
    scheduling_preset: 'auto', max_active_requests: 1, decode_batch_max: 1, batch_wait_ms: 0 } };
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
  const depth = field('Depth') as HTMLInputElement;
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

test('load panel preserves expanded controls and scroll through status remounts', async () => {
  setLibraryLaunchPrefsForTests({ byLibraryId: {} });
  const host = document.createElement('div'); document.body.append(host);
  let body: HTMLDivElement;
  const render = () => {
    body = document.createElement('div'); host.replaceChildren(body);
    renderModelEngineSettings(row, body, render);
  };
  const reasoning = () => [...body.querySelectorAll('details')].find((node) => node.querySelector('summary')?.textContent === 'Reasoning')!;
  render(); await settle();
  reasoning().open = true; reasoning().dispatchEvent(new win.Event('toggle') as unknown as Event);
  body!.scrollTop = 320; body!.dispatchEvent(new win.Event('scroll') as unknown as Event);
  render(); await settle();
  assert.equal(reasoning().open, true);
  assert.equal(body!.scrollTop, 320);
  reasoning().open = false; reasoning().dispatchEvent(new win.Event('toggle') as unknown as Event);
  render(); await settle();
  assert.equal(reasoning().open, false);
  host.remove();
});

test('load controls show inherited values, retain explicit overrides and reset to inheritance', async () => {
  setLibraryLaunchPrefsForTests({ byLibraryId: { [row.id]: { engine: 'mtplx', mtplx: { profile: 'turbo', allow_swap: false } } } });
  const body = document.createElement('div'); document.body.append(body);
  const render = () => { body.replaceChildren(); renderModelEngineSettings(row, body, render); };
  const field = (label: string) => [...body.querySelectorAll('label')].find((node) => node.firstElementChild?.textContent === label)?.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
  render(); await settle();
  assert.equal(field('Profile').value, 'turbo');
  for (const [label, expected] of [['Profile', 'Sustained'], ['KV quantization', 'Off'], ['Reasoning', 'On'], ['Reasoning effort', 'Low'], ['Reasoning parser', 'qwen3'], ['Tool prompts', 'native'], ['Enable thermal polling', 'On'], ['Allow swap', 'Off'], ['Mode', 'Auto']]) {
    assert.equal(field(label).querySelector('option')?.textContent, `${expected} (default)`);
  }
  assert.equal(field('Generation mode').querySelector('option')?.textContent, 'Model recommendation (MTP fallback) (default)');
  assert.equal(field('Preserve thinking').querySelector('option')?.textContent, 'auto (model history policy) (default)');
  assert.equal((field('Depth') as HTMLInputElement).placeholder, '1');
  assert.equal((field('Context window') as HTMLInputElement).placeholder, '12288');
  assert.equal((field('Temperature') as HTMLInputElement).placeholder, '0');
  assert.equal((field('Presence Penalty') as HTMLInputElement).placeholder, '0');
  assert.equal(field('Enable thermal polling').value, '');
  assert.equal(field('Allow swap').value, 'off');
  assert.equal(body.textContent?.includes('Engine default'), false);
  const change = async (label: string, value: string) => {
    const input = field(label); input.value = value;
    input.dispatchEvent(new win.Event('change') as unknown as Event); await settle();
  };
  await change('Profile', '');
  await change('Enable thermal polling', 'off');
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.profile, undefined);
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.enable_thermal_poll, false);
  await change('Enable thermal polling', '');
  await change('Allow swap', '');
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.enable_thermal_poll, undefined);
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.allow_swap, undefined);
  render(); await settle();
  assert.equal(field('Profile').value, '');
  assert.equal(field('Profile').querySelector('option')?.textContent, 'Sustained (default)');
  body.remove();
});

test('Performance mode and concurrency cap follow the MTPLX app presets', async () => {
  setLibraryLaunchPrefsForTests({ byLibraryId: { [row.id]: { engine: 'mtplx', mtplx: { scheduler_mode: 'ar_batch', batching_preset: 'agent', max_active_requests: 6 } } } });
  const body = document.createElement('div'); document.body.append(body);
  renderModelEngineSettings(row, body, () => {});
  await settle();
  const field = (label: string) => body.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
  const change = async (label: string, value: string) => {
    const input = field(label); input.value = value;
    input.dispatchEvent(new win.Event('change') as unknown as Event); await settle();
  };
  const mode = field('Mode') as HTMLSelectElement;
  assert.deepEqual([...mode.options].map((option) => option.textContent), ['Auto (default)', 'Fastest response', 'Handle multiple at once', 'Long agent tasks']);
  assert.equal(mode.value, 'agent');
  assert.equal(field('Concurrency cap').value, '6');
  assert.equal((field('Decode batch max') as HTMLInputElement).placeholder, '4');
  assert.equal((field('Admission window') as HTMLInputElement).placeholder, '50');
  await change('Mode', 'throughput');
  const saved = getLibraryLaunchSettingsForId(row.id)?.mtplx;
  assert.equal(saved?.scheduling_preset, 'throughput');
  for (const key of ['scheduler_mode', 'batching_preset', 'max_active_requests'] as const) assert.equal(saved?.[key], undefined);
  assert.equal(field('Concurrency cap').value, '');
  assert.equal((field('Concurrency cap') as HTMLInputElement).placeholder, '8');
  await change('Concurrency cap', '20');
  assert.equal(field('Concurrency cap').value, '16');
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.max_active_requests, 16);
  await change('Mode', '');
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.scheduling_preset, undefined);
  assert.equal((field('Concurrency cap') as HTMLInputElement).placeholder, '1');
  body.remove();
});

test('MTPLX Basic and Advanced share descriptor limits and retain edits across views', async () => {
  setLibraryLaunchPrefsForTests({ byLibraryId: {} });
  const body = document.createElement('div');
  document.body.appendChild(body);
  const { basic, advanced } = createLoadSettingsLayout(body, row.id);
  renderModelEngineSettings(row, basic, () => {}, advanced);
  await settle();
  const context = basic.querySelector<HTMLInputElement>('[aria-label="Context window"]')!;
  assert.ok(context);
  assert.equal(context.max, '16384');
  assert.equal(basic.querySelector('[aria-label="Depth"]'), null);
  assert.ok(advanced.querySelector('[aria-label="Depth"]'));
  context.value = '65536';
  context.dispatchEvent(new win.Event('change') as unknown as Event);
  await settle();
  assert.equal(context.value, '16384');
  document.getElementById('modelsLoadTab-advanced')!.click();
  assert.equal(basic.hidden, true);
  assert.equal(advanced.hidden, false);
  document.getElementById('modelsLoadTab-basic')!.click();
  assert.equal(basic.querySelector('[aria-label="Context window"]'), context);
  assert.equal(getLibraryLaunchSettingsForId(row.id)?.mtplx?.context_window, 16384);
  body.remove();
});

test('MTPLX omits controls the model descriptor does not support', async () => {
  const previous = [descriptor.draft.supported, descriptor.contextWindow.supported, descriptor.kvQuant.supported, descriptor.reasoning.supported];
  const body = document.createElement('div');
  document.body.appendChild(body);
  try {
    descriptor.draft.supported = descriptor.contextWindow.supported = descriptor.kvQuant.supported = descriptor.reasoning.supported = false;
    setLibraryLaunchPrefsForTests({ byLibraryId: {} });
    const { basic, advanced } = createLoadSettingsLayout(body, row.id);
    renderModelEngineSettings(row, basic, () => {}, advanced);
    await settle();
    for (const label of ['Context window', 'KV quantization', 'Reasoning', 'Reasoning effort', 'Depth', 'Adaptive depth']) {
      assert.equal(body.querySelector(`[aria-label="${label}"]`), null);
    }
    assert.ok(body.querySelector('[aria-label="Profile"]'));
  } finally {
    [descriptor.draft.supported, descriptor.contextWindow.supported, descriptor.kvQuant.supported, descriptor.reasoning.supported] = previous;
    body.remove();
  }
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
