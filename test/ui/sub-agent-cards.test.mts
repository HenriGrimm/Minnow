import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { resetInstancesForTests } from '../../src/os/instances.ts';
import {
  initOsPageBridge,
  resetOsPageBridgeForTests,
} from '../../src/os/page-bridge.ts';

const { upsertSubAgentCardForRun, clearSubAgentCardDomRegistry } = await import(
  '../../src/ui/sub-agent-cards.ts',
);
const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts',
);
const { renderHub, teardownHub } = await import('../../src/ui/hub.ts');

function setupCodeDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  document.body.innerHTML = `
    <div id="mainColumn">
      <div id="chatArea"></div>
      <div class="input-bar">
        <textarea id="msgInput"></textarea>
        <div id="modeSelector"></div>
      </div>
    </div>
  `;
  return window;
}

const sampleRun = (chatId: string) => ({
  runId: '22222222-2222-2222-2222-222222222222',
  type: 'explore',
  task: 'List files under src/',
  status: 'running' as const,
  parentChatId: chatId,
  parentToolCallId: null,
  parentTurnId: 'turn-1',
  summary: '',
  error: null,
  startedAt: '2026-05-20T12:00:00.000Z',
  endedAt: null,
  toolTurns: 0,
  cancelled: false,
  messages: [],
  liveNestedToolCalls: 1,
});

function laterAssistant(area: HTMLElement): HTMLElement {
  const trailing = document.createElement('div');
  trailing.className = 'msg assistant';
  trailing.textContent = 'Done.';
  area.appendChild(trailing);
  return trailing;
}

