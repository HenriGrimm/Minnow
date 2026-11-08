import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHostChatCommandHandler, createSharedChatObserver, createSharedChatPublisher } from '../../src/chat/shared-chat-bridge.ts';
import { applySharedChatFrame, createEmptyChatObject, getSessionDirtyTrackingForTests, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { registerChatStreamText, notifyChatStreamEnded } from '../../src/chat/streaming-state.ts';
import { setChatAbort, setStreaming, streamingChatIds } from '../../src/app-state.ts';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { setRemoteChatTurns, setRemoteChatPresence, isChatRunningRemotely } from '../../src/chat/remote-turn-state.ts';
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
import { initChatScroll } from '../../src/ui/chat-scroll';
import { refreshRemoteChatTurns } from '../../src/chat/turn-ownership';

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
  setRemoteChatTurns([], 'managed');
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

test('an idle accepted send appears in the transcript until its canonical input arrives without duplicating saved history', async () => {
  const chat = setup(); chat.chatCommandVersion = 1; chat.history = [];
  globalThis.fetch = async () => Response.json({ runs: [] });
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  const pending = { id: 'first-input', text: 'Review the chat', createdAt: 1,
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } };
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'minnow-server', sequence: 1, epoch: 'idle', running: false, live: null,
    fields: { pendingMessageQueue: [pending], agentPendingCommand: { commandId: pending.id, state: 'queued', held: false } } };
  try {
    await observer.receive(frame);
    const row = document.querySelector('.msg.user.msg--sending')!;
    assert.ok(row);
    assert.match(row.textContent!, /Review the chat/);
    assert.equal(row.querySelector('[role="status"]'), null);
    const sending = row.nextElementSibling!;
    assert.ok(sending.matches('.msg.assistant.msg--sending-status'));
    assert.equal(sending.querySelector('.stream-status__label')?.textContent, 'Sending…');
    assert.equal(sending.querySelectorAll('.activity-shimmer__dot').length, 3);
    assert.equal(row.hasAttribute('data-history-index'), false);
    assert.equal(row.querySelector('.message-actions'), null);
    assert.equal(document.getElementById('composerMessageQueue')!.classList.contains('hidden'), true);
    assert.equal(chat.history.length, 0);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(CHAT), false);
    // A repeated snapshot or remount preserves one view of the same accepted input.
    await observer.receive({ ...frame, sequence: 2 });
    assert.equal(document.querySelectorAll('.msg.user').length, 1);
    const canonical = { role: 'user' as const, content: pending.text, commandId: pending.id, provenance: pending.provenance };
    await observer.receive({ ...frame, sequence: 3, running: true, epoch: 'new-turn',
      fields: { pendingMessageQueue: null, agentPendingCommand: null, agentExecution: { executionId: 'new-turn', status: 'running' } },
      history: { start: 0, length: 1, messages: [canonical as any] } });
    assert.equal(chat.history.length, 1);
    assert.equal(document.querySelectorAll('.msg.user').length, 1);
    assert.equal(document.querySelector('.msg--sending'), null);
    assert.equal(document.querySelector('.msg--sending-status'), null);
    assert.equal(document.querySelector('.msg.user')?.getAttribute('data-history-index'), '0');
  } finally { observer.dispose(); }
});

test('pending input keeps human attribution and exact command identity when rendered before execution', () => {
  const chat = setup(); chat.chatCommandVersion = 1;
  globalThis.fetch = async () => Response.json({ runs: [] });
  const item = { id: 'pending', text: 'Build it', createdAt: 1,
    provenance: { version: 1 as const, actor: 'human' as const, source: 'composer' as const, kind: 'human_message' as const } };
  chat.pendingMessageQueue = [item];
  chat.agentPendingCommand = { commandId: item.id, runId: null, state: 'queued', held: false };
  renderChatFromHistory(chat);
  assert.equal(document.querySelectorAll('.msg.user').length, 2, 'equal text from another command is a separate message');
  chat.history[0] = { role: 'user', content: item.text, commandId: item.id };
  renderChatFromHistory(chat);
  assert.equal(document.querySelectorAll('.msg.user').length, 1, 'the exact canonical input replaces its pending view');
  chat.history = [];
  for (const patch of [{ provenance: { ...item.provenance, actor: 'system' } }, { hiddenFromTranscript: true }]) {
    chat.pendingMessageQueue = [{ ...item, ...patch } as any];
    renderChatFromHistory(chat);
    assert.equal(document.querySelector('.msg--sending'), null, 'hidden and non-human input cannot be attributed to the user');
    assert.equal(document.getElementById('composerMessageQueue')!.classList.contains('hidden'), false);
  }
});

