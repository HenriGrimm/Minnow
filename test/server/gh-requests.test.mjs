import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGhRequests } from '../../server/git/gh-requests.js';

const ok = { code: 0, stdout: '[]', stderr: '' };
const limited = { code: 1, stdout: '', stderr: 'GraphQL: API rate limit already exceeded for user ID 123.' };

test('PR reads coalesce across worktrees, cache for 25s, and invalidate after a write', async () => {
  let time = 1_000;
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const client = createGhRequests({ now: () => time, run: async () => { calls++; await pending; return ok; } });
  const args = ['pr', 'list', '--repo', 'github.com/a/b'];
  const a = client.request(args, { cwd: '/one' });
  const b = client.request(args, { cwd: '/two' });
  assert.equal(calls, 1);
  release();
  await Promise.all([a, b]);
  await client.request(args, { cwd: '/one' });
  assert.equal(calls, 1);
  // Different filters/repos/details remain separate reads.
  await client.request([...args, '--state', 'closed']);
  await client.request(['pr', 'view', '3', '--repo', 'github.com/a/b']);
  assert.equal(calls, 3);
  time += 25_001;
  await client.request(args);
  assert.equal(calls, 4);
  await client.request(['pr', 'close', '3']);
  await client.request(args);
  assert.equal(calls, 6);
});

test('a mutation prevents an older pending PR read from repopulating the cache', async () => {
  let release;
  let reads = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const client = createGhRequests({ run: async (args) => {
    if (args[1] === 'list') { reads++; if (reads === 1) await pending; }
    return ok;
  } });
  const read = client.request(['pr', 'list']);
  await client.request(['pr', 'merge', '3']);
  release();
  await read;
  await client.request(['pr', 'list']);
  assert.equal(reads, 2);
});

test('GraphQL exhaustion probes once and blocks issues and PRs in every workspace until reset', async () => {
  let time = 10_000;
  const calls = [];
  const client = createGhRequests({ now: () => time, run: async (args) => {
    calls.push(args);
    if (args.includes('rate_limit')) return { ...ok, stdout: JSON.stringify({ resources: { graphql: { remaining: 0, reset: 30 } } }) };
    return args[0] === 'run' || time >= 30_000 ? ok : limited;
  } });
  const first = await client.request(['issue', 'view', '1'], { cwd: '/one' });
  assert.match(first.stderr, /Retry after 1970-01-01T00:00:31.000Z/);
  await client.request(['pr', 'view', '3'], { cwd: '/two' });
  await client.request(['api', 'graphql'], { cwd: '/three' });
  assert.equal(calls.length, 2);
  // REST and other GitHub hosts have separate allowances.
  await client.request(['run', 'list']);
  await client.request(['pr', 'list'], {}, 'github.enterprise.test');
  assert.equal(calls.length, 5);
  time = 31_001;
  assert.equal((await client.request(['issue', 'view', '1'])).code, 0);
  assert.equal(calls.length, 6);
});

test('failed reset lookup uses a bounded fallback and ordinary failures are not cached', async () => {
  let calls = 0;
  const client = createGhRequests({ now: () => 1_000, run: async (args) => {
    calls++;
    if (args.includes('rate_limit')) throw new Error('offline');
    return limited;
  } });
  const result = await client.request(['pr', 'list']);
  assert.match(result.stderr, /Retry after 1970-01-01T01:00:01.000Z/);
  await client.request(['issue', 'edit', '1']);
  assert.equal(calls, 2);
  const other = createGhRequests({ run: async () => { calls++; return { ...limited, stderr: 'not found' }; } });
  await other.request(['pr', 'list']);
  await other.request(['pr', 'list']);
  assert.equal(calls, 4);
});

test('concurrent exhausted calls share their reset lookup and secondary limits wait a minute', async () => {
  let probes = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const client = createGhRequests({ now: () => 1_000, run: async (args) => {
    if (args.includes('rate_limit')) { probes++; await pending; return ok; }
    return { ...limited, stderr: 'You have exceeded a secondary rate limit.' };
  } });
  const requests = [client.request(['issue', 'view', '1']), client.request(['pr', 'view', '2'])];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  release();
  for (const result of await Promise.all(requests)) {
    assert.match(result.stderr, /Retry after 1970-01-01T00:01:01.000Z/);
  }
});
