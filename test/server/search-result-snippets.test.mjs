/**
 * Search snippet normalization — providers return page scrapes, not summaries.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_SNIPPET_CHARS,
  normalizeSearchResults,
  normalizeSnippet,
} from '../../server/tools/search-result.js';

describe('normalizeSnippet', () => {
  it('collapses whitespace and table pipe runs', () => {
    assert.equal(
      normalizeSnippet('Name   |||  Value \n\n  Rate  ||  12%'),
      'Name | Value Rate | 12%',
    );
  });

  it('drops repeated fragments', () => {
    const repeated = 'Release notes. Release notes. New in v4: watch options.';
    assert.equal(normalizeSnippet(repeated), 'Release notes. New in v4: watch options.');
  });

  it('caps very long snippets', () => {
    const long = normalizeSnippet('word '.repeat(500));
    assert.ok(long.length <= MAX_SNIPPET_CHARS);
    assert.match(long, /…$/);
  });

  it('handles missing snippets', () => {
    assert.equal(normalizeSnippet(undefined), '');
    assert.equal(normalizeSnippet(null), '');
  });
});

describe('normalizeSearchResults', () => {
  it('normalizes snippets and drops rows without a url', () => {
    const rows = normalizeSearchResults([
      { title: 'A', url: 'https://example.com/a', snippet: 'One. One. Two.' },
      { title: 'B', url: '', snippet: 'no url' },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].snippet, 'One. Two.');
  });
});
