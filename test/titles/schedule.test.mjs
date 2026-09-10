/**
 * Title schedule: races, duplicate guard, disabled config.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  resetTitlesConfigCache,
  setTitlesConfigForTests,
} from '../../src/config/titles-meta.ts';
import {
  applyGeneratedChatTitle,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  applyPromptTitlePlaceholder,
  resetTitleGenerationInflight,
  resetTitleScheduleContext,
  scheduleChatTitleGeneration,
  setGenerateChatTitleForTests,
} from '../../src/chat/titles/schedule.ts';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';

function setupDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  document.body.innerHTML = '<div id="chatList"></div>';
}

function seedSession(name = 'New chat') {
  setSessionStateForTests({
    version: 2,
    activeId: CHAT_ID,
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    chats: [
      {
        id: CHAT_ID,
        name,
        workspacePath: '',
        modelId: 'test-model',
        history: [],
        lastStats: null,
        modelInfo: {},
        updatedAt: 1,
      },
    ],
  });
}

function getChat() {
  if (!sessionState?.chats[0]) throw new Error('test session not seeded');
  return sessionState.chats[0];
}

function waitMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('scheduleChatTitleGeneration', () => {
  beforeEach(() => {
    setupDom();
    seedSession();
    resetTitleGenerationInflight();
    resetTitleScheduleContext();
    resetTitlesConfigCache();
    setTitlesConfigForTests({
      enabled: true,
      modelId: '',
      providerId: '',
      maxTokens: 24,
      temperature: 0.3,
    });
    setGenerateChatTitleForTests(null);
  });

  test('updates placeholder name after job completes', async () => {
    setGenerateChatTitleForTests(async () => ({ title: 'Generated title' }));

    scheduleChatTitleGeneration(CHAT_ID, 'Hello world');
    await waitMicrotasks();
    await waitMicrotasks();

    const chat = getChat();
    assert.equal(chat.name, 'Generated title');
  });

  test('shows first prompt snippet until the generated title replaces it', async () => {
    let finishTitle;
    setGenerateChatTitleForTests(
      () =>
        new Promise((resolve) => {
          finishTitle = resolve;
        }),
    );

    assert.equal(
      applyPromptTitlePlaceholder(CHAT_ID, 'How do I tune Redis cache eviction?'),
      true,
    );
    assert.equal(getChat().name, 'How do I tune Redis cache eviction?');

    scheduleChatTitleGeneration(CHAT_ID, 'How do I tune Redis cache eviction?');
    await waitMicrotasks();
    finishTitle({ title: 'Redis eviction tuning' });
    await waitMicrotasks();

    assert.equal(getChat().name, 'Redis eviction tuning');
  });

  test('truncates a long prompt placeholder with an ellipsis', () => {
    assert.equal(applyPromptTitlePlaceholder(CHAT_ID, 'a'.repeat(80)), true);
    assert.equal(getChat().name, `${'a'.repeat(40)}…`);
  });

  test('keeps a sensible fallback for a whitespace-only prompt', () => {
    assert.equal(applyPromptTitlePlaceholder(CHAT_ID, '   \n  '), false);
    assert.equal(getChat().name, 'New chat');
  });

  test('does not overwrite user rename before apply', async () => {
    setGenerateChatTitleForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ title: 'Late title' }), 20);
        }),
    );

    scheduleChatTitleGeneration(CHAT_ID, 'Hello');
    const chat = getChat();
    chat.name = 'My thread';
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(chat.name, 'My thread');
  });

  test('does not overwrite a prompt placeholder after the user renames it', async () => {
    let finishTitle;
    setGenerateChatTitleForTests(
      () =>
        new Promise((resolve) => {
          finishTitle = resolve;
        }),
    );

    applyPromptTitlePlaceholder(CHAT_ID, 'Original prompt');
    scheduleChatTitleGeneration(CHAT_ID, 'Original prompt');
    await waitMicrotasks();
    getChat().name = 'My thread';
    finishTitle({ title: 'Late title' });
    await waitMicrotasks();

    assert.equal(getChat().name, 'My thread');
  });

  test('duplicate schedule calls generate once', async () => {
    let calls = 0;
    setGenerateChatTitleForTests(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { title: 'Once' };
    });

    scheduleChatTitleGeneration(CHAT_ID, 'a');
    scheduleChatTitleGeneration(CHAT_ID, 'b');
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(calls, 1);
  });

  test('applies for New Chat casing variant', async () => {
    seedSession('New Chat');
    setGenerateChatTitleForTests(async () => ({ title: 'Cased title' }));

    scheduleChatTitleGeneration(CHAT_ID, 'Hello');
    await waitMicrotasks();
    await waitMicrotasks();

    assert.equal(getChat().name, 'Cased title');
  });

  test('uses schedule context model and provider overrides', async () => {
    getChat().modelId = '';
    setGenerateChatTitleForTests(async (_seed, options) => {
      assert.equal(options.modelId, 'context-model');
      assert.equal(options.providerId, 'context-provider');
      return { title: 'Context title' };
    });

    scheduleChatTitleGeneration(CHAT_ID, 'Hello', {
      modelId: 'context-model',
      providerId: 'context-provider',
    });
    await waitMicrotasks();
    await waitMicrotasks();

    assert.equal(getChat().name, 'Context title');
  });

  test('falls back to truncated user seed when generation returns null', async () => {
    setGenerateChatTitleForTests(async () => ({ title: null }));

    scheduleChatTitleGeneration(CHAT_ID, 'How do I tune Redis cache eviction?');
    await waitMicrotasks();
    await waitMicrotasks();

    assert.equal(getChat().name, 'How do I tune Redis cache eviction?');
  });

  test('disabled config skips generation', async () => {
    let calls = 0;
    setGenerateChatTitleForTests(async () => {
      calls += 1;
      return { title: 'Nope' };
    });
    setTitlesConfigForTests({
      enabled: false,
      modelId: '',
      providerId: '',
      maxTokens: 24,
      temperature: 0.3,
    });

    scheduleChatTitleGeneration(CHAT_ID, 'Hello');
    await waitMicrotasks();
    await waitMicrotasks();

    assert.equal(calls, 0);
    const chat = getChat();
    assert.equal(chat.name, 'New chat');
  });
});

describe('applyGeneratedChatTitle', () => {
  beforeEach(() => {
    seedSession();
  });

  test('applies only for placeholder name', async () => {
    assert.equal(applyGeneratedChatTitle(CHAT_ID, 'Fresh title'), true);
    const chat = getChat();
    assert.equal(chat.name, 'Fresh title');
    assert.equal(applyGeneratedChatTitle(CHAT_ID, 'Another'), false);
  });
});
