/**
 * P8-G — spawn / cancel / wait against the SSE store (V2 surface).
 *
 * Ports controller cancel AbortError + spawn POST semantics. Concurrency
 * caps and delivery-once live in conformance / delivery tests; retry-on-crash
 * is policy.test.mjs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  adoptSubAgentRunForTests,
  buildSubAgentStatusPayload,
  cancelAllForParentChat,
  cancelAllForParentTurn,
  cancelSubAgent,
  getSubAgentRun,
  countOpenSubAgentStreams,
  hydrateSubAgentRunsForParentChat,
  hydrateSubAgentTranscript,
  listActiveSubAgentRuns,
  rehydrateLiveParentSubAgents,
  resetSubAgentOrchestrator,
  setSubAgentApiFetchForTests,
  setSubAgentOpenStreamForTests,
  spawnSubAgent,
  subAgentRunFromFold,
  waitForSubAgent,
} from '../../src/agents/orchestrator.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';
import { setSubAgentExecutorContext } from '../../src/tools/sub-agent-executor.ts';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import {
  resetSubAgentConfigCache,
  setRuntimeSubAgentOverrides,
} from '../../src/agents/sub-agent-config.ts';
import { FIXED_RUN_ID, FIXED_SUMMARY } from './test-helpers.mts';

const CHAT_ID = '11111111-1111-1111-1111-222222222222';

function runningRun(): SubAgentRun {
  return {
    runId: FIXED_RUN_ID,
    type: 'explore',
    task: 'scan',
    status: 'running',
    parentChatId: CHAT_ID,
    parentToolCallId: null,
    parentTurnId: 'turn-1',
    summary: '',
    error: null,
    startedAt: '2026-05-19T12:00:00.000Z',
    endedAt: null,
    toolTurns: 0,
    cancelled: false,
    messages: [],
  };
}

// ── orchestrator SSE store ───────────────────────────────────────────────────

describe('orchestrator SSE store (spawn / cancel / wait)', () => {
  const posts: Array<{ method: string; url: string; body: string }> = [];

  beforeEach(() => {
    posts.length = 0;
    resetSubAgentOrchestrator();
    // Pin localStorage so spawn's type-config load does not ping a live server.
    setStorageModeForTests('localStorage');
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides({});
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
    setSubAgentApiFetchForTests(async (input, init) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      posts.push({ method, url, body: String(init?.body ?? '') });
      if (method === 'GET' && url.includes('/transcript')) {
        return new Response(
          JSON.stringify({ ok: true, events: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'POST' && url.endsWith('/api/agents') && !url.includes('/cancel')) {
        return new Response(
          JSON.stringify({
            ok: true,
            runId: FIXED_RUN_ID,
            status: 'running',
            run: {
              runId: FIXED_RUN_ID,
              type: 'explore',
              task: 'scan',
              parentChatId: CHAT_ID,
              parentTurnId: 'turn-1',
              cwd: '/tmp',
              requestedAt: 1,
              phase: 'running',
              attempts: [],
              delivered: false,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'POST' && url.includes('/cancel')) {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 'cancelled',
            state: {
              runs: [
                {
                  runId: FIXED_RUN_ID,
                  type: 'explore',
                  task: 'scan',
                  parentChatId: CHAT_ID,
                  phase: 'cancelled',
                  attempts: [],
                  delivered: false,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: `unexpected ${method} ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    setSubAgentExecutorContext(null);
    setSessionStateForTests(null);
    setSubAgentApiFetchForTests(null);
    setSubAgentOpenStreamForTests(null);
    resetSubAgentOrchestrator();
    setRuntimeSubAgentOverrides(null);
    resetSubAgentConfigCache();
    setStorageModeForTests(null);
  });

  test('spawn POSTs /api/agents and adopts the returned run', async () => {
    const result = await spawnSubAgent({
      type: 'explore',
      task: 'scan',
      wait: false,
      parentChatId: CHAT_ID,
      parentTurnId: 'turn-1',
    });
    assert.equal(result.runId, FIXED_RUN_ID);
    if (!('status' in result)) assert.fail('expected spawn result');
    assert.equal(result.status, 'running');
    const spawn = posts.find((p) => p.method === 'POST' && p.url.endsWith('/api/agents'));
    assert.ok(spawn);
    const body = JSON.parse(spawn.body) as { type: string; task: string; parentChatId: string };
    assert.equal(body.type, 'explore');
    assert.equal(body.task, 'scan');
    assert.equal(body.parentChatId, CHAT_ID);
  });

  test('cancel POSTs /api/agents/:runId/cancel', async () => {
    adoptSubAgentRunForTests(runningRun());
    const result = cancelSubAgent(FIXED_RUN_ID, 'user_cancel');
    assert.equal(result.ok, true);
    assert.equal(result.runId, FIXED_RUN_ID);
    await new Promise((r) => setTimeout(r, 20));
    const cancel = posts.find((p) => p.url.includes(`/${FIXED_RUN_ID}/cancel`));
    assert.ok(cancel);
    assert.equal(cancel.method, 'POST');
  });

  test('waitForSubAgent rejects AbortError and POSTs cancel when the passed signal aborts', async () => {
    // chatSignal shape: the same AbortSignal runChatTurn passes to executeTool.
    // This listener is the cancel origin WHEN a signal is actually passed
    // (Super Plan AbortSignal.timeout). Chat spawn wait:true does not pass it.
    adoptSubAgentRunForTests(runningRun());
    const chatSignal = new AbortController();
    const pending = waitForSubAgent(FIXED_RUN_ID, chatSignal.signal);
    chatSignal.abort();
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err && typeof err === 'object' && 'name' in err);
      assert.equal((err as { name: string }).name, 'AbortError');
      return true;
    });
    await new Promise((r) => setTimeout(r, 20));
    const cancel = posts.find((p) => p.url.includes(`/${FIXED_RUN_ID}/cancel`));
    assert.ok(cancel);
  });

  test('waitForSubAgent resolves when the store already has a terminal run', async () => {
    adoptSubAgentRunForTests({
      ...runningRun(),
      status: 'completed',
      summary: FIXED_SUMMARY,
      endedAt: '2026-05-19T12:00:01.000Z',
      structuredOutcome: {
        summary: FIXED_SUMMARY,
        findings: [],
        artifacts: [],
      },
    });
    const agg = await waitForSubAgent(FIXED_RUN_ID);
    assert.equal(agg.status, 'completed');
    assert.equal(agg.summary, FIXED_SUMMARY);
  });

  test('spawn forwards parentToolCallId and parentTurnId on the POST', async () => {
    const result = await spawnSubAgent({
      type: 'explore',
      task: 'scan',
      wait: false,
      parentChatId: CHAT_ID,
      parentTurnId: 'turn-1',
      parentToolCallId: 'call_spawn',
    });
    assert.equal(result.runId, FIXED_RUN_ID);
    const spawn = posts.find((p) => p.method === 'POST' && p.url.endsWith('/api/agents'));
    assert.ok(spawn);
    const body = JSON.parse(spawn.body) as {
      parentChatId: string;
      parentTurnId: string;
      parentToolCallId: string;
    };
    assert.equal(body.parentChatId, CHAT_ID);
    assert.equal(body.parentTurnId, 'turn-1');
    assert.equal(body.parentToolCallId, 'call_spawn');
  });

  test('spawn binds the parent chat model when the type has no override', async () => {
    const chat = createEmptyChatObject('chat-model');
    chat.id = CHAT_ID;
    chat.providerId = 'local-fake';
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    await spawnSubAgent({
      type: 'explore',
      task: 'scan',
      wait: false,
      parentChatId: CHAT_ID,
    });

    const spawn = posts.find((p) => p.method === 'POST' && p.url.endsWith('/api/agents'));
    assert.ok(spawn);
    const body = JSON.parse(spawn.body) as { providerId: string; modelId: string };
    assert.equal(body.providerId, 'local-fake');
    assert.equal(body.modelId, 'chat-model');
  });

  test('spawn keeps an explicit provider/model override', async () => {
    const chat = createEmptyChatObject('chat-model');
    chat.id = CHAT_ID;
    chat.providerId = 'local-fake';
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    await spawnSubAgent({
      type: 'explore',
      task: 'scan',
      wait: false,
      parentChatId: CHAT_ID,
      providerId: 'reviewer-provider',
      modelId: 'reviewer-model',
    });

    const spawn = posts.find((p) => p.method === 'POST' && p.url.endsWith('/api/agents'));
    assert.ok(spawn);
    const body = JSON.parse(spawn.body) as { providerId: string; modelId: string };
    assert.equal(body.providerId, 'reviewer-provider');
    assert.equal(body.modelId, 'reviewer-model');
  });

  test('cancelAllForParentTurn POSTs cancel for runs indexed by that turn', async () => {
    adoptSubAgentRunForTests(runningRun());
    cancelAllForParentTurn('turn-1');
    await new Promise((r) => setTimeout(r, 20));
    const cancel = posts.find((p) => p.url.includes(`/${FIXED_RUN_ID}/cancel`));
    assert.ok(cancel);
    assert.equal(cancel.method, 'POST');
  });

  test('cancelAllForParentTurn does not match a different parentTurnId', async () => {
    adoptSubAgentRunForTests(runningRun());
    cancelAllForParentTurn('turn-other');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      posts.filter((p) => p.url.includes('/cancel')).length,
      0,
    );
  });

  test('cancelAllForParentChat settles known children and uses one parent request', async () => {
    adoptSubAgentRunForTests(runningRun());
    cancelAllForParentChat(CHAT_ID);

    assert.equal(listActiveSubAgentRuns().length, 0, 'Stop should settle child UI immediately');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const parentCancels = posts.filter(
      (post) => post.method === 'POST' && post.url.includes('/cancel?parentChatId='),
    );
    assert.equal(parentCancels.length, 1);
    assert.equal(posts.some((post) => post.url.includes(`/${FIXED_RUN_ID}/cancel`)), false);
  });

  test('a spawn response arriving after parent Stop is cancelled too', async () => {
    let releaseSpawn!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const urls: string[] = [];
    setSubAgentApiFetchForTests(async (input, init) => {
      const url = String(input);
      urls.push(url);
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/api/agents')) {
        markStarted();
        return new Promise<Response>((resolve) => {
          releaseSpawn = resolve;
        });
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/cancel')) {
        return new Response(JSON.stringify({ ok: true, status: 'cancelled', state: { runs: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, state: { runs: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const spawning = spawnSubAgent({
      type: 'explore',
      task: 'scan',
      wait: false,
      parentChatId: CHAT_ID,
    });
    await started;
    cancelAllForParentChat(CHAT_ID);
    releaseSpawn(new Response(JSON.stringify({
      ok: true,
      runId: FIXED_RUN_ID,
      status: 'running',
      run: {
        runId: FIXED_RUN_ID,
        type: 'explore',
        task: 'scan',
        parentChatId: CHAT_ID,
        cwd: '/tmp',
        requestedAt: 1,
        phase: 'running',
        attempts: [],
        delivered: false,
      },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    await spawning;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(urls.some((url) => url.includes(`/${FIXED_RUN_ID}/cancel`)), true);
    assert.equal(listActiveSubAgentRuns().length, 0);
  });

  test('spawn without parentChatId prefers executor context over the active chat', async () => {
    const chatA = createEmptyChatObject('');
    chatA.id = 'chat-parent-a';
    const chatB = createEmptyChatObject('');
    chatB.id = 'chat-parent-b';
    setSessionStateForTests({
      version: 3,
      activeId: chatB.id,
      sidebarCollapsed: false,
      chats: [chatA, chatB],
    });
    setSubAgentExecutorContext({
      parentTurnId: 'turn-a',
      modeId: 'debug',
      parentChatId: chatA.id,
      parentToolCallId: 'call_a',
    });

    await spawnSubAgent({
      type: 'explore',
      task: 'scan',
      wait: false,
    });

    const spawn = posts.find((p) => p.method === 'POST' && p.url.endsWith('/api/agents'));
    assert.ok(spawn);
    const body = JSON.parse(spawn.body) as { parentChatId: string };
    assert.equal(body.parentChatId, chatA.id);
  });
});

// ── cancel origin wiring ─────────────────────────────────────────────────────

describe('cancel origin wiring (P10-L / MIN-777)', () => {
  const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  test('spawn wait:true does not pass a signal into waitForSubAgent', () => {
    const source = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'agents', 'orchestrator.ts'),
      'utf8',
    );
    assert.match(source, /return waitForSubAgent\(result\.runId\);/);
    assert.equal(/waitForSubAgent\(result\.runId\s*,/.test(source), false);
  });

  test('production parent stream defaults EventSource through withSessionToken', () => {
    const source = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'agents', 'orchestrator.ts'),
      'utf8',
    );
    assert.match(source, /function openAuthenticatedStream\(url: string\): EventStream/);
    assert.match(source, /new EventSource\(withSessionToken\(url\)\)/);
    assert.match(source, /\/api\/agents\/events\?parentChatId=/);
    assert.match(source, /\(openStream \?\? openAuthenticatedStream\)/);
  });

  test('executeSubAgentTool does not take the parent chat signal', () => {
    const source = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'tools', 'sub-agent-executor.ts'),
      'utf8',
    );
    assert.match(
      source,
      /export async function executeSubAgentTool\(\s*name: string,\s*args: Record<string, unknown>/,
    );
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'tools', 'client.ts'), 'utf8');
    assert.match(client, /executeSubAgentTool\(name, args\)/);
    assert.equal(client.includes('executeSubAgentTool(name, args, context)'), false);
  });

  test('parent Stop cancels the chat children without coupling runChatTurn to a turn signal', () => {
    const stop = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'chat', 'stop-generation.ts'),
      'utf8',
    );
    const chat = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'chat', 'run-turn-chat.ts'),
      'utf8',
    );
    assert.equal(stop.includes('cancelAllForParentChat'), true);
    assert.equal(chat.includes('cancelAllForParentTurn'), false);
  });

  test('rehydrateLiveParentSubAgents is a no-op when no live children', async () => {
    const fetches: string[] = [];
    setSubAgentApiFetchForTests(async (input) => {
      fetches.push(String(input));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await rehydrateLiveParentSubAgents(CHAT_ID);
    assert.deepEqual(fetches, []);
  });

  test('rehydrateLiveParentSubAgents folds a terminal run so it leaves the activity list', async () => {
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
    adoptSubAgentRunForTests(runningRun());
    assert.equal(listActiveSubAgentRuns().length, 1);
    setSubAgentApiFetchForTests(async (input) => {
      const url = String(input);
      if (url.includes('/transcript')) {
        return new Response(
          JSON.stringify({ ok: true, events: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes(`parentChatId=${encodeURIComponent(CHAT_ID)}`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            state: {
              runs: [
                {
                  runId: FIXED_RUN_ID,
                  type: 'explore',
                  task: 'scan',
                  parentChatId: CHAT_ID,
                  phase: 'passed',
                  attempts: [{ ended: true, summary: FIXED_SUMMARY }],
                  delivered: true,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: `unexpected ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await rehydrateLiveParentSubAgents(CHAT_ID);
    assert.equal(listActiveSubAgentRuns().length, 0);
  });
});

// ── fold merge ───────────────────────────────────────────────────────────────

describe('fold merge and Agent activity listing', () => {
  beforeEach(() => {
    resetSubAgentOrchestrator();
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
  });

  afterEach(() => {
    setSubAgentOpenStreamForTests(null);
    resetSubAgentOrchestrator();
  });

  test('empty prev summary does not mask attempt.ended', () => {
    const run = subAgentRunFromFold(
      {
        runId: FIXED_RUN_ID,
        type: 'explore',
        task: 'scan',
        parentChatId: CHAT_ID,
        phase: 'passed',
        attempts: [{ ended: true, summary: FIXED_SUMMARY, outcome: 'pass' }],
        delivered: true,
      },
      { summary: '', toolTurns: 0 },
    );
    assert.equal(run.summary, FIXED_SUMMARY);
    assert.equal(run.status, 'completed');
    assert.equal(run.structuredOutcome?.summary, FIXED_SUMMARY);
  });

  test('queued with zero attempts is listed; idle after a failed attempt is not', () => {
    adoptSubAgentRunForTests({
      ...runningRun(),
      status: 'queued',
      foldAttemptCount: 0,
    });
    assert.equal(listActiveSubAgentRuns().length, 1);

    resetSubAgentOrchestrator();
    const idle = subAgentRunFromFold(
      {
        runId: FIXED_RUN_ID,
        type: 'explore',
        task: 'scan',
        parentChatId: CHAT_ID,
        phase: 'idle',
        attempts: [{ ended: true, summary: 'nope', outcome: 'no_report' }],
        delivered: false,
      },
      { summary: '' },
    );
    assert.equal(idle.status, 'queued');
    assert.equal(idle.foldAttemptCount, 1);
    assert.equal(idle.summary, 'nope');
    adoptSubAgentRunForTests(idle);
    assert.equal(listActiveSubAgentRuns().length, 0);
  });

  test('passed, abandoned, and cancelled drop off Agent activity', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      resetSubAgentOrchestrator();
      adoptSubAgentRunForTests({ ...runningRun(), status });
      assert.equal(listActiveSubAgentRuns().length, 0, status);
    }
    adoptSubAgentRunForTests(runningRun());
    assert.equal(listActiveSubAgentRuns().length, 1);
  });
});

// ── transcript hydrate fills ─────────────────────────────────────────────────

describe('transcript hydrate fills Activity without the empty placeholder', () => {
  const PLACEHOLDER = 'Sub-agent completed with no text output.';

  beforeEach(() => {
    resetSubAgentOrchestrator();
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
  });

  afterEach(() => {
    setSubAgentOpenStreamForTests(null);
    resetSubAgentOrchestrator();
  });

  test('GET transcript with thinking + attempt_end + tools fills messages and a real summary', async () => {
    setSubAgentApiFetchForTests(async (input) => {
      const url = String(input);
      if (url.includes('/transcript')) {
        return new Response(
          JSON.stringify({
            ok: true,
            events: [
              { type: 'thinking', text: 'I should look at src/ next.' },
              {
                type: 'tool_call',
                name: 'read_file',
                id: 'call_read',
                arguments: { path: 'src/a.ts' },
              },
              { type: 'tool_result', id: 'call_read', content: 'export const a = 1;' },
              { type: 'attempt_end', name: 'pass', summary: 'Here is what I found in src/.' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes(`parentChatId=${encodeURIComponent(CHAT_ID)}`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            state: {
              runs: [
                {
                  runId: FIXED_RUN_ID,
                  type: 'explore',
                  task: 'scan',
                  parentChatId: CHAT_ID,
                  phase: 'passed',
                  attempts: [{ ended: true, summary: '', outcome: 'pass' }],
                  delivered: true,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: `unexpected ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await hydrateSubAgentRunsForParentChat(CHAT_ID);
    assert.equal(countOpenSubAgentStreams(), 0, 'terminal hydrate must not open EventSource');
    await hydrateSubAgentTranscript(FIXED_RUN_ID);
    const run = getSubAgentRun(FIXED_RUN_ID);
    assert.ok(run);
    assert.ok((run.messages?.length ?? 0) >= 3);
    const hasTool = run.messages.some(
      (row) => row && typeof row === 'object' && (row as { role?: string }).role === 'tool',
    );
    assert.equal(hasTool, true);
    const payload = buildSubAgentStatusPayload(run);
    assert.equal(payload.summary, 'Here is what I found in src/.');
    assert.notEqual(payload.summary, PLACEHOLDER);
  });
});

// ── hydrate caching (MIN-793 #3b/#3c) ────────────────────────────────────────

describe('hydrate does not refetch on every chat switch', () => {
  beforeEach(() => {
    resetSubAgentOrchestrator();
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
  });

  afterEach(() => {
    setSubAgentOpenStreamForTests(null);
    resetSubAgentOrchestrator();
  });

  /** Journal listing for CHAT_ID with one terminal run whose transcript is empty. */
  function installFetch(urls: string[]): void {
    setSubAgentApiFetchForTests(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/transcript')) {
        return new Response(JSON.stringify({ ok: true, events: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          state: {
            runs: [
              {
                runId: FIXED_RUN_ID,
                type: 'explore',
                task: 'scan',
                parentChatId: CHAT_ID,
                phase: 'passed',
                attempts: [{ ended: true, summary: '', outcome: 'pass' }],
                delivered: true,
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
  }

  test('repeat parent hydrates inside the TTL do not refetch the run list', async () => {
    const urls: string[] = [];
    installFetch(urls);

    await hydrateSubAgentRunsForParentChat(CHAT_ID);
    await hydrateSubAgentRunsForParentChat(CHAT_ID);
    await hydrateSubAgentRunsForParentChat(CHAT_ID);

    const lists = urls.filter((u) => u.includes('parentChatId='));
    assert.equal(lists.length, 1, 'switching back into a chat must reuse the hydrate');
  });

  test('force bypasses the TTL', async () => {
    const urls: string[] = [];
    installFetch(urls);

    await hydrateSubAgentRunsForParentChat(CHAT_ID);
    await hydrateSubAgentRunsForParentChat(CHAT_ID, { force: true });

    assert.equal(urls.filter((u) => u.includes('parentChatId=')).length, 2);
  });

  test('an empty transcript is not refetched on the next switch', async () => {
    const urls: string[] = [];
    installFetch(urls);

    await hydrateSubAgentRunsForParentChat(CHAT_ID);
    await hydrateSubAgentTranscript(FIXED_RUN_ID);
    await hydrateSubAgentTranscript(FIXED_RUN_ID);

    // The run has no mappable events, so `messages` stays empty; without the attempted
    // marker every switch would issue the request again, forever.
    assert.equal(urls.filter((u) => u.includes('/transcript')).length, 1);
  });
});

