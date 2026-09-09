/**
 * P9-B / P9-A / P9-G — the board surface, as DOM.
 *
 * The property under test is the one the whole phase is built around: **a card's
 * column is derived**. There is no drop handler, no status write, and no way for
 * this view to put a card anywhere the fold did not put it — so the tests assert
 * the mapping and assert that the writes on the page are commands.
 */
// First, and before the renderer imports: the detail panel renders task specs
// through the assistant markdown pipeline, and `dompurify` builds its sanitizer
// against `globalThis.window` at module eval.
import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { derive } from '../../server/orchestrator/core/derive.js';
import type { BoardState } from '../../server/orchestrator/core/types';
import { bucketWave, columnOf, isBlocked } from '../../src/orchestrator/board-columns.ts';
import {
  buildTaskCardMenuItems,
  renderBoardHeader,
  renderBoardSkeleton,
  renderEngineErrors,
  renderRunLedger,
  renderTaskList,
  retryCount,
  syncTaskCardActivity,
  thinkingGlimpse,
  type BoardActions,
} from '../../src/orchestrator/board-render.ts';
import type { MenuActionItem } from '../../src/ui/context-menu.ts';
import {
  renderTaskDetail,
  resetTaskDetailUi,
} from '../../src/orchestrator/task-detail.ts';

let activeWindow: Window | undefined;

function setupDom(): void {
  activeWindow?.close();
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
  // The detail panel remembers open disclosures across repaints, so each test
  // starts from the same place rather than from the last one's clicks.
  resetTaskDetailUi();
}

afterEach(() => {
  // The column-mapping tests are pure and never mount a DOM, so there may be
  // no `document` to clear.
  if (activeWindow) document.body.innerHTML = '';
  activeWindow?.close();
  activeWindow = undefined;
});

const NO_ACTIONS: BoardActions = {
  startTask: () => {},
  abandonTask: () => {},
  resetTask: () => {},
  rewindTask: () => {},
  rerun: () => {},
  select: () => {},
  openTranscript: () => {},
  toggleFileDiff: () => {},
  openFile: () => {},
};

const OPTIONS = { selectedTaskId: null, pendingTaskIds: new Set<string>() };

function menuAction(items: ReturnType<typeof buildTaskCardMenuItems>, id: string): MenuActionItem {
  const row = items.find((item): item is MenuActionItem => 'id' in item && item.id === id);
  assert.ok(row, `expected menu item ${id}`);
  return row;
}

function taskMenuItems(state: BoardState, taskId: string, actions = NO_ACTIONS): MenuActionItem[] {
  const task = state.tasks.get(taskId);
  assert.ok(task, `missing task ${taskId}`);
  return buildTaskCardMenuItems(state, task, actions, OPTIONS) as MenuActionItem[];
}

/** A board with W1-A merged, W1-B building, W1-C depending on an unmerged W1-B. */
function board(extra: Record<string, unknown>[] = []): BoardState {
  return derive([
    {
      v: 1,
      seq: 1,
      type: 'board.created',
      boardId: 'b1',
      planPath: 'documentation/plans/x.md',
      name: 'Example',
      waves: [{ n: 1, name: 'Foundations' }],
      tasks: [
        { id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] },
        { id: 'W1-B', title: 'B', wave: 1, dependsOn: [], touches: ['b.ts'] },
        { id: 'W1-C', title: 'C', wave: 1, dependsOn: ['W1-B'], touches: ['c.ts'] },
        { id: 'W1-D', title: 'D', wave: 1, dependsOn: [], touches: ['d.ts'] },
      ],
    },
    { v: 1, seq: 2, type: 'board.started', concurrency: 2 },
    {
      v: 1,
      seq: 3,
      type: 'task.attempt.started',
      taskId: 'W1-A',
      attemptId: 'a1',
      role: 'builder',
    },
    {
      v: 1,
      seq: 4,
      type: 'task.attempt.ended',
      taskId: 'W1-A',
      attemptId: 'a1',
      role: 'builder',
      outcome: 'pass',
    },
    { v: 1, seq: 5, type: 'merge.enqueued', taskId: 'W1-A' },
    { v: 1, seq: 6, type: 'merge.succeeded', taskId: 'W1-A', sha: 'abc123' },
    {
      v: 1,
      seq: 7,
      type: 'task.attempt.started',
      taskId: 'W1-B',
      attemptId: 'b1',
      role: 'builder',
    },
    ...extra,
  ]);
}

// ── column mapping ───────────────────────────────────────────────────────────

