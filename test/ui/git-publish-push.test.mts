import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitBranchTreeResult } from '../../src/state/git-api.ts';
import { pushWithPublishPrompt } from '../../src/ui/git-publish-push.ts';

function tree(upstream: string | null, upstreamGone = false): GitBranchTreeResult {
  return {
    ok: true,
    current: 'feature',
    branches: [{ name: 'feature', upstream, upstreamGone }] as GitBranchTreeResult['branches'],
  };
}

test('publishes a missing remote branch only after confirmation', async () => {
  const pushes: unknown[] = [];
  const result = await pushWithPublishPrompt('/repo', {
    branchTree: async () => tree(null),
    confirm: async () => true,
    push: async (input) => { pushes.push(input); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(pushes, [{ cwd: '/repo', setUpstream: true, branch: 'feature' }]);
});

test('declining publication leaves the remote untouched', async () => {
  let pushed = false;
  const result = await pushWithPublishPrompt('/repo', {
    branchTree: async () => tree(null),
    confirm: async () => false,
    push: async () => { pushed = true; return { ok: true }; },
  });
  assert.deepEqual(result, { ok: false, error: 'cancelled' });
  assert.equal(pushed, false);
});

test('a deleted upstream also asks before recreating the remote branch', async () => {
  const pushes: unknown[] = [];
  await pushWithPublishPrompt('/repo', {
    branchTree: async () => tree('origin/feature', true),
    confirm: async () => true,
    push: async (input) => { pushes.push(input); return { ok: true }; },
  });
  assert.deepEqual(pushes, [{ cwd: '/repo', setUpstream: true, branch: 'feature' }]);
});

test('a branch with an upstream pushes normally without prompting', async () => {
  const pushes: unknown[] = [];
  const result = await pushWithPublishPrompt('/repo', {
    branchTree: async () => tree('origin/feature'),
    confirm: async () => { throw new Error('unexpected prompt'); },
    push: async (input) => { pushes.push(input); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(pushes, [{ cwd: '/repo' }]);
});
