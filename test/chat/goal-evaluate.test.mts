import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  evaluateGoal,
  maybeContinueGoalAfterTurn,
  noteManagedGoalExecution,
  resetManagedGoalExecutionsForTests,
  setGoalContinuationForTests,
  setGoalEvalAgentImplForTests,
  setGoalEvalImplForTests,
  shouldEvaluateGoalAfterTurn,
} from '../../src/chat/goal/evaluate.ts';
import { buildGoalTranscriptExcerpt } from '../../src/chat/goal/prompt.ts';
import { managedChatPresentationForWire } from '../../src/config/api-client.ts';
import { MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS, MIN_GOAL_TURNS_BEFORE_PASS } from '../../src/chat/goal/eval-tools.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setActiveGoal,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';
const CONDITION = 'all unit tests pass';

function seedChat(turnCount = MIN_GOAL_TURNS_BEFORE_PASS) {
  const chat = createEmptyChatObject('m1');
  chat.id = FIXED_CHAT_ID;
  chat.providerId = 'lmstudio';
  chat.modelId = 'test-model';
  setActiveGoal(chat, CONDITION);
  chat.activeGoal!.turnCount = turnCount;
  setSessionStateForTests({
    version: 3,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return chat;
}

describe('evaluateGoal', () => {
  afterEach(() => {
    setGoalEvalAgentImplForTests(null);
    setGoalEvalImplForTests(null);
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
  });

  test('gate forces NO when agent returns YES with low verification tool count', async () => {
    const chat = seedChat();
    setGoalEvalAgentImplForTests(async () => ({
      raw: 'YES: rubber stamp.',
      verificationToolCalls: MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS - 1,
    }));

    const result = await evaluateGoal(chat);
    assert.equal(result.met, false);
    assert.match(result.reason, /Pass blocked/);
    assert.match(result.reason, /verification tool call/);
  });

  test('allows YES when agent returns sufficient verification tool calls', async () => {
    const chat = seedChat();
    setGoalEvalAgentImplForTests(async () => ({
      raw: 'YES: verified with tests.',
      verificationToolCalls: MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS,
    }));

    const result = await evaluateGoal(chat);
    assert.equal(result.met, true);
    assert.equal(result.reason, 'verified with tests.');
  });
});

describe('shouldEvaluateGoalAfterTurn', () => {
  afterEach(() => {
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
  });

  test('returns true for persisted active goal after reload (goalDriven false)', () => {
    const chat = seedChat();
    assert.equal(shouldEvaluateGoalAfterTurn(chat, false), true);
  });

  test('returns false when goal is achieved', () => {
    const chat = seedChat();
    chat.activeGoal!.achieved = true;
    assert.equal(shouldEvaluateGoalAfterTurn(chat, false), false);
  });

  test('returns false when chat has no goal', () => {
    const chat = createEmptyChatObject('m1');
    chat.id = FIXED_CHAT_ID;
    assert.equal(shouldEvaluateGoalAfterTurn(chat, false), false);
  });
});

describe('noteManagedGoalExecution', () => {
  afterEach(() => {
    resetManagedGoalExecutionsForTests();
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
  });

  function managedChat() {
    const chat = seedChat(0);
    chat.chatCommandVersion = 1;
    return chat;
  }

  function recorder() {
    const calls: string[] = [];
    return { calls, continueGoal: async (chat: { id: string }) => { calls.push(chat.id); } };
  }

  test('continues once when an observed server execution completes', () => {
    const chat = managedChat();
    const { calls, continueGoal } = recorder();
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'running' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'completed' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'completed' }, continueGoal);
    assert.deepEqual(calls, [FIXED_CHAT_ID]);
  });

  test('does not continue an execution first seen as completed (reload)', () => {
    const chat = managedChat();
    const { calls, continueGoal } = recorder();
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'completed' }, continueGoal);
    assert.deepEqual(calls, []);
  });

  test('does not continue after Stop, failure, or a cleared goal', () => {
    const chat = managedChat();
    const { calls, continueGoal } = recorder();
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'running' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'stopped' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'completed' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e2', status: 'running' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e2', status: 'failed' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e3', status: 'running' }, continueGoal);
    chat.activeGoal = undefined;
    noteManagedGoalExecution(chat, { executionId: 'e3', status: 'completed' }, continueGoal);
    assert.deepEqual(calls, []);
  });

  test('ignores legacy renderer-run chats', () => {
    const chat = seedChat(0);
    const { calls, continueGoal } = recorder();
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'running' }, continueGoal);
    noteManagedGoalExecution(chat, { executionId: 'e1', status: 'completed' }, continueGoal);
    assert.deepEqual(calls, []);
  });
});