describe('column mapping', () => {
  test('every phase lands in exactly one column', () => {
    const state = board();
    assert.equal(columnOf(state, state.tasks.get('W1-A')!), 'complete');
    assert.equal(columnOf(state, state.tasks.get('W1-B')!), 'in_progress');
    assert.equal(columnOf(state, state.tasks.get('W1-C')!), 'planned');
    assert.equal(columnOf(state, state.tasks.get('W1-D')!), 'planned');
  });

  test('a testing attempt is its own column, and merging is not', () => {
    const state = board([
      {
        v: 1,
        seq: 8,
        type: 'task.attempt.started',
        taskId: 'W1-D',
        attemptId: 'd1',
        role: 'tester',
      },
    ]);
    assert.equal(columnOf(state, state.tasks.get('W1-D')!), 'testing');
    // `merging` is in-flight work, not a fourth state: V1 grouped it with
    // In Progress and so does this.
    assert.equal(columnOf(state, state.tasks.get('W1-B')!), 'in_progress');
  });

  test('abandoned and skipped share Complete with merged', () => {
    const state = board([
      { v: 1, seq: 8, type: 'task.abandoned', taskId: 'W1-D', reason: 'user' },
    ]);
    assert.equal(columnOf(state, state.tasks.get('W1-D')!), 'complete');
    assert.equal(columnOf(state, state.tasks.get('W1-A')!), 'complete');
  });

  test('Blocked is a Planned task whose dependency has not merged', () => {
    const state = board();
    assert.equal(isBlocked(state, state.tasks.get('W1-C')!), true, 'C waits on B');
    assert.equal(isBlocked(state, state.tasks.get('W1-D')!), false, 'D waits on nothing');
    // Not a separate column — a card cannot be in two places.
    assert.equal(columnOf(state, state.tasks.get('W1-C')!), 'planned');
  });

  test('bucketWave keeps every column, empty ones included', () => {
    const state = board();
    const buckets = bucketWave(state, state.taskOrder);
    assert.deepEqual([...buckets.keys()], ['planned', 'in_progress', 'testing', 'complete']);
    assert.deepEqual(buckets.get('testing'), []);
    assert.deepEqual(
      buckets.get('planned')!.map((t) => t.id),
      ['W1-C', 'W1-D'],
    );
  });
});

// ── renderTaskList ───────────────────────────────────────────────────────────

