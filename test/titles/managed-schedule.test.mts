import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEmptyChatObject, setSessionStateForTests, resetSessionPersistenceForTests, getSessionDirtyTrackingForTests } from '../../src/state/sessions.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { DEFAULT_TITLES_CONFIG, setTitlesConfigForTests } from '../../src/config/titles-meta.ts';
import { DEFAULT_UTILITY_MODEL_CONFIG, setUtilityModelConfigForTests } from '../../src/config/utility-model-meta.ts';
import { resetTitleGenerationInflight, resetTitleScheduleContext, scheduleManagedChatTitleGeneration, setGenerateChatTitleForTests } from '../../src/chat/titles/schedule.ts';
import { startManagedChatBridge } from '../../src/chat/managed-chat-bridge.ts';
import { notifyManagedChatView } from '../../src/chat/managed-chat-view.ts';

const originalFetch = globalThis.fetch;
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function setup() {
  setStorageModeForTests('localStorage');
  setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG });
  setUtilityModelConfigForTests({ ...DEFAULT_UTILITY_MODEL_CONFIG });
  const chat = createEmptyChatObject('model'); chat.providerId = 'vite-fallback';
  chat.chatCommandVersion = 1; chat.name = 'Review the parser';
  chat.history = [{ role: 'user', content: 'Review the parser and check its edge cases.', commandId: 'review-command' },
    { role: 'assistant', content: 'Reviewed the parser.' }];
  chat.agentExecution = { executionId: 'review-execution', status: 'completed' };
  chat.agentTitleCandidate = { commandId: 'review-command', expectedName: chat.name };
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  return chat;
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetTitleGenerationInflight(); resetTitleScheduleContext(); setGenerateChatTitleForTests(null);
  resetSessionPersistenceForTests(); setSessionStateForTests(null); setStorageModeForTests(null);
});

test('managed completion generates once and applies a guarded server title update without a local save', async () => {
  const chat = setup(), requests: any[] = []; let generations = 0;
  setGenerateChatTitleForTests(async seed => { generations++; assert.match(seed, /edge cases/); return { title: 'Parser edge case review' }; });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `/api/chats/${chat.id}/configuration`);
    requests.push(JSON.parse(String(options?.body)));
    return Response.json({ receipt: { chatId: chat.id, disposition: 'settled' } });
  };
  scheduleManagedChatTitleGeneration(chat.id); scheduleManagedChatTitleGeneration(chat.id);
  for (let n = 0; requests.length === 0 && n < 30; n++) await tick();
  assert.equal(generations, 1); assert.equal(requests.length, 1);
  assert.equal(requests[0].name, 'Parser edge case review');
  assert.equal(requests[0].expectedName, 'Review the parser');
  assert.equal(chat.name, 'Review the parser', 'the canonical frame owns the new name');
  assert.ok(!getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
});

test('a manual rename during title generation wins without issuing a configuration write', async () => {
  const chat = setup(); let complete!: (value: { title: string }) => void, writes = 0;
  setGenerateChatTitleForTests(() => new Promise(resolve => { complete = resolve; }));
  globalThis.fetch = async () => { writes++; return Response.json({}); };
  scheduleManagedChatTitleGeneration(chat.id);
  for (let n = 0; !complete && n < 30; n++) await tick();
  assert.ok(complete);
  chat.name = 'My parser notes'; complete({ title: 'Automatic title' }); await tick();
  assert.equal(writes, 0); assert.equal(chat.name, 'My parser notes');
});

test('the managed bridge schedules titles from completion frames and deduplicates replayed baselines', async t => {
  const chat = setup(); let generations = 0, writes = 0;
  setGenerateChatTitleForTests(async () => { generations++; return { title: 'Parser review' }; });
  globalThis.fetch = async () => { writes++; return Response.json({ receipt: { chatId: chat.id, disposition: 'settled' } }); };
  const source = { onopen: null as any, onmessage: null as any, close() {} };
  notifyManagedChatView(chat.id);
  const stop = startManagedChatBridge({ receive: async () => {}, reconnect() {} }, () => {}, { createSource: () => source });
  t.after(() => { stop(); notifyManagedChatView(''); });
  source.onopen();
  const frame = { kind: 'frame', baseline: true, frame: { chatId: chat.id, fields: { agentExecution: chat.agentExecution } } };
  source.onmessage({ data: JSON.stringify(frame) });
  for (let n = 0; writes === 0 && n < 100; n++) await tick();
  assert.equal(writes, 1); assert.equal(generations, 1);
  source.onmessage({ data: JSON.stringify(frame) }); await tick();
  assert.equal(generations, 1);
});

test('running, failed, recovery and custom-named chats do not start managed title work', async () => {
  const chat = setup(); let generations = 0;
  setGenerateChatTitleForTests(async () => { generations++; return { title: 'Unexpected' }; });
  for (const status of ['running', 'failed', 'stopped', 'recovery_required']) {
    chat.agentExecution!.status = status; scheduleManagedChatTitleGeneration(chat.id);
  }
  chat.agentExecution!.status = 'completed'; chat.name = 'My own name';
  scheduleManagedChatTitleGeneration(chat.id); await tick();
  assert.equal(generations, 0);
});

test('a background completion hydrates canonical history before generating its title', async () => {
  const chat = setup(), history = chat.history;
  chat.history = []; chat.historyLoaded = false; chat.messageCount = history.length;
  setStorageModeForTests('server');
  let loaded = false, wrote = false;
  setGenerateChatTitleForTests(async seed => {
    assert.equal(loaded, true); assert.match(seed, /edge cases/);
    return { title: 'Parser review' };
  });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/config/sessions/history/')) {
      loaded = true; return Response.json({ chatId: chat.id, history });
    }
    if (String(url).startsWith('/api/providers')) return Response.json({ providers: [{ id: 'vite-fallback', label: 'Fixture', enabled: true,
      apiKind: 'openai-v1', baseUrl: 'http://127.0.0.1:1' }] });
    assert.equal(String(url), `/api/chats/${chat.id}/configuration`); wrote = true;
    return Response.json({ receipt: { chatId: chat.id, disposition: 'settled' } });
  };
  scheduleManagedChatTitleGeneration(chat.id);
  for (let n = 0; !wrote && n < 100; n++) await tick();
  assert.equal(loaded, true); assert.equal(wrote, true); assert.equal(chat.historyLoaded, true);
});
