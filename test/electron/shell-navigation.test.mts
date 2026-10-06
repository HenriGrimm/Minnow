import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { wireShellNavigation } from '../../electron/shell-navigation.ts';

class FakeContents extends EventEmitter {
  id = 42;
  popupHandler: ((details: { url: string }) => { action: string }) | null = null;

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.popupHandler = handler;
  }
}

function navigationPrevented(contents: FakeContents, kind: 'will-navigate' | 'will-redirect', url: string): boolean {
  let prevented = false;
  contents.emit(kind, { preventDefault() { prevented = true; } }, url);
  return prevented;
}

test('shell wiring guards both navigation paths and popup schemes, then revokes trust', () => {
  const contents = new FakeContents();
  const trusted = new Set<number>();
  const external: string[] = [];
  let revocations = 0;
  const revoke = wireShellNavigation(contents as unknown as Parameters<typeof wireShellNavigation>[0], 'http://127.0.0.1:9473/', {
    trust: (id) => { trusted.add(id); },
    untrust: (id) => { trusted.delete(id); revocations += 1; },
    openExternal: async (url) => { external.push(url); },
  });

  assert.equal(trusted.has(42), true);
  assert.equal(navigationPrevented(contents, 'will-navigate', 'http://127.0.0.1:9473/#/app/code'), false);
  assert.equal(navigationPrevented(contents, 'will-navigate', 'https://example.com/'), true);
  assert.equal(navigationPrevented(contents, 'will-redirect', 'http://127.0.0.1:9473/api/tools'), true);
  assert.equal(contents.popupHandler?.({ url: 'javascript:alert(1)' }).action, 'deny');
  assert.equal(contents.popupHandler?.({ url: 'https://example.com/docs' }).action, 'deny');
  assert.deepEqual(external, ['https://example.com/docs']);

  contents.emit('destroyed');
  assert.equal(trusted.has(42), false);
  revoke();
  assert.equal(revocations, 1, 'window close must not double-revoke destroyed contents');
});

test('Agent Browser viewer wiring remains on its dedicated hash route', () => {
  const contents = new FakeContents();
  wireShellNavigation(contents as unknown as Parameters<typeof wireShellNavigation>[0], 'http://127.0.0.1:9473/', {
    trust: () => {},
    untrust: () => {},
    openExternal: async () => {},
    routeHash: '#/agent-browser',
  });

  assert.equal(navigationPrevented(contents, 'will-navigate', 'http://127.0.0.1:9473/#/agent-browser'), false);
  assert.equal(navigationPrevented(contents, 'will-navigate', 'http://127.0.0.1:9473/#/app/code'), true);
  assert.equal(navigationPrevented(contents, 'will-redirect', 'https://example.com/'), true);
});

test('popup remains denied when external dispatch rejects', async () => {
  const contents = new FakeContents();
  wireShellNavigation(contents as unknown as Parameters<typeof wireShellNavigation>[0], 'http://127.0.0.1:9473/', {
    trust: () => {},
    untrust: () => {},
    openExternal: async () => { throw new Error('No OS handler'); },
  });
  assert.equal(contents.popupHandler?.({ url: 'https://example.com' }).action, 'deny');
  await Promise.resolve();
});
