import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { Chat } from '../../src/types';
import type { HeadlessRunCliOptions } from '../../src/headless/argv';
import type { WorkAgentDefinition } from '../../src/agents/work-agent-types';

let providerCalls: string[] = [], loads: string[] = [];
let loadError: Error | null = null;
let override: Record<string, string> = {};
const providers = ['lm-studio-local', 'mtplx-local', 'mlx-lm-local', 'llama-cpp-local'].map(id => ({ id, enabled: true }));
mock.module('../../src/providers/store.ts', { namedExports: {
  listProviders: async () => ({ providers }),
  invalidateProviderCache: () => {},
  getActiveProvider: async (id?: string) => {
    providerCalls.push(id ?? 'default');
    const provider = providers.find(row => row.id === (id ?? 'lm-studio-local'));
    if (!provider && id !== 'minnow-router') throw new Error(`Unknown provider id: ${id}`);
    return provider ?? { id };
  },
} });
mock.module('../../src/agents/work-agent-registry.ts', { namedExports: { getUserWorkAgentOverride: () => override } });
mock.module('../../src/models/model-select-library.ts', { namedExports: {
  isLibraryModelBinding: (providerId: string, modelId: string) => providerId === 'minnow-library' && /^(mtplx|mlx|gguf):/.test(modelId),
  resolveUpstreamProviderId: (providerId: string) => providerId,
} });
mock.module('../../src/models/api-client.ts', { namedExports: {
  bindLibraryModel: async (providerId: string, modelId: string, signal: AbortSignal) => {
    signal.throwIfAborted(); loads.push(modelId);
    if (loadError) throw loadError;
    return { providerId: modelId.startsWith('mtplx:') ? 'mtplx-local' : modelId.startsWith('mlx:') ? 'mlx-lm-local' : 'llama-cpp-local', modelId: 'served-model' };
  },
} });
const { resolveHeadlessModelBinding } = await import('../../src/headless/resolve-model-binding');
const chat = (extra = {}) => ({ modelId: '', ...extra }) as Chat;
const cli = (extra = {}) => extra as HeadlessRunCliOptions;
const signal = () => new AbortController().signal;
beforeEach(() => { providerCalls = []; loads = []; loadError = null; override = {}; });

for (const model of ['mtplx:Org/Qwen', 'mlx:Org/Qwen', 'gguf:Org/Qwen:weights.gguf']) {
  test(`synthetic ${model} selection resolves before registry lookup`, async () => {
    const result = await resolveHeadlessModelBinding(chat(), cli({ providerId: 'minnow-library', modelId: model }), null, signal());
    assert.equal(result.modelId, 'served-model'); assert.deepEqual(loads, [model]);
    assert.deepEqual(providerCalls, [result.providerId]);
  });
}
test('explicit CLI provider and model take precedence over work-agent overrides', async () => {
  override = { providerId: 'lm-studio-local', modelId: 'agent-model' };
  const agent = { id: 'builder', providerId: 'lm-studio-local', modelId: 'agent-default' } as WorkAgentDefinition;
  const result = await resolveHeadlessModelBinding(chat(), cli({ providerId: 'minnow-library', modelId: 'mtplx:Org/Qwen' }), agent, signal());
  assert.equal(result.providerId, 'mtplx-local'); assert.equal(result.modelId, 'served-model');
});
test('work-agent binding remains authoritative when no CLI selection is supplied', async () => {
  const agent = { id: 'builder', providerId: 'mtplx-local', modelId: 'agent-default' } as WorkAgentDefinition;
  const result = await resolveHeadlessModelBinding(chat(), cli(), agent, signal());
  assert.equal(result.providerId, 'mtplx-local'); assert.equal(result.modelId, 'agent-default'); assert.deepEqual(loads, []);
});
test('persisted direct bindings pass through and unknown providers cannot fall back', async () => {
  const result = await resolveHeadlessModelBinding(chat({ providerId: 'mtplx-local', modelId: 'saved' }), cli(), null, signal());
  assert.equal(result.modelId, 'saved'); assert.deepEqual(providerCalls, ['mtplx-local']);
  await assert.rejects(resolveHeadlessModelBinding(chat(), cli({ providerId: 'missing', modelId: 'wrong' }), null, signal()), /Unknown provider/);
  assert.deepEqual(loads, []);
});
test('library load failure and cancellation never select another provider', async () => {
  loadError = new Error('Model failed to load');
  const options = cli({ providerId: 'minnow-library', modelId: 'mtplx:Org/Qwen' });
  await assert.rejects(resolveHeadlessModelBinding(chat(), options, null, signal()), /Model failed to load/);
  assert.deepEqual(providerCalls, []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveHeadlessModelBinding(chat(), options, null, controller.signal), { name: 'AbortError' });
});
