import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { clearAttachments, getPendingAttachments, pushAttachment } from '../../src/attachments/store.ts';
import { sendMessageWithTools, sendProgrammaticChatText } from '../../src/chat/messaging.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { initComposerSkillHighlight } from '../../src/ui/composer-skill-highlight.ts';
import { syncComposerFromStreamingState } from '../../src/ui/composer-send.ts';
import { inlineComposerForInput, syncInlineComposerReferences } from '../../src/ui/composer-inline-references.ts';
import { applyComposerDraftForChat, handleComposerDraftInput } from '../../src/ui/composer-draft.ts';

const originalFetch = globalThis.fetch;
Object.assign(globalThis, { sessionStorage: window.sessionStorage });

function setup() {
  document.body.innerHTML = '<div id="chatArea"></div><textarea id="msgInput"></textarea><button id="sendBtn"><span id="sendIcon"></span><span id="sendStopIcon" class="hidden"></span></button>';
  const chat = createEmptyChatObject('model', 'C:/project');
  chat.chatCommandVersion = 1;
  chat.history = [{ role: 'user', content: 'Earlier message' }, { role: 'assistant', content: 'Earlier reply' }];
  chat.composerDraft = 'How is our DB setup?';
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  input.value = chat.composerDraft;
  initComposerSkillHighlight(input);
  globalThis.fetch = async url => {
    if (String(url).endsWith('/commands')) {
      // Live execution can arrive before the POST acknowledgement.
      chat.agentExecution = { executionId: 'execution', status: 'running' } as any;
      syncComposerFromStreamingState();
      return Response.json({ receipt: { chatId: chat.id, commandId: 'accepted', revision: 1, state: 'running' } });
    }
    return Response.json({});
  };
  return { chat, input, button: document.getElementById('sendBtn') as HTMLButtonElement };
}

afterEach(async () => {
  await Promise.all([import('../../src/ui/sidebar.ts'), import('../../src/ui/chat-app.ts')]);
  await new Promise(resolve => setImmediate(resolve));
  globalThis.fetch = originalFetch;
  setPairedDevice(false);
  setStorageModeForTests(null);
  clearAttachments();
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  sessionStorage.clear();
});

test('an accepted composer send clears visible text and restores Stop during an existing conversation', async () => {
  const { chat, input, button } = setup();
  await sendMessageWithTools();
  assert.equal(chat.composerDraft, undefined);
  assert.equal(input.value, '');
  assert.equal(input.parentElement?.querySelector('.composer-skill-highlight')?.textContent, '');
  assert.equal(button.getAttribute('aria-label'), 'Stop generating');
  assert.ok(button.classList.contains('send-btn--stop'));
  assert.ok(document.getElementById('sendIcon')?.classList.contains('hidden'));
});

test('a managed programmatic send clears its composer surface on acknowledgement', async () => {
  const { chat, input, button } = setup();
  await sendProgrammaticChatText(chat, input.value, { composerSurface: { inputEl: input, sendBtnEl: button } });
  assert.equal(chat.composerDraft, undefined);
  assert.equal(input.value, '');
  assert.equal(input.parentElement?.querySelector('.composer-skill-highlight')?.textContent, '');
  assert.equal(button.getAttribute('aria-label'), 'Stop generating');
});

test('an acknowledged first send clears the visible composer while its reply runs', async () => {
  const { chat, input, button } = setup();
  chat.history = [];
  await sendMessageWithTools();
  assert.equal(chat.composerDraft, undefined);
  assert.equal(input.value, '');
  assert.equal(input.parentElement?.querySelector('.composer-skill-highlight')?.textContent, '');
  assert.equal(button.getAttribute('aria-label'), 'Stop generating');
});

test('a paired phone persists the new chat before it relays the first message', async () => {
  const { chat, input } = setup();
  delete chat.chatCommandVersion;
  delete chat.composerDraft;
  chat.history = [];
  setPairedDevice(true);
  setStorageModeForTests('server');
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/config/sessions' && init?.method === 'PATCH') {
      const saved = JSON.parse(String(init.body)).chats.find((row: { id: string }) => row.id === chat.id);
      assert.equal(saved.workspacePath, chat.workspacePath);
      assert.equal(saved.composerDraft, undefined, 'the phone draft stays local');
      requests.push('save');
      return Response.json({ ok: true, revision: 3 });
    }
    if (String(url) === '/api/chat-sync/commands') {
      assert.deepEqual(requests, ['save']);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.chatId, chat.id);
      assert.equal(body.text, 'How is our DB setup?');
      requests.push('send');
      return Response.json({ id: body.id, ok: true });
    }
    return Response.json({});
  };
  await sendMessageWithTools();
  assert.deepEqual(requests, ['save', 'send']);
  assert.equal(input.value, '');
});

test('sending plain text after removing a chat chip clears the inline editor too', async () => {
  const { chat, input } = setup();
  input.value = 'See #/app/code/chat?chatId=linked-chat';
  syncInlineComposerReferences(input);
  input.value = chat.composerDraft!;
  syncInlineComposerReferences(input);
  const editor = inlineComposerForInput(input)!;
  assert.equal(editor.textContent, input.value);
  await sendMessageWithTools();
  assert.equal(input.value, '');
  assert.equal(editor.textContent, '');
});