test('running managed steering shows separate image bubbles immediately and replaces them once', () => {
  const chat = setup(); chat.chatCommandVersion = 1;
  globalThis.fetch = async () => Response.json({ runs: [] });
  const provenance = { version: 1 as const, actor: 'human' as const, source: 'composer' as const, kind: 'human_message' as const };
  const images = [{ name: 'screen.png', dataUrl: 'data:image/png;base64,YWJjZA==' }];
  chat.agentExecution = { executionId: 'active-steering', commandId: 'original', status: 'running', createdAt: 1, updatedAt: 1 };
  chat.pendingMessageQueue = [{ id: 'first-steer', text: 'Use this screenshot\n\n[image: screen.png]', kind: 'steer', createdAt: 2, provenance, images },
    { id: 'second-steer', text: 'Keep the existing controls', kind: 'steer', createdAt: 3, provenance }];
  renderChatFromHistory(chat);
  const pending = [...document.querySelectorAll('.msg--sending')];
  assert.equal(pending.length, 2);
  assert.equal(pending[0].querySelector('img')?.getAttribute('src'), images[0].dataUrl);
  assert.equal(document.querySelector('.msg-send-status, .msg-steer-chip'), null);
  assert.equal(document.getElementById('composerMessageQueue')!.classList.contains('hidden'), true);
  const items = chat.pendingMessageQueue;
  chat.history.push(...items.map(item => ({ role: 'user' as const, content: item.text, commandId: item.id, provenance, images: item.images, steer: true })));
  renderChatFromHistory(chat);
  assert.equal(document.querySelectorAll('.msg--sending').length, 0, 'canonical rows win even before pending metadata catches up');
  assert.equal(document.querySelectorAll('.msg.user').length, 3);
});

test('execution metadata arriving before canonical history keeps the first input visible', async () => {
  const chat = setup(); chat.chatCommandVersion = 1; chat.history = [];
  globalThis.fetch = async () => Response.json({ runs: [] });
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  const item = { id: 'starting-input', text: 'Keep this visible', createdAt: 1,
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } };
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'minnow-server', sequence: 1, epoch: 'idle', running: false, live: null,
    fields: { pendingMessageQueue: [item], agentPendingCommand: { commandId: item.id, state: 'accepted', held: false } } };
  try {
    await observer.receive(frame);
    const row = document.querySelector('.msg--sending');
    assert.ok(row);
    await observer.receive({ ...frame, sequence: 2, running: true, epoch: 'starting',
      fields: { pendingMessageQueue: null, agentPendingCommand: null,
        agentExecution: { commandId: item.id, executionId: 'starting', status: 'running' } } });
    assert.equal(document.querySelector('.msg--sending'), row, 'the accepted row survives the metadata/history gap');
    assert.equal(document.getElementById('vibeHub'), null, 'the new chat screen must not return during startup');
    assert.equal(chat.history.length, 0, 'the pending echo never writes to saved history');
    await observer.receive({ ...frame, sequence: 3, running: true, epoch: 'starting', fields: {},
      history: { start: 0, length: 1, messages: [{ role: 'user', content: item.text, commandId: item.id }] } });
    assert.equal(document.querySelectorAll('.msg.user').length, 1);
    assert.equal(document.querySelector('.msg--sending'), null);
  } finally { observer.dispose(); }
});

