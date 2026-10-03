import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { renderNotificationsSettingsSection } from '../../src/ui/settings-notifications.ts';
import { resetNotificationPrefsForTests, saveNotificationPref } from '../../src/notifications/prefs.ts';

let mount;
let button;
let status;
beforeEach(() => {
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  resetNotificationPrefsForTests();
  mount = document.createElement('div');
  renderNotificationsSettingsSection(mount);
  button = [...mount.querySelectorAll('button')].find((node) => node.textContent === 'Test desktop notification');
  status = button.parentElement.querySelector('[role="status"]');
});

test('desktop test waits for native delivery and presents the OS failure', async () => {
  let resolve;
  let calls = 0;
  window.minnow = { shell: { showNotification: () => {
    calls++;
    return new Promise((done) => { resolve = done; });
  } } };
  button.click();
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(calls, 1);
  resolve({ ok: false, error: 'Notifications are disabled by the system' });
  await new Promise((done) => setImmediate(done));
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, 'Notifications are disabled by the system');
});

test('desktop test respects disabled and silenced preferences', () => {
  let calls = 0;
  window.minnow = { shell: { showNotification: async () => { calls++; return { ok: true }; } } };
  for (const [key, value] of [['muted', true], ['enabled', false], ['osEnabled', false]]) {
    resetNotificationPrefsForTests();
    localStorage.clear();
    saveNotificationPref(key, value);
    button.click();
    assert.match(status.textContent, /Enable desktop notifications and unsilence/);
    assert.equal(calls, 0);
  }
});
