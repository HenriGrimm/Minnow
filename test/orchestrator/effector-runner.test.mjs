import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import {
  createFakeModelServer,
  proseSseChunks,
} from '../../scripts/fake-model-server.mjs';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { createProvider, updateProvider, listProviders } from '../../server/providers/store.js';
import {
  createMemoryTranscriptStore,
  postChatCompletionsInProcess,
  runHeadlessToolBatchStub,
  runTurn,
} from '../../server/runner/node.js';
import {
  deleteGenerationsForProviderShutdown,
  listGenerationStates,
} from '../../server/generations/store.js';
import { boardGraph } from '../../server/orchestrator/board-graph.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { createEngine, disposeEngines } from '../../server/orchestrator/engine.js';
import {
  cancelOrphanedRunnerGenerations,
  createRunnerEffector,
} from '../../server/orchestrator/effector-runner.js';
import { subscribeLive } from '../../server/orchestrator/live-events.js';
import {
  ATTEMPT_WALL_CLOCK_MS,
  attemptLimits,
  clampAttemptWallClockMs,
} from '../../server/orchestrator/attempt-limits.js';
import { REPORT_TOOL_NAME } from '../../server/orchestrator/report-tool.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { postChatCompletionsHttp } from '../../server/runner/adapters.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_JS = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'engine.js');
const EFFECTOR_JS = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'effector-runner.js');
const RUNNER_DIR = path.join(PROJECT_ROOT, 'server', 'runner');

const PROVIDER_ID = 'local-fake';
const MODEL_ID = 'fake-board-model';
const MODEL = { providerId: PROVIDER_ID, id: MODEL_ID };

const BUILDER_PASS = {
  outcome: 'pass',
  summary: 'Built the one-task fixture.',
  evidence: ['src/a.ts'],
  blockers: [],
  needs: [],
};
const TESTER_PASS = {
  outcome: 'pass',
  summary: 'Tests green.',
  evidence: ['npm test'],
  testOutput: 'ok',
};

/**
 * @param {string} name
 * @param {unknown} args
 * @param {string} [toolCallId]
 */
function functionCallChunks(name, args, toolCallId = 'call_report') {
  const argStr = typeof args === 'string' ? args : JSON.stringify(args);
  const delta = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: 'function',
              function: { name, arguments: argStr },
            },
          ],
        },
      },
    ],
  });
  const finish = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
  });
  return [
    `data: ${delta}\n\n`,
    `data: ${finish}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

function longThenReportChunks(payload) {
/** @type {string[]} */
  const chunks = [];
  for (let i = 0; i < 40; i += 1) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: `tok${i} ` } }] })}\n\n`);
  }
  chunks.push(...functionCallChunks(REPORT_TOOL_NAME, payload, 'call_after_tokens'));
  return chunks;
}

function stubDeps() {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: postChatCompletionsInProcess,
    runHeadlessToolBatch: runHeadlessToolBatchStub,
    resolveProvider: async () => ({
      id: PROVIDER_ID,
      label: 'P2-F fake',
      baseUrl: 'http://127.0.0.1:1',
      apiKind: 'openai-v1',
      chatCompletionsPath: '/v1/chat/completions',
    }),
    getSubAgentTypeConfig: async () => ({}),
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
    resolveThinkingMode: () => ({ mode: 'off' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {},
    getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => null,
    applyContextPolicy: async (input) => ({
      applied: false,
      messages: input.messages,
    }),
  };
}

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting');
}

function taskSpec(id = 'W1-A') {
  return {
    id,
    title: 'One task',
    wave: 1,
    dependsOn: [],
    touches: [`src/${id}/**`],
    build: 'build it',
    test: 'test it',
    accept: 'it works',
  };
}

/**
 * @param {string} boardId
 * @param {object} [extra]
 */
async function openBoard(boardId, extra = {}) {
  const journal = createMemoryJournal();
  await journal.createBoard(boardId);
  await journal.appendEvent(
    boardId,
    makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: extra.tasks ?? [taskSpec()],
      waves: [],
    }),
  );
  return journal;
}

