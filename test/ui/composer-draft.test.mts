import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { clearAttachments, getPendingAttachments, pushAttachment } from '../../src/attachments/store.ts';

const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const {
  clearComposerAfterSend,
  handleComposerDraftInput,
  persistComposerDraftOnChat,
  switchComposerDraft,
  flushActiveComposerDraftBeforeNewChat,
} = await import('../../src/ui/composer-draft.ts');

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';

function setupComposerInput(): HTMLTextAreaElement {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  const input = document.createElement('textarea');
  input.id = 'msgInput';
  document.body.appendChild(input);
  return input;
}

describe('clearComposerAfterSend', () => {
  afterEach(async () => {
    await import('../../src/ui/composer-prompt-history.ts');
    clearAttachments();
    setSessionStateForTests(null);
    document.body.replaceChildren();
  });

  test('clears persisted draft and textarea after send', () => {
    const chat = createEmptyChatObject(FIXED_CHAT_ID);
    persistComposerDraftOnChat(chat, 'hello world');
    const input = setupComposerInput();
    input.value = 'hello world';

    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    clearComposerAfterSend(chat, input);

    assert.equal(chat.composerDraft, undefined);
    assert.equal(input.value, '');
  });
});

describe('handleComposerDraftInput', () => {
  afterEach(() => {
    clearAttachments();
    setSessionStateForTests(null);
    document.body.replaceChildren();
  });

  test('stores draft text in memory without requiring a session flush first', () => {
    const chat = createEmptyChatObject(FIXED_CHAT_ID);
    const input = setupComposerInput();
    input.value = 'hello from composer';

    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    handleComposerDraftInput();

    assert.equal(chat.composerDraft, 'hello from composer');
  });
});

describe('attachment navigation', () => {
  afterEach(async () => {
    await import('../../src/ui/composer-prompt-history.ts');
    clearAttachments();
    setSessionStateForTests(null);
    document.body.replaceChildren();
  });

  test('switching chats preserves text drafts but clears unsent files', () => {
    const first = createEmptyChatObject(FIXED_CHAT_ID);
    const second = createEmptyChatObject('22222222-2222-2222-2222-222222222222');
    second.composerDraft = 'second draft';
    const input = setupComposerInput();
    input.value = 'first draft';
    setSessionStateForTests({ version: 3, activeId: first.id, sidebarCollapsed: false, chats: [first, second] });
    pushAttachment({ id: 'file-a', name: 'a.txt', kind: 'text', mimeType: 'text/plain', size: 1, text: 'a' });

    switchComposerDraft(first.id, second);

    assert.equal(first.composerDraft, 'first draft');
    assert.equal(input.value, 'second draft');
    assert.deepEqual(getPendingAttachments(), []);
  });

  test('starting a new chat clears unsent files with the old input', () => {
    const chat = createEmptyChatObject(FIXED_CHAT_ID);
    const input = setupComposerInput();
    input.value = 'draft';
    setSessionStateForTests({ version: 3, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
    pushAttachment({ id: 'file-a', name: 'a.txt', kind: 'text', mimeType: 'text/plain', size: 1, text: 'a' });

    flushActiveComposerDraftBeforeNewChat();

    assert.equal(chat.composerDraft, 'draft');
    assert.equal(input.value, '');
    assert.deepEqual(getPendingAttachments(), []);
  });
});
