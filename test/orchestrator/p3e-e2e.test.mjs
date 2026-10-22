/**
 * P3-E — concurrency > 1 and the Running/Stopped + N autonomy model (MIN-709).
 *
 * Real runner effector + fake host (same as P2-G). Overlap is asserted on
 * journal `seq` windows, never wall-clock `ts`.
 *
 * Seq / cap / AFK / reliability stay on the shared-sandbox `cwd` seam (P2-G
 * instant merge) for speed. The N=2 overlap+finish proof must isolate
 * worktrees and go through the merge queue — `cwd: sandbox` is not that proof.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import { createFakeModelServer, extractRequestContext } from '../../scripts/fake-model-server.mjs';
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from '../../server/orchestrate/board-testing/fake-model-ids.js';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { mergeConfigMeta } from '../../server/config/validators.js';
import { createProvider, updateProvider, listProviders } from '../../server/providers/store.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { postChatCompletionsInProcess } from '../../server/runner/node.js';
import { DEFAULT_HEADLESS_TOOL_IDS } from '../../server/runner/tool-set.js';
import { DEFAULT_BOARD_CONCURRENCY } from '../../server/orchestrator/core/derive.js';
import { stateFromJSON } from '../../server/orchestrator/core/snapshot.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { createRunnerEffector } from '../../server/orchestrator/effector-runner.js';
import { resetJournalCache } from '../../server/orchestrator/journal.js';
import { resetEnsuredBoards } from '../../server/orchestrator/worktree-lifecycle.js';
import { resetBoardIntegrationLock } from '../../server/worktree/worktree-ops.js';
import { getWorktreeSlotPath, isPathUnderWorktreesRoot } from '../../server/worktree/paths.js';
import {
  createBoardsMiddleware,
  setEffectorFactory,
} from '../../server/orchestrator/middleware.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import {
  P2G_PLAN,
  P2G_PLAN_PATH,
  P2G_RELIABILITY_PATH,
  P3E_RELIABILITY_PATH,
  SANDBOX_FILES,
  assertSandboxFiles,
  buildersOverlapBySeq,
  happyScenario,
  reliabilityFromEvents,
  waitFor,
} from './p2g-helpers.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const MODEL = { providerId: FAKE_PROVIDER_ID, id: FAKE_MODEL_ID };
const execFileAsync = promisify(execFile);

const fake = createFakeModelServer({ scenario: happyScenario(), verificationContracts: true });

/** @type {string} */
let homeDir = '';
/** @type {string} */
let sandbox = '';
/** @type {http.Server | null} */
let apiServer = null;
/** @type {string} */
let apiBase = '';
/** @type {string} */
let fakeBase = '';
/** @type {number} */
let boardSerial = 0;

/** @type {null | ((body: unknown, signal: AbortSignal | undefined) => Promise<void>)} */
let beforeModelCall = null;
/** @type {ReturnType<typeof createRunnerEffector> | null} */
let lastEffector = null;

/**
 * @param {string[]} args
 * @param {string} cwd
 */
