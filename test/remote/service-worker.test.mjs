/**
 * The shell service worker never stands between the server and the requests
 * that carry a device's sign-in, and serves the cached shell only offline.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://minnow-studio.tail1.ts.net';

function loadWorker({ online = true } = {}) {
  const listeners = new Map();
  const cache = new Map([['./index.html', 'cached shell']]);
  const context = {
    URL,
    self: {
      location: new URL(`${ORIGIN}/sw.js`),
      addEventListener: (type, fn) => listeners.set(type, fn),
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: {
      open: async () => ({ put: async (key, value) => cache.set(key, value), addAll: async () => {} }),
      match: async (key) => cache.get(key),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => {
      if (!online) throw new TypeError('offline');
      return { ok: true, clone: () => 'fresh shell', body: 'fresh shell' };
    },
  };
  vm.runInNewContext(SOURCE, context);
  return (request) => {
    let responded = null;
    listeners.get('fetch')({ request, respondWith: (value) => { responded = value; } });
    return responded;
  };
}

const navigate = (path) => ({ url: `${ORIGIN}${path}`, mode: 'navigate' });

test('API calls, the connect page, and handoff start URLs go straight to the server', () => {
  const dispatch = loadWorker();
  assert.equal(dispatch({ url: `${ORIGIN}/api/auth/session`, mode: 'cors' }), null);
  assert.equal(dispatch(navigate('/connect')), null);
  assert.equal(dispatch(navigate('/?handoff=abc')), null);
  assert.equal(dispatch({ url: 'http://localhost:1234/v1/models', mode: 'cors' }), null);
});

test('navigations are network-first and fall back to the cached shell offline', async () => {
  const online = loadWorker();
  const fresh = await online(navigate('/'));
  assert.equal(fresh.body, 'fresh shell');

  const offline = loadWorker({ online: false });
  assert.equal(await offline(navigate('/')), 'cached shell');
});
