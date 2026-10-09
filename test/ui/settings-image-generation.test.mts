import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const initial = { enabled: true, providerId: 'images', adapterId: 'openai', modelId: 'image-model', defaults: {}, maxConcurrentJobs: 1, timeoutSeconds: 600 };
let saved = { ...initial };
let fail = false;
const calls: string[] = [];
const discoveries: Record<string, unknown>[] = [];
let discover = async (_args: Record<string, unknown>): Promise<unknown> => ({ status: 'Available', models: [{ id: 'image-model' }, { id: 'new-image' }] });
const supportedConnections = [
  { id: 'images', label: 'My image account', baseUrl: 'https://api.openai.com/v1', enabled: true, apiKind: 'openai-v1' },
  { id: 'other', label: 'My gateway', baseUrl: 'https://openrouter.ai/api', enabled: true, apiKind: 'openai-v1' },
];
let connections = [...supportedConnections];
mock.module('../../src/config/image-generation-meta.ts', { namedExports: {
  loadImageGenerationConfig: async () => saved,
  saveImageGenerationConfig: async (next: typeof saved) => { if (fail) throw new Error('Save failed'); saved = next; },
} });
mock.module('../../src/providers/store.ts', { namedExports: { listProviders: async () => ({ providers: connections }) } });
mock.module('../../src/tools/client.ts', { namedExports: { executeTool: async (name: string, args: Record<string, unknown>) => {
  if (args.list_models) { discoveries.push(args); return { content: JSON.stringify(await discover(args)) }; }
  calls.push(name); return { content: JSON.stringify({ status: 'Ready', capabilities: { options: { format: ['png', 'webp'] } } }) };
} } });
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => '/workspace' } });
mock.module('../../src/ui/settings-layout.ts', { namedExports: {
  appendSettingsGroup: (mount: HTMLElement) => { const body = document.createElement('section'); mount.append(body); return body; },
  linkToSettingsSection: (label: string) => { const link = document.createElement('a'); link.textContent = label; return link; },
} });

test('settings preserve edits on save failure; metadata and test buttons use separate approved tools', async () => {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document });
  const { renderImageGenerationSettings } = await import('../../src/ui/settings-image-generation.ts');
  const mount = document.createElement('div'); document.body.append(mount);
  await renderImageGenerationSettings(mount);
  const button = (text: string) => [...mount.querySelectorAll('button')].find(b => b.textContent === text)!;
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  await settle();
  assert.deepEqual(discoveries, [{ list_models: true, provider_id: 'images', adapter_id: 'openai' }]);
  button('Check connection').click(); await settle();
  assert.deepEqual(calls, ['image_generation_info']);
  assert.ok(mount.textContent?.includes('No image was generated'));
  const input = mount.querySelectorAll('select')[2];
  input.value = 'new-image'; input.dispatchEvent(new window.Event('change') as unknown as Event);
  fail = true; button('Save').click(); await settle();
  assert.equal(saved.modelId, 'image-model'); assert.equal(input.value, 'new-image');
  fail = false; button('Retry save').click(); await settle();
  assert.equal(saved.modelId, 'new-image');
  button('Generate test image…').click(); await settle();
  assert.deepEqual(calls, ['image_generation_info', 'generate_image']);
  await window.happyDOM.close();
});

test('first-time setup discovers before enable/save, and ignores a superseded provider response', async () => {
  saved = { ...initial, enabled: false, providerId: '', adapterId: '', modelId: '' };
  discoveries.length = 0;
  let release!: (value: unknown) => void;
  discover = args => args.provider_id === 'images' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ status: 'Available', models: [{ id: 'other-image' }] });
  const window = new Window(); Object.assign(globalThis, { window, document: window.document });
  const { renderImageGenerationSettings } = await import('../../src/ui/settings-image-generation.ts');
  const mount = document.createElement('div'); document.body.append(mount); await renderImageGenerationSettings(mount);
  const [provider, adapter, model] = mount.querySelectorAll('select');
  const change = (select: HTMLSelectElement, value: string) => { select.value = value; select.dispatchEvent(new window.Event('change') as unknown as Event); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  change(provider, 'images'); change(adapter, 'openai'); await settle();
  assert.equal(saved.providerId, ''); assert.equal(saved.enabled, false);
  change(provider, 'other'); await settle();
  assert.equal(adapter.value, 'openrouter'); assert.equal(adapter.disabled, true);
  assert.deepEqual(discoveries.at(-1), { list_models: true, provider_id: 'other', adapter_id: 'openrouter' });
  assert.ok([...model.options].some(option => option.value === 'other-image'));
  release({ status: 'Available', models: [{ id: 'stale-image' }] }); await settle();
  assert.ok(![...model.options].some(option => option.value === 'stale-image'));
  change(model, 'other-image');
  [...mount.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click(); await settle();
  assert.equal(saved.providerId, 'other'); assert.equal(saved.modelId, 'other-image');
  assert.equal(saved.enabled, false);
  await window.happyDOM.close();
});

