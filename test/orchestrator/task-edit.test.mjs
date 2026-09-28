/** Board task editing: the pure rules, the fold, the seed, and the route. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { stateFromJSON } from '../../server/orchestrator/core/snapshot.js';
import {
  diffTaskChanges,
  normaliseTaskChanges,
  taskEditBlocker,
} from '../../server/orchestrator/core/task-edit.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { resetJournalCache } from '../../server/orchestrator/journal.js';
import { createBoardsMiddleware, setEffectorFactory } from '../../server/orchestrator/middleware.js';
import { buildSeed } from '../../server/orchestrator/seeds.js';

function journal(...events) {
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 1_700_000_000_000 + i }));
}

const TASKS = [
  { id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['src/a/**'], build: 'b', test: 't', accept: 'x' },
  { id: 'W2-B', title: 'B', wave: 2, dependsOn: ['W1-A'], touches: [], build: 'b', test: 't', accept: 'x' },
];

const created = () =>
  makeEvent('board.created', {
    boardId: 'b1',
    planPath: 'plan.md',
    name: 'demo',
    tasks: TASKS,
    waves: [{ n: 1, name: 'One' }, { n: 2, name: 'Two' }],
  });

// ── Rules ────────────────────────────────────────────────────────────────────

describe('task edit — normaliseTaskChanges', () => {
  it('trims text, clears blanks, dedupes touches', () => {
    const result = normaliseTaskChanges({
      title: '  New   title ',
      build: '  do it  ',
      test: '   ',
      accept: null,
      touches: ['src/x/**', ' src/x/** ', '', 'src/y.ts'],
    });
    assert.deepEqual(result, {
      ok: true,
      changes: {
        title: 'New title',
        build: 'do it',
        test: null,
        accept: null,
        touches: ['src/x/**', 'src/y.ts'],
      },
    });
  });

  it('refuses graph fields, bad types, and empty bodies', () => {
    assert.match(normaliseTaskChanges({ dependsOn: [] }).error, /dependsOn cannot be edited/);
    assert.match(normaliseTaskChanges({ wave: 2 }).error, /wave cannot be edited/);
    assert.match(normaliseTaskChanges({ title: '  ' }).error, /title/);
    assert.match(normaliseTaskChanges({ build: 3 }).error, /build/);
    assert.match(normaliseTaskChanges({ touches: 'src/**' }).error, /touches/);
    assert.match(normaliseTaskChanges({}).error, /nothing to change/);
    assert.match(normaliseTaskChanges(null).error, /object/);
  });
});

describe('task edit — taskEditBlocker', () => {
  it('allows idle, failed and abandoned cards', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('task.attempt.started', { taskId: 'W1-A', attemptId: 'a1', role: 'builder' }),
        makeEvent('task.attempt.ended', { taskId: 'W1-A', attemptId: 'a1', role: 'builder', outcome: 'fail' }),
        makeEvent('task.abandoned', { taskId: 'W1-A', reason: 'user' }),
      ),
    );
    assert.equal(taskEditBlocker(state, 'W1-A'), null);
    assert.equal(taskEditBlocker(state, 'W2-B'), null);
  });

  it('refuses running, queued, merged and unknown cards', () => {
    const running = derive(
      journal(created(), makeEvent('task.attempt.started', { taskId: 'W1-A', attemptId: 'a1', role: 'builder' })),
    );
    assert.match(taskEditBlocker(running, 'W1-A'), /running/);

    const queued = derive(journal(created(), makeEvent('merge.enqueued', { taskId: 'W1-A' })));
    assert.match(taskEditBlocker(queued, 'W1-A'), /merge/);

    const merged = derive(
      journal(
        created(),
        makeEvent('merge.enqueued', { taskId: 'W1-A' }),
        makeEvent('merge.succeeded', { taskId: 'W1-A', sha: 'abc' }),
      ),
    );
    assert.match(taskEditBlocker(merged, 'W1-A'), /Rewind/);
    assert.equal(taskEditBlocker(merged, 'NOPE'), 'no such task');
  });
});

describe('task edit — diffTaskChanges', () => {
  it('keeps only fields that moved, and carries touches expansion with touches', () => {
    const task = derive(journal(created())).tasks.get('W1-A');
    assert.deepEqual(diffTaskChanges(task, { title: 'A', build: 'b', touches: ['src/a/**'] }), {});
    assert.deepEqual(
      diffTaskChanges(task, {
        build: 'new',
        touches: ['src/z/**'],
        touchesExpanded: ['src/z/1.ts'],
        emptyTouchesGlobs: [],
      }),
      { build: 'new', touches: ['src/z/**'], touchesExpanded: ['src/z/1.ts'], emptyTouchesGlobs: [] },
    );
  });
});

// ── Fold and seed ────────────────────────────────────────────────────────────

describe('task edit — derive', () => {
  it('task.updated replaces spec fields, keeps runtime, and counts edits', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('task.attempt.started', { taskId: 'W1-A', attemptId: 'a1', role: 'builder' }),
        makeEvent('task.attempt.ended', { taskId: 'W1-A', attemptId: 'a1', role: 'builder', outcome: 'fail' }),
        makeEvent('task.updated', {
          taskId: 'W1-A',
          changes: { title: 'A2', build: 'rebuilt', accept: null, touches: ['src/n/**'], touchesExpanded: ['src/n/b.ts', 'src/n/a.ts'], emptyTouchesGlobs: [] },
        }),
        makeEvent('task.updated', { taskId: 'W1-A', changes: { test: 'retested' } }),
        makeEvent('task.updated', { taskId: 'NOPE', changes: { test: 'ignored' } }),
      ),
    );
    const task = state.tasks.get('W1-A');
    assert.equal(task.title, 'A2');
    assert.equal(task.buildSpec, 'rebuilt');
    assert.equal(task.testSpec, 'retested');
    assert.equal(task.accept, null);
    assert.deepEqual(task.touches, ['src/n/**']);
    assert.deepEqual(task.touchesExpanded, ['src/n/a.ts', 'src/n/b.ts']);
    assert.equal(task.edits, 2);
    assert.equal(task.attempts.length, 1, 'history stays');
    assert.equal(task.dependsOn.length, 0);
    assert.equal(state.tasks.get('W2-B').edits, 0);
  });

  it('seeds say the board spec beats the plan file only once a card is edited', () => {
    const plain = derive(journal(created()));
    assert.doesNotMatch(buildSeed('initial', { state: plain, taskId: 'W1-A' }), /edited on the board/);

    const edited = derive(
      journal(created(), makeEvent('task.updated', { taskId: 'W1-A', changes: { build: 'rebuilt' } })),
    );
    const seed = buildSeed('initial', { state: edited, taskId: 'W1-A' });
    assert.match(seed, /edited on the board/);
    assert.match(seed, /## Build\nrebuilt/);
  });
});

// ── Route ────────────────────────────────────────────────────────────────────

const PLAN = `---
name: edit-board
overview: A demo.
todos:
  - id: W1-A
    content: "Wave 1: A"
    status: pending
  - id: W1-B
    content: "Wave 1: B"
    status: pending
isProject: true
---

# Demo

## Wave Breakdown

### Wave 1 — One

#### Task W1-A: Alpha
- **Build:** build alpha
- **Test:** test alpha
- **Accept:** alpha works
- **Touches:** src/alpha/**

#### Task W1-B: Beta
- **Build:** build beta
- **Test:** test beta
- **Accept:** beta works
- **Touches:** src/beta/**
`;

describe('task edit — POST /api/boards/:id/tasks/:taskId/edit', { concurrency: 1 }, () => {
  /** @type {http.Server} */
  let server;
  /** @type {string} */
  let base;
  /** @type {string | undefined} */
  let previousHome;

  before(() => {
    previousHome = process.env.MINNOW_HOME;
  });

  beforeEach(async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-task-edit-'));
    process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    resetJournalCache();
    disposeEngines();
    setEffectorFactory(() =>
      createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }] }),
    );
    const middleware = createBoardsMiddleware();
    server = http.createServer((req, res) => {
      void middleware(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    disposeEngines();
    await new Promise((resolve) => server.close(resolve));
  });

  after(() => {
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    resetJournalCache();
    disposeEngines();
  });

  async function call(method, pathname, body) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function createBoard() {
    const created = await call('POST', '/api/boards', { planPath: 'edit.md', markdown: PLAN });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.boardId;
  }

  it('edits an idle card and journals only what changed', async () => {
    const boardId = await createBoard();
    const edited = await call('POST', `/api/boards/${boardId}/tasks/W1-A/edit`, {
      title: 'Alpha',
      build: 'build alpha, but better',
      accept: 'alpha works',
      touches: ['src/alpha/**', 'src/shared.ts'],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.changed, ['build', 'touches']);

    const task = stateFromJSON(edited.body.state).tasks.get('W1-A');
    assert.equal(task.buildSpec, 'build alpha, but better');
    assert.equal(task.edits, 1);
    assert.deepEqual(task.touches, ['src/alpha/**', 'src/shared.ts']);

    const events = (await call('GET', `/api/boards/${boardId}/journal`)).body.events;
    const updates = events.filter((e) => e.type === 'task.updated');
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(updates[0].changes).sort(), [
      'build',
      'emptyTouchesGlobs',
      'touches',
      'touchesExpanded',
    ]);

    const noop = await call('POST', `/api/boards/${boardId}/tasks/W1-A/edit`, { title: 'Alpha' });
    assert.equal(noop.status, 200);
    assert.deepEqual(noop.body.changed, []);
  });

  it('answers 400 for a bad body, 404 for an unknown card, 409 for a running one', async () => {
    const boardId = await createBoard();
    const bad = await call('POST', `/api/boards/${boardId}/tasks/W1-A/edit`, { dependsOn: ['W1-B'] });
    assert.equal(bad.status, 400);

    const missing = await call('POST', `/api/boards/${boardId}/tasks/NOPE/edit`, { build: 'x' });
    assert.equal(missing.status, 404);

    const noBoard = await call('POST', '/api/boards/nope/tasks/W1-A/edit', { build: 'x' });
    assert.equal(noBoard.status, 404);

    const started = await call('POST', `/api/boards/${boardId}/tasks/W1-A/start`);
    assert.equal(started.status, 200);
    const running = await call('POST', `/api/boards/${boardId}/tasks/W1-A/edit`, { build: 'x' });
    assert.equal(running.status, 409);
    assert.match(running.body.error, /running/);
    assert.equal(stateFromJSON(running.body.state).tasks.get('W1-A').buildSpec, 'build alpha');

    // Abandoned is editable again; this also ends the scripted attempt's timer.
    assert.equal((await call('POST', `/api/boards/${boardId}/tasks/W1-A/abandon`)).status, 200);
    const after = await call('POST', `/api/boards/${boardId}/tasks/W1-A/edit`, { build: 'x' });
    assert.equal(after.status, 200, JSON.stringify(after.body));
  });
});
