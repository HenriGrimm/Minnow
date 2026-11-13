import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { openPhoneApp } from '../../src/mobile/apps.ts';
import { getTopScreen, popScreen, registerTab, resetMobileNavForTests } from '../../src/mobile/nav.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('paired Settings exposes the seven authored destinations and preserves device navigation', async () => {
  const win = new Window({ url: 'http://localhost:9480/' });
  const originalFetch = globalThis.fetch;
  const originalHistory = globalThis.history;
  installHappyDomGlobals(win, {
    fetch: async (input) => {
      switch (String(input)) {
        case '/api/config/meta': return Response.json({ toolSecurity: { permissionLevel: 'manual' } });
        case '/api/config/default-model': return Response.json({ value: 'local-test\u001ftest-model', revision: 1 });
        case '/api/auth/host-info': return Response.json({ paired: true, ingress: 'lan', hostName: 'Test host' });
        case '/api/diagnostics/health': return Response.json({ version: '0.1.6' });
        default: return new Response('', { status: 404 });
      }
    },
  });
  globalThis.history = win.history;
  setStorageModeForTests('server');
  setPairedDevice(true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  registerTab('chats', host, { key: 'threads', el: document.createElement('section') });

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(condition(), 'The phone destination did not finish opening');
  }

  try {
    openPhoneApp('settings');
    await waitFor(() => getTopScreen()?.key === 'app:settings:landing');
    const landing = getTopScreen()!.el;
    const rows = [...landing.querySelectorAll('.m-phone-settings__label')].map(row => row.textContent);
    assert.deepEqual(rows, ['Appearance', 'Agents and permissions', 'Models and connections', 'Notifications', 'This phone', 'Backups', 'About']);
    assert.ok(landing.querySelector('button[aria-label="All settings"]'));
    await waitFor(() => landing.textContent!.includes('Minnow 0.1.6'));
    assert.match(landing.textContent!, /AppearanceDark.*Agents and permissionsManual.*Models and connectionstest-model.*Notifications3 on.*This phoneHome network/);

    landing.querySelector<HTMLButtonElement>('[data-setting="devices"]')!.click();
    await waitFor(() => getTopScreen()?.key === 'app:this-phone');
    const device = getTopScreen()!.el;
    assert.ok(landing.hidden);
    await waitFor(() => device.textContent!.includes('Connected to Test host'));
    assert.ok(device.querySelector('[aria-label="Permission level"]'));
    assert.ok(device.querySelector('.m-device__disconnect'));
    popScreen({ fromHistory: true });
    assert.equal(getTopScreen()?.el, landing);
    assert.equal(landing.hidden, false);
  } finally {
    resetMobileNavForTests();
    setPairedDevice(false);
    setStorageModeForTests(null);
    globalThis.fetch = originalFetch;
    globalThis.history = originalHistory;
    await teardownHappyDomAsync(win);
  }
});