test('tool results, subsequent rounds and metadata retain existing rows and expanded details', async () => {
  const chat = setup(); chat.chatCommandVersion = 1;
  globalThis.fetch = async () => Response.json({ runs: [] });
  chat.history.push({ role: 'assistant', content: 'I will inspect the files.', tool_calls: [
    { id: 'read-one', type: 'function', function: { name: 'read_file', arguments: '{"path":"one.ts"}' } },
    { id: 'read-two', type: 'function', function: { name: 'read_file', arguments: '{"path":"two.ts"}' } },
  ] });
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'minnow-server', sequence: 1, epoch: 'working', running: true, live: null,
    fields: { agentExecution: { executionId: 'working', status: 'running' } } };
  try {
    await observer.receive(frame);
    const user = document.querySelector('.msg.user');
    const assistant = document.querySelector('.msg.assistant');
    const batch = document.querySelector<HTMLDetailsElement>('.tool-call-batch')!;
    const tool = document.querySelector<HTMLElement>('[data-tool-call-id="read-one"]')!;
    const details = tool.querySelector<HTMLDetailsElement>('details')!;
    batch.open = true; details.open = true;
    const summary = details.querySelector('summary')!;
    summary.focus();
    await observer.receive({ ...frame, sequence: 2, history: { start: 2, length: 3,
      messages: [{ role: 'tool', tool_call_id: 'read-one', content: 'First file contents' }] } });
    assert.equal(document.querySelector('.msg.user'), user);
    assert.equal(document.querySelector('.msg.assistant'), assistant);
    assert.equal(document.querySelector('.tool-call-batch'), batch);
    assert.equal(document.querySelector('[data-tool-call-id="read-one"]'), tool);
    assert.equal(details.open, true);
    assert.equal(batch.open, true);
    assert.equal(document.activeElement, summary);
    assert.match(tool.textContent!, /First file contents/);
    assert.equal(tool.hasAttribute('aria-busy'), false);
    await observer.receive({ ...frame, sequence: 3, history: { start: 3, length: 4,
      messages: [{ role: 'assistant', content: 'Now checking the next part.' }] } });
    await observer.receive({ ...frame, sequence: 4, fields: { name: 'Updated title' } });
    assert.equal(document.querySelector('.msg.user'), user);
    assert.equal(document.querySelector('.tool-call-batch'), batch);
    assert.equal(details.open, true);
    assert.equal(document.querySelectorAll('.msg.assistant').length, 2);
    assert.equal(document.querySelectorAll('.tool-call-msg').length, 2);
    await observer.receive({ ...frame, sequence: 5, running: false, fields: { agentExecution: { status: 'completed' } } });
    assert.equal(document.querySelector('.tool-call-batch'), batch, 'settling a turn also preserves disclosures');
  } finally { observer.dispose(); }
});

test('metadata refreshes retain the current streaming row but real history edits repaint', async () => {
  const chat = setup(); chat.chatCommandVersion = 1;
  globalThis.fetch = async () => Response.json({ runs: [] });
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'minnow-server', sequence: 1, epoch: 'working', running: true,
    fields: { name: 'Working' }, live: { lastDelta: 'A live answer', lastThinking: '', toolCallCount: 0 } };
  try {
    await observer.receive(frame);
    const user = document.querySelector('.msg.user');
    const live = document.querySelector('.msg.assistant');
    await observer.receive({ ...frame, sequence: 2, fields: { name: 'Still working' } });
    assert.equal(document.querySelector('.msg.user'), user);
    assert.equal(document.querySelector('.msg.assistant'), live);
    await observer.receive({ ...frame, sequence: 3, running: false, live: null,
      history: { start: 0, length: 1, messages: [{ role: 'user', content: 'A corrected message' }] } });
    assert.match(document.querySelector('.msg.user')!.textContent!, /A corrected message/);
    assert.notEqual(document.querySelector('.msg.user'), user, 'edits cannot reuse stale rendered content');
  } finally { observer.dispose(); }
});

