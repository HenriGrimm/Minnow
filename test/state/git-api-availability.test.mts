import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { gitStatus, issueWorkOperation } from '../../src/state/git-api.ts';
import { isLocalServerAvailable, setLocalServerAvailableForTests } from '../../src/tools/config.ts';

const originalFetch = globalThis.fetch;
const originalAvailable = isLocalServerAvailable();
afterEach(() => {
  globalThis.fetch = originalFetch;
  setLocalServerAvailableForTests(originalAvailable);
});

test('a failed Git request does not disable requests from another project', async () => {
  setLocalServerAvailableForTests(true);
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ ok: true, branch: 'main' });
  };
  assert.equal((await gitStatus('/project-a')).ok, false);
  assert.equal(isLocalServerAvailable(), true);
  assert.equal((await gitStatus('/project-b')).ok, true);
  assert.equal(calls, 2);
});

test('Git errors preserve the server explanation instead of only the HTTP status', async () => {
  setLocalServerAvailableForTests(true);
  globalThis.fetch = async () => Response.json({ error: 'Workspace is not allowed' }, { status: 400 });
  assert.deepEqual(await gitStatus(), { ok: false, error: 'Workspace is not allowed' });
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  assert.deepEqual(await gitStatus(), { ok: false, error: 'HTTP 503' });
  assert.equal(isLocalServerAvailable(), true);
});

test('issue work requests explain how to recover from an older running server', async () => {
  setLocalServerAvailableForTests(true);
  for (const action of ['Inspect', 'Commit', 'Merge', 'Cleanup'] as const) {
    globalThis.fetch = async () => Response.json({ error: `Unknown git op: issueWork${action}` }, { status: 400 });
    const result = await issueWorkOperation(action, { cwd: '/project' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /Restart Minnow \(including the tool server\)/);
  }
  globalThis.fetch = async () => Response.json({ ok: false, error: 'The worktree is no longer registered' });
  assert.deepEqual(await issueWorkOperation('Inspect', { cwd: '/project' }), { ok: false, error: 'The worktree is no longer registered' });
});
