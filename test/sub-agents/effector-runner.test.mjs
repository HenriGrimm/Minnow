import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';

import {
  createFakeModelServer,
  proseSseChunks,
} from '../../scripts/fake-model-server.mjs';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { createProvider, updateProvider, listProviders } from '../../server/providers/store.js';
import {
  createMemoryTranscriptStore,
  postChatCompletionsInProcess,
  runHeadlessToolBatchStub,
} from '../../server/runner/node.js';
import { ASK_QUESTION_TOOL_NAME, DEFAULT_REPORT_TOOL_NAME } from '../../server/runner/run-turn.js';
import { DEFAULT_HEADLESS_TOOL_IDS, browserToolsIn } from '../../server/runner/tool-set.js';
import {
  deleteGenerationsForProviderShutdown,
  listGenerationStates,
} from '../../server/generations/store.js';
import { createEngine, disposeEngines, getEngine } from '../../server/orchestrator/engine.js';
import { subscribeLive } from '../../server/orchestrator/live-events.js';
import { attemptLimits } from '../../server/orchestrator/attempt-limits.js';
import { derive } from '../../server/sub-agents/derive.js';
import { makeEvent, SUB_AGENT_ROLE, validateEvent } from '../../server/sub-agents/events.js';
import { createSubAgentGraph, subAgentGraph } from '../../server/sub-agents/graph.js';
import { AGENTS_NAMESPACE } from '../../server/sub-agents/derive.js';
import {
  cancelOrphanedSubAgentGenerations,
  createSubAgentEffector,
  degradeNoReportIfProse,
  resolveSubAgentToolIds,
} from '../../server/sub-agents/effector-runner.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_JS = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'engine.js');
const EFFECTOR_JS = path.join(PROJECT_ROOT, 'server', 'sub-agents', 'effector-runner.js');
const RUNNER_DIR = path.join(PROJECT_ROOT, 'server', 'runner');

const PROVIDER_ID = 'local-fake';
const MODEL_ID = 'fake-board-model';
const MODEL = { providerId: PROVIDER_ID, id: MODEL_ID };

const VERDICT_PASS = {
  outcome: 'pass',
  summary: 'Explored the workspace.',
  evidence: ['src/a.ts'],
  blockers: [],
  needs: [],
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
  chunks.push(...functionCallChunks(DEFAULT_REPORT_TOOL_NAME, payload, 'call_after_tokens'));
  return chunks;
}