test('appending managed output preserves an up-thread reader instead of their distance from the bottom', async () => {
  const chat = setup(); chat.chatCommandVersion = 1;
  chat.history = Array.from({ length: 8 }, (_, i) => i % 2
    ? { role: 'assistant' as const, content: `Answer ${i}` }
    : { role: 'user' as const, content: `Question ${i}` });
  globalThis.fetch = async () => Response.json({ runs: [] });
  const area = document.getElementById('chatArea')!;
  let top = 0;
  Object.defineProperties(area, {
    scrollHeight: { get: () => area.querySelectorAll('.msg[data-history-index]').length * 100 },
    clientHeight: { value: 300 }, offsetHeight: { value: 300 },
    scrollTop: { get: () => top, set: value => { top = value; } },
  });
  area.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 300, width: 800, height: 300, toJSON() {} });
  initChatScroll();
  renderChatFromHistory(chat);
  for (const row of area.querySelectorAll<HTMLElement>('.msg[data-history-index]')) {
    const index = Number(row.dataset.historyIndex);
    row.getBoundingClientRect = () => ({ x: 0, y: index * 100 - top, top: index * 100 - top,
      left: 0, right: 800, bottom: (index + 1) * 100 - top, width: 800, height: 100, toJSON() {} });
  }
  area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -300 }));
  top = 200; area.dispatchEvent(new window.Event('scroll'));
  const visible = area.querySelector<HTMLElement>('[data-history-index="2"]')!;
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  try {
    await observer.receive({ chatId: CHAT, hostId: 'minnow-server', sequence: 1, epoch: 'next', running: true, live: null,
      history: { start: 8, length: 10, messages: [
        { role: 'user', content: 'Next question' }, { role: 'assistant', content: 'New output below the reader' },
      ] } });
    assert.equal(top, 200, 'new output below the viewport cannot move the reader');
    assert.equal(area.querySelector('[data-history-index="2"]'), visible);
    assert.equal(visible.getBoundingClientRect().top, 0);
  } finally { observer.dispose(); }
});

test('managed observer emits one payload-free received-to-DOM timing and disposes queued frames', async () => {
  const chat = setup(); let clock = 0;
  const events: unknown[] = [];
  const observer = createSharedChatObserver(() => {}, { clock: () => clock, onTiming: event => events.push(event) });
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'server', sequence: 1, epoch: 'execution', running: true,
    live: { lastDelta: 'Visible prose', lastThinking: '', toolCallCount: 0 } };
  const pending = observer.receive(frame); clock = 45;
  await pending;
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).stage, 'first_prose_dom');
  assert.equal((events[0] as any).durationMs, 45);
  assert.equal(JSON.stringify(events).includes('Visible prose'), false);
  await observer.receive({ ...frame, sequence: 2, live: { ...frame.live!, lastDelta: 'Visible prose continued' } });
  assert.equal(events.length, 1);
  const queued = observer.receive({ ...frame, sequence: 3, live: { ...frame.live!, lastDelta: 'Do not repaint disposed viewer' } });
  observer.dispose(); await queued;
  assert.doesNotMatch(document.body.textContent!, /Do not repaint disposed/);
  assert.equal(chat.history.length, 1, 'diagnostics and streaming never write canonical content');
});

test('repeated shared thinking snapshots keep a single visible reasoning indicator', async () => {
  setup();
  const observer = createSharedChatObserver(() => {});
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'pc', sequence: 1, epoch: 'turn', running: true,
    live: { lastDelta: '', lastThinking: 'Inspecting the renderer', phase: 'thinking', toolCallCount: 0 } };
  try {
    await observer.receive(frame);
    await observer.receive({ ...frame, sequence: 2,
      live: { ...frame.live!, lastThinking: 'Inspecting the renderer and status labels' } });
    assert.equal(document.querySelectorAll('.thought-stage .thoughts-toggle').length, 1);
    assert.equal(document.querySelectorAll('.stream-status:not(.hidden)').length, 0);
  } finally { observer.dispose(); }
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

test('legacy presence refreshes cannot settle a managed turn or clear its live output', async () => {
  const chat = setup(); chat.chatCommandVersion = 1;
  chat.history.push({ role: 'assistant', content: null, tool_calls: [
    { id: 'map', type: 'function', function: { name: 'code_map', arguments: '{}' } },
  ] });
  globalThis.fetch = async () => Response.json({ runs: [] });
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'minnow-server', sequence: 1, epoch: 'managed-turn', running: true,
    fields: { agentExecution: { executionId: 'managed-turn', status: 'running' } },
    live: { lastDelta: 'Reviewing the chat', lastThinking: '', toolCallCount: 0 } };
  try {
    await observer.receive(frame);
    setRemoteChatTurns(['legacy-chat']);
    setRemoteChatTurns([]);
    assert.equal(isChatRunningRemotely(CHAT), true, 'legacy lease lists do not include server-owned executions');
    renderChatFromHistory(chat);
    assert.equal(document.querySelector('.chat-work')?.getAttribute('data-outcome'), 'live');
    await observer.receive({ ...frame, sequence: 2, live: { ...frame.live!, lastDelta: 'The review is still running' } });
    assert.match(document.getElementById('chatArea')!.textContent!, /review is still running/);
    await observer.receive({ ...frame, sequence: 3, running: false, live: null,
      fields: { agentExecution: { executionId: 'managed-turn', status: 'completed' } },
      history: { start: 2, length: 4, messages: [
        { role: 'tool', tool_call_id: 'map', content: 'Mapped the chat files' },
        { role: 'assistant', content: 'Review finished' },
      ] } });
    assert.equal(isChatRunningRemotely(CHAT), false);
    assert.equal(document.querySelector('.chat-work')?.getAttribute('data-outcome'), 'done');
  } finally { observer.dispose(); }
});

