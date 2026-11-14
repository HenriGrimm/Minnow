import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import type { MinnowUpdaterStatus } from '../../src/electron.d.ts';
import { createUpdateCenter } from '../../src/os/update-center.ts';
import { disposeAppUpdatesSettings, renderAppUpdatesSettings } from '../../src/ui/settings-updates.ts';

let win: Window;
const originalFetch = globalThis.fetch;
afterEach(() => { disposeAppUpdatesSettings(); win?.close(); globalThis.fetch = originalFetch; });

test('Settings shares progress, restart, release notes and manual check for installed CLIs', async () => {
  win = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, { document: win.document, window: win, HTMLElement: win.HTMLElement });
  let status: MinnowUpdaterStatus = {
    state: 'idle', supported: true, unsupportedReason: null, installedVersion: '1.2.3', channel: 'stable',
    pendingVersion: null, releaseNotes: null, progressPercent: null, lastCheckedAt: Date.now(),
    nextCheckAt: null, errorMessage: null,
  };
  let listener: (status: MinnowUpdaterStatus) => void = () => {};
  const calls: string[] = [];
  window.minnow = { updater: {
    getStatus: async () => status,
    onStatusChanged: cb => { listener = cb; return () => {}; },
    checkNow: async () => { calls.push('check'); return status; },
    setChannel: async channel => { calls.push(channel); listener(status = { ...status, channel }); return status; },
    restart: async () => { calls.push('restart'); return false; },
  } } as typeof window.minnow;
  globalThis.fetch = async url => {
    calls.push(String(url));
    return Response.json({ checkedAt: Date.now(), items: [] });
  };
  const mount = document.createElement('div');
  document.body.append(mount);
  const center = createUpdateCenter();
  renderAppUpdatesSettings(mount, center);
  await center.checkCli();
  assert.match(mount.textContent!, /v1\.2\.3/);
  assert.match(mount.textContent!, /No CLI providers are installed/);
  await center.check();
  assert.ok(calls.includes('check'));
  assert.ok(calls.includes('/api/models/agent-clis/updates?refresh=1'));

  listener(status = { ...status, state: 'downloading', pendingVersion: '1.3.0', progressPercent: 41,
    releaseNotes: '### Changes\n- Reliability fixes' });
  const progress = mount.querySelector('progress')!;
  const notes = mount.querySelector('details')!;
  assert.equal(progress.value, 41);
  assert.equal(progress.getAttribute('aria-label'), 'Minnow download progress');
  notes.open = true;
  listener(status = { ...status, progressPercent: 72 });
  assert.equal(progress.value, 72);
  assert.equal(mount.querySelector('.updates-download__percent')!.textContent, '72%');
  listener(status = { ...status, state: 'ready' });
  assert.ok(progress.closest('[hidden]'));
  assert.equal(notes.open, true);
  assert.match(notes.textContent!, /Reliability fixes/);
  await center.restart();
  assert.match(mount.textContent!, /Could not restart Minnow/);
  const beta = mount.querySelector<HTMLInputElement>('[name="settings-update-channel"][value="beta"]')!;
  beta.checked = true;
  beta.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
  assert.ok(calls.includes('beta'));
});