function stubDeps() {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: postChatCompletionsInProcess,
    runHeadlessToolBatch: runHeadlessToolBatchStub,
    resolveProvider: async () => ({
      id: PROVIDER_ID,
      label: 'P8-D fake',
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

/**
 * @returns {{
 */
function createMemoryAgentsJournal() {
/** @type {Record<string, unknown>[]} */
  const events = [];
  let seq = 0;
  return {
    async loadState() {
      return derive(events);
    },
    async readHighestSeq() {
      return seq;
    },
    async readEvents() {
      return events.slice();
    },
    readEventsSync() {
      return events.slice();
    },
    async appendEvent(_id, event, options = {}) {
      seq += 1;
      const now = options.now ?? (() => 0);
      const stamped = { v: 1, ...event, seq, ts: now() };
      const checked = validateEvent(stamped);
      if (!checked.ok) throw new Error(`refusing to journal an invalid event: ${checked.error}`);
      const line = JSON.parse(JSON.stringify(stamped));
      events.push(line);
      return line;
    },
    async appendEvents(id, list, options = {}) {
      const out = [];
      for (const event of list) out.push(await this.appendEvent(id, event, options));
      return out;
    },
  };
}

/**
 * @param {string} parentChatId
 * @param {string} cwd
 * @param {object} [extra]
 */
function runRequested(parentChatId, cwd, extra = {}) {
  return makeEvent('run.requested', {
    runId: extra.runId ?? 'run-1',
    agentType: extra.agentType ?? 'explore',
    task: extra.task ?? 'Look at the workspace and report what you find.',
    parentChatId,
    cwd,
    requestedAt: extra.requestedAt ?? 1,
  });
}

/**
 * @param {{
 */
function makeEffector(opts = {}) {
  const parentChatId = opts.parentChatId ?? 'chat-p8d';
  return createSubAgentEffector({
    parentChatId,
    getState: opts.getState,
    model: MODEL,
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
    label: 'P8-D fake',
    baseUrl,
    apiKind: 'openai-v1',
  });
}

function streamingCount() {
  return listGenerationStates().filter(
    (state) => state.status === 'pending' || state.status === 'streaming',
  ).length;
}

describe('P8-D source contract', () => {
  test('engine.js is untouched by this task', () => {
    const source = fs.readFileSync(ENGINE_JS, 'utf8');
    assert.equal(source.includes('sub-agents/effector'), false);
    assert.equal(source.includes('createSubAgentEffector'), false);
    assert.equal(source.includes('cancelOrphanedSubAgentGenerations'), false);
  });

  test('runner package still does not import the orchestrator or sub-agents', () => {
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
          assert.equal(
            code.includes('sub-agents/'),
            false,
            `${path.relative(RUNNER_DIR, full)} imported sub-agents`,
          );
        }
      }
    };
    walk(RUNNER_DIR);
  });

  test('runner has no isBoard / isSubAgent branch', () => {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const code = fs.readFileSync(full, 'utf8');
          assert.equal(/\bisBoard\b/.test(code), false, `${full} mentions isBoard`);
          assert.equal(/\bisSubAgent\b/.test(code), false, `${full} mentions isSubAgent`);
        }
      }
    };
    walk(RUNNER_DIR);
  });

  test('limits come from attempt-limits.js, not a second module', () => {
    const limits = attemptLimits({ wallClockMs: 1000 });
    assert.equal(limits.wallClockMs, 1000);
    const source = fs.readFileSync(EFFECTOR_JS, 'utf8');
    assert.match(source, /attemptLimits/);
    assert.equal(source.includes('30 * 60 * 1000'), false);
  });

  test('unattended runTurn passes ask: null', () => {
    const source = fs.readFileSync(EFFECTOR_JS, 'utf8');
    assert.match(source, /ask:\s*null|ask,/);
    assert.match(source, /ask = options\.ask === undefined \? null/);
    assert.equal(/\bisBoard\b/.test(source), false);
    assert.equal(/\bisSubAgent\b/.test(source), false);
  });

  test('orphan cancel uses an sa- prefix so it cannot steal board live ids', () => {
    const source = fs.readFileSync(EFFECTOR_JS, 'utf8');
    assert.match(source, /ATTEMPT_PREFIX = 'sa-'/);
    assert.match(source, /startsWith\(ATTEMPT_PREFIX\)/);
  });

  test('per-type allow/deny narrows headless defaults and never adds browser tools', () => {
    const ids = resolveSubAgentToolIds({
      allowedTools: ['read_file', 'grep', 'spawn_sub_agent', 'browser_drive_navigate'],
      deniedTools: ['spawn_sub_agent', 'cancel_sub_agent'],
    });
    assert.ok(ids.includes('read_file'));
    assert.ok(ids.includes('grep'));
    assert.equal(ids.includes('spawn_sub_agent'), false);
    assert.deepEqual(browserToolsIn(ids), []);
    assert.ok(DEFAULT_HEADLESS_TOOL_IDS.includes('read_file'));
  });
});

