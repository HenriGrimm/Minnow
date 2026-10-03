import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { notifyOs, testDesktopNotification } from '../../src/notifications/os-notification.ts';

let shown;
beforeEach(() => {
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  document.hasFocus = () => false;
  shown = [];
  globalThis.Notification = class {
    static permission = 'default';
    constructor(title, options) { shown.push({ title, ...options }); }
    close() {}
  };
});

test('Electron delivers despite default or denied Chromium permission, with click routing', async () => {
  for (const permission of ['default', 'denied']) {
    Notification.permission = permission;
    let clicked = false;
    window.minnow = { shell: { showNotification: async (input, onClick) => {
      assert.deepEqual(input, { title: 'Chat', body: 'Done', tag: 'run-1' });
      onClick();
      return { ok: true };
    } } };
    assert.equal(await notifyOs({ title: 'Chat', body: 'Done', tag: 'run-1', onClick: () => { clicked = true; } }), true);
    assert.equal(clicked, true);
    assert.equal(shown.length, 0);
  }
});

test('foreground events remain suppressed, while an explicit test delivers', async () => {
  document.hasFocus = () => true;
  let calls = 0;
  window.minnow = { shell: { showNotification: async () => { calls++; return { ok: true }; } } };
  assert.equal(await notifyOs({ title: 'Chat', body: 'Done' }), false);
  assert.equal(calls, 0);
  assert.deepEqual(await testDesktopNotification(), { ok: true });
  assert.equal(calls, 1);
});

test('browser permission is requested only by the explicit test gesture', async () => {
  let requested = 0;
  Notification.requestPermission = async () => { requested++; Notification.permission = 'granted'; return 'granted'; };
  assert.equal(await notifyOs({ title: 'Chat', body: 'Done' }), false);
  assert.equal(requested, 0);
  assert.deepEqual(await testDesktopNotification(), { ok: true });
  assert.equal(requested, 1);
  assert.equal(shown.length, 1);
});

test('native errors stay visible without falling back to a duplicate browser toast', async () => {
  Notification.permission = 'granted';
  window.minnow = { shell: { showNotification: async () => { throw new Error('Native delivery unavailable'); } } };
  assert.deepEqual(await testDesktopNotification(), { ok: false, error: 'Native delivery unavailable' });
  assert.equal(shown.length, 0);
});

test('an old Electron preload asks for restart', async () => {
  window.minnow = { app: { isElectron: true } };
  assert.match((await testDesktopNotification()).error, /Restart Minnow/);
});
