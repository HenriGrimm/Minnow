import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parsePageMarkdown, serializePage } from '../../server/brain/store.js';

describe('Brain page frontmatter', () => {
  test('round-trips quotes, backslashes, delimiter text, newlines, and comma tags', () => {
    const meta = {
      id: 'page-1',
      title: 'The "quoted" C:\\notes --- title',
      tags: ['alpha,beta', '"quote"', 'C:\\brain', 'line\nbreak'],
      source: 'user',
      summary: 'First line\n---\nSecond "line" at C:\\brain',
      pinned: true,
      createdAt: '2026-09-29T00:00:00Z',
      updatedAt: '2026-09-29T00:00:00Z',
      anchors: ['one,two', 'path\\name'],
      status: 'current',
      input_hash: 'hash---value',
      chatId: 'chat,"one"',
      similarTo: ['facts/a,b', 'facts/c\\d'],
      sourceTurnIndices: [1, 23],
    };
    const body = 'Body can contain a line with --- and a real\n---\ndelimiter.';

    const serialized = serializePage(meta, body);
    const parsed = parsePageMarkdown(serialized);

    for (const field of ['id', 'title', 'tags', 'summary', 'pinned', 'createdAt', 'updatedAt', 'anchors', 'input_hash', 'chatId', 'similarTo', 'sourceTurnIndices']) {
      assert.deepEqual(parsed.front[field], meta[field], field);
    }
    assert.equal(parsed.body, body);
    assert.match(serialized, /summary: "First line\\n---\\nSecond/);
  });

  test('reads legacy unquoted and single-quoted values and line-based delimiters', () => {
    const legacy = `---
id: old-page
title: 'Bob''s --- notes'
tags: [plain, 'comma, tag', other]
sourceTurnIndices: [1, 2]
---

Legacy body with --- text.
`;
    const parsed = parsePageMarkdown(legacy);
    assert.equal(parsed.front.id, 'old-page');
    assert.equal(parsed.front.title, "Bob's --- notes");
    assert.deepEqual(parsed.front.tags, ['plain', 'comma, tag', 'other']);
    assert.deepEqual(parsed.front.sourceTurnIndices, [1, 2]);
    assert.equal(parsed.body, 'Legacy body with --- text.');
  });
});
