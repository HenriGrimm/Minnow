/**
 * Server session validator — v1 input persists as current SESSION_SCHEMA_VERSION.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateSessionState } from '../../server/config/validators.js';

describe('validateSessionState workspace schema', () => {
  it('accepts v1 input and returns version 6 with workspacePath', () => {
    const out = validateSessionState({
      version: 1,
      activeId: 'chat-1',
      sidebarCollapsed: false,
      chats: [
        {
          id: 'chat-1',
          name: 'Old',
          modelId: '',
          history: [],
          updatedAt: 1,
        },
      ],
    });

    assert.equal(out.version, 6);
    assert.equal(out.chats[0].workspacePath, '');
    assert.deepEqual(out.lastActiveChatIdByWorkspace, {});
    assert.deepEqual(out.groups, []);
  });

  it('accepts v5 input with sidebar groups', () => {
    const out = validateSessionState({
      version: 5,
      activeId: 'chat-1',
      sidebarCollapsed: false,
      activeBoardGroupId: 'grp-1',
      groups: [
        {
          id: 'grp-1',
          name: 'Plan A',
          workspacePath: 'C:/demo',
          collapsed: false,
          order: 0,
          createdAt: 1,
        },
      ],
      chats: [
        {
          id: 'chat-1',
          name: 'Planner',
          workspacePath: 'C:/demo',
          modelId: '',
          boardGroupId: 'grp-1',
          history: [],
          updatedAt: 1,
        },
      ],
    });

    assert.equal(out.version, 6);
    assert.equal(out.activeBoardGroupId, 'grp-1');
    assert.equal(out.groups[0].name, 'Plan A');
    assert.equal(out.chats[0].boardGroupId, 'grp-1');
  });

  it('drops stored Email appScope and remaps email mode to general', () => {
    const out = validateSessionState({
      version: 6,
      activeId: 'email-chat-1',
      sidebarCollapsed: false,
      lastActiveChatIdByApp: { email: 'email-chat-1' },
      chats: [
        {
          id: 'email-chat-1',
          name: 'Inbox help',
          appScope: 'email',
          workspacePath: 'C:/Users/test/.minnow/chats',
          modelId: 'test-model',
          modeId: 'email',
          history: [{ role: 'user', content: 'Summarize this thread' }],
          updatedAt: 1,
        },
      ],
    });

    assert.equal(out.chats[0].modeId, 'general');
    assert.equal(out.chats[0].appScope, undefined);
    assert.equal(out.lastActiveChatIdByApp.email, undefined);
  });

  it('preserves MIN-275 worktree isolation fields on chats and board tasks', () => {
    const worktreeRoot =
      'C:/Users/test/.minnow/worktrees/repo-abc/grp-1/task-W5-A';
    const out = validateSessionState({
      version: 5,
      activeId: 'test-chat',
      sidebarCollapsed: false,
      groups: [
        {
          id: 'grp-1',
          name: 'Board',
          workspacePath: 'C:/demo/Water Tracker',
          collapsed: false,
          order: 0,
          createdAt: 1,
          orchestrateBoard: {
            planPath: 'documentation/plans/p.md',
            startedAt: 1,
            lastUpdatedAt: 1,
            status: 'running',
            isolationMode: 'per-task',
            integrationBranch: 'minnow/board/grp-1/integration',
            waves: [{ id: 'W5', status: 'in_progress' }],
            tasks: [
              {
                id: 'W5-A',
                title: 'Notifications',
                wave: 'W5',
                category: 'test',
                status: 'testing',
                worktreePath: worktreeRoot,
                worktreeBranch: 'minnow/board/grp-1/task/W5-A',
                devPort: 5200,
              },
            ],
          },
        },
      ],
      chats: [
        {
          id: 'test-chat',
          name: 'Test W5-A',
          workspacePath: 'C:/demo/Water Tracker',
          modelId: '',
          boardGroupId: 'grp-1',
          boardTaskId: 'W5-A',
          worktreeRoot,
          workAgentId: 'tester',
          history: [],
          updatedAt: 1,
        },
      ],
    });

    assert.equal(out.chats[0].worktreeRoot, worktreeRoot);
    assert.equal(out.chats[0].boardTaskId, 'W5-A');
    assert.equal(out.chats[0].workAgentId, 'tester');
    const board = out.groups[0].orchestrateBoard;
    assert.equal(board.isolationMode, 'per-task');
    assert.equal(board.integrationBranch, 'minnow/board/grp-1/integration');
    assert.equal(board.tasks[0].worktreePath, worktreeRoot);
    assert.equal(board.tasks[0].worktreeBranch, 'minnow/board/grp-1/task/W5-A');
    assert.equal(board.tasks[0].devPort, 5200);
  });

  it('preserves superPlan on chats across validateSessionState round-trip', () => {
    const stages = {
      grill: { status: 'done' },
      spec_confirm: { status: 'done' },
      research: { status: 'running', startedAt: 2000 },
      draft1: { status: 'pending' },
      review1: { status: 'pending' },
      draft2: { status: 'pending' },
      review2: { status: 'pending' },
      impeccable: { status: 'pending' },
      finalize: { status: 'pending' },
      present: { status: 'pending' },
    };
    const out = validateSessionState({
      version: 5,
      activeId: 'chat-sp',
      sidebarCollapsed: false,
      chats: [
        {
          id: 'chat-sp',
          name: 'Super Plan chat',
          workspacePath: '',
          modelId: 'test-model',
          modeId: 'super-plan',
          history: [{ role: 'user', content: 'Add OAuth login' }],
          updatedAt: 1,
          superPlan: {
            slug: 'oauth',
            prompt: 'Add OAuth login',
            activeStage: 'research',
            stages,
            specPath: 'documentation/plans/references/oauth-spec.md',
            researchPath: 'documentation/plans/references/oauth-research.md',
            planPath: 'documentation/plans/oauth.md',
            uiInvolved: false,
            researchId: 'research-run-1',
          },
        },
      ],
    });

    assert.equal(out.chats[0].modeId, 'plan');
    assert.deepEqual(out.chats[0].superPlan, {
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'research',
      stages,
      specPath: 'documentation/plans/references/oauth-spec.md',
      researchPath: 'documentation/plans/references/oauth-research.md',
      planPath: 'documentation/plans/oauth.md',
      uiInvolved: false,
      researchId: 'research-run-1',
    });
  });

  it('preserves activeGoal on chats across validateSessionState round-trip', () => {
    const out = validateSessionState({
      version: 5,
      activeId: 'chat-1',
      sidebarCollapsed: false,
      chats: [
        {
          id: 'chat-1',
          name: 'Goal chat',
          workspacePath: '',
          modelId: 'test-model',
          history: [],
          updatedAt: 1,
          activeGoal: {
            conditionText: 'All tests pass',
            startedAt: 1000,
            turnCount: 3,
            tokenBaseline: 500,
            lastReason: 'Still failing lint',
            achieved: false,
          },
        },
      ],
    });

    assert.deepEqual(out.chats[0].activeGoal, {
      conditionText: 'All tests pass',
      startedAt: 1000,
      turnCount: 3,
      tokenBaseline: 500,
      lastReason: 'Still failing lint',
    });
  });

  it('migrates v5 expertSelection to v6 expertId and expertRuntime', () => {
    const out = validateSessionState({
      version: 5,
      activeId: 'chat-1',
      sidebarCollapsed: false,
      chats: [
        {
          id: 'chat-1',
          name: 'Expert chat',
          workspacePath: '',
          modelId: 'test-model',
          kind: 'expert',
          expertSelection: { mode: 'manual', expertId: 'software-engineer' },
          history: [],
          updatedAt: 1,
        },
      ],
    });

    assert.equal(out.version, 6);
    assert.equal(out.chats[0].expertId, 'software-engineer');
    assert.ok(out.chats[0].expertRuntime);
    assert.equal(out.chats[0].expertSelection, undefined);
  });

  it('rejects unknown session versions', () => {
    assert.throws(
      () =>
        validateSessionState({
          version: 99,
          activeId: 'x',
          chats: [],
        }),
      /Invalid session version/,
    );
  });

  it('preserves previously dropped Chat fields and codeChangeTotalsByWorkspace', () => {
    const out = validateSessionState({
      version: 6,
      activeId: 'chat-drop',
      sidebarCollapsed: false,
      codeChangeTotalsByWorkspace: {
        'C:/demo': { additions: 9, deletions: 2 },
      },
      chats: [
        {
          id: 'chat-drop',
          name: 'Drop test',
          workspacePath: 'C:/demo',
          modelId: 'm',
          history: [],
          updatedAt: 1,
          subAgentRuns: [
            {
              runId: 'r1',
              parentTurnId: 't1',
              type: 'explore',
              task: 'x',
              status: 'completed',
              summary: 'ok',
              toolTurns: 0,
              messages: [],
            },
          ],
          todos: [{ text: 'one', status: 'pending' }],
          todosUpdatedAt: 42,
          tokenLedger: {
            entries: [],
            totals: {
              promptTokens: 1,
              completionTokens: 2,
              totalTokens: 3,
              costUsd: 0,
              completionCount: 1,
            },
            bySource: {},
          },
          codeChangeTotals: { additions: 4, deletions: 1 },
          codeChangeBackfillAt: 99,
          lastContextTrim: { archived: 1, recalled: 0, recallTokens: 10 },
          composerDraft: 'draft',
          pinnedSkill: { id: 'caveman', intensity: 'full' },
          thinkingMode: 'off',
          reasoningEffort: 'high',
          uiDesignerMode: 'implement',
          pendingSteerMessage: 'steer',
          pendingMessageQueue: [{ id: 'q1', text: 'next', createdAt: 7 }],
          pendingModeId: 'plan',
          turnError: true,
        },
      ],
    });

    const chat = out.chats[0];
    assert.equal(chat.todos[0].text, 'one');
    assert.equal(chat.todosUpdatedAt, 42);
    assert.equal(chat.tokenLedger.totals.totalTokens, 3);
    assert.deepEqual(chat.codeChangeTotals, { additions: 4, deletions: 1 });
    assert.equal(chat.codeChangeBackfillAt, 99);
    assert.deepEqual(chat.lastContextTrim, { archived: 1, recalled: 0, recallTokens: 10 });
    assert.equal(chat.composerDraft, 'draft');
    assert.deepEqual(chat.pinnedSkill, { id: 'caveman', intensity: 'full' });
    assert.equal(chat.thinkingMode, 'off');
    assert.equal(chat.reasoningEffort, 'high');
    assert.equal(chat.uiDesignerMode, 'implement');
    assert.equal(chat.pendingSteerMessage, 'steer');
    assert.equal(chat.pendingMessageQueue[0].text, 'next');
    assert.equal(chat.pendingModeId, 'plan');
    assert.equal(chat.turnError, true);
    assert.equal(chat.subAgentRuns[0].runId, 'r1');
    assert.deepEqual(out.codeChangeTotalsByWorkspace['C:/demo'], {
      additions: 9,
      deletions: 2,
    });
  });

  it('keeps durable chat file and URL links (MIN-630)', () => {
    const out = validateSessionState({
      version: 6,
      activeId: 'chat-links',
      sidebarCollapsed: false,
      chats: [
        {
          id: 'chat-links',
          name: 'Linked',
          workspacePath: '',
          modelId: '',
          history: [],
          updatedAt: 1,
          links: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              kind: 'file',
              path: 'src/main.ts',
              label: 'main.ts',
              addedAt: 1,
            },
            {
              id: '22222222-2222-2222-2222-222222222222',
              kind: 'url',
              url: 'https://example.com/docs',
              label: 'example.com',
              addedAt: 2,
            },
          ],
        },
      ],
    });
    assert.deepEqual(out.chats[0].links, [
      {
        id: '11111111-1111-1111-1111-111111111111',
        kind: 'file',
        path: 'src/main.ts',
        label: 'main.ts',
        addedAt: 1,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        kind: 'url',
        url: 'https://example.com/docs',
        label: 'example.com',
        addedAt: 2,
      },
    ]);
  });

  it('does not trim chats above the former MAX_CHATS limit', () => {
    const chats = [];
    for (let i = 0; i < 55; i += 1) {
      chats.push({
        id: `chat-${i}`,
        name: `Chat ${i}`,
        modelId: '',
        history: [],
        updatedAt: i + 1,
        lastMessageAt: i + 1,
      });
    }
    const out = validateSessionState({
      version: 6,
      activeId: 'chat-54',
      sidebarCollapsed: false,
      chats,
    });
    assert.equal(out.chats.length, 55);
  });
});
