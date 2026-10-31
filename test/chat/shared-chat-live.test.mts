import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHostChatCommandHandler, createSharedChatObserver, createSharedChatPublisher } from '../../src/chat/shared-chat-bridge.ts';
import { applySharedChatFrame, createEmptyChatObject, getSessionDirtyTrackingForTests, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { registerChatStreamText, notifyChatStreamEnded } from '../../src/chat/streaming-state.ts';
import { setChatAbort, setStreaming, streamingChatIds } from '../../src/app-state.ts';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { setRemoteChatTurns, isChatRunningRemotely } from '../../src/chat/remote-turn-state.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { persistComposerDraftOnChat, applyComposerDraftForChat } from '../../src/ui/composer-draft.ts';
import { sendMessageWithTools } from '../../src/chat/messaging.ts';
import { stopGeneration } from '../../src/chat/stop-generation.ts';
import { renderChatFromHistory } from '../../src/ui/messages.ts';
import type { SharedChatFrame } from '../../src/chat/shared-chat-protocol.ts';
import type { RemoteChatCommand } from '../../src/chat/remote-chat-client.ts';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';
import type { Chat } from '../../src/types';
import { renameChatTitle } from '../../src/state/sessions';
import { setChatPinned } from '../../src/state/chat-groups';
import { setChatArchived } from '../../src/state/chat-archive';
import { onActiveChatModelChange } from '../../src/ui/chat-model-ui';
import { setChatMode } from '../../src/ui/mode-selector';
import { hasCurrentChatSurface } from '../../src/ui/chat-surface-state';

const CHAT = '11111111-1111-1111-1111-111111111111';
const originalFetch = globalThis.fetch;

function setup() {
  document.body.innerHTML = '<div id="chatArea"></div><textarea id="msgInput"></textarea><button id="sendBtn"></button>';
  const chat = createEmptyChatObject('model');
  chat.id = CHAT;
  chat.history = [{ role: 'user', content: 'Build it' }];
  setSessionStateForTests({ version: 6, activeId: CHAT, sidebarCollapsed: false, chats: [chat] });
  return chat;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setPairedDevice(false);
  setStreaming(false);
  setRemoteChatTurns([]);
  setChatAbort(CHAT, null);
  notifyChatStreamEnded(CHAT);
  resetSessionPersistenceForTests();
  setStorageModeForTests('localStorage');
  setSessionStateForTests(null);
});

test('publisher streams token differences, indexed tool messages and a terminal frame without waiting for session polling', async () => {
  const chat = setup();
  let text = { lastDelta: '', lastThinking: '', toolCallCount: 0 };
  registerChatStreamText(CHAT, () => text);
  const frames: Partial<SharedChatFrame>[] = [];
  const publisher = createSharedChatPublisher(async frame => { frames.push(structuredClone(frame)); });
  try {
    await publisher.update(CHAT, { type: 'round_start', index: 0 }, true);
    text = { ...text, lastDelta: 'Hello', lastThinking: 'Plan' };
    await publisher.update(CHAT, { type: 'delta', text: 'Hello' }, true);
    text = { ...text, lastDelta: 'Hello world', lastThinking: 'Plan ahead' };
    await publisher.update(CHAT, { type: 'delta', text: ' world' }, true);
    const token = frames.at(-1)!;
    assert.deepEqual(token.liveAppend, { textOffset: 5, thinkingOffset: 4, text: ' world', thinking: ' ahead' });
    assert.equal(token.history, undefined, 'tokens do not resend the transcript');
    chat.history.push({ role: 'assistant', content: 'Hello world' });
    await publisher.update(CHAT, { type: 'round_end', index: 0, toolCallCount: 0 } as any, true);
    assert.equal(frames.at(-1)!.history!.start, 1);
    assert.equal(frames.at(-1)!.history!.messages.length, 1);
    await publisher.update(CHAT, undefined, false);
    assert.equal(frames.at(-1)!.running, false, 'terminal state is sent even when prose did not change');
    assert.equal(frames.at(-1)!.live, null);
  } finally { publisher.dispose(); }
});

test('observer-only metadata invalidates a mounted view without marking the transcript dirty', () => {
  const chat = setup();
  renderChatFromHistory(chat);
  const area = document.getElementById('chatArea')!;
  assert.equal(hasCurrentChatSurface(area, chat), true);
  const before = getSessionDirtyTrackingForTests().dirtyChatIds;
  applySharedChatFrame(CHAT, { turnError: true });
  assert.equal(hasCurrentChatSurface(area, chat), false);
  assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, before);
});

