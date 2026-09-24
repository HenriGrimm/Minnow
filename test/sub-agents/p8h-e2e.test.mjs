/**
 * P8-H — E2E and reliability proof (MIN-761).
 *
 * Driven through HTTP `/api/agents` with the UI closed against the sub-agent
 * effector and a fake model host. Zero renderer: no DOM, no bundler, no `src/`
 * imports. The gate is that a sub-agent survives what the controller used to
 * kill — reload, restart, killed host, wall-clock, fail-past-cap, cancel
 * during approval, delivery while the parent streams.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import { createFakeModelServer } from '../../scripts/fake-model-server.mjs';
import { FAKE_MODEL_ID } from '../../server/orchestrate/board-testing/fake-model-ids.js';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { mergeConfigMeta } from '../../server/config/validators.js';
import { createProvider, updateProvider, listProviders } from '../../server/providers/store.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { postChatCompletionsHttp } from '../../server/runner/index.js';
import { MAX_TRANSIENT_FETCH_ATTEMPTS as TRANSIENT_ATTEMPTS } from '../../server/runner/transient-fetch-retry.js';
import { postChatCompletionsInProcess } from '../../server/runner/node.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import { derive, serializeState, stateToJSON } from '../../server/sub-agents/derive.js';
import {
  cancelOrphanedSubAgentGenerations,
  createSubAgentEffector,
} from '../../server/sub-agents/effector-runner.js';
import {
  createAgentsMiddleware,
  getAgentsEngine,
  resetAgentsMiddlewareForTests,
  setAgentsEffectorFactory,
} from '../../server/sub-agents/middleware.js';
import {
  getProductionDelivery,
  resetProductionDelivery,
  setProductionParentStatus,
} from '../../server/sub-agents/runtime.js';
import {
  P8H_RELIABILITY_PATH,
  attemptDurationTail,
  createHoldGate,
  failForeverScenario,
  happyScenario,
  probeRealProvider,
  reliabilityFromEvents,
  tokenCostFromEvents,
  waitFor,
} from './p8h-helpers.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');
const PROVIDER_ID = 'local-fake';
const MODEL = { providerId: PROVIDER_ID, id: FAKE_MODEL_ID };

const fake = createFakeModelServer({ scenario: happyScenario() });

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
let serial = 0;
/** @type {ReturnType<typeof createSubAgentEffector> | null} */
let lastEffector = null;
/** @type {null | ((body: unknown, signal: AbortSignal | undefined) => Promise<void>)} */
let beforeModelCall = null;
/** Extra createSubAgentEffector options for one test (limits / runTurn / postChat). */
let effectorExtra = {};

function nextId(prefix) {
  serial += 1;
  return `${prefix}-${serial}`;
}

async function pointProviderAt(baseUrl) {
  const { providers } = await listProviders();
  const body = {
    id: PROVIDER_ID,
    label: 'P8-H fake',
    baseUrl,
    apiKind: 'openai-v1',
  };
  if (providers.some((row) => row.id === PROVIDER_ID)) {
    await updateProvider(PROVIDER_ID, body);
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
        plannerProviderId: PROVIDER_ID,
        plannerModelId: FAKE_MODEL_ID,
      },
    }),
  );
}

function installFactory() {
  lastEffector = null;
  setAgentsEffectorFactory((parentChatId) => {
    lastEffector = createSubAgentEffector({
      parentChatId,
      model: MODEL,
      promptVariant: 'lite',
      limits: { maxTurns: 8, wallClockMs: 25_000 },
      postChatCompletions: async (provider, body, signal) => {
        if (beforeModelCall) await beforeModelCall(body, signal);
        return postChatCompletionsInProcess(provider, body, signal);
      },
      ...effectorExtra,
    });
    return lastEffector;
  });
}

