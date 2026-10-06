import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameSchedulerFile } from '../../server/scheduler/atomic-file.js';

test('scheduler atomic replacement recovers from transient Windows sharing locks', async () => {
  let calls = 0;
  const waits = [];
  await renameSchedulerFile('temporary', 'jobs.json', {
    rename: async (source, target) => {
      assert.equal(source, 'temporary');
      assert.equal(target, 'jobs.json');
      if (++calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    },
    wait: async ms => { waits.push(ms); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 50]);
});

test('scheduler atomic replacement reports persistent locks after bounded retries', async () => {
  let calls = 0;
  await assert.rejects(renameSchedulerFile('temporary', 'jobs.json', {
    rename: async () => { calls++; throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    wait: async () => {},
  }), /locked/);
  assert.equal(calls, 6);
});

test('scheduler atomic replacement does not retry unrelated filesystem failures', async () => {
  await assert.rejects(renameSchedulerFile('temporary', 'jobs.json', {
    rename: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    wait: async () => { assert.fail('disk full must not be retried as a sharing lock'); },
  }), /disk full/);
});
