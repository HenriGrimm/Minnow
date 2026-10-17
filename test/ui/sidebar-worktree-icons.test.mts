import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { renderSidebar } from '../../src/ui/sidebar.ts';
import { syncModeIconInDom } from '../../src/ui/mode-icons.ts';

let win: Window | undefined;
afterEach(() => {
  setLocalServerAvailableForTests(false);
  setSessionStateForTests(null);
  resetWorkspaceStateForTests();
  document.body.replaceChildren();
  win?.close();
});

test('local chats have no mode icon; worktree icons update in place and disappear on detach', async (t) => {
  win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = '<div id="chatList"></div>';
  const workspace = 'C:/workspace/sidebar-worktree-icons';
  setWorkspaceFromServer({ path: workspace, label: 'test', isDefault: false });
  const chat = createEmptyChatObject('m1', workspace);
  chat.name = 'Feature';
  chat.modeId = 'build';
  chat.workAgentId = 'builder';
  chat.history = [{ role: 'user', content: 'Build this' }];
  chat.historyLoaded = true;
  setSessionStateForTests({ ...defaultSessionState(), chats: [chat], activeId: chat.id });
  renderSidebar();
  const row = document.querySelector<HTMLElement>('.chat-item-row')!;
  assert.equal(row.querySelector('.chat-item-icon'), null);
  assert.equal(row.querySelector('.chat-item-agent-badge'), null);
  chat.worktreeRoot = workspace.toUpperCase().replaceAll('/', '\\');
  renderSidebar();
  assert.equal(row.querySelector('.chat-item-icon'), null, 'principal checkout is still local');
  chat.worktreeRoot = `${workspace}/feature`;
  setLocalServerAvailableForTests(true);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests++;
    assert.equal(JSON.parse(String(init?.body)).cwd, chat.worktreeRoot);
    return new Response(JSON.stringify({ ok: true, branch: 'actual-branch', trunk: 'main', merged: true, dirty: false }));
  });
  renderSidebar();
  const icon = row.querySelector<HTMLElement>('.chat-item-icon')!;
  assert.equal(icon.dataset.worktreeState, 'worktree');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(icon.dataset.worktreeState, 'merged');
  assert.match(icon.title, /actual-branch.*Merged into main/);
  assert.match(row.getAttribute('aria-label')!, /Merged into main/);
  syncModeIconInDom(chat.id, 'plan');
  assert.ok(icon.classList.contains('fi-rr-code-merge'), 'mode changes must preserve the merge icon');
  renderSidebar();
  assert.equal(document.querySelector('.chat-item-row'), row);
  assert.equal(row.querySelector('.chat-item-icon'), icon);
  assert.equal(requests, 1, 'frequent sidebar renders reuse the status request');
  delete chat.worktreeRoot;
  renderSidebar();
  assert.equal(row.querySelector('.chat-item-icon'), null);
  assert.doesNotMatch(row.getAttribute('aria-label')!, /Worktree/);
});

test('uncommitted work never shows a fully merged icon', async (t) => {
  win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = '<div id="chatList"></div>';
  const workspace = 'C:/workspace/sidebar-dirty-worktree';
  setWorkspaceFromServer({ path: workspace, label: 'test', isDefault: false });
  const chat = createEmptyChatObject('m1', workspace);
  chat.history = [{ role: 'user', content: 'hi' }];
  chat.worktreeRoot = `${workspace}/dirty`;
  setSessionStateForTests({ ...defaultSessionState(), chats: [chat], activeId: chat.id });
  setLocalServerAvailableForTests(true);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    ok: true, branch: 'feature', trunk: 'main', merged: true, dirty: true,
  })));
  renderSidebar();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const icon = document.querySelector<HTMLElement>('.chat-item-icon')!;
  assert.equal(icon.dataset.worktreeState, 'worktree');
  assert.match(icon.title, /Uncommitted changes/);
  assert.doesNotMatch(icon.title, /Merged into/);
});
