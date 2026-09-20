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
  test('binds an explicit workspace and skips ephemeral reuse', () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    const active = seedActiveChat(WS_A);

    const result = createChatWithMode({ modeId: 'build', workspacePath: WS_B });

    assert.equal(result.ok, true);
    assert.notEqual(result.chatId, active.id);
    const created = result.chatId ? findChatById(result.chatId) : null;
    assert.ok(created);
    assert.equal(created.workspacePath, WS_B);
  });

  test('keeps the current workspace when no option is passed', () => {
    setup();
    setWorkspaceFromServer(workspaceInfo(WS_A));
    seedActiveChat(WS_A);

    const result = createChatWithMode({ modeId: 'plan' });

    assert.equal(result.ok, true);
    const created = result.chatId ? findChatById(result.chatId) : null;
    assert.ok(created);
    assert.equal(created.workspacePath, WS_A);
    assert.equal(created.modeId, 'plan');
  });
});
