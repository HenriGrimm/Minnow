/**
 * P10-E (MIN-770) — a failed turn keeps what it already streamed.
 *
 * Integration tests drive `runChatTurn` (the product caller). Helper tests
 * keep `resolveFailedTurnPartialRow` honest so the persist path cannot drift.
 */

import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { GenerationNotFoundError, GENERATION_LOST_ON_RESTART_MESSAGE } from '../../src/api/generations.ts';
import type { Chat, Message } from '../../src/types.ts';
import {
  chatForSessionsWire,
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  getSessionDirtyTrackingForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';
import { getChatAbort, setChatAbort, setStreaming } from '../../src/app-state.ts';
import { DEFAULT_TITLES_CONFIG, setTitlesConfigForTests } from '../../src/config/titles-meta.ts';
import { resetRunTurnForTests, setRunTurnForTests } from '../../src/chat/run-turn-chat.ts';
import { persistFailedTurnPartial } from '../../src/chat/settle-interrupted-turn.ts';
import { resolveFailedTurnPartialRow } from '../../src/tools/turn-continuation.ts';
import { markMessageFailed } from '../../src/ui/stopped-affordance.ts';
import { appendFailedTurnRecoveryActions } from '../../src/ui/failed-turn-recovery-actions.ts';

const CHAT_ID = '22222222-2222-2222-2222-222222222222';

const SIMPLE_TURN = {
  pushUser: true as const,
  rawText: 'What time is it?',
  userText: 'What time is it?',
  skillId: null,
  displayText: 'What time is it?',
  historyContent: 'What time is it?',
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

/** Simulate a session PATCH/reload: history must survive JSON + wire serialization. */
function roundTripHistory(chat: Chat): Message[] {
  const wire = chatForSessionsWire(chat);
  return JSON.parse(JSON.stringify(wire.history ?? [])) as Message[];
}

// ── resolveFailedTurnPartialRow ──────────────────────────────────────────────

describe('resolveFailedTurnPartialRow', () => {
  test('keeps partial prose and reasoning on a failed row', () => {
    const row = resolveFailedTurnPartialRow({
      partialText: 'Here is what I found so f',
      thinking: ['Checking the config first.', '  '],
    });
    assert.deepEqual(row, {
      role: 'assistant',
      content: 'Here is what I found so f',
      failed: true,
      thinking: ['Checking the config first.'],
    });
  });

  test('falls back to reasoning when no prose was streamed', () => {
    const row = resolveFailedTurnPartialRow({
      partialText: '   ',
      thinking: ['First thought', 'Second thought'],
    });
    assert.equal(row?.failed, true);
    assert.equal(row?.content, 'First thought\n\nSecond thought');
  });

  test('stores nothing when the turn produced no output', () => {
    assert.equal(
      resolveFailedTurnPartialRow({ partialText: '  ', thinking: [] }),
      null,
    );
    assert.equal(resolveFailedTurnPartialRow({ partialText: '', thinking: ['']}), null);
  });

  test('stores nothing when the only partial output was tool-call markup', () => {
    const row = resolveFailedTurnPartialRow({
      partialText: '<tool_call>{"name":"read_file","arguments":{}}</tool_call>',
      thinking: [],
    });
    assert.equal(row, null);
  });

  test('keeps prose that accompanied a tool call', () => {
    const row = resolveFailedTurnPartialRow({
      partialText: 'Let me look at the file.\n<tool_call>{"name":"read_file","arguments":{}}</tool_call>',
      thinking: [],
    });
    assert.equal(row?.content, 'Let me look at the file.');
    assert.equal(row?.failed, true);
  });
});

// ── persistFailedTurnPartial ─────────────────────────────────────────────────

describe('persistFailedTurnPartial', () => {
  test('appends a failed assistant row onto the chat', () => {
    const chat = makeChat();
    chat.history = [{ role: 'user', content: 'hi' }];
    const ok = persistFailedTurnPartial({
      chat,
      skip: false,
      partialText: 'Partial ans',
      thinking: ['Drafting'],
    });
    assert.equal(ok, true);
    const last = chat.history[chat.history.length - 1];
    assert.equal(last?.role, 'assistant');
    assert.equal((last as { failed?: true }).failed, true);
    assert.equal((last as { content: string }).content, 'Partial ans');
    flushScheduledSessionSaveForTests();
  });

  test('skips GENERATION_LOST_ON_RESTART so triage cannot invent a partial', () => {
    const chat = makeChat();
    chat.history = [{ role: 'user', content: 'hi' }];
    const ok = persistFailedTurnPartial({
      chat,
      skip: true,
      partialText: 'should not land',
      thinking: [],
    });
    assert.equal(ok, false);
    assert.equal(chat.history.length, 1);
  });
});

// ── failed assistant affordance ──────────────────────────────────────────────

describe('failed assistant affordance', () => {
  test('markMessageFailed adds chip to assistant row', () => {
    setupDom();
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const label = document.createElement('div');
    label.className = 'msg-label';
    wrap.appendChild(label);

    markMessageFailed(wrap);

    assert.ok(wrap.classList.contains('msg--failed'));
    assert.equal(
      wrap.querySelector('.msg-failed-chip')?.textContent,
      'Partial reply — turn failed',
    );
  });

  test('markMessageFailed is idempotent across a re-render', () => {
    setupDom();
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';

    markMessageFailed(wrap);
    markMessageFailed(wrap);

    assert.equal(wrap.querySelectorAll('.msg-failed-chip').length, 1);
  });

  test('markMessageFailed with recovery exposes Continue and Clear', () => {
    setupDom();
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const label = document.createElement('div');
    label.className = 'msg-label';
    wrap.appendChild(label);

    markMessageFailed(wrap, { chatId: 'chat_1', forkHistoryIndex: 2 });

    const buttons = [...wrap.querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['Continue', 'Clear']);
    assert.equal(wrap.querySelectorAll('.msg-error-recover-actions').length, 1);
  });
});

// ── failed-turn recovery chrome ──────────────────────────────────────────────

describe('failed-turn recovery chrome', () => {
  test('error bubble offers Continue and Clear instead of rewind-and-retry', async () => {
    setupDom();
    const { setAssistantErrorBubbleWithRecovery } = await import('../../src/ui/messages.ts');
    const bubble = document.createElement('div');
    setAssistantErrorBubbleWithRecovery(bubble, 'Could not complete this reply: network error', {
      chatId: 'chat_1',
      forkHistoryIndex: 2,
    });

    const labels = [...bubble.querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(labels, ['Continue', 'Clear']);
    assert.equal(bubble.textContent?.includes('Clear last failed turn'), false);
    assert.match(bubble.textContent ?? '', /network error/);
  });

  test('appendFailedTurnRecoveryActions is idempotent', () => {
    setupDom();
    const host = document.createElement('div');
    const recovery = { chatId: 'chat_1', forkHistoryIndex: 0 };
    appendFailedTurnRecoveryActions(host, recovery);
    appendFailedTurnRecoveryActions(host, recovery);
    assert.equal(host.querySelectorAll('.msg-error-recover-actions').length, 1);
  });
});

// ── P10-E runChatTurn ────────────────────────────────────────────────────────

describe('P10-E runChatTurn failed-turn persist (MIN-770)', () => {
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

  test('provider error mid-reply persists failed partial that survives wire reload', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'thinking', text: 'Drafting the comparison.' });
      options.onEvent?.({ type: 'delta', text: 'Here is what I fou' });
      return { outcome: 'crashed', error: 'upstream http 500' };
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
    assert.ok(assistant, 'failed turn must keep the streamed partial');
    assert.equal(assistant.failed, true);
    assert.equal(assistant.content, 'Here is what I fou');
    assert.deepEqual(assistant.thinking, ['Drafting the comparison.']);
    assert.equal(chat.history[0]?.role, 'user');
    assert.ok(
      document.querySelector('.msg-bubble--error'),
      'error notice must sit below the partial',
    );
    assert.ok(
      getSessionDirtyTrackingForTests().dirtyChatIds.includes(CHAT_ID),
      'touchChat must mark the chat dirty so a leave/reload PATCH keeps the row',
    );

    const revived = roundTripHistory(chat);
    const revivedAssistant = revived.find((m) => m.role === 'assistant') as Extract<
      Message,
      { role: 'assistant' }
    >;
    assert.equal(revivedAssistant?.failed, true);
    assert.equal(revivedAssistant?.content, 'Here is what I fou');
    assert.deepEqual(revivedAssistant?.thinking, ['Drafting the comparison.']);
  });

  test('thrown provider error mid-reply takes the same persist path', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'Almost done wi' });
      throw new Error('ECONNREFUSED 127.0.0.1:1234');
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
    assert.equal(assistant?.failed, true);
    assert.equal(assistant?.content, 'Almost done wi');
  });

  test('Continue dismisses the old failure before inference and preserves the full transcript', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const chat = makeChat();
    chat.history = [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ];
    setSessionStateForTests({ version: 3, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'Partial answer' });
      return { outcome: 'crashed', error: 'Agent CLI attempted a native tool (browser_eval).' };
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });
    assert.ok(document.querySelector('.msg-bubble--error'));
    assert.ok(document.querySelector('.msg-failed-chip'));
    const before = chat.history.map((row) => ({ ...row }));

    let continued = false;
    setRunTurnForTests(async () => {
      continued = true;
      assert.equal(document.querySelector('.msg-bubble--error'), null);
      assert.equal(document.querySelector('.msg-failed-chip'), null);
      assert.equal(document.querySelector('.msg-error-recover-actions'), null);
      assert.deepEqual(chat.history, before.map((row) => {
        if (row.role !== 'assistant') return row;
        const { failed: _failed, ...rest } = row;
        return rest;
      }));
      assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(CHAT_ID));
      return { outcome: 'no_report' };
    });
    const { continueFailedTurn } = await import('../../src/chat/failed-turn-recovery.ts');
    await continueFailedTurn(chat.id);
    assert.equal(continued, true);
    assert.equal(document.querySelector('.msg-bubble--error'), null);
    assert.equal(roundTripHistory(chat).some((row) => row.role === 'assistant' && row.failed), false);
    assert.equal(chat.runs?.some((run) => run.errorMessage?.includes('browser_eval')), true);
  });

  test('a second failed Continue shows only the new failure', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const chat = makeChat();
    setSessionStateForTests({ version: 3, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'Partial answer' });
      return { outcome: 'crashed', error: 'First failure' };
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({ chat, ...SIMPLE_TURN });
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'More partial work' });
      return { outcome: 'crashed', error: 'Second failure' };
    });
    const { continueFailedTurn } = await import('../../src/chat/failed-turn-recovery.ts');
    await continueFailedTurn(chat.id);
    const errors = document.querySelectorAll('.msg-bubble--error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.textContent ?? '', /Second failure/);
    assert.equal(document.querySelectorAll('.msg-failed-chip').length, 1);
    assert.equal(chat.history.some((row) => row.role === 'assistant' && row.content === 'Partial answer'), true);
  });

  test('Continue while busy leaves the failure available for recovery', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const chat = makeChat();
    chat.history = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'partial', failed: true },
    ];
    setSessionStateForTests({ version: 3, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
    const { renderChatFromHistory } = await import('../../src/ui/messages.ts');
    renderChatFromHistory(chat);
    setStreaming(true, chat.id);
    const { continueFailedTurn } = await import('../../src/chat/failed-turn-recovery.ts');
    await continueFailedTurn(chat.id);
    assert.ok(document.querySelector('.msg-failed-chip'));
    assert.equal((chat.history.at(-1) as Extract<Message, { role: 'assistant' }>).failed, true);
  });

  test('turn that produced nothing rolls back to the user row', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async () => {
      throw new Error('ECONNREFUSED');
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

    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0]?.role, 'user');
    assert.equal(
      chat.history.some((m) => m.role === 'assistant'),
      false,
      'no stray empty assistant',
    );
  });

  test('server-killed generation leaves transcript and drops only an orphan tool tail', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async () => {
      return { outcome: 'crashed', error: 'Generation not found' };
    });
    const chat = makeChat();
    chat.history = [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: 'I already listed the files.',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_orphan',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"x"}' },
          },
        ],
      },
    ];
    chat.currentGenerationId = 'gen-dead';
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      pushUser: false,
      rawText: '',
      userText: '',
      skillId: null,
      historyContent: '',
      validAttachments: [],
      resumeGenerationId: 'gen-dead',
      ownsGlobalStreaming: false,
    });

    assert.equal(chat.history[0]?.role, 'user');
    assert.equal(chat.history[1]?.role, 'assistant');
    assert.equal(
      (chat.history[1] as { content: string }).content,
      'I already listed the files.',
    );
    assert.equal(
      chat.history.some(
        (m) => m.role === 'assistant' && 'tool_calls' in m && Array.isArray(m.tool_calls),
      ),
      false,
      'orphan tool_calls tail must be dropped',
    );
    assert.equal(
      chat.history.some((m) => m.role === 'assistant' && 'failed' in m && m.failed),
      false,
      'generation-lost must not mint a fake partial',
    );
  });

  test('thrown GenerationNotFoundError uses the same leave-transcript path', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async () => {
      throw new GenerationNotFoundError();
    });
    const chat = makeChat();
    chat.history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'already here' },
    ];
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      pushUser: false,
      rawText: '',
      userText: '',
      skillId: null,
      historyContent: '',
      validAttachments: [],
      ownsGlobalStreaming: true,
    });

    assert.equal(chat.history.length, 2);
    assert.equal((chat.history[1] as { content: string }).content, 'already here');
    assert.equal(document.getElementById('sText')?.textContent?.includes('lost') ||
      document.getElementById('sText')?.textContent === GENERATION_LOST_ON_RESTART_MESSAGE ||
      Boolean(document.querySelector('.msg-bubble--error')), true);
  });
});
