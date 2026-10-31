import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const appState = await import('../../src/app-state.ts');
const {
  setSessionStateForTests,
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
} = await import('../../src/state/sessions.ts');
const { enqueueComposerMessageForTests } = await import('../../src/chat/message-queue.ts');
const { handleComposerPrimaryAction, submitComposerFollowup } = await import('../../src/ui/composer-send.ts');
const { handleKey } = await import('../../src/ui/input.ts');
const { clearAttachments, pushAttachment, getPendingAttachments } = await import('../../src/attachments/store.ts');

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';
const STEER_TEXT = 'Use pnpm not npm';

function setupDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;

  const btn = document.createElement('button');
  btn.id = 'sendBtn';
  btn.type = 'button';
  document.body.appendChild(btn);

  const input = document.createElement('textarea');
  input.id = 'msgInput';
  document.body.appendChild(input);

  return { btn, input };
}

function seedStreamingChat() {
  const chat = createEmptyChatObject('m1');
  chat.id = FIXED_CHAT_ID;
  setSessionStateForTests({
    version: 3,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  appState.setStreaming(true, chat.id);
  return chat;
}

describe('composer queue vs stop', () => {
  afterEach(async () => {
    clearAttachments();
    appState.setStreaming(false);
    flushScheduledSessionSaveForTests();
    await import('../../src/ui/hub.ts');
    await Promise.resolve();
    setSessionStateForTests(null);
    appState.setChatAbort(FIXED_CHAT_ID, null);
  });

  test('streaming with text steers without abort', () => {
    const chat = seedStreamingChat();
    const { input } = setupDom();
    input.value = STEER_TEXT;

    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    appState.setChatAbort(chat.id, controller);

    handleComposerPrimaryAction();

    assert.equal(aborted, false);
    assert.equal(chat.pendingSteerMessage, STEER_TEXT);
    assert.equal(chat.pendingMessageQueue?.length ?? 0, 0);
    assert.equal(input.value, '');
  });

  test('streaming with empty input aborts via stopGeneration', () => {
    const chat = seedStreamingChat();
    setupDom();

    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    appState.setChatAbort(chat.id, controller);

    handleComposerPrimaryAction();

    assert.equal(aborted, true);
  });

  test('Stop with a queued follow-up aborts and leaves the queue untouched', () => {
    const chat = seedStreamingChat();
    setupDom();

    enqueueComposerMessageForTests(chat, {
      id: '22222222-2222-2222-2222-222222222222',
      text: STEER_TEXT,
      createdAt: 1,
    });

    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    appState.setChatAbort(chat.id, controller);

    handleComposerPrimaryAction();

    assert.equal(aborted, true);
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal(chat.pendingMessageQueue?.[0]?.text, STEER_TEXT);
  });

  test('streaming with queued /compact keeps it local until the reply ends', () => {
    const chat = seedStreamingChat();
    const { input } = setupDom();
    input.value = '/compact keep the API decisions';

    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    appState.setChatAbort(chat.id, controller);

    handleComposerPrimaryAction();

    assert.equal(aborted, false);
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal(chat.pendingMessageQueue?.[0]?.text, '/compact keep the API decisions');
  });

  test('Stop preserves unapplied steering in the follow-up queue', () => {
    const chat = seedStreamingChat();
    setupDom();
    chat.pendingSteerMessage = STEER_TEXT;

    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    appState.setChatAbort(chat.id, controller);

    handleComposerPrimaryAction();

    assert.equal(aborted, true);
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal(chat.pendingMessageQueue?.[0]?.text, STEER_TEXT);
  });

  test('explicit queue action does not steer', () => {
    const chat = seedStreamingChat();
    const { input } = setupDom();
    input.value = STEER_TEXT;
    submitComposerFollowup('queue');
    assert.equal(chat.pendingMessageQueue?.[0]?.text, STEER_TEXT);
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal(input.value, '');
  });

  test('Enter after a steer cannot accidentally stop the run', () => {
    const chat = seedStreamingChat();
    const { input } = setupDom();
    const controller = new AbortController();
    appState.setChatAbort(chat.id, controller);
    input.value = STEER_TEXT;
    input.addEventListener('keydown', handleKey);
    input.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(controller.signal.aborted, false);
    assert.equal(chat.pendingSteerMessage, STEER_TEXT);
  });

  test('IME Enter keeps composing instead of sending', () => {
    const chat = seedStreamingChat();
    const { input } = setupDom();
    input.value = 'まだ入力中';
    input.addEventListener('keydown', handleKey);
    input.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal(input.value, 'まだ入力中');
  });

  test('Enter with only an attachment does not stop the current reply', () => {
    const chat = seedStreamingChat();
    const { input } = setupDom();
    const controller = new AbortController();
    appState.setChatAbort(chat.id, controller);
    pushAttachment({ id: 'file', name: 'notes.txt', kind: 'text', mimeType: 'text/plain', size: 5, text: 'notes' });
    input.addEventListener('keydown', handleKey);
    input.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(controller.signal.aborted, false);
    assert.equal(getPendingAttachments()[0]?.id, 'file');
  });

  for (const pendingRead of [false, true]) {
    test(`mid-turn primary action preserves attachments and draft (reading=${pendingRead})`, () => {
      const chat = seedStreamingChat();
      const { input } = setupDom();
      input.value = STEER_TEXT;
      pushAttachment({ id: 'file', name: 'notes.txt', kind: pendingRead ? 'error' : 'text', mimeType: 'text/plain', size: 5, text: 'notes', pendingRead });
      handleComposerPrimaryAction();
      assert.equal(chat.pendingSteerMessage, undefined);
      assert.equal(input.value, STEER_TEXT);
      assert.equal(getPendingAttachments()[0]?.id, 'file');
    });
  }
});
