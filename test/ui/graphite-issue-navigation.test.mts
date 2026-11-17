import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('the chat Issue tab mounts full details with authenticated images before the Issues app mounts', async () => {
  const win = new Window({ url: 'http://localhost/#/app/code/chat' });
  Object.assign(globalThis, {
    window: win, document: win.document, localStorage: win.localStorage,
    HTMLElement: win.HTMLElement, MutationObserver: win.MutationObserver,
  });
  window.__MINNOW_SESSION_TOKEN__ = 'fixture-token';
  document.body.innerHTML = '<main id="workspaceSplit"><section id="mainColumn"></section></main>';
  const stage = document.getElementById('workspaceSplit')!;
  Object.defineProperty(stage, 'getClientRects', { value: () => [{}] });
  Object.defineProperty(stage, 'clientWidth', { value: 1440 });
  const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions');
  const chat = createEmptyChatObject('fixture', '/workspace');
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  const store = await import('../../src/state/issues-store');
  const { issueAttachmentUrl } = await import('../../src/state/issue-attachments-api');
  const attachment = { name: 'image.png', path: '/attachments/MIN-1048/image.png', mime: 'image/png', bytes: 32, addedAt: 1 };
  const imageUrl = issueAttachmentUrl(attachment);
  store.setIssuesStateForTests({ version: 2, nextId: 1050, workspaces: {}, issues: [{
    id: 'MIN-1048', title: 'Linked issue', description: `![Inline screenshot](${imageUrl})`, type: 'bug', status: 'in_progress',
    priority: 'medium', labels: [], workspacePath: '/workspace', createdAt: 1, updatedAt: 1,
    source: 'user', chatIds: [chat.id], attachments: [attachment],
    issueRefs: [{ kind: 'related', issueId: 'MIN-1049' }],
  }, {
    id: 'MIN-1049', title: 'Related issue', description: '', type: 'task', status: 'in_progress',
    priority: 'medium', labels: [], workspacePath: '/workspace', createdAt: 1, updatedAt: 1, source: 'user',
  }] });
  try {
    const { dismissSurface, mountSurfacePanels, openSurface } = await import('../../src/ui/surfaces/surfaces-column');
    const { mountGraphiteContextSurfaces } = await import('../../src/ui/surfaces/graphite-context-surfaces');
    mountGraphiteContextSurfaces();
    mountSurfacePanels(stage);
    assert.equal(openSurface('issue'), true);
    await import('../../src/ui/issues-detail');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.getElementById('issuesView'), null);
    const queryPanel = () => document.querySelector('#graphitePanel-issue .issues-detail');
    const panel = queryPanel();
    assert.ok(panel);
    assert.equal(panel.querySelector<HTMLTextAreaElement>('[aria-label="Issue title"]')?.value, 'Linked issue');
    assert.ok(panel.querySelector('.issues-detail__properties'));
    assert.ok(panel.querySelector('.issues-detail__section--comments'));
    assert.ok(panel.querySelector('.issues-work-tabs'));
    for (const alt of ['Inline screenshot', 'image.png']) {
      const src = panel.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)?.src;
      assert.ok(src, `Missing ${alt}`);
      assert.equal(new URL(src).searchParams.get('token'), 'fixture-token');
    }
    const related = panel.querySelector<HTMLButtonElement>('button[title="Open MIN-1049"]');
    assert.ok(related);
    related.click();
    assert.equal(window.location.hash, '#/app/code/chat');
    assert.equal(queryPanel()?.getAttribute('data-issue-id'), 'MIN-1049');
    dismissSurface('issue');
    assert.equal(queryPanel(), null);
    assert.equal(openSurface('issue'), true);
    const button = queryPanel()?.querySelector<HTMLButtonElement>('button[aria-label="Open in Issues"]');
    assert.ok(button);
    button.click();
    assert.equal(window.location.hash, '#/app/issues/MIN-1049');
  } finally {
    store.setIssuesStateForTests(null);
    await win.happyDOM.abort();
    await win.close();
  }
});
