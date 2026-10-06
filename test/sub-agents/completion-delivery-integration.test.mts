import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import * as sessions from '../../src/state/sessions.ts';
import type { Chat } from '../../src/types.ts';
import { setResumeGateState } from '../../src/chat/resume-gate.ts';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';

let persistSucceeds = true;
let holdTurn = false;
let declineResume = false;
const defaultResumes: string[] = [];
const pendingTurns: Array<(completed: boolean) => void> = [];

mock.module('../../src/state/sessions.ts', {
  namedExports: {
    ...sessions,
    persistSessionsBeforeDeliveryAck: async () => persistSucceeds,
  },
});
mock.module('../../src/chat/run-turn-chat.ts', {
  namedExports: {
    resumeParentChatWithMessage: async (
      chat: Chat,
      message: string,
      options: { onUserMessageAccepted?: () => Promise<void> },
    ) => {
      defaultResumes.push(chat.id);
      if (declineResume) return false;
      chat.history!.push({ role: 'user', content: message, hiddenFromTranscript: true });
      await options.onUserMessageAccepted?.();
      if (holdTurn) return new Promise<boolean>((resolve) => pendingTurns.push(resolve));
      return true;
    },
  },
});

const {
  hydrateSubAgentRunsForParentChat,
  resetSubAgentOrchestrator,
  setSubAgentApiFetchForTests,
  setSubAgentOpenStreamForTests,
} = await import('../../src/agents/orchestrator.ts');
const {
  flushSubAgentCompletionPushForChat,
  initSubAgentCompletionPush,
  resetSubAgentCompletionPushForTests,
  setSubAgentCompletionDeliverHook,
  setSubAgentDeliveryHandleForTests,
} = await import('../../src/agents/sub-agent-completion-push.ts');
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

function fold(runId: string, parentChatId: string, phase: 'running' | 'passed' | 'cancelled') {
  return {
    runId, type: 'explore', task: 'scan', parentChatId, requestedAt: 1,
    phase, attempts: phase === 'passed' ? [{ attemptId: 'a1', ended: true, outcome: 'pass', summary: 'done' }] : [],
    delivered: false,
  };
}

after(() => {
  setResumeGateState('idle');
  for (const finish of pendingTurns.splice(0)) finish(false);
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

async function defaultDeliveryHarness(chat?: Chat, cancelledResults = false) {
  resetSubAgentOrchestrator();
  resetSubAgentCompletionPushForTests();
  setSubAgentDeliveryHandleForTests(null);
  setSubAgentCompletionDeliverHook(null);
  persistSucceeds = true;
  holdTurn = false;
  declineResume = false;
  setResumeGateState('idle');
  defaultResumes.length = 0;
  const parent = chat ?? createEmptyChatObject('');
  parent.id = PARENT;
  parent.modelId = 'test-model';
  parent.history ??= [];
  setSessionStateForTests({ version: 2, activeId: PARENT, sidebarCollapsed: false, chats: [parent] });
  let stream: FakeStream | undefined;
  const acknowledgements: string[][] = [];
  setSubAgentOpenStreamForTests(() => {
    stream = new FakeStream();
    return stream;
  });
  setSubAgentApiFetchForTests(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/delivery/ack')) {
      acknowledgements.push(JSON.parse(String(init?.body)).runIds);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes('/transcript')) return new Response(JSON.stringify({ ok: true, events: [] }), { status: 200 });
    // An unrelated live child keeps the shared stream open for duplicate and
    // overlapping retry frames after the first result is acknowledged.
    return new Response(JSON.stringify({ ok: true, seq: 1, state: { runs: [
      fold(RUN, PARENT, cancelledResults ? 'cancelled' : 'passed'),
      fold(OFFLINE_RUN, PARENT, cancelledResults ? 'cancelled' : 'passed'),
      fold('run-keep-stream-open', PARENT, 'running'),
    ] } }), { status: 200 });
  });
  initSubAgentCompletionPush();
  await hydrateSubAgentRunsForParentChat(PARENT);
  assert.ok(stream);
  return {
    parent,
    acknowledgements,
    emit(runIds: string[], message = '[Sub-agent finished] retained result', kind = 'completion') {
      stream!.emit('deliver', { kind, parentChatId: PARENT, runIds, message });
    },
    flush() { return flushSubAgentCompletionPushForChat(PARENT); },
  };
}

test('default completion accepts and ACKs before the resumed turn completes, and Stop does not replay it', async () => {
  const harness = await defaultDeliveryHarness();
  holdTurn = true;
  harness.emit([RUN]);
  await harness.flush();
  assert.deepEqual(defaultResumes, [PARENT]);
  assert.deepEqual(harness.acknowledgements, [[RUN]], 'acceptance must not wait for model completion');
  assert.ok(harness.parent.subAgentDeliveryReceipts?.includes(RUN));
  assert.equal(pendingTurns.length, 1, 'the parent model is still running');
  pendingTurns.shift()!(false); // same result runChatTurn returns after user Stop
  await Promise.resolve();
  harness.emit([RUN]);
  await harness.flush();
  assert.deepEqual(defaultResumes, [PARENT], 'a stopped accepted turn must not restart');
  assert.equal(harness.parent.history!.length, 1);
});

