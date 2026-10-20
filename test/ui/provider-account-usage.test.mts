import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { fetchProviderAccountUsage, hasProviderUsage, type ProviderAccountUsage } from '../../src/providers/account-usage.ts';
import { createProviderAccountUsageView } from '../../src/ui/provider-account-usage.ts';

const snapshot: ProviderAccountUsage = { status: 'available', checkedAt: '2026-10-19T12:00:00Z',
  metrics: [{ label: 'Credits', remaining: 0, used: 2, limit: 2, unit: 'USD', resetsAt: '2026-11-01T00:00:00Z' }] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('coalesces requests and caches for no longer than sixty seconds', async () => {
  const original = globalThis.fetch;
  const now = Date.now;
  let time = now();
  let calls = 0;
  Date.now = () => time;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), '/api/providers/test%2Fcache/usage');
    assert.equal(init?.credentials, 'same-origin');
    return new Response(JSON.stringify(snapshot));
  }) as typeof fetch;
  try {
    const a = fetchProviderAccountUsage('test/cache');
    const b = fetchProviderAccountUsage('test/cache');
    assert.equal(a, b);
    await a;
    await fetchProviderAccountUsage('test/cache');
    assert.equal(calls, 1);
    time += 60_001;
    await fetchProviderAccountUsage('test/cache');
    assert.equal(calls, 2);
    await fetchProviderAccountUsage('test/cache', true);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; Date.now = now; }
});

test('real zero, units, freshness and reset render; unsupported has no figures', async () => {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  let current = snapshot;
  const view = createProviderAccountUsageView('test', { visible: () => true, request: async () => current });
  try {
    document.body.append(view.root);
    view.start();
    await tick();
    assert.match(view.root.textContent!, /0 USD remaining/);
    assert.match(view.root.textContent!, /Checked/);
    assert.match(view.root.textContent!, /Resets/);
    current = { ...snapshot, status: 'unsupported' };
    await view.refresh(true);
    assert.equal(view.root.querySelector('strong'), null);
    assert.match(view.root.textContent!, /does not expose/);
    assert.equal(hasProviderUsage(current), false);
  } finally { view.stop(); win.close(); Reflect.deleteProperty(globalThis, 'document'); }
});

test('hidden requests skipped and stopped views ignore late replies', async () => {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  let visible = false;
  let calls = 0;
  let changes = 0;
  let resolve!: (usage: ProviderAccountUsage) => void;
  const view = createProviderAccountUsageView('late', { visible: () => visible, onChange: () => changes++,
    request: async () => { calls++; return new Promise(done => { resolve = done; }); } });
  try {
    view.start();
    assert.equal(calls, 0);
    visible = true;
    const pending = view.refresh();
    view.stop();
    resolve(snapshot);
    await pending;
    assert.equal(changes, 0);
    assert.equal(view.root.querySelector('strong'), null);
  } finally { view.stop(); win.close(); Reflect.deleteProperty(globalThis, 'document'); }
});