async function git(args, cwd) {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

/** Instant-pass P3-F so this file does not grow into a ladder / P3-G proof. */
async function skipFinalLadder({ cwd }) {
  return {
    outcome: 'pass',
    summary: 'P3-E injected ladder (merge-queue proof only)',
    runInstructions: `command: true\ncwd: ${cwd}`,
    evidence: { ran: [], rungs: [] },
  };
}

function nextBoardId(prefix = 'p3e') {
  boardSerial += 1;
  return `${prefix}-${boardSerial}`;
}

function createHoldGate() {
  let closed = true;
  /** @type {Array<() => void>} */
  const waiters = [];
  return {
    get closed() {
      return closed;
    },
    /** @param {AbortSignal | undefined} signal */
    wait(signal) {
      if (!closed) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    },
    release() {
      closed = false;
      for (const done of waiters) done();
      waiters.length = 0;
    },
  };
}

async function pointProviderAt(baseUrl) {
  const { providers } = await listProviders();
  const body = {
    id: FAKE_PROVIDER_ID,
    label: 'P3-E fake',
    baseUrl,
    apiKind: 'openai-v1',
  };
  if (providers.some((row) => row.id === FAKE_PROVIDER_ID)) {
    await updateProvider(FAKE_PROVIDER_ID, body);
    return;
  }
  await createProvider(body);
}

async function bindAutopilotModel() {
  const cfg = (await readConfigJson('config.json')) ?? {};
  await writeConfigJson(
    'config.json',
    mergeConfigMeta(cfg, {
      autopilot: {
        plannerProviderId: FAKE_PROVIDER_ID,
        plannerModelId: FAKE_MODEL_ID,
      },
    }),
  );
}

/**
 * Shared-sandbox factory (`cwd`) is the P2-G instant-merge seam.
 * Pass `{ worktrees: true }` and omit cwd so isolateWorktrees allocates trees
 * and merge uses startMerge / the queue.
 *
 * @param {{ worktrees?: boolean }} [opts]
 */
function installRunnerFactory(opts = {}) {
  lastEffector = null;
  const isolateWorktrees = opts.worktrees === true;
  setEffectorFactory((boardId) => {
    lastEffector = createRunnerEffector({
      boardId,
      ...(isolateWorktrees ? { worktrees: true } : { cwd: sandbox }),
      promptVariant: 'lite',
      limits: { maxTurns: 8, wallClockMs: 25_000 },
      model: MODEL,
      ...(isolateWorktrees ? { runFinalLadder: skipFinalLadder } : {}),
      postChatCompletions: async (provider, body, signal) => {
        if (beforeModelCall) await beforeModelCall(body, signal);
        return postChatCompletionsInProcess(provider, body, signal);
      },
    });
    return lastEffector;
  });
}

/**
 * @param {{ worktrees?: boolean }} [opts]
 */
async function startApi(opts = {}) {
  installRunnerFactory(opts);
  const middleware = createBoardsMiddleware();
  apiServer = http.createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (apiServer.address()).port;
  apiBase = `http://127.0.0.1:${port}`;
}

async function stopApi() {
  disposeEngines();
  if (!apiServer) return;
  await new Promise((resolve) => apiServer.close(resolve));
  apiServer = null;
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {unknown} [body]
 */
async function call(method, pathname, body) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

async function createHttpBoard(markdown, boardId) {
  const created = await call('POST', '/api/boards', {
    planPath: P2G_PLAN_PATH,
    markdown,
    boardId,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.boardId;
}

async function waitUntilFinished(boardId, timeoutMs = 45_000) {
  await waitFor(async () => {
    const got = await call('GET', `/api/boards/${boardId}`);
    return got.body?.state?.finished === true;
  }, timeoutMs, `${boardId} to finish`);
  const got = await call('GET', `/api/boards/${boardId}`);
  return stateFromJSON(got.body.state);
}

async function journalEvents(boardId) {
  const journal = await call('GET', `/api/boards/${boardId}/journal`);
  return journal.body.events;
}

async function wipeSandboxFiles() {
  for (const rel of Object.keys(SANDBOX_FILES)) {
    await fsp.rm(path.join(sandbox, rel), { force: true });
  }
}

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-p3e');
  await ensureMinnowLayout();
  sandbox = path.join(homeDir, 'p3e-sandbox');
  await fsp.mkdir(path.join(sandbox, 'src'), { recursive: true });
  await initWorkspaceRoot();
  await setWorkspaceRoot(sandbox);
  await git(['init'], sandbox);
  await git(['config', 'user.email', 'test@example.com'], sandbox);
  await git(['config', 'user.name', 'Test'], sandbox);
  await fsp.writeFile(path.join(sandbox, 'README.md'), '# p3e sandbox\n', 'utf8');
  await git(['add', 'README.md'], sandbox);
  await git(['commit', '-m', 'init'], sandbox);
  await bindAutopilotModel();
  fake.reset();
  const port = await fake.listen(0);
  fakeBase = `http://127.0.0.1:${port}`;
  await pointProviderAt(fakeBase);
});

beforeEach(async () => {
  fake.reset();
  beforeModelCall = null;
  await pointProviderAt(fakeBase);
  await wipeSandboxFiles();
  resetJournalCache();
  disposeEngines();
  deleteGenerationsForProviderShutdown();
});

afterEach(async () => {
  beforeModelCall = null;
  lastEffector = null;
  deleteGenerationsForProviderShutdown();
  await stopApi();
  resetJournalCache();
  resetEnsuredBoards();
  resetBoardIntegrationLock();
});

after(async () => {
  deleteGenerationsForProviderShutdown();
  disposeEngines();
  if (typeof fake.server.closeAllConnections === 'function') {
    fake.server.closeAllConnections();
  }
  await fake.close();
  await rmTestHome(homeDir);
  resetMinnowHomeCache();
});

// ── P3-E N=2 overlap ─────────────────────────────────────────────────────────

describe('P3-E N=2 overlap + finish with isolated worktrees', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi({ worktrees: true });
  });

  test(
    'N=2 overlaps on seq with real worktrees; merge uses the queue not instant pass',
    { timeout: 90_000 },
    async () => {
      const gate = createHoldGate();
      /** @type {Set<string>} */
      const firstBuilderCall = new Set();
      beforeModelCall = async (body, signal) => {
        const ctx = extractRequestContext(body);
        if (ctx.role !== 'builder') return;
        if (ctx.taskId !== 'W1-A' && ctx.taskId !== 'W1-B') return;
        const key = String(ctx.taskId);
        if (firstBuilderCall.has(key)) return;
        firstBuilderCall.add(key);
        await gate.wait(signal);
      };

      const boardId = nextBoardId('overlap-wt');
      await createHttpBoard(P2G_PLAN, boardId);
      const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 2 });
      assert.equal(started.status, 200);

      await waitFor(
        async () => firstBuilderCall.size >= 2,
        30_000,
        'both wave-1 builders to enter the host',
      );

      const liveBuilders = (lastEffector?.inspect() ?? []).filter(
        (row) => row.role === 'builder' && (row.taskId === 'W1-A' || row.taskId === 'W1-B'),
      );
      assert.equal(liveBuilders.length, 2, `inspect was ${JSON.stringify(lastEffector?.inspect())}`);
      const livePaths = liveBuilders.map((row) => path.resolve(String(row.worktree)));
      assert.notEqual(livePaths[0], livePaths[1], 'wave-1 builders must not share a worktree');
      for (const wt of livePaths) {
        assert.notEqual(wt, path.resolve(sandbox), 'worktree must not be the shared sandbox cwd');
        assert.equal(isPathUnderWorktreesRoot(wt), true, `not a managed worktree: ${wt}`);
        await fsp.access(wt);
      }

      const mid = await journalEvents(boardId);
      assert.equal(buildersOverlapBySeq(mid), true, 'both builders started before either ended');
      const midStarts = mid.filter(
        (e) =>
          e.type === 'task.attempt.started' &&
          e.role === 'builder' &&
          (e.taskId === 'W1-A' || e.taskId === 'W1-B'),
      );
      assert.equal(midStarts.length, 2);
      for (const event of midStarts) {
        assert.equal(typeof event.worktree, 'string');
        assert.ok(String(event.worktree).length > 0);
        assert.notEqual(path.resolve(String(event.worktree)), path.resolve(sandbox));
        assert.equal(isPathUnderWorktreesRoot(String(event.worktree)), true);
      }
      assert.notEqual(
        path.resolve(String(midStarts[0].worktree)),
        path.resolve(String(midStarts[1].worktree)),
      );

      gate.release();

      const state = await waitUntilFinished(boardId, 75_000);
      assert.equal(state.finished, true);
      assert.equal(state.concurrency, 2);
      for (const id of ['W1-A', 'W1-B', 'W2-A']) {
        assert.equal(state.tasks.get(id).phase, 'merged', id);
      }

      const events = await journalEvents(boardId);
      assert.equal(buildersOverlapBySeq(events), true);

      const enqueued = events.filter((e) => e.type === 'merge.enqueued');
      assert.equal(new Set(enqueued.map((event) => event.taskId)).size, 3, 'each task must enter the merge queue');
      assert.equal(enqueued.length, 3 + events.filter((event) => event.type === 'merge.rebased').length, 'changed rebases require fresh test approval and re-enqueue');
      const succeeded = events.filter((e) => e.type === 'merge.succeeded');
      assert.equal(succeeded.length, 3);
      for (const event of succeeded) {
        assert.notEqual(event.sha, 'workspace-head', 'merge must not be engine-driven instant pass');
        assert.equal(typeof event.beforeSha, 'string');
        assert.ok(String(event.beforeSha).length > 0);
        assert.match(String(event.sha), /^[0-9a-f]{40}$/i);
        assert.notEqual(event.sha, event.beforeSha);
      }

      const integration = getWorktreeSlotPath(boardId, 'integration');
      for (const [rel, expected] of Object.entries(SANDBOX_FILES)) {
        const body = (await fsp.readFile(path.join(integration, rel), 'utf8')).replace(/\r\n/g, '\n');
        assert.equal(body, expected, `${rel} in integration worktree`);
      }
      await assert.rejects(() => assertSandboxFiles(sandbox), /did not match|ENOENT/);
    },
  );
});

