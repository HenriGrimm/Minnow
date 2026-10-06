import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFileContentMatches } from '../../src/ui/file-tree-content-search.ts';

test('content search keeps the first matching line per file and skips status text', () => {
  assert.deepEqual(parseFileContentMatches([
    'src/a.ts:12: const needle = true;',
    'src/a.ts:13: another needle',
    'src/b.ts:4:needle in another file',
    'No matches for "needle" under .',
  ].join('\n')), [
    { path: 'src/a.ts', line: 12, snippet: 'const needle = true;' },
    { path: 'src/b.ts', line: 4, snippet: 'needle in another file' },
  ]);
});

test('content search accepts workspace relative and Windows paths', () => {
  assert.deepEqual(parseFileContentMatches('./readme.md:2: hello\nC:\\repo\\file.ts:8: value'), [
    { path: 'readme.md', line: 2, snippet: 'hello' },
    { path: 'C:/repo/file.ts', line: 8, snippet: 'value' },
  ]);
});
