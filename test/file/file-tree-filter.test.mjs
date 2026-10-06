import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  basenameOf,
  buildWorkspaceIndex,
  filterPaths,
  matchesNameFilter,
  normalizeFilterQuery,
  shouldSkipDirName,
  sortFilteredPaths,
} = await import('../../src/ui/file-tree-filter.ts');

describe('file-tree-filter', () => {
  test('normalizeFilterQuery trims and lowercases', () => {
    assert.equal(normalizeFilterQuery('  Foo '), 'foo');
  });

  test('basenameOf returns last segment', () => {
    assert.equal(basenameOf('src/ui/file-tree.ts'), 'file-tree.ts');
    assert.equal(basenameOf('README.md'), 'README.md');
  });

  test('shouldSkipDirName skips common heavy dirs', () => {
    assert.equal(shouldSkipDirName('node_modules'), true);
    assert.equal(shouldSkipDirName('.git'), true);
    assert.equal(shouldSkipDirName('.godot'), true);
    assert.equal(shouldSkipDirName('src'), false);
  });

  test('matchesNameFilter subsequence is case-insensitive', () => {
    assert.equal(matchesNameFilter('ft', 'file-tree.ts'), true);
    assert.equal(matchesNameFilter('zzz', 'file-tree.ts'), false);
    assert.equal(matchesNameFilter('', 'anything'), true);
  });

  test('matchesNameFilter accepts ordered chars not adjacent', () => {
    assert.equal(matchesNameFilter('ftr', 'file-tree.ts'), true);
  });

  test('filterPaths and sortFilteredPaths', () => {
    const paths = ['src/b.ts', 'src/a.ts', 'lib/z.ts'];
    const filtered = filterPaths(paths, 'a');
    assert.deepEqual(filtered, ['src/a.ts']);
    const sorted = sortFilteredPaths(['src/b.ts', 'a.ts', 'ab.ts'], 'a');
    assert.equal(sorted[0], 'a.ts');
  });

  test('buildWorkspaceIndex walks BFS and skips ignored dirs', async () => {
    const listings = {
      '.': {
        dirs: ['src', 'node_modules', '.godot'],
        files: ['root.txt'],
      },
      src: {
        dirs: ['nested'],
        files: ['app.ts'],
      },
      'src/nested': {
        dirs: [],
        files: ['deep.ts'],
      },
      '.godot': { dirs: [], files: ['cache.bin'] },
    };

    const paths = await buildWorkspaceIndex('.', async (dir) => listings[dir] ?? { error: 'missing' });
    assert.ok(!('error' in paths));
    assert.deepEqual(paths.sort(), ['root.txt', 'src/app.ts', 'src/nested/deep.ts']);
  });
});
