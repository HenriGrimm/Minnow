/**
 * Turn snapshot capture helpers (MIN-409) with injected create fn.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  shouldCaptureTurnSnapshots,
  resolveTurnSnapshotCwd,
  capturePreTurnSnapshot,
  capturePostTurnSnapshot,
  setSnapshotCreateForTests,
} from '../../src/chat/turn-snapshots.ts';
import { createRun, findRunById } from '../../src/state/runs-store.ts';
import { setSessionStateForTests } from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import type { Chat, TurnSnapshot } from '../../src/types.ts';

const FIXED_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
const FIXED_HEAD = '1111111111111111111111111111111111111111';

let createCalls: { cwd?: string; message?: string }[] = [];
let createOk = true;

function baseSnapshot(): TurnSnapshot {
  return {
    forkHistoryIndex: 0,
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
    id: 'chat-snap-1',
    name: 'Test',
    workspacePath: 'C:\\Users\\test\\.minnow\\workspace',
    modelId: 'model-a',
    modeId: 'build',
    history: [{ role: 'user', content: 'hello' }],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
    lastMessageAt: 1,
    runs: [],
    ...overrides,
  };
}

afterEach(() => {
  createCalls = [];
  createOk = true;
  setSnapshotCreateForTests(null);
  setSessionStateForTests(null);
  resetWorkspaceStateForTests();
});

describe('turn-snapshots', () => {
  test('shouldCaptureTurnSnapshots handles legacy chats and skips isolated worktrees', () => {
    assert.equal(shouldCaptureTurnSnapshots(makeChat()), true);
    assert.equal(shouldCaptureTurnSnapshots(makeChat({ modeId: 'orchestrate' })), true);
    assert.equal(shouldCaptureTurnSnapshots(makeChat({ boardTaskId: 't1' })), true);
    assert.equal(shouldCaptureTurnSnapshots(makeChat({ worktreeRoot: 'C:\\wt' })), false);
  });

  test('capturePreTurnSnapshot annotates run fields', async () => {
    setSnapshotCreateForTests(async (input) => {
      createCalls.push(input ?? {});
      if (!createOk) return { ok: false, error: 'not a git repository' };
      return { ok: true, sha: FIXED_SHA, headSha: FIXED_HEAD, treeSha: FIXED_SHA };
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: {},
      chats: [chat],
      groups: [],
      activeBoardGroupId: null,
    });
    const run = createRun(chat, baseSnapshot());
    await capturePreTurnSnapshot(chat, run.runId);
    const annotated = findRunById(chat, run.runId);
    assert.equal(annotated?.preTurnSnapshotSha, FIXED_SHA);
    assert.equal(annotated?.headShaAtTurn, FIXED_HEAD);
    assert.ok(annotated?.snapshotCwd);
    assert.equal(createCalls.length, 1);
  });

  test('capturePostTurnSnapshot annotates post sha', async () => {
    setSnapshotCreateForTests(async () => ({
      ok: true,
      sha: FIXED_SHA,
      headSha: FIXED_HEAD,
    }));

    const chat = makeChat();
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: {},
      chats: [chat],
      groups: [],
      activeBoardGroupId: null,
    });
    const run = createRun(chat, baseSnapshot());
    await capturePostTurnSnapshot(chat, run.runId);
    assert.equal(findRunById(chat, run.runId)?.postTurnSnapshotSha, FIXED_SHA);
  });

  test('capture skips when git create fails', async () => {
    createOk = false;
    setSnapshotCreateForTests(async () => {
      createCalls.push({});
      return { ok: false, error: 'not a git repository' };
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: {},
      chats: [chat],
      groups: [],
      activeBoardGroupId: null,
    });
    const run = createRun(chat, baseSnapshot());
    await capturePreTurnSnapshot(chat, run.runId);
    assert.equal(findRunById(chat, run.runId)?.preTurnSnapshotSha, undefined);
  });

  test('resolveTurnSnapshotCwd returns undefined for worktree chats', () => {
    assert.equal(resolveTurnSnapshotCwd(makeChat({ worktreeRoot: 'C:\\wt' })), undefined);
  });
});