describe('renderTaskList', () => {
  test('renders one kanban grid per wave, with four lanes', () => {
    setupDom();
    const node = renderTaskList(board(), NO_ACTIONS, OPTIONS);
    const grids = node.querySelectorAll('.ov2-kanban');
    assert.equal(grids.length, 1);
    assert.deepEqual(
      [...grids[0]!.querySelectorAll('.ov2-col')].map((c) => (c as HTMLElement).dataset.column),
      ['planned', 'in_progress', 'testing', 'complete'],
    );
  });

  test('puts each card in the column the fold implies', () => {
    setupDom();
    const node = renderTaskList(board(), NO_ACTIONS, OPTIONS);
    const columnOfCard = (id: string) =>
      (node
        .querySelector(`[data-task-id="${id}"]`)
        ?.closest('.ov2-col') as HTMLElement | null)?.dataset.column;
    assert.equal(columnOfCard('W1-A'), 'complete');
    assert.equal(columnOfCard('W1-B'), 'in_progress');
    assert.equal(columnOfCard('W1-C'), 'planned');
  });

  test('has no drag affordance at all', () => {
    // V1's drop handler wrote a status. There is no status to write here, so
    // there must be nothing that looks like it can be dragged.
    setupDom();
    const node = renderTaskList(board(), NO_ACTIONS, OPTIONS);
    assert.equal(node.querySelectorAll('[draggable="true"]').length, 0);
    assert.equal(node.querySelectorAll('[data-drop-target]').length, 0);
  });

  test('says what a blocked card is waiting for', () => {
    setupDom();
    const node = renderTaskList(board(), NO_ACTIONS, OPTIONS);
    const card = node.querySelector('[data-task-id="W1-C"]')!;
    assert.equal(card.classList.contains('ov2-task--blocked'), true);
    assert.match(card.querySelector('.ov2-task__blocked')!.textContent!, /W1-B/);
  });

  test('a clean task claims no retries — build, test and merge are not tries', () => {
    setupDom();
    // W1-A ran a builder that passed and then merged: three attempts, nothing
    // retried. The old badge read "3 tries" here, which is the bug.
    const state = board();
    assert.equal(retryCount(state.tasks.get('W1-A')!), 0);
    const node = renderTaskList(state, NO_ACTIONS, OPTIONS);
    const card = node.querySelector('[data-task-id="W1-A"]')!;
    assert.equal(card.querySelector('.ov2-task__retries'), null);
    // The old copy. "Retry" the button is fine; "3 tries" the badge was not.
    assert.doesNotMatch(card.textContent!, /\d+ tr(y|ies)/);
  });

  test('a task picked up again counts that, and only that', () => {
    setupDom();
    const state = board([
      {
        v: 1,
        seq: 8,
        type: 'task.attempt.ended',
        taskId: 'W1-B',
        attemptId: 'b1',
        role: 'builder',
        outcome: 'fail',
      },
      {
        v: 1,
        seq: 9,
        type: 'task.attempt.started',
        taskId: 'W1-B',
        attemptId: 'b2',
        role: 'builder',
        seedKind: 'failure-aware',
      },
      {
        v: 1,
        seq: 10,
        type: 'task.attempt.ended',
        taskId: 'W1-B',
        attemptId: 'b2',
        role: 'builder',
        outcome: 'pass',
      },
    ]);
    assert.equal(retryCount(state.tasks.get('W1-B')!), 1);
    const node = renderTaskList(state, NO_ACTIONS, OPTIONS);
    const card = node.querySelector('[data-task-id="W1-B"]')!;
    assert.equal(card.querySelector('.ov2-task__retries')!.textContent, '1 retry');
  });

  test('a running card shows what the agent is doing and for how long', () => {
    setupDom();
    const state = board();
    const node = renderTaskList(state, NO_ACTIONS, {
      ...OPTIONS,
      liveActivity: new Map([
        ['W1-B', { attemptId: 'b1', role: 'builder', kind: 'tool' as const, text: 'read_file', settled: false }],
      ]),
      attemptStartedAt: new Map([['b1', 1_000]]),
      now: 1_000 + 95_000,
    });
    const card = node.querySelector('[data-task-id="W1-B"]')!;
    const activity = card.querySelector('.ov2-activity')!;
    // The tool reads as an action, not as a raw function name.
    assert.match(activity.querySelector('.ov2-activity__label')!.textContent!, /Read/);
    assert.equal(activity.querySelector('.ov2-activity__elapsed')!.textContent, '1:35');
    assert.ok(activity.querySelector('.tool-call-spinner'), 'a running tool spins');
  });

  test('a reconnected running card uses durable state without stale startup or crash labels', () => {
    setupDom();
    const state = board([
      {
        v: 1,
        seq: 8,
        type: 'task.attempt.ended',
        taskId: 'W1-D',
        attemptId: 'd1',
        role: 'builder',
        outcome: 'crashed',
      },
      {
        v: 1,
        seq: 9,
        type: 'task.attempt.started',
        taskId: 'W1-D',
        attemptId: 'd2',
        role: 'builder',
        seedKind: 'continue',
      },
    ]);
    const node = renderTaskList(state, NO_ACTIONS, {
      ...OPTIONS,
      // A reconnect restores this timestamp from the snapshot, but transient
      // thinking/tool frames are not replayed.
      attemptStartedAt: new Map([['d2', 1_000]]),
      now: 96_000,
    });
    const card = node.querySelector('[data-task-id="W1-D"]')!;
    assert.equal(card.querySelector('.ov2-activity__label')!.textContent, 'Running');
    assert.equal(card.querySelector('.ov2-activity__elapsed')!.textContent, '1:35');
    assert.doesNotMatch(card.querySelector('.ov2-task__badges')!.textContent!, /crashed/i);
    assert.equal(card.querySelector('.ov2-task__retries')!.textContent, '1 retry');
  });

  test('a thinking agent says what it is thinking, not the last tool it touched', () => {
    setupDom();
    const state = board();
    const node = renderTaskList(state, NO_ACTIONS, {
      ...OPTIONS,
      liveActivity: new Map([
        [
          'W1-B',
          {
            attemptId: 'b1',
            role: 'builder',
            kind: 'thinking' as const,
            text: 'The scaffold already has a vite config.',
            settled: false,
          },
        ],
      ]),
    });
    const activity = node.querySelector('[data-task-id="W1-B"] .ov2-activity')!;
    assert.ok(activity.classList.contains('ov2-activity--thinking'));
    assert.match(activity.textContent!, /vite config/);
  });

  test('a long thought shows the sentence being written, not its opening', () => {
    // The label ellipses on overflow, so pinning the head of a thought that
    // grows for minutes is what made a working agent read as stuck.
    const thought = [
      'The scaffold already has a vite config, so I should not add one.',
      'Next I need to check whether the dev server port is pinned.',
      'It is not, which explains the flake.',
    ].join(' ');
    assert.equal(thinkingGlimpse(thought), 'It is not, which explains the flake.');

    // A sentence that has barely started keeps the one before it for context.
    assert.match(thinkingGlimpse(`${thought} So`), /explains the flake\. So$/);

    // Reasoning arrives as paragraphs; the live one is the last non-empty line.
    assert.equal(
      thinkingGlimpse(`First para.

Second para.

`),
      'Second para.',
    );
    assert.equal(thinkingGlimpse(`
  `), '');
  });

  test('a card marks the gap where a tool is named but not yet sent', () => {
    setupDom();
    const state = board();
    const node = renderTaskList(state, NO_ACTIONS, {
      ...OPTIONS,
      liveActivity: new Map([
        [
          'W1-B',
          {
            attemptId: 'b1',
            role: 'builder',
            kind: 'tool' as const,
            text: 'save_file',
            settled: false,
            preparing: true,
          },
        ],
      ]),
    });
    const activity = node.querySelector('[data-task-id="W1-B"] .ov2-activity')!;
    assert.match(activity.querySelector('.ov2-activity__label')!.textContent!, /^Calling .+…$/);
    assert.ok(activity.querySelector('.tool-call-spinner'), 'a call being written spins');
  });

  test('a card says it is writing rather than holding the tool it just finished', () => {
    setupDom();
    const state = board();
    const card = renderTaskList(state, NO_ACTIONS, {
      ...OPTIONS,
      liveActivity: new Map([
        [
          'W1-B',
          { attemptId: 'b1', role: 'builder', kind: 'tool' as const, text: 'read_file', settled: true },
        ],
      ]),
    }).querySelector<HTMLElement>('[data-task-id="W1-B"]')!;
    assert.match(card.querySelector('.ov2-activity__label')!.textContent!, /Read/);

    syncTaskCardActivity(
      card,
      { attemptId: 'b1', role: 'builder', kind: 'writing', text: '', settled: false },
      null,
    );
    assert.equal(card.querySelector('.ov2-activity__label')!.textContent, 'Writing…');
    assert.ok(card.querySelector('.tool-call-spinner'), 'writing spins');
  });

  test('syncTaskCardActivity grows thinking without replacing the card head', () => {
    setupDom();
    const state = board();
    let selected: string | null = null;
    const actions: BoardActions = {
      ...NO_ACTIONS,
      select: (taskId) => {
        selected = taskId;
      },
    };
    const node = renderTaskList(state, actions, OPTIONS);
    const card = node.querySelector<HTMLElement>('[data-task-id="W1-B"]')!;
    const head = card.querySelector<HTMLElement>('.ov2-task__head')!;
    const row = card.querySelector<HTMLElement>('.ov2-activity')!;

    syncTaskCardActivity(
      card,
      {
        attemptId: 'b1',
        role: 'builder',
        kind: 'thinking',
        text: 'The scaffold already has a vite config.',
        settled: false,
      },
      1_000,
      2_000,
    );

    assert.equal(card.querySelector('.ov2-task__head'), head);
    assert.equal(card.querySelector('.ov2-activity'), row);
    assert.match(row.querySelector('.ov2-activity__label')!.textContent!, /vite config/);
    head.click();
    assert.equal(selected, 'W1-B');
  });

  test('a card with no attempt running shows no activity line at all', () => {
    setupDom();
    const node = renderTaskList(board(), NO_ACTIONS, OPTIONS);
    // W1-A merged; W1-C is blocked. Neither is doing anything.
    assert.equal(node.querySelector('[data-task-id="W1-A"] .ov2-activity'), null);
    assert.equal(node.querySelector('[data-task-id="W1-C"] .ov2-activity'), null);
  });

  test('a card that has failed offers Retry, not Start', () => {
    setupDom();
    const state = board([
      {
        v: 1,
        seq: 8,
        type: 'task.attempt.ended',
        taskId: 'W1-B',
        attemptId: 'b1',
        role: 'builder',
        outcome: 'fail',
      },
    ]);
    const start = menuAction(taskMenuItems(state, 'W1-B'), 'start:W1-B');
    assert.equal(start.label, 'Retry');
  });

  test('an abandoned task on a finished board offers enabled Retry', () => {
    setupDom();
    const state = derive([
      {
        v: 1,
        seq: 1,
        type: 'board.created',
        boardId: 'b1',
        planPath: 'p.md',
        name: 'Example',
        waves: [{ n: 1, name: 'One' }],
        tasks: [
          { id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] },
          { id: 'W1-B', title: 'B', wave: 1, dependsOn: [], touches: ['b.ts'] },
        ],
      },
      { v: 1, seq: 2, type: 'merge.succeeded', taskId: 'W1-A', sha: 'abc123abc123' },
      { v: 1, seq: 3, type: 'task.abandoned', taskId: 'W1-B', reason: 'builder-failed-twice' },
      { v: 1, seq: 4, type: 'final.test.ended', outcome: 'fail' },
      { v: 1, seq: 5, type: 'run.finished', summary: 'blocked' },
      { v: 1, seq: 6, type: 'board.stopped', reason: 'terminal' },
    ]);
    const calls: string[][] = [];
    const actions: BoardActions = {
      ...NO_ACTIONS,
      rerun: (ids) => calls.push(ids ?? []),
    };
    const start = menuAction(taskMenuItems(state, 'W1-B', actions), 'start:W1-B');
    assert.equal(start.disabled, false);
    assert.equal(start.label, 'Retry');
    void start.onSelect();
    assert.deepEqual(calls, [['W1-B']]);
  });

  test('Abandon is offered on live work and refused on finished work', () => {
    setupDom();
    const state = board();
    const live = menuAction(taskMenuItems(state, 'W1-B'), 'abandon:W1-B');
    assert.equal(live.disabled, false, 'a building task can be abandoned');
    const merged = taskMenuItems(state, 'W1-A');
    assert.equal(merged.some((item) => item.id === 'abandon:W1-A'), false);
    assert.ok(merged.some((item) => item.id === 'rewind:W1-A'));
  });

  test('Reset is hidden on a never-started card and shown when a card has debris', () => {
    setupDom();
    const liveState = board();
    assert.equal(
      taskMenuItems(liveState, 'W1-C').some((item) => item.id === 'reset:W1-C'),
      false,
      'W1-C has never run',
    );
    assert.equal(
      taskMenuItems(liveState, 'W1-D').some((item) => item.id === 'reset:W1-D'),
      false,
      'W1-D has never run',
    );
    assert.ok(
      taskMenuItems(liveState, 'W1-B').some((item) => item.id === 'reset:W1-B'),
      'a building card can reset',
    );

    const abandoned = board([
      {
        v: 1,
        seq: 8,
        type: 'task.attempt.ended',
        taskId: 'W1-B',
        attemptId: 'b1',
        role: 'builder',
        outcome: 'fail',
      },
      { v: 1, seq: 9, type: 'task.abandoned', taskId: 'W1-B', reason: 'user' },
    ]);
    assert.ok(
      taskMenuItems(abandoned, 'W1-B').some((item) => item.id === 'reset:W1-B'),
      'an abandoned card can reset',
    );
  });

  test('a merged card offers Rewind instead of Start, Abandon, or Reset', () => {
    setupDom();
    const state = board();
    const items = taskMenuItems(state, 'W1-A');
    assert.equal(items.some((item) => item.id === 'start:W1-A'), false);
    assert.equal(items.some((item) => item.id === 'abandon:W1-A'), false);
    assert.equal(items.some((item) => item.id === 'reset:W1-A'), false);
    const rewind = menuAction(items, 'rewind:W1-A');
    assert.equal(rewind.disabled, false);
    assert.equal(rewind.label, 'Rewind');
  });

  test('each card exposes one compact actions menu trigger', () => {
    setupDom();
    const node = renderTaskList(board(), NO_ACTIONS, OPTIONS);
    for (const card of node.querySelectorAll('.ov2-task')) {
      assert.equal(card.querySelectorAll('.ov2-task__menu').length, 1);
    }
  });

  test('every card carries a focus key that survives a repaint', () => {
    setupDom();
    const node = renderTaskList(board(), NO_ACTIONS, OPTIONS);
    const keys = [...node.querySelectorAll('.ov2-task__head')].map(
      (h) => (h as HTMLElement).dataset.focusKey,
    );
    assert.deepEqual(keys, ['task:W1-C', 'task:W1-D', 'task:W1-B', 'task:W1-A']);
  });

  test('selecting an already-open card does not toggle the overlay closed', () => {
    setupDom();
    const calls: Array<string | null> = [];
    const actions: BoardActions = {
      ...NO_ACTIONS,
      select: (id) => calls.push(id),
    };
    const node = renderTaskList(board(), actions, {
      selectedTaskId: 'W1-A',
      pendingTaskIds: new Set(),
    });
    node.querySelector<HTMLButtonElement>('[data-focus-key="task:W1-A"]')!.click();
    assert.deepEqual(calls, []);
    node.querySelector<HTMLButtonElement>('[data-focus-key="task:W1-B"]')!.click();
    assert.deepEqual(calls, ['W1-B']);
  });
});

