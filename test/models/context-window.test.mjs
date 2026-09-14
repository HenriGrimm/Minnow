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

const noCapabilities = async () => ({ models: {} });

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
        readCapabilities: async () => ({ models: { 'Qwen3-8B-Q4_K_M': { contextLength: 262144 } } }),
      },
    );
    assert.equal(limit, 40960);
  });

  test('mlx serve window', async () => {
    const limit = await resolveServerModelContextLimit(
      { providerId: 'mlx-lm-local', id: '/models/qwen' },
      {
        findLiveMlxServe: async () => ({ status: 'running', mlxSettings: { contextLength: 16384 } }),
        readCapabilities: noCapabilities,
      },
    );
    assert.equal(limit, 16384);
  });

  test('hosted providers fall back to the probed model row', async () => {
    const limit = await resolveServerModelContextLimit(
      { providerId: 'openrouter', id: 'anthropic/claude-sonnet-5' },
      { readCapabilities: async () => ({ models: { 'anthropic/claude-sonnet-5': { contextLength: 200000 } } }) },
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
          readCapabilities: noCapabilities,
        },
      ),
      null,
    );
    assert.equal(await resolveServerModelContextLimit(null), null);
  });
});