describe('sub-agent runner effector', { concurrency: false }, () => {
  const fake = createFakeModelServer({
    scenario: [{ match: { nth: 0 }, emit: functionCallChunks(DEFAULT_REPORT_TOOL_NAME, VERDICT_PASS) }],
  });
/** @type {string} */
  let homeDir = '';
/** @type {string} */
  let fakeBase = '';

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-p8d-effector');
    await ensureMinnowLayout();
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

  test('a run reaches a verdict with no renderer', { timeout: 30_000 }, async () => {
    fake.reset();
    const parentChatId = 'chat-p8d-verdict';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-verdict-'));
    const journal = createMemoryAgentsJournal();
    const live = [];
    const unsubLive = subscribeLive(parentChatId, (payload) => live.push(payload));
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      parentChatId,
      journal,
      getState: () => box.engine.getState(),
    });
    const engine = createEngine({
      boardId: parentChatId,
      effector,
      journal,
      graph: subAgentGraph,
      tickMs: 100_000,
    });
    box.engine = engine;
    await engine.load();
    try {
      await engine.append([runRequested(parentChatId, cwd)]);
      await engine.tick();
      await waitFor(() => {
        const run = engine.getState().runs.get('run-1');
        return run?.phase === 'passed';
      }, 25_000);

      const run = engine.getState().runs.get('run-1');
      assert.equal(run.phase, 'passed');
      assert.equal(effector.started[0].role, SUB_AGENT_ROLE);
      const events = journal.readEventsSync();
      const types = events.map((event) => event.type);
      assert.ok(types.includes('run.requested'));
      assert.ok(types.includes('attempt.started'));
      assert.ok(types.includes('attempt.ended'));
      const ended = events.filter((event) => event.type === 'attempt.ended');
      assert.equal(ended[0].outcome, 'pass');
      assert.ok(ended[0].usage == null || typeof ended[0].usage === 'object');
    } finally {
      unsubLive();
      engine.dispose();
    }
  });

  test(
    'exceeding wallClockMs journals timeout and is retried with continue seed and transcript',
    { timeout: 25_000 },
    async () => {
      const parentChatId = 'chat-p8d-timeout-continue';
      const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-timeout-'));
      const journal = createMemoryAgentsJournal();
/** @type {import('../../server/runner/run-turn').RunTurnOptions[]} */
      const seen = [];
      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      const deps = stubDeps();
      const effector = makeEffector({
        parentChatId,
        getState: () => box.engine.getState(),
        deps,
        runTurn: async (options) => {
          seen.push(options);
          if (seen.length === 1) {
            options.deps.transcriptStore.append(options.chatId, {
              role: 'assistant',
              content: 'partial work kept',
            });
            return { outcome: 'timeout' };
          }
          return { outcome: 'pass', summary: 'resumed from transcript', evidence: [] };
        },
      });
      const engine = createEngine({
        boardId: parentChatId,
        effector,
        journal,
        graph: subAgentGraph,
        tickMs: 100_000,
      });
      box.engine = engine;
      await engine.load();
      try {
        await engine.append([runRequested(parentChatId, cwd)]);
        await engine.tick();
        await waitFor(() => {
          const run = engine.getState().runs.get('run-1');
          return run?.phase === 'passed';
        }, 15_000);

        const events = journal.readEventsSync();
        const ended = events.filter((event) => event.type === 'attempt.ended');
        assert.ok(ended.length >= 2, 'timeout then a retry must both be journaled');
        assert.equal(ended[0].outcome, 'timeout');
        assert.equal(ended[1].outcome, 'pass');
        const started = events.filter((event) => event.type === 'attempt.started');
        assert.equal(started[1].seedKind, 'continue');
        assert.equal(seen.length >= 2, true);
        assert.equal(seen[1].seedKind, 'continue');
        const prior = seen[1].messages ?? [];
        assert.ok(
          prior.some((row) => String(row?.content ?? '').includes('partial work kept')),
          'continue seed must carry the previous transcript, not discard it',
        );
      } finally {
        engine.dispose();
      }
    },
  );

  test(
    'cwd on run.requested is the spawning workspace, not a default',
    { timeout: 20_000 },
    async () => {
      const parentChatId = 'chat-p8d-cwd';
      const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-spawn-cwd-'));
      const journal = createMemoryAgentsJournal();
/** @type {string[]} */
      const seenCwd = [];
      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      const effector = makeEffector({
        parentChatId,
        getState: () => box.engine.getState(),
        runTurn: async (options) => {
          seenCwd.push(options.cwd);
          return { outcome: 'pass', summary: 'ok', evidence: [] };
        },
      });
      const engine = createEngine({
        boardId: parentChatId,
        effector,
        journal,
        graph: subAgentGraph,
        tickMs: 100_000,
      });
      box.engine = engine;
      await engine.load();
      try {
        await engine.append([runRequested(parentChatId, cwd)]);
        await engine.tick();
        await waitFor(() => seenCwd.length >= 1, 10_000);

        const requested = journal.readEventsSync().find((event) => event.type === 'run.requested');
        assert.equal(requested.cwd, cwd, 'cwd must be asserted from the journal');
        assert.equal(seenCwd[0], cwd, 'runTurn must receive the journaled cwd');
        assert.equal(effector.started[0].cwd, cwd);
        assert.notEqual(cwd, os.tmpdir(), 'test cwd is a unique spawn path, not a default');
      } finally {
        engine.dispose();
      }
    },
  );

  test('ask: null omits ask_question from runTurn tools', { timeout: 20_000 }, async () => {
    const parentChatId = 'chat-p8d-ask-null';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-ask-'));
    const journal = createMemoryAgentsJournal();
/** @type {unknown[]} */
    const seenAsk = [];
/** @type {string[][]} */
    const seenToolNames = [];
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      parentChatId,
      getState: () => box.engine.getState(),
      runTurn: async (options) => {
        for (const [name, required] of [['read_file', 'path'], ['grep', 'pattern'], ['execute_command', 'command']]) {
          const tool = options.tools.find(tool => tool.function.name === name);
          assert.ok(tool?.function.parameters.required?.includes(required), name + ' must supply its required arguments');
        }
        seenAsk.push(options.ask);
        seenToolNames.push(
          (options.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean),
        );
        return { outcome: 'pass', summary: 'ok', evidence: [] };
      },
    });
    const engine = createEngine({
      boardId: parentChatId,
      effector,
      journal,
      graph: subAgentGraph,
      tickMs: 100_000,
    });
    box.engine = engine;
    await engine.load();
    try {
      await engine.append([runRequested(parentChatId, cwd, { agentType: 'generalPurpose' })]);
      await engine.tick();
      await waitFor(() => seenAsk.length >= 1, 10_000);
      assert.equal(seenAsk[0], null);
      assert.equal(seenToolNames[0].includes(ASK_QUESTION_TOOL_NAME), false);
    } finally {
      engine.dispose();
    }
  });

  test('runTurn receives Settings sampler max tokens when the type omits maxTokens', { timeout: 20_000 }, async () => {
    const meta = (await readConfigJson('config.json')) ?? {};
    await writeConfigJson('config.json', {
      ...meta,
      sampler: { ...(meta.sampler && typeof meta.sampler === 'object' ? meta.sampler : {}), maxTokens: 131072 },
    });
    const parentChatId = 'chat-p8d-sampler-max';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-sampler-'));
    const journal = createMemoryAgentsJournal();
    /** @type {import('../../server/runner/run-turn').RunTurnOptions[]} */
    const seen = [];
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      parentChatId,
      getState: () => box.engine.getState(),
      runTurn: async (options) => {
        seen.push(options);
        return { outcome: 'pass', summary: 'ok', evidence: [] };
      },
    });
    const engine = createEngine({
      boardId: parentChatId,
      effector,
      journal,
      graph: subAgentGraph,
      tickMs: 100_000,
    });
    box.engine = engine;
    await engine.load();
    try {
      await engine.append([runRequested(parentChatId, cwd, { agentType: 'explore' })]);
      await engine.tick();
      await waitFor(() => seen.length >= 1, 10_000);
      assert.equal(seen[0]?.model?.sampler?.maxTokens, 131072);
      assert.ok(seen[0]?.model?.sampler?.preset, 'sampler must be { preset, maxTokens }, not a flat row');
    } finally {
      engine.dispose();
      await writeConfigJson('config.json', meta);
    }
  });

  test('tokens ride the live channel, not the journal', { timeout: 20_000 }, async () => {
    const longFake = createFakeModelServer({
      scenario: [{ emit: longThenReportChunks(VERDICT_PASS) }],
    });
    longFake.reset();
    const port = await longFake.listen(0);
    await pointProviderAt(`http://127.0.0.1:${port}`);
    const parentChatId = 'chat-p8d-tokens';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-tokens-'));
    const journal = createMemoryAgentsJournal();
    const live = [];
    const unsubLive = subscribeLive(parentChatId, (payload) => live.push(payload));
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      parentChatId,
      getState: () => box.engine.getState(),
    });
    const engine = createEngine({
      boardId: parentChatId,
      effector,
      journal,
      graph: subAgentGraph,
      tickMs: 100_000,
    });
    box.engine = engine;
    await engine.load();
    try {
      await engine.append([runRequested(parentChatId, cwd)]);
      await engine.tick();
      await waitFor(() => {
        return journal.readEventsSync().some((event) => event.type === 'attempt.ended');
      });
      const events = journal.readEventsSync();
      for (const event of events) {
        assert.notEqual(event.type, 'delta');
        assert.notEqual(event.type, 'token');
        assert.notEqual(event.type, 'live');
        assert.equal(typeof event.text, 'undefined');
      }
      assert.ok(
        live.some((row) => row.event?.type === 'delta' || row.event?.type === 'tool_call'),
        'live bus must see tokens or tool calls',
      );
    } finally {
      unsubLive();
      engine.dispose();
      await longFake.close();
      await restoreFake();
    }
  });

  test('inspect stays populated until onEnd resolves', { timeout: 20_000 }, async () => {
    fake.reset();
    const parentChatId = 'chat-p8d-inspect';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-inspect-'));
    const journal = createMemoryAgentsJournal();
    await journal.appendEvent(parentChatId, runRequested(parentChatId, cwd));
    const state = await journal.loadState(parentChatId);
    const effector = makeEffector({ parentChatId, getState: () => state });

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
      taskId: 'run-1',
      role: SUB_AGENT_ROLE,
      seedKind: 'initial',
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

  test('1-second wall clock → timeout from the effector', { timeout: 15_000 }, async () => {
    const hang = createHangServer();
    try {
    const url = await hang.listen();
    await pointProviderAt(url);
    const parentChatId = 'chat-p8d-wallclock';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-wall-'));
    const journal = createMemoryAgentsJournal();
    await journal.appendEvent(parentChatId, runRequested(parentChatId, cwd));
    const state = await journal.loadState(parentChatId);
    const effector = makeEffector({
      parentChatId,
      getState: () => state,
      limits: { wallClockMs: 1000, maxTurns: 40 },
    });
/** @type {import('../../server/orchestrator/engine.js').AttemptEnd | null} */
    let ended = null;
    effector.onEnd((payload) => {
      ended = payload;
    });
    await effector.start({
      taskId: 'run-1',
      role: SUB_AGENT_ROLE,
      seedKind: 'initial',
    });
    await waitFor(() => ended !== null, 8_000);
    assert.equal(
      ended.outcome,
      'timeout',
      `wall-clock expected timeout, got ${ended.outcome}: ${String(ended.summary ?? '')}`,
    );
    } finally {
      hang.kill();
      await hang.close().catch(() => {});
      await restoreFake();
    }
  });

  test('throw inside runTurn → crashed; engine keeps ticking', { timeout: 20_000 }, async () => {
    const parentChatId = 'chat-p8d-throw';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-throw-'));
    const journal = createMemoryAgentsJournal();
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const effector = makeEffector({
      parentChatId,
      getState: () => box.engine.getState(),
      runTurn: async () => {
        throw new Error('injected boom');
      },
    });
    const engine = createEngine({
      boardId: parentChatId,
      effector,
      journal,
      graph: subAgentGraph,
      tickMs: 100_000,
    });
    box.engine = engine;
    await engine.load();
    try {
      await engine.append([runRequested(parentChatId, cwd)]);
      await engine.tick();
      await waitFor(() => effector.started.length >= 2, 10_000);
      assert.ok(engine.getState(), 'engine still has state after the throw');
      const events = journal.readEventsSync();
      const crashed = events.filter(
        (event) => event.type === 'attempt.ended' && event.outcome === 'crashed',
      );
      assert.ok(crashed.length >= 1);
      assert.match(String(crashed[0].summary ?? ''), /injected boom/);
    } finally {
      engine.dispose();
    }
  });

  test('getEngine wires namespace agents without modifying engine.js', { timeout: 20_000 }, async () => {
    const parentChatId = 'chat-p8d-getengine';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-geteng-'));
    const journal = createMemoryAgentsJournal();
    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    const make = () =>
      makeEffector({
        parentChatId,
        getState: () => box.engine.getState(),
        runTurn: async () => ({ outcome: 'pass', summary: 'ok', evidence: [] }),
      });
    const engine = await getEngine(parentChatId, make, {
      namespace: AGENTS_NAMESPACE,
      graph: createSubAgentGraph(),
      journal,
      tickMs: 100_000,
    });
    box.engine = engine;
    try {
      await engine.append([runRequested(parentChatId, cwd)]);
      await engine.tick();
      await waitFor(() => engine.getState().runs.get('run-1')?.phase === 'passed', 10_000);
      assert.equal(engine.getState().runs.get('run-1').phase, 'passed');
    } finally {
      engine.dispose();
    }
  });

  test('inspect empty at boot; cancelOrphanedSubAgentGenerations is exported', () => {
    const effector = createSubAgentEffector({
      parentChatId: 'boot',
      getState: () => derive([]),
      model: MODEL,
      deps: stubDeps(),
    });
    assert.equal(effector.inspect().length, 0);
    assert.equal(typeof cancelOrphanedSubAgentGenerations, 'function');
  });

  test('fake model prose without report tool is a degraded pass', { timeout: 20_000 }, async () => {
    const silent = createFakeModelServer({
      scenario: [{ emit: proseSseChunks('I finished but I will not call the tool.') }],
    });
    silent.reset();
    const port = await silent.listen(0);
    try {
    await pointProviderAt(`http://127.0.0.1:${port}`);
    const parentChatId = 'chat-p8d-noreport';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-noreport-'));
    const journal = createMemoryAgentsJournal();
    await journal.appendEvent(parentChatId, runRequested(parentChatId, cwd));
    const state = await journal.loadState(parentChatId);
    const effector = makeEffector({ parentChatId, getState: () => state });
/** @type {import('../../server/orchestrator/engine.js').AttemptEnd | null} */
    let ended = null;
    effector.onEnd((payload) => {
      ended = payload;
    });
    await effector.start({
      taskId: 'run-1',
      role: SUB_AGENT_ROLE,
      seedKind: 'initial',
    });
    await waitFor(() => ended !== null);
    assert.equal(ended.outcome, 'pass');
    assert.equal(ended.summary, 'I finished but I will not call the tool.');
    } finally {
      await silent.close();
      await restoreFake();
    }
  });

  test('stop() mid-turn cancels generation; no orphaned upstream', { timeout: 20_000 }, async () => {
    const hang = createHangServer();
    try {
    const url = await hang.listen();
    await pointProviderAt(url);
    const parentChatId = 'chat-p8d-stop';
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-stop-'));
    const journal = createMemoryAgentsJournal();
    await journal.appendEvent(parentChatId, runRequested(parentChatId, cwd));
    const state = await journal.loadState(parentChatId);
    const effector = makeEffector({ parentChatId, getState: () => state });
    const { attemptId } = await effector.start({
      taskId: 'run-1',
      role: SUB_AGENT_ROLE,
      seedKind: 'initial',
    });
    await waitFor(() => streamingCount() >= 1 || effector.inspect().length === 1);
    await effector.stop(attemptId);
    assert.equal(effector.inspect().length, 0);
    await waitFor(() => streamingCount() === 0);
    } finally {
      hang.kill();
      await hang.close().catch(() => {});
      await restoreFake();
    }
  });

  test(
    'prose-only no_report is a degraded pass (effector, not runTurn)',
    { timeout: 20_000 },
    async () => {
      const parentChatId = 'chat-p8d-prose-fallback';
      const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-prose-'));
      const journal = createMemoryAgentsJournal();
      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      const deps = stubDeps();
      const prose = 'Here is what I found in src/.';
      const effector = makeEffector({
        parentChatId,
        getState: () => box.engine.getState(),
        deps,
        runTurn: async (options) => {
          options.deps.transcriptStore.append(options.chatId, {
            role: 'assistant',
            content: prose,
          });
          return { outcome: 'no_report' };
        },
      });
      const engine = createEngine({
        boardId: parentChatId,
        effector,
        journal,
        graph: subAgentGraph,
        tickMs: 100_000,
      });
      box.engine = engine;
      await engine.load();
      try {
        await engine.append([runRequested(parentChatId, cwd)]);
        await engine.tick();
        await waitFor(() => {
          const run = engine.getState().runs.get('run-1');
          return run?.phase === 'passed';
        }, 15_000);
        const ended = journal.readEventsSync().filter((event) => event.type === 'attempt.ended');
        assert.equal(ended.length, 1);
        assert.equal(ended[0].outcome, 'pass');
        assert.equal(ended[0].summary, prose);
      } finally {
        engine.dispose();
      }
    },
  );

  test(
    'empty no_report is not a degraded pass',
    { timeout: 20_000 },
    async () => {
      const parentChatId = 'chat-p8d-empty-noreport';
      const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8d-empty-nr-'));
      const journal = createMemoryAgentsJournal();
      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      let turns = 0;
      const effector = makeEffector({
        parentChatId,
        getState: () => box.engine.getState(),
        runTurn: async () => {
          turns += 1;
          return { outcome: 'no_report' };
        },
      });
      const engine = createEngine({
        boardId: parentChatId,
        effector,
        journal,
        graph: subAgentGraph,
        tickMs: 100_000,
      });
      box.engine = engine;
      await engine.load();
      try {
        await engine.append([runRequested(parentChatId, cwd)]);
        await engine.tick();
        await waitFor(() => {
          const ended = journal.readEventsSync().filter((event) => event.type === 'attempt.ended');
          return ended.length >= 1 && ended[0].outcome === 'no_report';
        }, 15_000);
        const first = journal.readEventsSync().find((event) => event.type === 'attempt.ended');
        assert.equal(first.outcome, 'no_report');
        assert.equal(turns >= 1, true);
      } finally {
        engine.dispose();
      }
    },
  );
});

