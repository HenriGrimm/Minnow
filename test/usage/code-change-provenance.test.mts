import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCodeChangePayload } from '../../src/usage/code-change-payload.ts';
import { getPerFileChangeSummary } from '../../src/usage/code-change-ledger.ts';
import type { Chat, CodeChangeStats } from '../../src/types.ts';

test('API normalization preserves recorded checkout, commit and per-file counts through JSON reload', () => {
  const change = { additions: 4, deletions: 1, paths: ['a.ts', 'b.ts'], gitBranch: 'feature', workspacePath: '/repo', commitSha: 'abc1234', files: [
    { path: 'a.ts', additions: 3, deletions: 1 }, { path: 'b.ts', additions: 1, deletions: 0 },
  ] };
  assert.deepEqual(normalizeCodeChangePayload(JSON.parse(JSON.stringify(change))), change);
  assert.equal(normalizeCodeChangePayload({ additions: 1, deletions: 0, gitBranch: 123 })?.gitBranch, undefined);
});
test('same path edited on different branches or checkouts never merges provenance or diffs', () => {
  const stats: CodeChangeStats[] = [
    { additions: 2, deletions: 0, path: 'a.ts', gitBranch: 'one', workspacePath: '/repo' },
    { additions: 3, deletions: 0, path: 'a.ts', gitBranch: 'two', workspacePath: '/repo' },
    { additions: 4, deletions: 0, path: 'a.ts', gitBranch: 'one', workspacePath: '/slot' },
  ];
  const chat = { history: stats.map((codeChange, i) => ({ role: 'tool', tool_call_id: String(i), content: '', codeChange })) } as Chat;
  const files = getPerFileChangeSummary(chat);
  assert.equal(files.length, 3);
  assert.deepEqual(files.map(f => [f.workspacePath, f.gitBranch, f.additions]), [['/slot', 'one', 4], ['/repo', 'two', 3], ['/repo', 'one', 2]]);
});

test('multi-file command and patch diffs survive reload and stay attached to their own file and chat', () => {
  const change: CodeChangeStats = {
    additions: 2, deletions: 1, paths: ['a.ts', 'b.ts'], source: 'command-snapshot', files: [
      { path: 'a.ts', additions: 1, deletions: 1, diffLines: [{ type: 'remove', text: 'old A' }, { type: 'add', text: 'new A' }], diffTruncated: false },
      { path: 'b.ts', additions: 1, deletions: 0, diffLines: [{ type: 'add', text: 'new B' }], diffTruncated: true },
    ],
  };
  const normalized = normalizeCodeChangePayload(JSON.parse(JSON.stringify(change)));
  assert.deepEqual(normalized, change);
  const a = { history: [{ role: 'tool', tool_call_id: 'a', content: '', codeChange: normalized }] } as Chat;
  const b = { history: [{ role: 'tool', tool_call_id: 'b', content: '', codeChange: { additions: 1, deletions: 0, path: 'other.ts' } }] } as Chat;
  const files = getPerFileChangeSummary(a);
  assert.deepEqual(files.map(f => [f.path, f.additions, f.deletions]), [['a.ts', 1, 1], ['b.ts', 1, 0]]);
  assert.deepEqual(files[0].diffChunks, [{ lines: change.files![0].diffLines, truncated: false }]);
  assert.deepEqual(files[1].diffChunks, [{ lines: change.files![1].diffLines, truncated: true }]);
  assert.deepEqual(getPerFileChangeSummary(b).map(f => f.path), ['other.ts']);
});
