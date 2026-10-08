/** Plan re-sync: the three-way merge, the fold, and the route. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { planBaseSpecs, planResync, resyncHasWork } from '../../server/orchestrator/core/plan-resync.js';
import { stateFromJSON } from '../../server/orchestrator/core/snapshot.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { resetJournalCache } from '../../server/orchestrator/journal.js';
import { createBoardsMiddleware, setEffectorFactory } from '../../server/orchestrator/middleware.js';
import { getDefaultWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';

function journal(...events) {
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 1_700_000_000_000 + i }));
}

const TASKS = [
  { id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['src/a/**'], build: 'build a', test: 'test a', accept: 'a ok' },
  { id: 'W1-B', title: 'B', wave: 1, dependsOn: [], touches: ['src/b/**'], build: 'build b', test: 'test b', accept: 'b ok' },
  { id: 'W2-C', title: 'C', wave: 2, dependsOn: ['W1-A'], touches: ['src/c/**'], build: 'build c', test: 'test c', accept: 'c ok' },
];
const WAVES = [{ n: 1, name: 'One' }, { n: 2, name: 'Two' }];

const created = () =>
  makeEvent('board.created', { boardId: 'b1', planPath: 'plan.md', name: 'demo', tasks: TASKS, waves: WAVES });

/** The plan as parsed, with per-task overrides. */
function plan(overrides = {}, extra = []) {
  return [
    ...TASKS.filter((t) => overrides[t.id] !== null).map((t) => ({ ...t, ...(overrides[t.id] ?? {}) })),
    ...extra,
  ];
}

function resync(events, planTasks, waves = WAVES) {
  const log = journal(...events);
  return planResync(derive(log), log, planTasks, waves);
}

// ── Merge ────────────────────────────────────────────────────────────────────

