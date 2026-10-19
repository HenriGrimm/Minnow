/**
 * Settings → Devices and the Connect a phone sheet (happy-dom, mocked API).
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';

type Json = Record<string, unknown>;
let routes: Map<string, (body?: Json) => unknown>;
let posts: { url: string; body: Json }[];
const qrTexts: string[] = [];
const originalFetch = globalThis.fetch;

const lanOff = { state: 'off', port: 9480, urls: [] };
const lanOn = { state: 'on', port: 9480, urls: ['http://studio.local:9480/', 'http://192.168.1.10:9480/'] };
const anywhereOff = { state: 'off' };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

before(() => {
  mock.module('qrcode', {
    namedExports: {
      toCanvas: async (canvas: HTMLCanvasElement, text: string) => {
        canvas.dataset.qr = text;
        qrTexts.push(text);
      },
    },
  });
});

beforeEach(() => {
  const win = new Window({ url: 'http://127.0.0.1:9473/' });
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    Option: win.Option, Event: win.Event, KeyboardEvent: win.KeyboardEvent,
    localStorage: win.localStorage,
  });
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
  routes = new Map();
  posts = [];
  qrTexts.length = 0;
  routes.set('GET /api/remote/status', () => ({ lan: lanOff, anywhere: anywhereOff }));
  routes.set('GET /api/auth/devices', () => ({ devices: [] }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') posts.push({ url, body: body ?? {} });
    const handler = routes.get(`${method} ${url}`);
    if (!handler) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

after(() => mock.restoreAll());

describe('Devices page', () => {
  test('shows both connection cards and the empty device list', async () => {
    const { renderDevicesSettings } = await import('../../src/ui/settings-devices.ts');
    const mount = document.createElement('div');
    document.body.append(mount);
    await renderDevicesSettings(mount);
    const titles = [...mount.querySelectorAll('.devices-card__title')].map((node) => node.textContent);
    assert.deepEqual(titles, ['Anywhere', 'Home network']);
    assert.ok([...mount.querySelectorAll('button')].some((b) => b.textContent === 'Make it work anywhere'));
    assert.match(mount.querySelector('.devices-list__empty')!.textContent!, /No devices yet/);
  });

  test('a busy home-network port names the port', async () => {
    routes.set('GET /api/remote/status', () => ({
      lan: { state: 'error', port: 9480, urls: [], error: { code: 'port-in-use', message: '' } },
      anywhere: anywhereOff,
    }));
    const { renderDevicesSettings } = await import('../../src/ui/settings-devices.ts');
    const mount = document.createElement('div');
    document.body.append(mount);
    await renderDevicesSettings(mount);
    assert.match(mount.textContent!, /Port 9480 is in use/);
  });

  test('device rows show the Home Screen badge and when they were last used', async () => {
    routes.set('GET /api/auth/devices', () => ({
      devices: [{
        id: 'a'.repeat(24),
        name: 'Henri iPhone',
        kind: 'phone',
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastIngress: 'funnel',
        credentials: [{ id: 'b'.repeat(24), label: 'home-screen', origin: '', createdAt: '' }],
      }],
    }));
    const { renderDevicesSettings } = await import('../../src/ui/settings-devices.ts');
    const mount = document.createElement('div');
    document.body.append(mount);
    await renderDevicesSettings(mount);
    const row = mount.querySelector('.devices-row')!;
    assert.match(row.textContent!, /Henri iPhone/);
    assert.match(row.textContent!, /Home Screen app/);
    assert.match(row.textContent!, /Active now · via Anywhere/);
  });

  test('each Anywhere state offers its one next step', async () => {
    const { renderAnywhereState } = await import('../../src/ui/settings-devices-anywhere.ts');
    const cases: [Json, string][] = [
      [{ state: 'off' }, 'Make it work anywhere'],
      [{ state: 'needs-login', authUrl: 'https://login.tailscale.com/a/x' }, 'Sign in with Tailscale'],
      [{ state: 'needs-approval', feature: 'funnel', url: 'https://login.tailscale.com/f/funnel' }, 'Allow access'],
      [{ state: 'needs-approval', feature: 'https', url: 'https://login.tailscale.com/f/serve' }, 'Turn on HTTPS'],
      [{ state: 'needs-approval', feature: 'device', url: 'https://login.tailscale.com/admin/machines' }, 'Approve this computer'],
      [{ state: 'starting' }, 'Cancel'],
      [{ state: 'ready', url: 'https://minnow-studio.tail1.ts.net/', funnel: true }, 'Turn off'],
      [{ state: 'error', message: 'Broken' }, 'Try again'],
    ];
    for (const [status, label] of cases) {
      const mount = document.createElement('div');
      renderAnywhereState(mount, status as never, () => {});
      const primary = mount.querySelector('.settings-action-btn--primary, .settings-action-btn');
      assert.equal(primary?.textContent, label, String(status.state));
    }
  });

  test('a node stuck on the wrong account can start over with a different one', async () => {
    routes.set('POST /api/remote/anywhere/logout', () => ({ lan: lanOff, anywhere: anywhereOff }));
    routes.set('POST /api/remote/anywhere', () => ({ lan: lanOff, anywhere: { state: 'needs-login', authUrl: 'https://login.tailscale.com/a/y' } }));
    const { renderAnywhereState } = await import('../../src/ui/settings-devices-anywhere.ts');
    const mount = document.createElement('div');
    const next: string[] = [];
    renderAnywhereState(
      mount,
      { state: 'needs-approval', feature: 'device', url: 'https://login.tailscale.com/admin/machines', loginName: 'wrong@example.com' },
      (status) => next.push(status.anywhere.state),
    );
    assert.match(mount.textContent!, /Tailscale account: wrong@example\.com/);
    const button = [...mount.querySelectorAll('button')].find((b) => b.textContent === 'Use a different account')!;
    button.click();
    await flush();
    assert.deepEqual(posts.map((p) => p.url), ['/api/remote/anywhere/logout', '/api/remote/anywhere']);
    assert.deepEqual(posts[1].body, { enabled: true });
    assert.deepEqual(next, ['needs-login']);
  });
});

describe('Connect a phone sheet', () => {
  test('first use asks where the phone should work, then shows a live QR', async () => {
    let lan = lanOff;
    routes.set('GET /api/remote/status', () => ({ lan, anywhere: anywhereOff }));
    routes.set('POST /api/remote/lan', () => {
      lan = lanOn;
      return { lan, anywhere: anywhereOff };
    });
    routes.set('POST /api/auth/connect-sessions', () => ({
      id: 'c'.repeat(24),
      expiresAt: '',
      code: '123456',
      targets: [{ kind: 'lan', url: 'http://studio.local:9480/connect#t=TICKETTICKETTICKETTICK', baseUrl: 'http://studio.local:9480/' }],
    }));
    let claimed = false;
    routes.set(`GET /api/auth/connect-sessions/${'c'.repeat(24)}`, () =>
      claimed ? { id: 'c'.repeat(24), status: 'claimed', device: { id: 'd'.repeat(24), name: 'iPhone' } } : { id: 'c'.repeat(24), status: 'waiting' });

    const { openConnectSheet } = await import('../../src/ui/settings-devices-connect.ts');
    const connected: string[] = [];
    void openConnectSheet({ onConnected: (device) => connected.push(device.name) });
    await flush();
    assert.equal(document.getElementById('devicesSheetTitle')!.textContent, 'Where should this phone work?');
    [...document.querySelectorAll<HTMLButtonElement>('.devices-choice__option')][0].click();
    await flush();
    assert.deepEqual(posts.find((p) => p.url === '/api/remote/lan')?.body, { enabled: true });
    assert.equal(document.getElementById('devicesSheetTitle')!.textContent, 'Scan with your phone');
    assert.equal(qrTexts.at(-1), 'http://studio.local:9480/connect#t=TICKETTICKETTICKETTICK');
    assert.match(document.querySelector('.devices-fallback')!.textContent!, /123 456/);

    claimed = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_700));
    assert.equal(document.getElementById('devicesSheetTitle')!.textContent, 'iPhone is connected');
    assert.deepEqual(connected, ['iPhone']);
    [...document.querySelectorAll<HTMLButtonElement>('.devices-sheet button')].find((b) => b.textContent === 'Done')!.click();
    assert.equal(document.getElementById('devicesConnectSheet'), null);
  });

  test('with Anywhere ready the QR points at the HTTPS address and offers no code', async () => {
    routes.set('GET /api/remote/status', () => ({ lan: lanOff, anywhere: { state: 'ready', url: 'https://minnow-studio.tail1.ts.net/' } }));
    routes.set('POST /api/auth/connect-sessions', () => ({
      id: 'e'.repeat(24),
      expiresAt: '',
      targets: [{ kind: 'anywhere', url: 'https://minnow-studio.tail1.ts.net/connect#t=X', baseUrl: 'https://minnow-studio.tail1.ts.net/' }],
    }));
    routes.set(`GET /api/auth/connect-sessions/${'e'.repeat(24)}`, () => ({ id: 'e'.repeat(24), status: 'waiting' }));
    const { openConnectSheet } = await import('../../src/ui/settings-devices-connect.ts');
    void openConnectSheet();
    await flush();
    assert.equal(qrTexts.at(-1), 'https://minnow-studio.tail1.ts.net/connect#t=X');
    assert.match(document.querySelector('.devices-sheet__where')!.textContent!, /Works anywhere/);
    assert.match(document.querySelector('.devices-fallback')!.textContent!, /Request access/);
    document.getElementById('devicesConnectSheet')?.querySelector<HTMLButtonElement>('.devices-sheet__close')!.click();
  });
});
