import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEmptyChatObject, getSessionDirtyTrackingForTests, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { sendMessageWithTools } from '../../src/chat/messaging.ts';
import { resetOrdinaryChatRoutingForTests } from '../../src/chat/ordinary-routing.ts';
import { clearAttachments, getPendingAttachments, pushAttachment } from '../../src/attachments/store.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { createChatStreamingRow, renderChatFromHistory } from '../../src/ui/messages.ts';
import { syncComposerFromStreamingState } from '../../src/ui/composer-send.ts';
import { applyComposerDraftForChat, handleComposerDraftInput, persistComposerDraftForChatId } from '../../src/ui/composer-draft.ts';

const originalFetch = globalThis.fetch;
Object.assign(globalThis, { sessionStorage: window.sessionStorage });

function setup(canonical = false) {
  document.body.innerHTML = '<div id="chatArea"></div><textarea id="msgInput"></textarea><button id="sendBtn"></button>';
  const chat = createEmptyChatObject('model', 'C:/project');
  chat.id = 'first-message';
  if (canonical) chat.chatCommandVersion = 1;
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  input.value = 'Review the build';
  chat.composerDraft = input.value;
  return { chat, input, button: document.getElementById('sendBtn') as HTMLButtonElement };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  // Let acknowledgement-triggered sidebar imports settle before disposing the session.
  await Promise.all([import('../../src/ui/sidebar.ts'), import('../../src/ui/chat-app.ts')]);
  globalThis.fetch = originalFetch;
  clearAttachments();
  resetOrdinaryChatRoutingForTests();
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  setStorageModeForTests('localStorage');
  sessionStorage.clear();
});

test('first message paints before delayed promotion, prevents duplicate sends and preserves a newer draft', async t => {
  const { chat, input, button } = setup();
  const image = { id: 'original-image', name: 'screen.png', kind: 'image' as const, size: 4, mimeType: 'image/png', dataUrl: 'data:image/png;base64,YWJjZA==' };
  pushAttachment(image);
  // Recover an in-flight promotion without using the live session store.
  sessionStorage.setItem(`minnow.ordinaryPromotion.${chat.id}`, JSON.stringify({ id: 'promotion', revision: 7 }));
  const promotion = deferred<Response>();
  const commands: any[] = [];
  let promotions = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/ordinary-routing')) { promotions++; return promotion.promise; }
    if (String(url).endsWith('/commands')) {
      commands.push(JSON.parse(String(init?.body)));
      return Response.json({ receipt: { chatId: chat.id, commandId: 'accepted-first', revision: 8, state: 'accepted' } });
    }
    return Response.json({});
  };
  const dirtyBefore = getSessionDirtyTrackingForTests().dirtyChatIds;
  const started = performance.now();
  const sending = sendMessageWithTools();
  try {
    assert.match(document.querySelector('.msg.user.msg--sending')?.textContent ?? '', /Review the build/);
    assert.equal(input.value, '', 'the pending bubble and composer must never display the same text');
    assert.equal(chat.composerDraft, 'Review the build', 'retain the recoverable draft until acknowledgement');
    t.diagnostic(`First sending DOM: ${(performance.now() - started).toFixed(1)} ms, with promotion still unresolved`);
    assert.equal(document.querySelector('.msg--sending img')?.getAttribute('src'), image.dataUrl);
    assert.equal(document.querySelector('[role="status"]')?.textContent, 'Sending…');
    assert.ok(document.querySelector('.msg.assistant.msg--sending-status > .stream-status'));
    assert.equal(document.querySelector('.msg.user [role="status"]'), null);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(chat.history.length, 0);
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, dirtyBefore, 'pending UI does not save a transcript');
    syncComposerFromStreamingState();
    assert.equal(button.disabled, true, 'background UI refresh cannot reopen Send during admission');
    await sendMessageWithTools();
    assert.equal(promotions, 1);
    input.value = 'A newer draft';
    chat.composerDraft = input.value;
    clearAttachments();
    pushAttachment({ id: 'new-file', name: 'next.txt', kind: 'text', text: 'Next message', size: 12, mimeType: 'text/plain' });
  } finally {
    promotion.resolve(Response.json({ receipt: { chatId: chat.id, revision: 8, disposition: 'promoted' },
      frame: { chatId: chat.id, fields: { chatCommandVersion: 1 } } }));
    await sending;
  }
  assert.equal(commands.length, 1);
  assert.match(commands[0].text, /^Review the build/);
  assert.deepEqual(commands[0].images, [{ name: image.name, dataUrl: image.dataUrl }]);
  assert.equal(commands[0].text.includes('Next message'), false, 'attachments added during routing belong to the next draft');
  assert.equal(getPendingAttachments()[0]?.id, 'new-file');
  assert.equal(input.value, 'A newer draft');
  assert.equal(chat.composerDraft, 'A newer draft');
  assert.equal(document.querySelectorAll('.msg.user').length, 1, 'the local echo survives until canonical history arrives');
  chat.pendingMessageQueue = [{ id: 'accepted-first', text: 'Review the build', createdAt: 1,
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } }];
  chat.agentPendingCommand = { commandId: 'accepted-first', state: 'accepted', held: false };
  renderChatFromHistory(chat);
  assert.equal(document.querySelectorAll('.msg.user').length, 1, 'the admission frame and local echo share the canonical command id');
  const stream = createChatStreamingRow(document.getElementById('chatArea')!);
  assert.equal(document.querySelector('.msg--sending-status'), null, 'generation replaces the sending indicator');
  assert.equal(document.querySelectorAll('.stream-status').length, 1);
  assert.equal(document.querySelector('.stream-status__label')?.textContent, 'Generating response…');
  stream.streamStatus.dispose();
  chat.history.push({ role: 'user', content: 'Review the build', commandId: 'accepted-first' });
  renderChatFromHistory(chat);
  assert.equal(document.querySelectorAll('.msg.user').length, 1);
  assert.equal(document.querySelector('.msg--sending'), null);
});

