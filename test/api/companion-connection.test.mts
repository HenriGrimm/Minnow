import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { installFetchAuth } from '../../src/api/install-fetch-auth.ts';
import { startCompanionConnectionMonitor } from '../../src/companion/connection.ts';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
let fetchMock: typeof fetch;
let timers: Map<number, () => void>;
let timeouts: Map<number, () => void>;
let monitor: ReturnType<typeof startCompanionConnectionMonitor> | undefined;
let changes: boolean[];
let revoked: number;
let sessions: unknown[];

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
    onSession: (session) => sessions.push(session),
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
  sessions = [];
  let nextTimer = 0;
  const win = Object.assign(new EventTarget(), {
    location: { href: 'http://192.168.1.10:9480/', origin: 'http://192.168.1.10:9480', pathname: '/', search: '', hash: '' },
    setInterval(callback: () => void) { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id: number) { timers.delete(id); },
    setTimeout(callback: () => void) { timeouts.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id: number) { timeouts.delete(id); },
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.assign(globalThis, { window: win, document: doc });
  fetchMock = async () => new Response('{"hostName":"Studio Mac"}');
  setPairedDevice(true);
});

afterEach(() => {
  monitor?.stop();
  monitor = undefined;
  setPairedDevice(false);
});
after(() => {
  Object.assign(globalThis, { fetch: originalFetch, window: originalWindow, document: originalDocument });
});

test('probes authenticate with the same-origin cookie, never a token header', async () => {
  const seen: RequestInit[] = [];
  fetchMock = async (_input, init) => {
    seen.push(init ?? {});
    return new Response('{"hostName":"Studio Mac"}');
  };
  assert.equal(await start().ready, true);
  assert.equal(seen[0].credentials, 'same-origin');
  assert.equal(new Headers(seen[0].headers).has('X-Minnow-Token'), false);
  assert.deepEqual(sessions, [{ hostName: 'Studio Mac' }]);
});

test('host recovery emits one refresh event after an outage', async () => {
  let refreshed = 0;
  window.addEventListener('minnow-host-reconnected', () => { refreshed += 1; });
  fetchMock = async () => { throw new TypeError('offline'); };
  start();
  await flush();
  assert.deepEqual(changes, [false]);
  fetchMock = async () => new Response('{}');
  tick();
  await flush();
  tick();
  await flush();
  assert.deepEqual(changes, [false, true, true]);
  assert.equal(refreshed, 1);
});

test('host outage during boot waits and resumes automatically on Wi-Fi recovery', async () => {
  let online = false;
  fetchMock = async () => {
    if (!online) throw new TypeError('offline');
    return new Response('{}');
  };
  let ready = false;
  void start().ready.then((value) => { ready = value; });
  await flush();
  assert.equal(ready, false);
  assert.deepEqual(changes, [false]);
  online = true;
  window.dispatchEvent(new Event('online'));
  await flush();
  assert.equal(ready, true);
  assert.equal(revoked, 0);
});

test('hung checks time out, never overlap, and retry', async () => {
  let calls = 0;
  fetchMock = (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  };
  start();
  tick();
  assert.equal(calls, 1, 'a second probe must not overlap the first');
  for (const callback of [...timeouts.values()]) callback();
  await flush();
  assert.deepEqual(changes, [false]);
  tick();
  assert.equal(calls, 2);
});

test('phone wake aborts a suspended probe and checks the restored network immediately', async () => {
  let calls = 0;
  fetchMock = (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    return Promise.resolve(new Response('{}'));
  };
  let ready = false;
  void start().ready.then((value) => { ready = value; });
  window.dispatchEvent(new Event('pageshow'));
  await flush();
  await flush();
  assert.equal(calls, 2);
  assert.equal(ready, true);
});

test('a confirmed 401 from the session probe means revoked and stops reconnecting', async () => {
  fetchMock = async () => rejectAuth();
  let ready = true;
  void start().ready.then((value) => { ready = value; });
  await flush();
  assert.equal(revoked, 1);
  assert.equal(ready, false);
  assert.equal(timers.size, 0);
});

test('storage errors (503) and unmarked 401s keep the pairing and retry', async () => {
  fetchMock = async () => new Response('{}', { status: 503 });
  start();
  await flush();
  fetchMock = async () => new Response('{}', { status: 401 });
  tick();
  await flush();
  assert.equal(revoked, 0);
  assert.deepEqual(changes, [false, false]);
});

test('provider 401s on other routes only ask the monitor to double-check', async () => {
  let checks = 0;
  window.addEventListener('minnow-auth-check', () => { checks += 1; });
  fetchMock = async () => rejectAuth();
  await fetch('/api/providers');
  assert.equal(checks, 1);
  await fetch('/api/auth/session');
  assert.equal(checks, 1, 'the probe itself never re-triggers a check');
  fetchMock = async () => new Response('{}', { status: 401 });
  await fetch('/api/generations');
  assert.equal(checks, 1, 'upstream 401 without the gate marker is ignored');
});