test('image providers only show enabled official API connections and never query an unsupported saved provider', async () => {
  const unsupported = [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://custom.example.test', apiKind: 'openai-v1', enabled: true },
    { id: 'spoof', label: 'OpenRouter', baseUrl: 'https://openrouter.ai.example.test/api', apiKind: 'openai-v1', enabled: true },
    { id: 'local', label: 'LM Studio', baseUrl: 'http://localhost:1234', apiKind: 'lm-studio-v0', enabled: true },
    { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', apiKind: 'openai-v1', enabled: true },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai', apiKind: 'openai-v1', enabled: true },
    { id: 'codex', label: 'Codex', baseUrl: 'https://api.openai.com', apiKind: 'agent-cli-v1', enabled: true },
    { id: 'disabled', label: 'Disabled OpenAI', baseUrl: 'https://api.openai.com', apiKind: 'openai-v1', enabled: false },
    { id: 'http', label: 'OpenAI over HTTP', baseUrl: 'http://api.openai.com', apiKind: 'openai-v1', enabled: true },
    { id: 'bad-url', label: 'Invalid', baseUrl: 'invalid', apiKind: 'openai-v1', enabled: true },
  ];
  connections = [...supportedConnections, ...unsupported]; saved = { ...initial, providerId: 'openai' }; discoveries.length = 0;
  const window = new Window(); Object.assign(globalThis, { window, document: window.document });
  const { renderImageGenerationSettings } = await import('../../src/ui/settings-image-generation.ts');
  const mount = document.createElement('div'); document.body.append(mount); await renderImageGenerationSettings(mount);
  const provider = mount.querySelector('select')!;
  assert.deepEqual([...provider.options].map(option => option.value), ['', 'images', 'other']);
  assert.equal(provider.value, ''); assert.equal(discoveries.length, 0); assert.equal(saved.providerId, 'openai');
  assert.ok(mount.textContent?.includes('Saved image provider is unsupported or disabled'));
  assert.equal([...mount.querySelectorAll('button')].find(button => button.textContent === 'Generate test image…')!.disabled, true);
  connections = unsupported; saved = { ...initial, enabled: false, providerId: '', adapterId: '', modelId: '' };
  const emptyMount = document.createElement('div'); document.body.append(emptyMount); await renderImageGenerationSettings(emptyMount);
  assert.equal(emptyMount.querySelector('select')!.options.length, 1);
  assert.ok(emptyMount.textContent?.includes('Add and enable an OpenAI or OpenRouter API connection'));
  assert.equal(discoveries.length, 0);
  connections = [...supportedConnections];
  await window.happyDOM.close();
});

test('missing saved models survive discovery failure and empty refresh; custom entry remains available', async () => {
  saved = { ...initial }; discover = async () => { throw new Error('offline'); };
  const window = new Window(); Object.assign(globalThis, { window, document: window.document });
  const { renderImageGenerationSettings } = await import('../../src/ui/settings-image-generation.ts');
  const mount = document.createElement('div'); document.body.append(mount); await renderImageGenerationSettings(mount);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20)); await settle();
  const model = mount.querySelectorAll('select')[2];
  assert.equal(model.value, 'image-model'); assert.ok(mount.textContent?.includes('Could not load image models'));
  discover = async () => ({ status: 'Available', models: [] });
  [...mount.querySelectorAll('button')].find(button => button.textContent === 'Refresh models')!.click(); await settle();
  assert.equal(model.value, 'image-model'); assert.ok(mount.textContent?.includes('No supported image models found'));
  model.value = '__custom_image_model__'; model.dispatchEvent(new window.Event('change') as unknown as Event);
  const custom = mount.querySelector('input[type="text"]') as HTMLInputElement;
  assert.equal(custom.closest('.settings-row')?.hasAttribute('hidden'), false);
  custom.value = 'custom-image'; custom.dispatchEvent(new window.Event('input') as unknown as Event);
  [...mount.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click(); await settle();
  assert.equal(saved.modelId, 'custom-image');
  await window.happyDOM.close();
});
