import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('chat turn notification producer', () => {
  let chatTurn;
  let background;
  let store;
  let sessions;
  let instances;
  let prefs;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.localStorage = win.localStorage;

    store = await import('../../src/notifications/store.ts');
    chatTurn = await import('../../src/notifications/chat-turn.ts');
    background = await import('../../src/notifications/background.ts');
    sessions = await import('../../src/state/sessions.ts');
    instances = await import('../../src/os/instances.ts');
    prefs = await import('../../src/notifications/prefs.ts');

    store.resetNotificationStoreForTests();
    prefs.resetNotificationPrefsForTests();
    instances.resetInstancesForTests();
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      chats: [],
      groups: [],
    });
  });

  afterEach(() => {
    store.resetNotificationStoreForTests();
    prefs.resetNotificationPrefsForTests();
    instances.resetInstancesForTests();
    sessions.setSessionStateForTests(null);
  });

  test('shouldNotifyForChatTurn is true on desktop even for active chat', () => {
    instances.showDesktop();
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      chats: [{ ...sessions.createEmptyChatObject('model-a'), id: 'chat-a' }],
      groups: [],
    });
    assert.equal(background.shouldNotifyForChatTurn('chat-a'), true);
  });

  test('suppresses completion when Code app shows the same chat', () => {
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-a';
    chat.name = 'Alpha';
    chat.history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there' },
    ];
    chat.runs = [
      {
        runId: 'run-1',
        branchId: 'b1',
        forkHistoryIndex: 0,
        status: 'completed',
        createdAt: 1,
        endedAt: 2,
        snapshot: {
          forkHistoryIndex: 0,
          providerId: 'p',
          modelId: 'm',
          temperature: 0.7,
          maxTokens: 100,
          maxToolTurns: 8,
          historyPrefixHash: 'abc',
        },
        outputHistoryStart: 1,
        outputHistoryEnd: 1,
      },
    ];
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      chats: [chat],
      groups: [],
    });
    instances.launchInstance('code');

    chatTurn.notifyChatTurnEnded('chat-a', 'run-1');
    assert.equal(store.getUnreadNotificationCount(), 0);

    instances.showDesktop();
    chatTurn.notifyChatTurnEnded('chat-a', 'run-1');
    assert.equal(store.getUnreadNotificationCount(), 1);
    assert.match(store.getNotifications()[0]?.preview ?? '', /Hello/);
  });

  function seedCompletedChat(runId) {
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-a';
    chat.name = 'Alpha';
    chat.history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there' },
    ];
    chat.runs = [
      {
        runId,
        branchId: 'b1',
        forkHistoryIndex: 0,
        status: 'completed',
        createdAt: 1,
        endedAt: 2,
        snapshot: {
          forkHistoryIndex: 0,
          providerId: 'p',
          modelId: 'm',
          temperature: 0.7,
          maxTokens: 100,
          maxToolTurns: 8,
          historyPrefixHash: 'abc',
        },
        outputHistoryStart: 1,
        outputHistoryEnd: 1,
      },
    ];
    sessions.setSessionStateForTests({ version: 5, activeId: 'chat-a', chats: [chat], groups: [] });
    instances.launchInstance('code');
  }

  function stubOsNotifications() {
    const shown = [];
    class FakeNotification {
      static permission = 'granted';
      constructor(title, options) {
        shown.push({ title, ...options });
      }
      close() {}
    }
    globalThis.Notification = FakeNotification;
    document.hasFocus = () => false;
    return shown;
  }

  test('active chat in an unfocused window alerts with an OS notification', () => {
    seedCompletedChat('run-unfocused');
    const shown = stubOsNotifications();
    try {
      chatTurn.notifyChatTurnEnded('chat-a', 'run-unfocused');
      assert.equal(store.getUnreadNotificationCount(), 1);
      assert.equal(shown.length, 1);
      assert.equal(shown[0].title, 'Alpha');
      assert.match(shown[0].body, /Hello/);
    } finally {
      delete globalThis.Notification;
    }
  });

  test('desktop notifications pref off keeps the bell row but skips the OS toast', () => {
    seedCompletedChat('run-os-off');
    const shown = stubOsNotifications();
    prefs.saveNotificationPref('osEnabled', false);
    try {
      chatTurn.notifyChatTurnEnded('chat-a', 'run-os-off');
      assert.equal(store.getUnreadNotificationCount(), 1);
      assert.equal(shown.length, 0);
    } finally {
      delete globalThis.Notification;
    }
  });

  test('plays turn-complete sound on active chat without bell alert when enabled', () => {
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-a';
    chat.name = 'Alpha';
    chat.history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there' },
    ];
    chat.runs = [
      {
        runId: 'run-active',
        branchId: 'b1',
        forkHistoryIndex: 0,
        status: 'completed',
        createdAt: 1,
        endedAt: 2,
        snapshot: {
          forkHistoryIndex: 0,
          providerId: 'p',
          modelId: 'm',
          temperature: 0.7,
          maxTokens: 100,
          maxToolTurns: 8,
          historyPrefixHash: 'abc',
        },
        outputHistoryStart: 1,
        outputHistoryEnd: 1,
      },
    ];
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      chats: [chat],
      groups: [],
    });
    instances.launchInstance('code');
    prefs.saveNotificationPref('soundOnActiveChat', true);

    chatTurn.notifyChatTurnEnded('chat-a', 'run-active');

    assert.equal(store.getUnreadNotificationCount(), 0);
    assert.equal(store.getNotifications().length, 0);
  });

  test('pushes tool failure notification at end of completed turn', () => {
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-b';
    chat.name = 'Beta';
    chat.workspacePath = '/projects/my-app';
    chat.history = [
      { role: 'user', content: 'run tools' },
      { role: 'tool', content: 'Error: denied', tool_call_id: 't1' },
      { role: 'assistant', content: 'Done anyway' },
    ];
    chat.runs = [
      {
        runId: 'run-2',
        branchId: 'b2',
        forkHistoryIndex: 0,
        status: 'completed',
        createdAt: 1,
        endedAt: 2,
        snapshot: {
          forkHistoryIndex: 0,
          providerId: 'p',
          modelId: 'm',
          temperature: 0.7,
          maxTokens: 100,
          maxToolTurns: 8,
          historyPrefixHash: 'def',
        },
        outputHistoryStart: 1,
        outputHistoryEnd: 2,
      },
    ];
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'other-chat',
      chats: [chat, { ...sessions.createEmptyChatObject('model-a'), id: 'other-chat' }],
      groups: [],
    });

    chatTurn.notifyChatTurnEnded('chat-b', 'run-2');

    const rows = store.getNotifications();
    assert.ok(rows.some((r) => r.kind === 'chat_tool_failure'));
    assert.match(rows.find((r) => r.kind === 'chat_tool_failure')?.preview ?? '', /denied/);
    assert.equal(rows.find((r) => r.kind === 'chat_tool_failure')?.appId, 'code');
  });

  test('uses run errorMessage when failed turn output was rolled back', () => {
    instances.showDesktop();
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-fail';
    chat.name = 'Failed plan';
    chat.history = [{ role: 'user', content: 'draft' }];
    chat.runs = [
      {
        runId: 'run-fail',
        branchId: 'bf',
        forkHistoryIndex: 0,
        status: 'failed',
        createdAt: 1,
        endedAt: 2,
        errorMessage: 'Could not complete this reply: Model not loaded',
        snapshot: {
          forkHistoryIndex: 0,
          providerId: 'p',
          modelId: 'm',
          temperature: 0.7,
          maxTokens: 100,
          historyPrefixHash: 'fail',
        },
      },
    ];
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'other-chat',
      chats: [chat, { ...sessions.createEmptyChatObject('model-a'), id: 'other-chat' }],
      groups: [],
    });

    chatTurn.notifyChatTurnEnded('chat-fail', 'run-fail');

    const row = store.getNotifications().find((r) => r.kind === 'chat_turn_error');
    assert.match(row?.preview ?? '', /Model not loaded/);
  });

  test('uses chat app id for assistant workspace completions', () => {
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-c';
    chat.name = 'Gamma';
    chat.workspacePath = 'C:/Users/me/.minnow/chats';
    chat.history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hey there' },
    ];
    chat.runs = [
      {
        runId: 'run-3',
        branchId: 'b3',
        forkHistoryIndex: 0,
        status: 'completed',
        createdAt: 1,
        endedAt: 2,
        snapshot: {
          forkHistoryIndex: 0,
          providerId: 'p',
          modelId: 'm',
          temperature: 0.7,
          maxTokens: 100,
          maxToolTurns: 8,
          historyPrefixHash: 'ghi',
        },
        outputHistoryStart: 1,
        outputHistoryEnd: 1,
      },
    ];
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'other-chat',
      chats: [chat, { ...sessions.createEmptyChatObject('model-a'), id: 'other-chat' }],
      groups: [],
    });

    chatTurn.notifyChatTurnEnded('chat-c', 'run-3');

    const row = store.getNotifications().find((r) => r.kind === 'chat_turn_complete');
    assert.equal(row?.appId, 'code');
  });
});
