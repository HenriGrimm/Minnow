import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { streamingChatIds } from '../../src/app-state.ts';
import {
  canUndoTurn,
  getUndoEligibility,
  undoLastAgentTurn,
} from '../../src/chat/undo-turn.ts';
import {
  activateBranch,
  createRun,
  finalizeRun,
  listSelectableBranchesAtFork,
} from '../../src/state/runs-store.ts';
import {
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import type { Chat, TurnSnapshot } from '../../src/types.ts';

function baseSnapshot(forkHistoryIndex: number): TurnSnapshot {
  return {
    forkHistoryIndex,
    userContent: 'hello',
    skillId: null,
    providerId: 'lm-studio-local',
    modelId: 'model-a',
    temperature: 0.7,
    maxTokens: 4096,
    modeId: 'build',
    workAgentId: null,
    workAgentAuto: true,
    composedSystemPrompt: 'You are helpful.',
    enabledToolNames: ['read_file'],
    maxToolTurns: 25,
    historyPrefixHash: 'abc123',
  };
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-undo-1',
    name: 'Test',
    workspacePath: '',
    modelId: 'model-a',
    modeId: 'build',
    history: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply A' },
    ],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
    lastMessageAt: 1,
    runs: [],
    ...overrides,
  };
}

function installChat(chat: Chat): void {
  setSessionStateForTests({
    version: 2,
    activeId: chat.id,
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    chats: [chat],
    chatGroups: [],
    activeBoardGroupId: null,
  });
}

function seedCompletedTurn(chat: Chat, fork: number, reply: string): string {
  const run = createRun(chat, {
    ...baseSnapshot(fork),
    userContent: String(chat.history[fork]?.content ?? 'hello'),
  });
  finalizeRun(chat, run.runId, {
    status: 'completed',
    outputHistoryStart: fork + 1,
    outputHistoryEnd: fork + 1,
    outputMessages: [{ role: 'assistant', content: reply }],
  });
  return run.branchId;
}

afterEach(() => {
  streamingChatIds.clear();
  // Null state first so a flushed save cannot start putSessions / hub import.
  setSessionStateForTests(null);
  flushScheduledSessionSaveForTests();
});

describe('undo-turn', () => {
  test('getUndoEligibility blocks streaming', () => {
    const chat = makeChat();
    installChat(chat);
    seedCompletedTurn(chat, 0, 'reply A');
    streamingChatIds.add(chat.id);
    const elig = getUndoEligibility(chat);
    assert.equal(elig.ok, false);
    assert.equal(elig.reason, 'streaming');
  });

  test('legacy Orchestrate chats support ordinary turn undo', () => {
    const chat = makeChat({ modeId: 'orchestrate', boardGroupId: 'old-group', boardTaskId: 'task' });
    installChat(chat);
    seedCompletedTurn(chat, 0, 'reply A');
    assert.equal(getUndoEligibility(chat).ok, true);
  });

  test('getUndoEligibility blocks worktree-isolated chats', () => {
    const chat = makeChat({ worktreeRoot: 'C:\\tmp\\wt' });
    installChat(chat);
    seedCompletedTurn(chat, 0, 'reply A');
    const elig = getUndoEligibility(chat);
    assert.equal(elig.ok, false);
    assert.equal(elig.reason, 'worktree');
  });

  test('getUndoEligibility reports no_turn when history has no reply', () => {
    const chat = makeChat({
      history: [{ role: 'user', content: 'hello' }],
    });
    installChat(chat);
    const elig = getUndoEligibility(chat);
    assert.equal(elig.ok, false);
    assert.equal(elig.reason, 'no_turn');
    assert.equal(canUndoTurn(chat), false);
  });

  test('undoLastAgentTurn truncates inclusive and keeps redo branch', async () => {
    const chat = makeChat();
    installChat(chat);
    const branchId = seedCompletedTurn(chat, 0, 'reply A');

    const result = await undoLastAgentTurn(chat.id);
    assert.equal(result.ok, true);
    assert.equal(result.forkHistoryIndex, 0);
    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0]?.role, 'user');
    assert.equal(chat.activeBranchByFork?.['0'], undefined);
    assert.equal(listSelectableBranchesAtFork(chat, 0).length, 1);

    const restored = activateBranch(chat, 0, branchId);
    assert.equal(restored, true);
    assert.equal(chat.history.length, 2);
    assert.equal((chat.history[1] as { content: string }).content, 'reply A');
  });

  test('undoLastAgentTurn does not auto-regenerate (no history growth)', async () => {
    const chat = makeChat();
    installChat(chat);
    seedCompletedTurn(chat, 0, 'reply A');
    const before = chat.history.length;
    const result = await undoLastAgentTurn(chat.id);
    assert.equal(result.ok, true);
    assert.ok(chat.history.length < before);
    assert.equal(chat.history.length, 1);
  });

  test('multi-turn undo rewinds newest turn first', async () => {
    const chat = makeChat({
      history: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'reply 2' },
      ],
    });
    installChat(chat);
    seedCompletedTurn(chat, 0, 'reply 1');
    seedCompletedTurn(chat, 2, 'reply 2');

    const first = await undoLastAgentTurn(chat.id);
    assert.equal(first.ok, true);
    assert.equal(first.forkHistoryIndex, 2);
    assert.equal(chat.history.length, 3);
    assert.equal((chat.history[2] as { content: string }).content, 'two');

    const second = await undoLastAgentTurn(chat.id);
    assert.equal(second.ok, true);
    assert.equal(second.forkHistoryIndex, 0);
    assert.equal(chat.history.length, 1);
    assert.equal((chat.history[0] as { content: string }).content, 'one');
  });

  test('undo persists follow-up suffix for redo', async () => {
    const chat = makeChat({
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply A' },
        { role: 'user', content: 'follow up' },
        { role: 'assistant', content: 'more' },
      ],
    });
    installChat(chat);
    // Single turn at fork 0 covering the whole suffix (continuation after reply).
    const run = createRun(chat, baseSnapshot(0));
    finalizeRun(chat, run.runId, {
      status: 'completed',
      outputHistoryStart: 1,
      outputHistoryEnd: 1,
      outputMessages: [{ role: 'assistant', content: 'reply A' }],
    });

    const result = await undoLastAgentTurn(chat.id);
    assert.equal(result.ok, true);
    assert.equal(chat.history.length, 1);
    assert.ok((run.outputMessages?.length ?? 0) >= 3);

    const restored = activateBranch(chat, 0, run.branchId);
    assert.equal(restored, true);
    assert.equal(chat.history.length, 4);
    assert.equal((chat.history[2] as { content: string }).content, 'follow up');
  });
});
