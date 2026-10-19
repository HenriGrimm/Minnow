/**
 * Host approval card for a device asking to connect (happy-dom, mocked API).
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { Window } from 'happy-dom';

const originalFetch = globalThis.fetch;
const request = {
  id: 'f'.repeat(24),
  name: 'iPhone',
  kind: 'phone',
  verifyCode: '4821',
  installed: true,
  ingress: 'lan',
  createdAt: '',
  expiresAt: '',
};
let pending = [request];
const posts: { url: string; body: unknown }[] = [];

before(() => {
  const win = new Window({ url: 'http://127.0.0.1:9473/' });
  Object.assign(win, { __MINNOW_SESSION_TOKEN__: 'host' });
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement, Option: win.Option, Event: win.Event, KeyboardEvent: win.KeyboardEvent, localStorage: win.localStorage });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      pending = [];
      return new Response('{}');
    }
    if (url === '/api/remote/status') return new Response(JSON.stringify({ lan: { state: 'on', port: 9480, urls: [] }, anywhere: { state: 'off' } }));
    if (url === '/api/auth/requests') return new Response(JSON.stringify({ requests: pending }));
    if (url === '/api/auth/devices') {
      return new Response(JSON.stringify({
        devices: [{ id: 'a'.repeat(24), name: 'iPhone', kind: 'phone', createdAt: '', credentials: [] }],
      }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {});
after(() => {
  globalThis.fetch = originalFetch;
  (globalThis.window as unknown as { happyDOM?: { abort: () => void } }).happyDOM?.abort();
});

test('shows the number to match, preselects the known device for a Home Screen app, and approves', async () => {
  const { initDeviceRequestPrompt } = await import('../../src/ui/device-request-prompt.ts');
  initDeviceRequestPrompt();
  initDeviceRequestPrompt();
  for (let i = 0; i < 100 && !document.querySelector('.device-request'); i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const cards = document.querySelectorAll('.device-request');
  assert.equal(cards.length, 1, 'one card per request, even if initialized twice');
  assert.match(cards[0].textContent!, /iPhone wants to connect/);
  assert.equal(cards[0].querySelector('.device-request__code')!.textContent, '4 8 2 1');
  const select = cards[0].querySelector<HTMLSelectElement>('select')!;
  assert.equal(select.value, 'a'.repeat(24));

  [...cards[0].querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Approve')!.click();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(posts, [{ url: `/api/auth/requests/${request.id}/approve`, body: { attachToDeviceId: 'a'.repeat(24) } }]);
  assert.equal(document.querySelectorAll('.device-request').length, 0);
});
