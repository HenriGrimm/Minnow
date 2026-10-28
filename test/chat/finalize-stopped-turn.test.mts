/**
 * P10-E (MIN-770) — Stop mid-reply persists the partial and records run status `stopped`.
 *
 * User Stop does not throw into `runChatTurn`'s catch. `runTurn` returns
 * `{ outcome: 'crashed', error: 'aborted' }`. Tests cover that path and a
 * thrown AbortError fallback.
 */

import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type {
  AssistantToolCallMessage,
  Chat,
  Message,
  ToolResultMessage,
} from '../../src/types.ts';
import type { RunTurnOptions } from '../../server/runner/run-turn.d.ts';
import type { TranscriptMessage } from '../../server/runner/transcript-store.d.ts';
import {
  chatForSessionsWire,
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  getSessionDirtyTrackingForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { findRunById } from '../../src/state/runs-store.ts';
import { endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';
import {
  getChatAbort,
  setChatAbort,
  setChatStopReason,
  setStreaming,
} from '../../src/app-state.ts';
import { DEFAULT_TITLES_CONFIG, setTitlesConfigForTests } from '../../src/config/titles-meta.ts';
import { resetRunTurnForTests, setRunTurnForTests } from '../../src/chat/run-turn-chat.ts';
import { markMessageStopped } from '../../src/ui/stopped-affordance.ts';
import { ChatOwnershipError } from '../../src/chat/turn-lease.ts';

const CHAT_ID = '33333333-3333-3333-3333-333333333333';

const SIMPLE_TURN = {
  pushUser: true as const,
  rawText: 'Write a haiku',
  userText: 'Write a haiku',
  skillId: null,
  displayText: 'Write a haiku',
  historyContent: 'Write a haiku',
  validAttachments: [] as [],
  ownsGlobalStreaming: true,
};

function setupDom(): void {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
}

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
}

function makeChat(): Chat {
  const chat = createEmptyChatObject('m1');
  chat.id = CHAT_ID;
  chat.providerId = 'vite-fallback';
  chat.modelId = 'm1';
  return chat;
}

function roundTripHistory(chat: Chat): Message[] {
  const wire = chatForSessionsWire(chat);
  return JSON.parse(JSON.stringify(wire.history ?? [])) as Message[];
}

const TOOL_CALL_ROW: TranscriptMessage = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
    },
  ],
} as TranscriptMessage;

/** What the runner has already persisted when Stop lands mid tool batch. */
function appendStoppedToolRound(options: RunTurnOptions): void {
  options.transcript?.append(options.chatId, TOOL_CALL_ROW);
  options.transcript?.append(options.chatId, {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'export const a = 1;',
  } as TranscriptMessage);
}

function toolCallRowOf(history: Message[]): AssistantToolCallMessage | undefined {
  return history.find(
    (m): m is AssistantToolCallMessage => m.role === 'assistant' && 'tool_calls' in m,
  );
}

describe('stopped assistant affordance', () => {
  test('markMessageStopped adds chip to assistant row', () => {
    setupDom();
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const label = document.createElement('div');
    label.className = 'msg-label';
    wrap.appendChild(label);

    markMessageStopped(wrap);

    assert.ok(wrap.classList.contains('msg--stopped'));
    assert.equal(wrap.querySelector('.msg-stopped-chip')?.textContent, 'Generation stopped');
  });
});

