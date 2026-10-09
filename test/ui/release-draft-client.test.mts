import assert from 'node:assert/strict';
import { test, mock, beforeEach } from 'node:test';

let utility = { modelId: 'utility-model', providerId: 'utility-provider' };
const requests: any[] = [];
const cancelled: string[] = [];
let emit: (handlers: any) => void;
let create: () => Promise<{ generationId: string }>;
let needsLoad = false;
const loads: string[] = [];
mock.module('../../src/config/utility-model-meta.ts', { namedExports: {
  loadUtilityModelConfig: async () => utility,
  utilityModelOverride: (config: typeof utility) => config.modelId ? config : null,
} });
mock.module('../../src/ui/default-model.ts', { namedExports: {
  readDefaultModelBinding: () => ({ providerId: 'default-provider', modelId: 'default-model' }),
} });
mock.module('../../src/app-state.ts', { namedExports: { modelCache: new Map() } });
mock.module('../../src/providers/store.ts', { namedExports: {
  resolveProvider: async (id = 'default-provider') => ({ id, apiKind: 'openai-v1' }),
} });
mock.module('../../src/models/library-request-binding.ts', { namedExports: {
  resolveLibraryRequestBinding: async (providerId: string, modelId: string) => needsLoad
    ? { kind: 'needsLoad', libraryModelId: 'library-model' }
    : { kind: 'ready', providerId, modelId },
} });
mock.module('../../src/api/ensure-chat-model-loaded.ts', { namedExports: {
  ensureChatModelLoadedForTurn: async (_provider: string, model: string) => { loads.push(model); needsLoad = false; },
} });
mock.module('../../src/agents/merge-thinking-body.ts', { namedExports: {
  applyUtilityThinkingOff: () => {},
} });
mock.module('../../src/api/generations.ts', { namedExports: {
  createGeneration: async (providerId: string, body: unknown, options: unknown) => {
    requests.push({ providerId, body, options });
    return create();
  },
  subscribeToGeneration: (_id: string, handlers: any) => { queueMicrotask(() => emit(handlers)); return () => {}; },
  cancelGeneration: async (id: string) => { cancelled.push(id); },
  formatGenerationErrorMessage: (message: string) => message,
} });
const { writeReleaseDraft } = await import('../../src/ui/release-draft-client.ts');
const context = { repo: 'github.com/o/r', tag: 'v2', baseTag: 'v1', baseSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), commitCount: 1, commits: [{ sha: 'b'.repeat(40), message: 'feat: navigation' }] };
beforeEach(() => {
  requests.length = cancelled.length = loads.length = 0;
  utility = { modelId: 'utility-model', providerId: 'utility-provider' };
  create = async () => ({ generationId: 'generation-1' });
  needsLoad = false;
  emit = handlers => {
    handlers.onChunk({ choices: [{ delta: { content: '## Features\n- Keyboard navigation.' }, finish_reason: 'stop' }] });
    handlers.onEnd({ status: 'complete' });
  };
});

test('uses the utility model and shared transient generation APIs', async () => {
  const text = await writeReleaseDraft(context, new AbortController().signal, () => {});
  assert.match(text, /Keyboard navigation/);
  assert.equal(requests[0].providerId, 'utility-provider');
  assert.equal(requests[0].body.model, 'utility-model');
  assert.deepEqual(requests[0].options, { persist: false, fallbackRole: 'utility' });
  assert.equal(requests[0].body.tools, undefined);
});

test('unset utility override follows the default binding', async () => {
  utility = { modelId: '', providerId: '' };
  await writeReleaseDraft(context, new AbortController().signal, () => {});
  assert.equal(requests[0].providerId, 'default-provider');
  assert.equal(requests[0].body.model, 'default-model');
});

test('loads library models before inference', async () => {
  needsLoad = true;
  await writeReleaseDraft(context, new AbortController().signal, () => {});
  assert.deepEqual(loads, ['library-model']);
  assert.equal(requests[0].body.model, 'library-model');
});

test('provider failures, empty content, and incomplete output are rejected', async () => {
  emit = handlers => handlers.onEnd({ status: 'error', errorMessage: 'Quota exhausted' });
  await assert.rejects(writeReleaseDraft(context, new AbortController().signal, () => {}), /Quota exhausted/);
  emit = handlers => handlers.onEnd({ status: 'complete' });
  await assert.rejects(writeReleaseDraft(context, new AbortController().signal, () => {}), /no release notes/);
  emit = handlers => {
    handlers.onChunk({ choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] });
    handlers.onEnd({ status: 'complete' });
  };
  await assert.rejects(writeReleaseDraft(context, new AbortController().signal, () => {}), /incomplete release notes/);
});

test('cancel during streaming cancels the backend generation', async () => {
  const controller = new AbortController();
  emit = () => controller.abort();
  await assert.rejects(writeReleaseDraft(context, controller.signal, () => {}), { name: 'AbortError' });
  assert.deepEqual(cancelled, ['generation-1']);
});

test('cancel during generation creation cancels before subscribing', async () => {
  const controller = new AbortController();
  create = async () => { controller.abort(); return { generationId: 'generation-1' }; };
  emit = () => assert.fail('Must not subscribe');
  await assert.rejects(writeReleaseDraft(context, controller.signal, () => {}), { name: 'AbortError' });
  assert.deepEqual(cancelled, ['generation-1']);
});