test('durable per-run receipts prevent reload and overlapping-batch retries from duplicating history', async () => {
  let harness = await defaultDeliveryHarness();
  harness.emit([RUN]);
  await harness.flush();
  const restoredChat = normalizeChatRow(JSON.parse(JSON.stringify(harness.parent)));
  harness = await defaultDeliveryHarness(restoredChat);
  harness.emit([RUN]);
  await harness.flush();
  assert.deepEqual(defaultResumes, [], 'reload must only re-ACK an accepted run');
  assert.deepEqual(harness.acknowledgements, [[RUN]]);
  harness.emit([RUN, OFFLINE_RUN]);
  await harness.flush();
  assert.deepEqual(defaultResumes, [PARENT]);
  assert.equal(harness.parent.history!.length, 2, 'only the new run gets a new accepted history row');
  assert.deepEqual(new Set(harness.parent.subAgentDeliveryReceipts), new Set([RUN, OFFLINE_RUN]));
  harness.emit([OFFLINE_RUN]);
  await harness.flush();
  assert.equal(harness.parent.history!.length, 2);
  assert.deepEqual(defaultResumes, [PARENT]);
});

test('an explicit Stop fence retains and ACKs results and ignores check-ins without restarting the chat', async () => {
  const harness = await defaultDeliveryHarness();
  harness.parent.subAgentAutoResumeBlocked = true;
  harness.emit([RUN]);
  await harness.flush();
  assert.deepEqual(defaultResumes, []);
  assert.deepEqual(harness.acknowledgements, [[RUN]]);
  assert.equal(harness.parent.history!.length, 1, 'completed child evidence must be retained');
  harness.emit(['run-keep-stream-open'], '[Sub-agent check-in] still working', 'check_in_nudge');
  await harness.flush();
  assert.deepEqual(defaultResumes, []);
  assert.equal(harness.parent.history!.length, 1);
  const restoredChat = normalizeChatRow(JSON.parse(JSON.stringify(harness.parent)));
  assert.equal(restoredChat.subAgentAutoResumeBlocked, true, 'Stop fence must survive server normalization');
});

test('cancelled child results retain their evidence and ACK without resuming even without a Stop fence', async () => {
  const harness = await defaultDeliveryHarness(undefined, true);
  harness.emit([RUN, OFFLINE_RUN]);
  await harness.flush();
  assert.deepEqual(defaultResumes, []);
  assert.deepEqual(harness.acknowledgements, [[RUN, OFFLINE_RUN]]);
  assert.equal(harness.parent.history!.length, 1);
  assert.deepEqual(new Set(harness.parent.subAgentDeliveryReceipts), new Set([RUN, OFFLINE_RUN]));
});

test('pending and declined boot resume gates retain and ACK results without launching a turn', async () => {
  for (const state of ['pending', 'declined'] as const) {
    const harness = await defaultDeliveryHarness();
    setResumeGateState(state);
    harness.emit([RUN]);
    await harness.flush();
    assert.deepEqual(harness.acknowledgements, [[RUN]]);
    assert.equal(harness.parent.history!.length, 1);
    harness.emit([RUN]);
    await harness.flush();
    assert.deepEqual(defaultResumes, []);
    assert.equal(harness.parent.history!.length, 1);
  }
  setResumeGateState('idle');
});

test('a busy parent that has not accepted the message keeps delivery pending for a later retry', async () => {
  const harness = await defaultDeliveryHarness();
  declineResume = true;
  harness.emit([RUN]);
  await assert.rejects(harness.flush(), /did not accept/);
  assert.deepEqual(harness.acknowledgements, []);
  assert.equal(harness.parent.history!.length, 0);
  declineResume = false;
  harness.emit([RUN]);
  await harness.flush();
  assert.deepEqual(harness.acknowledgements, [[RUN]]);
  assert.equal(harness.parent.history!.length, 1);
});

test('failed persistence leaves delivery unacknowledged and retries without duplicating its accepted history', async () => {
  const harness = await defaultDeliveryHarness();
  persistSucceeds = false;
  harness.emit([RUN]);
  await assert.rejects(harness.flush(), /persist|accept|durable/i);
  assert.deepEqual(harness.acknowledgements, []);
  assert.equal(harness.parent.history!.length, 1);
  persistSucceeds = true;
  harness.emit([RUN]);
  await harness.flush();
  assert.deepEqual(harness.acknowledgements, [[RUN]]);
  assert.equal(defaultResumes.length, 1, 'retry should persist the receipt rather than start another model turn');
  assert.equal(harness.parent.history!.length, 1);
});
