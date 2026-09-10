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
} from '../../server/runner/node.js';
import {
  deleteGenerationsForProviderShutdown,
  listGenerationStates,
} from '../../server/generations/store.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { createEngine, disposeEngines } from '../../server/orchestrator/engine.js';
import {
  cancelOrphanedRunnerGenerations,
  createRunnerEffector,
} from '../../server/orchestrator/effector-runner.js';
import { subscribeLive } from '../../server/orchestrator/live-events.js';
import { ATTEMPT_WALL_CLOCK_MS, attemptLimits } from '../../server/orchestrator/attempt-limits.js';
import { REPORT_TOOL_NAME } from '../../server/orchestrator/report-tool.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';

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

  test('limits live in one constants module', () => {
    assert.equal(ATTEMPT_WALL_CLOCK_MS, 120 * 60 * 1000);
    const defaults = attemptLimits();
    assert.equal(defaults.wallClockMs, ATTEMPT_WALL_CLOCK_MS);
    assert.equal(defaults.maxTurns, undefined);
    const source = fs.readFileSync(EFFECTOR_JS, 'utf8');
    assert.equal(source.includes('30 * 60 * 1000'), false);
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

  test('kill the model host mid-turn → crashed', { timeout: 20_000 }, async () => {
    const boardId = 'p2f-crash';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
/** @type {((err: Error) => void) | null} */
    let explode = null;
    const deps = stubDeps();
    deps.postChatCompletions = (_provider, _body, signal) =>
      new Promise((_, reject) => {
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

  test('P6-B: start() injects ask: null on the real runTurn options', { timeout: 20_000 }, async () => {
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
