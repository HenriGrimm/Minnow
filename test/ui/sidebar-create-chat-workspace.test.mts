/**
 * MIN-206 — createChatWithMode can bind a new chat to an explicit workspace.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  installHappyDomGlobals,
  setupMinimalComposerDom,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  createEmptyChatObject,
  findChatById,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';
import { createChatWithMode } from '../../src/ui/sidebar.ts';
import type { Chat } from '../../src/types.ts';

/** Chat records store workspace paths normalized to forward slashes. */
const WS_A = 'C:/ws/min-206-a';
const WS_B = 'C:/ws/min-206-b';

let win: Window | undefined;
const originalFetch = globalThis.fetch;

function setup(): void {
  win = new Window();
  installHappyDomGlobals(win, { fetch: async () => new Response('{}', { status: 200 }) });
  setupMinimalComposerDom(document);
}

function seedActiveChat(workspacePath: string): Chat {
  const chat = createEmptyChatObject('m1', workspacePath);
  chat.history = [{ role: 'user', content: 'hello' }];
  chat.historyLoaded = true;
  setSessionStateForTests({
    ...defaultSessionState(),
    activeId: chat.id,
    chats: [chat],
  });
  return chat;
}

function workspaceInfo(path: string) {
  return { path, label: path, isDefault: false, exists: true, isCurrent: true };
}

afterEach(async () => {
  flushScheduledSessionSaveForTests();
  // Chat creation kicks off deferred composer imports that read the active chat;
  // let them settle before the session state goes away.
  if (win) {
    await teardownHappyDomAsync(win);
    win = undefined;
  }
  setSessionStateForTests(null);
  resetWorkspaceStateForTests();
  globalThis.fetch = originalFetch;
  document.body.innerHTML = '';
});

describe('createChatWithMode workspace option', () => {
  test('pins a recovery chat to the captured checkout before its first turn', async () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    seedActiveChat(WS_A);
    const result = await createChatWithMode({ modeId: 'build', workspacePath: WS_A,
      gitRecoveryTarget: { cwd: `${WS_A}/.worktrees/conflict`, branch: 'feature' } });
    assert.equal(result.ok, true);
    const created = findChatById(result.chatId!)!;
    const { resolveChatToolWorkspaceRoot } = await import('../../src/state/chat-worktree.ts');
    assert.equal(resolveChatToolWorkspaceRoot(created), `${WS_A}/.worktrees/conflict`);
    assert.equal(created.gitBranch, 'feature');
    assert.equal(created.worktreeSetupRequired, undefined);
    assert.equal(created.chatWorktreeManaged, false);
  });
  test('binds an explicit workspace and skips ephemeral reuse', async () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    const active = seedActiveChat(WS_A);
    const { setGitPanelCwd } = await import('../../src/ui/git-panel.ts');
    setGitPanelCwd(`${WS_A}/.worktrees/review`);

    const result = await createChatWithMode({ modeId: 'build', workspacePath: WS_B });

    assert.equal(result.ok, true);
    assert.notEqual(result.chatId, active.id);
    const created = result.chatId ? findChatById(result.chatId) : null;
    assert.ok(created);
    assert.equal(created.workspacePath, WS_B);
    assert.equal(created.worktreeRoot, undefined);
  });

  test('New Thread starts Local and retains a previously configured empty checkout', async () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    const active = seedActiveChat(WS_A);
    active.history = [];
    active.worktreeRoot = `${WS_A}/.worktrees/existing`;
    const { setGitPanelCwd } = await import('../../src/ui/git-panel.ts');
    setGitPanelCwd(`${WS_A}/.worktrees/review`);

    const result = await createChatWithMode({ modeId: 'build' });

    assert.equal(result.ok, true);
    assert.notEqual(result.chatId, active.id);
    const created = findChatById(result.chatId!)!;
    assert.equal(created.workspacePath, WS_A);
    assert.equal(created.worktreeRoot, undefined);
    assert.equal(findChatById(active.id)?.worktreeRoot, active.worktreeRoot);
  });

  test('an explicit checkout action starts a thread in that checkout', async () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    seedActiveChat(WS_A);
    const cwd = `${WS_A}/.worktrees/review`;
    const target = { cwd, branch: 'review/file-browser' };
    const foreign = await createChatWithMode({ modeId: 'build', workspacePath: WS_B, checkoutTarget: target });
    assert.equal(foreign.ok, false);

    const result = await createChatWithMode({ modeId: 'build', workspacePath: WS_A, checkoutTarget: target });
    assert.equal(result.ok, true);
    const created = findChatById(result.chatId!)!;
    assert.equal(created.workspacePath, WS_A);
    assert.equal(created.worktreeRoot, cwd);
    assert.equal(created.gitBranch, target.branch);
  });

  test('keeps the current workspace when no option is passed', async () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    seedActiveChat(WS_A);

    const result = await createChatWithMode({ modeId: 'plan' });

    assert.equal(result.ok, true);
    const created = result.chatId ? findChatById(result.chatId) : null;
    assert.ok(created);
    assert.equal(created.workspacePath, WS_A);
    assert.equal(created.modeId, 'build');
    assert.equal(created.pinnedSkill?.id, 'plan');
  });

  test('a follow-up always creates a chat with the source model binding', async () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    const active = createEmptyChatObject('current-model', WS_A);
    active.historyLoaded = true;
    setSessionStateForTests({
      ...defaultSessionState(),
      activeId: active.id,
      chats: [active],
    });

    const result = await createChatWithMode({
      modeId: 'build',
      forceNewChat: true,
      modelId: 'source-model',
      providerId: 'source-provider',
    });

    assert.equal(result.ok, true);
    assert.notEqual(result.chatId, active.id);
    const created = result.chatId ? findChatById(result.chatId) : null;
    assert.ok(created);
    assert.equal(created.modelId, 'source-model');
    assert.equal(created.providerId, 'source-provider');
  });
});
