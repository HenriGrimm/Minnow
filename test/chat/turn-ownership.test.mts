import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createChatTurnRegistry } from '../../server/chat-turns/middleware.js';
import { acquireChatTurn, isChatOwnedElsewhere, refreshRemoteChatTurns } from '../../src/chat/turn-ownership.ts';
import { isChatRunningRemotely, setRemoteChatTurns } from '../../src/chat/remote-turn-state.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { isChatTurnSetupPending } from '../../src/chat/chat-turn-guard.ts';
import { runChatTurn } from '../../src/chat/run-turn-chat.ts';
import { bootGenerationResumeForChat } from '../../src/chat/generation-resume.ts';
import { resumeIncompleteToolBatch } from '../../src/chat/incomplete-tool-resume.ts';
import { setResumeGateState } from '../../src/chat/resume-gate.ts';
import { collectResumeCandidates } from '../../src/boot/resume-gate-boot.ts';
import { syncComposerFromStreamingState } from '../../src/ui/composer-send.ts';
import { streamingChatIds } from '../../src/app-state.ts';

const CHAT = '11111111-1111-1111-1111-111111111111';
const originalFetch = globalThis.fetch;
const originalNow = Date.now;

function installRegistry(registry: ReturnType<typeof createChatTurnRegistry>): void {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/chat-turns');
    if (!init?.body) return Response.json({ turns: registry.list() });
    const { action, chatId, ownerId } = JSON.parse(String(init.body));
    if (action === 'release') { registry.release(chatId, ownerId); return Response.json({ ok: true }); }
    const ok = action === 'claim' ? registry.claim(chatId, ownerId) : registry.renew(chatId, ownerId);
    return Response.json({ ok, leaseMs: 30_000 }, { status: ok ? 200 : 409 });
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  setStorageModeForTests('localStorage');
  setSessionStateForTests(null);
  setRemoteChatTurns([]);
  setResumeGateState('idle');
});

test('lease client renews/releases on the server and excludes its own turn from observer status', async () => {
  const registry = createChatTurnRegistry({ generations: () => [] });
  setStorageModeForTests('server');
  installRegistry(registry);
  const lease = await acquireChatTurn(CHAT);
  try {
    assert.ok(lease);
    await refreshRemoteChatTurns();
    assert.equal(isChatRunningRemotely(CHAT), false);
    assert.equal(await isChatOwnedElsewhere(CHAT), false);
    assert.equal(registry.claim(CHAT, 'phone'), false);
    await lease.check();
  } finally {
    await lease?.release();
    await lease?.release();
    assert.deepEqual(registry.list(), []);
  }
});

test('a renderer waking after replacement aborts before its next model or tool action', async (t) => {
  let clock = 0;
  Date.now = () => clock;
  t.mock.method(performance, 'now', () => clock);
  const registry = createChatTurnRegistry({ now: () => clock, generations: () => [] });
  installRegistry(registry);
  setStorageModeForTests('server');
  const lease = await acquireChatTurn(CHAT);
  assert.ok(lease);
  try {
    clock = 31_000;
    assert.equal(registry.claim(CHAT, 'phone'), true);
    await assert.rejects(lease.check(), { name: 'ChatOwnershipError' });
    assert.equal(lease.signal.aborted, true);
  } finally {
    await lease.release();
    assert.deepEqual(registry.list(), [{ chatId: CHAT, ownerId: 'phone' }]);
  }
});