test('phone paints live reasoning/prose, reconnects without duplicates, then displays the PC final result', async () => {
  const chat = setup();
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'pc', sequence: 1, epoch: 'turn', running: true,
    fields: { name: 'Shared chat' }, live: { lastDelta: 'Hello', lastThinking: 'Thinking', toolCallCount: 0 } };
  try {
    await observer.receive(frame);
    await observer.receive({ chatId: CHAT, hostId: 'pc', sequence: 2, epoch: 'turn', running: true,
      liveAppend: { textOffset: 5, thinkingOffset: 8, text: ' world', thinking: ' more' } });
    assert.match(document.getElementById('chatArea')!.textContent!, /Hello world/);
    assert.equal(chat.history.length, 1, 'streamed tokens are a view, not a second persisted message');
    assert.equal(streamingChatIds.has(CHAT), false);
    assert.equal(isChatRunningRemotely(CHAT), true);
    observer.reconnect();
    await observer.receive({ ...frame, sequence: 2, live: { lastDelta: 'Hello world', lastThinking: 'Thinking more', toolCallCount: 0 } });
    assert.equal(document.querySelectorAll('.msg.assistant').length, 1);
    await observer.receive({ chatId: CHAT, hostId: 'pc', sequence: 3, epoch: 'turn', running: false, live: null,
      fields: { turnError: false, currentGenerationId: null },
      history: { start: 1, length: 2, messages: [{ role: 'assistant', content: 'Hello world' }] } });
    assert.equal(chat.history.length, 2);
    assert.equal(document.querySelectorAll('.msg.assistant').length, 1);
    assert.equal(isChatRunningRemotely(CHAT), false);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(CHAT), false);
    await observer.receive(frame);
    assert.equal(chat.history.length, 2, 'late frames cannot put a completed reply back into streaming');
  } finally { observer.dispose(); }
});

test('PC admits phone send once, queues and steers on its engine, and Stop aborts that same run', async () => {
  const chat = setup();
  let calls = 0;
  let runningSignal: AbortSignal | undefined;
  const handler = createHostChatCommandHandler(async () => {}, {
    persist: async () => true,
    send: async (_chat, text, options) => {
      calls++;
      assert.equal(text, 'Phone message');
      assert.equal(options.clearComposerOnSend, false);
      runningSignal = options.signal;
      setStreaming(true, CHAT);
      await options.onUserMessageAccepted?.();
      await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => { setStreaming(false, CHAT); resolve(); }, { once: true }));
    },
  });
  const command: RemoteChatCommand = { id: 'first', deliveryId: 'phone:first', chatId: CHAT, action: 'send', text: 'Phone message' };
  await Promise.all([handler(command), handler(command)]);
  assert.equal(calls, 1);
  await handler({ id: 'second', chatId: CHAT, action: 'send', text: 'Follow-up' });
  assert.equal(chat.pendingMessageQueue?.[0].text, 'Follow-up');
  await handler({ id: 'third', chatId: CHAT, action: 'push', itemId: chat.pendingMessageQueue![0].id });
  assert.equal(chat.pendingSteerMessage, 'Follow-up');
  assert.equal(chat.pendingMessageQueue, undefined);
  await handler({ id: 'stop', chatId: CHAT, action: 'stop' });
  assert.equal(runningSignal!.aborted, true);
  assert.equal(calls, 1);
  const reloaded = normalizeChatRow(JSON.parse(JSON.stringify(chat))) as Chat;
  assert.ok(reloaded.remoteCommandReceipts?.includes(command.deliveryId!));
  setSessionStateForTests({ version: 6, activeId: CHAT, sidebarCollapsed: false, chats: [reloaded] });
  const reloadedHandler = createHostChatCommandHandler(async () => {}, { persist: async () => true,
    send: async () => { throw new Error('must not resend a persisted receipt'); } });
  await reloadedHandler(command);
});

test('phone queue edits and steering cancellation reach the owner without replacing its draft', async () => {
  const chat = setup();
  chat.composerDraft = 'computer draft';
  chat.pendingMessageQueue = [{ id: 'queued', text: 'original', createdAt: 1 }];
  chat.pendingSteerMessage = 'correction';
  setStreaming(true, CHAT);
  const handler = createHostChatCommandHandler(async () => {}, { persist: async () => true });
  await handler({ id: 'edit', chatId: CHAT, action: 'edit', itemId: 'queued', text: 'revised' });
  await handler({ id: 'cancel', chatId: CHAT, action: 'cancel-steer' });
  assert.equal(chat.pendingMessageQueue[0].text, 'revised');
  assert.equal(chat.pendingSteerMessage, undefined);
  assert.equal(chat.composerDraft, 'computer draft');
  assert.equal(streamingChatIds.has(CHAT), true);
});

