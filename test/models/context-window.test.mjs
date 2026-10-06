/**
 * Server-side context window for board / sub-agent / Super Plan attempts
 * (context compaction v2, P0-C).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resolveServerModelContextLimit,
  servedContextLength,
} from '../../server/models/context-window.js';

const listModels = async () => ({ data: [] });
const noCapabilities = async () => ({ models: {} });

test('DeepSeek null probe uses the same fallback as chat, including provider-prefixed ids', async () => {
  for (const id of ['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash']) {
    assert.equal(await resolveServerModelContextLimit({ providerId: 'custom-cloud', id }, {
      listModels, readCapabilities: async () => ({ models: { [id]: { contextLength: null } } }),
    }), 1_000_000);
  }
});

test('catalog-only custom models and loaded local windows match chat precedence', async () => {
  const { contextLengthFromModelRow } = await import('../../src/lib/context-length.mjs');
  for (const row of [
    { id: 'custom', max_context_length: 96000 },
    { id: 'custom', state: 'loaded', loaded_context_length: 8192, max_context_length: 131072, capabilities: { contextLength: 65536 } },
    { id: 'custom', state: 'unloaded', loaded_context_length: 8192, max_context_length: 131072 },
    { id: 'custom', max_context_length: NaN, capabilities: { contextLength: -1 } },
  ]) {
    assert.equal(await resolveServerModelContextLimit({ providerId: 'any-compatible', id: row.id }, {
      readCapabilities: noCapabilities, listModels: async () => ({ data: [row] }),
    }), contextLengthFromModelRow(row) ?? null);
  }
});

test('metadata is isolated by provider and failures retain the known fallback', async () => {
  const deps = { readCapabilities: noCapabilities, listModels: async providerId => ({ data: [{ id: 'same', max_context_length: providerId === 'a' ? 8192 : 32768 }] }) };
  assert.equal(await resolveServerModelContextLimit({ providerId: 'a', id: 'same' }, deps), 8192);
  assert.equal(await resolveServerModelContextLimit({ providerId: 'b', id: 'same' }, deps), 32768);
  assert.equal(await resolveServerModelContextLimit({ providerId: 'offline', id: 'deepseek-v4.1-flash' }, {
    readCapabilities: async () => { throw new Error('offline'); }, listModels: async () => { throw new Error('offline'); },
  }), 1_000_000);
});

test('a stale catalog observation does not override the current provider catalog', async () => {
  assert.equal(await resolveServerModelContextLimit({ providerId: 'cloud', id: 'custom' }, {
    readCapabilities: async () => ({ models: { custom: { contextLength: 8192, sources: { contextLength: 'catalog' } } } }),
    listModels: async () => ({ data: [{ id: 'custom', max_context_length: 64000 }] }),
  }), 64000);
});

test('normalized OpenAI, Anthropic and LM Studio model rows retain loaded limits', async () => {
  const { normalizeModelsResponse } = await import('../../server/providers/paths.js');
  for (const apiKind of ['openai-v1', 'anthropic-v1', 'lm-studio-v0']) {
    const catalog = normalizeModelsResponse(apiKind, { data: [{ id: 'custom', state: 'loaded', loaded_context_length: 4096, max_context_length: 131072 }] });
    assert.equal(await resolveServerModelContextLimit({ providerId: apiKind, id: 'custom' }, {
      readCapabilities: noCapabilities, listModels: async () => catalog,
    }), 4096);
  }
});

describe('servedContextLength', () => {
  test('splits the llama -c total across parallel slots', () => {
    assert.equal(
      servedContextLength({ status: 'running', llamaSettings: { ctx: 131072, parallel: 2 } }),
      65536,
    );
  });

  test('mlx contextLength wins; a stopped serve has no window', () => {
    assert.equal(servedContextLength({ status: 'running', mlxSettings: { contextLength: 32768 } }), 32768);
    assert.equal(servedContextLength({ status: 'stopped', llamaSettings: { ctx: 8192 } }), null);
    assert.equal(servedContextLength(null), null);
  });
});

describe('resolveServerModelContextLimit', () => {
  test('a running llama.cpp serve -c is authoritative over the model row', async () => {
    const limit = await resolveServerModelContextLimit(
      { providerId: 'llama-cpp-local', id: 'Qwen3-8B-Q4_K_M' },
      {
        findLiveLlamaCppServe: async (id) =>
          id === 'Qwen3-8B-Q4_K_M' ? { status: 'running', llamaSettings: { ctx: 40960, parallel: 1 } } : null,
        listModels, readCapabilities: async () => ({ models: { 'Qwen3-8B-Q4_K_M': { contextLength: 262144 } } }),
      },
    );
    assert.equal(limit, 40960);
  });

  test('mlx serve window', async () => {
    const limit = await resolveServerModelContextLimit(
      { providerId: 'mlx-lm-local', id: '/models/qwen' },
      {
        findLiveMlxServe: async () => ({ status: 'running', mlxSettings: { contextLength: 16384 } }),
        listModels, readCapabilities: noCapabilities,
      },
    );
    assert.equal(limit, 16384);
  });

  test('hosted providers fall back to the probed model row', async () => {
    const limit = await resolveServerModelContextLimit(
      { providerId: 'openrouter', id: 'anthropic/claude-sonnet-5' },
      { listModels, readCapabilities: async () => ({ models: { 'anthropic/claude-sonnet-5': { contextLength: 200000 } } }) },
    );
    assert.equal(limit, 200000);
  });

  test('no serve and no row, or a throwing registry, is unknown', async () => {
    assert.equal(
      await resolveServerModelContextLimit(
        { providerId: 'llama-cpp-local', id: 'missing' },
        {
          findLiveLlamaCppServe: async () => {
            throw new Error('no registry');
          },
          listModels, readCapabilities: noCapabilities,
        },
      ),
      null,
    );
    assert.equal(await resolveServerModelContextLimit(null), null);
  });
});
