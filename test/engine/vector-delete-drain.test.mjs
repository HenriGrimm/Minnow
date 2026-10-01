import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVectorSync } from '../../server/engine/vector-sync.js';

test('deletion drain follows actual delayed sidecar work, including later queued deletions', async () => {
  const releases = [];
  const deleted = [];
  const sync = createVectorSync({ deleteEntryVector: async id => {
    await new Promise(resolve => releases.push(resolve));
    deleted.push(id);
  } }, { patchEmbeddingsConfig: async () => {} });
  void sync.syncDeleteEntryVector('first');
  let finished = false;
  const draining = sync.drainVectorDeletes().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  void sync.syncDeleteEntryVector('second');
  releases[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releases[1]();
  await draining;
  assert.deepEqual(deleted, ['first', 'second']);
});