/**
 * @param {{ boardId?: string, journal?: ReturnType<typeof createMemoryJournal>, limits?: object, runTurn?: Function, reapOrphans?: boolean }} [opts]
 */
function makeEffector(opts = {}) {
  const boardId = opts.boardId ?? 'p2f';
  return createRunnerEffector({
    boardId,
    journal: opts.journal,
    getState: opts.getState,
    model: MODEL,
    cwd: opts.cwd ?? os.tmpdir(),
    limits: opts.limits,
    promptVariant: 'lite',
    runTurn: opts.runTurn,
    deps: opts.deps ?? stubDeps(),
    reapOrphans: opts.reapOrphans,
  });
}

function createHangServer() {
/** @type {import('http').ServerResponse[]} */
  const open = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"choices":[{"delta":{"content":"hold"}}]}\n\n');
      open.push(res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return {
    server,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
      return `http://127.0.0.1:${port}`;
    },
    kill() {
      for (const res of open) {
        try {
          res.write('event: end\ndata: {"status":"error","errorMessage":"model host killed"}\n\n');
        } catch {
        }
        try {
          res.destroy();
        } catch {
        }
      }
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function pointProviderAt(baseUrl) {
  const { providers } = await listProviders();
  if (providers.some((row) => row.id === PROVIDER_ID)) {
    await updateProvider(PROVIDER_ID, { baseUrl, apiKind: 'openai-v1' });
    return;
  }
  await createProvider({
    id: PROVIDER_ID,
    label: 'P2-F fake',
    baseUrl,
    apiKind: 'openai-v1',
  });
}

function streamingCount() {
  return listGenerationStates().filter(
    (state) => state.status === 'pending' || state.status === 'streaming',
  ).length;
}

describe('P2-F source contract', () => {
  test('engine.js is untouched by this task', () => {
    const source = fs.readFileSync(ENGINE_JS, 'utf8');
    assert.equal(source.includes('effector-runner'), false);
    assert.equal(source.includes('createRunnerEffector'), false);
    assert.equal(source.includes('attempt-limits'), false);
  });

  test('runner package still does not import the orchestrator', () => {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const code = fs.readFileSync(full, 'utf8');
          assert.equal(
            code.includes('orchestrator/'),
            false,
            `${path.relative(RUNNER_DIR, full)} imported orchestrator`,
          );
        }
      }
    };
    walk(RUNNER_DIR);
  });

  test('attemptLimits stays uncapped; board wall clock comes from Settings (240 min default)', () => {
    const defaults = attemptLimits();
    assert.equal(defaults.wallClockMs, undefined);
    assert.equal(defaults.maxTurns, undefined);
    assert.equal(attemptLimits({ wallClockMs: 1000 }).wallClockMs, 1000);
    assert.equal(ATTEMPT_WALL_CLOCK_MS, 240 * 60 * 1000);
    assert.equal(clampAttemptWallClockMs(undefined), ATTEMPT_WALL_CLOCK_MS);
    assert.equal(clampAttemptWallClockMs('junk'), ATTEMPT_WALL_CLOCK_MS);
    assert.equal(clampAttemptWallClockMs(0), 0);
    assert.equal(clampAttemptWallClockMs(-5), 0);
    assert.equal(clampAttemptWallClockMs(1000), 5 * 60 * 1000);
    assert.equal(clampAttemptWallClockMs(90 * 60 * 1000), 90 * 60 * 1000);
    assert.equal(clampAttemptWallClockMs(48 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);
    const source = fs.readFileSync(EFFECTOR_JS, 'utf8');
    assert.match(source, /attemptLimits/);
  });

  test('P6-B: unattended runTurn passes ask: null', () => {
    const source = fs.readFileSync(EFFECTOR_JS, 'utf8');
    assert.match(source, /ask:\s*null/);
    assert.equal(/\bisBoard\b/.test(source), false);
  });
});