test('a mixed ownership refresh cannot keep a completed managed chat working', async () => {
  const chat = setup(); chat.chatCommandVersion = 1;
  setStorageModeForTests('server');
  document.body.insertAdjacentHTML('beforeend', '<div id="composerRunStatus" hidden><span class="composer-run-status__time"></span><span class="composer-run-status__count"></span></div>');
  globalThis.fetch = async input => String(input) === '/api/chat-turns'
    ? Response.json({ turns: [
      { chatId: CHAT, ownerId: 'minnow-server', hostId: 'minnow-server', executionId: 'managed-turn' },
      { chatId: 'legacy-chat', ownerId: 'other-owner', hostId: 'other-window' },
    ] }) : Response.json({ runs: [] });
  const observer = createSharedChatObserver(active => { if (active) renderChatFromHistory(chat); });
  const frame: SharedChatFrame = { chatId: CHAT, hostId: 'minnow-server', sequence: 1, epoch: 'managed-turn', running: true,
    fields: { agentExecution: { executionId: 'managed-turn', status: 'running' } },
    live: { lastDelta: 'Reviewing the project', lastThinking: '', toolCallCount: 0 } };
  try {
    await observer.receive(frame);
    await refreshRemoteChatTurns();
    assert.equal(isChatRunningRemotely(CHAT), true, 'a legacy refresh preserves managed live activity');
    assert.equal(isChatRunningRemotely('legacy-chat'), true);
    assert.equal(document.getElementById('sendBtn')!.dataset.mode, 'stop');
    assert.equal((document.getElementById('composerRunStatus') as HTMLElement).hidden, false);
    await observer.receive({ ...frame, sequence: 2, running: false, live: null,
      fields: { agentExecution: { executionId: 'managed-turn', status: 'completed' } },
      history: { start: 1, length: 2, messages: [{ role: 'assistant', content: 'Review finished' }] } });
    assert.equal(isChatRunningRemotely(CHAT), false);
    assert.equal(isChatRunningRemotely('legacy-chat'), true, 'unrelated legacy work stays active');
    assert.equal(document.getElementById('sendBtn')!.dataset.mode, 'send');
    assert.equal(document.getElementById('sendBtn')!.getAttribute('aria-busy'), 'false');
    assert.equal((document.getElementById('composerRunStatus') as HTMLElement).hidden, true);
    assert.equal(document.querySelector('.chat-work--live'), null);
    assert.match(document.getElementById('chatArea')!.textContent!, /Review finished/);
    setRemoteChatPresence([
      { chatId: CHAT, ownerId: 'minnow-server', hostId: 'minnow-server' },
      { chatId: 'legacy-chat', ownerId: 'other-owner', hostId: 'other-window' },
    ]);
    assert.equal(isChatRunningRemotely(CHAT), false, 'a delayed legacy presence from an older server cannot revive managed work');
    assert.equal(isChatRunningRemotely('legacy-chat'), true);
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
  assert.equal(chat.pendingMessageQueue?.[0]?.kind, 'steer');
  assert.equal(chat.pendingMessageQueue?.[0]?.text, 'Follow-up');
  assert.equal(chat.pendingMessageQueue?.length, 1);
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
