import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { gitStatus } from '../../src/state/git-api.ts';
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
