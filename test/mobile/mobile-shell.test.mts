/**
 * Phone app (src/mobile/): boot decision, tab/stack navigation with the back
 * gesture, and the pure helpers behind the board, file and chat lists.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { Window } from 'happy-dom';

let win: Window;

test('workspace sheet refreshes recents, includes sandbox and browsing, and reports load failures', async () => {
  const { switchWorkspaceFromSheet } = await import('../../src/mobile/workspace-switch.ts');
  const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  const originalFetch = globalThis.fetch;
  const row = (path: string) => ({ path, label: path, exists: true, isCurrent: false });
  let reads = 0;
  setWorkspaceFromServer({ path: '/current', label: 'Current', isDefault: false, recent: [] });
  globalThis.fetch = (async () => {
    reads++;
    return new Response(JSON.stringify({
      path: '/current', label: 'Current', isDefault: false,
      recent: [row('/current'), row(`/fresh-${reads}`), { ...row('/missing'), exists: false }],
      sandbox: row('/sandbox'),
    }));
  }) as typeof fetch;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const pending = switchWorkspaceFromSheet();
      for (let i = 0; i < 20 && !document.querySelector('.m-sheet:not(.test-closed)'); i++) await Promise.resolve();
      const sheet = document.querySelector('.m-sheet:not(.test-closed)')!;
      assert.ok(sheet, 'empty cached recents still opens a picker');
      const labels = [...sheet.querySelectorAll('.m-pick__label')].map((el) => el.textContent);
      assert.deepEqual(labels, ['/sandbox', '/current', `/fresh-${attempt}`, 'Browse folders…']);
      (sheet.querySelector('[aria-selected="true"]') as HTMLButtonElement).click();
      sheet.classList.add('test-closed');
      await pending;
    }
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    await switchWorkspaceFromSheet();
    assert.match(document.querySelector('.mn-toast--error')?.textContent ?? '', /Unable to load workspaces/);
  } finally {
    globalThis.fetch = originalFetch;
    document.querySelectorAll('.m-sheet, .mn-toast-stack').forEach((el) => el.remove());
  }
});

function setMatchMedia(phone: boolean): void {
  Object.assign(win, {
    matchMedia: (query: string) => ({
      matches: phone && query.includes('max-width: 640px'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

before(() => {
  win = new Window({ url: 'http://127.0.0.1:9473/' });
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    history: win.history,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    PopStateEvent: win.PopStateEvent,
    localStorage: win.localStorage,
    cancelAnimationFrame: clearTimeout,
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  });
  setMatchMedia(false);
});

after(async () => {
  win.dispatchEvent(new win.Event('pagehide'));
  await win.happyDOM.close();
});

test('phone alert preferences affect paired delivery and leave desktop delivery alone', async () => {
  const { setPairedDevice } = await import('../../src/api/session-token.ts');
  const { allowsPhoneAlert, setPhoneAlertEnabled } = await import('../../src/notifications/phone-prefs.ts');
  const failure = { kind: 'scheduler', appId: 'scheduler', activityStatus: 'failed' } as const;
  const approval = { kind: 'chat_question', appId: 'code' } as const;
  setPairedDevice(true);
  try {
    assert.equal(allowsPhoneAlert(failure), false);
    assert.equal(allowsPhoneAlert({ ...failure, activityStatus: 'completed' }), true);
    assert.equal(allowsPhoneAlert(approval), true);
    setPhoneAlertEnabled('scheduler', true);
    setPhoneAlertEnabled('approvals', false);
    assert.equal(allowsPhoneAlert(failure), true);
    assert.equal(allowsPhoneAlert(approval), false);
  } finally {
    setPairedDevice(false);
    localStorage.removeItem('minnow.notifications.phone.scheduler');
    localStorage.removeItem('minnow.notifications.phone.approvals');
  }
  assert.equal(allowsPhoneAlert(approval), true);
});

// ── Boot decision ────────────────────────────────────────────────────────────

test('phone-sized browsers boot the phone app; Electron never does', async () => {
  const { isMobileShell, resetMobileShellModeForTests } = await import('../../src/mobile/mode.ts');
  win.localStorage.clear();

  setMatchMedia(true);
  resetMobileShellModeForTests();
  assert.equal(isMobileShell(), true);

  setMatchMedia(false);
  resetMobileShellModeForTests();
  assert.equal(isMobileShell(), false);

  Object.assign(win, { minnow: {} });
  setMatchMedia(true);
  resetMobileShellModeForTests();
  assert.equal(isMobileShell(), false, 'Electron windows keep the desktop shell');
  delete (win as unknown as { minnow?: unknown }).minnow;
  resetMobileShellModeForTests();
});

test('?mobile=0 and ?mobile=1 override the viewport and are remembered', async () => {
  const { isMobileShell, resetMobileShellModeForTests, setMobileShellPreference } = await import('../../src/mobile/mode.ts');
  win.localStorage.clear();
  setMatchMedia(true);

  win.history.replaceState(null, '', '/?mobile=0');
  resetMobileShellModeForTests();
  assert.equal(isMobileShell(), false);

  win.history.replaceState(null, '', '/');
  resetMobileShellModeForTests();
  assert.equal(isMobileShell(), false, 'the choice survives the next load');

  setMatchMedia(false);
  win.history.replaceState(null, '', '/?mobile=1');
  resetMobileShellModeForTests();
  assert.equal(isMobileShell(), true);

  setMobileShellPreference(null);
  win.history.replaceState(null, '', '/');
  resetMobileShellModeForTests();
  assert.equal(isMobileShell(), false);
});

// ── Navigation ───────────────────────────────────────────────────────────────

type Log = string[];

async function screen(key: string, log: Log) {
  const { el } = await import('../../src/mobile/dom.ts');
  return {
    key,
    el: el('section', { className: 'm-screen' }),
    onShow: () => log.push(`show:${key}`),
    onHide: () => log.push(`hide:${key}`),
    dispose: () => log.push(`dispose:${key}`),
  };
}

afterEach(async () => {
  const { resetMobileNavForTests } = await import('../../src/mobile/nav.ts');
  resetMobileNavForTests();
});

test('each tab keeps its own stack; re-selecting a tab pops it to the root', async () => {
  const nav = await import('../../src/mobile/nav.ts');
  const log: Log = [];
  const chatsHost = win.document.createElement('div') as unknown as HTMLElement;
  const filesHost = win.document.createElement('div') as unknown as HTMLElement;
  nav.registerTab('chats', chatsHost, await screen('chats', log));
  nav.registerTab('files', filesHost, await screen('files', log));

  nav.pushScreen(await screen('chat:a', log));
  assert.equal(nav.getTopScreen()?.key, 'chat:a');

  nav.selectTab('files');
  assert.equal(nav.getActiveTab(), 'files');
  assert.equal(nav.getTopScreen()?.key, 'files');
  assert.equal(filesHost.hidden, false);
  assert.equal(chatsHost.hidden, true);

  nav.selectTab('chats');
  assert.equal(nav.getTopScreen()?.key, 'chat:a', 'returning to a tab shows where you left it');

  nav.selectTab('chats');
  assert.equal(nav.getTopScreen()?.key, 'chats');
  assert.ok(log.includes('dispose:chat:a'));
});

test('pushing the same screen twice keeps one copy', async () => {
  const nav = await import('../../src/mobile/nav.ts');
  const log: Log = [];
  const host = win.document.createElement('div') as unknown as HTMLElement;
  nav.registerTab('chats', host, await screen('chats', log));
  nav.pushScreen(await screen('chat:a', log));
  nav.pushScreen(await screen('chat:a', log));
  assert.equal(host.querySelectorAll('section').length, 2);
});

test('the back gesture pops the top screen; in-app back does not pop twice', async () => {
  const nav = await import('../../src/mobile/nav.ts');
  const log: Log = [];
  const host = win.document.createElement('div') as unknown as HTMLElement;
  nav.registerTab('issues', host, await screen('issues', log));
  nav.selectTab('issues');
  nav.pushScreen(await screen('issue:1', log));
  const priorState = win.history.state;
  nav.pushScreen(await screen('issue:2', log));

  win.dispatchEvent(new win.PopStateEvent('popstate', { state: priorState }));
  assert.equal(nav.getTopScreen()?.key, 'issue:1');

  // An in-app pop calls history.back(); the popstate it causes is swallowed.
  win.history.pushState({ minnowMobile: 2 }, '');
  nav.popScreen();
  assert.equal(nav.getTopScreen()?.key, 'issues');
  win.dispatchEvent(new win.PopStateEvent('popstate', { state: null }));
  assert.equal(nav.getTopScreen()?.key, 'issues');
});

test('phone sheets keep focus on the top layer and return it to the trigger', async () => {
  const { openSheet, closeMobileSheets } = await import('../../src/mobile/sheet.ts');
  const shell = document.createElement('div');
  shell.id = 'mobileShell';
  const stage = document.createElement('div');
  stage.className = 'm-stage';
  const trigger = document.createElement('button');
  stage.append(trigger);
  shell.append(stage);
  document.body.append(shell);
  document.documentElement.setAttribute('data-reduce-motion', '');
  try {
    trigger.focus();
    const drawer = openSheet(document.createElement('button'), { title: 'Minnow', placement: 'left' });
    await Promise.resolve();
    assert.equal(stage.inert, true);
    const drawerButton = drawer.body.querySelector('button')!;
    drawerButton.focus();
    const details = openSheet(document.createElement('button'), { title: 'Details' });
    await Promise.resolve();
    assert.equal(drawer.el.inert, true);
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(details.el.isConnected, false);
    assert.equal(drawer.el.isConnected, true);
    assert.equal(document.activeElement, drawerButton);
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(stage.inert, false);
    assert.equal(document.activeElement, trigger);
  } finally {
    closeMobileSheets();
    shell.remove();
    document.documentElement.removeAttribute('data-reduce-motion');
  }
});

test('touch scrolling in a phone sheet leaves the form open', async () => {
  const { openSheet } = await import('../../src/mobile/sheet.ts');
  const field = document.createElement('textarea');
  const sheet = openSheet(field, { title: 'New issue' });
  const panel = sheet.el.querySelector<HTMLElement>('.m-sheet__panel')!;
  const handle = sheet.el.querySelector('.m-sheet__handle')!;
  const swipe = (target: Element) => {
    target.dispatchEvent(Object.assign(new win.Event('touchstart', { bubbles: true }), { touches: [{ clientY: 20 }] }));
    target.dispatchEvent(Object.assign(new win.Event('touchmove', { bubbles: true }), { touches: [{ clientY: 160 }] }));
    target.dispatchEvent(new win.Event('touchend', { bubbles: true }));
  };
  document.documentElement.setAttribute('data-reduce-motion', '');
  try {
    swipe(sheet.body);
    assert.equal(sheet.el.isConnected, true);
    assert.equal(panel.style.transform, '');
    swipe(handle);
    assert.equal(sheet.el.isConnected, false);
  } finally {
    sheet.close();
    document.documentElement.removeAttribute('data-reduce-motion');
  }
});

test('changing workspaces retires file and issue screens, stale history and pending issue edits', async () => {
  const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  const { addIssue, findIssueById, parseIssuesState, setIssuesStateForTests } = await import('../../src/state/issues-store.ts');
  const { createFileViewerScreen } = await import('../../src/mobile/file-viewer.ts');
  const { mountMobileShell } = await import('../../src/mobile/shell.ts');
  const nav = await import('../../src/mobile/nav.ts');
  const switchTo = (path: string) => setWorkspaceFromServer({ path, label: path, isDefault: false });
  const click = (selector: string) => {
    const node = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(node, selector);
    node.click();
  };
  const drawerTab = (tab: 'chats' | 'issues' | 'files') => {
    click('.m-tab-host:not([hidden]) > .m-screen:not([hidden]) [aria-label="Open menu"]');
    click(`.m-sheet--drawer:not([inert]) button[data-tab="${tab}"]`);
  };

  win.localStorage.clear();
  switchTo('C:/projects/one');
  setIssuesStateForTests(parseIssuesState({ issues: [] }));
  try {
    const first = addIssue({ title: 'Original title', workspacePath: 'C:/projects/one' });
    const second = addIssue({ title: 'Second workspace', workspacePath: 'C:/projects/two' });
    mountMobileShell();
    nav.pushScreen(createFileViewerScreen('logo.png', { openDir() {} }), 'files');
    nav.selectTab('issues');
    click(`button[data-issue-id="${first.id}"]`);
    const staleHistory = win.history.state;
    const firstScreen = nav.getTopScreen()!;
    const staleComment = firstScreen.el.querySelector('form')!;
    staleComment.querySelector('textarea')!.value = 'From the old workspace';
    click('[aria-label="Edit title"]');
    const editForm = document.querySelector<HTMLFormElement>('.m-sheet .m-prompt')!;
    editForm.querySelector('input')!.value = 'Stale edit';
    nav.selectTab('chats');
    switchTo('c:/projects/ONE/');
    nav.selectTab('issues');
    assert.equal(nav.getTopScreen(), firstScreen, 'equivalent path keeps the open screen');

    // Resolve the pending editor, then publish the workspace change before its continuation runs.
    editForm.dispatchEvent(new Event('submit', { cancelable: true }));
    nav.selectTab('chats');
    switchTo('C:/projects/two');
    await Promise.resolve();
    assert.equal(nav.getActiveTab(), 'chats');
    drawerTab('issues');
    assert.equal(nav.getTopScreen()?.key, 'issues');
    assert.equal(document.querySelector(`[data-issue-id="${first.id}"]`), null);
    assert.ok(document.querySelector(`[data-issue-id="${second.id}"]`));
    staleComment.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(findIssueById(first.id)?.title, 'Original title');
    assert.equal(findIssueById(first.id)?.comments?.length ?? 0, 0);
    drawerTab('files');
    assert.equal(nav.getTopScreen()?.key, 'dir:.');
    assert.equal(document.querySelector('[data-screen="file:logo.png"]'), null);

    drawerTab('issues');
    click(`button[data-issue-id="${second.id}"]`);
    win.dispatchEvent(new win.PopStateEvent('popstate', { state: staleHistory }));
    assert.equal(nav.getTopScreen()?.key, `issue:${second.id}`, 'old history cannot pop a new detail');
    const form = nav.getTopScreen()!.el.querySelector('form')!;
    form.querySelector('textarea')!.value = 'Current workspace';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(findIssueById(second.id)?.comments?.[0]?.body, 'Current workspace');
  } finally {
    nav.resetWorkspaceScreens();
    setIssuesStateForTests(null);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test('board status reads in plain words', async () => {
  const { boardStatus, outcomeText } = await import('../../src/mobile/board-status.ts');
  const base = { stopReason: null, finished: false, finalTestFailed: false, attentionCount: 0 };
  assert.deepEqual(boardStatus({ ...base, status: 'running' }), { label: 'Running', tone: 'live' });
  assert.equal(boardStatus({ ...base, status: 'created' }).label, 'Not started');
  assert.equal(boardStatus({ ...base, status: 'stopped', stopReason: 'paused' }).label, 'Paused');
  assert.equal(boardStatus({ ...base, status: 'stopped', stopReason: 'quota' }).label, 'Out of usage');
  assert.equal(boardStatus({ ...base, status: 'stopped', finished: true }).label, 'Done');
  assert.equal(boardStatus({ ...base, status: 'stopped', finished: true, attentionCount: 2 }).label, 'Needs attention');
  assert.equal(boardStatus({ ...base, status: 'stopped', finished: true, finalTestFailed: true }).label, 'Final test failed');
  assert.equal(outcomeText('no_report'), 'No report');
  assert.equal(outcomeText('some_new_outcome'), 'some new outcome');
});

test('folder listings derive from the file index', async () => {
  const { listFromIndex, fuzzyScore } = await import('../../src/mobile/file-index.ts');
  const files = ['README.md', 'src/a.ts', 'src/lib/b.ts', 'src/lib/c.ts', 'docs/plans/x.md'];
  assert.deepEqual(listFromIndex(files, '.'), { dirs: ['docs', 'src'], files: ['README.md'] });
  assert.deepEqual(listFromIndex(files, 'src'), { dirs: ['lib'], files: ['a.ts'] });
  assert.deepEqual(listFromIndex(files, 'src/lib'), { dirs: [], files: ['b.ts', 'c.ts'] });

  assert.ok(fuzzyScore('src/widget.ts', 'wid') > fuzzyScore('docs/wide/notes.md', 'wid'), 'basename hits rank first');
  assert.ok(fuzzyScore('src/mobile/shell.ts', 'msh') >= 0, 'subsequences match');
  assert.equal(fuzzyScore('src/a.ts', 'zzz'), -1);
});

test('chat previews strip markdown and fall back to the summary preview', async () => {
  const { chatPreview } = await import('../../src/mobile/chat-preview.ts');
  const chat = (history: unknown[], extra: Record<string, unknown> = {}) =>
    ({ id: 'c', history, ...extra }) as unknown as import('../../src/types.ts').Chat;
  assert.equal(chatPreview(chat([{ role: 'assistant', content: '## Hello **world**' }])), 'Hello world');
  assert.equal(chatPreview(chat([{ role: 'user', content: 'Fix it' }])), 'You: Fix it');
  assert.equal(chatPreview(chat([], { historyLoaded: false, messageCount: 4 })), '4 messages');
  assert.equal(chatPreview(chat([], { historyLoaded: false, messageCount: 4 }), '`done` now'), 'done now');
});

test('phone Threads opens on Active and can browse and search Archive', async (t) => {
  const { createChatsScreen, listedMobileChats } = await import('../../src/mobile/chats.ts');
  const { defaultSessionState } = await import('../../src/config/defaults.ts');
  const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions.ts');
  const { resetWorkspaceStateForTests, setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  const workspace = '/threads-workspace';
  const active = { ...createEmptyChatObject('', workspace), id: 'active', name: 'Active thread', historyLoaded: false, messageCount: 1 };
  const archived = { ...createEmptyChatObject('', workspace), id: 'archived', name: 'Archived thread', archivedAt: 100 };
  const child = createEmptyChatObject('', workspace);
  child.name = 'Delegated task';
  child.agentConversation = {
    version: 1, childChatId: child.id, parentChatId: archived.id, rootChatId: archived.id,
    journalOwnerId: archived.id, initialRunId: 'child-task', origin: 'delegated', createdAt: 1,
    capabilities: { canSend: true, canStop: true, canChooseModel: true },
  };
  const otherWorkspace = { ...archived, id: 'elsewhere', workspacePath: '/different' };
  const boardChat = { ...archived, id: 'board', boardGroupId: 'board' };
  setWorkspaceFromServer({ path: workspace, label: 'Threads workspace', isDefault: false });
  setSessionStateForTests({ ...defaultSessionState(), activeId: active.id, chats: [active, archived, child, otherWorkspace, boardChat] });
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const opened: string[] = [];
  const screen = createChatsScreen({
    openChat: (id) => opened.push(id), newChat: async () => false,
    openMenu() {}, openModels() {}, openAlertsSettings() {},
  });
  try {
    const rows = () => [...screen.el.querySelectorAll<HTMLButtonElement>('[data-chat-id]')];
    const ids = () => rows().map(row => row.dataset.chatId).sort();
    const [activeButton, archiveButton] = screen.el.querySelectorAll<HTMLButtonElement>('.m-segment');
    assert.equal(activeButton.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(ids(), [active.id]);
    assert.deepEqual(listedMobileChats().map(chat => chat.id), [active.id], 'drawer uses active threads');

    archiveButton.click();
    assert.equal(archiveButton.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(ids(), [archived.id, child.id].sort());
    rows().find(row => row.dataset.chatId === archived.id)!.click();
    assert.deepEqual(opened, [archived.id]);

    screen.el.querySelector<HTMLButtonElement>('button[aria-label="Search threads"]')!.click();
    const search = screen.el.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'Active thread';
    search.dispatchEvent(new Event('input'));
    assert.deepEqual(ids(), []);
    assert.equal(screen.el.querySelector('.m-empty__title')?.textContent, 'No matching threads');
    activeButton.click();
    assert.deepEqual(ids(), [active.id]);
  } finally {
    screen.dispose?.();
    setSessionStateForTests(null);
    resetWorkspaceStateForTests();
  }
});

test('diffs fold long unchanged runs and keep line numbers right', async () => {
  const { renderDiff } = await import('../../src/mobile/diff.ts');
  const lines = [
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'unchanged' as const, text: `ctx ${i + 1}` })),
    { type: 'remove' as const, text: 'old' },
    { type: 'add' as const, text: 'new' },
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'unchanged' as const, text: `tail ${i + 1}` })),
  ];
  const node = renderDiff(lines);
  const folds = node.querySelectorAll('.m-diff__fold');
  assert.equal(folds.length, 2, 'leading and trailing context collapse');
  const added = node.querySelector('.m-diff__row--add .m-diff__num');
  assert.equal(added?.textContent, '11');
  const removed = node.querySelector('.m-diff__row--remove .m-diff__num');
  assert.equal(removed?.textContent, '11');

  (folds[0] as unknown as HTMLButtonElement).click();
  const numbers = [...node.querySelectorAll('.m-diff__row--unchanged .m-diff__num')].map((n) => n.textContent);
  assert.deepEqual(numbers.slice(0, 10), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
});
