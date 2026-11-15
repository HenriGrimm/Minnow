import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { sendMessageWithTools } from '../../src/chat/messaging.ts';
import { createEmptyChatObject, resetSessionPersistenceForTests, sessionState, setSessionStateForTests } from '../../src/state/sessions.ts';
import { applyComposerDraftForChat, handleComposerDraftInput, initComposerDraftListener } from '../../src/ui/composer-draft.ts';
import { switchChat } from '../../src/ui/sidebar.ts';

const originalFetch = globalThis.fetch;

function setup(messageCount = 2) {
  document.body.innerHTML = '<div id="chatArea"></div><textarea id="msgInput"></textarea><button id="sendBtn"></button>';
  setStorageModeForTests('server');
  const first = createEmptyChatObject('model', 'C:/project');
  first.composerDraft = 'Build out attaching things to chat';
  const second = createEmptyChatObject('model', 'C:/project');
  second.historyLoaded = false;
  second.messageCount = messageCount;
  const third = createEmptyChatObject('model', 'C:/project');
  third.composerDraft = 'Third chat draft';
  setSessionStateForTests({ version: 6, activeId: first.id, sidebarCollapsed: false, chats: [first, second, third] });
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  applyComposerDraftForChat(first);
  initComposerDraftListener(input);
  let resolveHistory!: () => void;
  let historyRequested!: () => void;
  const requested = new Promise<void>(resolve => { historyRequested = resolve; });
  const history = new Promise<Response>(resolve => { resolveHistory = () => resolve(Response.json({ history: messageCount ? [
    { role: 'user', content: 'Earlier prompt' }, { role: 'assistant', content: 'Earlier reply' },
  ] : [] })); });
  globalThis.fetch = async url => {
    if (String(url).includes(`/sessions/history/${second.id}`)) { historyRequested(); return history; }
    return Response.json({ runs: [] });
  };
  return { first, second, third, input, requested, resolveHistory };
}

afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  setStorageModeForTests('localStorage');
  globalThis.fetch = originalFetch;
});

for (const messageCount of [0, 2]) {
test(`switching to ${messageCount ? 'an existing chat' : 'a saved empty chat'} transfers the composer before blur can duplicate a draft`, async () => {
  const { first, second, input, requested, resolveHistory } = setup(messageCount);
  const switching = switchChat(second.id);
  try {
    await requested;
    assert.equal(sessionState?.activeId, second.id);
    input.dispatchEvent(new window.FocusEvent('blur'));
    assert.equal(second.composerDraft, undefined, 'the new chat must not inherit the old composer text');
    assert.equal(input.value, '');
    assert.equal(first.composerDraft, 'Build out attaching things to chat');
    input.value = 'A follow-up for the selected chat';
    handleComposerDraftInput();
  } finally {
    resolveHistory();
    await switching;
  }
  assert.equal(input.value, 'A follow-up for the selected chat');
  assert.equal(second.composerDraft, input.value);
  assert.equal(first.composerDraft, 'Build out attaching things to chat', 'late hydration must not flush the target field onto the leaving chat');
});
}

test('acknowledging a first send during navigation cannot recreate a draft on the running chat', async () => {
  const { first, second, input, requested, resolveHistory } = setup();
  first.chatCommandVersion = 1;
  const fetchHistory = globalThis.fetch;
  let acknowledge!: () => void;
  let commandRequested!: () => void;
  const command = new Promise<void>(resolve => { commandRequested = resolve; });
  const receipt = new Promise<Response>(resolve => { acknowledge = () => resolve(Response.json({
    receipt: { chatId: first.id, commandId: 'first-send', revision: 1, state: 'running' },
  })); });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/commands')) { commandRequested(); return receipt; }
    return fetchHistory(url, init);
  };
  const sending = sendMessageWithTools();
  await command;
  const switching = switchChat(second.id);
  try {
    await requested;
    acknowledge();
    await sending;
    input.value = 'A different draft';
    handleComposerDraftInput();
  } finally {
    resolveHistory();
    await switching;
    acknowledge();
    await sending;
  }
  assert.equal(first.composerDraft, undefined, 'the accepted send must not acquire the other chat draft');
  assert.equal(second.composerDraft, 'A different draft');
  assert.equal(input.value, 'A different draft');
});

test('a superseded history load cannot move drafts between chats or replace the current composer', async () => {
  const { first, second, third, input, requested, resolveHistory } = setup();
  const switching = switchChat(second.id);
  try {
    await requested;
    await switchChat(third.id);
    assert.equal(input.value, third.composerDraft);
    assert.equal(second.composerDraft, undefined);
  } finally {
    resolveHistory();
    await switching;
  }
  assert.equal(sessionState?.activeId, third.id);
  assert.equal(input.value, 'Third chat draft');
  assert.equal(first.composerDraft, 'Build out attaching things to chat');
  assert.equal(second.composerDraft, undefined);
});