describe('runner effector', { concurrency: false }, () => {
  const fake = createFakeModelServer({
    scenario: [
      { match: { nth: 0 }, emit: functionCallChunks(REPORT_TOOL_NAME, BUILDER_PASS) },
      { match: { nth: 1 }, emit: functionCallChunks(REPORT_TOOL_NAME, TESTER_PASS) },
    ],
  });
/** @type {string} */
  let homeDir = '';
/** @type {string} */
  let cwd = '';
/** @type {string} */
  let fakeBase = '';

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-p2f-effector');
    await ensureMinnowLayout();
    cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p2f-cwd-'));
    fake.reset();
    const port = await fake.listen(0);
    fakeBase = `http://127.0.0.1:${port}`;
    await pointProviderAt(fakeBase);
  });

  async function restoreFake() {
    if (fakeBase) await pointProviderAt(fakeBase);
  }

  afterEach(async () => {
    deleteGenerationsForProviderShutdown();
    disposeEngines();
    await restoreFake();
  });

  after(async () => {
    deleteGenerationsForProviderShutdown();
    disposeEngines();
    await fake.close();
    await rmTestHome(homeDir);
    resetMinnowHomeCache();
  });

  test('pause/resume keeps attempt identity; Stop still replaces it on Start', { timeout: 10000 }, async () => {
    const boardId = 'pause-identity';
    const journal = await openBoard(boardId);
    let turn;
    const effector = makeEffector({ boardId, journal, cwd, runTurn: async opts => {
      turn = opts;
      if (!opts.signal.aborted) await new Promise(resolve => opts.signal.addEventListener('abort', resolve, { once: true }));
      return { outcome: 'crashed', error: 'aborted' };
    } });
    const engine = createEngine({ boardId, effector, journal, graph: { ...boardGraph, writeReport: undefined } });
    await engine.load();
    try {
      await engine.startBoard(1);
      await waitFor(() => Boolean(turn));
      const first = effector.inspect()[0].attemptId;
      assert.equal(await engine.pauseBoard(), true);
      assert.equal(turn.pauseGate.paused, true);
      await engine.tick();
      assert.equal(engine.getState().stopReason, 'paused');
      assert.equal((await journal.loadState(boardId)).stopReason, 'paused');
      assert.equal(effector.inspect()[0].attemptId, first);
      assert.equal(engine.getState().tasks.get('W1-A').attempts[0].ended, false);
      assert.equal(await engine.startTask('W1-A'), false);
      await engine.startBoard(1);
      assert.equal(turn.pauseGate.paused, false);
      assert.equal(effector.inspect()[0].attemptId, first);
      assert.equal(effector.started.length, 1);
      await engine.pauseBoard();
      const signal = turn.signal;
      await engine.stopBoard();
      assert.equal(signal.aborted, true);
      assert.equal(effector.inspect().length, 0);
      await engine.startBoard(1);
      assert.notEqual(effector.inspect()[0].attemptId, first);
    } finally { engine.dispose(); }
  });

  test('a paused board stays idle after process recovery until explicit Resume', { timeout: 10000 }, async () => {
    const boardId = 'pause-recovery';
    const journal = await openBoard(boardId);
    const make = () => makeEffector({ boardId, journal, cwd, runTurn: async opts => {
      if (!opts.signal.aborted) await new Promise(resolve => opts.signal.addEventListener('abort', resolve, { once: true }));
      return { outcome: 'crashed', error: 'aborted' };
    } });
    const first = createEngine({ boardId, journal, effector: make() });
    await first.load();
    await first.startBoard(1);
    await first.pauseBoard();
    first.dispose();
    const effector = make();
    const recovered = createEngine({ boardId, journal, effector });
    try {
      await recovered.load();
      await recovered.tick();
      assert.equal(recovered.getState().stopReason, 'paused');
      assert.equal(effector.started.length, 0);
      await recovered.startBoard(1);
      assert.equal(effector.started.length, 1);
      assert.equal(effector.started[0].seedKind, 'continue');
    } finally { first.dispose(); recovered.dispose(); }
  });

  test('engine drives builder → tester with no engine.js changes', { timeout: 30_000 }, async () => {
    fake.reset();
    const boardId = 'p2f-e2e';
    const journal = await openBoard(boardId);
    const live = [];
    const unsubLive = subscribeLive(boardId, (payload) => live.push(payload));
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      await waitFor(() => engine.getState().finished === true, 25_000);

      const state = engine.getState();
      assert.equal(state.tasks.get('W1-A').phase, 'merged');
      const roles = effector.started.map((row) => row.role);
      assert.ok(roles.includes('builder'), 'builder ran');
      assert.ok(roles.includes('tester'), 'tester ran');
      const events = await journal.readEvents(boardId);
      const types = events.map((event) => event.type);
      assert.ok(types.includes('task.attempt.started'));
      assert.ok(types.includes('task.attempt.ended'));
      const ended = events.filter((event) => event.type === 'task.attempt.ended');
      assert.equal(ended[0].role, 'builder');
      assert.equal(ended[0].outcome, 'pass');
      assert.equal(ended[1].role, 'tester');
      assert.equal(ended[1].outcome, 'pass');
      assert.ok(
        live.some((row) => row.event?.type === 'tool_call'),
        'live bus saw tool calls',
      );
      // Rounds open with a thinking frame, so a card never keeps naming a
      // finished tool while the model processes the next prompt.
      for (const attemptId of new Set(live.map((row) => row.attemptId))) {
        const frames = live.filter((row) => row.attemptId === attemptId).map((row) => row.event);
        const opened = frames.findIndex((e) => e?.type === 'phase' && e.phase === 'thinking');
        const called = frames.findIndex((e) => e?.type === 'tool_call');
        assert.ok(opened !== -1 && opened < called, `round opened live before tool call for ${attemptId}`);
      }
      assert.equal(
        events.some((event) => event.type === 'delta' || event.type === 'live'),
        false,
        'tokens must never become journal lines',
      );
    } finally {
      unsubLive();
      engine.dispose();
    }
  });

  test('final ladder skips browser verification for boards', async () => {
    const boardId = 'p2f-final-no-browser';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    let seenInput = null;
    const effector = createRunnerEffector({
      boardId,
      journal,
      getState: () => state,
      model: MODEL,
      cwd,
      runFinalLadder: async (input) => {
        seenInput = input;
        return { outcome: 'pass', runInstructions: '', summary: 'Static checks passed.', evidence: {} };
      },
    });
    let ended = false;
    effector.onEnd(() => { ended = true; });
    await effector.start({ taskId: null, role: 'final', seedKind: 'initial' });
    await waitFor(() => ended);
    assert.equal(seenInput.browser, false);
  });

  test('inspect stays populated until onEnd resolves', { timeout: 20_000 }, async () => {
    fake.reset();
    const boardId = 'p2f-inspect';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    const effector = makeEffector({ boardId, journal, cwd, getState: () => state });

    let entered = false;
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    effector.onEnd(async () => {
      entered = true;
      await hold;
    });

    const { attemptId } = await effector.start({
      taskId: 'W1-A',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    });
    await waitFor(() => entered);
    assert.deepEqual(
      effector.inspect().map((row) => row.attemptId),
      [attemptId],
      'attempt must remain in inspect() while onEnd is in flight',
    );
    release();
    await waitFor(() => effector.inspect().length === 0);
  });

  test('a rejected completion listener does not become an unhandled rejection or strand the slot', async () => {
    const boardId = 'listener-failure';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    const effector = makeEffector({ boardId, journal, cwd, getState: () => state,
      runTurn: async () => BUILDER_PASS });
    let called = false;
    effector.onEnd(async () => { called = true; throw new Error('temporary journal failure'); });
    await effector.start({ taskId: 'W1-A', role: 'builder', seedKind: 'initial', sameWorktree: false });
    await waitFor(() => called && effector.inspect().length === 0);
  });

  test('completed attempts carry model round speed without tool wall time', async () => {
    const boardId = 'p2f-round-speed';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    const effector = makeEffector({ boardId, journal, cwd, getState: () => state,
      runTurn: async (options) => {
        options.onEvent({ type: 'round_end', index: 0, text: '', reasoning: '', toolCallCount: 0,
          usage: { prompt_tokens: 20, completion_tokens: 10 },
          stats: { tokens_per_second: 10, generation_time: 1 }, t0: 0, tFirst: 100, tEnd: 1100 });
        options.onEvent({ type: 'round_end', index: 1, text: '', reasoning: '', toolCallCount: 0,
          usage: { prompt_tokens: 30, completion_tokens: 20 },
          stats: { tokens_per_second: 20, generation_time: 1 }, t0: 5000, tFirst: 5100, tEnd: 6100 });
        return { ...BUILDER_PASS, usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } };
      } });
    let end = null;
    effector.onEnd((payload) => { end = payload; });
    await effector.start({ taskId: 'W1-A', role: 'builder', seedKind: 'initial', sameWorktree: false });
    await waitFor(() => end !== null);
    assert.deepEqual(end.speed, { tokens: 30, seconds: 2 });
    assert.deepEqual(end.usage, { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 });
  });

  test('kill the model host mid-turn → crashed', { timeout: 20_000 }, async () => {
    const boardId = 'p2f-crash';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
/** @type {((err: Error) => void) | null} */
    let explode = null;
    const deps = stubDeps();
    let calls = 0;
    deps.postChatCompletions = (_provider, _body, signal) =>
      new Promise((_, reject) => {
        calls += 1;
        // The first call hangs so the test can observe a live attempt. The
        // runner replays a dropped connection, so every replay has to drop too
        // or the host is not actually dead.
        if (calls > 1) {
          reject(new Error('ECONNRESET: model host killed'));
          return;
        }
        explode = (err) => reject(err);
        signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      });
    const effector = makeEffector({ boardId, journal, cwd, getState: () => state, deps });
/** @type {import('../../server/orchestrator/engine.js').AttemptEnd | null} */
    let end = null;
    effector.onEnd((payload) => {
      end = payload;
    });
    await effector.start({
      taskId: 'W1-A',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    });
    await waitFor(() => effector.inspect().length === 1);
    await waitFor(() => explode !== null);
    explode(new Error('ECONNRESET: model host killed'));
    await waitFor(() => end !== null);
    assert.equal(end.outcome, 'crashed');
    assert.match(String(end.summary ?? ''), /model host killed|ECONNRESET/);
  });

  test('1-second wall clock → timeout', { timeout: 15_000 }, async () => {
    const hang = createHangServer();
    const url = await hang.listen();
    await pointProviderAt(url);
    const boardId = 'p2f-timeout';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    const effector = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => state,
      limits: { wallClockMs: 1000, maxTurns: 40 },
    });