test('opening a PC-owned chat on the phone never resumes a generation or pending tool batch', async () => {
  const chat = createEmptyChatObject('m1');
  chat.id = CHAT;
  chat.history = [
    { role: 'user', content: 'Build it' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tool-1', type: 'function',
      function: { name: 'save_file', arguments: '{"path":"a.txt","content":"hello"}' } }] },
  ];
  chat.currentGenerationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const state = { version: 6, activeId: CHAT, chats: [chat], sidebarCollapsed: false };
  setSessionStateForTests(state);
  setResumeGateState('resumed');
  setStorageModeForTests('server');
  const requests: { path: string; action?: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const action = init?.body ? JSON.parse(String(init.body)).action : undefined;
    requests.push({ path, action });
    if (path === '/api/chat-turns') {
      return action ? Response.json({ ok: false }, { status: 409 })
        : Response.json({ turns: [{ chatId: CHAT, ownerId: 'pc' }] });
    }
    // Board-resume polling is unrelated to chat execution.
    if (path === '/api/boards/resume/pending') return Response.json({ ok: true, boards: [] });
    throw new Error(`Observer attempted an unexpected request: ${path}`);
  };
  const original = structuredClone(chat);
  await bootGenerationResumeForChat(chat);
  assert.equal(await resumeIncompleteToolBatch(chat), false);
  assert.equal(await runChatTurn({ chat, pushUser: true, rawText: 'Follow-up', userText: 'Follow-up',
    skillId: null, historyContent: 'Follow-up', validAttachments: [] }), false);
  assert.deepEqual(chat, original, 'observer must not append an error or clear the PC generation id');
  assert.equal(isChatTurnSetupPending(CHAT), false);
  assert.equal(isChatRunningRemotely(CHAT), true);
  const candidates = await collectResumeCandidates(state);
  assert.deepEqual(candidates.chats, [], 'live work is not offered as interrupted work at phone boot');
  assert.ok(requests.every(request => request.path === '/api/chat-turns' || request.path.includes('/resume')));
});

test('an unavailable ownership API leaves automatic recovery passive', async () => {
  setStorageModeForTests('server');
  globalThis.fetch = async () => { throw new Error('offline'); };
  const chat = createEmptyChatObject('m1');
  chat.id = CHAT;
  chat.currentGenerationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const state = { version: 6, activeId: CHAT, chats: [chat], sidebarCollapsed: false };
  setSessionStateForTests(state);
  const original = structuredClone(chat);
  await bootGenerationResumeForChat(chat);
  assert.deepEqual((await collectResumeCandidates(state)).chats, []);
  assert.deepEqual(chat, original);
});

for (const status of [503, 401, 403, 400, 'invalid-grant'] as const) test(`renewal ${status} is classified without pretending the user pressed Stop`, async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  setStorageModeForTests('server');
  globalThis.fetch = async (input, init) => {
    if (String(input) !== '/api/chat-turns') return Response.json({ ok: true });
    const action = JSON.parse(String(init?.body)).action;
    if (action !== 'renew') return Response.json({ ok: true, leaseMs: 30_000 });
    return status === 'invalid-grant' ? Response.json(null) : Response.json({ error: 'Unavailable' }, { status });
  };
  const lease = await acquireChatTurn(CHAT);
  assert.ok(lease);
  try {
    clock = 6_000;
    if (status === 503) {
      await lease.check();
      assert.equal(lease.signal.aborted, false, 'temporary server failure retains the confirmed grant');
    } else {
      await assert.rejects(lease.check(), { name: 'ChatOwnershipError' });
      assert.equal(lease.signal.reason.kind, 'unavailable');
    }
  } finally { await lease.release(); }
});

test('remote streaming retains composer controls without creating a local runner', () => {
  const chat = createEmptyChatObject('m1');
  chat.id = CHAT;
  setSessionStateForTests({ version: 6, activeId: CHAT, chats: [chat], sidebarCollapsed: false });
  const input = document.createElement('textarea');
  input.id = 'msgInput';
  const send = document.createElement('button');
  send.id = 'sendBtn';
  document.body.replaceChildren(input, send);
  setRemoteChatTurns([CHAT]);
  syncComposerFromStreamingState();
  assert.equal(input.disabled, false);
  assert.equal(send.disabled, false);
  assert.equal(send.getAttribute('aria-label'), 'Stop generating');
  assert.equal(streamingChatIds.has(CHAT), false);
  setRemoteChatTurns([]);
  syncComposerFromStreamingState();
  assert.equal(input.disabled, false);
  assert.equal(send.disabled, false);
  assert.equal(send.getAttribute('aria-label'), 'Send message');
});
