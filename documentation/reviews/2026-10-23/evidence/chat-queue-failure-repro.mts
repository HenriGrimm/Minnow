/**
 * Offline reproduction, from repository root:
 * node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/chat-queue-failure-repro.mts
 * No server/provider/profile access. Only model execution and network are stubbed;
 * the queue, acceptance, turn adapter and failed-turn settlement are real.
 */
import assert from 'node:assert/strict';
import '../../../../test/tools/install-dom-before-imports.mts';

globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
const { createEmptyChatObject, setSessionStateForTests } = await import('../../../../src/state/sessions.ts');
const { setRunTurnForTests, setChatLibraryAndServesForTests } = await import('../../../../src/chat/run-turn-chat.ts');
const { setTitlesConfigForTests, DEFAULT_TITLES_CONFIG } = await import('../../../../src/config/titles-meta.ts');
const { enqueueComposerMessage, flushPendingMessageQueue } = await import('../../../../src/chat/message-queue.ts');

setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
setChatLibraryAndServesForTests(async () => ({ library: [], serves: [] }));
const chat = Object.assign(createEmptyChatObject('m1'), { id: 'queued', providerId: 'vite-fallback', modelId: 'm1' });
const active = createEmptyChatObject('m1');
setSessionStateForTests({ version: 3, activeId: active.id, sidebarCollapsed: false, chats: [active, chat] });
let called = false;
setRunTurnForTests(async () => {
  called = true;
  return { outcome: 'crashed', error: 'offline fixture failure' };
});
enqueueComposerMessage(chat, 'Make the change');
await flushPendingMessageQueue(chat);
const userRows = chat.history.filter(row => row.role === 'user').map(row => row.content);
const queued = chat.pendingMessageQueue?.map(row => row.text);
assert.equal(called, true);
assert.deepEqual(userRows, ['Make the change']);
assert.deepEqual(queued, ['Make the change']); // Defect: accepted prompt is queued again.
console.log(JSON.stringify({ called, userRows, queued }));
setSessionStateForTests(null);
process.exit(0);
