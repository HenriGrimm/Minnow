/**
 * Known context window lookup (MIN-199).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lookupKnownContextLength } from '../../src/lib/known-context-windows.ts';

describe('lookupKnownContextLength', () => {
  test('gpt-4o-mini returns 128000', () => {
    assert.equal(lookupKnownContextLength('gpt-4o-mini'), 128_000);
  });

  test('gpt-4o returns 128000', () => {
    assert.equal(lookupKnownContextLength('gpt-4o'), 128_000);
  });

  test('o1-mini returns 128000 (not shadowed by o1)', () => {
    assert.equal(lookupKnownContextLength('o1-mini'), 128_000);
  });

  test('o1 returns 200000', () => {
    assert.equal(lookupKnownContextLength('o1'), 200_000);
  });

  test('provider-prefixed id matches', () => {
    assert.equal(lookupKnownContextLength('openai/gpt-4o'), 128_000);
  });

  test('tag suffix is stripped before matching', () => {
    assert.equal(lookupKnownContextLength('deepseek-r1:free'), 64_000);
    assert.equal(lookupKnownContextLength('deepseek/deepseek-v4.1'), 1_000_000);
    assert.equal(lookupKnownContextLength('deepseek-v4-flash'), 1_000_000);
  });

  test('claude-3-5-sonnet returns 200000', () => {
    assert.equal(lookupKnownContextLength('claude-3-5-sonnet'), 200_000);
  });

  test('unknown model returns undefined', () => {
    assert.equal(lookupKnownContextLength('totally-unknown-model-xyz'), undefined);
  });

  test('qwen3.8 ids resolve 262144 not generic qwen3 131072', () => {
    assert.equal(lookupKnownContextLength('qwen/qwen3.8-27b'), 262_144);
    assert.equal(lookupKnownContextLength('qwen3.8-27b'), 262_144);
    assert.equal(lookupKnownContextLength('qwen3_8-27b'), 262_144);
  });

  test('qwen3.5 and qwen3.6 ids also resolve 262144', () => {
    assert.equal(lookupKnownContextLength('qwen/qwen3.5-27b'), 262_144);
    assert.equal(lookupKnownContextLength('qwen3.6-27b'), 262_144);
  });
});
