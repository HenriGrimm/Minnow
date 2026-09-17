import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  MAX_FILE_DRAG_PATHS,
  resolveFileDragPaths,
} from '../../electron/shell-file-drag-paths.ts';

const root = path.resolve('/work/repo');
const always = (): boolean => true;

describe('resolveFileDragPaths', () => {
  test('resolves tree paths against the listing root', () => {
    assert.deepEqual(resolveFileDragPaths(root, ['src/a.ts', 'docs'], always), [
      path.join(root, 'src', 'a.ts'),
      path.join(root, 'docs'),
    ]);
  });

  test('drops duplicates', () => {
    assert.deepEqual(resolveFileDragPaths(root, ['a.ts', './a.ts'], always), [
      path.join(root, 'a.ts'),
    ]);
  });

  test('refuses the whole drag when any path is missing', () => {
    const exists = (p: string): boolean => p.endsWith('a.ts');
    assert.equal(resolveFileDragPaths(root, ['a.ts', 'gone.ts'], exists), null);
  });

  test('refuses a relative or empty root', () => {
    assert.equal(resolveFileDragPaths('repo', ['a.ts'], always), null);
    assert.equal(resolveFileDragPaths('', ['a.ts'], always), null);
    assert.equal(resolveFileDragPaths(undefined, ['a.ts'], always), null);
  });

  test('refuses malformed path lists', () => {
    assert.equal(resolveFileDragPaths(root, [], always), null);
    assert.equal(resolveFileDragPaths(root, 'a.ts', always), null);
    assert.equal(resolveFileDragPaths(root, [42], always), null);
    assert.equal(resolveFileDragPaths(root, ['a\0.ts'], always), null);
    assert.equal(
      resolveFileDragPaths(root, Array.from({ length: MAX_FILE_DRAG_PATHS + 1 }, (_, i) => `f${i}`), always),
      null,
    );
  });
});
