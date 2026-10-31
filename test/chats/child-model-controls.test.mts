import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEmptyChatObject, setSessionStateForTests, resetSessionPersistenceForTests, applySharedChatFrame, getSessionDirtyTrackingForTests } from '../../src/state/sessions.ts';
import { configureManagedChatModel, isManagedModelBusy, managedReasoningSelection, stopAndSwitchManagedChat, syncAgentModelControls } from '../../src/ui/managed-chat-model.ts';
import { notifyManagedChatMetadata } from '../../src/chat/managed-chat-view.ts';
import { onActiveChatModelChange } from '../../src/ui/chat-model-ui.ts';
import { modelCache } from '../../src/app-state.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { getComposerReasoningState, setComposerReasoningChoice } from '../../src/ui/composer-reasoning-effort.ts';
import { persistDefaultModelValue, readDefaultModelBinding } from '../../src/models/selection.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { initThinkingControl, syncThinkingControlFromActiveChat } from '../../src/ui/composer-thinking.ts';

const originalFetch = globalThis.fetch;
Object.assign(globalThis, { sessionStorage: window.sessionStorage, localStorage: window.localStorage });
let nextId = 0;
function setup() {
  const chat = createEmptyChatObject('old'); chat.id = `model-controls-${++nextId}`; chat.providerId = 'provider';
  chat.chatCommandVersion = 1; chat.profileReference = { profileId: 'profile', profileVersion: 3 };
  chat.agentConversation = { version: 1, childChatId: chat.id, parentChatId: 'parent', rootChatId: 'parent', journalOwnerId: 'parent', origin: 'delegated', createdAt: 1,
    capabilities: { canSend: true, canStop: true, canChooseModel: true } };
  chat.agentModelSelection = { providerId: 'provider', modelId: 'old', options: { reasoningEffort: 'low', thinkingBudgetTokens: 1024 } };
  chat.reasoningEffort = 'low';
  chat.agentExecution = { executionId: 'running-execution', status: 'running', modelSelection: structuredClone(chat.agentModelSelection) };
  chat.pendingMessageQueue = [{ id: 'queued', text: 'Review later', createdAt: 1, commandRevision: 2, modelSelection: structuredClone(chat.agentModelSelection) }];
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  document.body.innerHTML = '<div data-agent-chat-controls></div>';
  const host = document.querySelector<HTMLElement>('[data-agent-chat-controls]')!; host.dataset.agentChatControls = chat.id;
  syncAgentModelControls(chat, host);
  return { chat, host };
}
async function idle(chatId: string) {
  for (let count = 0; count < 100 && isManagedModelBusy(chatId); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(isManagedModelBusy(chatId), false);
}
function applyReceipt(event: Event) {
  const detail = (event as CustomEvent).detail;
  if (detail.frame?.fields) { applySharedChatFrame(detail.chatId, detail.frame.fields); notifyManagedChatMetadata(detail.chatId); }
}
window.addEventListener('minnow:managed-chat-change', applyReceipt);
afterEach(() => {
  globalThis.fetch = originalFetch; modelCache.clear(); resetSessionPersistenceForTests(); setSessionStateForTests(null);
  setStorageModeForTests(null); sessionStorage.clear(); document.body.replaceChildren();
});

test('child picker saves only a complete next-message selection and never remembers it or stops active work', async () => {
  const { chat, host } = setup(); setStorageModeForTests('localStorage');
  await persistDefaultModelValue(encodeModelSelectKey('remembered', 'default'));
  const captured = structuredClone(chat.agentExecution), queued = structuredClone(chat.pendingMessageQueue);
  const requests: any[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options?.method, body: JSON.parse(String(options?.body)) });
    return Response.json({ frame: { fields: { providerId: 'next-provider', modelId: 'next', reasoningEffort: null,
      agentModelSelection: { providerId: 'next-provider', modelId: 'next', options: {} } } } });
  };
  onActiveChatModelChange(encodeModelSelectKey('next-provider', 'next'), chat); await idle(chat.id);
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'PATCH');
  assert.deepEqual(requests[0].body.selection, { providerId: 'next-provider', modelId: 'next', options: {} });
  assert.equal(requests[0].body.expectedProfileVersion, 3);
  assert.equal(readDefaultModelBinding().providerId, 'remembered');
  assert.deepEqual(chat.agentExecution, captured); assert.deepEqual(chat.pendingMessageQueue, queued);
  assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []);
  assert.match(host.textContent!, /New messages: next/); assert.match(host.textContent!, /Stop and switch/);
});

