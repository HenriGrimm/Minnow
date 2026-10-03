import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cursorReasoningForModels,
  cursorVariantFamilyKey,
  resolveCursorVariantId,
} from '../../src/models/cursor-variants.mjs';

test('Cursor family effort and Fast resolve to an advertised model ID', () => {
  const ids = [
    'claude-opus-4-8-low',
    'claude-opus-4-8-low-fast',
    'claude-opus-4-8-high',
    'claude-opus-4-8-high-fast',
    'claude-opus-4-8-thinking-low',
    'claude-opus-4-8-thinking-high',
  ];
  assert.notEqual(cursorVariantFamilyKey(ids[0]), cursorVariantFamilyKey(ids[4]));
  assert.equal(resolveCursorVariantId(ids[0], ids, { effort: 'high', fast: true }), ids[3]);
  assert.equal(resolveCursorVariantId(ids[4], ids, { effort: 'high', fast: true }), ids[5]);
  assert.equal(resolveCursorVariantId(ids[0], ids, { effort: 'max', fast: true }), ids[1]);
  assert.equal(resolveCursorVariantId(ids[0], [], { effort: 'high' }), ids[0]);
});

test('Cursor catalog advertises family reasoning levels without changing model IDs', () => {
  const rows = cursorReasoningForModels([
    { id: 'gpt-5.5-none' },
    { id: 'gpt-5.5-low' },
    { id: 'gpt-5.5-extra-high-fast' },
    { id: 'composer-2.5' },
    { id: 'composer-2.5-fast' },
  ]);
  assert.deepEqual(rows.map(row => row.id), [
    'gpt-5.5-none', 'gpt-5.5-low', 'gpt-5.5-extra-high-fast',
    'composer-2.5', 'composer-2.5-fast',
  ]);
  assert.deepEqual(rows[1].reasoning.allowed_options, ['off', 'low', 'xhigh']);
  assert.equal(rows[1].reasoning.default, 'low');
  assert.equal(rows[3].reasoning, undefined);
});