test('an already-open stale phone transcript hydrates its missing prefix before applying the live turn', async () => {
  const chat = setup();
  const observer = createSharedChatObserver(() => {});
  globalThis.fetch = async input => {
    assert.match(String(input), /sessions\/history\//);
    return Response.json({ chatId: CHAT, history: [
      { role: 'user', content: 'Build it' }, { role: 'assistant', content: 'Previous completed reply' },
    ] });
  };
  try {
    await observer.receive({ chatId: CHAT, hostId: 'pc', sequence: 1, epoch: 'next', running: true,
      history: { start: 2, length: 3, messages: [{ role: 'user', content: 'Continue from phone' }] },
      live: { lastDelta: 'Working now', lastThinking: '', toolCallCount: 0 } });
    assert.equal(chat.history.length, 3);
    assert.equal(chat.history[1].content, 'Previous completed reply');
    assert.equal(chat.history[2].content, 'Continue from phone');
  } finally { observer.dispose(); }
});

test('phone chat settings use PC commands instead of racing its transcript persistence', async () => {
  const chat = setup();
  const original = { name: chat.name, modelId: chat.modelId, modeId: chat.modeId };
  setPairedDevice(true);
  const commands: RemoteChatCommand[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/chat-sync/commands');
    const command = JSON.parse(String(init?.body));
    commands.push(command);
    return Response.json({ id: `phone:${command.id}`, ok: true, pending: false }, { status: 202 });
  };
  renameChatTitle(CHAT, 'Phone title');
  setChatPinned(chat, true);
  setChatArchived(chat, true);
  onActiveChatModelChange('another-model');
  assert.equal(setChatMode('build', chat).ok, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(commands.length, 5);
  assert.ok(commands.every(command => command.action === 'configure'));
  assert.equal(chat.name, original.name);
  assert.equal(chat.modelId, original.modelId);
  assert.equal(chat.modeId, original.modeId);
  assert.equal(chat.pinnedAt, undefined);
  assert.equal(chat.archivedAt, undefined);
});

test('host archive commands publish metadata and leave the active transcript intact', async () => {
  const chat = setup();
  const history = structuredClone(chat.history);
  const frames: any[] = [];
  const publisher = createSharedChatPublisher(async frame => { frames.push(frame); });
  const handler = createHostChatCommandHandler(async (chatId, running) => {
    await publisher.update(chatId, undefined, running);
  }, { persist: async () => true });
  try {
    await handler({ id: 'archive', chatId: CHAT, action: 'configure', patch: { archived: true } });
    assert.ok(chat.archivedAt! > 0);
    assert.equal(frames.at(-1).fields.archivedAt, chat.archivedAt);
    assert.deepEqual(chat.history, history);
    await handler({ id: 'restore', chatId: CHAT, action: 'configure', patch: { archived: false } });
    assert.equal(chat.archivedAt, undefined);
    assert.equal(frames.at(-1).fields.archivedAt, null);
    assert.deepEqual(chat.history, history);
  } finally { publisher.dispose(); }
});

test('phone send and Stop use the shared command API and keep drafts outside the PC chat', async () => {
  const chat = setup();
  chat.composerDraft = 'Unsent PC draft';
  setPairedDevice(true);
  persistComposerDraftOnChat(chat, 'Phone draft');
  assert.equal(chat.composerDraft, 'Unsent PC draft');
  applyComposerDraftForChat(chat);
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  assert.equal(input.value, 'Phone draft');
  const commands: RemoteChatCommand[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/chat-sync/commands', 'phone must not call generations, tools or session writes');
    const body = JSON.parse(String(init?.body));
    commands.push(body);
    return Response.json({ id: `phone:${body.id}`, ok: true, pending: false }, { status: 202 });
  };
  await sendMessageWithTools({ inputEl: input });
  assert.equal(input.value, '');
  assert.equal(chat.composerDraft, 'Unsent PC draft');
  assert.equal(chat.history.length, 1);
  stopGeneration(CHAT);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(commands.map(command => command.action), ['send', 'stop']);
  assert.equal(commands[0].text, 'Phone draft');
});