/** @type {string | null} */
    let outcome = null;
    effector.onEnd((payload) => {
      outcome = payload.outcome;
    });
    await effector.start({
      taskId: 'W1-A',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    });
    await waitFor(() => outcome !== null, 8_000);
    assert.equal(outcome, 'timeout');
    hang.kill();
    await hang.close().catch(() => {});
    await restoreFake();
  });

  test('fake model never calls report tool → no_report', { timeout: 20_000 }, async () => {
    const silent = createFakeModelServer({
      scenario: [{ emit: proseSseChunks('I finished but I will not call the tool.') }],
    });
    silent.reset();
    const port = await silent.listen(0);
    await pointProviderAt(`http://127.0.0.1:${port}`);
    const boardId = 'p2f-noreport';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    const effector = makeEffector({ boardId, journal, cwd, getState: () => state });
/** @type {string | null} */
    let outcome = null;
    effector.onEnd((payload) => {
      outcome = payload.outcome;
    });
    await effector.start({
      taskId: 'W1-A',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    });
    await waitFor(() => outcome !== null);
    assert.equal(outcome, 'no_report');
    await silent.close();
    await restoreFake();
  });

  test('stop() mid-turn cancels generation; no orphaned upstream', { timeout: 20_000 }, async () => {
    const hang = createHangServer();
    const url = await hang.listen();
    await pointProviderAt(url);
    const boardId = 'p2f-stop';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    const effector = makeEffector({ boardId, journal, cwd, getState: () => state });
    const { attemptId } = await effector.start({
      taskId: 'W1-A',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    });
    await waitFor(() => streamingCount() >= 1 || effector.inspect().length === 1);
    await effector.stop(attemptId);
    assert.equal(effector.inspect().length, 0);
    await waitFor(() => streamingCount() === 0);
    hang.kill();
    await hang.close().catch(() => {});
    await restoreFake();
  });

  test('restart with a live attempt: inspect empty, one restart, zero orphans', { timeout: 25_000 }, async () => {
    const hang = createHangServer();
    const url = await hang.listen();
    await pointProviderAt(url);
    const boardId = 'p2f-restart';
    const journal = await openBoard(boardId);
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const first = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
    });
    const engineA = createEngine({ boardId, effector: first, journal, tickMs: 100_000 });
    box.engine = engineA;
    await engineA.load();
    await engineA.startBoard(1);
    await waitFor(() => first.inspect().length === 1);
    await waitFor(() => streamingCount() >= 1);
    assert.ok(streamingCount() >= 1, 'expected a live generation before the crash');

    first.vanishAll();
    assert.equal(first.inspect().length, 0);
    engineA.dispose();

    const second = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
      reapOrphans: true,
    });
    assert.equal(second.inspect().length, 0, 'inspect is empty at boot');
    assert.equal(streamingCount(), 0, 'orphaned generations must be cancelled');

    const engineB = createEngine({ boardId, effector: second, journal, tickMs: 100_000 });
    box.engine = engineB;
    await engineB.load();
    await engineB.tick();
    await waitFor(() => second.started.length === 1);
    assert.equal(second.started.length, 1, 'exactly one restarted attempt');
    assert.equal(second.started[0].role, 'builder');

    for (const row of second.inspect()) await second.stop(row.attemptId);
    engineB.dispose();
    hang.kill();
    await hang.close().catch(() => {});
    await restoreFake();
  });

  test('journal line count for a long turn is bounded by outcomes, not tokens', { timeout: 20_000 }, async () => {
    const longFake = createFakeModelServer({
      scenario: [{ emit: longThenReportChunks(BUILDER_PASS) }],
    });
    longFake.reset();
    const port = await longFake.listen(0);
    await pointProviderAt(`http://127.0.0.1:${port}`);
    const boardId = 'p2f-journal';
    const journal = await openBoard(boardId);
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      await waitFor(() => {
        const events = journal.readEventsSync(boardId);
        return events.some((event) => event.type === 'task.attempt.ended');
      });
      const events = journal.readEventsSync(boardId);
      const ended = events.filter((event) => event.type === 'task.attempt.ended');
      assert.ok(ended.length >= 1);
      for (const event of events) {
        assert.notEqual(event.type, 'delta');
        assert.notEqual(event.type, 'token');
        assert.equal(typeof event.text, 'undefined');
      }
      const attemptLines = events.filter(
        (event) => event.type === 'task.attempt.started' || event.type === 'task.attempt.ended',
      );
      assert.ok(
        attemptLines.length <= 8,
        `attempt journal lines should be outcome-bounded, got ${attemptLines.length}`,
      );
    } finally {
      engine.dispose();
      await longFake.close();
      await restoreFake();
    }
  });

  test('P6-B: start() passes board tool options to runTurn', { timeout: 20_000 }, async () => {
    const boardId = 'p2f-ask-null';
    const journal = await openBoard(boardId);
/** @type {unknown[]} */
    const seenAsk = [];
/** @type {boolean[]} */
    const seenFinalize = [];
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
      runTurn: async (options) => {
        for (const [name, required] of [['read_file', 'path'], ['grep', 'pattern'], ['execute_command', 'command']]) {
          const tool = options.tools.find(tool => tool.function.name === name);
          assert.ok(tool?.function.parameters.required?.includes(required), name + ' must supply its required arguments');
        }
        seenAsk.push(options.ask);
        seenFinalize.push(options.finalizeStructuredOutcome);
        assert.deepEqual(options.alwaysLoadedToolNames, [
          'mcp__context7__resolve_library_id',
          'mcp__context7__query_docs',
        ]);
        return { outcome: 'pass', summary: 'ok', evidence: [] };
      },
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      await waitFor(() => seenAsk.length >= 1, 10_000);
      assert.equal(seenAsk[0], null);
      assert.equal(seenFinalize[0], false);
    } finally {
      engine.dispose();
    }
  });

  test('builder runTurn receives Settings sampler max tokens, not the 2048 fallback', { timeout: 20_000 }, async () => {
    const meta = (await readConfigJson('config.json')) ?? {};
    await writeConfigJson('config.json', {
      ...meta,
      sampler: { ...(meta.sampler && typeof meta.sampler === 'object' ? meta.sampler : {}), maxTokens: 131072 },
    });
    const boardId = 'p2f-sampler-max';
    const journal = await openBoard(boardId);
    /** @type {import('../../server/runner/run-turn').RunTurnOptions[]} */
    const seen = [];
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
      runTurn: async (options) => {
        seen.push(options);
        return { outcome: 'pass', summary: 'ok', evidence: [] };
      },
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      await waitFor(() => seen.length >= 1, 10_000);
      assert.equal(seen[0]?.model?.sampler?.maxTokens, 131072);
      assert.ok(seen[0]?.model?.sampler?.preset, 'sampler must be { preset, maxTokens }, not a flat row');
    } finally {
      engine.dispose();
      await writeConfigJson('config.json', meta);
    }
  });

  test('builder attempt gets the Settings attempt wall clock (default, override, off)', { timeout: 30_000 }, async () => {
    const meta = (await readConfigJson('config.json')) ?? {};
    const autopilot = meta.autopilot && typeof meta.autopilot === 'object' ? meta.autopilot : {};
    /** @param {unknown} attemptWallClockMs */
    const wallClockFor = async (attemptWallClockMs) => {
      const nextAutopilot = { ...autopilot };
      if (attemptWallClockMs === undefined) delete nextAutopilot.attemptWallClockMs;
      else nextAutopilot.attemptWallClockMs = attemptWallClockMs;
      await writeConfigJson('config.json', { ...meta, autopilot: nextAutopilot });
      const boardId = `p2f-wallclock-${String(attemptWallClockMs)}`;
      const journal = await openBoard(boardId);
      /** @type {import('../../server/runner/run-turn').RunTurnOptions[]} */
      const seen = [];
      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      const effector = makeEffector({
        boardId,
        journal,
        cwd,
        getState: () => box.engine.getState(),
        runTurn: async (options) => {
          seen.push(options);
          return { outcome: 'pass', summary: 'ok', evidence: [] };
        },
      });
      const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
      box.engine = engine;
      await engine.load();
      try {
        await engine.startBoard(1);
        await waitFor(() => seen.length >= 1, 10_000);
        return seen[0]?.limits?.wallClockMs;
      } finally {
        engine.dispose();
      }
    };
    try {
      assert.equal(await wallClockFor(undefined), ATTEMPT_WALL_CLOCK_MS);
      assert.equal(await wallClockFor(30 * 60 * 1000), 30 * 60 * 1000);
      assert.equal(await wallClockFor(0), undefined);
    } finally {
      await writeConfigJson('config.json', meta);
    }
  });

  test('board with no reasoning picked follows the Settings thinking default', { timeout: 20_000 }, async () => {
    const meta = (await readConfigJson('config.json')) ?? {};
    const boardId = 'p2f-thinking-default';
    const journal = await openBoard(boardId);
    /** @type {import('../../server/runner/run-turn').RunTurnOptions[]} */
    const seen = [];
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
      runTurn: async (options) => {
        seen.push(options);
        return { outcome: 'pass', summary: 'ok', evidence: [] };
      },
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await writeConfigJson('config.json', { ...meta, thinking: { defaultMode: 'on' } });
      await engine.startBoard(1);
      await waitFor(() => seen.length >= 1, 10_000);
      assert.deepEqual(seen[0]?.model?.thinking, { mode: 'on' });
    } finally {
      engine.dispose();
      await writeConfigJson('config.json', meta);
    }
  });

  for (const nextEffort of ['high', 'minimal', 'xhigh', 'max']) {
    test(`live reasoning changes to ${nextEffort} preserve active attempts and apply to the next agent`, { timeout: 20_000 }, async () => {
      fake.reset();
      const boardId = 'live-reasoning';
      const journal = await openBoard(boardId);
      const deps = stubDeps();
      deps.postChatCompletions = postChatCompletionsHttp;
      const resolveProvider = deps.resolveProvider;
      deps.resolveProvider = async () => ({ ...await resolveProvider(), baseUrl: fakeBase });
      deps.resolveSendCapabilities = () => ({ reasoning: true, reasoningAllowedOptions: ['off', 'low', 'medium', 'high', 'minimal', 'xhigh', 'max'] });
      const seen = [];
      let finishBuilder;
      const builderDone = new Promise((resolve) => { finishBuilder = resolve; });
      const box = { engine: null };
      const effector = createRunnerEffector({
        boardId, journal, cwd, deps, promptVariant: 'lite',
        getState: () => box.engine.getState(),
        runTurn: async (options) => {
          seen.push({ options, effort: deps.transcriptStore.load(options.chatId)?.meta.reasoningEffort });
          if (seen.length === 1) await builderDone;
          return runTurn(options);
        },
      });
      const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
      box.engine = engine;
      await engine.load();
      try {
        await engine.setModel({ ...MODEL, reasoning: 'low' });
        await engine.startBoard(1);
        await waitFor(() => seen.length === 1, 10_000);
        assert.equal(seen[0].effort, 'low');
        await engine.setModel({ ...MODEL, reasoning: nextEffort });
        assert.equal(engine.getState().status, 'running');
        assert.equal(seen[0].options.signal.aborted, false);
        assert.equal(deps.transcriptStore.load(seen[0].options.chatId).meta.reasoningEffort, 'low');
        assert.equal(seen.length, 1);
        finishBuilder(BUILDER_PASS);
        await waitFor(() => seen.length >= 2, 10_000);
        assert.equal(seen[1].effort, nextEffort);
        assert.equal(seen[1].options.model.thinking.mode, 'on');
        await waitFor(() => fake.requests.filter((row) => row.method === 'POST').length >= 2, 10_000);
        const requests = fake.requests.filter((row) => row.method === 'POST');
        await waitFor(() => effector.inspect().length === 0, 10_000);
        assert.equal(requests[0].body.reasoning_effort, 'low');
        assert.equal(requests[1].body.reasoning_effort, nextEffort);
      } finally {
        finishBuilder(BUILDER_PASS);
        engine.dispose();
      }
    });
  }

  test('throw inside runTurn → crashed; engine keeps ticking', { timeout: 20_000 }, async () => {
    const boardId = 'p2f-throw';
    const journal = await openBoard(boardId);
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      boardId,
      journal,
      cwd,
      getState: () => box.engine.getState(),
      runTurn: async () => {
        throw new Error('injected boom');
      },
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      await waitFor(() => effector.started.length >= 2, 10_000);
      assert.ok(engine.getState(), 'engine still has state after the throw');
      const events = journal.readEventsSync(boardId);
      const crashed = events.filter(
        (event) => event.type === 'task.attempt.ended' && event.outcome === 'crashed',
      );
      assert.ok(crashed.length >= 1);
      assert.match(String(crashed[0].summary ?? ''), /injected boom/);
    } finally {
      engine.dispose();
    }
  });

  test('cancelOrphanedRunnerGenerations is exported for boot', () => {
    assert.equal(typeof cancelOrphanedRunnerGenerations, 'function');
  });
});