// ── renderEngineErrors ───────────────────────────────────────────────────────

describe('renderEngineErrors (P9-A)', () => {
  test('renders nothing when nothing is failing', () => {
    setupDom();
    assert.equal(renderEngineErrors(new Map()), null);
    assert.equal(renderEngineErrors(undefined), null);
  });

  test('shows the message and how long it has been going', () => {
    setupDom();
    const node = renderEngineErrors(
      new Map([
        [
          'builder:W1-B',
          {
            taskId: 'W1-B',
            role: 'builder',
            message: 'no model bound for this attempt',
            consecutive: 40,
          },
        ],
      ]),
    )!;
    assert.equal(node.getAttribute('role'), 'alert');
    assert.match(node.textContent!, /no model bound for this attempt/);
    assert.match(node.textContent!, /W1-B/);
    assert.match(node.textContent!, /40 ticks in a row/);
  });

  test('one block per piece of work, not one per tick', () => {
    setupDom();
    const node = renderEngineErrors(
      new Map([
        ['builder:W1-B', { taskId: 'W1-B', role: 'builder', message: 'x', consecutive: 9 }],
      ]),
    )!;
    assert.equal(node.querySelectorAll('.ov2-errors__item').length, 1);
  });
});

// ── renderRunLedger ──────────────────────────────────────────────────────────

