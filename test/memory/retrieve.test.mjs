/**
 * Memory retrieve formatting — static expected strings.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatMemoryBlock, retrieveMemoryBlock } from '../../server/memory/retrieve.js';

const META_A = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'npm workflow',
  tags: ['npm'],
  updatedAt: '2026-05-19T12:00:00.000Z',
  pinned: false,
};

const META_B = {
  id: '22222222-2222-2222-2222-222222222222',
  title: 'Python only',
  tags: ['python'],
  updatedAt: '2026-05-19T11:00:00.000Z',
  pinned: false,
};

describe('memory retrieve', () => {
  test('formatMemoryBlock static shape', () => {
    const block = formatMemoryBlock(
      [{ meta: META_A, body: 'Use npm start for tests.' }],
      4000,
    );
    const expected = `## Retrieved memory
- [npm workflow] (tags: npm)
  Use npm start for tests.`;
    assert.equal(block, expected);
  });

  test('formatMemoryBlock uses query-relevant excerpt when query provided', () => {
    const block = formatMemoryBlock(
      [
        {
          meta: META_A,
          body: 'Intro line.\n\nUse npm start for integration tests before release.',
        },
      ],
      4000,
      'integration tests',
    );
    assert.match(block, /integration tests/);
    assert.doesNotMatch(block, /^Intro line\.$/m);
  });
  test('formatMemoryBlock includes path when meta.path is set', () => {
    const block = formatMemoryBlock(
      [
        {
          meta: { ...META_A, path: 'minnow/architecture.md' },
          body: 'High-level architecture overview.',
        },
      ],
      4000,
    );
    const expected = `## Retrieved memory
- [npm workflow] path: minnow/architecture.md (tags: npm)
  High-level architecture overview.`;
    assert.equal(block, expected);
  });

  test('retrieveMemoryBlock falls back when query has no token matches', () => {
    const all = [
      { meta: META_A, body: 'Use npm start for integration tests.' },
      { meta: META_B, body: 'Use poetry for Python projects.' },
    ];
    const { block, ids } = retrieveMemoryBlock(all, {
      query: 'hello world unrelated',
      limit: 4,
      maxChars: 4000,
    });
    assert.match(block, /<<<UNTRUSTED_SOURCE_DATA source="memory">>>/);
    assert.match(block, /npm workflow/);
    assert.match(block, /Python only/);
    assert.equal(ids.length, 2);
  });

  test('retrieveMemoryBlock ranks npm over python', () => {
    const all = [
      { meta: META_A, body: 'Use npm start for integration tests.' },
      { meta: META_B, body: 'Use poetry for Python projects.' },
    ];
    const { block, ids } = retrieveMemoryBlock(all, {
      query: 'npm',
      limit: 4,
      maxChars: 4000,
    });
    assert.match(block, /<<<UNTRUSTED_SOURCE_DATA source="memory">>>/);
    assert.match(block, /npm workflow/);
    assert.doesNotMatch(block, /Python only/);
    assert.ok(ids.includes(META_A.id));
  });

  test('automatic injection omits unrelated game memories', () => {
    const all = [
      { meta: { ...META_A, title: 'Robot Rage game', tags: ['robot-rage'] }, body: 'Build a web game with a chess-like board.' },
      { meta: { ...META_B, title: 'Chess castling rules', tags: ['chess'] }, body: 'Castling requires clear safe transit squares.' },
    ];
    const { ids, block } = retrieveMemoryBlock(all, {
      query: 'Lets make a chess web game',
      autoInject: true,
    });
    assert.deepEqual(ids, [META_B.id]);
    assert.match(block, /Chess castling rules/);
    assert.doesNotMatch(block, /Robot Rage/);
  });

  test('automatic injection returns nothing when the topic has no memory', () => {
    const { block, ids } = retrieveMemoryBlock(
      [{ meta: META_A, body: 'Use npm to make a web game.' }],
      { query: 'Lets make a chess web game', autoInject: true },
    );
    assert.equal(block, '');
    assert.deepEqual(ids, []);
  });
});
