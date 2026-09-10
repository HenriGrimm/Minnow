/**
 * Default provider paths include v1 load/unload for LM Studio.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDefaultPaths,
  getProviderCapabilities,
  normalizeModelsResponse,
} from '../../server/providers/paths.js';

describe('provider paths', () => {
  it('lm-studio-v0 includes v1 load and unload paths', () => {
    const paths = getDefaultPaths('lm-studio-v0');
    assert.equal(paths.modelsPath, '/api/v0/models');
    assert.equal(paths.chatCompletionsPath, '/api/v0/chat/completions');
    assert.equal(paths.modelsLoadPath, '/api/v1/models/load');
    assert.equal(paths.modelsUnloadPath, '/api/v1/models/unload');
  });

  it('openai-v1 has no load/unload paths', () => {
    const paths = getDefaultPaths('openai-v1');
    assert.equal(paths.modelsPath, '/v1/models');
    assert.equal(paths.modelsLoadPath, undefined);
    assert.equal(paths.modelsUnloadPath, undefined);
  });

  it('openai-v1 includes default messages path for gateways', () => {
    const paths = getDefaultPaths('openai-v1');
    assert.equal(paths.messagesPath, '/v1/messages');
  });

  it('openai-v1 derives messages path from custom chat completions path', () => {
    const paths = getDefaultPaths('openai-v1', {
      chatCompletionsPath: '/zen/v1/chat/completions',
    });
    assert.equal(paths.messagesPath, '/zen/v1/messages');
  });

  it('anthropic-v1 uses messages path and no load/unload paths', () => {
    const paths = getDefaultPaths('anthropic-v1');
    assert.equal(paths.modelsPath, '/v1/models');
    assert.equal(paths.chatCompletionsPath, '/v1/messages');
    assert.equal(paths.modelsLoadPath, undefined);
    assert.equal(paths.modelsUnloadPath, undefined);
  });

  it('unknown apiKind has no default HTTP paths', () => {
    const paths = getDefaultPaths('agent-cli-v1', {
      modelsPath: '',
      chatCompletionsPath: '',
    });
    assert.equal(paths.modelsPath, '');
    assert.equal(paths.chatCompletionsPath, '');
    assert.equal(paths.modelsLoadPath, undefined);
    assert.equal(paths.modelsUnloadPath, undefined);
  });

  it('getProviderCapabilities marks lm-studio-v0 as load-capable', () => {
    assert.equal(getProviderCapabilities('lm-studio-v0').supportsModelLoadUnload, true);
    assert.equal(getProviderCapabilities('openai-v1').supportsModelLoadUnload, false);
    assert.equal(getProviderCapabilities('anthropic-v1').supportsModelLoadUnload, false);
  });

  it('lm-studio-v0 normalizes catalog vision and strips upstream capabilities', () => {
    const json = {
      data: [
        {
          id: 'qwen-vl',
          type: 'llm',
          state: 'loaded',
          capabilities: { vision: true, reasoning: { default: 'off' } },
          max_context_length: 32768,
        },
      ],
    };
    const out = normalizeModelsResponse('lm-studio-v0', json);
    assert.equal(out.data.length, 1);
    const row = out.data[0];
    assert.equal(row.id, 'qwen-vl');
    assert.equal(row.catalogVision, true);
    assert.equal(row.max_context_length, 32768);
    assert.equal(row.capabilities, undefined);
    assert.equal(row.reasoning?.default, 'off');
  });

  it('lm-studio-v0 type vlm sets catalogVision without upstream capabilities', () => {
    const out = normalizeModelsResponse('lm-studio-v0', {
      data: [{ id: 'native-vlm', type: 'vlm', state: 'not-loaded' }],
    });
    assert.equal(out.data[0].catalogVision, true);
    assert.equal(out.data[0].capabilities, undefined);
  });

  it('openai-v1 preserves top-level context_length as max_context_length', () => {
    const out = normalizeModelsResponse('openai-v1', {
      data: [{ id: 'gpt-4o-mini', object: 'model', context_length: 128_000 }],
    });
    assert.equal(out.data.length, 1);
    assert.equal(out.data[0].id, 'gpt-4o-mini');
    assert.equal(out.data[0].max_context_length, 128_000);
    assert.equal(out.data[0].state, 'loaded');
  });

  it('openai-v1 extracts nested meta.context_length (OpenRouter-style)', () => {
    const out = normalizeModelsResponse('openai-v1', {
      data: [
        {
          id: 'anthropic/claude-3.5-sonnet',
          meta: { context_length: 200_000 },
        },
      ],
    });
    assert.equal(out.data[0].max_context_length, 200_000);
  });

  it('openai-v1 extracts nested meta.n_ctx_train (llama-server)', () => {
    // llama-server's /v1/models rows carry the trained window here and nowhere
    // else, so a GGUF outside the bundled catalog used to arrive with no limit.
    const out = normalizeModelsResponse('openai-v1', {
      data: [
        {
          id: 'gguf:acme/ornith-1.5:ornith-1.5-q4_k_m.gguf',
          meta: { n_ctx_train: 262_144, n_params: 35_000_000_000 },
        },
      ],
    });
    assert.equal(out.data[0].max_context_length, 262_144);
  });

  it('openai-v1 string model ids default to loaded llm rows', () => {
    const out = normalizeModelsResponse('openai-v1', { data: ['gpt-4o'] });
    assert.deepEqual(out.data[0], { id: 'gpt-4o', type: 'llm', state: 'loaded' });
  });

  it('openai-v1 leaves catalogVision unset when the row says nothing', () => {
    const out = normalizeModelsResponse('openai-v1', {
      data: [{ id: 'Qwen3-8B', object: 'model' }],
    });
    assert.equal(out.data[0].catalogVision, undefined);
  });

  it('openai-v1 reads capabilities.vision and boolean vision flags', () => {
    const out = normalizeModelsResponse('openai-v1', {
      data: [
        { id: 'a', capabilities: { vision: true } },
        { id: 'b', capabilities: { vision: false } },
        { id: 'c', supports_vision: true },
        { id: 'd', vision: false },
      ],
    });
    assert.equal(out.data[0].catalogVision, true);
    assert.equal(out.data[1].catalogVision, false);
    assert.equal(out.data[2].catalogVision, true);
    assert.equal(out.data[3].catalogVision, false);
  });

  it('openai-v1 reads capability token lists', () => {
    const out = normalizeModelsResponse('openai-v1', {
      data: [
        { id: 'a', capabilities: ['tools', 'vision'] },
        { id: 'b', capabilities: ['tools'] },
      ],
    });
    assert.equal(out.data[0].catalogVision, true);
    assert.equal(out.data[1].catalogVision, undefined);
  });

  it('openai-v1 reads OpenRouter input modalities', () => {
    const out = normalizeModelsResponse('openai-v1', {
      data: [
        { id: 'a', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'b', architecture: { modality: 'text+image->text' } },
        { id: 'c', architecture: { modality: 'text->image' } },
      ],
    });
    assert.equal(out.data[0].catalogVision, true);
    assert.equal(out.data[1].catalogVision, true);
    // Image *output* is a generator, not a model that reads images.
    assert.equal(out.data[2].catalogVision, undefined);
  });

  it('openai-v1 type vlm sets catalogVision', () => {
    const out = normalizeModelsResponse('openai-v1', {
      data: [{ id: 'local-vlm', type: 'vlm' }],
    });
    assert.equal(out.data[0].catalogVision, true);
  });
});
