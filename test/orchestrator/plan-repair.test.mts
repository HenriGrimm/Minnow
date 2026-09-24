/**
 * Plan-repairer runner: background spawn, wait, retry createBoard, no activeId steal.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { SubAgentRun } from '../../src/agents/types.ts';
import { PlanParseFailure } from '../../src/orchestrator/client.ts';
import {
  buildPlanRepairTask,
  cancelPlanRepair,
  planRepairBackgroundKey,
  resetPlanRepairForTests,
  startPlanRepair,
  type PlanRepairHooks,
} from '../../src/orchestrator/plan-repair.ts';
import {
  createEmptyChatObject,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';

const PLAN_PATH = 'documentation/plans/alpha.md';
const WORKSPACE = 'C:/Users/test/workspace';
const PARSE_ERRORS = [
  {
    line: 12,
    column: 1,
    message: 'missing Touches',
    hint: 'Add a Touches list',
  },
];

function seedSession(activeId?: string) {
  const existing = createEmptyChatObject('m1', WORKSPACE);
  existing.modeId = 'build';
  existing.name = 'User chat';
  setSessionStateForTests({
    version: 5,
    activeId: activeId ?? existing.id,
    sidebarCollapsed: false,
    groups: [],
    chats: [existing],
  });
  return existing;
}

function completedRun(runId: string): SubAgentRun {
  return {
    runId,
    type: 'plan-repairer',
    task: '',
    status: 'completed',
    parentChatId: null,
    parentToolCallId: null,
    parentTurnId: null,
    summary: 'repaired',
    error: null,
    startedAt: null,
    endedAt: null,
    toolTurns: 1,
    cancelled: false,
    messages: [],
  };
}

function waitResult(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  extra: { error?: string; summary?: string; cancelled?: boolean } = {},
) {
  return {
    runId,
    type: 'plan-repairer',
    status,
    summary: extra.summary ?? '',
    outcome: { summary: extra.summary ?? '', findings: [], artifacts: [] },
    startedAt: null,
    endedAt: null,
    toolTurns: 1,
    cancelled: extra.cancelled ?? status === 'cancelled',
    ...(extra.error ? { error: extra.error } : {}),
  };
}

afterEach(() => {
  resetPlanRepairForTests();
  setSessionStateForTests(null);
  resetWorkspaceStateForTests();
});

describe('buildPlanRepairTask', () => {
  test('includes the plan path, line errors, and narrow repair rules', () => {
    const task = buildPlanRepairTask(PLAN_PATH, PARSE_ERRORS);
    assert.match(task, /documentation\/plans\/alpha\.md/);
    assert.match(task, /line 12:1/);
    assert.match(task, /missing Touches/);
    assert.match(task, /Add a Touches list/);
    assert.match(task, /schema and dependency corrections only/i);
    assert.match(task, /missing task dependency/);
    assert.match(task, /save_file/);
  });
});

describe('planRepairBackgroundKey', () => {
  test('is stable per workspace and plan path', () => {
    const a = planRepairBackgroundKey(WORKSPACE, PLAN_PATH);
    const b = planRepairBackgroundKey(WORKSPACE, PLAN_PATH);
    assert.equal(a, b);
    assert.match(a, /^plan-repair:/);
    assert.match(a, /alpha\.md/);
  });
});

describe('startPlanRepair', () => {
  test('spawns plan-repairer on a background chat without changing activeId', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    const existing = seedSession();
    const activeBefore = sessionState?.activeId;
    const spawns: Array<Record<string, unknown>> = [];
    const created: string[] = [];

    const hooks: PlanRepairHooks = {
      spawnSubAgent: async (input) => {
        spawns.push(input as unknown as Record<string, unknown>);
        return { runId: 'run-repair-1', status: 'running' };
      },
      waitForSubAgent: async (runId) => waitResult(runId, 'completed', { summary: 'repaired' }),
      getSubAgentRun: (runId) => completedRun(runId),
      cancelSubAgent: () => ({ ok: true, runId: '', status: 'cancelled' }),
    };

    const result = await startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async (planPath) => {
          created.push(planPath);
          return { boardId: 'alpha' };
        },
      },
      hooks,
    );

    assert.deepEqual(result, { ok: true, boardId: 'alpha' });
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0]?.type, 'plan-repairer');
    assert.match(String(spawns[0]?.task), /documentation\/plans\/alpha\.md/);
    assert.equal(spawns[0]?.wait, false);
    assert.equal(spawns[0]?.parentTurnId, null);
    assert.equal(typeof spawns[0]?.parentChatId, 'string');
    assert.notEqual(spawns[0]?.parentChatId, existing.id);
    assert.deepEqual(created, [PLAN_PATH]);
    assert.equal(sessionState?.activeId, activeBefore);

    const repairChat = sessionState?.chats.find((c) => c.backgroundKey?.startsWith('plan-repair:'));
    assert.ok(repairChat, 'expected a background repair chat');
    assert.equal(repairChat.modeId, 'plan');
    assert.equal(repairChat.name, 'Repair plan');
    assert.equal(repairChat.background, true);
  });

  test('does not retry createBoard when the agent fails', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    seedSession();
    let createCalls = 0;

    const result = await startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async () => {
          createCalls += 1;
          return { boardId: 'alpha' };
        },
      },
      {
        spawnSubAgent: async () => ({ runId: 'run-fail', status: 'running' }),
        waitForSubAgent: async (runId) =>
          waitResult(runId, 'failed', { error: 'agent crashed', summary: 'nope' }),
        getSubAgentRun: (runId) => ({
          ...completedRun(runId),
          status: 'failed',
          error: 'agent crashed',
          summary: 'nope',
        }),
        cancelSubAgent: () => ({ ok: true, runId: '', status: 'cancelled' }),
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok && 'error' in result) assert.match(result.error, /agent crashed/);
    assert.equal(createCalls, 0);
  });

  test('returns parseFailure when the retry still does not parse', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    seedSession();
    const leftover = new PlanParseFailure('the plan does not parse', [
      { line: 4, column: 1, message: 'missing name', hint: 'add YAML name' },
    ]);

    const result = await startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async () => {
          throw leftover;
        },
      },
      {
        spawnSubAgent: async () => ({ runId: 'run-ok', status: 'running' }),
        waitForSubAgent: async (runId) => waitResult(runId, 'completed', { summary: 'repaired' }),
        getSubAgentRun: (runId) => completedRun(runId),
        cancelSubAgent: () => ({ ok: true, runId: '', status: 'cancelled' }),
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok && 'parseFailure' in result) {
      assert.equal(result.parseFailure.errors[0]?.message, 'missing name');
    } else {
      assert.fail('expected parseFailure');
    }
  });

  test('returns alreadyRunning when the same plan is in flight', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    seedSession();
    let releaseWait: () => void = () => {};
    const waiting = new Promise<ReturnType<typeof waitResult>>((resolve) => {
      releaseWait = () => resolve(waitResult('run-slow', 'completed', { summary: 'repaired' }));
    });

    const hooks: PlanRepairHooks = {
      spawnSubAgent: async () => ({ runId: 'run-slow', status: 'running' }),
      waitForSubAgent: async () => waiting,
      getSubAgentRun: (runId) => completedRun(runId),
      cancelSubAgent: () => ({ ok: true, runId: 'run-slow', status: 'cancelled' }),
    };

    const first = startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async () => ({ boardId: 'alpha' }),
      },
      hooks,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async () => ({ boardId: 'alpha' }),
      },
      hooks,
    );
    assert.deepEqual(second, { ok: false, alreadyRunning: true });

    releaseWait();
    const settled = await first;
    assert.deepEqual(settled, { ok: true, boardId: 'alpha' });
  });

  test('cancelPlanRepair cancels the in-flight run', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    seedSession();
    const cancelled: string[] = [];
    let releaseWait: () => void = () => {};
    const waiting = new Promise<ReturnType<typeof waitResult>>((resolve) => {
      releaseWait = () =>
        resolve(waitResult('run-cancel', 'cancelled', { cancelled: true, summary: 'stopped' }));
    });

    const hooks: PlanRepairHooks = {
      spawnSubAgent: async () => ({ runId: 'run-cancel', status: 'running' }),
      waitForSubAgent: async () => waiting,
      getSubAgentRun: (runId) => ({
        ...completedRun(runId),
        status: 'cancelled',
        cancelled: true,
      }),
      cancelSubAgent: (runId) => {
        cancelled.push(runId);
        return { ok: true, runId, status: 'cancelled' };
      },
    };

    const pending = startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async () => ({ boardId: 'alpha' }),
      },
      hooks,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelPlanRepair(PLAN_PATH, hooks);
    releaseWait();
    const result = await pending;

    assert.deepEqual(cancelled, ['run-cancel']);
    assert.equal(result.ok, false);
    if (!result.ok && 'error' in result) assert.match(result.error, /cancelled/i);
  });
});
