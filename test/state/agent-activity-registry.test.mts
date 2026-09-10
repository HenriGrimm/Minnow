/**
 * Agent activity registry snapshot tests (fixed ids / timestamps).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MainTurnActivity } from '../../src/chat/main-turn-activity.ts';
import type { TitleJobActivity } from '../../src/chat/titles/activity-events.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';
import type { Chat } from '../../src/types.ts';
import {
  buildAgentActivitySnapshot,
  formatAgentActivityElapsed,
  formatAgentActivityStatusLine,
  sortAgentActivityRows,
  type AgentActivityRow,
} from '../../src/state/agent-activity-registry.ts';

const CHAT_A = '11111111-1111-1111-1111-111111111111';
const CHAT_B = '22222222-2222-2222-2222-222222222222';
const RUN_ID = 'run-00000000-0000-0000-0000-000000000001';
const NOW_MS = 1710000000000;
const STARTED_MS = 1710000000000 - 65_000;

const CHAT_FIXTURE: Chat = {
  id: CHAT_A,
  name: 'Alpha chat',
  modelId: 'test/model-a',
  providerId: 'lm-studio-local',
  history: [],
  lastStats: null,
  modelInfo: {},
  updatedAt: STARTED_MS,
};

function subAgentFixture(): SubAgentRun {
  return {
    runId: RUN_ID,
    type: 'explore',
    task: 'Search the codebase for auth middleware',
    status: 'running',
    parentChatId: CHAT_B,
    parentToolCallId: 'tc-parent-1',
    parentTurnId: 'turn-1',
    summary: '',
    error: null,
    startedAt: new Date(STARTED_MS).toISOString(),
    endedAt: null,
    toolTurns: 2,
    maxToolTurns: 12,
    cancelled: false,
    messages: [],
    liveCurrentToolName: 'Grep',
    modelId: 'test/sub-model',
    providerId: 'lm-studio-local',
  };
}

describe('agent-activity-registry', () => {
  test('buildAgentActivitySnapshot merges kinds and computes elapsed', () => {
    const mainTurn: MainTurnActivity = {
      chatId: CHAT_A,
      phase: 'tools',
      currentTool: 'Read',
      workAgentLabel: 'Builder',
      modelId: 'test/model-a',
      providerId: 'lm-studio-local',
      startedAtMs: STARTED_MS,
    };
    const titleJob: TitleJobActivity = {
      chatId: CHAT_B,
      modelId: 'test/title-model',
      startedAtMs: STARTED_MS + 1000,
    };

    const rows = buildAgentActivitySnapshot({
      nowMs: NOW_MS,
      chats: [
        CHAT_FIXTURE,
        {
          ...CHAT_FIXTURE,
          id: CHAT_B,
          name: 'Beta chat',
          currentGenerationId: undefined,
        },
      ],
      mainTurns: [mainTurn],
      subAgents: [subAgentFixture()],
      titleJobs: [titleJob],
      contextByChatId: new Map([[CHAT_A, { percent: 42, isEstimate: false }]]),
      resolveSubAgentLabel: () => 'Explore',
    });

    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.kind, 'main_turn');
    assert.equal(rows[0]?.elapsedMs, 65_000);
    assert.equal(rows[0]?.contextPercent, 42);
    assert.equal(rows[0]?.currentTool, 'Read');

    const subRow = rows.find((r) => r.kind === 'sub_agent');
    assert.ok(subRow);
    assert.equal(subRow.label, 'Explore');
    assert.equal(subRow.currentTool, 'Grep');
    assert.equal(subRow.chatTitle, 'Beta chat');
  });

  test('sortAgentActivityRows orders main before sub-agent', () => {
    const rows: AgentActivityRow[] = [
      {
        id: 'sub:1',
        kind: 'sub_agent',
        chatId: CHAT_A,
        chatTitle: 'A',
        label: 'Explore',
        status: 'running',
        modelDisplay: 'm',
        contextPercent: null,
        contextIsEstimate: true,
        startedAtMs: 100,
        elapsedMs: 0,
        elapsedFrozen: false,
      },
      {
        id: 'main:1',
        kind: 'main_turn',
        chatId: CHAT_A,
        chatTitle: 'A',
        label: 'Builder',
        status: 'generating',
        modelDisplay: 'm',
        contextPercent: null,
        contextIsEstimate: true,
        startedAtMs: 200,
        elapsedMs: 0,
        elapsedFrozen: false,
      },
    ];
    const sorted = sortAgentActivityRows(rows);
    assert.equal(sorted[0]?.kind, 'main_turn');
    assert.equal(sorted[1]?.kind, 'sub_agent');
  });

  test('formatAgentActivityElapsed and status line', () => {
    assert.equal(formatAgentActivityElapsed(125_000), '2:05');
    const row: AgentActivityRow = {
      id: 'main:1',
      kind: 'main_turn',
      chatId: CHAT_A,
      chatTitle: 'A',
      label: 'Builder',
      status: 'tools',
      modelDisplay: 'Model',
      currentTool: 'Shell',
      contextPercent: null,
      contextIsEstimate: true,
      startedAtMs: STARTED_MS,
      elapsedMs: 1000,
      elapsedFrozen: false,
    };
    assert.equal(formatAgentActivityStatusLine(row), 'Running Shell');
    assert.equal(
      formatAgentActivityStatusLine({ ...row, status: 'pending_question' }),
      'Pending question',
    );
  });

  test('pending ask_question freezes elapsed and status', () => {
    const mainTurn: MainTurnActivity = {
      chatId: CHAT_A,
      phase: 'generating',
      currentTool: null,
      workAgentLabel: 'Builder',
      modelId: 'test/model-a',
      providerId: 'lm-studio-local',
      startedAtMs: STARTED_MS,
      pausedAtMs: STARTED_MS + 30_000,
    };
    const rows = buildAgentActivitySnapshot({
      nowMs: NOW_MS,
      chats: [CHAT_FIXTURE],
      mainTurns: [mainTurn],
      subAgents: [],
      titleJobs: [],
      questionPendingChatIds: new Set([CHAT_A]),
    });
    assert.equal(rows[0]?.status, 'pending_question');
    assert.equal(rows[0]?.elapsedMs, 30_000);
    assert.equal(rows[0]?.elapsedFrozen, true);
    assert.equal(formatAgentActivityStatusLine(rows[0]!), 'Pending question');
  });

  test('stale currentGenerationId without a live main-turn still produces a main: fallback', () => {
    const rows = buildAgentActivitySnapshot({
      nowMs: NOW_MS,
      chats: [
        {
          ...CHAT_FIXTURE,
          currentGenerationId: 'gen-stale-1111',
        },
      ],
      mainTurns: [],
      subAgents: [],
      titleJobs: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, `main:${CHAT_A}`);
  });

  test('finished turn with no generation id and no mainTurns has no main: row', () => {
    const rows = buildAgentActivitySnapshot({
      nowMs: NOW_MS,
      chats: [
        {
          ...CHAT_FIXTURE,
          currentGenerationId: undefined,
        },
      ],
      mainTurns: [],
      subAgents: [],
      titleJobs: [],
    });
    assert.equal(rows.some((r) => r.id.startsWith('main:')), false);
  });
});
