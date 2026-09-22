import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import {
  getSessionDirtyTrackingForTests, resetSessionPersistenceForTests, saveSessionsNow,
  setSessionStateForTests, touchChat, waitForSessionSaveForTests,
} from '../../src/state/sessions.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  setStorageModeForTests('localStorage');
  globalThis.fetch = originalFetch;
});

test('failed saves back off, retain new edits, and resume promptly after recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  setStorageModeForTests('server');
  resetSessionPersistenceForTests();
  const state = defaultSessionState();
  setSessionStateForTests(state);
  const chat = state.chats[0]!;
  touchChat(chat);
  let failing = true;
  const bodies: Array<{ chats?: Array<{ name: string }> }> = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(failing ? { error: 'offline' } : { ok: true, revision: 2 }),
      { status: failing ? 503 : 200 });
  }) as typeof fetch;
  saveSessionsNow();
  await waitForSessionSaveForTests();
  assert.equal(bodies.length, 1);
  chat.name = 'Changed during outage';
  touchChat(chat);
  for (let i = 0; i < 100; i++) saveSessionsNow();
  assert.equal(bodies.length, 1, 'new edits must not bypass the backoff');
  assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
  t.mock.timers.tick(499);
  assert.equal(bodies.length, 1);
  t.mock.timers.tick(1);
  await waitForSessionSaveForTests();
  assert.equal(bodies.length, 2);
  failing = false;
  t.mock.timers.tick(999);
  assert.equal(bodies.length, 2, 'second failure doubles the wait');
  t.mock.timers.tick(1);
  await waitForSessionSaveForTests();
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2]?.chats?.[0]?.name, 'Changed during outage');
  assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.length, 0);
  touchChat(chat);
  saveSessionsNow();
  await waitForSessionSaveForTests();
  assert.equal(bodies.length, 4, 'successful recovery clears the backoff');
});

test('shutdown bypasses backoff and cancels retry after dispatching the pending edits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setStorageModeForTests('server');
  resetSessionPersistenceForTests();
  const state = defaultSessionState();
  setSessionStateForTests(state);
  touchChat(state.chats[0]!);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('offline');
  };
  saveSessionsNow();
  await waitForSessionSaveForTests();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let beacons = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { sendBeacon: () => { beacons++; return true; } },
  });
  try {
    saveSessionsNow({ keepalive: true });
    assert.equal(beacons, 1);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.length, 0);
    t.mock.timers.tick(60_000);
    assert.equal(requests, 1, 'a completed shutdown flush cancels the queued retry');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