async function startApi() {
  installFactory();
  const middleware = createAgentsMiddleware();
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
  resetAgentsMiddlewareForTests();
  resetProductionDelivery();
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

/**
 * @param {Record<string, unknown>} extra
 */
async function spawn(extra = {}) {
  const created = await call('POST', '/api/agents', {
    type: extra.type ?? 'explore',
    task: extra.task ?? 'scan the sandbox and report pass',
    parentChatId: extra.parentChatId ?? nextId('chat'),
    cwd: extra.cwd ?? sandbox,
    ...extra,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

async function journalOf(runId) {
  const got = await call('GET', `/api/agents/${runId}/journal`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  return /** @type {Record<string, unknown>[]} */ (got.body.events);
}

async function waitUntilRun(runId, predicate, timeoutMs = 45_000, label = 'run') {
  await waitFor(async () => {
    const got = await call('GET', `/api/agents/${runId}`);
    if (got.status !== 200) return false;
    return predicate(got.body);
  }, timeoutMs, label);
  return (await call('GET', `/api/agents/${runId}`)).body;
}

/**
 * Hang the upstream SSE so wall-clock can fire with a partial transcript.
 * Closing it is `no_report`; keeping it open is what `timeout` needs.
 */
function createHangServer() {
  /** @type {import('http').ServerResponse[]} */
  const open = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      req.resume();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"choices":[{"delta":{"content":"partial work kept"}}]}\n\n');
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
      const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      return `http://127.0.0.1:${port}`;
    },
    close() {
      for (const res of open) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * @param {string} runId
 * @param {(frames: Array<{ event: string, data: any }>) => boolean} enough
 * @param {number} [timeoutMs]
 */
function readSse(runId, enough, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    /** @type {Array<{ event: string, data: any }>} */
    const frames = [];
    const request = http.get(`${apiBase}/api/agents/${runId}/events`, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`SSE returned ${response.statusCode}`));
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (raw.startsWith(':')) continue;
          /** @type {any} */
          const frame = {};
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) {
              try {
                frame.data = JSON.parse(line.slice(6));
              } catch {
                frame.data = line.slice(6);
              }
            }
          }
          frames.push(frame);
          if (enough(frames)) {
            request.destroy();
            resolve(frames);
            return;
          }
        }
      });
      response.on('error', () => resolve(frames));
    });
    request.on('error', (err) => {
      if (frames.length > 0) resolve(frames);
      else reject(err);
    });
    setTimeout(() => {
      request.destroy();
      resolve(frames);
    }, timeoutMs).unref?.();
  });
}

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-p8h');
  await ensureMinnowLayout();
  sandbox = path.join(homeDir, 'p8h-sandbox');
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
  beforeModelCall = null;
  effectorExtra = {};
  lastEffector = null;
  resetProductionDelivery();
  resetAgentsMiddlewareForTests();
  deleteGenerationsForProviderShutdown();
});

