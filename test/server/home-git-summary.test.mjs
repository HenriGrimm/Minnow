import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { diffSummary } from '../../server/git/git-ops.js';

test('Home git totals include staged edits, exclude untracked lines, and support an unborn branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-home-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo\n');
    git('add', 'tracked.txt');
    assert.deepEqual(await diffSummary({ cwd: root }), { ok: true, additions: 2, deletions: 0 });
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\nnew\nthird\n');
    git('add', 'tracked.txt');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'not counted\n');
    assert.deepEqual(await diffSummary({ cwd: root }), { ok: true, additions: 2, deletions: 1 });
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'fourth\n');
    assert.deepEqual(await diffSummary({ cwd: root }), { ok: true, additions: 3, deletions: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
