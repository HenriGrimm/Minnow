import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  installHappyDomGlobals,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';
import { setStreaming } from '../../src/app-state.ts';
import { notifyChatStreamEnded } from '../../src/chat/streaming-state.ts';
import { initModeSelector, disposeModeSelectorForTests } from '../../src/ui/mode-selector.ts';
import {
  enqueuePendingMode,
  flushPendingMode,
  clearPendingMode,
} from '../../src/chat/pending-mode.ts';
import { executeSetChatMode } from '../../src/tools/mode-handoff-tools.ts';
import {
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
  createEmptyChatObject,
} from '../../src/state/sessions.ts';

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';

/** happy-dom window for DOM-touching mode handoff paths. */
let win: Window | undefined;

function seedChat(modeId: 'plan' | 'build' = 'plan') {
  const chat = createEmptyChatObject('m1');
  chat.id = FIXED_CHAT_ID;
  chat.modeId = modeId;
  setSessionStateForTests({
    version: 3,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return chat;
}

describe('pending-mode (MIN-191)', () => {
  beforeEach(() => {
    win = new Window();
    installHappyDomGlobals(win);
    setStreaming(false);
  });

  afterEach(async () => {
    disposeModeSelectorForTests();
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
    setStreaming(false);
    if (win) {
      await teardownHappyDomAsync(win);
      win = undefined;
    }
  });

  test('executeSetChatMode switches immediately when streaming', () => {
    const chat = seedChat('plan');
    setStreaming(true, chat.id);

    const raw = executeSetChatMode({ mode_id: 'build' });
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      deferred?: boolean;
      modeId: string;
    };

    assert.equal(parsed.ok, true);
    assert.equal(parsed.deferred, undefined);
    assert.equal(parsed.modeId, 'build');
    assert.equal(chat.pendingModeId, undefined);
    assert.equal(chat.modeId, 'build');
  });

  test('flushPendingMode applies mode after stream ends', () => {
    const chat = seedChat('plan');
    enqueuePendingMode(chat, 'build');
    setStreaming(true, chat.id);
    assert.equal(flushPendingMode(chat), null);

    setStreaming(false, chat.id);
    const result = flushPendingMode(chat);
    assert.ok(result?.ok);
    assert.equal(chat.modeId, 'build');
    assert.equal(chat.pendingModeId, undefined);
  });

  test('clearPendingMode drops queued mode', () => {
    const chat = seedChat();
    enqueuePendingMode(chat, 'build');
    clearPendingMode(chat);
    assert.equal(chat.pendingModeId, undefined);
  });

  test('the tool updates both composer selectors before streaming ends', async () => {
    const chat = seedChat('plan');
    document.body.innerHTML = '<div><div id="modeSelector"></div></div>';
    initModeSelector();
    setStreaming(true, chat.id);
    executeSetChatMode({ mode_id: 'build' });
    assert.equal(chat.modeId, 'build');
    assert.equal(chat.pendingModeId, undefined);
    assert.equal(document.querySelector('#modeSelector [data-mode-id="build"]')?.getAttribute('aria-checked'), 'true');
    assert.equal(document.querySelector('.mode-selector-dropdown__label')?.textContent, 'Build');
  });

  test('a background handoff changes only its originating chat', async () => {
    const chat = seedChat('plan');
    setStreaming(true, chat.id);
    const other = createEmptyChatObject('m1');
    other.modeId = 'general';
    setSessionStateForTests({ version: 3, activeId: other.id, sidebarCollapsed: false, chats: [chat, other] });
    setStreaming(true, other.id);
    executeSetChatMode({ mode_id: 'build' }, chat.id);
    assert.equal(chat.modeId, 'build');
    assert.equal(other.modeId, 'general');
    setStreaming(false, chat.id);
    notifyChatStreamEnded(chat.id);
    await Promise.resolve();
    assert.equal(chat.modeId, 'build');
    assert.equal(other.modeId, 'general');
  });

  test('executeSetChatMode no-op when already on target mode', () => {
    const chat = seedChat('build');
    setStreaming(true, chat.id);

    const raw = executeSetChatMode({ mode_id: 'build' });
    const parsed = JSON.parse(raw) as { ok: boolean; deferred?: boolean };

    assert.equal(parsed.ok, true);
    assert.equal(parsed.deferred, undefined);
    assert.equal(chat.pendingModeId, undefined);
  });
});
