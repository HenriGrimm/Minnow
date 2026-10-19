import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { initializeCompanionAccess } from '../../src/companion/bootstrap.ts';
import { isChromeReady, markChromeReady, resetAppReadyForTests, scheduleMarkAppReady } from '../../src/boot/app-ready.ts';
import { setPairedDevice } from '../../src/api/session-token.ts';

const originalFetch = globalThis.fetch;
const originalAnimationFrame = globalThis.requestAnimationFrame;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const windows: Window[] = [];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

function setup(url = 'http://192.168.1.10:9480/#/app/code/chat') {
  const win = new Window({ url, settings: { navigator: { userAgent: IPHONE } } });
  win.happyDOM.setWindowSize({ width: 390, height: 844 });
  // Connection timer/wake behavior is exercised in companion-connection.test.
  // These tests cover bootstrap DOM and routing without a perpetual poller.
  win.setInterval = (() => 0) as typeof win.setInterval;
  windows.push(win);
  Object.assign(globalThis, {
    window: win, document: win.document,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
  });
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
  resetAppReadyForTests();
  return win;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });
const unauthorized = () => new Response('{}', { status: 401, headers: { 'X-Minnow-Auth': 'required' } });
const hostInfo = { hostName: 'Studio Mac', ingress: 'lan', codeEntry: true, requestsOpen: true, paired: false };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  resetAppReadyForTests();
  setPairedDevice(false);
  globalThis.fetch = originalFetch;
  globalThis.requestAnimationFrame = originalAnimationFrame;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  for (const win of windows.splice(0)) win.close();
});

test('a paired phone keeps deep links and viewport changes keep the active app', async () => {
  const win = setup();
  globalThis.fetch = async () => json({ authenticated: true, kind: 'device', hostName: 'Studio Mac' });
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
});

test('a scanned QR shows one Connect button, strips the ticket, and claims with the typed name', async () => {
  setup('http://192.168.1.10:9480/connect#t=AAAAAAAAAAAAAAAAAAAAAA');
  const requests: { url: string; body?: string }[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body as string | undefined });
    if (url === '/api/auth/host-info') return json(hostInfo);
    if (url === '/api/auth/claim') return json({ device: { id: 'a'.repeat(24), name: 'Kitchen iPhone' } });
    return json({});
  };
  assert.equal(await initializeCompanionAccess(), false);
  assert.equal(window.location.hash, '');
  assert.match(document.getElementById('companionAccessTitle')!.textContent!, /Connect to Studio Mac\?/);
  const input = document.querySelector<HTMLInputElement>('.companion-access__input')!;
  assert.equal(input.value, 'iPhone');
  input.value = 'Kitchen iPhone';
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#companionAccess button')];
  assert.deepEqual(buttons.map((b) => b.textContent), ['Connect']);
  buttons[0].click();
  await flush();
  const claim = requests.find((r) => r.url === '/api/auth/claim')!;
  assert.deepEqual(JSON.parse(claim.body!), { ticket: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'Kitchen iPhone', installed: false });
});

test('an unconnected phone can request access and sees the number to match', async () => {
  setup('http://192.168.1.10:9480/');
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') return unauthorized();
    if (url === '/api/auth/host-info') return json(hostInfo);
    if (url === '/api/auth/requests') return json({ id: 'b'.repeat(24), secret: 's', verifyCode: '4821', expiresAt: '' }, { status: 201 });
    return json({});
  };
  assert.equal(await initializeCompanionAccess(), false);
  await flush();
  assert.equal(document.getElementById('companionAccessTitle')!.textContent, 'Connect this device');
  const labels = [...document.querySelectorAll('#companionAccess button')].map((b) => b.textContent);
  assert.ok(labels.includes('Request access'));
  assert.ok(labels.includes('Enter a code instead'), 'home network offers code entry');
  assert.ok(!labels.includes('Scan QR'), 'no camera on plain HTTP');
  [...document.querySelectorAll<HTMLButtonElement>('#companionAccess button')].find((b) => b.textContent === 'Request access')!.click();
  await flush();
  assert.equal(document.getElementById('companionAccessTitle')!.textContent, 'Approve on your computer');
  assert.equal(document.querySelector('.companion-access__verify')!.textContent, '4 8 2 1');
});

test('a revoked device says so; a first visit does not', async () => {
  setup('http://192.168.1.10:9480/');
  window.localStorage.setItem('minnow.companion.paired', '1');
  globalThis.fetch = async (input: RequestInfo | URL) =>
    String(input) === '/api/auth/session' ? unauthorized() : json(hostInfo);
  assert.equal(await initializeCompanionAccess(), false);
  await flush();
  assert.equal(document.getElementById('companionAccessTitle')!.textContent, 'This device was disconnected');
});

test('a Home Screen app whose handoff expired explains why it asks once', async () => {
  setup('http://192.168.1.10:9480/connect?reason=handoff-expired');
  globalThis.fetch = async (input: RequestInfo | URL) =>
    String(input) === '/api/auth/session' ? unauthorized() : json({ ...hostInfo, codeEntry: false });
  assert.equal(await initializeCompanionAccess(), false);
  await flush();
  assert.match(document.querySelector('#companionAccess .companion-access__copy')!.textContent!, /needs to connect once/);
  const labels = [...document.querySelectorAll('#companionAccess button')].map((b) => b.textContent);
  assert.ok(!labels.includes('Enter a code instead'));
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
  finish(json({ authenticated: true, kind: 'device' }));
  assert.equal(await boot, true);
  await Promise.resolve();
  assert.ok(win.document.getElementById('companionConnecting'), 'authorization alone cannot expose unfinished chrome');
  markChromeReady();
  await Promise.resolve();
  assert.equal(win.document.getElementById('companionConnecting'), null);
  await new Promise<void>((resolve) => win.setTimeout(resolve, 40));
});
