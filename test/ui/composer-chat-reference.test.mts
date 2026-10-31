import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { initComposerPaste, pasteChatReferences } from '../../src/ui/composer-paste.ts';
import { clearAttachments, getPendingAttachments } from '../../src/attachments/store.ts';
import { inlineComposerForInput, inlineComposerText, syncInlineComposerReferences } from '../../src/ui/composer-inline-references.ts';
import { buildHistoryUserContent, buildVlmUserApiContent } from '../../src/chat/build-api-messages.ts';
import { createEmptyChatObject, sessionState, setSessionStateForTests } from '../../src/state/sessions.ts';
import { applyComposerDraftForChat, persistComposerDraftForChatId } from '../../src/ui/composer-draft.ts';
import { setStreaming } from '../../src/app-state.ts';
import { shouldSubmitComposerOnEnter, submitComposerFollowup } from '../../src/ui/composer-send.ts';

const url = 'http://localhost:9473/#/app/code/chat?chatId=linked-chat';
let win: Window;
let input: HTMLTextAreaElement;

beforeEach(() => {
  win = new Window({ url: 'http://localhost:9473/' });
  Object.assign(globalThis, {
    window: win, document: win.document, HTMLElement: win.HTMLElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, Event: win.Event,
  });
  document.body.innerHTML = '<div id="attachPreview" class="hidden"></div><textarea id="msgInput"></textarea>';
  input = document.querySelector('textarea')!;
  initComposerPaste();
  const source = { ...createEmptyChatObject('model'), id: 'linked-chat' };
  source.name = 'Build & review';
  setSessionStateForTests({ version: 6, activeId: 'draft-chat', sidebarCollapsed: false,
    chats: [{ ...createEmptyChatObject('model'), id: 'draft-chat' }, source] });
});

afterEach(async () => {
  await import('../../src/ui/composer-prompt-history.ts');
  await import('../../src/ui/input.ts');
  await new Promise(resolve => setImmediate(resolve));
  clearAttachments();
  setStreaming(false);
  setSessionStateForTests(null);
  await win.happyDOM.close();
});

test('paste displays an inline title chip immediately and preserves reference position when sending', () => {
  input.value = 'Before  after';
  input.setSelectionRange(7, 7);
  assert.equal(pasteChatReferences(input, url), true);
  const editor = inlineComposerForInput(input)!;
  assert.ok(editor);
  assert.equal(input.value, `Before ${url} after`);
  assert.equal(editor.querySelector('.chat-reference-chip__title')?.textContent, 'Build & review');
  assert.equal(editor.textContent, 'Before Build & review after');
  assert.equal(inlineComposerText(editor), input.value);
  assert.equal(document.querySelector('#attachPreview')?.classList.contains('hidden'), true);
  assert.equal(getPendingAttachments().length, 0);
  assert.equal(buildHistoryUserContent(input.value, []), `Before ${url} after`);
  assert.deepEqual(buildVlmUserApiContent(input.value, []), [ { type: 'text', text: `Before ${url} after` } ]);
});

test('mixed Markdown paste replaces the selection and keeps surrounding text', () => {
  input.value = 'Before replace after';
  input.setSelectionRange(7, 14);
  let events = 0;
  input.addEventListener('input', () => events++);
  assert.equal(pasteChatReferences(input, `See [chat](${url}), then continue`), true);
  assert.equal(input.value, `Before See [chat](${url}), then continue after`);
  assert.equal(inlineComposerForInput(input)?.textContent, 'Before See Build & review, then continue after');
  assert.equal(events, 1);
});

test('references survive saving and restoring the draft without a new persisted schema', () => {
  pasteChatReferences(input, `Review this ${url}`);
  persistComposerDraftForChatId('draft-chat');
  clearAttachments();
  input.value = '';
  const chat = sessionState!.chats.find(chat => chat.id === 'draft-chat')!;
  assert.equal(chat.composerDraft, `Review this ${url}`);
  applyComposerDraftForChat(chat);
  assert.equal(input.value, `Review this ${url}`);
  assert.equal(getPendingAttachments().length, 0);
  assert.equal(document.querySelector('.chat-reference-chip__title')?.textContent, 'Build & review');
});


test('external links and disabled composers keep ordinary paste behavior', () => {
  assert.equal(pasteChatReferences(input, url.replace('localhost', 'example.com')), false);
  input.disabled = true;
  assert.equal(pasteChatReferences(input, url), false);
  input.disabled = false;
  input.readOnly = true;
  assert.equal(pasteChatReferences(input, url), false);
  assert.equal(getPendingAttachments().length, 0);
});

test('the actual composer paste event creates the chip immediately', () => {
  initComposerPaste();
  const event = new win.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => url } });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.value, url);
  assert.equal(inlineComposerForInput(input)?.querySelectorAll('.composer-inline-chat-reference').length, 1);
});

for (const delivery of ['steer', 'queue'] as const) {
  test(`a chip-only ${delivery} remains a text follow-up during a running reply`, () => {
    const chat = sessionState!.chats.find(chat => chat.id === 'draft-chat')!;
    setStreaming(true, chat.id);
    pasteChatReferences(input, url);
    assert.equal(shouldSubmitComposerOnEnter(input.value), true);
    submitComposerFollowup(delivery);
    assert.equal(delivery === 'steer' ? chat.pendingSteerMessage : chat.pendingMessageQueue?.[0]?.text, url);
    assert.equal(getPendingAttachments().length, 0);
  });
}

test('native text insertion converts on the input event without reloading or switching chats', () => {
  input.value = `Use ${url} here`;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(inlineComposerForInput(input)?.textContent, 'Use Build & review here');
  assert.equal(input.value, `Use ${url} here`);
});

test('editing and removing inline chips updates the backing draft immediately', () => {
  pasteChatReferences(input, `Use ${url} here`);
  const editor = inlineComposerForInput(input)!;
  editor.querySelector('.composer-inline-chat-reference')!.remove();
  editor.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(input.value, 'Use  here');
  input.value = 'Restored plain draft';
  syncInlineComposerReferences(input);
  assert.equal(editor.textContent, 'Restored plain draft');
});

test('copying a chip copies the reference rather than only its visible title', () => {
  pasteChatReferences(input, `Use ${url} here`);
  const editor = inlineComposerForInput(input)!;
  const range = document.createRange();
  range.selectNodeContents(editor);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  let copied = '';
  const event = new win.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData: (_: string, text: string) => { copied = text; } } });
  editor.dispatchEvent(event);
  assert.equal(copied, `Use ${url} here`);
});

test('inline presentation follows disabled and read-only state', async () => {
  pasteChatReferences(input, url);
  const editor = inlineComposerForInput(input)!;
  input.disabled = true;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.contentEditable, 'false');
  assert.equal(editor.getAttribute('aria-disabled'), 'true');
  input.disabled = false;
  input.readOnly = true;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.contentEditable, 'false');
  assert.equal(editor.getAttribute('aria-readonly'), 'true');
});
