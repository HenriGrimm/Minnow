import { DEFAULT_MODEL_STORAGE_KEY } from '../../src/models/selection.ts';
/**
 * Background /git-setup launcher: one chat per workspace, no focus steal,
 * reuse, streaming guard, and the slash prompt.
 *
 * mock.module must run before the launcher loads messaging.ts.
 */

import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import type { Chat } from '../../src/types.ts';
import { setStreaming } from '../../src/app-state.ts';
import { endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';
import {
  createEmptyChatObject,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';

const WORKSPACE = '/workspace';
const PROMPT =
  '/git-setup Initialize git in this workspace (init, .gitignore, initial commit).';

type SendCall = {
  chatId: string;
  text: string;
  ownsGlobalStreaming?: boolean;
};

const sendCalls: SendCall[] = [];
const toastMessages: string[] = [];
let sendImpl: () => Promise<void> = async () => {};
let resolveHungSend: (() => void) | null = null;

mock.module('../../src/chat/messaging.ts', {
  namedExports: {
    sendProgrammaticChatText: async (
      chat: Chat,
      text: string,
      options?: { ownsGlobalStreaming?: boolean },
    ) => {
      sendCalls.push({
        chatId: chat.id,
        text,
        ownsGlobalStreaming: options?.ownsGlobalStreaming,
      });
      return sendImpl();
    },
  },
});

mock.module('../../src/ui/toast.ts', {
  namedExports: {
    showToast: (message: string) => {
      toastMessages.push(message);
    },
  },
});

mock.module('../../src/ui/composer-undo.ts', {
  namedExports: {
    invalidateComposerUndoGitCache: () => {},
    syncComposerUndoFromActiveChat: () => {},
  },
});

mock.module('../../src/ui/source-control-center.ts', {
  namedExports: {
    refreshSourceControlCenter: () => {},
  },
});

mock.module('../../src/ui/git-panel.ts', {
  namedExports: {
    refreshGitPanel: async () => {},
  },
});

const gitSetup = await import('../../src/chat/git-setup-background.ts');
const { renderGitNoRepositoryState } = await import('../../src/ui/git-no-repo-state.ts');

function ensureModelSelect(): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
  localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, 'm1');
  if (document.getElementById('modelSelect')) return;
  const sel = document.createElement('select');
  sel.id = 'modelSelect';
  const opt = document.createElement('option');
  opt.value = 'm1';
  opt.selected = true;
  sel.append(opt);
  document.body.append(sel);
}

function seedOpenChat() {
  ensureModelSelect();
  setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
  const open = createEmptyChatObject('model', WORKSPACE);
  open.id = 'chat-user-open';
  setSessionStateForTests({
    version: 2,
    activeId: open.id,
    sidebarCollapsed: false,
    chats: [open],
  });
  return open;
}

describe('git setup background chat', () => {
  afterEach(() => {
    sendCalls.length = 0;
    toastMessages.length = 0;
    resolveHungSend?.();
    resolveHungSend = null;
    sendImpl = async () => {};
    gitSetup.resetGitSetupBackgroundLaunchingForTests();
    setStreaming(false);
    resetWorkspaceStateForTests();
    setSessionStateForTests(null);
  });

  test('gitSetupBackgroundKey uses the normalized workspace path', () => {
    assert.equal(gitSetup.gitSetupBackgroundKey(WORKSPACE), 'git-setup:/workspace');
  });

  test('creates a background chat without taking activeId', async () => {
    const open = seedOpenChat();

    const result = await gitSetup.startGitSetupBackgroundChat(WORKSPACE);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const created = sessionState?.chats.find((c) => c.id === result.chatId);
    assert.ok(created);
    assert.notEqual(created.id, open.id);
    assert.equal(created.background, true);
    assert.equal(created.backgroundKey, 'git-setup:/workspace');
    assert.equal(created.name, 'Set up git');
    assert.equal(created.modeId, 'build');
    assert.equal(sessionState?.activeId, open.id);
  });

  test('reuses the same chat on a second click', async () => {
    seedOpenChat();
    sendImpl = () =>
      new Promise((resolve) => {
        resolveHungSend = resolve;
      });

    const first = await gitSetup.startGitSetupBackgroundChat(WORKSPACE);
    const second = await gitSetup.startGitSetupBackgroundChat(WORKSPACE);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(second.chatId, first.chatId);
    assert.equal(second.alreadyRunning, true);
    assert.equal(sendCalls.length, 1);
    assert.equal(
      sessionState?.chats.filter((c) => c.backgroundKey === 'git-setup:/workspace').length,
      1,
    );
  });

  test('does not send when the chat is already streaming', async () => {
    seedOpenChat();

    const first = await gitSetup.startGitSetupBackgroundChat(WORKSPACE);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    setStreaming(true, first.chatId);
    sendCalls.length = 0;
    toastMessages.length = 0;

    const second = await gitSetup.startGitSetupBackgroundChat(WORKSPACE);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.alreadyRunning, true);
    assert.equal(sendCalls.length, 0);
    assert.equal(toastMessages.includes('Git setup is already running'), true);

    endChatTurnSetup(first.chatId);
    setStreaming(false, first.chatId);
  });

  test('sends the /git-setup prompt without owning global streaming', async () => {
    seedOpenChat();

    const result = await gitSetup.startGitSetupBackgroundChat(WORKSPACE);
    assert.equal(result.ok, true);
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.text, PROMPT);
    assert.equal(sendCalls[0]?.ownsGlobalStreaming, false);
    assert.equal(toastMessages.includes('Setting up git in the background'), true);
  });

  test('default no-repo CTA does not write the composer', async () => {
    seedOpenChat();

    const input = document.createElement('textarea');
    input.id = 'msgInput';
    input.value = '';
    document.body.appendChild(input);

    const host = document.createElement('div');
    document.body.appendChild(host);
    renderGitNoRepositoryState(host);

    const btn = host.querySelector('.git-no-repo__btn') as HTMLButtonElement | null;
    assert.ok(btn);
    btn.click();
    for (let i = 0; i < 20 && sendCalls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }

    assert.equal(input.value, '');
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.text, PROMPT);
    assert.equal(sessionState?.activeId, 'chat-user-open');
  });
});
