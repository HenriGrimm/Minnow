/**
 * Paired devices hold no secret in page storage. A pairing saved by an older
 * build in localStorage is handed to the host once and then removed.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  getSessionToken,
  hasHostSessionToken,
  isPairedDevice,
  migrateLegacyDeviceToken,
  setPairedDevice,
  withSessionToken,
} from '../../src/api/session-token.ts';

const LEGACY_KEY = 'minnow.auth.deviceToken';
const LEGACY_TOKEN = 'minnow_device_aaaaaaaaaaaaaaaaaaaaaaaa.saved';
const originalFetch = globalThis.fetch;
const g = globalThis as typeof globalThis & { window?: unknown };
let storage: Map<string, string>;
let calls: { url: string; init?: RequestInit }[];

function installWindow(extra: Record<string, unknown> = {}) {
  storage = new Map();
  g.window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    location: { href: 'http://192.168.1.10:9480/' },
    ...extra,
  };
}

function respondWith(response: Response | Error) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
}

describe('legacy device credential migration', () => {
  beforeEach(() => installWindow());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete g.window;
    setPairedDevice(false);
  });

  test('adoption moves the old credential into the cookie and forgets it', async () => {
    storage.set(LEGACY_KEY, LEGACY_TOKEN);
    respondWith(new Response('{"adopted":true}'));
    assert.equal(await migrateLegacyDeviceToken(), true);
    assert.equal(calls[0].url, '/api/auth/adopt');
    assert.equal(new Headers(calls[0].init?.headers).get('X-Minnow-Token'), LEGACY_TOKEN);
    assert.equal(storage.has(LEGACY_KEY), false);
  });

  test('a network failure keeps the old credential for the next launch', async () => {
    storage.set(LEGACY_KEY, LEGACY_TOKEN);
    respondWith(new TypeError('offline'));
    assert.equal(await migrateLegacyDeviceToken(), false);
    assert.equal(storage.get(LEGACY_KEY), LEGACY_TOKEN);
  });

  test('a rejected credential is dropped', async () => {
    storage.set(LEGACY_KEY, LEGACY_TOKEN);
    respondWith(new Response('{}', { status: 401 }));
    assert.equal(await migrateLegacyDeviceToken(), false);
    assert.equal(storage.has(LEGACY_KEY), false);
  });

  test('nothing to migrate makes no request', async () => {
    respondWith(new Response('{}'));
    assert.equal(await migrateLegacyDeviceToken(), false);
    assert.equal(calls.length, 0);
  });
});

describe('session token helpers', () => {
  afterEach(() => {
    delete g.window;
    setPairedDevice(false);
  });

  test('paired devices add no token to socket and stream URLs', () => {
    installWindow();
    setPairedDevice(true);
    assert.equal(isPairedDevice(), true);
    assert.equal(getSessionToken(), '');
    assert.equal(withSessionToken('/api/streams/ws'), '/api/streams/ws');
  });

  test('the host token still rides the query string', () => {
    installWindow({ __MINNOW_SESSION_TOKEN__: 'host-secret' });
    setPairedDevice(true);
    assert.equal(hasHostSessionToken(), true);
    assert.equal(isPairedDevice(), false);
    assert.equal(withSessionToken('/api/streams/ws'), '/api/streams/ws?token=host-secret');
  });
});

describe('installed PWA detection', () => {
  test('detects iOS standalone flag', async () => {
    g.window = {
      navigator: { standalone: true },
      matchMedia: () => ({ matches: false }),
    };
    const { isInstalledPwa } = await import('../../src/api/pwa-context.ts');
    assert.equal(isInstalledPwa(), true);
    delete g.window;
  });
});