describe('renderRunLedger (P9-G)', () => {
  test('is absent while the run is still going', () => {
    setupDom();
    assert.equal(renderRunLedger(board()), null);
  });

  test('reports per-task outcomes, retries and why', () => {
    setupDom();
    const state = board([
      { v: 1, seq: 8, type: 'task.abandoned', taskId: 'W1-D', reason: 'builder-failed-twice' },
      { v: 1, seq: 9, type: 'task.skipped', taskId: 'W1-C', blockedBy: 'W1-D' },
      { v: 1, seq: 10, type: 'final.test.ended', outcome: 'pass', runInstructions: 'npm test' },
      { v: 1, seq: 11, type: 'run.finished', summary: '1 merged, 1 abandoned, 1 skipped' },
    ]);
    const node = renderRunLedger(state)!;
    const text = node.textContent!;
    assert.match(text, /1 merged, 1 abandoned, 1 skipped/);
    assert.match(text, /builder-failed-twice/);
    assert.match(text, /stranded by W1-D/);
    assert.match(text, /npm test/);
    assert.match(text, /abc123/, 'the integration sha is part of the report');
    assert.equal(node.querySelectorAll('.ov2-report__task').length, 4);
    // Nothing was retried, so the ledger totals zero and no row claims one.
    assert.match(text, /Retries0/);
    assert.equal(node.querySelectorAll('.ov2-report__task-retries').length, 0);
  });

  test('names a hand abandonment as one', () => {
    setupDom();
    const state = board([
      { v: 1, seq: 8, type: 'task.abandoned', taskId: 'W1-D', reason: 'user' },
      { v: 1, seq: 9, type: 'run.finished', summary: 'done' },
    ]);
    assert.match(renderRunLedger(state)!.textContent!, /abandoned by hand/);
  });
});

// ── renderTaskDetail ─────────────────────────────────────────────────────────

