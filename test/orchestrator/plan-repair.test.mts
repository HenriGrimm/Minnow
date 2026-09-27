/**
 * Plan repair runner: regular Plan chat turn, retry createBoard, no activeId steal.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
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
import type { Chat } from '../../src/types.ts';

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

/** Hooks with an idle chat and an instant, successful turn unless overridden. */
function chatHooks(overrides: PlanRepairHooks = {}): PlanRepairHooks {
  return {
    isChatBusy: () => false,
    sendChatText: async () => {},
    stopChat: () => {},
    ...overrides,
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
    assert.match(task, /^Edit the file in place/m);
    assert.match(task, /replace_text_in_file/);
    assert.doesNotMatch(task, /\brewrite the file\b/i);
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
  test('sends the task as a turn in a regular Plan chat without changing activeId', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    const existing = seedSession();
    const activeBefore = sessionState?.activeId;
    const sends: Array<{ chat: Chat; text: string }> = [];
    const created: string[] = [];

    const result = await startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async (planPath) => {
          created.push(planPath);
          return { boardId: 'alpha' };
        },
      },
      chatHooks({
        sendChatText: async (chat, text) => {
          sends.push({ chat, text });
        },
      }),
    );

    assert.deepEqual(result, { ok: true, boardId: 'alpha' });
    assert.equal(sends.length, 1);
    assert.match(sends[0]!.text, /documentation\/plans\/alpha\.md/);
    assert.notEqual(sends[0]!.chat.id, existing.id);
    assert.deepEqual(created, [PLAN_PATH]);
    assert.equal(sessionState?.activeId, activeBefore);

    const repairChat = sessionState?.chats.find((c) => c.backgroundKey?.startsWith('plan-repair:'));
    assert.ok(repairChat, 'expected a repair chat');
    assert.equal(repairChat.id, sends[0]!.chat.id);
    assert.equal(repairChat.modeId, 'plan');
    assert.equal(repairChat.name, 'Repair plan');
  });

  test('reuses the same chat for a second repair of the same plan', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    seedSession();
    const chatIds: string[] = [];
    const hooks = chatHooks({
      sendChatText: async (chat) => {
        chatIds.push(chat.id);
      },
    });
    const input = {
      planPath: PLAN_PATH,
      errors: PARSE_ERRORS,
      createBoard: async () => ({ boardId: 'alpha' }),
    };

    await startPlanRepair(input, hooks);
    await startPlanRepair(input, hooks);

    assert.equal(chatIds.length, 2);
    assert.equal(chatIds[0], chatIds[1]);
  });

  test('does not retry createBoard when the turn fails', async () => {
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
      chatHooks({
        sendChatText: async () => {
          throw new Error('Select a model first');
        },
      }),
    );

    assert.equal(result.ok, false);
    if (!result.ok && 'error' in result) assert.match(result.error, /Select a model first/);
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
      chatHooks(),
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
    let releaseTurn: () => void = () => {};
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const hooks = chatHooks({ sendChatText: () => turn });

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

    releaseTurn();
    const settled = await first;
    assert.deepEqual(settled, { ok: true, boardId: 'alpha' });
  });

  test('returns alreadyRunning without sending when the chat is mid-turn', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    seedSession();
    let sends = 0;

    const result = await startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async () => ({ boardId: 'alpha' }),
      },
      chatHooks({
        isChatBusy: () => true,
        sendChatText: async () => {
          sends += 1;
        },
      }),
    );

    assert.deepEqual(result, { ok: false, alreadyRunning: true });
    assert.equal(sends, 0);
  });

  test('cancelPlanRepair stops the repair chat turn', async () => {
    setWorkspaceFromServer({ path: WORKSPACE, label: 'workspace', isDefault: false });
    seedSession();
    const stopped: string[] = [];
    let rejectTurn: (err: Error) => void = () => {};
    const turn = new Promise<void>((_resolve, reject) => {
      rejectTurn = reject;
    });
    let sentChatId = '';
    let createCalls = 0;

    const hooks = chatHooks({
      sendChatText: (chat) => {
        sentChatId = chat.id;
        return turn;
      },
      stopChat: (chatId) => {
        stopped.push(chatId);
        rejectTurn(new Error('Follow-up turn did not complete'));
      },
    });

    const pending = startPlanRepair(
      {
        planPath: PLAN_PATH,
        errors: PARSE_ERRORS,
        createBoard: async () => {
          createCalls += 1;
          return { boardId: 'alpha' };
        },
      },
      hooks,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelPlanRepair(PLAN_PATH, hooks);
    const result = await pending;

    assert.deepEqual(stopped, [sentChatId]);
    assert.equal(createCalls, 0);
    assert.equal(result.ok, false);
    if (!result.ok && 'error' in result) assert.match(result.error, /cancelled/i);
  });
});
