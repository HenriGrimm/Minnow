/**
 * P4-B: leftover V1 session boards must not emit completion notifications.
 *
 * Board toasts come from the V2 journal (`run.finished` / attempt events), not
 * from mutating `ChatGroup.orchestrateBoard`. The old handleBoardChange hook
 * is deleted (MIN-714).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('leftover board rows do not produce notifications (MIN-714)', () => {
  let store;
  let producers;
  let sessions;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.localStorage = win.localStorage;

    store = await import('../../src/notifications/store.ts');
    producers = await import('../../src/notifications/producers.ts');
    sessions = await import('../../src/state/sessions.ts');

    store.resetNotificationStoreForTests();
    producers.resetNotificationProducersForTests();
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'planner-1',
      chats: [],
      groups: [],
    });
  });

  afterEach(() => {
    store.resetNotificationStoreForTests();
    producers.resetNotificationProducersForTests();
    sessions.setSessionStateForTests(null);
  });

  test('init does not fire board_complete for leftover hydrated boards', () => {
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'planner-1',
      chats: [],
      groups: [
        {
          id: 'grp-1',
          name: 'Board',
          workspacePath: '/ws',
          collapsed: false,
          order: 0,
          createdAt: 1,
          plannerChatId: 'planner-1',
          orchestrateBoard: {
            planPath: 'docs/plans/test.md',
            startedAt: 1,
            lastUpdatedAt: 2,
            waves: [{ id: 'W1', status: 'planned' }],
            tasks: [
              {
                id: 'T1',
                title: 'Task One',
                wave: 'W1',
                category: 'build',
                status: 'quarantined',
              },
            ],
          },
        },
      ],
    });

    producers.initNotificationProducers();
    const kinds = store.getNotifications().map((n) => n.kind);
    assert.equal(kinds.includes('board_complete'), false);
    assert.equal(kinds.includes('board_blocked'), false);
    assert.equal(kinds.includes('task_quarantined'), false);
  });

  test('legacy sub-agent completions do not create notifications', () => {
    producers.__testHooks.handleSubAgentRun({ runId: 'done', status: 'completed', summary: 'Done' });
    assert.equal(store.getNotifications().length, 0);
  });

  test('producers no longer expose a leftover-board change hook', () => {
    assert.equal(
      typeof producers.__testHooks.handleBoardChange,
      'undefined',
      'V1 board lifecycle hook must stay deleted',
    );
    assert.equal(typeof producers.__testHooks.handleSubAgentRun, 'function');
  });
});