describe('renderTaskDetail', () => {
  /** A task with a spec but no attempts, for the "never run" reading. */
  function unrunBoard(): BoardState {
    return derive([
      {
        v: 1,
        seq: 1,
        type: 'board.created',
        boardId: 'b1',
        planPath: 'documentation/plans/x.md',
        name: 'Example',
        waves: [{ n: 1, name: 'Foundations' }],
        tasks: [
          {
            id: 'W1-A',
            title: 'A',
            wave: 1,
            dependsOn: [],
            touches: ['a.ts'],
            build: 'Create package.json',
            test: 'npm test',
          },
        ],
      },
    ]);
  }

  test('opens as a modal overlay with the facts strip above the scroll body', () => {
    setupDom();
    const state = unrunBoard();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    assert.equal(node.className, 'ov2-detail-overlay');
    const dialog = node.querySelector('.ov2-detail')!;
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.ok(node.querySelector('.ov2-facts'), 'status facts live in the pinned head');
    assert.ok(node.querySelector('.ov2-detail__rail'));
    assert.ok(node.querySelector('.ov2-thread'), 'the thread gets its own pane');
    // The head is not part of either scrolling pane, so the title stays put.
    assert.equal(node.querySelector('.ov2-detail__panes .ov2-detail__title'), null);
  });

  test('leads with the run and keeps the spec last', () => {
    setupDom();
    const state = unrunBoard();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    const railText = node.querySelector('.ov2-detail__rail')!.textContent!;
    const filesAt = railText.indexOf('Files');
    const workAt = railText.indexOf('Work');
    const specAt = railText.indexOf('Spec');
    assert.ok(filesAt >= 0 && workAt > filesAt, 'Files precede Work');
    assert.ok(specAt > workAt, 'the spec is last, not the first screen');
  });

  test('opens the spec for a task that has not run, and folds it once it has', () => {
    setupDom();
    const unrun = unrunBoard();
    const fresh = renderTaskDetail(unrun, unrun.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    assert.equal(fresh.querySelector<HTMLDetailsElement>('.ov2-spec')!.open, true);

    setupDom();
    const ran = board();
    const after = renderTaskDetail(ran, ran.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    const spec = after.querySelector<HTMLDetailsElement>('.ov2-spec');
    if (spec) assert.equal(spec.open, false, 'a task with attempts folds its spec away');
  });

  test('Close and scrim both dismiss via select(null)', () => {
    setupDom();
    const state = board();
    const calls: Array<string | null> = [];
    const actions: BoardActions = {
      ...NO_ACTIONS,
      select: (id) => calls.push(id),
    };
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, actions, OPTIONS);
    node.querySelector<HTMLButtonElement>('[data-focus-key="detail-close"]')!.click();
    assert.deepEqual(calls, [null]);
    calls.length = 0;
    node.click();
    assert.deepEqual(calls, [null]);
  });

  test('an agent row opens its thread, and engine steps have none to open', () => {
    setupDom();
    const state = board();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    const opens = [...node.querySelectorAll('.ov2-work__header')]
      .map((row) => (row as HTMLElement).dataset.focusKey)
      .filter(Boolean);
    // W1-A ran one builder (a1) and has one merge attempt the fold synthesised.
    assert.deepEqual(opens, ['transcript:a1']);
    // The merge is in the list, visibly not an agent, and not clickable.
    assert.equal(node.querySelectorAll('.ov2-work__header--static').length, 1);
    assert.equal(node.querySelectorAll('.ov2-work__item--engine').length, 1);
  });

  test('Work counts agents, not engine steps', () => {
    setupDom();
    const state = board();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    const panels = [...node.querySelectorAll('.ov2-panel')];
    const work = panels.find((p) => p.querySelector('.ov2-panel__title')?.textContent === 'Work')!;
    assert.ok(work, 'the section is called Work');
    // Two rows — builder and merge — but only the builder is an agent.
    assert.equal(work.querySelectorAll('.ov2-work__item').length, 2);
    assert.equal(work.querySelector('.ov2-panel__count')!.textContent, '1 agent');
  });

  test('Work list leads with a scent and hides the rest of a long write-up', () => {
    setupDom();
    const state = board();
    const task = state.tasks.get('W1-A')!;
    const builder = task.attempts.find((attempt) => attempt.role === 'builder');
    assert.ok(builder);
    builder.summary =
      'W3-B complete. Build: created live-events then wrote a long paragraph UNIQUE_WORK_TOKEN about middleware.';
    builder.evidence = { blockers: ['psql refused'], files: ['a.ts'] };
    const node = renderTaskDetail(state, task, NO_ACTIONS, OPTIONS);
    const work = [...node.querySelectorAll('.ov2-panel')].find(
      (panel) => panel.querySelector('.ov2-panel__title')?.textContent === 'Work',
    )!;
    assert.match(work.textContent!, /W3-B complete\./);
    assert.match(work.textContent!, /psql refused/);
    assert.match(work.textContent!, /1 file/);
    assert.doesNotMatch(work.textContent!, /UNIQUE_WORK_TOKEN/);
    const writeUp = work.querySelector<HTMLDetailsElement>('.ov2-attempt-writeup__full')!;
    writeUp.open = true;
    writeUp.dispatchEvent(new window.Event('toggle'));
    assert.match(work.textContent!, /UNIQUE_WORK_TOKEN/);
  });

  test('falls back to the declared footprint before a task has merged', () => {
    setupDom();
    const state = unrunBoard();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    assert.ok(node.querySelector('.ov2-files--planned'));
    assert.match(node.textContent!, /a\.ts/);
    assert.match(node.textContent!, /Line counts arrive when the task merges/);
    // No invented zeroes: an unmerged task has no diffstat to show.
    assert.equal(node.querySelector('.ov2-stat--add'), null);
  });

  test('shows real line counts once git has answered', () => {
    setupDom();
    const state = board();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, {
      ...OPTIONS,
      files: {
        taskId: 'W1-A',
        status: 'ready' as const,
        source: 'merged' as const,
        files: [{ path: 'src/a.ts', additions: 12, deletions: 3, binary: false }],
        additions: 12,
        deletions: 3,
        truncated: false,
        diffs: new Map(),
        expanded: new Set<string>(),
      },
    });
    assert.match(node.querySelector('.ov2-panel__meta')!.textContent!, /1 file/);
    assert.equal(node.querySelector('.ov2-stat--add')!.textContent, '+12');
    // Directory and filename are separate so the filename never gets truncated.
    assert.equal(node.querySelector('.ov2-file__dir')!.textContent, 'src/');
    assert.equal(node.querySelector('.ov2-file__name')!.textContent, 'a.ts');
  });

  test('a file row asks for its own diff rather than loading every patch', () => {
    setupDom();
    const state = board();
    const asked: string[] = [];
    const node = renderTaskDetail(
      state,
      state.tasks.get('W1-A')!,
      { ...NO_ACTIONS, toggleFileDiff: (path) => asked.push(path) },
      {
        ...OPTIONS,
        files: {
          taskId: 'W1-A',
          status: 'ready' as const,
          source: 'merged' as const,
          files: [{ path: 'src/a.ts', additions: 1, deletions: 0, binary: false }],
          additions: 1,
          deletions: 0,
          truncated: false,
          diffs: new Map(),
          expanded: new Set<string>(),
        },
      },
    );
    node.querySelector<HTMLButtonElement>('[data-focus-key="file-toggle:src/a.ts"]')!.click();
    assert.deepEqual(asked, ['src/a.ts']);
  });

  test('renders a loading thread as a skeleton, not as a word', () => {
    setupDom();
    const state = board();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, {
      ...OPTIONS,
      transcript: {
        attemptId: 'a1',
        status: 'loading' as const,
        events: [],
        truncated: false,
        capped: false,
      },
    });
    assert.ok(node.querySelector('.ov2-skeleton--log'));
    assert.equal(node.querySelector('.tool-call-msg'), null);
  });

  test('a tool call renders as a chat tool card, and says when it was capped', () => {
    setupDom();
    const state = board();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, {
      ...OPTIONS,
      transcript: {
        attemptId: 'a1',
        status: 'ready' as const,
        events: [
          { type: 'tool_call', id: 't1', name: 'read_file', arguments: '{"path":"a.ts"}' },
          { type: 'tool_result', id: 't1', name: 'read_file', content: 'ok' },
          { type: 'round_end', index: 1, toolCallCount: 1, text: '' },
        ],
        truncated: false,
        capped: true,
      },
    });
    // The same card chat uses, not a log row with a label gutter.
    const card = node.querySelector('.tool-call-msg')!;
    assert.ok(card, 'the tool call is a chat tool card');
    assert.equal((card as HTMLElement).dataset.toolName, 'read_file');
    assert.match(node.textContent!, /ran longer than the transcript keeps/);
  });

  test('reasoning goes to the thoughts panel, uncapped, and the outcome is stated', () => {
    setupDom();
    const state = board();
    const thought =
      'Let me start by exploring the working directory. '.repeat(12);
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, {
      ...OPTIONS,
      transcript: {
        attemptId: 'a1',
        status: 'ready' as const,
        events: [
          { type: 'thinking', text: thought },
          { type: 'tool_call', id: 't1', name: 'read_file' },
          { type: 'tool_result', id: 't1', name: 'read_file', content: 'ok' },
          { type: 'round_end', index: 1, toolCallCount: 1, text: 'Created the file.' },
          { type: 'attempt_end', name: 'pass', summary: 'Created the file.' },
        ],
        truncated: false,
        capped: false,
      },
    });
    const thoughts = node.querySelector('.thoughts-panel-wrap')!;
    assert.ok(thoughts, 'reasoning is a thoughts panel, not a clamped log row');
    // The whole thought is present: nothing is cut at a character count.
    assert.ok(thoughts.textContent!.includes(thought.trim().slice(-40)));
    // The assistant's prose for the round reads as a message.
    assert.match(node.querySelector('.transcript-view__assistant')!.textContent!, /Created the file/);
    assert.match(node.querySelector('.ov2-thread__end')!.textContent!, /pass/);
  });

  test('an empty thread says so rather than showing nothing', () => {
    setupDom();
    const state = board();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, {
      ...OPTIONS,
      transcript: {
        attemptId: 'a1',
        status: 'ready' as const,
        events: [],
        truncated: false,
        capped: false,
      },
    });
    assert.match(node.textContent!, /Nothing was recorded/);
  });

  test('with no attempt picked, the thread pane invites one instead of sitting blank', () => {
    setupDom();
    const state = board();
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    assert.match(node.querySelector('.ov2-thread__blank')!.textContent!, /Pick a Builder or Tester/);
  });

  test('says outright that a skipped task did not fail, above everything else', () => {
    setupDom();
    const state = board([
      { v: 1, seq: 8, type: 'task.abandoned', taskId: 'W1-B', reason: 'builder-failed-twice' },
      { v: 1, seq: 9, type: 'task.skipped', taskId: 'W1-C', blockedBy: 'W1-B' },
    ]);
    const node = renderTaskDetail(state, state.tasks.get('W1-C')!, NO_ACTIONS, OPTIONS);
    const alert = node.querySelector('.ov2-alert--warn')!;
    assert.match(alert.textContent!, /did not fail itself/);
    // Alerts come before every section, because they are why the card was opened.
    const rail = node.querySelector('.ov2-detail__rail')!;
    assert.ok(rail.firstElementChild!.classList.contains('ov2-alert'));
  });

  test('footprint noise never becomes an alert', () => {
    setupDom();
    const state = board([
      {
        v: 1,
        seq: 8,
        type: 'touches.overflow',
        taskId: 'W1-A',
        attemptId: 'a1',
        declared: ['a.ts'],
        actual: ['package-lock.json'],
      },
      {
        v: 1,
        seq: 9,
        type: 'touches.overflow',
        taskId: 'W1-A',
        attemptId: 'a1',
        declared: ['a.ts'],
        actual: ['package-lock.json'],
      },
    ]);
    const node = renderTaskDetail(state, state.tasks.get('W1-A')!, NO_ACTIONS, OPTIONS);
    // It stays on the journal. It does not open the panel three times over.
    assert.equal(node.querySelectorAll('.ov2-alert').length, 0);
    assert.doesNotMatch(node.textContent!, /Wrote outside its footprint/);
  });
});

