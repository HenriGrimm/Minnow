import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('Open in Issues routes from the chat surface even before the Issues app mounts', async () => {
  const win = new Window({ url: 'http://localhost/#/app/code/chat' });
  Object.assign(globalThis, {
    window: win, document: win.document, localStorage: win.localStorage,
    HTMLElement: win.HTMLElement, MutationObserver: win.MutationObserver,
  });
  document.body.innerHTML = '<main id="workspaceSplit"><section id="mainColumn"></section></main>';
  const stage = document.getElementById('workspaceSplit')!;
  Object.defineProperty(stage, 'getClientRects', { value: () => [{}] });
  Object.defineProperty(stage, 'clientWidth', { value: 1440 });
  const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions');
  const chat = createEmptyChatObject('fixture', '/workspace');
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  const store = await import('../../src/state/issues-store');
  store.setIssuesStateForTests({ version: 2, nextId: 1049, workspaces: {}, issues: [{
    id: 'MIN-1048', title: 'Linked issue', description: '', type: 'bug', status: 'in_progress',
    priority: 'medium', labels: [], workspacePath: '/workspace', createdAt: 1, updatedAt: 1,
    source: 'user', chatIds: [chat.id],
  }] });
  try {
    const { mountSurfacePanels, openSurface } = await import('../../src/ui/surfaces/surfaces-column');
    const { mountGraphiteContextSurfaces } = await import('../../src/ui/surfaces/graphite-context-surfaces');
    mountGraphiteContextSurfaces();
    mountSurfacePanels(stage);
    assert.equal(openSurface('issue'), true);
    assert.equal(document.getElementById('issuesView'), null);
    const button = [...document.querySelectorAll('button')].find(node => node.textContent?.includes('Open in Issues'));
    assert.ok(button);
    button.click();
    assert.equal(window.location.hash, '#/app/issues/MIN-1048');
  } finally {
    store.setIssuesStateForTests(null);
    await win.happyDOM.abort();
    await win.close();
  }
});