test('reasoning changes use the child pair and preserve explicit budgets without changing its running or queued snapshot', async () => {
  const { chat } = setup(); const bodies: any[] = [];
  modelCache.set(encodeModelSelectKey('provider', 'old'), { id: 'old', reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' }, capabilities: { vision: false, tools: true, streaming: true, grammar: null,
    reasoning: true, reasoningAllowedOptions: ['off', 'low', 'medium', 'high'], reasoningDefault: 'medium', contextLength: null, loadState: null } });
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({}); };
  assert.equal(getComposerReasoningState().disabled, false, 'next-message controls remain available during a server-owned reply');
  setComposerReasoningChoice('high'); await idle(chat.id);
  assert.deepEqual(bodies[0].selection, { providerId: 'provider', modelId: 'old', options: { reasoningEffort: 'high', thinkingBudgetTokens: 1024 } });
  assert.equal(chat.agentModelSelection!.options!.reasoningEffort, 'low', 'only the server echo changes saved controls');
  assert.equal(chat.pendingMessageQueue![0].modelSelection!.options!.reasoningEffort, 'low');
  assert.deepEqual(managedReasoningSelection(chat, 'inherit', true).options, { thinkingBudgetTokens: 1024 });
  assert.deepEqual(managedReasoningSelection(chat, 'off', true).options, { reasoningEffort: 'off' });
  assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []);
});

test('the managed thinking toggle saves child-local options and keeps its current reply running', async () => {
  const { chat } = setup(), bodies: any[] = [];
  chat.agentModelSelection = { providerId: 'provider', modelId: 'old', options: { thinkingMode: 'on', thinkingBudgetTokens: 1024 } };
  delete chat.reasoningEffort; chat.thinkingMode = 'on';
  document.body.insertAdjacentHTML('beforeend', '<div id="composerThinkingControl"></div>');
  modelCache.set(encodeModelSelectKey('provider', 'old'), { id: 'old', reasoning: { allowed_options: ['off', 'on'], default: 'on' },
    capabilities: { vision: false, tools: true, streaming: true, grammar: null, reasoning: true,
      reasoningAllowedOptions: ['off', 'on'], contextLength: null, loadState: null } });
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({}); };
  initThinkingControl(); syncThinkingControlFromActiveChat();
  const button = document.querySelector<HTMLButtonElement>('.thinking-toggle-btn')!;
  assert.equal(button.disabled, false); button.click(); await idle(chat.id);
  assert.deepEqual(bodies[0].selection, { providerId: 'provider', modelId: 'old', options: { thinkingMode: 'off' } });
  assert.equal(chat.thinkingMode, 'on'); assert.equal(chat.agentExecution!.status, 'running');
});

test('an unsupported option fails visibly, keeps the saved pair, and permits an explicit retry', async () => {
  const { chat, host } = setup(); let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? Response.json({ error: { code: 'options_unsupported', message: 'This model does not support high effort.' } }, { status: 400 }) : Response.json({});
  const selection = { providerId: 'provider', modelId: 'old', options: { reasoningEffort: 'high' } };
  await assert.rejects(configureManagedChatModel(chat, selection), /does not support/);
  assert.equal(chat.agentModelSelection!.options!.reasoningEffort, 'low');
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /does not support/);
  await configureManagedChatModel(chat, selection); assert.equal(calls, 2);
  assert.equal(host.querySelector('[role="alert"]'), null);
});

