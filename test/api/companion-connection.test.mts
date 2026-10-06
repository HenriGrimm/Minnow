import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { configureCompanionManifest, initializeDevicePairing } from '../../src/api/device-auth.ts';
import { clearDeviceToken, getDeviceToken, saveDeviceToken } from '../../src/api/session-token.ts';
import { installFetchAuth } from '../../src/api/install-fetch-auth.ts';
import { startCompanionConnectionMonitor } from '../../src/companion/connection.ts';

const TOKEN = 'minnow_device_saved-credential';
const NEW_TOKEN = 'minnow_device_new-credential';
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
let fetchMock: typeof fetch;
let timers: Map<number, () => void>;
let timeouts: Map<number, () => void>;
let monitor: ReturnType<typeof startCompanionConnectionMonitor> | undefined;
let changes: boolean[];
let revoked: number;

const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const rejectAuth = () => new Response('{}', {
  status: 401, headers: { 'X-Minnow-Auth': 'required' },
});
const start = () => {
  monitor = startCompanionConnectionMonitor({
    onConnectionChange: (connected) => changes.push(connected),
    onRevoked: () => { revoked += 1; },
  });
  return monitor;
};
const tick = () => { for (const callback of [...timers.values()]) callback(); };

before(() => {
  globalThis.fetch = ((...args) => fetchMock(...args)) as typeof fetch;
  installFetchAuth();
});

beforeEach(() => {
  timers = new Map();
  timeouts = new Map();
  changes = [];
  revoked = 0;
  let nextTimer = 0;
  const storage = new Map<string, string>();
  let cookie = '';
  const win = Object.assign(new EventTarget(), {
    location: { href: 'http://192.168.1.10:9473/', origin: 'http://192.168.1.10:9473',
      pathname: '/', search: '', hash: '' },
    history: { replaceState(_state: unknown, _title: string, url: string) {
      win.location.hash = new URL(url, win.location.href).hash;
    } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    setInterval(callback: () => void) { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id: number) { timers.delete(id); },
    setTimeout(callback: () => void) { timeouts.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id: number) { timeouts.delete(id); },
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.defineProperty(doc, 'cookie', {
    get: () => cookie,
    set: (value: string) => { cookie = value.includes('Max-Age=0') ? '' : value.split(';')[0]; },
  });
  Object.assign(globalThis, { window: win, document: doc });
  fetchMock = async () => new Response('{}');
  saveDeviceToken(TOKEN);
});

afterEach(() => { monitor?.stop(); monitor = undefined; });
after(() => {
  Object.assign(globalThis, { fetch: originalFetch, window: originalWindow, document: originalDocument });
});

test('reopening a used pairing QR preserves the existing pairing without exchanging the code', async () => {
  window.location.hash = '#pair=123456';
  fetchMock = async () => { throw new Error('Must not exchange an already used code'); };
  assert.equal(await initializeDevicePairing(), 'device');
  assert.equal(getDeviceToken(), TOKEN);
  assert.equal(window.location.hash, '#/desktop');
});

test('installed launch hydrates fresh storage without reusing the one-time pairing code', async () => {
  clearDeviceToken();
  window.location.hash = `#device=${encodeURIComponent(TOKEN)}`;
  fetchMock = async () => { throw new Error('No pairing exchange should be needed'); };
  assert.equal(await initializeDevicePairing(), 'device');
  assert.equal(getDeviceToken(), TOKEN);
  assert.equal(window.location.hash, '#/desktop', 'strip the launch credential immediately');
  fetchMock = async () => new Response('{}');
  assert.equal(await start().ready, true);
});

test('paired browser installs from its device manifest, never a host manifest', () => {
  const link = { href: '/manifest.json' };
  (document as any).querySelector = () => link;
  configureCompanionManifest();
  assert.equal(link.href, `/api/auth/manifest?token=${encodeURIComponent(TOKEN)}`);
  link.href = '/manifest.json';
  window.__MINNOW_SESSION_TOKEN__ = 'host-only-token';
  configureCompanionManifest();
  assert.equal(link.href, '/manifest.json');
});

test('installed launch cannot replace a newer pairing and is still subject to revocation', async () => {
  window.location.hash = `#device=${encodeURIComponent(NEW_TOKEN)}`;
  assert.equal(await initializeDevicePairing(), 'device');
  assert.equal(getDeviceToken(), TOKEN);
  fetchMock = async () => rejectAuth();
  assert.equal(await start().ready, false);
  assert.equal(getDeviceToken(), '');
  assert.equal(revoked, 1);
});

test('host recovery emits one refresh event after an outage', async () => {
  let refreshes = 0;
  window.addEventListener('minnow-host-reconnected', () => { refreshes += 1; });
  assert.equal(await start().ready, true);
  assert.equal(refreshes, 0);
  fetchMock = async () => { throw new Error('offline'); };
  tick();
  await flush();
  fetchMock = async () => new Response('{}');
  tick();
  await flush();
  tick();
  await flush();
  assert.equal(refreshes, 1);
});

test('workspace requests and upstream 401s cannot discard a valid pairing', async () => {
  const connection = start();
  assert.equal(await connection.ready, true);
  let checks = 0;
  fetchMock = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('X-Minnow-Token'), TOKEN);
    if (String(input) === '/api/auth/session') { checks += 1; return new Response('{}'); }
    assert.equal(new Headers(init?.headers).get('X-Minnow-Workspace'), 'C:/second-workspace');
    return new Response('provider signed out', { status: 401 });
  };
  (window as any).minnow = { viewContext: { workspacePath: 'C:/second-workspace' } };
  await fetch('/api/workspace', { method: 'PUT' });
  await flush();
  assert.equal(checks, 0);
  assert.equal(getDeviceToken(), TOKEN);
  assert.equal(revoked, 0);
  // Even an auth-gate rejection must be confirmed using the current credential.
  fetchMock = async (input) => String(input) === '/api/auth/session'
    ? new Response('{}') : rejectAuth();
  await fetch('/api/workspace');
  await flush();
  assert.equal(getDeviceToken(), TOKEN);
  assert.equal(revoked, 0);
});

test('host outage during boot waits and resumes automatically on Wi-Fi recovery', async () => {
  fetchMock = async () => { throw new TypeError('Network unavailable'); };
  let booted = false;
  const connection = start();
  void connection.ready.then((allowed) => { booted = allowed; });
  await flush();
  assert.equal(booted, false);
  assert.deepEqual(changes, [false]);
  assert.equal(getDeviceToken(), TOKEN);
  fetchMock = async () => new Response('{}');
  window.dispatchEvent(new Event('online'));
  assert.equal(await connection.ready, true);
  assert.equal(booted, true);
  fetchMock = async () => { throw new TypeError('Wi-Fi disconnected'); };
  window.dispatchEvent(new Event('offline'));
  await flush();
  fetchMock = async () => new Response('{}');
  window.dispatchEvent(new Event('online'));
  await flush();
  assert.deepEqual(changes, [false, true, false, true]);
  assert.equal(getDeviceToken(), TOKEN);
});

test('hung checks time out, never overlap, and retry using the same saved token', async () => {
  let calls = 0;
  fetchMock = (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    });
  };
  const connection = start();
  tick(); tick();
  assert.equal(calls, 1);
  for (const callback of [...timeouts.values()]) callback();
  await flush();
  assert.deepEqual(changes, [false]);
  fetchMock = async () => new Response('{}');
  tick();
  assert.equal(await connection.ready, true);
  assert.equal(getDeviceToken(), TOKEN);
});