describe('sub-agent cards', { concurrency: false }, () => {
  afterEach(() => {
    teardownHub();
    setSessionStateForTests(null);
    resetInstancesForTests();
    resetOsPageBridgeForTests();
  });

  test('upsertSubAgentCardForRun mounts a card for the active chat', () => {
    setupCodeDom();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-sub-1';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const el = upsertSubAgentCardForRun(sampleRun(chat.id), chat.id);
    assert.ok(el);
    assert.ok(el.classList.contains('sub-agent-card--active'));
    assert.ok(el.textContent?.includes('Working'));
    assert.ok(el.textContent?.includes('Sub-agent'));
    assert.ok(el.textContent?.includes('Explore'));
    assert.ok(el.textContent?.includes('List files'));
    assert.equal(el.getAttribute('aria-busy'), 'true');
    assert.ok(el.querySelector('.sub-agent-card__mark .icon-svg'));
    assert.ok(el.querySelector('.sub-agent-card__chevron'));
    assert.equal(document.getElementById('chatArea')?.querySelector('.sub-agent-card'), el);

    clearSubAgentCardDomRegistry();
  });

  test('sub-agent cards share the centered chat reading column', () => {
    const css = readFileSync(new URL('../../src/styles/chat-thread.css', import.meta.url), 'utf8');
    assert.match(css, /\.chat-thread > \.sub-agent-card,/);
  });

  test('upsertSubAgentCardForRun shows live phase on the badge and subtitle', () => {
    setupCodeDom();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-sub-live';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const el = upsertSubAgentCardForRun(
      {
        ...sampleRun(chat.id),
        livePhase: 'thinking',
        livePartialReasoning: 'Checking routes…',
      },
      chat.id,
    );
    assert.ok(el);
    assert.ok(el.textContent?.includes('Thinking'));
    assert.ok(el.textContent?.includes('Thinking…'));

    clearSubAgentCardDomRegistry();
  });

  test('upsertSubAgentCardForRun skips the Vibe hub empty-chat landing', () => {
    setupCodeDom();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-hub-sub';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderHub(chat);
    const el = upsertSubAgentCardForRun(sampleRun(chat.id), chat.id);
    assert.equal(el, null);
    assert.equal(document.getElementById('chatArea')?.querySelector('.sub-agent-card'), null);

    clearSubAgentCardDomRegistry();
  });

  test('upsert places the card under the spawn_sub_agent tool row', () => {
    setupCodeDom();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-sub-anchor';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const area = document.getElementById('chatArea');
    assert.ok(area);
    const assistant = document.createElement('div');
    assistant.className = 'msg assistant';
    area.appendChild(assistant);
    const toolRow = document.createElement('div');
    toolRow.className = 'tool-call-msg';
    toolRow.dataset.toolCallId = 'call_spawn_1';
    area.appendChild(toolRow);
    const later = document.createElement('div');
    later.className = 'msg assistant';
    later.textContent = 'Done.';
    area.appendChild(later);

    const el = upsertSubAgentCardForRun(
      { ...sampleRun(chat.id), parentToolCallId: 'call_spawn_1' },
      chat.id,
    );
    assert.ok(el);
    assert.equal(el.previousElementSibling, toolRow);
    assert.equal(toolRow.nextElementSibling, el);

    clearSubAgentCardDomRegistry();
  });

  test('upsert re-anchors a detached card after a transcript rebuild', () => {
    setupCodeDom();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-sub-reanchor';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const area = document.getElementById('chatArea');
    assert.ok(area);
    const firstRow = document.createElement('div');
    firstRow.className = 'tool-call-msg';
    firstRow.dataset.toolCallId = 'call_spawn_2';
    area.appendChild(firstRow);

    const run = { ...sampleRun(chat.id), parentToolCallId: 'call_spawn_2' };
    const el = upsertSubAgentCardForRun(run, chat.id);
    assert.ok(el);
    assert.equal(el.previousElementSibling, firstRow);

    // Simulate renderChatFromHistory: wipe the transcript but keep the card
    // in the registry (the creation-only path would then skip placement).
    area.replaceChildren();
    assert.equal(el.isConnected, false);

    const rebuilt = document.createElement('div');
    rebuilt.className = 'tool-call-msg';
    rebuilt.dataset.toolCallId = 'call_spawn_2';
    area.appendChild(rebuilt);
    laterAssistant(area);

    const again = upsertSubAgentCardForRun(run, chat.id);
    assert.equal(again, el);
    assert.equal(el.previousElementSibling, rebuilt);
    assert.equal(rebuilt.nextElementSibling, el);

    clearSubAgentCardDomRegistry();
  });

  test('upsert moves a bottom-appended card once the spawn tool row appears', () => {
    setupCodeDom();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-sub-late-anchor';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const area = document.getElementById('chatArea');
    assert.ok(area);
    const trailing = document.createElement('div');
    trailing.className = 'msg assistant';
    trailing.textContent = 'Done.';
    area.appendChild(trailing);

    const run = { ...sampleRun(chat.id), parentToolCallId: 'call_spawn_3' };
    const el = upsertSubAgentCardForRun(run, chat.id);
    assert.ok(el);
    assert.equal(area.lastElementChild, el);

    const spawnRow = document.createElement('div');
    spawnRow.className = 'tool-call-msg';
    spawnRow.dataset.toolCallId = 'call_spawn_3';
    area.insertBefore(spawnRow, trailing);

    const again = upsertSubAgentCardForRun(run, chat.id);
    assert.equal(again, el);
    assert.equal(el.previousElementSibling, spawnRow);
    assert.equal(spawnRow.nextElementSibling, el);

    clearSubAgentCardDomRegistry();
  });

  test('upsert after clearSubAgentCardDomRegistry still sits under the rebuilt tool row', () => {
    setupCodeDom();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-sub-history';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const area = document.getElementById('chatArea');
    assert.ok(area);
    const firstRow = document.createElement('div');
    firstRow.className = 'tool-call-msg';
    firstRow.dataset.toolCallId = 'call_spawn_hist';
    area.appendChild(firstRow);

    const run = { ...sampleRun(chat.id), parentToolCallId: 'call_spawn_hist' };
    const first = upsertSubAgentCardForRun(run, chat.id);
    assert.ok(first);
    assert.equal(first.previousElementSibling, firstRow);

    // Production renderChatFromHistory: drop the registry, wipe the mount,
    // rebuild the spawn tool row, then re-upsert persisted cards.
    clearSubAgentCardDomRegistry();
    area.replaceChildren();
    const rebuilt = document.createElement('div');
    rebuilt.className = 'tool-call-msg';
    rebuilt.dataset.toolCallId = 'call_spawn_hist';
    area.appendChild(rebuilt);
    laterAssistant(area);

    const again = upsertSubAgentCardForRun(run, chat.id);
    assert.ok(again);
    assert.equal(again.previousElementSibling, rebuilt);
    assert.equal(rebuilt.nextElementSibling, again);

    clearSubAgentCardDomRegistry();
  });
});

