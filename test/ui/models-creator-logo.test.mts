import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatCreatorLabel, resolveModelCreator } from '../../src/ui/models/creator-logo.ts';

describe('discover model creator identity', () => {
  test('uses the source model owner for curated recommendations', () => {
    assert.equal(resolveModelCreator('unsloth/Qwen3.5-9B-GGUF', 'Qwen/Qwen3.5-9B'), 'Qwen');
    assert.equal(
      resolveModelCreator('google/gemma-4-12B-it-qat-q4_0-gguf', 'google/gemma-4-12B-it'),
      'google',
    );
  });

  test('recognises model makers in repackaged Hub repositories', () => {
    assert.equal(resolveModelCreator('unsloth/Qwen3-Coder-30B-GGUF'), 'Qwen');
    assert.equal(resolveModelCreator('bartowski/DeepSeek-R1-GGUF'), 'deepseek-ai');
    assert.equal(resolveModelCreator('community/Gemma-3-12B-GGUF'), 'google');
  });

  test('falls back to the repository owner for an unknown model family', () => {
    assert.equal(resolveModelCreator('ornith-ai/ornith-1.5-9B-GGUF'), 'ornith-ai');
  });

  test('presents technical creator ids as names', () => {
    assert.equal(formatCreatorLabel('google'), 'Google');
    assert.equal(formatCreatorLabel('deepseek-ai'), 'DeepSeek');
    assert.equal(formatCreatorLabel('ornith-ai'), 'ornith-ai');
  });
});
