import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import type { LibraryModel } from '../../src/models/library.ts';
import {
  getLibrarySamplerForId,
  mergeGlobalSamplerWithLibraryModel,
  setLibraryInferencePrefsForTests,
} from '../../src/config/library-inference-meta.ts';
import { normalizeSamplerPreset } from '../../server/agents/sampler.js';
import { samplerToCompletionFields } from '../../src/agents/sampler-types.ts';
import { getModelsState } from '../../src/ui/models/store.ts';
import { showModelInInspector } from '../../src/ui/models/inspector.ts';

const model: LibraryModel = {
  id: 'gguf:unsloth/Qwen3.6-27B-GGUF:Qwen3.6-27B-Q4_K_M.gguf',
  name: 'Qwen3.6-27B-Q4_K_M', repoId: 'unsloth/Qwen3.6-27B-GGUF',
  publisher: 'unsloth', producerSlug: 'qwen', producerName: 'Qwen', producerLogoId: 'qwen',
  format: 'GGUF', quant: 'Q4_K_M', arch: 'qwen35', domain: 'chat',
  paramsB: 27, contextLength: 262144, capabilities: [], sizeBytes: 16_000_000_000,
  path: '/tmp/Qwen3.6-27B-Q4_K_M.gguf', fileName: 'Qwen3.6-27B-Q4_K_M.gguf',
  source: 'downloaded', servable: true, incomplete: false, isMoe: false,
};
const originalFetch = globalThis.fetch;
let saves: Array<{ libraryId: string; sampler: Record<string, unknown> | null }>;

beforeEach(() => {
  const window = new Window();
  globalThis.window = window as never;
  globalThis.document = window.document as never;
  globalThis.localStorage = window.localStorage;
  document.body.innerHTML = '<main id="modelsView" class="models-page is-workbench"><aside id="modelsInspector"></aside></main>';
  setLibraryInferencePrefsForTests({ byLibraryId: {}, chatModelAliases: {} });
  getModelsState().library = [model];
  getModelsState().serves = [];
  saves = [];
  const prefs = { byLibraryId: {} as Record<string, unknown>, chatModelAliases: {} as Record<string, string> };
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    saves.push(payload);
    // Give consecutive UI changes a chance to race an in-flight save.
    await new Promise((resolve) => setTimeout(resolve, 5));
    prefs.byLibraryId[payload.libraryId] = normalizeSamplerPreset(payload.sampler);
    for (const alias of payload.aliases ?? []) prefs.chatModelAliases[alias] = payload.libraryId;
    return Response.json(prefs);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = '';
});

function input(label: string): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(field, label);
  return field;
}

function change(field: HTMLInputElement): void {
  field.dispatchEvent(new window.Event('change', { bubbles: true }));
}

async function finishSaves(): Promise<void> {
  // Flush the ordered save chain and response/cache writes.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('apply fills fields, saves once, and later edits survive reopen and the send path', async () => {
  const stored = { temperature: 0.2, minP: 0.1, maxTokens: 4096, stop: ['END'] };
  setLibraryInferencePrefsForTests({ byLibraryId: { [model.id]: stored }, chatModelAliases: {} });
  showModelInInspector(model.id, 'inference');
  await Promise.resolve();
  assert.equal(input('Temperature').value, '0.2');
  assert.equal(saves.length, 0, 'selecting a model must not apply a preset');

  const select = document.querySelector<HTMLSelectElement>('#models-sampler-preset')!;
  select.value = 'thinking-code';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(input('Temperature').value, '0.2', 'choosing a preset waits for Apply');
  const apply = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent === 'Apply preset')!;
  apply.click();
  assert.deepEqual(['Temperature', 'Top P', 'Top K', 'Min P', 'Presence penalty', 'Repeat penalty']
    .map((label) => input(label).value), ['0.6', '0.95', '20', '0', '0', '1']);
  assert.equal(input('Max tokens').value, '4096');
  assert.equal(input('Temperature').disabled, false);
  showModelInInspector(model.id, 'inference');
  await Promise.resolve();
  assert.equal(input('Temperature').value, '0.6', 'an inspector rebuild keeps the pending preset');
  input('Temperature').value = '0.85';
  change(input('Temperature'));
  await finishSaves();
  assert.equal(saves.length, 2, 'apply and edit each save a snapshot');
  assert.equal(saves[0].sampler?.temperature, 0.6);
  assert.equal(getLibrarySamplerForId(model.id)?.temperature, 0.85);
  assert.equal(getLibrarySamplerForId(model.id)?.minP, 0);
  assert.deepEqual(getLibrarySamplerForId(model.id)?.stop, ['END']);

  showModelInInspector(model.id, 'inference');
  assert.equal(input('Temperature').value, '0.85');
  assert.equal(input('Min P').value, '0');
  const merged = mergeGlobalSamplerWithLibraryModel({
    maxTokens: 131072,
    preset: { temperature: 1, topP: 1, minP: 0.1, presencePenalty: 1.5, repetitionPenalty: 1.2 },
  }, model.name);
  const body = samplerToCompletionFields(merged.preset, merged.maxTokens);
  assert.equal(body.temperature, 0.85);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.min_p, 0);
  assert.equal(body.presence_penalty, 0);
  assert.equal(body.repetition_penalty, 1);
  for (const modelId of [model.id, model.path!]) {
    const byId = mergeGlobalSamplerWithLibraryModel({ maxTokens: 131072, preset: {} }, modelId);
    assert.equal(byId.preset.temperature, 0.85, 'library and weight-path bindings use the saved override');
  }
});

test('unknown models remain editable and another model never receives the preset', async () => {
  showModelInInspector(model.id, 'inference');
  const other = { ...model, id: 'gguf:custom', name: 'custom-model', repoId: 'local/custom', fileName: 'custom.gguf' };
  getModelsState().library.push(other);
  showModelInInspector(other.id, 'inference');
  await Promise.resolve();
  assert.equal(document.querySelector('#models-sampler-preset'), null);
  assert.match(document.body.textContent ?? '', /No recommended preset/);
  input('Temperature').value = '0.35';
  change(input('Temperature'));
  await finishSaves();
  assert.equal(getLibrarySamplerForId(other.id)?.temperature, 0.35);
  assert.equal(getLibrarySamplerForId(model.id), null);
});
