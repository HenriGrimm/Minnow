/**
 * P3-F — Final Tester static ladder (MIN-710).
 *
 * Fixture repos only. Never `npm test` the Minnow tree from this file —
 * that suite has known failures and rewrites fixtures.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, afterEach, before, describe, test } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { plan } from '../../server/orchestrator/core/plan.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createRunnerEffector } from '../../server/orchestrator/effector-runner.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import {
  execLadderCommand,
  matchesKnownBaseline,
  parseRunInstructions,
  parseVerificationChecklist,
  resolveLadderRungs,
  runFinalLadder,
} from '../../server/orchestrator/final-test.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import {
  attemptBranch,
  resetEnsuredBoards,
} from '../../server/orchestrator/worktree-lifecycle.js';
import {
  createWorktree,
  ensureIntegration,
  mergeIntoIntegration,
  resetBoardIntegrationLock,
} from '../../server/worktree/worktree-ops.js';
import { getWorktreeSlotPath } from '../../server/worktree/paths.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MERGE_QUEUE_JS = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'merge-queue.js');
const FINAL_TEST_JS = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'final-test.js');

const CHECKLIST = `# Fixture

## Verification Checklist

- [ ] \`npm run typecheck\` passes
- [ ] \`npm run lint\` passes
- [ ] \`npm test\` passes
- [ ] \`npm run build\` passes
`;

/**
 * @param {string} id
 * @param {object} [extra]
 */
function taskSpec(id, extra = {}) {
  return {
    id,
    title: id,
    wave: 1,
    dependsOn: [],
    touches: [`src/${id}/**`],
    build: 'build',
    test: 'test',
    accept: 'ok',
    ...extra,
  };
}

/** @param {string} cwd */
async function gitFile(args, cwd) {
  return execFileAsync('git', args, { cwd, windowsHide: true });
}

/**
 * @param {string} dir
 * @param {'pass' | 'type-error' | 'unit-fail'} variant
 */
async function writeLadderPackage(dir, variant = 'pass') {
  await fsp.mkdir(path.join(dir, 'rungs'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'documentation', 'plans'), { recursive: true });

  const typecheck =
    variant === 'type-error'
      ? `console.error("error TS2322: Type 'string' is not assignable to type 'number'.");\nprocess.exit(1);\n`
      : `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.accessSync(path.join(root, 'a.txt'));
fs.accessSync(path.join(root, 'b.txt'));
`;

  const unit =
    variant === 'unit-fail'
      ? `console.error('expected 2 === 3');\nprocess.exit(1);\n`
      : `console.log('unit ok');\n`;

  await fsp.writeFile(path.join(dir, 'rungs', 'typecheck.mjs'), typecheck, 'utf8');
  await fsp.writeFile(
    path.join(dir, 'rungs', 'lint.mjs'),
    'console.log("lint ok");\n',
    'utf8',
  );
  await fsp.writeFile(path.join(dir, 'rungs', 'unit.mjs'), unit, 'utf8');
  await fsp.writeFile(
    path.join(dir, 'rungs', 'build.mjs'),
    'console.log("build ok");\n',
    'utf8',
  );
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'final-ladder-fixture',
        private: true,
        type: 'module',
        scripts: {
          typecheck: 'node ./rungs/typecheck.mjs',
          lint: 'node ./rungs/lint.mjs',
          test: 'node ./rungs/unit.mjs',
          build: 'node ./rungs/build.mjs',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fsp.writeFile(path.join(dir, 'documentation', 'plans', 'plan.md'), CHECKLIST, 'utf8');
}

/**
 * @param {string} suffix
 * @param {'pass' | 'type-error' | 'unit-fail'} [variant]
 */
async function makeRepo(suffix, variant = 'pass') {
  resetBoardIntegrationLock();
  resetEnsuredBoards();
  const boardId = `p3f-${suffix}`;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `minnow-p3f-${suffix}-`));
  const repoDir = path.join(root, 'repo');
  const minnowHome = path.join(root, 'minnow-home');
  await fsp.mkdir(repoDir, { recursive: true });
  await fsp.mkdir(minnowHome, { recursive: true });
  process.env.MINNOW_HOME = minnowHome;
  resetMinnowHomeCache();
  await setWorkspaceRoot(repoDir);

  await gitFile(['init'], repoDir);
  await gitFile(['config', 'user.email', 'test@example.com'], repoDir);
  await gitFile(['config', 'user.name', 'Test'], repoDir);
  await writeLadderPackage(repoDir, variant);
  await fsp.writeFile(path.join(repoDir, 'README.md'), '# p3f\n', 'utf8');
  await gitFile(['add', '.'], repoDir);
  await gitFile(['commit', '-m', 'init'], repoDir);

  const integrationRef = attemptBranch(boardId, 'integration');
  const ensured = await ensureIntegration({ boardId, branch: integrationRef });
  assert.equal(ensured.ok, true, ensured.output || ensured.error);

  return { boardId, repoDir, minnowHome, integrationRef, root };
}

