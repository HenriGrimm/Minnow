import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  hydrateSubAgentRunsForParentChat,
  resetSubAgentOrchestrator,
  setSubAgentApiFetchForTests,
  setSubAgentOpenStreamForTests,
} from '../../src/agents/orchestrator.ts';
import {
  flushSubAgentCompletionPushForChat,
  initSubAgentCompletionPush,
  resetSubAgentCompletionPushForTests,
  setSubAgentCompletionDeliverHook,
  setSubAgentDeliveryHandleForTests,
} from '../../src/agents/sub-agent-completion-push.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';

const PARENT = '11111111-1111-1111-1111-aaaaaaaaaaaa';
const OFFLINE_PARENT = '11111111-1111-1111-1111-bbbbbbbbbbbb';
const RUN = 'run-live';
const OFFLINE_RUN = 'run-offline';

class FakeStream {
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void { this.closed = true; }

  emit(type: string, payload: unknown): void {
    if (this.closed) return;
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(payload) });
  }
}

function fold(runId: string, parentChatId: string, phase: 'running' | 'passed') {
  return {
    runId, type: 'explore', task: 'scan', parentChatId, requestedAt: 1,
    phase, attempts: phase === 'passed' ? [{ attemptId: 'a1', ended: true, outcome: 'pass', summary: 'done' }] : [],
    delivered: false,
  };
}

after(() => {
  setSubAgentCompletionDeliverHook(null);
  setSubAgentApiFetchForTests(null);
  setSubAgentOpenStreamForTests(null);
  resetSubAgentOrchestrator();
  setSessionStateForTests(null);
});

test('production completion listener resumes and ACKs live and offline results', async () => {
  resetSubAgentOrchestrator();
  resetSubAgentCompletionPushForTests();
  setSubAgentDeliveryHandleForTests(null); // production uses server delivery frames

  const liveChat = createEmptyChatObject('');
  liveChat.id = PARENT;
  const offlineChat = createEmptyChatObject('');
  offlineChat.id = OFFLINE_PARENT;
  setSessionStateForTests({ version: 2, activeId: PARENT, sidebarCollapsed: false, chats: [liveChat, offlineChat] });

  const streams = new Map<string, FakeStream>();
  const resumes: string[] = [];
  const acknowledgements: string[][] = [];
  setSubAgentOpenStreamForTests((url) => {
    const parent = new URL(url, 'http://local.invalid').searchParams.get('parentChatId') ?? '';
    const stream = new FakeStream();
    streams.set(parent, stream);
    return stream;
  });
  setSubAgentApiFetchForTests(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/delivery/ack')) {
      const body = JSON.parse(String(init?.body));
      acknowledgements.push(body.runIds);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes('/transcript')) return new Response(JSON.stringify({ ok: true, events: [] }), { status: 200 });
    const parent = new URL(url, 'http://local.invalid').searchParams.get('parentChatId');
    const runs = parent === PARENT ? [fold(RUN, PARENT, 'running')] : [fold(OFFLINE_RUN, OFFLINE_PARENT, 'passed')];
    return new Response(JSON.stringify({ ok: true, seq: 1, state: { runs } }), { status: 200 });
  });
  setSubAgentCompletionDeliverHook(async (chatId) => { resumes.push(chatId); });
  initSubAgentCompletionPush();

  await hydrateSubAgentRunsForParentChat(PARENT);
  const live = streams.get(PARENT);
  assert.ok(live);
  live.emit('deliver', { kind: 'check_in_nudge', parentChatId: PARENT, runIds: [RUN], message: 'still working' });
  await flushSubAgentCompletionPushForChat(PARENT);
  assert.deepEqual(resumes, [PARENT]);
  assert.deepEqual(acknowledgements, [], 'a running check-in is not a completion ACK');
  assert.equal(live.closed, false);
  live.emit('event', { v: 1, seq: 2, ts: 2, type: 'attempt.ended', runId: RUN, attemptId: 'a1', outcome: 'pass', summary: 'done' });
  live.emit('deliver', { kind: 'completion', parentChatId: PARENT, runIds: [RUN], message: 'done' });
  await flushSubAgentCompletionPushForChat(PARENT);
  assert.deepEqual(resumes, [PARENT, PARENT]);
  assert.deepEqual(acknowledgements, [[RUN]]);
  assert.equal(live.closed, true);

  await hydrateSubAgentRunsForParentChat(OFFLINE_PARENT);
  const offline = streams.get(OFFLINE_PARENT);
  assert.ok(offline, 'terminal undelivered hydration must connect');
  offline.emit('deliver', { kind: 'completion', parentChatId: OFFLINE_PARENT, runIds: [OFFLINE_RUN], message: 'offline done' });
  await flushSubAgentCompletionPushForChat(OFFLINE_PARENT);
  assert.deepEqual(resumes, [PARENT, PARENT, OFFLINE_PARENT]);
  assert.deepEqual(acknowledgements, [[RUN], [OFFLINE_RUN]]);
  assert.equal(offline.closed, true);
});
