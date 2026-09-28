/**
 * The task detail's spec editor: an edit is a command (editTask), the draft
 * survives live repaints, and the saved spec comes back from the fold.
 */
// Before the renderer imports: dompurify binds to globalThis.window at eval.
import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { derive } from '../../server/orchestrator/core/derive.js';
import type { BoardState, TaskEditChanges } from '../../server/orchestrator/core/types';
import type { BoardActions } from '../../src/orchestrator/board-render.ts';
import {
  renderTaskDetail,
  resetTaskDetailUi,
  settleSpecEdit,
  syncTaskDetailOverlay,
} from '../../src/orchestrator/task-detail.ts';

let activeWindow: Window | undefined;

function setupDom(): void {
  activeWindow?.close();
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
  resetTaskDetailUi();
}

afterEach(() => {
  if (activeWindow) document.body.innerHTML = '';
  activeWindow?.close();
  activeWindow = undefined;
});

const OPTIONS = { selectedTaskId: 'W1-A', pendingTaskIds: new Set<string>() };

function actionsRecording(edits: Array<[string, TaskEditChanges]>): BoardActions {
  return {
    startTask: () => {},
    abandonTask: () => {},
    skipTask: () => {},
    editTask: (taskId, changes) => edits.push([taskId, changes]),
    resetTask: () => {},
    rewindTask: () => {},
    rerun: () => {},
    select: () => {},
    openTranscript: () => {},
    toggleFileDiff: () => {},
    openFile: () => {},
  };
}

const CREATED = {
  v: 1,
  seq: 1,
  type: 'board.created',
  boardId: 'b1',
  planPath: 'documentation/plans/x.md',
  name: 'Example',
  waves: [{ n: 1, name: 'One' }],
  tasks: [
    {
      id: 'W1-A',
      title: 'Alpha',
      wave: 1,
      dependsOn: [],
      touches: ['src/a/**'],
      build: 'Build alpha',
      test: 'Test alpha',
      accept: 'Alpha works',
    },
  ],
};

function board(extra: Record<string, unknown>[] = []): BoardState {
  return derive([CREATED, ...extra.map((e, i) => ({ v: 1, seq: i + 2, ...e }))]);
}

function mount(state: BoardState, actions: BoardActions): HTMLElement {
  const node = renderTaskDetail(state, state.tasks.get('W1-A')!, actions, OPTIONS);
  document.body.appendChild(node);
  return node;
}

function sync(node: HTMLElement, state: BoardState, actions: BoardActions): void {
  syncTaskDetailOverlay(node, state, state.tasks.get('W1-A')!, actions, OPTIONS, {
    syncWork: true,
    thread: 'auto',
  });
}

function input(node: HTMLElement, key: string): HTMLInputElement | HTMLTextAreaElement {
  const found = node.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-focus-key="spec-edit-${key}"]`,
  );
  assert.ok(found !== null, `missing ${key} field`);
  return found!;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new activeWindow!.Event('input') as unknown as Event);
}

function submit(node: HTMLElement): void {
  const form = node.querySelector('form.ov2-spec-edit');
  assert.ok(form !== null, 'the editor is open');
  form!.dispatchEvent(new activeWindow!.Event('submit', { cancelable: true }) as unknown as Event);
}

describe('task spec editor', () => {
  test('Edit opens a prefilled form and Save sends one editTask command', () => {
    setupDom();
    const edits: Array<[string, TaskEditChanges]> = [];
    const actions = actionsRecording(edits);
    const node = mount(board(), actions);

    const edit = node.querySelector<HTMLButtonElement>('[data-focus-key="spec-edit"]');
    assert.ok(edit !== null, 'an idle card offers Edit');
    edit!.click();

    assert.equal(input(node, 'title').value, 'Alpha');
    assert.equal(input(node, 'build').value, 'Build alpha');
    assert.equal(input(node, 'touches').value, 'src/a/**');

    type(input(node, 'build'), 'Build alpha, properly');
    type(input(node, 'touches'), 'src/a/**\n\n  src/shared.ts  ');
    submit(node);

    assert.equal(edits.length, 1);
    assert.equal(edits[0][0], 'W1-A');
    assert.deepEqual(edits[0][1], {
      title: 'Alpha',
      build: 'Build alpha, properly',
      test: 'Test alpha',
      accept: 'Alpha works',
      touches: ['src/a/**', 'src/shared.ts'],
    });
    const save = node.querySelector<HTMLButtonElement>('.ov2-spec-edit button[type="submit"]');
    assert.equal(save?.disabled, true, 'Save waits for the server');
  });

  test('a live repaint keeps the draft; a refusal shows the reason in the editor', () => {
    setupDom();
    const edits: Array<[string, TaskEditChanges]> = [];
    const actions = actionsRecording(edits);
    const state = board();
    const node = mount(state, actions);
    node.querySelector<HTMLButtonElement>('[data-focus-key="spec-edit"]')!.click();
    type(input(node, 'accept'), 'half typed');

    sync(node, board([{ type: 'board.started', concurrency: 1 }]), actions);
    assert.equal(input(node, 'accept').value, 'half typed', 'the repaint left the draft alone');

    submit(node);
    settleSpecEdit('W1-A', 'this task is running; wait for it or abandon it before editing');
    sync(node, state, actions);
    const error = node.querySelector('.ov2-spec-edit [role="alert"]');
    assert.equal(error?.textContent, 'this task is running; wait for it or abandon it before editing');
    assert.equal(input(node, 'accept').value, 'half typed');
    assert.equal(
      node.querySelector<HTMLButtonElement>('.ov2-spec-edit button[type="submit"]')?.disabled,
      false,
    );
  });

  test('a saved edit closes the editor and the fold shows the new spec as edited', () => {
    setupDom();
    const actions = actionsRecording([]);
    const node = mount(board(), actions);
    node.querySelector<HTMLButtonElement>('[data-focus-key="spec-edit"]')!.click();
    submit(node);

    settleSpecEdit('W1-A', null);
    sync(
      node,
      board([{ type: 'task.updated', taskId: 'W1-A', changes: { title: 'Alpha 2', build: 'New build' } }]),
      actions,
    );
    assert.equal(node.querySelector('form.ov2-spec-edit'), null);
    assert.equal(node.querySelector('.ov2-detail__title')?.textContent, 'Alpha 2');
    assert.ok(node.querySelector('.ov2-spec')?.textContent?.includes('New build'));
    assert.equal(node.querySelector('.ov2-spec__edited')?.textContent, 'edited');
  });

  test('Cancel returns to the read view without a command', () => {
    setupDom();
    const edits: Array<[string, TaskEditChanges]> = [];
    const node = mount(board(), actionsRecording(edits));
    node.querySelector<HTMLButtonElement>('[data-focus-key="spec-edit"]')!.click();
    const cancel = [...node.querySelectorAll<HTMLButtonElement>('.ov2-spec-edit button')].find(
      (b) => b.textContent === 'Cancel',
    );
    cancel!.click();
    assert.equal(node.querySelector('form.ov2-spec-edit'), null);
    assert.ok(node.querySelector('.ov2-spec'));
    assert.equal(edits.length, 0);
  });

  test('a running card offers no Edit', () => {
    setupDom();
    const running = board([
      { type: 'task.attempt.started', taskId: 'W1-A', attemptId: 'a1', role: 'builder' },
    ]);
    const node = mount(running, actionsRecording([]));
    assert.equal(node.querySelector('[data-focus-key="spec-edit"]'), null);
  });
});
