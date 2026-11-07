import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginToolCache } from '../../src/tools/plugin-tool-cache';

const tool = (name: string) => ({ type: 'function' as const, function: { name, description: '', parameters: { type: 'object' } } });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test('unchanged rounds and reconnect snapshots perform zero additional catalog requests', async () => {
  let reads = 0, closed = 0;
  let revision = 'boot:1';
  let changed!: (revision: string) => void;
  const cache = createPluginToolCache({
    read: async () => { reads++; return { revision, tools: [tool(revision)] }; },
    subscribe: listener => { changed = listener; return () => { closed++; }; },
  });
  try {
    await Promise.all(Array.from({ length: 12 }, () => cache.refresh()));
    for (let i = 0; i < 20; i++) await cache.refresh();
    changed(revision);
    await cache.refresh();
    assert.equal(reads, 1);
    revision = 'boot:2';
    changed(revision);
    assert.deepEqual(cache.tools, [], 'invalidated definitions disappear before refresh settles');
    await cache.refresh();
    assert.equal(reads, 2);
    revision = 'new-server:0';
    changed(revision);
    await cache.refresh();
    assert.equal(reads, 3);
    assert.equal(cache.tools[0].function.name, revision);
    await cache.refresh(true);
    assert.equal(reads, 4, 'explicit refresh bypasses unchanged revision');
  } finally { cache.clear(); }
  assert.equal(closed, 1);
});

test('racing revisions coalesce and never publish an outdated in-flight inventory', async () => {
  let reads = 0;
  let revision = '1';
  let changed!: (revision: string) => void;
  const hold = deferred();
  const cache = createPluginToolCache({
    read: async () => {
      const captured = revision;
      if (++reads === 2) await hold.promise;
      return { revision: captured, tools: [tool(captured)] };
    },
    subscribe: listener => { changed = listener; return () => {}; },
  });
  try {
    await cache.refresh();
    revision = '2'; changed(revision);
    revision = '3'; changed(revision); changed(revision);
    hold.resolve();
    await cache.refresh();
    assert.equal(reads, 3);
    assert.equal(cache.tools[0].function.name, '3');
  } finally { cache.clear(); }
});

test('failure is explicit and latched until a new revision or explicit refresh, not retried per round', async () => {
  let reads = 0, failures = 0;
  let broken = false;
  let changed!: (revision: string) => void;
  const cache = createPluginToolCache({
    read: async () => {
      reads++;
      if (broken) throw new Error('offline');
      return { revision: '1', tools: [tool('echo')] };
    },
    subscribe: listener => { changed = listener; return () => {}; },
    onError: () => { failures++; },
  });
  try {
    await cache.refresh();
    broken = true;
    await assert.rejects(cache.refresh(true), /offline/);
    for (let i = 0; i < 10; i++) await assert.rejects(cache.refresh(), /offline/);
    assert.equal(reads, 2);
    assert.equal(failures, 1);
    assert.deepEqual(cache.tools, []);
    assert.match(cache.error!.message, /offline/);
    broken = false;
    changed('2');
    await cache.refresh();
    assert.equal(reads, 3);
  } finally { cache.clear(); }
});

test('deadline aborts a hung body/read and does not retry it at round boundaries', async () => {
  let reads = 0;
  let signal!: AbortSignal;
  const cache = createPluginToolCache({
    read: input => { reads++; signal = input; return new Promise(() => {}); },
    subscribe: () => () => {}, timeoutMs: 10, onError: () => {},
  });
  try {
    await assert.rejects(cache.refresh(), /timed out/);
    assert.equal(signal.aborted, true);
    await assert.rejects(cache.refresh(), /timed out/);
    assert.equal(reads, 1);
  } finally { cache.clear(); }
});

