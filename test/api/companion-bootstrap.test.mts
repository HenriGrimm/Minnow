import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { initializeCompanionAccess } from '../../src/companion/bootstrap.ts';
import { isChromeReady, markChromeReady, resetAppReadyForTests, scheduleMarkAppReady } from '../../src/boot/app-ready.ts';
import { saveDeviceToken } from '../../src/api/session-token.ts';

const originalFetch = globalThis.fetch;
const originalAnimationFrame = globalThis.requestAnimationFrame;
const windows: Window[] = [];

function setup() {
  const win = new Window({ url: 'http://192.168.1.10:9473/#/app/code/chat' });
  win.happyDOM.setWindowSize({ width: 390, height: 844 });
  // Connection timer/wake behavior is exercised in companion-connection.test.
  // These tests cover bootstrap DOM and routing without a perpetual poller.
  win.setInterval = (() => 0) as typeof win.setInterval;
  windows.push(win);
  Object.assign(globalThis, {
    window: win, document: win.document,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
  });
  resetAppReadyForTests();
  saveDeviceToken('minnow_device_mobile-regression');
  return win;
}

afterEach(() => {
  resetAppReadyForTests();
  globalThis.fetch = originalFetch;
  globalThis.requestAnimationFrame = originalAnimationFrame;
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

test('the real loading-shell CSS and chrome deadline cannot hide or remove companion status', async () => {
  const win = setup();
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const style = win.document.createElement('style');
  style.textContent = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  win.document.head.appendChild(style);
  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  scheduleMarkAppReady({ styleTimeoutMs: 1, chromeTimeoutMs: 1 });
  const boot = initializeCompanionAccess();
  await new Promise<void>((resolve) => win.setTimeout(resolve, 20));
  const waiting = win.document.getElementById('companionConnecting')!;
  assert.ok(waiting);
  assert.notEqual(win.getComputedStyle(waiting).visibility, 'hidden');
  const unfinished = win.document.createElement('main');
  win.document.body.appendChild(unfinished);
  assert.equal(win.getComputedStyle(unfinished).visibility, 'hidden', 'the real critical CSS still hides unfinished chrome');
  assert.equal(isChromeReady(), false);
  finish(new Response('{}'));
  assert.equal(await boot, true);
  await Promise.resolve();
  assert.ok(win.document.getElementById('companionConnecting'), 'authorization alone cannot expose unfinished chrome');
  markChromeReady();
  await Promise.resolve();
  assert.equal(win.document.getElementById('companionConnecting'), null);
  await new Promise<void>((resolve) => win.setTimeout(resolve, 40));
});
