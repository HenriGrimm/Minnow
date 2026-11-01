import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { derive, emptyState } from '../../server/orchestrator/core/derive.js';
import { recoveryHold } from '../../server/orchestrator/core/recovery.js';
import { collectBoardAttention, createBoardAttentionInbox } from '../../src/orchestrator/board-attention';

let win: Window;
let inbox: ReturnType<typeof createBoardAttentionInbox>;
const actions = { resetTask() {}, fixFinal() {}, async checkRecovery() {} };

function setup() {
  win = new Window();
  installHappyDomGlobals(win);
  inbox = createBoardAttentionInbox();
  document.body.appendChild(inbox.element);
}

afterEach(() => { inbox?.dispose(); win?.close(); });

function failedBoard() {
  return derive([
    { v: 1, seq: 1, type: 'board.created', boardId: 'inbox', name: 'Recovery', planPath: 'documentation/plans/x.md', waves: [], tasks: [
      { id: 'A', title: 'Controls', wave: 1, dependsOn: [], touches: [] },
      { id: 'B', title: 'Tests', wave: 1, dependsOn: ['A'], touches: [] },
    ] },
    { v: 1, seq: 2, type: 'task.abandoned', taskId: 'A', reason: 'builder-failed-twice' },
    { v: 1, seq: 3, type: 'task.skipped', taskId: 'B', blockedBy: 'A' },
    { v: 1, seq: 4, type: 'final.test.ended', outcome: 'fail', runInstructions: 'npm test', evidence: { output: '<script>failure</script>\nlast line' } },
  ]);
}

test('badge counts notices, details are lazy, and task/final actions retain their targets', () => {
  setup();
  const state = failedBoard();
  const resets: string[] = [];
  let fixes = 0;
  inbox.update(collectBoardAttention(state, { ...actions, resetTask: id => resets.push(id), fixFinal: () => fixes++ }));
  assert.equal(inbox.element.hidden, false);
  assert.match(inbox.element.getAttribute('aria-label')!, /3 notices/);
  assert.equal(document.querySelector('.ov2-inbox-popover'), null);
  assert.equal(document.querySelector('.ov2-attention__row'), null);
  inbox.element.click();
  const popover = document.querySelector('.ov2-inbox-popover')!;
  assert.equal(popover.getAttribute('role'), 'dialog');
  assert.ok(popover.classList.contains('mn-occludes-preview'));
  assert.equal(inbox.element.getAttribute('aria-expanded'), 'true');
  assert.equal(popover.querySelectorAll('.ov2-inbox__item').length, 3);
  assert.equal(popover.querySelector('script'), null);
  assert.match(popover.textContent!, /<script>failure<\/script>/);
  assert.equal(popover.querySelector<HTMLDetailsElement>('.ov2-integration-output')!.open, false);
  popover.querySelector<HTMLButtonElement>('.ov2-attention__action')!.click();
  assert.equal(fixes, 1);
  popover.querySelector<HTMLButtonElement>('[data-notice-id="task:A"]')!.click();
  assert.match(popover.textContent!, /The builder failed twice/);
  popover.querySelector<HTMLButtonElement>('.ov2-attention__action')!.click();
  assert.deepEqual(resets, ['A']);
  popover.querySelector<HTMLButtonElement>('[data-notice-id="task:B"]')!.click();
  assert.match(popover.textContent!, /Waiting on A/);
});

test('live updates preserve an open log and selection, and resolving notices closes the inbox', () => {
  setup();
  const state = failedBoard();
  inbox.update(collectBoardAttention(state, actions));
  inbox.element.click();
  const log = document.querySelector<HTMLDetailsElement>('.ov2-integration-output')!;
  log.open = true;
  inbox.update(collectBoardAttention(state, actions));
  assert.equal(document.querySelector('.ov2-integration-output'), log);
  state.finalTest!.evidence!.output = 'New failure output';
  inbox.update(collectBoardAttention(state, actions));
  assert.equal(document.querySelector<HTMLDetailsElement>('.ov2-integration-output')!.open, true);
  assert.match(document.querySelector('.ov2-inbox__detail')!.textContent!, /New failure output/);
  document.querySelector<HTMLButtonElement>('[data-notice-id="task:B"]')!.click();
  inbox.update(collectBoardAttention(state, actions));
  assert.equal(document.activeElement?.getAttribute('data-notice-id'), 'task:B');
  state.tasks.get('B')!.waived = true;
  inbox.update(collectBoardAttention(state, actions));
  assert.ok(document.activeElement?.isConnected);
  assert.equal(document.querySelector('[data-notice-id="task:B"]'), null);
  inbox.update([]);
  assert.equal(inbox.element.hidden, true);
  assert.equal(document.querySelector('.ov2-inbox-popover'), null);
  assert.equal(inbox.element.getAttribute('aria-expanded'), 'false');
});

test('Escape restores focus; outside click, toggle and dispose dismiss the overlay', () => {
  setup();
  inbox.update(collectBoardAttention(failedBoard(), actions));
  inbox.element.click();
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.ov2-inbox-popover'), null);
  assert.equal(document.activeElement, inbox.element);
  inbox.element.click();
  document.body.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(document.querySelector('.ov2-inbox-popover'), null);
  inbox.element.click();
  inbox.element.click();
  assert.equal(document.querySelector('.ov2-inbox-popover'), null);
  inbox.element.click();
  inbox.dispose();
  assert.equal(document.querySelector('.ov2-inbox-popover'), null);
});

test('recovery waits, deduplicated engine errors and action notices share the inbox', async () => {
  setup();
  const state = emptyState();
  state.status = 'running';
  const hold = recoveryHold(state, { taskId: 'A', role: 'builder', now: 1000, failure: { category: 'prerequisite', scope: 'task', message: 'Device unavailable', fingerprint: 'device' } });
  state.recoveryHolds[hold.key] = hold;
  const errors = new Map([
    ['builder:A', { taskId: 'A', role: 'builder', message: 'Device unavailable', consecutive: 2 }],
    ['tester:B', { taskId: 'B', role: 'tester', message: 'Executable missing', consecutive: 3 }],
  ]);
  let checks = 0;
  let reject!: (error: Error) => void;
  const callbacks = { ...actions, checkRecovery: async () => { checks++; await new Promise<void>((_, no) => { reject = no; }); } };
  const items = collectBoardAttention(state, callbacks, errors, { tone: 'warn', text: '<script>Action failed</script>' });
  assert.equal(items.length, 3);
  inbox.update(items);
  inbox.element.click();
  const check = document.querySelector<HTMLButtonElement>('.ov2-recovery button')!;
  check.click(); check.click();
  inbox.update(collectBoardAttention(state, callbacks, errors));
  assert.equal(document.querySelector('.ov2-recovery button'), check);
  assert.equal(check.disabled, true);
  assert.equal(checks, 1);
  reject(new Error('Still unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(check.disabled, false);
  assert.match(document.querySelector('.ov2-recovery')!.textContent!, /Still unavailable/);
  document.querySelector<HTMLButtonElement>('[data-notice-id="engine:tester:B"]')!.click();
  assert.match(document.querySelector('.ov2-inbox__detail')!.textContent!, /Executable missing/);
  assert.match(document.querySelector('.ov2-inbox__detail')!.textContent!, /3 ticks/);
  const stopped = { ...state, status: 'stopped' as const };
  inbox.update(collectBoardAttention(stopped, actions));
  document.querySelector<HTMLButtonElement>('[data-notice-id]')!.click();
  assert.equal(document.querySelector('.ov2-recovery button'), null);
  assert.match(document.querySelector('.ov2-recovery')!.textContent!, /when you start/);
});
