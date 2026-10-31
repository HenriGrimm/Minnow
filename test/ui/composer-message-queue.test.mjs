import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { resolveComposerQueueMount, syncComposerMessageQueue } = await import(
  '../../src/ui/composer-message-queue.ts'
);
const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const { enqueueComposerMessage, removeQueuedMessage } = await import('../../src/chat/message-queue.ts');
const appState = await import('../../src/app-state.ts');
const { composerFollowUpPlaceholder } = await import('../../src/ui/composer-shortcuts.ts');
const { enqueueSteerMessage } = await import('../../src/chat/steer-message.ts');

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';
const QUEUE_TEXT = 'hello';

function setupCodeComposerDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);

  const composer = document.createElement('div');
  composer.className = 'input-bar-composer';

  const inputRow = document.createElement('div');
  inputRow.className = 'input-row';

  const input = document.createElement('textarea');
  input.id = 'msgInput';
  inputRow.appendChild(input);
  composer.appendChild(inputRow);
  document.body.appendChild(composer);

  const hiddenChat = document.createElement('div');
  hiddenChat.className = 'chat-app-composer-inner';
  hiddenChat.style.display = 'none';
  document.body.appendChild(hiddenChat);

  return { composer, inputRow, input, hiddenChat, chatArea };
}

describe('composer message queue mount', () => {
  afterEach(() => {
    appState.setStreaming(false);
    appState.setChatAbort(FIXED_CHAT_ID, null);
    setSessionStateForTests(null);
  });

  function seed() {
    const dom = setupCodeComposerDom();
    const chat = createEmptyChatObject('m1');
    chat.id = FIXED_CHAT_ID;
    setSessionStateForTests({ version: 3, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
    appState.setStreaming(true, chat.id);
    return { ...dom, chat };
  }

  test('queued turns show their saved model options even when the next-message selection changes', () => {
    const { chat } = seed();
    chat.pendingMessageQueue = [{ id: 'captured-model', text: 'Saved task', createdAt: 1,
      modelSelection: { providerId: 'provider', modelId: 'captured', options: { reasoningEffort: 'high', thinkingBudgetTokens: 1024 } } }];
    chat.agentModelSelection = { providerId: 'other', modelId: 'new-message-model' };
    syncComposerMessageQueue();
    const saved = document.querySelector('.composer-message-queue__model');
    assert.equal(saved.textContent, 'Saved model: captured · high effort · 1024 token budget');
    assert.match(saved.title, /provider/);
    assert.equal(saved.textContent.includes('new-message-model'), false);
    chat.pendingMessageQueue[0].modelSelection.options.reasoningEffort = 'low';
    syncComposerMessageQueue();
    assert.match(document.querySelector('.composer-message-queue__model').textContent, /low effort/);
  });

  test('inline editing preserves both the composer draft and the queue position', async () => {
    const { input, chat } = seed();
    input.value = 'unsent draft';
    enqueueComposerMessage(chat, 'first');
    enqueueComposerMessage(chat, 'second');
    const id = chat.pendingMessageQueue[0].id;
    syncComposerMessageQueue();
    document.querySelector('button[aria-label="Edit queued message"]').click();
    const editor = document.querySelector('.composer-message-queue__editor');
    assert.ok(editor);
    assert.equal(input.value, 'unsent draft');
    assert.equal(chat.pendingMessageQueue[0].id, id);
    editor.value = 'revised first';
    editor.dispatchEvent(new document.defaultView.Event('input'));
    // A new correction must not discard edits or steal focus.
    editor.focus();
    enqueueSteerMessage(chat, 'use the helper');
    assert.equal(document.activeElement.value, 'revised first');
    const save = [...document.querySelectorAll('.composer-message-queue__text-action')].find(el => el.textContent === 'Save');
    save.click();
    await Promise.resolve();
    assert.deepEqual(chat.pendingMessageQueue.map(item => item.text), ['revised first', 'second']);
    assert.equal(input.value, 'unsent draft');
  });

  test('pending steering stays visible and can be cancelled without stopping the run', () => {
    const { chat } = seed();
    syncComposerMessageQueue();
    enqueueSteerMessage(chat, 'use the existing helper');
    const queue = document.getElementById('composerMessageQueue');
    assert.match(queue.textContent, /Steering at next step/);
    assert.match(queue.textContent, /use the existing helper/);
    queue.querySelector('button[aria-label="Cancel pending steering"]').click();
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal(appState.streamingChatIds.has(chat.id), true);
    assert.equal(document.getElementById('msgInput').placeholder, composerFollowUpPlaceholder());
  });

  test('a remotely removed queue item cannot take an unsaved edit with it', () => {
    const { chat, input } = seed();
    input.value = 'separate draft';
    enqueueComposerMessage(chat, 'original');
    syncComposerMessageQueue();
    document.querySelector('button[aria-label="Edit queued message"]').click();
    const editor = document.querySelector('.composer-message-queue__editor');
    editor.value = 'unsaved correction';
    editor.dispatchEvent(new document.defaultView.Event('input'));
    removeQueuedMessage(chat, chat.pendingMessageQueue[0].id);
    assert.equal(document.querySelector('.composer-message-queue__editor').value, 'unsaved correction');
    assert.match(document.getElementById('composerMessageQueue').textContent, /Send as new message/);
    assert.equal(input.value, 'separate draft');
    [...document.querySelectorAll('.composer-message-queue__text-action')].find(el => el.textContent === 'Cancel').click();
  });

  test('running chat shows follow-up shortcuts as a placeholder without an extra controls row', () => {
    const { input } = seed();
    syncComposerMessageQueue();
    assert.equal(input.placeholder, composerFollowUpPlaceholder());
    assert.equal(document.getElementById('composerRunControls'), null);
    input.value = 'keep this draft';
    syncComposerMessageQueue();
    assert.equal(input.value, 'keep this draft');
    assert.equal(document.getElementById('composerRunControls'), null);
    input.value = '';
    syncComposerMessageQueue();
    assert.equal(input.placeholder, composerFollowUpPlaceholder());
    appState.setStreaming(false);
    syncComposerMessageQueue();
    assert.equal(input.placeholder, 'Ask Minnow to plan, build, or debug…');
  });

  test('resolveComposerQueueMount targets the active code composer input row', () => {
    const { input, inputRow } = setupCodeComposerDom();
    const mount = resolveComposerQueueMount(input);
    assert.ok(mount);
    assert.equal(mount.host.className, 'input-bar-composer');
    assert.equal(mount.before, inputRow);
  });

  test('syncComposerMessageQueue mounts above the active composer, not hidden chat shell', () => {
    const { input, inputRow, hiddenChat } = setupCodeComposerDom();
    const chat = createEmptyChatObject('m1');
    chat.id = FIXED_CHAT_ID;
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    appState.setStreaming(true, chat.id);
    enqueueComposerMessage(chat, QUEUE_TEXT);

    syncComposerMessageQueue();

    const queue = document.getElementById('composerMessageQueue');
    assert.ok(queue);
    assert.equal(queue.classList.contains('hidden'), false);
    assert.equal(queue.parentElement?.className, 'input-bar-composer');
    assert.equal(queue.nextElementSibling, inputRow);
    assert.equal(hiddenChat.contains(queue), false);
    assert.match(queue.textContent ?? '', /1 queued for later/);
    assert.match(queue.textContent ?? '', /hello/);

    assert.equal(document.querySelector('#queuedTranscript'), null);
    assert.equal(document.querySelectorAll('.msg--queued').length, 0);
    assert.equal(chat.history.length, 0);
    assert.equal(queue.querySelectorAll('.composer-message-queue__actions button').length, 3);

    setSessionStateForTests(null);
    appState.setStreaming(false);
  });

  test('pending messages stay out of the transcript and clear from the composer when removed', () => {
    const { chatArea } = setupCodeComposerDom();
    const chat = createEmptyChatObject('m1');
    chat.id = FIXED_CHAT_ID;
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    appState.setStreaming(true, chat.id);
    enqueueComposerMessage(chat, QUEUE_TEXT);
    syncComposerMessageQueue();
    assert.equal(chatArea.children.length, 0);
    assert.equal(chat.history.length, 0);
    assert.equal(document.querySelectorAll('.composer-message-queue__item').length, 1);

    removeQueuedMessage(chat, chat.pendingMessageQueue[0].id);
    syncComposerMessageQueue();
    assert.equal(chatArea.children.length, 0);
    const queue = document.getElementById('composerMessageQueue');
    assert.equal(queue.classList.contains('hidden'), true);
    assert.equal(queue.children.length, 0);

    setSessionStateForTests(null);
    appState.setStreaming(false);
  });
});
