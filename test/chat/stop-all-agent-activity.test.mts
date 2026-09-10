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
import {
  createInitialSuperPlanStages,
  createSuperPlanState,
} from '../helpers/super-plan-fixture.ts';

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

  test('stopAllAgentActivity pauses an active Super Plan chat (resumable, not terminal)', async () => {
    seedActiveChat();
    const chat = sessionState!.chats[0]!;
    chat.superPlanRunId = 'fixture';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ ok: true, state: { status: 'stopped', finished: false } });
    chat.superPlanView = createSuperPlanState('Add OAuth login');
    chat.superPlanView.stages = createInitialSuperPlanStages();
    chat.superPlanView.activeStage = 'draft1';
    chat.superPlanView.stages.draft1 = { status: 'running' };
    streamingChatIds.add(FIXED_CHAT_ID);

    stopAllAgentActivity();

    assert.equal(chat.superPlanView.paused, true);
    assert.equal(chat.superPlanView.cancelled, undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    globalThis.fetch = originalFetch;
    assert.equal(hasStopAllAgentActivityTargets(), false);
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