for (const programmatic of [false, true]) {
  const label = programmatic ? 'programmatic' : 'composer';
  test(`an accepted ${label} send preserves text typed before draft tracking catches up`, async () => {
    const { chat, input, button } = setup();
    let acknowledge!: () => void;
    let dispatched!: () => void;
    const command = new Promise<void>(resolve => { dispatched = resolve; });
    globalThis.fetch = async url => {
      if (!String(url).endsWith('/commands')) return Response.json({});
      dispatched();
      await new Promise<void>(resolve => { acknowledge = resolve; });
      return Response.json({ receipt: { chatId: chat.id, commandId: 'accepted-newer', revision: 2, state: 'accepted' } });
    };
    const sending = programmatic
      ? sendProgrammaticChatText(chat, input.value, { composerSurface: { inputEl: input, sendBtnEl: button } })
      : sendMessageWithTools();
    await command;
    assert.equal(input.value, '', 'the composer clears while delivery is pending');
    assert.equal(input.parentElement?.querySelector('.composer-skill-highlight')?.textContent, '');
    input.value = 'A newer draft';
    acknowledge();
    await sending;
    assert.equal(input.value, 'A newer draft');
    handleComposerDraftInput();
    assert.equal(chat.composerDraft, 'A newer draft');
  });

  test(`a rejected ${label} send preserves its draft and attachment`, async () => {
    const { chat, input } = setup();
    const attachment = { id: 'note', name: 'note.txt', kind: 'text' as const, text: 'Details', size: 7, mimeType: 'text/plain' };
    pushAttachment(attachment);
    globalThis.fetch = async url => String(url).endsWith('/commands')
      ? Response.json({ error: { message: 'Model unavailable' } }, { status: 400 }) : Response.json({});
    if (programmatic) {
      await assert.rejects(sendProgrammaticChatText(chat, input.value, { validAttachments: [attachment] }), /Model unavailable/);
    } else {
      await sendMessageWithTools();
    }
    assert.equal(input.value, 'How is our DB setup?');
    assert.equal(chat.composerDraft, input.value);
    assert.equal(getPendingAttachments()[0]?.id, attachment.id);
    assert.match(input.parentElement?.querySelector('.composer-skill-highlight')?.textContent ?? '', /How is our DB setup\?/);
  });

  test(`a rejected ${label} send leaves a newer draft intact`, async () => {
    const { chat, input } = setup();
    let rejectDelivery!: () => void;
    let dispatched!: () => void;
    const command = new Promise<void>(resolve => { dispatched = resolve; });
    globalThis.fetch = async url => {
      if (!String(url).endsWith('/commands')) return Response.json({});
      dispatched();
      await new Promise<void>(resolve => { rejectDelivery = resolve; });
      return Response.json({ error: { message: 'Model unavailable' } }, { status: 400 });
    };
    const sending = programmatic ? sendProgrammaticChatText(chat, input.value) : sendMessageWithTools();
    const settled = programmatic ? assert.rejects(sending, /Model unavailable/) : sending;
    await command;
    assert.equal(input.value, '');
    input.value = 'Keep my new draft';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    rejectDelivery();
    await settled;
    assert.equal(input.value, 'Keep my new draft');
    assert.equal(chat.composerDraft, input.value);
  });

  test(`acknowledging a ${label} send after switching chats clears only the submitted draft`, async () => {
    const { chat, input } = setup();
    let acknowledge!: () => void;
    let dispatched!: () => void;
    const command = new Promise<void>(resolve => { dispatched = resolve; });
    globalThis.fetch = async url => {
      if (!String(url).endsWith('/commands')) return Response.json({});
      dispatched();
      await new Promise<void>(resolve => { acknowledge = resolve; });
      return Response.json({ receipt: { chatId: chat.id, commandId: 'accepted-switch', revision: 3, state: 'accepted' } });
    };
    const sending = programmatic ? sendProgrammaticChatText(chat, input.value) : sendMessageWithTools();
    await command;
    const other = createEmptyChatObject('model', 'C:/project');
    other.composerDraft = 'Other chat draft';
    setSessionStateForTests({ version: 6, activeId: other.id, sidebarCollapsed: false, chats: [chat, other] });
    applyComposerDraftForChat(other);
    acknowledge();
    await sending;
    assert.equal(input.value, 'Other chat draft');
    assert.equal(chat.composerDraft, undefined);
    setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat, other] });
    applyComposerDraftForChat(chat);
    assert.equal(input.value, '');
  });
}

test('programmatic sends can keep the active composer explicitly', async () => {
  const { chat, input } = setup();
  await sendProgrammaticChatText(chat, 'Background instruction', { clearComposerOnSend: false });
  assert.equal(chat.composerDraft, 'How is our DB setup?');
  assert.equal(input.value, chat.composerDraft);
});
