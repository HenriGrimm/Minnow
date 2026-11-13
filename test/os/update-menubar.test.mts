import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createUpdateCenter } from '../../src/os/update-center.ts';
import { initUpdateMenubarPill } from '../../src/os/update-menubar.ts';
import { launchApp, getCurrentRoute, resetOsRouterForTests } from '../../src/os/router.ts';
import { resetInstancesForTests } from '../../src/os/instances.ts';
import { installHappyDomGlobals } from './dom-helpers.mts';
import { resetToastsForTests } from '../../src/ui/toast.ts';

let win: Window;
let cleanup: (() => void) | undefined;
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  resetToastsForTests();
  resetInstancesForTests();
  resetOsRouterForTests();
  win?.close();
  globalThis.fetch = originalFetch;
});

function mountUpdates(center: ReturnType<typeof createUpdateCenter>) {
  const slot = document.createElement('div');
  document.body.append(slot);
  cleanup = initUpdateMenubarPill(slot, center);
  const trigger = slot.querySelector('button')!;
  const rect = new win.DOMRect(400, 220, 32, 32);
  trigger.getBoundingClientRect = () => rect;
  trigger.getClientRects = () => (slot.hidden ? [] : [rect]) as unknown as DOMRectList;
  trigger.style.visibility = 'visible';
  return { slot, trigger };
}

test('workspace update badge and popover track an in-app CLI install', async () => {
  win = new Window({ url: 'http://localhost' });
  installHappyDomGlobals(win);
  let installedVersion = '1.1.0';
  let release!: () => void;
  let fail = false;
  const posted: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posted.push(String(url));
      await new Promise<void>(resolve => { release = resolve; });
      if (fail) return Response.json({ error: 'Finish active Claude Code work before updating.' }, { status: 400 });
      installedVersion = '1.2.0';
      return Response.json({ installedVersion });
    }
    return Response.json({ checkedAt: Date.now(), items: [{
      kind: 'claude', label: 'Claude Code', installedVersion, latestVersion: '1.2.0',
      state: installedVersion === '1.2.0' ? 'current' : 'available',
    }] });
  };
  const center = createUpdateCenter();
  const { trigger } = mountUpdates(center);
  assert.equal(trigger.getAttribute('aria-label'), 'Updates');
  trigger.click();
  const panel = document.querySelector<HTMLElement>('.mn-os-update-menu')!;
  assert.equal(panel.dataset.occluderKind, 'menu');
  await center.checkCli();
  assert.equal(trigger.getAttribute('aria-label'), '1 update available');
  assert.match(panel.textContent!, /v1\.1\.0 → v1\.2\.0/);

  const button = panel.querySelector<HTMLButtonElement>('[aria-label="Update Claude Code"]')!;
  button.click();
  assert.equal(button.disabled, true);
  assert.match(panel.textContent!, /Updating in the background/);
  fail = true;
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(panel.textContent!, /Finish active Claude Code work/);
  assert.equal(button.textContent, 'Retry');

  fail = false;
  button.click();
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(posted, ['/api/models/agent-clis/claude/update', '/api/models/agent-clis/claude/update']);
  assert.equal(trigger.getAttribute('aria-label'), 'Updates');
  assert.match(panel.textContent!, /Installed version 1\.2\.0/);
  window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger);
});

test('View updates anchors to the visible control and links directly to Settings Updates', async () => {
  win = new Window({ url: 'http://localhost/#/app/models/providers' });
  installHappyDomGlobals(win);
  Object.defineProperty(document, 'hidden', { value: false });
  globalThis.fetch = async () => Response.json({ checkedAt: Date.now(), items: [{
    kind: 'codex', label: 'Codex CLI', installedVersion: '1.1.0', latestVersion: '1.2.0', state: 'available',
  }] });
  launchApp('models', { modelsSection: 'providers' });
  const center = createUpdateCenter();
  const { slot, trigger } = mountUpdates(center);
  await center.checkCli();
  await new Promise(resolve => setTimeout(resolve, 0));
  const action = document.querySelector<HTMLButtonElement>('.mn-toast__action');
  assert.equal(action?.textContent, 'View updates');
  action!.click();
  const panel = document.querySelector<HTMLElement>('.mn-os-update-menu');
  assert.ok(panel);
  assert.equal(panel.style.top, '256px');
  assert.equal(window.location.hash, '#/app/models/providers');
  slot.hidden = true;
  window.dispatchEvent(new window.Event('minnow:graphite-workspace-changed'));
  assert.equal(panel.isConnected, false);
  slot.hidden = false;
  trigger.click();
  const settings = document.querySelector<HTMLButtonElement>('.updates-popover__footer button');
  assert.ok(settings);
  settings.click();
  assert.equal(window.location.hash, '#/app/settings/updates');
  assert.equal(getCurrentRoute().settingsSection, 'updates');

  launchApp('models', { modelsSection: 'providers' });
  center.state.cli!.items[0].latestVersion = '1.3.0';
  window.dispatchEvent(new window.Event('minnow:graphite-workspace-changed'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const nextAction = document.querySelector<HTMLButtonElement>('.mn-toast__action');
  assert.ok(nextAction);
  slot.hidden = true;
  nextAction.click();
  assert.equal(document.querySelector('.mn-os-update-menu'), null);
  assert.equal(window.location.hash, '#/app/settings/updates');
});