test('a first command that fails before writing history cannot leave a permanent Sending bubble', async () => {
  const { chat } = setup(true);
  globalThis.fetch = async url => String(url).endsWith('/commands')
    ? Response.json({ receipt: { chatId: chat.id, commandId: 'failed-first', revision: 1, state: 'failed' } })
    : Response.json({});
  await sendMessageWithTools();
  assert.equal(document.querySelector('.msg--sending'), null);
  assert.equal(chat.history.length, 0);
});

test('a rejected first send removes the pending bubble and leaves the draft retryable', async () => {
  const { chat, input, button } = setup(true);
  pushAttachment({ id: 'note', name: 'note.txt', kind: 'text', text: 'Details', size: 7, mimeType: 'text/plain' });
  const command = deferred<Response>();
  const dispatched = deferred<void>();
  globalThis.fetch = async url => {
    if (String(url).endsWith('/commands')) { dispatched.resolve(); return command.promise; }
    return Response.json({});
  };
  const sending = sendMessageWithTools();
  try {
    assert.ok(document.querySelector('.msg--sending'));
    assert.equal(input.value, '', 'clear before the command acknowledgement');
    handleComposerDraftInput();
    persistComposerDraftForChatId(chat.id);
    applyComposerDraftForChat(chat);
    assert.equal(chat.composerDraft, 'Review the build', 'blur and navigation must not discard an in-flight draft');
    assert.equal(input.value, '', 'restoring the mounted chat cannot redisplay the pending message');
    await dispatched.promise;
    await sendMessageWithTools();
  } finally {
    command.resolve(Response.json({ error: { message: 'Model unavailable' } }, { status: 400 }));
    await sending;
  }
  assert.equal(document.querySelector('.msg--sending'), null);
  assert.equal(input.value, 'Review the build');
  assert.equal(chat.composerDraft, input.value);
  assert.equal(chat.history.length, 0);
  assert.equal(getPendingAttachments()[0]?.id, 'note');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
});

test('leaving a new chat during promotion cannot send from the other composer', async () => {
  const { chat, input } = setup();
  sessionStorage.setItem(`minnow.ordinaryPromotion.${chat.id}`, JSON.stringify({ id: 'promotion', revision: 7 }));
  const promotion = deferred<Response>();
  let commands = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/ordinary-routing')) return promotion.promise;
    if (String(url).endsWith('/commands')) commands++;
    return Response.json({});
  };
  const sending = sendMessageWithTools();
  const other = createEmptyChatObject('model', 'C:/project');
  setSessionStateForTests({ version: 6, activeId: other.id, sidebarCollapsed: false, chats: [chat, other] });
  input.value = 'Other chat draft';
  renderChatFromHistory(other);
  promotion.resolve(Response.json({ receipt: { chatId: chat.id, revision: 8, disposition: 'promoted' },
    frame: { chatId: chat.id, fields: { chatCommandVersion: 1 } } }));
  await sending;
  assert.equal(commands, 0);
  assert.equal(input.value, 'Other chat draft');
  assert.equal(chat.composerDraft, 'Review the build');
  renderChatFromHistory(chat);
  assert.equal(document.querySelector('.msg--sending'), null);
});

test('routing rejection restores the composer that was cleared for the Sending bubble', async () => {
  const { chat, input } = setup();
  sessionStorage.setItem(`minnow.ordinaryPromotion.${chat.id}`, JSON.stringify({ id: 'promotion', revision: 7 }));
  const promotion = deferred<Response>();
  globalThis.fetch = async url => String(url).endsWith('/ordinary-routing') ? promotion.promise : Response.json({});
  const sending = sendMessageWithTools();
  assert.equal(input.value, '');
  assert.ok(document.querySelector('.msg--sending'));
  promotion.resolve(Response.json({ error: { message: 'Cannot route this conversation' } }, { status: 400 }));
  await sending;
  assert.equal(input.value, 'Review the build');
  assert.equal(chat.composerDraft, input.value);
  assert.equal(document.querySelector('.msg--sending'), null);
});