describe('maybeContinueGoalAfterTurn', () => {
  const sent: string[] = [];
  const saved: Record<string, unknown> = {};
  before(() => {
    // The loop refreshes composer/sidebar status, which needs a document.
    const window = new Window();
    for (const key of ['document', 'window', 'HTMLElement']) saved[key] = (globalThis as Record<string, unknown>)[key];
    Object.assign(globalThis, { document: window.document, window, HTMLElement: window.HTMLElement });
  });
  after(() => { Object.assign(globalThis, saved); });
  afterEach(() => {
    sent.length = 0;
    setGoalContinuationForTests(null);
    setGoalEvalAgentImplForTests(null);
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
  });

  function managed(turnCount = 0) {
    const chat = seedChat(turnCount);
    chat.chatCommandVersion = 1;
    chat.agentExecution = { executionId: 'e1', status: 'completed' };
    setGoalContinuationForTests(async (_chat, directive) => { sent.push(directive); });
    return chat;
  }

  test('a NO verdict counts the round and sends one continuation with the feedback', async () => {
    const chat = managed();
    setGoalEvalAgentImplForTests(async () => ({ raw: 'NO: tests still failing.', verificationToolCalls: 5 }));
    await maybeContinueGoalAfterTurn(chat);
    assert.equal(chat.activeGoal!.turnCount, 1);
    assert.equal(chat.activeGoal!.lastReason, 'tests still failing.');
    assert.equal(chat.activeGoal!.paused, undefined);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Evaluator feedback: tests still failing\./);
  });

  test('an evaluator failure pauses the loop instead of re-running the agent', async () => {
    const chat = managed();
    setGoalEvalAgentImplForTests(async () => ({ raw: 'NO: Goal evaluator failed: Background use of this CLI is off.', verificationToolCalls: 0, failed: true }));
    await maybeContinueGoalAfterTurn(chat);
    assert.deepEqual(sent, []);
    assert.equal(chat.activeGoal!.paused, true);
    assert.match(chat.activeGoal!.lastReason ?? '', /^Paused: .*Background use of this CLI is off/);
    // Resume clears the pause and continues on a real verdict.
    setGoalEvalAgentImplForTests(async () => ({ raw: 'NO: not done.', verificationToolCalls: 4 }));
    await maybeContinueGoalAfterTurn(chat);
    assert.equal(chat.activeGoal!.paused, undefined);
    assert.equal(sent.length, 1);
  });

  test('a thrown evaluator error pauses without an unhandled rejection', async () => {
    const chat = managed();
    setGoalEvalAgentImplForTests(async () => { throw new Error('boom'); });
    await maybeContinueGoalAfterTurn(chat);
    assert.deepEqual(sent, []);
    assert.equal(chat.activeGoal!.paused, true);
  });

  test('achievement on a server-run chat never writes a local transcript row', async () => {
    const chat = managed(MIN_GOAL_TURNS_BEFORE_PASS);
    const before = chat.history.length;
    setGoalEvalAgentImplForTests(async () => ({ raw: 'YES: verified.', verificationToolCalls: MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS }));
    await maybeContinueGoalAfterTurn(chat);
    assert.equal(chat.activeGoal!.achieved, true);
    assert.equal(chat.history.length, before);
    assert.deepEqual(sent, []);
  });

  test('skips evaluation while a server turn is running or queued', async () => {
    const chat = managed();
    let calls = 0;
    setGoalEvalAgentImplForTests(async () => { calls += 1; return { raw: 'NO: x', verificationToolCalls: 0 }; });
    chat.agentExecution = { executionId: 'e2', status: 'running' };
    await maybeContinueGoalAfterTurn(chat);
    chat.agentExecution = { executionId: 'e2', status: 'completed' };
    chat.agentPendingCommand = { commandId: 'c1', state: 'queued', held: false } as never;
    await maybeContinueGoalAfterTurn(chat);
    assert.equal(calls, 0);
    assert.equal(chat.activeGoal!.turnCount, 0);
  });
});

describe('goal transcript and persistence', () => {
  afterEach(() => {
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
  });

  test('transcript excerpt tolerates content-part arrays and object tool arguments', () => {
    const chat = seedChat();
    chat.history = [
      { role: 'user', content: [{ type: 'text', text: 'Build it' }] as never },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: { path: 'a' } as never } }] } as never,
      { role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: 'file body' }] as never } as never,
      { role: 'user', content: 'Continue working toward the active goal.\n\nGoal: x' },
    ];
    const excerpt = buildGoalTranscriptExcerpt(chat);
    assert.match(excerpt, /User: Build it/);
    assert.match(excerpt, /read_file\(\{"path":"a"\}\)/);
    assert.match(excerpt, /Tool \(t1\): file body/);
    assert.doesNotMatch(excerpt, /Continue working toward/);
  });

  test('managed saves always carry goal state, with null when cleared', () => {
    const chat = seedChat();
    chat.chatCommandVersion = 1;
    const wire = managedChatPresentationForWire(chat) as unknown as Record<string, unknown>;
    assert.deepEqual(wire.activeGoal, chat.activeGoal);
    chat.activeGoal = undefined;
    assert.equal((managedChatPresentationForWire(chat) as unknown as Record<string, unknown>).activeGoal, null);
  });
});