describe('plan resync — three-way merge', () => {
  it('does nothing when the plan has not moved', () => {
    const result = resync([created()], plan());
    assert.equal(resyncHasWork(result), false);
    assert.deepEqual(result, { updates: [], adds: [], conflicts: [], blocked: [], missing: [], errors: [] });
  });

  it('takes plan changes on cards the board has not touched', () => {
    const result = resync([created()], plan({ 'W1-A': { build: 'build a v2', touches: ['src/a/**', 'src/x.ts'], touchesExpanded: ['src/x.ts'] } }));
    assert.equal(result.updates.length, 1);
    assert.deepEqual(result.updates[0].fields, ['build', 'touches']);
    assert.equal(result.updates[0].changes.build, 'build a v2');
    assert.deepEqual(result.updates[0].changes.touchesExpanded, ['src/x.ts']);
  });

  it('keeps a hand edit the plan did not change, and reports a two-sided change as a conflict', () => {
    const edited = makeEvent('task.updated', { taskId: 'W1-A', changes: { build: 'hand build' }, reason: 'user' });
    assert.equal(resyncHasWork(resync([created(), edited], plan())), false, 'a stale plan never reverts a board edit');

    const result = resync([created(), edited], plan({ 'W1-A': { build: 'plan build', test: 'plan test' } }));
    assert.deepEqual(result.conflicts, [{ taskId: 'W1-A', fields: ['build'] }]);
    assert.deepEqual(result.updates.map((u) => [u.taskId, u.fields]), [['W1-A', ['test']]]);
  });

  it('measures the next re-sync from the last one', () => {
    const synced = makeEvent('task.updated', { taskId: 'W1-A', changes: { build: 'v2' }, reason: 'plan' });
    assert.equal(planBaseSpecs(journal(created(), synced)).get('W1-A').build, 'v2');
    assert.equal(resyncHasWork(resync([created(), synced], plan({ 'W1-A': { build: 'v2' } }))), false);
    const next = resync([created(), synced], plan({ 'W1-A': { build: 'v3' } }));
    assert.deepEqual(next.updates.map((u) => u.changes.build), ['v3']);
  });

  it('holds changes for running and merged cards', () => {
    const result = resync(
      [
        created(),
        makeEvent('task.attempt.started', { taskId: 'W1-A', attemptId: 'a1', role: 'builder' }),
        makeEvent('merge.enqueued', { taskId: 'W1-B' }),
        makeEvent('merge.succeeded', { taskId: 'W1-B', sha: 'abc' }),
      ],
      plan({ 'W1-A': { build: 'x' }, 'W1-B': { accept: 'y' } }),
    );
    assert.equal(result.updates.length, 0);
    assert.deepEqual(result.blocked.map((b) => b.taskId), ['W1-A', 'W1-B']);
    assert.match(result.blocked[0].reason, /running/);
    assert.match(result.blocked[1].reason, /Rewind/);
  });

  it('takes wave and dependency changes, and never drops a card', () => {
    const result = resync(
      [created()],
      plan({ 'W2-C': { wave: 3, dependsOn: [] }, 'W1-B': null }),
      [...WAVES, { n: 3, name: 'Three' }],
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.updates, [
      { taskId: 'W2-C', changes: { wave: 3, dependsOn: [] }, fields: ['wave', 'dependsOn'], wave: { n: 3, name: 'Three' } },
    ]);
    assert.deepEqual(result.missing, ['W1-B']);
  });

  it('treats dependency order as irrelevant', () => {
    const log = [created(), makeEvent('task.updated', { taskId: 'W2-C', changes: { dependsOn: ['W1-A', 'W1-B'] }, reason: 'plan' })];
    assert.equal(resyncHasWork(resync(log, plan({ 'W2-C': { dependsOn: ['W1-B', 'W1-A'] } }))), false);
  });

  it('refuses a graph that would loop or point at nothing', () => {
    const loop = resync([created()], plan({ 'W1-A': { dependsOn: ['W2-C'] } }));
    assert.match(loop.errors.join('\n'), /would loop: .*W1-A.*W2-C/);
    const dangling = resync([created()], plan({ 'W1-A': { dependsOn: ['GONE'] } }));
    assert.match(dangling.errors[0], /W1-A depends on GONE/);
  });

  it('adds new plan tasks with their new wave, and refuses unknown dependencies', () => {
    const added = { id: 'W3-D', title: 'D', wave: 3, dependsOn: ['W2-C'], touches: [], build: 'd', test: 't', accept: 'x' };
    const result = resync([created()], plan({}, [added]), [...WAVES, { n: 3, name: 'Three' }]);
    assert.deepEqual(result.adds, [{ task: added, wave: { n: 3, name: 'Three' } }]);

    const orphan = resync([created()], plan({}, [{ ...added, dependsOn: ['GONE'] }]));
    assert.match(orphan.errors[0], /W3-D depends on GONE/);
  });

  it('treats engine-made cards as not the plan’s', () => {
    const fix = makeEvent('task.added', {
      task: { id: 'FIX-1', title: 'Fix', wave: 3, dependsOn: [], touches: ['**/*'], build: 'f', test: 't', accept: 'a' },
    });
    assert.deepEqual(resync([created(), fix], plan()).missing, [], 'a FIX card is not "missing" from the plan');
    const clash = resync([created(), fix], plan({}, [{ id: 'FIX-1', title: 'Mine', wave: 3, dependsOn: [], touches: [], build: 'b', test: 't', accept: 'a' }]));
    assert.match(clash.errors[0], /FIX-1 is already on the board/);
  });
});

// ── Fold ─────────────────────────────────────────────────────────────────────