afterEach(async () => {
  lastEffector = null;
  beforeModelCall = null;
  effectorExtra = {};
  deleteGenerationsForProviderShutdown();
  await stopApi();
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

// ── P8-H renderer exclusion ──────────────────────────────────────────────────

describe('P8-H renderer exclusion', { concurrency: false }, () => {
  test('runs without a document or window', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');
  });

  test('this suite does not import a bundler, DOM adapter, or src/', () => {
    const source = fs.readFileSync(THIS_FILE, 'utf8');
    // Import-line match only: a mention inside this assertion must not trip it.
    assert.equal(/^\s*import\s+.+['"]happy-dom['"]/m.test(source), false);
    assert.equal(/^\s*import\s+.+['"]vite['"]/m.test(source), false);
    assert.equal(/^\s*import\s+.+['"]\.\.\/\.\.\/src\//m.test(source), false);
  });
});

// ── P8-H dead supervisor keys ────────────────────────────────────────────────

describe('P8-H dead supervisor keys', { concurrency: false }, () => {
  test('src/ has no lastHeartbeatAt, tier1Attempted, or progressStallMs', () => {
    const srcRoot = path.join(PROJECT_ROOT, 'src');
    const banned = /lastHeartbeatAt|tier1Attempted|progressStallMs/;
    /** @type {string[]} */
    const hits = [];
    function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|js|mjs|mts)$/.test(name)) continue;
        const body = fs.readFileSync(full, 'utf8');
        if (banned.test(body)) hits.push(path.relative(srcRoot, full).replaceAll('\\', '/'));
      }
    }
    walk(srcRoot);
    assert.deepEqual(hits, [], hits.join('\n'));
  });
});

// ── P8-H HTTP spawn ──────────────────────────────────────────────────────────

describe('P8-H HTTP spawn (UI closed)', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi();
  });

  test('GET mid-run folds the same state the engine holds; the run finishes', { timeout: 60_000 }, async () => {
    const hold = createHoldGate();
    beforeModelCall = (_body, signal) => hold.wait(signal);
    const parentChatId = nextId('chat-reload');
    const spawned = await spawn({ parentChatId });

    await waitFor(
      () => lastEffector && lastEffector.inspect().length === 1,
      15_000,
      'attempt live',
    );

    const listed = await call('GET', `/api/agents?parentChatId=${parentChatId}`);
    const journal = await journalOf(spawned.runId);
    assert.deepEqual(listed.body.state, stateToJSON(derive(journal)));

    hold.release();
    const done = await waitUntilRun(
      spawned.runId,
      (body) => body.status === 'completed' || body.run?.phase === 'passed',
      30_000,
      'reload-path finish',
    );
    assert.equal(done.run.phase, 'passed');
  });

  test('server restart: inspect empty → reap crashed → continue seed → completes', { timeout: 90_000 }, async () => {
    // vanishAll is the inspect-empty analogue of p5d `--induce kill-server@…`.
    // Killing this process would take the assertion with it; the journal is
    // what `--resume` would fold, and a fresh engine over it is the proof.
    const hold = createHoldGate();
    beforeModelCall = (_body, signal) => hold.wait(signal);
    const parentChatId = nextId('chat-restart');
    const spawned = await spawn({ parentChatId });

    await waitFor(
      () => lastEffector && lastEffector.inspect().length === 1,
      15_000,
      'attempt live before crash',
    );
    lastEffector.vanishAll();
    assert.equal(lastEffector.inspect().length, 0);

    resetAgentsMiddlewareForTests();
    cancelOrphanedSubAgentGenerations();
    installFactory();

    const engine = await getAgentsEngine(parentChatId);
    assert.equal(lastEffector.inspect().length, 0, 'fresh effector must start empty');
    await engine.tick();

    hold.release();
    const done = await waitUntilRun(
      spawned.runId,
      (body) => body.run?.phase === 'passed',
      30_000,
      'restart recovery finish',
    );
    assert.equal(done.run.phase, 'passed');

    const events = await journalOf(spawned.runId);
    const ended = events.filter((event) => event.type === 'attempt.ended');
    assert.ok(
      ended.some((event) => event.outcome === 'crashed'),
      `expected crashed reap, got ${ended.map((e) => e.outcome).join(',')}`,
    );
    const started = events.filter((event) => event.type === 'attempt.started');
    assert.ok(
      started.some((event) => event.seedKind === 'continue'),
      'retry after crash must be a continue seed, not a cold start',
    );
  });

  test('completion while parent is streaming, then reload, still delivers', { timeout: 60_000 }, async () => {
    const parentChatId = nextId('chat-stream');
    let streaming = true;
    setProductionParentStatus(() => ({ streaming, skip: null }));

    const spawned = await spawn({ parentChatId });
    await waitUntilRun(
      spawned.runId,
      (body) => body.run?.phase === 'passed',
      30_000,
      'pass while parent streams',
    );

    let events = await journalOf(spawned.runId);
    assert.equal(
      events.some((event) => event.type === 'result.delivered'),
      false,
      'streaming parent must leave the completion pending in the journal',
    );

    // "Reload": the parent is no longer streaming. SSE is the connected view.
    streaming = false;
    const framesP = readSse(
      spawned.runId,
      (frames) => frames.some((f) => f.event === 'deliver'),
      15_000,
    );
    await getProductionDelivery().tick(parentChatId);
    const frames = await framesP;
    assert.ok(
      frames.some((f) => f.event === 'deliver'),
      'reload after stream-end must still deliver',
    );

    events = await journalOf(spawned.runId);
    assert.ok(events.some((event) => event.type === 'result.delivered'));
  });

  test('two runs at once honor globalMaxConcurrent and the per-type cap', { timeout: 90_000 }, async () => {
    // Shipped caps: global 3, explore 2. Hold so inspect() is the proof,
    // not a race where the first finishes before the second starts.
    const hold = createHoldGate();
    beforeModelCall = (_body, signal) => hold.wait(signal);
    const parentChatId = nextId('chat-caps');

    const a = await spawn({ parentChatId, type: 'explore', task: 'explore A' });
    const b = await spawn({ parentChatId, type: 'explore', task: 'explore B' });
    await waitFor(
      () => lastEffector && lastEffector.inspect().length === 2,
      15_000,
      'two explore attempts live',
    );

    const c = await spawn({ parentChatId, type: 'explore', task: 'explore C' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      lastEffector.inspect().length,
      2,
      'per-type cap 2 must not start a third explore',
    );

    const d = await spawn({ parentChatId, type: 'generalPurpose', task: 'gp D' });
    await waitFor(
      () => lastEffector && lastEffector.inspect().length === 3,
      10_000,
      'global cap still has a slot for another type',
    );

    const e = await spawn({ parentChatId, type: 'generalPurpose', task: 'gp E' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      lastEffector.inspect().length,
      3,
      'globalMaxConcurrent 3 must not start a fifth run',
    );

    hold.release();
    for (const row of [a, b, c, d, e]) {
      const done = await waitUntilRun(
        row.runId,
        (body) => body.run?.phase === 'passed',
        40_000,
        `${row.runId} finish after cap release`,
      );
      assert.equal(done.run.phase, 'passed', row.runId);
    }
  });
});

// ── P8-H induced failures ────────────────────────────────────────────────────

describe('P8-H induced failures', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi();
  });

  test('killed model host → crashed then retry with continue seed', { timeout: 60_000 }, async () => {
    let explode = null;
    let first = true;
    let deadCalls = 0;
    const completionsUrl = { current: '' };
    effectorExtra = {
      postChatCompletions: (_provider, body, signal) => {
        if (first) {
          first = false;
          deadCalls += 1;
          return new Promise((_, reject) => {
            explode = (err) => reject(err);
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        // The runner replays a dropped connection before giving up, so every
        // replay has to drop too or the host is not actually dead.
        if (deadCalls < TRANSIENT_ATTEMPTS) {
          deadCalls += 1;
          return Promise.reject(new Error('ECONNRESET: model host killed'));
        }
        return postChatCompletionsHttp(
          {
            id: PROVIDER_ID,
            baseUrl: completionsUrl.current,
            apiKind: 'openai-v1',
            chatCompletionsPath: '/v1/chat/completions',
          },
          body,
          signal,
        );
      },
    };

    const parentChatId = nextId('chat-kill-host');
    const spawned = await spawn({ parentChatId });
    await waitFor(() => lastEffector && lastEffector.inspect().length === 1 && explode, 15_000, 'hung host');

    const recovery = createFakeModelServer({ scenario: happyScenario() });
    recovery.reset();
    const port = await recovery.listen(0);
    completionsUrl.current = `http://127.0.0.1:${port}`;
    explode(new Error('ECONNRESET: model host killed'));

    try {
      const done = await waitUntilRun(
        spawned.runId,
        (body) => body.run?.phase === 'passed',
        30_000,
        'killed-host recovery',
      );
      assert.equal(done.run.phase, 'passed');
      const events = await journalOf(spawned.runId);
      const ended = events.filter((e) => e.type === 'attempt.ended').map((e) => e.outcome);
      assert.ok(ended.includes('crashed'), `expected crashed, got ${ended.join(',')}`);
      const started = events.filter((e) => e.type === 'attempt.started');
      assert.ok(started.some((e) => e.seedKind === 'continue'));
    } finally {
      if (typeof recovery.server.closeAllConnections === 'function') {
        recovery.server.closeAllConnections();
      }
      await recovery.close().catch(() => {});
    }
  });

  test('exceeding wallClockMs is retried by policy, not cancelled', { timeout: 45_000 }, async () => {
    const hang = createHangServer();
    const hangBase = await hang.listen();
    effectorExtra = {
      limits: { maxTurns: 40, wallClockMs: 1200 },
      postChatCompletions: (_provider, body, signal) => {
        const n = effectorExtra._n = (effectorExtra._n ?? 0) + 1;
        if (n === 1) {
          return postChatCompletionsHttp(
            {
              id: PROVIDER_ID,
              baseUrl: hangBase,
              apiKind: 'openai-v1',
              chatCompletionsPath: '/v1/chat/completions',
            },
            body,
            signal,
          );
        }
        return postChatCompletionsInProcess(_provider, body, signal);
      },
    };

    try {
      const spawned = await spawn({ parentChatId: nextId('chat-timeout') });
      const done = await waitUntilRun(
        spawned.runId,
        (body) => body.run?.phase === 'passed',
        25_000,
        'timeout then retry',
      );
      assert.equal(done.run.phase, 'passed');
      const events = await journalOf(spawned.runId);
      const ended = events.filter((e) => e.type === 'attempt.ended');
      assert.ok(ended.length >= 2, 'timeout then a retry must both be journaled');
      assert.equal(ended[0].outcome, 'timeout');
      assert.equal(ended.at(-1).outcome, 'pass');
      const started = events.filter((e) => e.type === 'attempt.started');
      assert.equal(started[1].seedKind, 'continue');
    } finally {
      await hang.close();
    }
  });

  test('fail past the cap journals run.abandoned with the full evidence bundle', { timeout: 60_000 }, async () => {
    fake.reset();
    // Dedicated host so the shared happy-path scenario cannot pass a retry.
    const failing = createFakeModelServer({ scenario: failForeverScenario() });
    failing.reset();
    const port = await failing.listen(0);
    const failBase = `http://127.0.0.1:${port}`;
    await pointProviderAt(failBase);

    try {
      const spawned = await spawn({ parentChatId: nextId('chat-abandon') });
      const done = await waitUntilRun(
        spawned.runId,
        (body) => body.run?.phase === 'abandoned' || body.status === 'failed',
        40_000,
        'abandon after fail cap',
      );
      assert.equal(done.run.phase, 'abandoned');
      const evidence = done.run.abandonedEvidence;
      assert.ok(evidence && typeof evidence === 'object', 'abandonment must carry evidence');
      assert.ok(Array.isArray(evidence.attempts), 'attempt list must not be truncated away');
      assert.ok(
        evidence.attempts.length >= 3,
        `full bundle expected ≥3 attempts, got ${evidence.attempts.length}`,
      );
      const events = await journalOf(spawned.runId);
      assert.ok(events.some((e) => e.type === 'run.abandoned'));
    } finally {
      await pointProviderAt(fakeBase);
      if (typeof failing.server.closeAllConnections === 'function') {
        failing.server.closeAllConnections();
      }
      await failing.close().catch(() => {});
    }
  });

  test('cancel while a tool waits on AbortSignal does not execute the tool', { timeout: 30_000 }, async () => {
    // Re-assert P8-A without importing the renderer modal: cancel → stop() →
    // signal abort → the waiting tool never runs. The queue unit test covers
    // the modal; this is the engine path that used to execute anyway.
    let toolExecuted = false;
    let approvalOpen = false;
    effectorExtra = {
      runTurn: async (options) => {
        approvalOpen = true;
        await new Promise((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (options.signal?.aborted) {
          return { outcome: 'crashed', error: 'aborted before tool execute' };
        }
        toolExecuted = true;
        return { outcome: 'pass', summary: 'tool ran', evidence: [] };
      },
    };

    const spawned = await spawn({ parentChatId: nextId('chat-approve') });
    await waitFor(() => approvalOpen, 10_000, 'approval wait');
    const cancelled = await call('POST', `/api/agents/${spawned.runId}/cancel`);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    await waitUntilRun(
      spawned.runId,
      (body) => body.status === 'cancelled' || body.run?.phase === 'cancelled',
      10_000,
      'cancel settles',
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(toolExecuted, false, 'cancelled run must not execute the waiting tool');
  });
});

// ── P8-H reliability ─────────────────────────────────────────────────────────

describe('P8-H reliability (10-run)', { concurrency: false }, () => {
  beforeEach(async () => {
    await startApi();
  });

  test('fixture completes 10 times; numbers are the deterministic-host ceiling', { timeout: 180_000 }, async () => {
    const RUNS = 10;
    /** @type {Array<Record<string, unknown>>} */
    const perRun = [];
    let completed = 0;
    let retries = 0;
    let abandonments = 0;
    /** @type {Record<string, unknown>[]} */
    const allEvents = [];

    for (let n = 1; n <= RUNS; n += 1) {
      fake.reset();
      const t0 = Date.now();
      let finished = false;
      let runRetries = 0;
      let runAbandoned = 0;
      try {
        const spawned = await spawn({
          parentChatId: nextId(`chat-rel${n}`),
          task: `reliability run ${n}`,
        });
        const done = await waitUntilRun(
          spawned.runId,
          (body) => body.run?.phase === 'passed',
          30_000,
          `reliability ${n}`,
        );
        finished = done.run?.phase === 'passed';
        const events = await journalOf(spawned.runId);
        allEvents.push(...events);
        const stats = reliabilityFromEvents(events);
        runRetries = stats.retries;
        runAbandoned = stats.abandonments;
        if (finished) completed += 1;
      } catch (err) {
        finished = false;
        perRun.push({
          n,
          finished: false,
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
        retries: runRetries,
        abandoned: runAbandoned,
        ms: Date.now() - t0,
      });
    }

    const realProvider = await probeRealProvider();
    const report = {
      runs: RUNS,
      completed,
      failed: RUNS - completed,
      retries,
      abandonments,
      attemptDistribution: attemptDurationTail(allEvents),
      tokenCost: tokenCostFromEvents(allEvents),
      perRun,
      realProvider,
      recordedAt: '2026-08-31',
      host: 'scripts/fake-model-server.mjs',
      ceiling:
        '10/10 is the deterministic-host ceiling, not a measurement that agents never retry. Do not quote this as a live-LLM result.',
      note: 'Deterministic fake host emitting report_outcome pass. A fake-host 10/10 is the host ceiling, not a live-LLM measurement — Phase 8 should not treat it as “agents never retry.”',
    };
    await fsp.writeFile(P8H_RELIABILITY_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const table = perRun
      .map(
        (row) =>
          `  run ${String(row.n).padStart(2)}  finished=${row.finished}  retries=${row.retries}  abandoned=${row.abandoned}  ${row.ms}ms`,
      )
      .join('\n');
    console.log(
      `P8-H reliability\n${table}\n  completed ${completed}/${RUNS}  retries ${retries}  abandonments ${abandonments}`,
    );

    assert.equal(completed, RUNS, `expected ${RUNS} completions, got ${completed}`);
    assert.equal(abandonments, 0);
    assert.match(String(report.ceiling), /deterministic-host ceiling/);
  });
});