// ── P3-E overlap by ──────────────────────────────────────────────────────────

describe('P3-E overlap by journal seq (shared sandbox)', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi();
  });

  test('N=1 is sequential: wave-1 builders do not overlap', { timeout: 60_000 }, async () => {
    const boardId = nextBoardId('seq');
    await createHttpBoard(P2G_PLAN, boardId);
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    const state = await waitUntilFinished(boardId);
    assert.equal(state.finished, true);
    const events = await journalEvents(boardId);
    assert.equal(buildersOverlapBySeq(events), false, 'N=1 must not overlap builders');
  });

  test('AFK is unattended Running: start only, no ask_question, board finishes', { timeout: 60_000 }, async () => {
    assert.equal(DEFAULT_HEADLESS_TOOL_IDS.includes('ask_question'), false);
    const boardId = nextBoardId('afk');
    await createHttpBoard(P2G_PLAN, boardId);
    const started = await call('POST', `/api/boards/${boardId}/start`, {});
    assert.equal(started.status, 200);
    assert.equal(stateFromJSON(started.body.state).concurrency, DEFAULT_BOARD_CONCURRENCY);
    const state = await waitUntilFinished(boardId);
    assert.equal(state.finished, true);
    assert.equal(state.status, 'stopped');
    const events = await journalEvents(boardId);
    assert.equal(
      events.some((e) => e.type === 'task.attempt.started' && String(e.taskId).startsWith('manual')),
      false,
    );
  });

  test('Stopped + manual start runs exactly one task', { timeout: 60_000 }, async () => {
    const boardId = nextBoardId('manual');
    await createHttpBoard(P2G_PLAN, boardId);
    const started = await call('POST', `/api/boards/${boardId}/tasks/W1-A/start`);
    assert.equal(started.status, 200);
    await waitFor(async () => {
      const events = await journalEvents(boardId);
      return events.some((e) => e.type === 'task.attempt.ended' && e.taskId === 'W1-A');
    }, 20_000, 'W1-A attempt to end');
    const events = await journalEvents(boardId);
    assert.equal(
      events.some((e) => e.type === 'task.attempt.started' && e.taskId === 'W1-B'),
      false,
      'W1-B must not start on a stopped board',
    );
    const got = stateFromJSON((await call('GET', `/api/boards/${boardId}`)).body.state);
    assert.notEqual(got.status, 'running');
    assert.equal(got.finished, false);
  });

  test('raising N mid-run starts more work; lowering does not kill in-flight', { timeout: 60_000 }, async () => {
    const gate = createHoldGate();
    beforeModelCall = async (body, signal) => {
      const ctx = extractRequestContext(body);
      if (ctx.role === 'builder') await gate.wait(signal);
    };

    const boardId = nextBoardId('cap');
    await createHttpBoard(P2G_PLAN, boardId);
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    await waitFor(async () => {
      const events = await journalEvents(boardId);
      return events.filter((e) => e.type === 'task.attempt.started' && e.role === 'builder').length === 1;
    }, 20_000, 'first builder start');

    await call('POST', `/api/boards/${boardId}/concurrency`, { n: 2 });
    await waitFor(async () => {
      const events = await journalEvents(boardId);
      return events.filter((e) => e.type === 'task.attempt.started' && e.role === 'builder').length >= 2;
    }, 20_000, 'second builder after raise');

    let events = await journalEvents(boardId);
    const openBuilders = events.filter(
      (e) => e.type === 'task.attempt.started' && e.role === 'builder',
    ).length;
    const endedBuilders = events.filter(
      (e) => e.type === 'task.attempt.ended' && e.role === 'builder',
    ).length;
    assert.ok(openBuilders >= 2);
    assert.equal(endedBuilders, 0, 'held builders must still be in flight');
    assert.equal(buildersOverlapBySeq(events), true);

    await call('POST', `/api/boards/${boardId}/concurrency`, { n: 1 });
    await new Promise((r) => setTimeout(r, 200));
    events = await journalEvents(boardId);
    const endedAfterLower = events.filter(
      (e) => e.type === 'task.attempt.ended' && e.role === 'builder',
    ).length;
    assert.equal(endedAfterLower, 0, 'lowering N must not end in-flight builders');

    gate.release();
    const state = await waitUntilFinished(boardId, 60_000);
    assert.equal(state.finished, true);
  });
});

