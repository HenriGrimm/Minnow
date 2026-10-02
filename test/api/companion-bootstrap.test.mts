import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { initializeCompanionAccess } from '../../src/companion/bootstrap.ts';
import { markChromeReady, resetAppReadyForTests } from '../../src/boot/app-ready.ts';
import { saveDeviceToken } from '../../src/api/session-token.ts';

const originalFetch = globalThis.fetch;
const windows: Window[] = [];

function setup() {
  const win = new Window({ url: 'http://192.168.1.10:9473/#/app/code/chat' });
  win.happyDOM.setWindowSize({ width: 390, height: 844 });
  // Connection timer/wake behavior is exercised in companion-connection.test.
  // These tests cover bootstrap DOM and routing without a perpetual poller.
  win.setInterval = (() => 0) as typeof win.setInterval;
  windows.push(win);
  Object.assign(globalThis, { window: win, document: win.document });
  resetAppReadyForTests();
  saveDeviceToken('minnow_device_mobile-regression');
  return win;
}

afterEach(() => {
  resetAppReadyForTests();
  globalThis.fetch = originalFetch;
  for (const win of windows.splice(0)) win.close();
});

test('paired phone preserves deep links and viewport changes preserve the active app', async () => {
  const win = setup();
  globalThis.fetch = async () => new Response('{}');
  assert.equal(await initializeCompanionAccess(), true);
  assert.equal(window.location.hash, '#/app/code/chat');
  assert.equal(document.documentElement.classList.contains('minnow-companion'), true);
  window.location.hash = '#/app/issues/ISS-42';
  win.happyDOM.setWindowSize({ width: 900, height: 600 });
  win.happyDOM.setWindowSize({ width: 390, height: 844 });
  assert.equal(window.location.hash, '#/app/issues/ISS-42');
  assert.ok(document.getElementById('companionConnecting'));
  markChromeReady();
  await Promise.resolve();
  assert.equal(document.getElementById('companionConnecting'), null);
  assert.equal(document.getElementById('companionModeSelect'), null);
});

test('host outage leaves a visible status until authorization and chrome recover', async () => {
  setup();
  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const boot = initializeCompanionAccess();
  await Promise.resolve();
  assert.match(document.getElementById('companionConnecting')!.textContent!, /Waiting for the host/);
  finish(new Response('{}'));
  assert.equal(await boot, true);
  assert.match(document.getElementById('companionConnecting')!.textContent!, /Opening Minnow/);
  markChromeReady();
  await Promise.resolve();
  assert.equal(document.getElementById('companionConnecting'), null);
});
