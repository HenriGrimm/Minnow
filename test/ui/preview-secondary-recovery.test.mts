import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('secondary preview validates the live guest before reusing a saved URL', async () => {
  const win = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, {
    window: win, document: win.document, localStorage: win.localStorage,
    HTMLElement: win.HTMLElement, MutationObserver: win.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  });
  document.body.innerHTML = '<div id="previewBodySecondary"></div><input id="previewUrlInputSecondary">';
  document.getElementById('previewBodySecondary')!.getBoundingClientRect = () =>
    new win.DOMRect(20, 20, 500, 400);
  const guests = new Map<string, { id: string; url: string; loading: boolean }>();
  const navigations: string[] = [];
  const instances: string[] = [];
  (window as unknown as { minnow: unknown }).minnow = { preview: {
    instances: { create: async () => {} },
    show: async () => {}, hide: async () => {},
    tabs: {
      list: async (instance: string) => { instances.push(instance); return [...guests.values()]; },
      create: async (id: string) => { guests.set(id, { id, url: 'about:blank', loading: false }); },
      activate: async () => {},
    },
    navigateAndWait: async (url: string, id: string) => {
      navigations.push(id);
      guests.get(id)!.url = url;
      return { ok: true };
    },
  } };
  const { openPreviewTab, resetPreviewTabStoreForTests } = await import('../../src/ui/preview-tab-store');
  const { renderSecondaryPreviewSlot, hideSecondaryPreviewSlot } = await import('../../src/ui/preview-secondary-slot');
  const { resetPreviewInstanceHostsForTests } = await import('../../src/ui/preview-instance-host');
  const { resetFilePanelStateForTests } = await import('../../src/state/file-panel');
  const tab = openPreviewTab({ kind: 'url', url: 'http://localhost:1234/page' })!;
  const activate = () => renderSecondaryPreviewSlot(tab.id, { isCurrent: () => true });
  try {
    await activate();
    await activate();
    assert.deepEqual(navigations, [tab.id], 'healthy pages keep their document');
    guests.clear();
    await activate();
    assert.equal(guests.get(tab.id)?.url, 'http://localhost:1234/page');
    assert.equal(navigations.length, 2, 'a missing guest is recovered');
    guests.set(tab.id, { id: tab.id, url: 'about:blank', loading: false });
    await activate();
    assert.equal(guests.get(tab.id)?.url, 'http://localhost:1234/page');
    assert.equal(navigations.length, 3, 'a guest recreated by layout is recovered');
    guests.set(tab.id, { id: tab.id, url: 'about:blank', loading: true });
    await activate();
    assert.equal(navigations.length, 3, 'in-flight navigation is not restarted');
    assert.ok(instances.every(id => id === 'workspace-preview-secondary'));
  } finally {
    hideSecondaryPreviewSlot();
    resetPreviewInstanceHostsForTests();
    resetPreviewTabStoreForTests();
    resetFilePanelStateForTests();
    await win.happyDOM.close();
  }
});