test('Stop and switch pins the visible execution to turn scope and cannot stop a replacement or duplicate its receipt', async () => {
  const { chat, host } = setup(); chat.agentModelSelection = { providerId: 'provider', modelId: 'next', options: {} };
  syncAgentModelControls(chat, host); const button = host.querySelector<HTMLButtonElement>('button')!; button.focus();
  const sameButton = host.querySelector('button'); notifyManagedChatMetadata(chat.id);
  assert.equal(host.querySelector('button'), sameButton); assert.equal(document.activeElement, button);
  chat.agentExecution!.updatedAt = Date.now(); notifyManagedChatMetadata(chat.id);
  assert.equal(host.querySelector('button'), sameButton, 'timestamp-only metadata does not rebuild focused controls');
  const requests: any[] = []; let release!: () => void;
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(String(options?.body))); await new Promise<void>(resolve => { release = resolve; }); return Response.json({}); };
  const stopping = stopAndSwitchManagedChat(chat);
  for (let count = 0; count < 100 && !release; count++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(isManagedModelBusy(chat.id), true); assert.equal(host.querySelector<HTMLButtonElement>('button')!.disabled, true);
  chat.agentExecution = { executionId: 'replacement', status: 'running', modelSelection: chat.agentModelSelection };
  release(); await stopping;
  assert.equal(requests.length, 1); assert.equal(requests[0].action, 'stop');
  assert.equal(requests[0].executionId, 'running-execution'); assert.equal(requests[0].scope, 'turn');
  chat.agentExecution = { executionId: 'running-execution', status: 'running', modelSelection: { providerId: 'provider', modelId: 'old' } };
  await stopAndSwitchManagedChat(chat); assert.equal(requests.length, 1);
});

test('concurrent model saves are rejected without applying either selection locally', async () => {
  const { chat, host } = setup(); let release!: () => void;
  globalThis.fetch = async () => { await new Promise<void>(resolve => { release = resolve; }); return Response.json({}); };
  const saving = configureManagedChatModel(chat, { providerId: 'provider', modelId: 'next' });
  await assert.rejects(configureManagedChatModel(chat, { providerId: 'provider', modelId: 'other' }), /Wait for/);
  assert.match(host.textContent!, /Saving model controls/);
  for (let count = 0; count < 100 && !release; count++) await new Promise(resolve => setTimeout(resolve, 2));
  release(); await saving; assert.equal(chat.modelId, 'old');
});

test('native and model-restricted children keep all model mutations disabled with truthful inspector copy', async () => {
  const { chat, host } = setup(); let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  chat.agentConversation!.origin = 'native'; syncAgentModelControls(chat, host);
  assert.match(host.textContent!, /Saved model:/); assert.equal(host.querySelector('button'), null);
  await assert.rejects(configureManagedChatModel(chat, { providerId: 'provider', modelId: 'next' }), /original host/);
  await assert.rejects(stopAndSwitchManagedChat(chat), /original host/);
  chat.agentConversation!.origin = 'delegated'; chat.agentConversation!.capabilities!.canChooseModel = false;
  await assert.rejects(configureManagedChatModel(chat, { providerId: 'provider', modelId: 'next' }), /does not permit/);
  assert.equal(calls, 0);
});

test('a child without Stop authority can save a next model but has no Stop-and-switch action', async () => {
  const { chat, host } = setup();
  chat.agentModelSelection = { providerId: 'provider', modelId: 'next' }; syncAgentModelControls(chat, host);
  assert.ok(host.querySelector('button'));
  chat.agentConversation!.capabilities!.canStop = false; syncAgentModelControls(chat, host);
  assert.equal(host.querySelector('button'), null);
  await assert.rejects(stopAndSwitchManagedChat(chat), /does not permit stopping/);
});
