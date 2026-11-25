import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('ask_question notification producer', () => {
  let askQuestion;
  let store;
  let sessions;
  let instances;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.localStorage = win.localStorage;

    store = await import('../../src/notifications/store.ts');
    askQuestion = await import('../../src/notifications/ask-question.ts');
    sessions = await import('../../src/state/sessions.ts');
    instances = await import('../../src/os/instances.ts');

    store.resetNotificationStoreForTests();
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
    instances.resetInstancesForTests();
    sessions.setSessionStateForTests(null);
  });

  const sampleArgs = {
    title: 'Design choices',
    questions: [
      {
        id: 'q1',
        prompt: 'Which layout do you prefer?',
        options: [
          { id: 'a', label: 'Sidebar' },
          { id: 'b', label: 'Top nav' },
        ],
      },
    ],
  };

  test('pushes notification when user is on desktop', () => {
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-a';
    chat.name = 'Super Plan run';
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      chats: [chat],
      groups: [],
    });
    instances.showDesktop();

    askQuestion.notifyAskQuestionShown('chat-a', sampleArgs);

    assert.equal(store.getUnreadNotificationCount(), 1);
    const row = store.getNotifications()[0];
    assert.equal(row?.kind, 'chat_question');
    assert.match(row?.preview ?? '', /Which layout/);
    assert.equal(row?.chatId, 'chat-a');
  });

  test('dedupes identical question batches', () => {
    const chat = sessions.createEmptyChatObject('model-a');
    chat.id = 'chat-a';
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      chats: [chat],
      groups: [],
    });
    instances.showDesktop();

    askQuestion.notifyAskQuestionShown('chat-a', sampleArgs);
    askQuestion.notifyAskQuestionShown('chat-a', sampleArgs);
    assert.equal(store.getUnreadNotificationCount(), 1);
  });
});