test('clear aborts pending work and discards late responses across cache lifecycles', async () => {
  const hold = deferred();
  let reads = 0;
  let signal!: AbortSignal;
  const cache = createPluginToolCache({
    read: async input => {
      signal = input;
      const name = String(++reads);
      if (reads === 1) await hold.promise;
      return { revision: name, tools: [tool(name)] };
    },
    subscribe: () => () => {}, onError: () => {},
  });
  const pending = cache.refresh();
  cache.clear();
  assert.equal(signal.aborted, true);
  await cache.refresh();
  hold.resolve();
  await pending;
  assert.equal(cache.tools[0].function.name, '2');
  cache.clear();
});

test('concurrent explicit refreshes during a read share one trailing forced reload', async () => {
  let reads = 0, forced = 0;
  const hold = deferred();
  const cache = createPluginToolCache({
    read: async (_signal, force) => {
      reads++; if (force) forced++;
      if (reads === 1) await hold.promise;
      return { tools: [tool(String(reads))], revision: String(reads) };
    },
    subscribe: () => () => {},
  });
  try {
    const initial = cache.refresh();
    const first = cache.refresh(true);
    const second = cache.refresh(true);
    hold.resolve();
    await Promise.all([initial, first, second]);
    assert.equal(reads, 2);
    assert.equal(forced, 1);
  } finally { cache.clear(); }
});

test('default reader bounds JSON parsing and forwards abort to the catalog HTTP request', async t => {
  let signal!: AbortSignal;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    signal = init.signal!;
    return { ok: true, json: () => new Promise(() => {}) } as unknown as Response;
  });
  const cache = createPluginToolCache({ subscribe: () => () => {}, timeoutMs: 10, onError: () => {} });
  try {
    await assert.rejects(cache.refresh(), /timed out/);
    assert.equal(signal.aborted, true);
  } finally { cache.clear(); }
});

test('healthy reconnect needs no HTTP; failed reconnect retries even with an unchanged revision', async () => {
  let reads = 0;
  let broken = false;
  let changed!: (revision: string, reconnected?: boolean) => void;
  const cache = createPluginToolCache({
    read: async () => {
      reads++;
      if (broken) throw new Error('offline');
      return { revision: '1', tools: [tool('echo')] };
    },
    subscribe: listener => { changed = listener; return () => {}; }, onError: () => {},
  });
  try {
    await cache.refresh();
    changed('1'); changed('1', true);
    await cache.refresh();
    assert.equal(reads, 1);
    broken = true;
    await assert.rejects(cache.refresh(true), /offline/);
    broken = false;
    changed('1', true);
    await cache.refresh();
    assert.equal(reads, 3);
    assert.equal(cache.tools[0].function.name, 'echo');
  } finally { cache.clear(); }
});

test('explicit HTTP refresh reloads handlers; ordinary rounds only use the initial GET', async t => {
  const requests: { url: string; method?: string; signal: AbortSignal }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method, signal: init.signal! });
    return Response.json({ revision: 'boot:1', tools: [tool('echo')] });
  });
  const cache = createPluginToolCache({ subscribe: () => () => {} });
  try {
    await cache.refresh();
    await cache.refresh();
    assert.deepEqual(requests.map(r => r.url), ['/api/plugins/tools']);
    await cache.refresh(true);
    assert.deepEqual(requests.map(r => r.url), ['/api/plugins/tools', '/api/plugins/reload', '/api/plugins/tools']);
    assert.equal(requests[1].method, 'POST');
    assert.equal(requests[1].signal, requests[2].signal);
  } finally { cache.clear(); }
});

test('notifications queued before clear cannot reactivate the old cache lifecycle', async () => {
  let changed!: (revision: string) => void;
  let reads = 0;
  const cache = createPluginToolCache({
    read: async () => { reads++; return { revision: '1', tools: [] }; },
    subscribe: listener => { changed = listener; return () => {}; },
  });
  await cache.refresh();
  cache.clear();
  changed('2');
  await Promise.resolve();
  assert.equal(reads, 1);
});
