import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mtplxReasoningCatalog } from '../../server/models/mtplx-reasoning.js';
import { modelOptionSupport, resolveAgentModelSelection } from '../../server/chats/model-selection.js';
import { mergeThinkingIntoCompletionBody } from '../../server/runner/merge-thinking-body.js';

test('MTPLX library and runtime aliases use descriptor effort controls', () => {
  const descriptor = { reasoning: { supported: true, modes: ['auto', 'on', 'off'],
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'xhigh' } };
  const reasoning = mtplxReasoningCatalog(descriptor);
  assert.deepEqual(reasoning.allowed_options, ['off', 'on', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(reasoning.default, 'xhigh');
  assert.equal(mtplxReasoningCatalog(), undefined);
  assert.deepEqual(mtplxReasoningCatalog({ reasoning: { supported: false } }), {
    source: 'mtplx', allowed_options: ['off'], default: 'off',
  });
  assert.equal(mtplxReasoningCatalog(descriptor, { reasoning_effort: 'low' }).default, 'low');
  assert.equal(mtplxReasoningCatalog(descriptor, { reasoning: 'off' }).default, 'off');
  assert.equal(mtplxReasoningCatalog({ reasoning: { modes: ['auto', 'on'], effortLevels: [] } }).default, 'on');
});

test('library preflight uses live MTPLX controls and preserves old Qwen High selections', async () => {
  const providerId = 'minnow-library';
  const modelId = 'mtplx:Fixture/Qwen3.8';
  const selection = { providerId, modelId, options: { reasoningEffort: 'high' } };
  const descriptor = { reasoning: { supported: true, modes: ['auto', 'on', 'off'],
    effortLevels: ['xhigh', 'medium', 'low'], defaultEffort: 'medium' } };
  const result = await resolveAgentModelSelection({ target: selection }, { adapters: {
    listLibraryModels: async () => [{ repo_id: 'Fixture/Qwen3.8', mtplx_validated: true }],
    resolveLibraryTarget: async () => ({ runtime: 'mtplx' }),
    readCapabilities: async () => ({ models: { [modelId]: { reasoning: false } } }),
    listServes: async () => [{ libraryId: modelId, runtime: 'mtplx', status: 'running', mtplxDescriptor: descriptor }],
  } });
  assert.deepEqual(result.sendCapabilities.reasoningAllowedOptions, ['off', 'on', 'low', 'medium', 'xhigh']);
  assert.equal(result.sendCapabilities.reasoningDefault, 'medium');
  assert.equal(result.selection.options.reasoningEffort, 'xhigh');
});

test('MTPLX sends the selected High level unchanged when the model advertises both High and Extra high', () => {
  const model = { id: 'Qwen3.8-alias', reasoning: {
    source: 'mtplx', allowed_options: ['off', 'low', 'high', 'xhigh'], default: 'high',
  } };
  const body = { model: model.id };
  const caps = modelOptionSupport(model).sendCapabilities;
  mergeThinkingIntoCompletionBody(body, 'on', { id: 'mtplx-local', apiKind: 'openai-v1' }, caps, 'high');
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.enable_thinking, true);
});
