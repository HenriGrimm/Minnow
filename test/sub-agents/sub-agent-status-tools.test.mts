import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  buildSubAgentStatusPayload,
  resetSubAgentOrchestrator,
  setSubAgentApiFetchForTests,
  setSubAgentOpenStreamForTests,
} from '../../src/agents/orchestrator.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';
import { resetSubAgentConfigCache, setRuntimeSubAgentOverrides } from '../../src/agents/sub-agent-config.ts';
import {
  resetSubAgentRunIdFactory,
  setSubAgentRunIdFactory,
} from '../../src/agents/sub-agent-run-id.ts';
import {
  executeSubAgentTool,
  setSubAgentExecutorContext,
} from '../../src/tools/sub-agent-executor.ts';
import {
  FIXED_RUN_ID,
  nextFixedRunId,
  resetRunIdCounter,
} from './test-helpers.mts';

describe('sub-agent status tools', () => {
  test('buildSubAgentStatusPayload omits legacy outcome while run is active', () => {
    const run: SubAgentRun = {
      runId: FIXED_RUN_ID,
      type: 'explore',
      task: 'in progress',
      status: 'running',
      parentChatId: 'chat-1',
      parentToolCallId: null,
      parentTurnId: 'turn-live',
      summary: '',
      error: null,
      startedAt: '2026-05-19T12:00:00.000Z',
      endedAt: null,
      toolTurns: 1,
      maxToolTurns: 12,
      cancelled: false,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'Still working on the file list.' },
      ],
    };
    const payload = buildSubAgentStatusPayload(run);
    assert.equal(payload.outcome, undefined);
    assert.equal(payload.summary, 'Still working on the file list.');
    assert.notEqual(payload.summary, 'Sub-agent completed with no text output.');
  });

  test('buildSubAgentStatusPayload uses message preview instead of the empty-summary placeholder', () => {
    const run: SubAgentRun = {
      runId: FIXED_RUN_ID,
      type: 'explore',
      task: 'done',
      status: 'completed',
      parentChatId: 'chat-1',
      parentToolCallId: null,
      parentTurnId: 'turn-done',
      summary: '',
      error: null,
      startedAt: '2026-05-19T12:00:00.000Z',
      endedAt: '2026-05-19T12:01:00.000Z',
      toolTurns: 1,
      maxToolTurns: 12,
      cancelled: false,
      messages: [
        { role: 'assistant', content: 'Here is what I found in src/.' },
      ],
    };
    const payload = buildSubAgentStatusPayload(run);
    assert.equal(payload.summary, 'Here is what I found in src/.');
    assert.notEqual(payload.summary, 'Sub-agent completed with no text output.');
  });

  beforeEach(() => {
    resetSubAgentOrchestrator();
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides({ defaultModel: { providerId: 'fixture', modelId: 'fixture-model' } });
    resetSubAgentRunIdFactory();
    resetRunIdCounter();
    setSubAgentRunIdFactory(() => FIXED_RUN_ID);
    setSubAgentExecutorContext(null);
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
    let n = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      if (method === 'GET' && url.includes('/transcript')) {
        return new Response(JSON.stringify({ ok: true, events: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && !url.includes('/cancel')) {
        n += 1;
        const req = JSON.parse(String(init?.body ?? '{}')) as {
          type: string;
          task: string;
          parentChatId: string;
          parentTurnId?: string;
          parentToolCallId?: string;
        };
        const runId =
          n === 1 && req.task !== 'long' && req.task !== 'queued task'
            ? FIXED_RUN_ID
            : `11111111-1111-1111-1111-${String(n).padStart(12, '0')}`;
        const terminal = req.task !== 'long' && req.task !== 'queued task';
        const run = {
          runId,
          type: req.type,
          task: req.task,
          parentChatId: req.parentChatId,
          parentTurnId: req.parentTurnId ?? null,
          parentToolCallId: req.parentToolCallId ?? null,
          cwd: '/tmp',
          requestedAt: 1,
          phase: terminal ? 'passed' : 'running',
          attempts: terminal
            ? [
                {
                  attemptId: 'a1',
                  ended: true,
                  outcome: 'pass',
                  summary: 'FIXED_SUMMARY',
                  seedKind: 'initial',
                  seed: {},
                },
              ]
            : [],
          delivered: false,
        };
        return new Response(
          JSON.stringify({
            ok: true,
            runId,
            status: terminal ? 'completed' : 'running',
            run,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: `unexpected ${method} ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    setSubAgentApiFetchForTests(fakeFetch);
  });

  test('list_sub_agents requires parent chat context', async () => {
    const out = await executeSubAgentTool('list_sub_agents', {});
    assert.match(out, /Error: list_sub_agents requires an active parent chat/);
  });

  test('list_sub_agents returns runs for current parent turn', async () => {
    setSubAgentExecutorContext({
      parentTurnId: 'parent-turn-aa',
      modeId: 'orchestrate',
      parentChatId: 'chat-1',
    });

    const spawnOut = await executeSubAgentTool('spawn_sub_agent', {
      type: 'explore',
      task: 'do the thing',
      wait: true,
    });
    assert.ok(spawnOut.includes(FIXED_RUN_ID));

    const listOut = await executeSubAgentTool('list_sub_agents', {});
    const parsed = JSON.parse(listOut) as { runs?: Array<{ runId: string; status: string }> };
    assert.ok(Array.isArray(parsed.runs));
    assert.equal(parsed.runs?.length, 1);
    assert.equal(parsed.runs?.[0]?.runId, FIXED_RUN_ID);
    assert.equal(parsed.runs?.[0]?.status, 'completed');
  });

  test('get_sub_agent_status returns payload after completion', async () => {
    setSubAgentExecutorContext({
      parentTurnId: 'parent-turn-bb',
      modeId: 'orchestrate',
      parentChatId: 'chat-2',
    });

    const spawnOut = await executeSubAgentTool('spawn_sub_agent', {
      type: 'explore',
      task: 'inspect me',
      wait: true,
    });
    assert.ok(spawnOut.includes('FIXED_SUMMARY'));

    const statusOut = await executeSubAgentTool('get_sub_agent_status', {
      run_id: FIXED_RUN_ID,
    });
    const body = JSON.parse(statusOut) as {
      runId: string;
      status: string;
      summary: string;
      lastMessagePreview: string;
    };
    assert.equal(body.runId, FIXED_RUN_ID);
    assert.equal(body.status, 'completed');
    assert.equal(body.summary, 'FIXED_SUMMARY');
    // The fold does not carry the transcript; lastMessagePreview is an overlay.
  });

  test('get_sub_agent_status allows run from an earlier parent turn in the same chat', async () => {
    setSubAgentExecutorContext({
      parentTurnId: 'turn-a',
      modeId: 'build',
      parentChatId: 'chat-session-1',
    });
    const first = await executeSubAgentTool('spawn_sub_agent', {
      type: 'explore',
      task: 'task a',
      wait: true,
    });
    assert.ok(first.includes(FIXED_RUN_ID));

    setSubAgentExecutorContext({
      parentTurnId: 'turn-b',
      modeId: 'build',
      parentChatId: 'chat-session-1',
    });
    const statusOut = await executeSubAgentTool('get_sub_agent_status', {
      run_id: FIXED_RUN_ID,
    });
    const body = JSON.parse(statusOut) as { runId: string; status: string };
    assert.equal(body.runId, FIXED_RUN_ID);
    assert.equal(body.status, 'completed');
  });

  test('get_sub_agent_status rejects run from another chat', async () => {
    setSubAgentExecutorContext({
      parentTurnId: 'turn-a',
      modeId: 'build',
      parentChatId: 'chat-a',
    });
    const first = await executeSubAgentTool('spawn_sub_agent', {
      type: 'explore',
      task: 'task a',
      wait: true,
    });
    assert.ok(first.includes(FIXED_RUN_ID));

    setSubAgentExecutorContext({
      parentTurnId: 'turn-b',
      modeId: 'build',
      parentChatId: 'chat-b',
    });
    const denied = await executeSubAgentTool('get_sub_agent_status', {
      run_id: FIXED_RUN_ID,
    });
    assert.match(denied, /not visible from this chat/);
  });

  test('list_sub_agents shows queued run while another blocks the slot', async () => {
    setSubAgentRunIdFactory(() => nextFixedRunId());
    resetRunIdCounter();

    setRuntimeSubAgentOverrides({ globalMaxConcurrent: 1, defaultModel: { providerId: 'fixture', modelId: 'fixture-model' } });

    setSubAgentExecutorContext({
      parentTurnId: 'turn-parallel',
      modeId: 'orchestrate',
      parentChatId: 'chat-parallel',
    });

    const r1 = await executeSubAgentTool('spawn_sub_agent', {
      type: 'explore',
      task: 'long',
      wait: false,
    });
    const id1 = (JSON.parse(r1) as { runId: string }).runId;

    const r2 = await executeSubAgentTool('spawn_sub_agent', {
      type: 'explore',
      task: 'queued task',
      wait: false,
    });
    const id2 = (JSON.parse(r2) as { runId: string }).runId;

    const listMid = JSON.parse(await executeSubAgentTool('list_sub_agents', {})) as {
      runs: Array<{ runId: string; status: string }>;
    };
    assert.equal(listMid.runs.length, 2);
    const s1 = listMid.runs.find((r) => r.runId === id1)?.status;
    const s2 = listMid.runs.find((r) => r.runId === id2)?.status;
    assert.ok(s1 === 'running' || s1 === 'queued');
    assert.ok(s2 === 'running' || s2 === 'queued');
  });
});
