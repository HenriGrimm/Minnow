/**
 * MIN-206 — follow-up chain panel in the transcript.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  hasFollowupChain,
  setFollowupChain,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { syncFollowupActiveHint } from '../../src/ui/followup-active-hint.ts';
import type { Chat, FollowupChainState } from '../../src/types.ts';

let win: Window | undefined;

/** Pass `null` for a chat with no armed chain. */
function setup(chain: Partial<FollowupChainState> | null = {}): Chat {
  win = new Window();
  installHappyDomGlobals(win);

  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);

  const chat = createEmptyChatObject('m1', 'C:/ws/min-206');
  chat.id = 'root';
  chat.historyLoaded = true;

  if (chain) {
    setFollowupChain(chat, {
      chainId: 'chain-1',
      total: 5,
      index: 2,
      remaining: 3,
      promptText: 'review the build',
      modeId: 'build',
      rootChatId: 'root',
      parentChatId: 'root',
      createdAt: 1,
      ...chain,
    });
  }

  setSessionStateForTests({
    ...defaultSessionState(),
    activeId: chat.id,
    chats: [chat],
  });
  return chat;
}

function panel(): HTMLElement | null {
  return document.querySelector('.followup-status');
}

afterEach(async () => {
  flushScheduledSessionSaveForTests();
  if (win) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    win.close();
    win = undefined;
  }
  setSessionStateForTests(null);
  document.body.innerHTML = '';
});

describe('follow-up chain panel', () => {
  test('shows progress and the pending task', () => {
    setup();

    syncFollowupActiveHint();

    const el = panel();
    assert.ok(el);
    assert.match(el.querySelector('.followup-status__runs')?.textContent ?? '', /2 of 5 started · 3 to go/);
    assert.match(el.querySelector('.followup-status__task')?.textContent ?? '', /Next task: review the build/);
  });

  test('says the task is agent-chosen when none is set', () => {
    setup({ promptText: '' });

    syncFollowupActiveHint();

    assert.match(
      panel()?.querySelector('.followup-status__task')?.textContent ?? '',
      /chosen by the agent/,
    );
  });

  test('stop clears the chain and removes the panel', () => {
    const chat = setup();
    syncFollowupActiveHint();

    const stop = document.querySelector<HTMLButtonElement>('.followup-status__stop');
    assert.ok(stop);
    assert.equal(stop.getAttribute('aria-label'), 'Stop follow-up chain');
    stop.click();

    assert.equal(hasFollowupChain(chat), false);
    assert.equal(panel(), null);
  });

  test('renders nothing for a chat with no chain', () => {
    setup(null);
    syncFollowupActiveHint();
    assert.equal(panel(), null);
  });
});
