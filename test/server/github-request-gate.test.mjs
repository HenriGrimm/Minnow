import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithubRequestGate } from '../../server/git/github-request-gate.js';

const ok = () => ({ code: 0, stdout: '[]', stderr: '' });

test('primary exhaustion pauses all workspaces on the host until the response reset', async () => {
  let now = 1_000_000;
  let calls = 0;
  let probes = 0;
  const request = createGithubRequestGate({ now: () => now, probe: async () => {
    probes++;
    return 'X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1060\r\n';
  } });
  const failed = await request(['issue', 'view', '1'], '/a', 'github.com', async () => {
    calls++;
    return { code: 1, stdout: '', stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' };
  });
  assert.match(failed.stderr, /paused until 1970-01-01T00:17:41.000Z/);
  const blocked = await request(['pr', 'list'], '/b', 'github.com', async () => { calls++; return ok(); });
  assert.equal(blocked.code, 1);
  assert.equal(calls, 1);
  assert.equal(probes, 1);
  assert.equal((await request(['pr', 'list'], '/b', 'github.enterprise', async () => ok())).code, 0);
  now = 1_061_000;
  assert.equal((await request(['pr', 'list'], '/b', 'github.com', async () => { calls++; return ok(); })).code, 0);
  assert.equal(calls, 2);
});

test('secondary limits honor Retry-After and increase backoff without it', async () => {
  let now = 1_000_000;
  const request = createGithubRequestGate({ now: () => now });
  const fail = async (stderr) => request(['api', 'repos/a/b/issues'], '/a', 'github.com',
    async () => ({ code: 1, stdout: '', stderr }));
  let result = await fail('secondary rate limit\nRetry-After: 90');
  assert.match(result.stderr, /00:18:10.000Z/);
  now += 90_000;
  result = await fail('secondary rate limit');
  assert.match(result.stderr, /00:19:10.000Z/);
  now += 60_000;
  result = await fail('secondary rate limit');
  assert.match(result.stderr, /00:21:10.000Z/);
});

test('simultaneous and recent reads share work; mutations and TTL invalidate it', async () => {
  let now = 1_000_000;
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const request = createGithubRequestGate({ now: () => now });
  const run = async () => { calls++; await pending; return ok(); };
  const one = request(['pr', 'list'], '/a', 'github.com', run);
  const two = request(['pr', 'list'], '/a', 'github.com', run);
  assert.equal(calls, 1);
  release();
  await Promise.all([one, two]);
  await request(['pr', 'list'], '/a', 'github.com', run);
  assert.equal(calls, 1);
  await request(['pr', 'merge', '1'], '/a', 'github.com', async () => ok());
  await request(['pr', 'list'], '/a', 'github.com', run);
  assert.equal(calls, 2);
  now += 30_000;
  await request(['pr', 'list'], '/a', 'github.com', run);
  assert.equal(calls, 3);
});

test('a read begun before a mutation cannot populate the new cache generation', async () => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const request = createGithubRequestGate();
  const old = request(['issue', 'view', '1'], '/a', 'github.com', async () => { calls++; await pending; return ok(); });
  await request(['issue', 'edit', '1'], '/a', 'github.com', async () => ok());
  release();
  await old;
  await request(['issue', 'view', '1'], '/a', 'github.com', async () => { calls++; return ok(); });
  assert.equal(calls, 2);
});

test('ordinary failures are neither cached nor classified as rate limits', async () => {
  let calls = 0;
  const request = createGithubRequestGate();
  for (let i = 0; i < 2; i++) {
    const result = await request(['issue', 'view', '1'], '/a', 'github.com', async () => {
      calls++; return { code: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    });
    assert.match(result.stderr, /404/);
  }
  assert.equal(calls, 2);
});

test('issue conflict reads stay fresh and explicit refresh clears PR cache', async () => {
  let calls = 0;
  const request = createGithubRequestGate();
  const run = async () => { calls++; return ok(); };
  await request(['issue', 'view', '1'], '/a', 'github.com', run);
  await request(['issue', 'view', '1'], '/a', 'github.com', run);
  assert.equal(calls, 2);
  await request(['pr', 'view', '1'], '/a', 'github.com', run);
  request.invalidateReads();
  await request(['pr', 'view', '1'], '/a', 'github.com', run);
  assert.equal(calls, 4);
});