test('phone wake aborts a suspended probe and checks the restored network immediately', async () => {
  let calls = 0;
  fetchMock = (_input, init) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(new Response('{}'));
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('Suspended')), { once: true });
    });
  };
  const connection = start();
  window.dispatchEvent(new Event('pageshow'));
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await connection.ready, true);
  assert.equal(calls, 2);
  assert.equal(timeouts.size, 0);
  assert.equal(getDeviceToken(), TOKEN);
});

test('tablet visibility changes and auth storage failures retain pairing and retry', async () => {
  fetchMock = async () => new Response('{}', { status: 503 });
  const connection = start();
  await flush();
  assert.deepEqual(changes, [false]);
  assert.equal(getDeviceToken(), TOKEN);
  // Monitoring does not depend on a phone viewport or minnow-companion CSS.
  fetchMock = async () => new Response('{}');
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await connection.ready, true);
  assert.equal(revoked, 0);
});

test('confirmed revocation clears both credential stores and stops reconnecting', async () => {
  fetchMock = async () => rejectAuth();
  assert.equal(await start().ready, false);
  assert.equal(getDeviceToken(), '');
  assert.equal(revoked, 1);
  assert.equal(timers.size, 0);
  assert.equal(timeouts.size, 0);
  window.dispatchEvent(new Event('online'));
  tick();
  assert.equal(revoked, 1);
});

test('a late rejected probe cannot erase a newer pairing', async () => {
  let finish!: (response: Response) => void;
  fetchMock = () => new Promise((resolve) => { finish = resolve; });
  const connection = start();
  saveDeviceToken(NEW_TOKEN);
  finish(rejectAuth());
  await flush();
  assert.equal(getDeviceToken(), NEW_TOKEN);
  assert.equal(revoked, 0);
  fetchMock = async () => new Response('{}');
  tick();
  assert.equal(await connection.ready, true);
});

test('an old request cannot trigger auth events for a newer pairing', async () => {
  let finish!: (response: Response) => void;
  let checks = 0;
  window.addEventListener('minnow-auth-check', () => { checks += 1; });
  fetchMock = () => new Promise((resolve) => { finish = resolve; });
  const request = fetch('/api/workspace');
  saveDeviceToken(NEW_TOKEN);
  finish(rejectAuth());
  await request;
  assert.equal(checks, 0);
  assert.equal(getDeviceToken(), NEW_TOKEN);
});
