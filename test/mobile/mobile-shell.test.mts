/**
 * Phone app (src/mobile/): boot decision, tab/stack navigation with the back
 * gesture, and the pure helpers behind the board, file and chat lists.
 */

import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { Window } from 'happy-dom';

let win: Window;

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
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  });
  setMatchMedia(false);
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
  nav.pushScreen(await screen('issue:2', log));

  win.dispatchEvent(new win.PopStateEvent('popstate', { state: null }));
  assert.equal(nav.getTopScreen()?.key, 'issue:1');

  // An in-app pop calls history.back(); the popstate it causes is swallowed.
  win.history.pushState({ minnowMobile: 2 }, '');
  nav.popScreen();
  assert.equal(nav.getTopScreen()?.key, 'issues');
  win.dispatchEvent(new win.PopStateEvent('popstate', { state: null }));
  assert.equal(nav.getTopScreen()?.key, 'issues');
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
