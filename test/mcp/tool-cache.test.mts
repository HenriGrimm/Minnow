import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpToolCache } from '../../src/mcp/tool-cache';

const tool = (name: string) => ({ type: 'function' as const, function: { name, description: '', parameters: { type: 'object' } } });

test('renderer reads MCP tools once and follows pushed revisions without polling', async t => {
  let reads = 0;
  let revision = 'boot:1';
  let changed!: (revision: string) => void;
  let closed = 0;
  const cache = createMcpToolCache({
    read: async () => { reads++; return { revision, tools: [tool(revision)] }; },
    subscribe: listener => { changed = listener; return () => { closed++; }; },
  });
  try {
    await Promise.all([cache.refresh(false), cache.refresh(false), cache.refresh(false)]);
    assert.equal(reads, 1);
    t.mock.method(Date, 'now', () => 1e15);
    await cache.refresh(false);
    assert.equal(reads, 1, 'time and turn boundaries do not refresh tools');
    changed(revision); // Initial snapshot or reconnect with no changes.
    await cache.refresh(false);
    assert.equal(reads, 1);

    revision = 'boot:2';
    changed(revision);
    await cache.refresh(false);
    assert.equal(reads, 2);
    assert.equal(cache.tools[0].function.name, revision);

    revision = 'new-server:0';
    changed(revision); // Reconnect after the Minnow server restarts.
    await cache.refresh(false);
    assert.equal(reads, 3);
    await cache.refresh(); // Explicit Settings refresh for non-notifying servers.
    assert.equal(reads, 4);
  } finally { cache.clear(); }
  assert.equal(closed, 1);
});

test('a change during a renderer read queues one fresh read and clear discards late results', async () => {
  let changed!: (revision: string) => void;
  let reads = 0;
  let release!: () => void;
  let revision = '1';
  const cache = createMcpToolCache({
    read: async () => {
      reads++;
      const captured = revision;
      if (reads === 2 || reads === 4) await new Promise<void>(resolve => { release = resolve; });
      return { revision: captured, tools: [tool(captured)] };
    },
    subscribe: listener => { changed = listener; return () => {}; },
  });
  try {
    await cache.refresh(false);
    revision = '2';
    changed(revision);
    await Promise.resolve();
    revision = '3';
    changed(revision);
    changed(revision);
    release();
    await cache.refresh(false);
    assert.equal(reads, 3, 'several in-flight notifications share one trailing request');
    assert.equal(cache.tools[0].function.name, '3');

    const late = cache.refresh();
    await Promise.resolve();
    cache.clear();
    release();
    await late;
    assert.deepEqual(cache.tools, []);
    await cache.refresh(false);
    assert.equal(reads, 5, 'clearing allows a fresh initial read');
  } finally { cache.clear(); }
});

test('failed renderer refreshes can retry on the next read without an expiry timer', async () => {
  let reads = 0;
  const cache = createMcpToolCache({
    read: async () => {
      if (++reads === 2) throw new Error('disconnected');
      return { revision: '1', tools: [tool('echo')] };
    },
    subscribe: () => () => {},
  });
  try {
    await cache.refresh(false);
    await cache.refresh();
    assert.deepEqual(cache.tools, []);
    await cache.refresh(false);
    assert.equal(reads, 3);
    assert.equal(cache.tools[0].function.name, 'echo');
  } finally { cache.clear(); }
});
