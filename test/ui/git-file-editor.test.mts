import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const opens: unknown[] = [];
let load = async (_options: unknown) => ({ ok: true, before: 'old\n', after: 'new\n' });
mock.module('../../src/state/git-api.ts', { namedExports: { gitFileDiff: (options: unknown) => load(options) } });
mock.module('../../src/ui/file-viewer.ts', { namedExports: {
  openGitFileInEditor: async (options: unknown) => { opens.push(options); return true; },
  openFileInViewer: async (path: string) => { opens.push(path); },
} });
const { openGitFileEditor } = await import('../../src/ui/git-file-editor.ts');
beforeEach(() => { opens.length = 0; load = async () => ({ ok: true, before: 'old\n', after: 'new\n' }); });

test('both staging buckets forward complete text to the code editor', async () => {
  for (const staged of [false, true]) {
    const calls: unknown[] = [];
    load = async (options) => { calls.push(options); return { ok: true, before: 'base\n', after: 'full file\n' }; };
    assert.deepEqual(await openGitFileEditor({ path: 'file.ts', staged, cwd: '/worktree' }), { ok: true });
    assert.deepEqual(calls, [{ path: 'file.ts', cached: staged, cwd: '/worktree' }]);
    assert.equal((opens.at(-1) as { after: string }).after, 'full file\n');
    assert.equal((opens.at(-1) as { staged: boolean }).staged, staged);
  }
});

test('a late response cannot replace the same file selected in another staging bucket', async () => {
  let resolveOld!: (result: { ok: boolean; before: string; after: string }) => void;
  load = (options) => (options as { cached: boolean }).cached
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({ ok: true, before: 'index', after: 'working' });
  const old = openGitFileEditor({ path: 'file.ts', staged: true });
  await openGitFileEditor({ path: 'file.ts', staged: false });
  resolveOld({ ok: true, before: 'head', after: 'index' });
  assert.deepEqual(await old, { ok: false, cancelled: true });
  assert.equal(opens.length, 1);
  assert.equal((opens[0] as { after: string }).after, 'working');
});

test('read errors leave the existing editor alone', async () => {
  load = async () => ({ ok: false, error: 'Cannot read file' } as any);
  assert.deepEqual(await openGitFileEditor({ path: 'file.ts', staged: false }), { ok: false, error: 'Cannot read file' });
  assert.equal(opens.length, 0);
});
