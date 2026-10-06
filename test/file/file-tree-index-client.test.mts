import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSharedFileIndex, invalidateSharedFileIndex, resolveFileTreeSearch } from '../../src/ui/file-tree-index-client.ts';

test('names paint before slow content finishes, and an obsolete result cannot finish', async () => {
  let finishContent!: (value: string) => void;
  const content = new Promise<string>((resolve) => { finishContent = resolve; });
  const painted: string[][] = [];
  let current = true;
  const result = resolveFileTreeSearch(Promise.resolve(['src/app.ts']), content,
    () => current, (files) => painted.push(files));
  await Promise.resolve();
  assert.deepEqual(painted, [['src/app.ts']]);
  current = false;
  finishContent('src/app.ts:1:match');
  assert.equal(await result, null);
  const stalePaint: string[][] = [];
  assert.equal(await resolveFileTreeSearch(Promise.resolve(['old.ts']), Promise.resolve(''),
    () => false, (files) => stalePaint.push(files)), null);
  assert.deepEqual(stalePaint, []);
});

test('one file-list request carries worktree scope and refresh invalidation', async () => {
  const originalFetch = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(String(url), 'http://localhost'));
    return Response.json({ files: ['src/a.ts'] });
  };
  try {
    const signal = new AbortController().signal;
    invalidateSharedFileIndex();
    assert.deepEqual(await fetchSharedFileIndex('src', 'C:/worktree', signal), ['src/a.ts']);
    await fetchSharedFileIndex('src', 'C:/worktree', signal);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchParams.get('path'), 'src');
    assert.equal(calls[0].searchParams.get('workspaceRoot'), 'C:/worktree');
    assert.equal(calls[0].searchParams.get('refresh'), '1');
    assert.equal(calls[1].searchParams.has('refresh'), false);
  } finally { globalThis.fetch = originalFetch; }
});
