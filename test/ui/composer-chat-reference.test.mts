import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { initComposerPaste, pasteChatReferences } from '../../src/ui/composer-paste.ts';
import { clearAttachments, getPendingAttachments } from '../../src/attachments/store.ts';
import { withComposerChatReferences } from '../../src/attachments/chat-ref.ts';
import { buildHistoryUserContent, buildVlmUserApiContent } from '../../src/chat/build-api-messages.ts';
import { createEmptyChatObject, sessionState, setSessionStateForTests } from '../../src/state/sessions.ts';
import { applyComposerDraftForChat, persistComposerDraftForChatId } from '../../src/ui/composer-draft.ts';
import { setStreaming } from '../../src/app-state.ts';
import { shouldSubmitComposerOnEnter, submitComposerFollowup } from '../../src/ui/composer-send.ts';

const url = 'http://localhost:9473/#/app/code/chat?chatId=linked-chat';
const link = '#/app/code/chat?chatId=linked-chat';
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

test('paste displays a titled removable chip before send and sends the reference as text', async () => {
  assert.equal(pasteChatReferences(input, url), true);
  assert.equal(input.value, '');
  assert.equal(document.querySelector('.chat-reference-chip__title')?.textContent, 'Build & review');
  assert.equal(document.querySelector('#attachPreview')?.classList.contains('hidden'), false);
  assert.equal(shouldSubmitComposerOnEnter(''), true);
  assert.equal(buildHistoryUserContent('', getPendingAttachments()), link);
  assert.deepEqual(buildVlmUserApiContent('Use this chat', getPendingAttachments()), [
    { type: 'text', text: `Use this chat\n\n${link}` },
  ]);
  document.querySelector<HTMLButtonElement>('.attach-chip-remove')!.click();
  await Promise.resolve();
  assert.equal(getPendingAttachments().length, 0);
  assert.equal(withComposerChatReferences(''), '');
  assert.equal(shouldSubmitComposerOnEnter(''), false);
});

test('mixed Markdown paste replaces the selection, preserves other text and deduplicates references', () => {
  input.value = 'Before replace after';
  input.setSelectionRange(7, 14);
  let events = 0;
  input.addEventListener('input', () => events++);
  assert.equal(pasteChatReferences(input, `See [chat](${url}), then continue`), true);
  assert.equal(input.value, 'Before See , then continue after');
  assert.equal(events, 1);
  assert.equal(pasteChatReferences(input, `<${url}>`), true);
  assert.equal(getPendingAttachments().length, 1);
});

test('references survive saving and restoring the draft without a new persisted schema', () => {
  pasteChatReferences(input, `Review this ${url}`);
  persistComposerDraftForChatId('draft-chat');
  clearAttachments();
  input.value = '';
  const chat = sessionState!.chats.find(chat => chat.id === 'draft-chat')!;
  assert.equal(chat.composerDraft, `Review this \n\n${link}`);
  applyComposerDraftForChat(chat);
  assert.equal(input.value.trim(), 'Review this');
  assert.equal(getPendingAttachments()[0]?.chatId, 'linked-chat');
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
  assert.equal(input.value, '');
  assert.equal(getPendingAttachments()[0]?.chatId, 'linked-chat');
});

for (const delivery of ['steer', 'queue'] as const) {
  test(`a chip-only ${delivery} remains a text follow-up during a running reply`, () => {
    const chat = sessionState!.chats.find(chat => chat.id === 'draft-chat')!;
    setStreaming(true, chat.id);
    pasteChatReferences(input, url);
    assert.equal(shouldSubmitComposerOnEnter(''), true);
    submitComposerFollowup(delivery);
    assert.equal(delivery === 'steer' ? chat.pendingSteerMessage : chat.pendingMessageQueue?.[0]?.text, link);
    assert.equal(getPendingAttachments().length, 0);
  });
}
