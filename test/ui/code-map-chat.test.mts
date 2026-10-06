import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  Event: win.Event, Node: win.Node,
});
const oldChat = { id: 'previous', history: [{ role: 'user', content: 'Existing conversation' }] };
const sessionState = { activeId: oldChat.id, chats: [oldChat] };
let created = 0;
let failSend = false;
const sent: { chatId: string; prompt: string; card: unknown }[] = [];
mock.module('../../src/chat/messaging.ts', { namedExports: {
  async sendProgrammaticChatText(chat: typeof oldChat, prompt: string, options: { codeMap: unknown; parseSlash: boolean }) {
    assert.ok(document.getElementById('codeMapChatTranscript'));
    assert.equal(options.parseSlash, false);
    if (failSend) throw new Error('Select a model first');
    sent.push({ chatId: chat.id, prompt, card: options.codeMap });
    chat.history.push({ role: 'user', content: prompt });
  },
} });
mock.module('../../src/state/sessions.ts', { namedExports: { sessionState } });
mock.module('../../src/ui/sidebar.ts', { namedExports: {
  createChatWithMode(options: { modeId: string; forceNewChat: boolean }) {
    assert.equal(options.modeId, 'general');
    assert.equal(options.forceNewChat, true);
    const chat = { id: `map-${++created}`, history: [] };
    sessionState.chats.push(chat);
    sessionState.activeId = chat.id;
    return { ok: true, chatId: chat.id };
  },
} });
mock.module('../../src/chat/ask-question-display.ts', { namedExports: {
  notifyAskQuestionDisplayContextChanged() {},
} });
mock.module('../../src/ui/chat-scroll.ts', { namedExports: {
  bindCodeMapChatScroll() {}, invalidateChatScrollRootCache() {},
} });
mock.module('../../src/ui/main-column-overlay.ts', { namedExports: {
  notifyCodeStageViewChanged() {},
  stripMainColumnOverlayClasses() {
    document.getElementById('chatArea')?.classList.remove('chat-area--code-brain-map');
  },
} });
mock.module('../../src/os/instances.ts', { namedExports: { getForegroundAppId: () => 'code' } });
mock.module('../../src/ui/orchestrate-board-init-split.ts', { namedExports: {
  getOrchestrateChatMountElement: () => document.getElementById('chatArea'),
} });
mock.module('../../src/ui/orchestrate-board-chat-state.ts', { namedExports: {
  isBoardChatEmbedOpen: () => false, queryBoardChatTranscriptHost: () => null,
} });
const { openCodeMapChat, closeCodeMapChat, teardownCodeBrainMapBeforeChatPaint } =
  await import('../../src/ui/code-brain-map.ts');
const { queryCodeMapChatHost } = await import('../../src/ui/code-map/chat-state.ts');
const { appendChatTranscriptNode, getActiveChatMountElement } = await import('../../src/ui/chat-mount.ts');

beforeEach(() => {
  failSend = false;
  sent.length = 0;
  closeCodeMapChat();
  sessionState.activeId = oldChat.id;
  document.body.innerHTML = `
    <div id="mainColumn">
      <div id="chatArea" class="chat-area--code-brain-map">
        <div id="codeBrainMapRoot"><div id="codeBrainMapMount">Map remains here</div></div>
      </div>
      <div class="tool-approval-host" hidden></div>
      <div class="question-host" hidden></div>
      <div class="input-bar"><textarea id="msgInput"></textarea><button id="sendBtn">Send</button></div>
      <div id="afterComposer"></div>
    </div>`;
});
after(() => { closeCodeMapChat(); win.happyDOM.abort(); });

test('asking from the map opens a separate chat and preserves the shared composer', async () => {
  const composer = document.querySelector('.input-bar');
  const send = document.getElementById('sendBtn');
  const request = makeRequest('Explain src/main.ts');
  await openCodeMapChat(request);
  assert.notEqual(sessionState.activeId, oldChat.id);
  assert.deepEqual(oldChat.history, [{ role: 'user', content: 'Existing conversation' }]);
  assert.equal(document.getElementById('codeBrainMapMount')?.textContent, 'Map remains here');
  assert.equal(document.getElementById('msgInput')?.closest('aside')?.id, 'codeMapChatSidebar');
  assert.equal(document.getElementById('sendBtn'), send);
  assert.equal(document.querySelector('.input-bar'), composer);
  assert.equal((document.getElementById('msgInput') as HTMLTextAreaElement).value, '');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, sessionState.activeId);
  assert.equal(sent[0].prompt, request.prompt);
  assert.deepEqual(sent[0].card, request.card);
  assert.ok(queryCodeMapChatHost(sessionState.activeId));
  assert.equal(queryCodeMapChatHost(oldChat.id), null);
  const reply = document.createElement('div');
  reply.textContent = 'Reply from the shared engine';
  appendChatTranscriptNode(reply);
  assert.equal(reply.parentElement, queryCodeMapChatHost(sessionState.activeId));
  assert.equal(document.getElementById('codeBrainMapMount')?.textContent, 'Map remains here');
});

test('closing the sidebar restores composer order and leaves the map open', async () => {
  await openCodeMapChat(makeRequest('Explain'));
  document.querySelector<HTMLButtonElement>('[aria-label="Close code map chat"]')!.click();
  assert.equal(document.getElementById('codeMapChatSidebar'), null);
  assert.ok(document.getElementById('codeBrainMapRoot'));
  assert.equal(document.querySelector('.input-bar')?.nextElementSibling?.id, 'afterComposer');
  assert.equal(document.querySelector('.input-bar')?.previousElementSibling?.className, 'question-host');
  assert.equal(queryCodeMapChatHost(), null);
  assert.equal(getActiveChatMountElement(), document.getElementById('chatArea'));
});

test('another map question starts fresh and map teardown does not destroy composer nodes', async () => {
  await openCodeMapChat(makeRequest('First question'));
  const firstId = sessionState.activeId;
  const composer = document.querySelector('.input-bar');
  await openCodeMapChat(makeRequest('Second question'));
  assert.notEqual(sessionState.activeId, firstId);
  assert.equal(document.querySelectorAll('#codeMapChatSidebar').length, 1);
  teardownCodeBrainMapBeforeChatPaint();
  assert.equal(document.getElementById('codeBrainMapRoot'), null);
  assert.equal(composer?.parentElement?.id, 'mainColumn');
  assert.equal(queryCodeMapChatHost(), null);
});

function makeRequest(question: string) {
  return { card: { question, title: 'main.ts', kind: 'file', path: 'src/main.ts' }, prompt: question + '\nHidden indexed source context' };
}

test('send failures stay in the sidebar and can retry without exposing the agent prompt', async () => {
  failSend = true;
  await openCodeMapChat(makeRequest('Explain'));
  assert.match(document.querySelector('[role=alert]')?.textContent || '', /Select a model/);
  assert.equal((document.getElementById('msgInput') as HTMLTextAreaElement).value, '');
  assert.ok(!document.body.textContent?.includes('Hidden indexed source context'));
  failSend = false;
  document.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, 1);
});