describe('plan resync — derive', () => {
  it('dropping a dependency frees a card skipped because of it, and reopens a finished run', () => {
    const abandonA = [
      makeEvent('task.attempt.started', { taskId: 'W1-A', attemptId: 'a1', role: 'builder' }),
      makeEvent('task.attempt.ended', { taskId: 'W1-A', attemptId: 'a1', role: 'builder', outcome: 'fail' }),
      makeEvent('task.abandoned', { taskId: 'W1-A', reason: 'user' }),
      makeEvent('task.skipped', { taskId: 'W2-C', blockedBy: 'W1-A' }),
      makeEvent('run.finished', { summary: 'done' }),
    ];
    const before = derive(journal(created(), ...abandonA));
    assert.equal(before.tasks.get('W2-C').phase, 'skipped');

    const after = derive(
      journal(
        created(),
        ...abandonA,
        makeEvent('task.updated', { taskId: 'W2-C', changes: { dependsOn: [] }, reason: 'plan' }),
      ),
    );
    const c = after.tasks.get('W2-C');
    assert.deepEqual(c.dependsOn, []);
    assert.equal(c.skippedBy, null);
    assert.equal(c.phase, 'idle');
    assert.equal(after.finished, false);
  });

  it('keeps a skip whose blocker is still upstream', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('task.abandoned', { taskId: 'W1-A', reason: 'user' }),
        makeEvent('task.skipped', { taskId: 'W2-C', blockedBy: 'W1-A' }),
        makeEvent('task.updated', { taskId: 'W2-C', changes: { dependsOn: ['W1-A', 'W1-B'] }, reason: 'plan' }),
      ),
    );
    assert.equal(state.tasks.get('W2-C').skippedBy, 'W1-A');
  });

  it('a plan task.added reopens a finished run; a plan task.updated is not a hand edit', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('run.finished', { summary: 'done' }),
        makeEvent('task.updated', { taskId: 'W1-A', changes: { build: 'v2' }, reason: 'plan' }),
      ),
    );
    assert.equal(state.finished, true);
    assert.equal(state.tasks.get('W1-A').edits, 0);

    const reopened = derive(
      journal(
        created(),
        makeEvent('run.finished', { summary: 'done' }),
        makeEvent('task.added', {
          task: { id: 'W3-D', title: 'D', wave: 3, dependsOn: [], touches: [], build: 'd', test: 't', accept: 'a' },
          wave: { n: 3, name: 'Three' },
          source: 'plan',
        }),
      ),
    );
    assert.equal(reopened.finished, false);
    assert.equal(reopened.tasks.get('W3-D').phase, 'idle');
    assert.ok(reopened.waves.some((w) => w.n === 3));
  });
});

// ── Route ────────────────────────────────────────────────────────────────────

function planMarkdown({ alphaBuild = 'build alpha', extra = '', todo = '' } = {}) {
  return `---
name: resync-board
overview: A demo.
todos:
  - id: W1-A
    content: "Wave 1: A"
    status: pending
  - id: W1-B
    content: "Wave 1: B"
    status: pending
${todo}isProject: true
---

# Demo

## Wave Breakdown

### Wave 1 — One

#### Task W1-A: Alpha
- **Build:** ${alphaBuild}
- **Test:** test alpha
- **Accept:** alpha works
- **Touches:** src/alpha/**

#### Task W1-B: Beta
- **Build:** build beta
- **Test:** test beta
- **Accept:** beta works
- **Touches:** src/beta/**
${extra}`;
}

const GAMMA_TODO = `  - id: W2-C
    content: "Wave 2: C"
    status: pending
`;

const GAMMA = `
### Wave 2 — Two

#### Task W2-C: Gamma
- **Build:** build gamma
- **Test:** test gamma
- **Accept:** gamma works
- **Touches:** src/gamma/**
- **Depends on:** W1-A
`;