describe('degradeNoReportIfProse (effector-only)', () => {
  const SCHEMA = 'minnow.sub-agent.v1';

  test('maps assistant prose onto a degraded pass', () => {
    const out = degradeNoReportIfProse(
      { outcome: 'no_report' },
      [{ role: 'assistant', content: 'Here is what I found in src/.' }],
      SCHEMA,
    );
    assert.equal(out.outcome, 'pass');
    assert.equal(out.summary, 'Here is what I found in src/.');
  });

  test('empty no_report stays no_report', () => {
    const out = degradeNoReportIfProse({ outcome: 'no_report' }, [], SCHEMA);
    assert.equal(out.outcome, 'no_report');
  });

  test('thinking-only rows are not a summary', () => {
    const out = degradeNoReportIfProse(
      { outcome: 'no_report' },
      [{ role: 'assistant', content: '', thinking: ['hmm'] }],
      SCHEMA,
    );
    assert.equal(out.outcome, 'no_report');
  });

  test('tool-call-only rows are not a summary', () => {
    const out = degradeNoReportIfProse(
      { outcome: 'no_report' },
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file' } }],
        },
      ],
      SCHEMA,
    );
    assert.equal(out.outcome, 'no_report');
  });

  test('does not rewrite a typed fail', () => {
    const out = degradeNoReportIfProse(
      { outcome: 'fail', summary: 'blocked' },
      [{ role: 'assistant', content: 'Here is what I found in src/.' }],
      SCHEMA,
    );
    assert.equal(out.outcome, 'fail');
    assert.equal(out.summary, 'blocked');
  });
});
