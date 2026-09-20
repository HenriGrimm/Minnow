/**
 * P2-G — real single-agent board, end to end (MIN-704).
 *
 * Driven through HTTP `/api/boards` (UI closed) against the runner effector
 * and a fake model host programmed to emit `save_file` then `report_outcome`.
 * No live LLM. This file must not touch a renderer — no DOM, no bundler.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import {
  createFakeModelServer,
  extractRequestContext,
} from '../../scripts/fake-model-server.mjs';
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from '../../server/orchestrate/board-testing/fake-model-ids.js';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { mergeConfigMeta } from '../../server/config/validators.js';
import { createProvider, updateProvider, listProviders } from '../../server/providers/store.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { postChatCompletionsHttp } from '../../server/runner/index.js';
import { MAX_TRANSIENT_FETCH_ATTEMPTS as TRANSIENT_ATTEMPTS } from '../../server/runner/transient-fetch-retry.js';
import { isParseErrors, parsePlan } from '../../server/orchestrator/core/parse-plan.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { stateFromJSON } from '../../server/orchestrator/core/snapshot.js';
import { createEngine, disposeEngines } from '../../server/orchestrator/engine.js';
import {
  cancelOrphanedRunnerGenerations,
  createRunnerEffector,
} from '../../server/orchestrator/effector-runner.js';
import { resetJournalCache } from '../../server/orchestrator/journal.js';
import {
  createBoardsMiddleware,
  setEffectorFactory,
} from '../../server/orchestrator/middleware.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import {
  MINI_PLAN,
  P2G_PLAN,
  P2G_PLAN_PATH,
  P2G_RELIABILITY_PATH,
  SANDBOX_FILES,
  afterCrashScenario,
  assertSandboxFiles,
  blockedScenario,
  failingBuildScenario,
  failingTestScenario,
  happyScenario,
  reliabilityFromEvents,
  waitFor,
} from './p2g-helpers.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const MODEL = { providerId: FAKE_PROVIDER_ID, id: FAKE_MODEL_ID };

const fake = createFakeModelServer({ scenario: happyScenario() });

/** @type {string} */
let homeDir = '';
/** @type {string} */
let sandbox = '';
/** @type {string} */
let fakeBase = '';
/** @type {http.Server | null} */
let apiServer = null;
/** @type {string} */
let apiBase = '';
/** @type {ReturnType<typeof createRunnerEffector> | null} */
let lastEffector = null;
/** @type {number} */
let boardSerial = 0;

function nextBoardId(prefix = 'p2g') {
  boardSerial += 1;
  return `${prefix}-${boardSerial}`;
}

