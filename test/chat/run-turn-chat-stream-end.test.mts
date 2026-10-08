/**
 * P6-D: stream-end order on the runTurn path is setStreaming(false)
 * before notifyChatStreamEnded (PRD §1.3).
 */

import '../tools/install-dom-before-imports.mts';
import { createIssueChatActivity } from '../../src/ui/issues-chat-activity.ts';
import { getChatRunActivity } from '../../src/state/chat-run-activity.ts';
import type { IssueCard } from '../../src/types.ts';


import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { Chat } from '../../src/types.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';
import { getChatAbort, setChatAbort, setStreaming } from '../../src/app-state.ts';
import { DEFAULT_TITLES_CONFIG, setTitlesConfigForTests } from '../../src/config/titles-meta.ts';
import { notifyChatStreamEnded } from '../../src/chat/streaming-state.ts';
import { isChatStreaming } from '../../src/chat/streaming-state.ts';
import { buildAgentActivitySnapshot } from '../../src/state/agent-activity-registry.ts';
import { listMainTurnActivity } from '../../src/chat/main-turn-activity.ts';
import {
  maybeRunChatTurnViaRunner,
  resetRunTurnForTests,
  setRunTurnChatEndStreamingForTests,
  setRunTurnForTests,
} from '../../src/chat/run-turn-chat.ts';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';

function installChatDom(): void {
  document.body.replaceChildren();
  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);
  const sDot = document.createElement('span');
  sDot.id = 'sDot';
  document.body.appendChild(sDot);
  const sText = document.createElement('span');
  sText.id = 'sText';
  document.body.appendChild(sText);
  const msgInput = document.createElement('textarea');
  msgInput.id = 'msgInput';
  document.body.appendChild(msgInput);
  const sendBtn = document.createElement('button');
  sendBtn.id = 'sendBtn';
  sendBtn.type = 'button';
  sendBtn.innerHTML = `
    <span id="sendIcon"></span>
    <span id="sendStopIcon" class="hidden"></span>
    <span id="sendSpinner" class="hidden"></span>
  `;
  document.body.appendChild(sendBtn);
}

function makeChat(): Chat {
  const chat = createEmptyChatObject('m1');
  chat.id = CHAT_ID;
  chat.providerId = 'vite-fallback';
  chat.modelId = 'm1';
  return chat;
}

describe('P6-D stream-end order (MIN-726)', () => {
  afterEach(() => {
    setRunTurnChatEndStreamingForTests(null);
    resetRunTurnForTests();
    getChatAbort(CHAT_ID)?.abort();
    setChatAbort(CHAT_ID, null);
    setStreaming(false, CHAT_ID);
    endChatTurnSetup(CHAT_ID);
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
  });

  test('setStreaming(false) runs before notifyChatStreamEnded', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const order: string[] = [];
    setRunTurnChatEndStreamingForTests({
      setStreaming: (value, chatId) => {
        if (value === false) order.push('setStreaming(false)');
        setStreaming(value, chatId);
      },
      notifyChatStreamEnded: (chatId) => {
        order.push('notifyChatStreamEnded');
        notifyChatStreamEnded(chatId);
      },
    });
    setRunTurnForTests(async () => ({ outcome: 'no_report' }));

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    await maybeRunChatTurnViaRunner({
      chat,
      pushUser: true,
      rawText: 'Hi',
      userText: 'Hi',
      skillId: null,
      historyContent: 'Hi',
      validAttachments: [],
      ownsGlobalStreaming: true,
    });

    assert.deepEqual(order, ['setStreaming(false)', 'notifyChatStreamEnded']);
  });

  test('background turns still register per-chat streaming activity', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    let registeredDuringRun = false;
    setRunTurnForTests(async () => {
      registeredDuringRun = isChatStreaming(CHAT_ID);
      return { outcome: 'no_report' };
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const pending = maybeRunChatTurnViaRunner({
      chat,
      pushUser: true,
      rawText: 'Hi',
      userText: 'Hi',
      skillId: null,
      historyContent: 'Hi',
      validAttachments: [],
      ownsGlobalStreaming: false,
    });

    const issue = { chatIds: [CHAT_ID], status: 'in_progress' } as IssueCard;
    const badge = createIssueChatActivity(issue);
    document.body.append(badge);
    assert.equal(badge.textContent, 'Chat running');
    assert.equal(isChatStreaming(CHAT_ID), true);
    assert.ok(getChatAbort(CHAT_ID));
    await pending;
    assert.equal(registeredDuringRun, true);
    assert.equal(isChatStreaming(CHAT_ID), false);
    assert.equal(getChatRunActivity(CHAT_ID), 'completed');
    assert.equal(badge.textContent, 'Chat finished');
    assert.equal(issue.status, 'in_progress');
  });

  test('no_report restores idle composer and clears the main-turn activity fallback', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async () => ({ outcome: 'no_report' }));

    const chat = makeChat();
    chat.currentGenerationId = 'gen-stale-1111';
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    await maybeRunChatTurnViaRunner({
      chat,
      pushUser: true,
      rawText: 'Hi',
      userText: 'Hi',
      skillId: null,
      historyContent: 'Hi',
      validAttachments: [],
      ownsGlobalStreaming: true,
    });

    const input = document.getElementById('msgInput') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    assert.notEqual(input.placeholder, 'Steer the run, or queue a follow-up…');
    assert.equal(sendBtn.dataset.mode, 'send');
    assert.equal(chat.currentGenerationId, undefined);
    assert.equal(listMainTurnActivity().some((t) => t.chatId === chat.id), false);

    const rows = buildAgentActivitySnapshot({
      nowMs: 1_710_000_000_000,
      chats: [chat],
      mainTurns: listMainTurnActivity(),
      subAgents: [],
      titleJobs: [],
    });
    assert.equal(rows.some((r) => r.id === `main:${chat.id}`), false);
  });
});
