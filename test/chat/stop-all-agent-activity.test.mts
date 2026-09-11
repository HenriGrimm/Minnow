/**
 * Global stop-all orchestration (boards, streams, sub-agents, titles, research).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { setChatAbort, streamingChatIds } from '../../src/app-state.ts';
import {
  hasStopAllAgentActivityTargets,
  stopAllAgentActivity,
} from '../../src/chat/stop-all-agent-activity.ts';
import {
  listTitleJobInflightChatIds,
  registerTitleJobInflight,
  resetTitleGenerationInflight,
} from '../../src/chat/titles/inflight.ts';
import {
  createEmptyChatObject,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { superPlanRunView, superPlanSummary } from '../helpers/super-plan-fixture.ts';

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';

function seedActiveChat(): void {
  const chat = createEmptyChatObject('m1');
  chat.id = FIXED_CHAT_ID;
  setSessionStateForTests({
    version: 2,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
    groups: [],
  });
}

describe('stop-all-agent-activity', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.performance = window.performance;
  });

  afterEach(() => {
    streamingChatIds.clear();
    setSessionStateForTests(null);
    setChatAbort(FIXED_CHAT_ID, null);
    resetTitleGenerationInflight();
  });

  test('hasStopAllAgentActivityTargets is false when idle', () => {
    seedActiveChat();
    assert.equal(hasStopAllAgentActivityTargets(), false);
  });

  test('hasStopAllAgentActivityTargets is true when a chat is streaming', () => {
    seedActiveChat();
    streamingChatIds.add(FIXED_CHAT_ID);
    assert.equal(hasStopAllAgentActivityTargets(), true);
  });

  test('hasStopAllAgentActivityTargets is true when a title job is inflight', () => {
    seedActiveChat();
    registerTitleJobInflight(FIXED_CHAT_ID, new AbortController());
    assert.equal(hasStopAllAgentActivityTargets(), true);
  });

  test('a running Super Plan counts as agent activity; one waiting on the user does not', () => {
    seedActiveChat();
    const chat = sessionState!.chats[0]!;
    chat.superPlanRunId = 'run-1';
    chat.superPlanView = superPlanSummary('drafting', { runId: 'run-1' });
    assert.equal(hasStopAllAgentActivityTargets(), true);
    chat.superPlanView = superPlanSummary('accept', { runId: 'run-1' });
    assert.equal(hasStopAllAgentActivityTargets(), false);
  });

  test('stopAllAgentActivity pauses a running Super Plan on the server (resumable, not cancelled)', async () => {
    seedActiveChat();
    const chat = sessionState!.chats[0]!;
    chat.superPlanRunId = 'run-1';
    chat.superPlanView = superPlanSummary('drafting', { runId: 'run-1', seq: 40 });
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      const paused = superPlanRunView('paused', { runId: 'run-1', chatId: chat.id, seq: 41 });
      return Response.json({ ok: true, view: paused });
    }) as typeof fetch;
    try {
      stopAllAgentActivity();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(calls, ['POST /api/super-plan/run-1/pause']);
      assert.equal(chat.superPlanView?.status, 'paused');
      assert.equal(chat.superPlanView?.finished, false);
      assert.equal(hasStopAllAgentActivityTargets(), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('stopAllAgentActivity aborts streaming chats and clears title jobs', () => {
    seedActiveChat();
    streamingChatIds.add(FIXED_CHAT_ID);
    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    setChatAbort(FIXED_CHAT_ID, controller);
    registerTitleJobInflight(FIXED_CHAT_ID, new AbortController());

    stopAllAgentActivity();

    assert.equal(aborted, true);
    assert.deepEqual(listTitleJobInflightChatIds(), []);
    assert.equal(streamingChatIds.size, 0);
    assert.equal(hasStopAllAgentActivityTargets(), false);
  });
});