/**
 * @param {{ boardId: string, integrationRef: string }} h
 * @param {string} slotId
 * @param {Record<string, string>} files
 */
async function addSlot(h, slotId, files) {
  const branch = attemptBranch(h.boardId, slotId);
  const created = await createWorktree({
    boardId: h.boardId,
    slotId,
    branch,
    baseRef: h.integrationRef,
  });
  assert.equal(created.ok, true, created.output || created.error);
  const wt = getWorktreeSlotPath(h.boardId, slotId);
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(wt, name), content, 'utf8');
  }
  await gitFile(['add', '-A'], wt);
  await gitFile(['commit', '-m', `commit ${slotId}`], wt);
  return { branch, wt, slotId };
}

/**
 * Journal a board whose tasks are already merged so the next tick wants Final.
 *
 * @param {string} boardId
 */
async function seedMergedJournal(boardId, journal) {
  await journal.createBoard(boardId);
  /** @type {Record<string, unknown>[]} */
  const events = [
    makeEvent('board.created', {
      boardId,
      planPath: 'documentation/plans/plan.md',
      tasks: [taskSpec('A'), taskSpec('B')],
      waves: [],
    }),
  ];
  for (const id of ['A', 'B']) {
    events.push(
      makeEvent('task.attempt.started', {
        taskId: id,
        attemptId: `b-${id}`,
        role: 'builder',
      }),
      makeEvent('task.attempt.ended', {
        taskId: id,
        attemptId: `b-${id}`,
        role: 'builder',
        outcome: 'pass',
      }),
      makeEvent('task.attempt.started', {
        taskId: id,
        attemptId: `t-${id}`,
        role: 'tester',
      }),
      makeEvent('task.attempt.ended', {
        taskId: id,
        attemptId: `t-${id}`,
        role: 'tester',
        outcome: 'pass',
      }),
      makeEvent('merge.enqueued', { taskId: id }),
      makeEvent('merge.succeeded', { taskId: id, sha: `sha-${id}` }),
    );
  }
  for (const event of events) {
    await journal.appendEvent(boardId, event);
  }
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {string} label
 */
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

// ── P3-F ladder resolution ───────────────────────────────────────────────────

describe('P3-F ladder resolution (no Minnow npm test)', () => {
  test('checklist maps the four rungs', () => {
    const mapped = parseVerificationChecklist(CHECKLIST);
    assert.equal(mapped.typecheck, 'npm run typecheck');
    assert.equal(mapped.lint, 'npm run lint');
    assert.equal(mapped.unit, 'npm test');
    assert.equal(mapped.build, 'npm run build');
  });

  test('lint is skipped when the package has no lint script and the plan is silent', () => {
    const rungs = resolveLadderRungs({
      planMarkdown: '# No checklist\n',
      packageJson: { scripts: { test: 'node --test', build: 'echo build' } },
    });
    assert.deepEqual(
      rungs.map((r) => r.id),
      ['typecheck', 'unit', 'build'],
    );
  });

  test('baseline: same non-zero unit exit is not a regression', () => {
    assert.equal(
      matchesKnownBaseline(
        'unit',
        { exitCode: 1, output: 'expected 2 === 3\n' },
        { unit: { expectedExitCode: 1, failingPatterns: ['expected 2 === 3'] } },
      ),
      true,
    );
    assert.equal(
      matchesKnownBaseline(
        'unit',
        { exitCode: 1, output: 'a brand new boom\n' },
        { unit: { expectedExitCode: 1, failingPatterns: ['expected 2 === 3'] } },
      ),
      false,
    );
  });
});

describe('ladder PATH', () => {
  test('a bare checklist binary resolves from the checkout node_modules/.bin', async () => {
    // A plan checklist said `tsc --noEmit`; exec'd outside `npm run`, that failed
    // as "'tsc' is not recognized" and spawned a pointless integration-fix task.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ladder-bin-'));
    try {
      const bin = path.join(dir, 'node_modules', '.bin');
      await fsp.mkdir(bin, { recursive: true });
      if (process.platform === 'win32') {
        await fsp.writeFile(path.join(bin, 'ladderfakebin.cmd'), '@echo local-bin-ran\r\n');
      } else {
        const file = path.join(bin, 'ladderfakebin');
        await fsp.writeFile(file, '#!/bin/sh\necho local-bin-ran\n');
        await fsp.chmod(file, 0o755);
      }
      const result = await execLadderCommand('ladderfakebin', { cwd: dir });
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /local-bin-ran/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── P3-F merge-queue ─────────────────────────────────────────────────────────

describe('P3-F merge-queue stays model-free', () => {
  test('merge-queue.js does not import the ladder or a runner', () => {
    const source = fs.readFileSync(MERGE_QUEUE_JS, 'utf8');
    assert.equal(source.includes('final-test'), false);
    assert.equal(/\brunTurn\b/.test(source), false);
  });

  test('final-test.js does not import a generation or runner', () => {
    const source = fs.readFileSync(FINAL_TEST_JS, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const specs = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      assert.equal(
        /runner|generations|model-binding|prompts|providers|effector-runner|fake-model/i.test(spec),
        false,
        `forbidden import: ${spec}`,
      );
    }
  });
});

// ── P3-F scripted effector ───────────────────────────────────────────────────

describe('P3-F scripted effector', () => {
  test('still instant-passes final (Phase 1 stays model-free and git-free)', async () => {
    const effector = createScriptedEffector();
    /** @type {import('../../server/orchestrator/engine.js').AttemptEnd | undefined} */
    let end;
    effector.onEnd((e) => {
      end = e;
    });
    await effector.start({
      taskId: null,
      role: 'final',
      seedKind: 'initial',
      sameWorktree: false,
    });
    await waitUntil(() => end != null, 1000, 'scripted final end');
    assert.equal(end.role, 'final');
    assert.equal(end.outcome, 'pass');
  });
});

// ── P3-F fixture ladder ──────────────────────────────────────────────────────

describe('P3-F fixture ladder (real commands, not Minnow)', { concurrency: false }, () => {
  /** @type {string | undefined} */
  let previousHome;

  before(() => {
    previousHome = process.env.MINNOW_HOME;
  });

  afterEach(() => {
    resetBoardIntegrationLock();
    resetEnsuredBoards();
  });

  after(() => {
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    resetBoardIntegrationLock();
    resetEnsuredBoards();
  });

  test('clean fixture passes all four rungs', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-p3f-clean-'));
    await writeLadderPackage(dir, 'pass');
    await fsp.writeFile(path.join(dir, 'a.txt'), 'from-a\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'from-b\n', 'utf8');
    /** @type {string[]} */
    const ran = [];
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: CHECKLIST,
      execCommand: async (command, opts) => {
        ran.push(command);
        return execLadderCommand(command, opts);
      },
    });
    assert.equal(result.outcome, 'pass');
    assert.deepEqual(ran, ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build']);
    assert.deepEqual(result.evidence.ran, ['typecheck', 'lint', 'unit', 'build']);
    assert.equal(result.evidence.failedRung, null);
  });

  test('deliberate type error fails at rung 1; later rungs do not run', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-p3f-tsc-'));
    await writeLadderPackage(dir, 'type-error');
    await fsp.writeFile(path.join(dir, 'a.txt'), 'from-a\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'from-b\n', 'utf8');
    /** @type {string[]} */
    const ran = [];
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: CHECKLIST,
      execCommand: async (command, opts) => {
        ran.push(command);
        return execLadderCommand(command, opts);
      },
    });
    assert.equal(result.outcome, 'fail');
    assert.equal(result.evidence.failedRung, 'typecheck');
    assert.deepEqual(result.evidence.ran, ['typecheck']);
    assert.deepEqual(ran, ['npm run typecheck']);
    assert.match(String(result.evidence.output), /TS2322/);
    const parsed = parseRunInstructions(result.runInstructions);
    assert.ok(parsed);
    assert.equal(parsed.command, 'npm run typecheck');
    assert.equal(path.resolve(parsed.cwd), path.resolve(dir));
  });

  test('failing unit test fails at rung 3 with test output in the result', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-p3f-unit-'));
    await writeLadderPackage(dir, 'unit-fail');
    await fsp.writeFile(path.join(dir, 'a.txt'), 'from-a\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'from-b\n', 'utf8');
    const result = await runFinalLadder({ cwd: dir, planMarkdown: CHECKLIST });
    assert.equal(result.outcome, 'fail');
    assert.equal(result.evidence.failedRung, 'unit');
    assert.deepEqual(result.evidence.ran, ['typecheck', 'lint', 'unit']);
    assert.match(String(result.evidence.output), /expected 2 === 3/);
  });

  test('runInstructions reproduces the same failure', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-p3f-repro-'));
    await writeLadderPackage(dir, 'type-error');
    await fsp.writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'y\n', 'utf8');
    const result = await runFinalLadder({ cwd: dir, planMarkdown: CHECKLIST });
    const parsed = parseRunInstructions(result.runInstructions);
    assert.ok(parsed);
    const replay = await execLadderCommand(parsed.command, { cwd: parsed.cwd });
    assert.notEqual(replay.exitCode, 0);
    assert.match(replay.output, /TS2322/);
  });

  test('recorded unit baseline is not treated as a regression', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-p3f-base-'));
    await writeLadderPackage(dir, 'unit-fail');
    await fsp.writeFile(path.join(dir, 'a.txt'), 'from-a\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'from-b\n', 'utf8');
    await fsp.writeFile(
      path.join(dir, 'documentation', 'plans', 'final-test-baseline.json'),
      `${JSON.stringify(
        { unit: { expectedExitCode: 1, failingPatterns: ['expected 2 === 3'] } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const result = await runFinalLadder({ cwd: dir, planMarkdown: CHECKLIST });
    assert.equal(result.outcome, 'pass', JSON.stringify(result.evidence));
    const unit = /** @type {Array<{ id: string, matchedBaseline?: boolean }>} */ (
      result.evidence.rungs
    ).find((r) => r.id === 'unit');
    assert.equal(unit?.matchedBaseline, true);
    assert.deepEqual(result.evidence.ran, ['typecheck', 'lint', 'unit', 'build']);
  });

  test(
    'engine journals pass from the integration worktree; merged files are in no single task tree',
    { timeout: 45_000 },
    async () => {
      const h = await makeRepo('pass', 'pass');
      const a = await addSlot(h, 'slot-a', { 'a.txt': 'from-a\n' });
      const b = await addSlot(h, 'slot-b', { 'b.txt': 'from-b\n' });
      const mergedA = await mergeIntoIntegration({
        boardId: h.boardId,
        fromBranch: a.branch,
        message: 'merge A',
      });
      assert.equal(mergedA.ok, true, mergedA.output || mergedA.error);
      const mergedB = await mergeIntoIntegration({
        boardId: h.boardId,
        fromBranch: b.branch,
        message: 'merge B',
      });
      assert.equal(mergedB.ok, true, mergedB.output || mergedB.error);

      const intPath = getWorktreeSlotPath(h.boardId, 'integration');
      assert.equal(fs.existsSync(path.join(intPath, 'a.txt')), true);
      assert.equal(fs.existsSync(path.join(intPath, 'b.txt')), true);
      assert.equal(fs.existsSync(path.join(a.wt, 'b.txt')), false, 'A tree must not have B file');
      assert.equal(fs.existsSync(path.join(b.wt, 'a.txt')), false, 'B tree must not have A file');

      const journal = createMemoryJournal();
      await seedMergedJournal(h.boardId, journal);
      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      const effector = createRunnerEffector({
        boardId: h.boardId,
        journal,
        getState: () => box.engine.getState(),
        worktrees: true,
      });
      const engine = createEngine({ boardId: h.boardId, effector, journal, tickMs: 100_000 });
      box.engine = engine;
      await engine.load();
      try {
        await engine.startBoard(1);
        await waitUntil(() => engine.getState().finished === true, 30_000, 'board to finish');
        const events = await journal.readEvents(h.boardId);
        const ended = events.find((event) => event.type === 'final.test.ended');
        assert.ok(ended, 'expected final.test.ended');
        assert.equal(ended.outcome, 'pass');
        const parsed = parseRunInstructions(ended.runInstructions);
        assert.ok(parsed);
        assert.equal(path.resolve(parsed.cwd), path.resolve(intPath));
        assert.equal(engine.getState().finalTest.outcome, 'pass');
        const startedFinal = effector.started.filter((s) => s.role === 'final');
        assert.equal(startedFinal.length, 1);
        assert.equal(path.resolve(startedFinal[0].worktree), path.resolve(intPath));
      } finally {
        engine.dispose();
      }
    },
  );

  test(
    'ladder failure journals fail and does not reopen, retry, or abandon tasks',
    { timeout: 45_000 },
    async () => {
      const h = await makeRepo('fail', 'type-error');
      const a = await addSlot(h, 'slot-a', { 'a.txt': 'from-a\n' });
      const b = await addSlot(h, 'slot-b', { 'b.txt': 'from-b\n' });
      assert.equal((await mergeIntoIntegration({ boardId: h.boardId, fromBranch: a.branch })).ok, true);
      assert.equal((await mergeIntoIntegration({ boardId: h.boardId, fromBranch: b.branch })).ok, true);

      const journal = createMemoryJournal();
      await seedMergedJournal(h.boardId, journal);
      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      const effector = createRunnerEffector({
        boardId: h.boardId,
        journal,
        getState: () => box.engine.getState(),
        worktrees: true,
      });
      const engine = createEngine({ boardId: h.boardId, effector, journal, tickMs: 100_000 });
      box.engine = engine;
      await engine.load();
      try {
        await engine.startBoard(1);
        await waitUntil(() => engine.getState().finished === true, 30_000, 'board to finish after fail');
        const state = engine.getState();
        assert.equal(state.finalTest.outcome, 'fail');
        assert.equal(state.tasks.get('A').phase, 'merged');
        assert.equal(state.tasks.get('B').phase, 'merged');
        assert.deepEqual(plan(state), []);
        const events = await journal.readEvents(h.boardId);
        assert.equal(events.some((e) => e.type === 'task.abandoned'), false);
        assert.equal(
          events.filter((e) => e.type === 'task.attempt.started' && e.role === 'builder').length,
          2,
          'seeded builders only — no retry',
        );
        const ended = events.find((e) => e.type === 'final.test.ended');
        assert.equal(ended.outcome, 'fail');
        assert.match(String(ended.evidence?.output), /TS2322/);
        const parsed = parseRunInstructions(ended.runInstructions);
        assert.ok(parsed);
        const replay = await execLadderCommand(parsed.command, { cwd: parsed.cwd });
        assert.notEqual(replay.exitCode, 0);
      } finally {
        engine.dispose();
      }
    },
  );

  test('injected runTurn still instant-passes final (existing P3-C fake path)', async () => {
    const journal = createMemoryJournal();
    const boardId = 'p3f-fake-turn';
    await seedMergedJournal(boardId, journal);
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = createRunnerEffector({
      boardId,
      journal,
      getState: () => box.engine.getState(),
      worktrees: true,
      runTurn: async () => ({ outcome: 'pass', summary: 'unused', evidence: [] }),
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      await waitUntil(() => engine.getState().finished === true, 5_000, 'fake-turn final');
      assert.equal(engine.getState().finalTest.outcome, 'pass');
    } finally {
      engine.dispose();
    }
  });
});
