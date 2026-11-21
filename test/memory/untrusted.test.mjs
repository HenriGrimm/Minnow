/**
 * Memory injection integration — untrusted wrapping.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { retrieveMemoryBlock } from '../../server/engine/retrieve.js';
import { GUARD_CLOSE, GUARD_OPEN_PREFIX } from '../../src/lib/untrusted.mjs';

const META_A = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'npm workflow',
  tags: ['npm'],
  updatedAt: '2026-05-19T12:00:00.000Z',
  pinned: false,
};

describe('memory untrusted wrapping', () => {
  test('retrieveMemoryBlock wraps output with memory source', () => {
    const all = [{ meta: META_A, body: 'Use npm start for tests.' }];
    const { block } = retrieveMemoryBlock(all, {
      query: 'npm',
      limit: 4,
      maxChars: 4000,
    });

    assert.ok(block.startsWith(GUARD_OPEN_PREFIX));
    assert.ok(block.includes('source="memory"'));
    assert.ok(block.endsWith(GUARD_CLOSE));
    assert.match(block, /npm workflow/);
  });

  test('empty retrieval returns empty block without wrapper', () => {
    const { block } = retrieveMemoryBlock([], { query: 'npm', limit: 4 });
    assert.equal(block, '');
  });
});