async function pointProviderAt(baseUrl) {
  const { providers } = await listProviders();
  const body = {
    id: FAKE_PROVIDER_ID,
    label: 'P2-G fake',
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

function installRunnerFactory() {
  lastEffector = null;
  setEffectorFactory((boardId) => {
    lastEffector = createRunnerEffector({
      boardId,
      cwd: sandbox,
      promptVariant: 'lite',
      limits: { maxTurns: 8, wallClockMs: 25_000 },
    });
    return lastEffector;
  });
}

async function startApi() {
  installRunnerFactory();
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

async function wipeSandboxFiles() {
  for (const rel of Object.keys(SANDBOX_FILES)) {
    await fsp.rm(path.join(sandbox, rel), { force: true });
  }
}

/**
 * @param {string} boardId
 * @param {string} markdown
 * @param {ReturnType<typeof happyScenario>} scenario
 * @param {object} [extra]
 */
async function openMemoryBoard(boardId, markdown, extra = {}) {
  const parsed = parsePlan(markdown);
  assert.equal(isParseErrors(parsed), false, JSON.stringify(parsed));
  const journal = createMemoryJournal();
  await journal.createBoard(boardId);
  await journal.appendEvent(
    boardId,
    makeEvent('board.created', {
      boardId,
      planPath: extra.planPath ?? 'mini.md',
      name: parsed.name,
      tasks: parsed.tasks,
      waves: parsed.waves,
    }),
  );
  return journal;
}

function makeMiniEffector(opts) {
  const completionsUrl = opts.completionsUrl;
  return createRunnerEffector({
    boardId: opts.boardId,
    journal: opts.journal,
    getState: opts.getState,
    model: MODEL,
    cwd: sandbox,
    promptVariant: 'lite',
    limits: { maxTurns: 8, wallClockMs: 20_000 },
    postChatCompletions: (_provider, body, signal) =>
      postChatCompletionsHttp(
        {
          id: FAKE_PROVIDER_ID,
          baseUrl: typeof completionsUrl === 'string' ? completionsUrl : completionsUrl.current,
          apiKind: 'openai-v1',
          chatCompletionsPath: '/v1/chat/completions',
        },
        body,
        signal,
      ),
  });
}

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-p2g');
  await ensureMinnowLayout();
  sandbox = path.join(homeDir, 'p2g-sandbox');
  await fsp.mkdir(path.join(sandbox, 'src'), { recursive: true });
  await initWorkspaceRoot();
  await setWorkspaceRoot(sandbox);
  await bindAutopilotModel();
  fake.reset();
  const port = await fake.listen(0);
  fakeBase = `http://127.0.0.1:${port}`;
  await pointProviderAt(fakeBase);
});

beforeEach(async () => {
  fake.reset();
  await pointProviderAt(fakeBase);
  await wipeSandboxFiles();
  resetJournalCache();
  disposeEngines();
  deleteGenerationsForProviderShutdown();
});

afterEach(async () => {
  lastEffector = null;
  deleteGenerationsForProviderShutdown();
  await stopApi();
  resetJournalCache();
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

// ── P2-G renderer exclusion ──────────────────────────────────────────────────

describe('P2-G renderer exclusion', { concurrency: false }, () => {
  test('runs without a document or window', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');
  });

  test('this suite does not import a bundler or DOM adapter', () => {
    const source = fs.readFileSync(THIS_FILE, 'utf8');
    assert.equal(/^\s*import\s+.+['"]happy-dom['"]/m.test(source), false);
    assert.equal(/^\s*import\s+.+['"]vite['"]/m.test(source), false);
  });
});

// ── P2-G fixture plan ────────────────────────────────────────────────────────

describe('P2-G fixture plan', { concurrency: false }, () => {
  test('parsePlan accepts the standing fixture', () => {
    const graph = parsePlan(P2G_PLAN);
    assert.equal(isParseErrors(graph), false, JSON.stringify(graph, null, 2));
    assert.deepEqual(graph.tasks.map((t) => t.id), ['W1-A', 'W1-B', 'W2-A']);
    assert.deepEqual(graph.tasks[2].dependsOn, ['W1-A', 'W1-B']);
  });

  test('fake host classifies V2 builder and tester seeds', () => {
    const builder = extractRequestContext({
      messages: [
        { role: 'system', content: '**Builder.** Implement one task precisely.' },
        { role: 'user', content: '# Task W1-A — Add greet\n\n## Build\nCreate src/greet.js\n' },
      ],
    });
    assert.equal(builder.role, 'builder');
    assert.equal(builder.taskId, 'W1-A');

    const tester = extractRequestContext({
      messages: [
        { role: 'system', content: '**Tester.** Verify Builder output against the Test spec.' },
        { role: 'user', content: '# Task W1-B — Add add\n\n## Test\nexports add\n' },
      ],
    });
    assert.equal(tester.role, 'tester');
    assert.equal(tester.taskId, 'W1-B');
  });
});

// ── P2-G HTTP board ──────────────────────────────────────────────────────────

describe('P2-G HTTP board (UI closed)', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi();
  });

  test('fixture completes at concurrency 1 with files on disk', { timeout: 60_000 }, async () => {
    const boardId = nextBoardId('http');
    await createHttpBoard(P2G_PLAN, boardId);
    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const state = await waitUntilFinished(boardId);
    assert.equal(state.finished, true);
    assert.equal(state.stopReason, 'complete');
    for (const id of ['W1-A', 'W1-B', 'W2-A']) {
      assert.equal(state.tasks.get(id).phase, 'merged', `${id} should be merged`);
    }
    await assertSandboxFiles(sandbox);

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    const types = journal.body.events.map((event) => event.type);
    assert.ok(types.includes('task.attempt.started'));
    assert.ok(types.includes('task.attempt.ended'));
    assert.ok(types.includes('merge.succeeded'));
    assert.ok(types.includes('run.finished'));
    assert.equal(
      types.includes('board.git.initialized'),
      false,
      'P2-G explicit cwd must stay git-free',
    );
  });

  test('GET mid-run folds the same state the engine holds', { timeout: 60_000 }, async () => {
    const boardId = nextBoardId('fold');
    await createHttpBoard(P2G_PLAN, boardId);
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    await waitFor(async () => {
      const got = await call('GET', `/api/boards/${boardId}`);
      const tasks = stateFromJSON(got.body.state).tasks;
      return [...tasks.values()].some((task) => task.phase === 'building' || task.phase === 'testing');
    }, 20_000, 'an attempt to be in flight');

    const got = await call('GET', `/api/boards/${boardId}`);
    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    const fromJournal = derive(journal.body.events);
    assert.deepEqual(stateFromJSON(got.body.state), fromJournal);

    const state = await waitUntilFinished(boardId);
    assert.equal(state.finished, true);
    await assertSandboxFiles(sandbox);
  });

  test('new engine on the same journal mid-run still completes', { timeout: 90_000 }, async () => {
    const boardId = nextBoardId('reload');
    await createHttpBoard(P2G_PLAN, boardId);
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    await waitFor(() => lastEffector && lastEffector.inspect().length === 1, 20_000, 'first attempt live');

    lastEffector.vanishAll();
    assert.equal(lastEffector.inspect().length, 0);
    disposeEngines();
    cancelOrphanedRunnerGenerations();
    fake.reset();

    const restarted = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body));

    const state = await waitUntilFinished(boardId);
    assert.equal(state.finished, true);
    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    const crashed = journal.body.events.filter(
      (event) => event.type === 'task.attempt.ended' && event.outcome === 'crashed',
    );
    assert.ok(crashed.length >= 1, 'vanished attempt must be reaped as crashed');
    await assertSandboxFiles(sandbox);
  });
});

// ── P2-G induced failures ────────────────────────────────────────────────────

describe('P2-G induced failures', { concurrency: false }, () => {
  /**
   * @param {string} boardId
   * @param {ReturnType<typeof failingBuildScenario>} scenario
   */
  async function runMini(boardId, scenario) {
    const dedicated = createFakeModelServer({ scenario });
    dedicated.reset();
    const port = await dedicated.listen(0);
    const completionsUrl = `http://127.0.0.1:${port}`;

    const journal = await openMemoryBoard(boardId, MINI_PLAN);
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeMiniEffector({
      boardId,
      journal,
      getState: () => box.engine.getState(),
      completionsUrl,
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 50 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      try {
        await waitFor(() => engine.getState().finished === true, 25_000, `${boardId} mini finish`);
      } catch (err) {
        const events = journal.readEventsSync(boardId);
        const types = events.map((event) => `${event.type}:${event.outcome ?? event.role ?? ''}`).join(', ');
        throw new Error(`${err instanceof Error ? err.message : err}\njournal: ${types}\nstarted: ${JSON.stringify(effector.started)}`);
      }
      return { engine, effector, journal, state: engine.getState() };
    } finally {
      engine.dispose();
      if (typeof dedicated.server.closeAllConnections === 'function') {
        dedicated.server.closeAllConnections();
      }
      await dedicated.close();
    }
  }

  test('failing build retries with a failure-aware seed', { timeout: 45_000 }, async () => {
    const { effector, state } = await runMini(nextBoardId('fail-build'), failingBuildScenario());
    assert.equal(state.tasks.get('W1-A').phase, 'merged');
    const builderStarts = effector.started.filter((row) => row.role === 'builder');
    assert.ok(builderStarts.length >= 2, 'builder must retry');
    assert.equal(builderStarts[1].seedKind, 'failure-aware');
    const body = await fsp.readFile(path.join(sandbox, 'src/mini.js'), 'utf8');
    assert.match(body, /export function ok/);
  });

  test('failing test retries the builder with a fix seed', { timeout: 45_000 }, async () => {
    const { effector, state } = await runMini(nextBoardId('fail-test'), failingTestScenario());
    assert.equal(state.tasks.get('W1-A').phase, 'merged');
    const builderStarts = effector.started.filter((row) => row.role === 'builder');
    assert.ok(builderStarts.some((row) => row.seedKind === 'fix'), 'fix seed after tester fail');
  });

  test('blocked report retries with a repair seed', { timeout: 45_000 }, async () => {
    const { effector, state } = await runMini(nextBoardId('blocked'), blockedScenario());
    assert.equal(state.tasks.get('W1-A').phase, 'merged');
    const builderStarts = effector.started.filter((row) => row.role === 'builder');
    assert.ok(builderStarts.some((row) => row.seedKind === 'repair'), 'repair seed after blocked');
  });

  test('killed model host → crashed then retry with continue seed', { timeout: 60_000 }, async () => {
    const completionsUrl = { current: '' };
    /** @type {((err: Error) => void) | null} */
    let explode = null;
    let firstCall = true;
    let deadCalls = 0;

    const boardId = nextBoardId('crash');
    const journal = await openMemoryBoard(boardId, MINI_PLAN);
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = createRunnerEffector({
      boardId,
      journal,
      getState: () => box.engine.getState(),
      model: MODEL,
      cwd: sandbox,
      promptVariant: 'lite',
      limits: { maxTurns: 8, wallClockMs: 20_000 },
      postChatCompletions: (_provider, body, signal) => {
        if (firstCall) {
          firstCall = false;
          deadCalls += 1;
          return new Promise((_, reject) => {
            explode = (err) => reject(err);
            signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
        }
        // The runner replays a dropped connection before giving up. Keep
        // dropping until its budget is spent, otherwise the host is not dead
        // and the board never sees the crash it is meant to recover from.
        if (deadCalls < TRANSIENT_ATTEMPTS) {
          deadCalls += 1;
          return Promise.reject(new Error('ECONNRESET: model host killed'));
        }
        return postChatCompletionsHttp(
          {
            id: FAKE_PROVIDER_ID,
            baseUrl: completionsUrl.current,
            apiKind: 'openai-v1',
            chatCompletionsPath: '/v1/chat/completions',
          },
          body,
          signal,
        );
      },
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 50 });
    box.engine = engine;
    await engine.load();
    /** @type {ReturnType<typeof createFakeModelServer> | null} */
    let recovery = null;
    try {
      await engine.startBoard(1);
      await waitFor(() => effector.inspect().length === 1 && explode, 15_000, 'hung attempt');

      recovery = createFakeModelServer({ scenario: afterCrashScenario() });
      recovery.reset();
      const port = await recovery.listen(0);
      completionsUrl.current = `http://127.0.0.1:${port}`;
      explode(new Error('ECONNRESET: model host killed'));

      await waitFor(() => engine.getState().finished === true, 25_000, 'crash recovery finish');
      const state = engine.getState();
      assert.equal(state.tasks.get('W1-A').phase, 'merged');
      const events = journal.readEventsSync(boardId);
      const ended = events
        .filter((event) => event.type === 'task.attempt.ended')
        .map((event) => event.outcome);
      assert.ok(ended.includes('crashed'), `expected crashed, got ${ended.join(',')}`);
      const builderStarts = effector.started.filter((row) => row.role === 'builder');
      assert.ok(builderStarts.some((row) => row.seedKind === 'continue'), 'continue seed after crash');
    } finally {
      engine.dispose();
      if (recovery) {
        if (typeof recovery.server.closeAllConnections === 'function') {
          recovery.server.closeAllConnections();
        }
        await recovery.close().catch(() => {});
      }
    }
  });
});

// ── P2-G reliability ─────────────────────────────────────────────────────────

describe('P2-G reliability (10-run)', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi();
  });

  test('fixture completes 10 times; numbers are the Phase 3 baseline', { timeout: 180_000 }, async () => {
    const RUNS = 10;
    /** @type {Array<Record<string, unknown>>} */
    const perRun = [];
    let completed = 0;
    let retries = 0;
    let abandonments = 0;

    for (let n = 1; n <= RUNS; n += 1) {
      fake.reset();
      await wipeSandboxFiles();
      const boardId = nextBoardId(`rel${n}`);
      const t0 = Date.now();
      let finished = false;
      let merged = 0;
      let runRetries = 0;
      let runAbandoned = 0;
      try {
        await createHttpBoard(P2G_PLAN, boardId);
        const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
        assert.equal(started.status, 200, `run ${n} start: ${JSON.stringify(started.body)}`);
        const state = await waitUntilFinished(boardId, 40_000);
        finished = state.finished === true;
        merged = [...state.tasks.values()].filter((task) => task.phase === 'merged').length;
        const journal = await call('GET', `/api/boards/${boardId}/journal`);
        const stats = reliabilityFromEvents(journal.body.events);
        runRetries = stats.retries;
        runAbandoned = stats.abandonments;
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
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
        retries += runRetries;
        abandonments += runAbandoned;
        continue;
      }
      retries += runRetries;
      abandonments += runAbandoned;
      perRun.push({
        n,
        finished,
        merged,
        retries: runRetries,
        abandoned: runAbandoned,
        ms: Date.now() - t0,
      });
    }

    const report = {
      runs: RUNS,
      completed,
      failed: RUNS - completed,
      retries,
      abandonments,
      perRun,
      recordedAt: '2026-08-29',
      host: 'scripts/fake-model-server.mjs',
      note: 'Deterministic fake host emitting save_file then report_outcome. Phase 3 is measured against this baseline.',
    };
    await fsp.writeFile(P2G_RELIABILITY_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const table = perRun
      .map(
        (row) =>
          `  run ${String(row.n).padStart(2)}  finished=${row.finished}  merged=${row.merged}  retries=${row.retries}  abandoned=${row.abandoned}  ${row.ms}ms`,
      )
      .join('\n');
    console.log(`P2-G reliability\n${table}\n  completed ${completed}/${RUNS}  retries ${retries}  abandonments ${abandonments}`);

    assert.equal(completed, RUNS, `expected ${RUNS} completions, got ${completed}`);
    assert.equal(abandonments, 0);
  });
});
