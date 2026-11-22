import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorktreeSetupQueue } from '../../server/worktree/setup-process.js';

test('automatic dependency setup bounds concurrency and never starts a cancelled queued install', async () => {
  const queue = createWorktreeSetupQueue(2);
  const started = [];
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const run = (name, result, signal) => queue(() => {
    started.push(name);
    return result;
  }, signal);

  const a = run('a', first.promise);
  const b = run('b', second.promise);
  const cancel = new AbortController();
  const c = run('cancelled', undefined, cancel.signal);
  const d = run('d', 'ready');
  await Promise.resolve();
  assert.deepEqual(started, ['a', 'b']);
  cancel.abort();
  await assert.rejects(c, { name: 'AbortError' });
  assert.deepEqual(started, ['a', 'b']);
  first.reject(new Error('setup failed'));
  await assert.rejects(a, /setup failed/);
  assert.equal(await d, 'ready');
  assert.deepEqual(started, ['a', 'b', 'd']);
  second.resolve();
  await b;
});