describe('P10-E runChatTurn stopped persist (MIN-770)', () => {
  afterEach(() => {
    resetRunTurnForTests();
    getChatAbort(CHAT_ID)?.abort();
    setChatAbort(CHAT_ID, null);
    setStreaming(false, CHAT_ID);
    endChatTurnSetup(CHAT_ID);
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
  });

  for (const kind of ['lost', 'unavailable'] as const) test(`ownership ${kind} persists a failed run and retains completed tools`, async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const controller = new AbortController();
    setRunTurnForTests(async options => {
      appendStoppedToolRound(options);
      options.onEvent?.({ type: 'delta', text: 'Work already done.' });
      controller.abort(new ChatOwnershipError(kind, CHAT_ID));
      return { outcome: 'crashed', error: 'aborted' };
    });
    const chat = makeChat();
    setSessionStateForTests({ version: 3, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN, turnLease: { signal: controller.signal, async check() {}, async release() {} } });
    const run = chat.runs?.find(row => row.status === 'failed');
    assert.ok(run);
    assert.equal(run.stopReason, undefined);
    assert.match(run.errorMessage ?? '', kind === 'lost' ? /no longer owns/ : /Could not confirm chat ownership/);
    assert.equal(chat.history.some(row => row.role === 'tool' && row.tool_call_id === 'call_1'), true);
    assert.equal(chat.history.some(row => row.role === 'assistant' && row.stopped), false);
    assert.equal(roundTripHistory(chat).some(row => row.role === 'tool'), true);
  });

  test('returned aborted outcome persists stopped partial that survives wire reload', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'thinking', text: 'Counting syllables.' });
      options.onEvent?.({ type: 'delta', text: 'Soft rain on the roof' });
      return { outcome: 'crashed', error: 'aborted' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    const assistant = chat.history.find((m) => m.role === 'assistant') as Extract<
      Message,
      { role: 'assistant' }
    >;
    assert.ok(assistant);
    assert.equal(assistant.stopped, true);
    assert.equal(assistant.content, 'Soft rain on the roof');
    assert.deepEqual(assistant.thinking, ['Counting syllables.']);
    assert.equal(
      chat.history.some((m) => m.role === 'assistant' && 'failed' in m && m.failed),
      false,
    );
    assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(CHAT_ID));

    const revived = roundTripHistory(chat);
    const revivedAssistant = revived.find((m) => m.role === 'assistant') as Extract<
      Message,
      { role: 'assistant' }
    >;
    assert.equal(revivedAssistant?.stopped, true);
    assert.equal(revivedAssistant?.content, 'Soft rain on the roof');

    const run = chat.runs?.find((r) => r.status === 'stopped' || r.status === 'failed' || r.status === 'completed');
    const recorded = run ? findRunById(chat, run.runId) : undefined;
    assert.equal(recorded?.status, 'stopped');
    assert.equal(recorded?.stopReason, 'user');
  });

  test('thrown AbortError also persists a stopped row', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'Halfway thr' });
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    const assistant = chat.history.find((m) => m.role === 'assistant') as Extract<
      Message,
      { role: 'assistant' }
    >;
    assert.equal(assistant?.stopped, true);
    assert.equal(assistant?.content, 'Halfway thr');
    const run = chat.runs?.find((r) => r.status === 'stopped');
    assert.equal(run?.status, 'stopped');
    assert.equal(run?.stopReason, 'user');
  });

  test('Stop with nothing streamed does not mint an empty assistant', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async () => ({ outcome: 'crashed', error: 'aborted' }));
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0]?.role, 'user');
    const run = chat.runs?.find((r) => r.status === 'stopped');
    assert.equal(run?.status, 'stopped');
  });

  test('Stop mid tool batch flags the tool-call row instead of minting a partial', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      appendStoppedToolRound(options);
      return { outcome: 'crashed', error: 'aborted' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    assert.deepEqual(
      chat.history.map((m) => m.role),
      ['user', 'assistant', 'tool'],
    );
    assert.equal(toolCallRowOf(chat.history)?.stopped, true);
    assert.equal(toolCallRowOf(roundTripHistory(chat))?.stopped, true);
    assert.equal(
      document.querySelector('.msg--stopped .msg-stopped-chip')?.textContent,
      'Generation stopped',
      'the live transcript shows the stop, not just the reload',
    );
  });

  // The Stop above leaves a paired tool tail. Sending the next message used to slice
  // history back to the last user row, so the model lost the entire stopped turn.
  test('next user send keeps the stopped turn instead of wiping it', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      appendStoppedToolRound(options);
      return { outcome: 'crashed', error: 'aborted' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    setRunTurnForTests(async () => ({ outcome: 'crashed', error: 'aborted' }));
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
      rawText: 'carry on',
      userText: 'carry on',
      displayText: 'carry on',
      historyContent: 'carry on',
    });

    assert.deepEqual(
      chat.history.map((m) => m.role),
      ['user', 'assistant', 'tool', 'user'],
    );
    assert.equal((chat.history[2] as ToolResultMessage).content, 'export const a = 1;');
  });

  test('next user send still drops an unpaired tool-call tail', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      options.transcript?.append(options.chatId, TOOL_CALL_ROW);
      return { outcome: 'crashed', error: 'aborted' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    setRunTurnForTests(async () => ({ outcome: 'crashed', error: 'aborted' }));
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
      rawText: 'carry on',
      userText: 'carry on',
      displayText: 'carry on',
      historyContent: 'carry on',
    });

    assert.deepEqual(
      chat.history.map((m) => m.role),
      ['user', 'user'],
    );
  });

  test('system Stop keeps currentGenerationId for boot resume', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'Still going' });
      return { outcome: 'crashed', error: 'aborted' };
    });
    const chat = makeChat();
    chat.currentGenerationId = 'gen-keep';
    setChatStopReason(CHAT_ID, 'system');
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    assert.equal(chat.currentGenerationId, 'gen-keep');
    const run = chat.runs?.find((r) => r.status === 'stopped');
    assert.equal(run?.stopReason, 'system');
  });

  test('captured timeout stopReason lands on the run record', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setChatStopReason(CHAT_ID, 'timeout');
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'tick' });
      return { outcome: 'crashed', error: 'aborted' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });

    const run = chat.runs?.find((r) => r.status === 'stopped');
    assert.equal(run?.status, 'stopped');
    assert.equal(run?.stopReason, 'timeout');
  });
});