describe('plan resync — POST /api/boards/:id/resync', { concurrency: 1 }, () => {
  /** @type {http.Server} */
  let server;
  /** @type {string} */
  let base;
  /** @type {string} */
  let workspace;
  /** @type {string | undefined} */
  let previousHome;
  /** @type {string} */
  let previousRoot;

  before(() => {
    previousHome = process.env.MINNOW_HOME;
    previousRoot = getDefaultWorkspaceRoot();
  });

  beforeEach(async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-resync-home-'));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-resync-ws-'));
    process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    resetJournalCache();
    disposeEngines();
    await setWorkspaceRoot(workspace);
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

  after(async () => {
    await setWorkspaceRoot(previousRoot);
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

  async function writePlan(markdown) {
    await fs.writeFile(path.join(workspace, 'resync.md'), markdown);
  }

  async function createBoard() {
    await writePlan(planMarkdown());
    const created = await call('POST', '/api/boards', { planPath: 'resync.md' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.boardId;
  }

  async function eventTypes(boardId) {
    return (await call('GET', `/api/boards/${boardId}/journal`)).body.events.map((e) => e.type);
  }

  it('rejects Build plans on direct board creation and resync without changing the journal', async () => {
    const boardId = await createBoard();
    const before = await eventTypes(boardId);
    await writePlan(planMarkdown().replace(/^---/, '---\nplanType: build'));
    await fs.copyFile(path.join(workspace, 'resync.md'), path.join(workspace, 'build.md'));
    const create = await call('POST', '/api/boards', { planPath: 'build.md' });
    assert.equal(create.status, 400);
    assert.match(JSON.stringify(create.body), /Build plan/);
    const resync = await call('POST', `/api/boards/${boardId}/resync`, {});
    assert.equal(resync.status, 400);
    assert.match(JSON.stringify(resync.body), /Build plan/);
    assert.deepEqual(await eventTypes(boardId), before);
  });

  it('previews without journaling, then applies updates and additions', async () => {
    const boardId = await createBoard();
    await writePlan(planMarkdown({ alphaBuild: 'build alpha, v2', extra: GAMMA, todo: GAMMA_TODO }));
    const before = (await eventTypes(boardId)).length;

    const preview = await call('POST', `/api/boards/${boardId}/resync`, { dryRun: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.applied, false);
    assert.deepEqual(preview.body.result.updates.map((u) => [u.taskId, u.fields]), [['W1-A', ['build']]]);
    assert.deepEqual(preview.body.result.adds.map((a) => a.task.id), ['W2-C']);
    assert.equal((await eventTypes(boardId)).length, before, 'a preview journals nothing');

    const applied = await call('POST', `/api/boards/${boardId}/resync`, {});
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.applied, true);
    const state = stateFromJSON(applied.body.state);
    assert.equal(state.tasks.get('W1-A').buildSpec, 'build alpha, v2');
    assert.equal(state.tasks.get('W1-A').edits, 0);
    assert.deepEqual(state.tasks.get('W2-C').dependsOn, ['W1-A']);
    assert.ok(state.waves.some((w) => w.n === 2));

    const again = await call('POST', `/api/boards/${boardId}/resync`, { dryRun: true });
    assert.equal(again.body.result.updates.length + again.body.result.adds.length, 0, 'second sync is a no-op');
  });

  it('applies a dependency the plan dropped', async () => {
    await writePlan(planMarkdown({ extra: GAMMA, todo: GAMMA_TODO }));
    const created = await call('POST', '/api/boards', { planPath: 'resync.md' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const boardId = created.body.boardId;
    assert.deepEqual(stateFromJSON(created.body.state).tasks.get('W2-C').dependsOn, ['W1-A']);

    await writePlan(planMarkdown({ extra: GAMMA.replace('- **Depends on:** W1-A\n', ''), todo: GAMMA_TODO }));
    const preview = await call('POST', `/api/boards/${boardId}/resync`, { dryRun: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.result.updates.map((u) => [u.taskId, u.fields]), [['W2-C', ['dependsOn']]]);

    const applied = await call('POST', `/api/boards/${boardId}/resync`, {});
    assert.equal(applied.body.applied, true);
    assert.deepEqual(stateFromJSON(applied.body.state).tasks.get('W2-C').dependsOn, []);
  });

  it('answers 400 when the plan no longer parses', async () => {
    const boardId = await createBoard();
    await writePlan('# not a plan\n');
    const broken = await call('POST', `/api/boards/${boardId}/resync`, { dryRun: true });
    assert.equal(broken.status, 400);
    assert.ok(Array.isArray(broken.body.errors));
  });

  it('answers 404 for an unknown board', async () => {
    assert.equal((await call('POST', '/api/boards/nope/resync', {})).status, 404);
  });
});

// ── Summary ──────────────────────────────────────────────────────────────────

describe('plan resync — summary lines', () => {
  it('lists changes first and what stays as is after', async () => {
    const { describeResync } = await import('../../src/orchestrator/plan-resync-summary.ts');
    const { changes, skipped } = describeResync({
      updates: [{ taskId: 'W1-A', changes: { build: 'x' }, fields: ['build', 'touches'] }],
      adds: [{ task: { id: 'W3-D', title: 'Dee', wave: 3 }, wave: { n: 3, name: 'Three' } }],
      conflicts: [{ taskId: 'W1-B', fields: ['accept'] }],
      blocked: [{ taskId: 'W2-C', fields: ['test'], reason: 'this task is running' }],
      missing: ['W1-Z'],
      errors: [],
    });
    assert.deepEqual(changes, ['Update W1-A: Build, Touches', 'Add W3-D — Dee (wave 3, new)']);
    assert.deepEqual(skipped, [
      "Keep W1-B's board edit to Accept (the plan changed it differently)",
      'Not now W2-C (Test): this task is running',
      'W1-Z is no longer in the plan; it stays on the board (Abandon it if unwanted)',
    ]);
  });
});
