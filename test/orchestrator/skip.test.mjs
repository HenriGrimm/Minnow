/**
 * Hand Skip (`task.waived`): the card settles as skipped, and its dependents
 * treat it as done rather than stranding behind it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import {
  deadEnded,
  derive,
  needsAttention,
  readyTasks,
  satisfiesDependents,
} from '../../server/orchestrator/core/derive.js';
import { isRunComplete, pendingSkips, plan, reopenTargets } from '../../server/orchestrator/core/plan.js';
import { hasRunDebris } from '../../server/orchestrator/core/rewind.js';

function journal(...events) {
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 1_700_000_000_000 + i }));
}

const spec = (id, wave, dependsOn = []) => ({
  id,
  title: id,
  wave,
  dependsOn,
  touches: [`src/${id}/**`],
  build: 'b',
  test: 't',
  accept: 'x',
});

// A <- B <- C, and D on its own.
const TASKS = [spec('A', 1), spec('D', 1), spec('B', 2, ['A']), spec('C', 3, ['B'])];

const created = () =>
  makeEvent('board.created', {
    boardId: 'b1',
    planPath: 'plan.md',
    tasks: TASKS,
    waves: [{ n: 1, name: 'One' }, { n: 2, name: 'Two' }, { n: 3, name: 'Three' }],
  });

describe('task.waived — fold', () => {
  it('settles the card as skipped and frees its dependents', () => {
    const state = derive(journal(created(), makeEvent('task.waived', { taskId: 'A' })));
    const a = state.tasks.get('A');
    assert.equal(a.phase, 'skipped');
    assert.equal(a.waived, true);
    assert.equal(satisfiesDependents(a), true);
    assert.equal(needsAttention(a), false);
    assert.deepEqual(readyTasks(state), ['D', 'B']);
    assert.equal(deadEnded(state).size, 0);
  });

  it('a stranded skip still blocks, unlike a hand skip', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed-twice' }),
        makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
      ),
    );
    assert.equal(satisfiesDependents(state.tasks.get('B')), false);
    assert.equal(needsAttention(state.tasks.get('B')), true);
    assert.equal(deadEnded(state).get('C'), 'A');
  });

  it('skipping an abandoned card releases the cards it stranded', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed-twice' }),
        makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
        makeEvent('task.skipped', { taskId: 'C', blockedBy: 'A' }),
        makeEvent('task.waived', { taskId: 'A' }),
      ),
    );
    assert.equal(state.tasks.get('A').phase, 'skipped');
    assert.equal(state.tasks.get('B').phase, 'idle');
    assert.equal(state.tasks.get('B').skippedBy, null);
    assert.equal(state.tasks.get('C').phase, 'idle');
    assert.deepEqual(pendingSkips(state), []);
    assert.equal(readyTasks(state).includes('B'), true);
  });

  it('keeps a card stranded when another broken dependency still blocks it', () => {
    const tasks = [spec('A', 1), spec('E', 1), spec('B', 2, ['A', 'E'])];
    const state = derive(
      journal(
        makeEvent('board.created', { boardId: 'b1', planPath: 'p.md', tasks, waves: [] }),
        makeEvent('task.abandoned', { taskId: 'A', reason: 'x' }),
        makeEvent('task.abandoned', { taskId: 'E', reason: 'x' }),
        makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
        makeEvent('task.waived', { taskId: 'A' }),
      ),
    );
    assert.equal(state.tasks.get('B').phase, 'skipped');
    assert.equal(state.tasks.get('B').skippedBy, 'A');
  });

  it('reopens a finished board when it frees stranded work', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('task.abandoned', { taskId: 'A', reason: 'x' }),
        makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
        makeEvent('task.skipped', { taskId: 'C', blockedBy: 'A' }),
        makeEvent('merge.succeeded', { taskId: 'D', sha: 'sha-d' }),
        makeEvent('final.test.ended', { outcome: 'pass' }),
        makeEvent('run.finished', { summary: 'done' }),
        makeEvent('board.stopped', { reason: 'complete' }),
        makeEvent('task.waived', { taskId: 'A' }),
      ),
    );
    assert.equal(state.finished, false);
    assert.equal(state.finalTest, null);
  });

  it('never unmerges a merged card', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('merge.succeeded', { taskId: 'A', sha: 'sha-a' }),
        makeEvent('task.waived', { taskId: 'A' }),
      ),
    );
    assert.equal(state.tasks.get('A').phase, 'merged');
    assert.equal(state.tasks.get('A').waived, false);
  });
});

describe('task.waived — scheduler', () => {
  it('schedules the dependent of a skipped card on a running board', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('board.started', { concurrency: 4 }),
        makeEvent('task.waived', { taskId: 'A' }),
      ),
    );
    assert.deepEqual(
      plan(state).map((d) => d.taskId).sort(),
      ['B', 'D'],
    );
  });

  it('counts as settled for run completion', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('board.started', { concurrency: 2 }),
        makeEvent('task.waived', { taskId: 'A' }),
        makeEvent('merge.succeeded', { taskId: 'D', sha: 'sha-d' }),
        makeEvent('merge.succeeded', { taskId: 'B', sha: 'sha-b' }),
        makeEvent('merge.succeeded', { taskId: 'C', sha: 'sha-c' }),
        makeEvent('final.test.ended', { outcome: 'pass' }),
      ),
    );
    assert.equal(isRunComplete(state), true);
  });

  it('a plain rerun leaves hand skips alone; naming one brings it back', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('task.waived', { taskId: 'A' }),
        makeEvent('task.abandoned', { taskId: 'D', reason: 'x' }),
      ),
    );
    assert.deepEqual(reopenTargets(state), ['D']);
    assert.deepEqual(reopenTargets(state, ['A']), ['A']);

    const reopened = derive(
      journal(
        created(),
        makeEvent('task.waived', { taskId: 'A' }),
        makeEvent('board.reopened', { taskIds: ['A'], reason: 'user' }),
      ),
    );
    const a = reopened.tasks.get('A');
    assert.equal(a.waived, false);
    assert.equal(a.phase, 'idle');
    assert.equal(a.reopened?.from, 'skipped by hand');
  });

  it('Reset un-skips the card', () => {
    const events = [created(), makeEvent('task.waived', { taskId: 'A' })];
    const skipped = derive(journal(...events));
    assert.equal(hasRunDebris(skipped, skipped.tasks.get('A')), true);
    const reset = derive(
      journal(...events, makeEvent('task.reset', { taskIds: ['A'], reason: 'user' })),
    );
    assert.equal(reset.tasks.get('A').waived, false);
    assert.equal(reset.tasks.get('A').phase, 'idle');
    assert.equal(readyTasks(reset).includes('B'), false);
  });
});