// ── P3-E reliability vs P2-G ─────────────────────────────────────────────────

describe('P3-E reliability vs P2-G (10-run, N=2, shared sandbox)', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi();
  });

  test('records completions, retries, abandonments, overflow vs N=1 baseline', { timeout: 180_000 }, async () => {
    const RUNS = 10;
    /** @type {Array<Record<string, unknown>>} */
    const perRun = [];
    let completed = 0;
    let retries = 0;
    let abandonments = 0;
    let overflowEvents = 0;

    for (let n = 1; n <= RUNS; n += 1) {
      fake.reset();
      await wipeSandboxFiles();
      const boardId = nextBoardId(`rel${n}`);
      const t0 = Date.now();
      let finished = false;
      let merged = 0;
      let runRetries = 0;
      let runAbandoned = 0;
      let runOverflow = 0;
      try {
        await createHttpBoard(P2G_PLAN, boardId);
        const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 2 });
        assert.equal(started.status, 200, `run ${n} start: ${JSON.stringify(started.body)}`);
        const state = await waitUntilFinished(boardId, 40_000);
        finished = state.finished === true;
        merged = [...state.tasks.values()].filter((task) => task.phase === 'merged').length;
        const journal = await call('GET', `/api/boards/${boardId}/journal`);
        const stats = reliabilityFromEvents(journal.body.events);
        runRetries = stats.retries;
        runAbandoned = stats.abandonments;
        runOverflow = stats.overflowEvents;
        if (finished && merged === 3) {
          await assertSandboxFiles(sandbox);
          completed += 1;
        }
      } catch (err) {
        finished = false;
        perRun.push({
          n,
          finished: false,
          merged,
          retries: runRetries,
          abandoned: runAbandoned,
          overflowEvents: runOverflow,
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
        retries += runRetries;
        abandonments += runAbandoned;
        overflowEvents += runOverflow;
        continue;
      }
      retries += runRetries;
      abandonments += runAbandoned;
      overflowEvents += runOverflow;
      perRun.push({
        n,
        finished,
        merged,
        retries: runRetries,
        abandoned: runAbandoned,
        overflowEvents: runOverflow,
        ms: Date.now() - t0,
      });
    }

    const baseline = JSON.parse(fs.readFileSync(P2G_RELIABILITY_PATH, 'utf8'));
    const report = {
      runs: RUNS,
      concurrency: 2,
      completed,
      failed: RUNS - completed,
      retries,
      abandonments,
      overflowEvents,
      perRun,
      recordedAt: '2026-08-29',
      host: 'scripts/fake-model-server.mjs',
      baseline: {
        path: 'test/orchestrator/p2g-reliability.json',
        concurrency: 1,
        completed: baseline.completed,
        retries: baseline.retries,
        abandonments: baseline.abandonments,
      },
      comparison: {
        completedDelta: completed - baseline.completed,
        retriesDelta: retries - baseline.retries,
        abandonmentsDelta: abandonments - baseline.abandonments,
      },
      note:
        'Deterministic fake host at N=2. 10/10 is the host ceiling, not evidence that live agents never retry. Do not raise the default concurrency from this number.',
    };
    await fsp.writeFile(P3E_RELIABILITY_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    assert.equal(completed, RUNS, `expected ${RUNS} completions, got ${completed}`);
    assert.equal(fs.existsSync(THIS_FILE), true);
  });
});
