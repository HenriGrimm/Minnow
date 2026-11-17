import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('chat switching restores a live browser page without reloading it', async () => {
  const win = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, {
    window: win, document: win.document, localStorage: win.localStorage,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
    CustomEvent: win.CustomEvent, MutationObserver: win.MutationObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  });
  document.documentElement.dataset.osApp = 'code';
  const markup = new win.DOMParser().parseFromString(
    readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), 'text/html',
  );
  const stage = document.importNode(markup.getElementById('workspaceSplit')! as unknown as Node, true) as HTMLElement;
  const app = document.createElement('div');
  app.id = 'appBody';
  app.append(stage);
  document.body.append(app);
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const visible = this.isConnected && !this.closest('[hidden], .hidden');
    return new win.DOMRect(20, 20, visible ? 500 : 0, visible ? 400 : 0);
  };
  const guests = new Map<string, { id: string; url: string; loading: boolean; title: string }>();
  let active: string | undefined;
  let painted: string | undefined;
  const navigations: string[] = [];
  const calls: string[] = [];
  (window as unknown as { minnow: unknown }).minnow = { preview: {
    tabs: {
      list: async () => [...guests.values()],
      create: async (id: string) => { guests.set(id, { id, url: 'about:blank', loading: false, title: '' }); return id; },
      activate: async (id: string) => { active = id; calls.push(`activate:${id}`); },
      close: async (id: string) => guests.delete(id),
    },
    show: async (_bounds: unknown, id?: string) => {
      painted = active = id ?? active;
      if (painted && !guests.has(painted)) guests.set(painted, { id: painted, url: 'about:blank', loading: false, title: '' });
      calls.push(`show:${painted}`);
    },
    hide: async () => { painted = undefined; calls.push('hide'); },
    navigateAndWait: async (url: string, id: string) => {
      guests.get(id)!.url = url;
      navigations.push(id);
      return { ok: true };
    },
    getInfo: async () => ({}),
  } };
  const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions');
  const { openPreviewTab } = await import('../../src/ui/preview-tab-store');
  const { mountSurfacePanels, refreshSurfacePanels } = await import('../../src/ui/surfaces/surfaces-column');
  const { createWorkbenchContent } = await import('../../src/ui/surfaces/workbench-content');
  const { resetPreviewGuestVisibilityForTests } = await import('../../src/ui/preview-electron-visibility');
  const a = createEmptyChatObject('a', '/workspace');
  const b = createEmptyChatObject('b', '/workspace');
  const state = { version: 6 as const, activeId: a.id, sidebarCollapsed: false, chats: [a, b] };
  setSessionStateForTests(state);
  const tab = openPreviewTab({ kind: 'url', url: 'http://localhost:1234/page' })!;
  for (const chat of [a, b]) {
    localStorage.setItem(`minnow.graphite.surfaces.v1.thread.${JSON.stringify(['/workspace', chat.id])}`, JSON.stringify({
      open: [`preview:${tab.id}`], side: { shown: true, active: `preview:${tab.id}` },
    }));
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 120));
  try {
    mountSurfacePanels(stage, { content: createWorkbenchContent(stage) });
    await settle();
    assert.equal(painted, tab.id, calls.join('\n'));
    assert.equal(guests.get(tab.id)?.url, tab.source?.kind === 'url' ? tab.source.url : '');
    for (const chat of [b, a, b, a]) {
      state.activeId = chat.id;
      refreshSurfacePanels();
      await settle();
      assert.equal(painted, tab.id, calls.join('\n'));
    }
    assert.equal(stage.querySelector('.graphite-preview-servers'), null);
    stage.dataset.surfaceMax = 'side';
    await settle();
    assert.equal(stage.querySelector('.graphite-preview-servers'), null, 'expanded browser must not mount dev server UI');
    delete stage.dataset.surfaceMax;
    assert.deepEqual(navigations, [tab.id], 'the loaded document must survive every chat switch');

    // Native hidden instances can be evicted independently of the renderer's
    // loaded-tab cache. A bounds sync can recreate the guest before activation.
    guests.clear();
    state.activeId = b.id;
    refreshSurfacePanels();
    await settle();
    assert.equal(painted, tab.id);
    assert.equal(guests.get(tab.id)?.url, 'http://localhost:1234/page', 'an evicted page must recover without manual reload');
    assert.deepEqual(navigations, [tab.id, tab.id], 'only the lost guest needs loading again');
    guests.set(tab.id, { id: tab.id, url: 'about:blank', loading: false, title: '' });
    state.activeId = a.id;
    refreshSurfacePanels();
    await settle();
    assert.equal(guests.get(tab.id)?.url, 'http://localhost:1234/page', 'a recreated blank guest must also recover');
    assert.equal(navigations.length, 3);
    guests.set(tab.id, { id: tab.id, url: 'about:blank', loading: true, title: '' });
    state.activeId = b.id;
    refreshSurfacePanels();
    await settle();
    assert.equal(navigations.length, 3, 'in-flight navigation must not be restarted');
  } finally {
    resetPreviewGuestVisibilityForTests();
    setSessionStateForTests(null);
    await win.happyDOM.close();
  }
});