// ── loading states ───────────────────────────────────────────────────────────

describe('loading states (P9-I)', () => {
  test('the board skeleton announces itself without animating', () => {
    setupDom();
    const node = renderBoardSkeleton();
    assert.equal(node.querySelector('[role="status"]')!.textContent, 'Loading the board');
    // The skeleton itself is decoration and must not be read out line by line.
    assert.equal(node.querySelector('.ov2-skeleton')!.getAttribute('aria-hidden'), 'true');
    assert.ok(node.querySelectorAll('.ov2-skeleton__line').length > 0);
  });
});

// ── renderBoardHeader ────────────────────────────────────────────────────────

describe('renderBoardHeader', () => {
  test('uses the orchestrator instrument strip, not a boxed control card', () => {
    setupDom();
    const node = renderBoardHeader(board(), true);
    assert.equal(node.className, 'board-header ob-runhead');
    assert.equal(node.querySelector('.ov2-controls'), null);
    assert.equal(node.querySelector('.ov2-board__header'), null);
    assert.equal(node.querySelector('.board-header__title')?.textContent, 'Example');
    assert.equal(
      node.querySelector('.board-header__badge-label')?.textContent,
      'Running',
    );
    assert.ok(node.querySelector('.board-header__badge--running'));
    assert.equal(
      node.querySelector('[data-board-metric="tasks"] .board-header__metric-value')
        ?.textContent,
      '1/4',
    );
    assert.ok(node.querySelector('.board-header__progress-fill'));
    assert.ok(node.querySelector('.board-header__controls'));
  });

  test('a created board is Ready', () => {
    setupDom();
    const state = derive([
      {
        v: 1,
        seq: 1,
        type: 'board.created',
        boardId: 'b1',
        planPath: 'documentation/plans/x.md',
        name: 'Example',
        waves: [{ n: 1, name: 'Foundations' }],
        tasks: [{ id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] }],
      },
    ]);
    const node = renderBoardHeader(state, true);
    assert.equal(node.querySelector('.board-header__badge-label')?.textContent, 'Ready');
    assert.ok(node.querySelector('.board-header__badge--ready'));
  });

  test('a dropped stream on a running board is Reconnecting, not Stopped', () => {
    setupDom();
    const node = renderBoardHeader(board(), false);
    assert.equal(
      node.querySelector('.board-header__badge-label')?.textContent,
      'Reconnecting',
    );
    assert.ok(node.querySelector('.board-header__badge--stalled'));
  });

  test('passed-in run controls sit in the toolbar, not under a second card', () => {
    setupDom();
    const controls = document.createElement('div');
    controls.className = 'board-header__controls';
    const start = document.createElement('button');
    start.className = 'board-header__run-btn';
    start.textContent = 'Start';
    controls.appendChild(start);
    const node = renderBoardHeader(board(), true, controls);
    assert.equal(node.querySelector('.board-header__toolbar .board-header__run-btn'), start);
    assert.equal(node.querySelectorAll('.board-header__controls').length, 1);
  });

  test('a failed board renders Failed, not Complete', () => {
    setupDom();
    const state = derive([
      {
        v: 1,
        seq: 1,
        type: 'board.created',
        boardId: 'b1',
        planPath: 'p.md',
        name: 'Example',
        waves: [{ n: 1, name: 'One' }],
        tasks: [{ id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] }],
      },
      { v: 1, seq: 2, type: 'task.abandoned', taskId: 'W1-A', reason: 'builder-failed-twice' },
      { v: 1, seq: 3, type: 'final.test.ended', outcome: 'fail', runInstructions: 'command: tsc\ncwd: /tmp' },
      { v: 1, seq: 4, type: 'run.finished', summary: 'failed' },
      { v: 1, seq: 5, type: 'board.stopped', reason: 'terminal' },
    ]);
    const node = renderBoardHeader(state, true);
    assert.equal(node.querySelector('.board-header__badge-label')?.textContent, 'Failed');
    assert.ok(node.querySelector('.board-header__badge--failed'));
  });
});
