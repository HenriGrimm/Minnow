/**
 * P10-M / MIN-778 — live frames are parent-keyed but must paint per run.
 *
 * Two concurrent sub-agents under one parent used to render each other's
 * tool names and phases: emitLive is keyed on parentChatId, and onLive
 * parsed only the inner TurnEvent. This file drives that leak through a
 * fake stream and asserts isolation. Stale attemptId after retry is the
 * same consume path.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  createSubAgentRunClient,
  liveFrameBelongsToRun,
  shouldPaintLiveFrame,
  type EventStream,
} from '../../src/agents/sub-agent-client.ts';
import {
  getSubAgentRun,
  resetSubAgentOrchestrator,
  setSubAgentApiFetchForTests,
  setSubAgentOpenStreamForTests,
  spawnSubAgent,
} from '../../src/agents/orchestrator.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import {
  resetSubAgentConfigCache,
  setRuntimeSubAgentOverrides,
} from '../../src/agents/sub-agent-config.ts';

const PARENT = '11111111-1111-1111-1111-222222222222';
const RUN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ATTEMPT_A1 = 'attempt-a-1';
const ATTEMPT_A2 = 'attempt-a-2';
const ATTEMPT_B1 = 'attempt-b-1';

/** In-memory EventSource stand-in. Tests push frames; Node has no EventSource. */
class FakeStream implements EventStream {
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {}

  emit(type: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

function runningSnapshot(
  runId: string,
  attempts: Array<{ attemptId: string; ended: boolean }>,
): Record<string, unknown> {
  return {
    seq: 1,
    parentChatId: PARENT,
    run: {
      runId,
      type: 'explore',
      task: runId === RUN_A ? 'scan A' : 'scan B',
      parentChatId: PARENT,
      cwd: '/tmp',
      requestedAt: 1,
      phase: 'running',
      attempts,
      abandonedReason: null,
      abandonedEvidence: null,
      cancelledReason: null,
      delivered: false,
      deliveredSkipReason: null,
      nudged: false,
      parentTurnId: 'turn-1',
      parentToolCallId: null,
      model: null,
    },
  };
}

describe('liveFrameBelongsToRun (P10-M identity)', () => {
  test('drops a sibling taskId and a missing taskId', () => {
    assert.equal(
      liveFrameBelongsToRun({ taskId: RUN_B, attemptId: ATTEMPT_B1 }, RUN_A, null),
      false,
    );
    assert.equal(liveFrameBelongsToRun({ attemptId: ATTEMPT_A1 }, RUN_A, null), false);
  });

  test('accepts this run before any fold, then drops a stale attempt after retry', () => {
    assert.equal(
      liveFrameBelongsToRun({ taskId: RUN_A, attemptId: ATTEMPT_A1 }, RUN_A, null),
      true,
    );
    const retried = {
      attempts: [
        { attemptId: ATTEMPT_A1, ended: true },
        { attemptId: ATTEMPT_A2, ended: false },
      ],
    };
    assert.equal(
      liveFrameBelongsToRun({ taskId: RUN_A, attemptId: ATTEMPT_A1 }, RUN_A, retried),
      false,
    );
    assert.equal(
      liveFrameBelongsToRun({ taskId: RUN_A, attemptId: ATTEMPT_A2 }, RUN_A, retried),
      true,
    );
  });
});

describe('sub-agent live frames isolate per run (P10-M)', () => {
  let bus!: FakeStream;

  beforeEach(() => {
    bus = new FakeStream();
    resetSubAgentOrchestrator();
    setStorageModeForTests('localStorage');
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides({});
    // One parent-scoped bus for both run EventSources — the leak P10-M closes.
    setSubAgentOpenStreamForTests(() => bus);
    let spawns = 0;
    setSubAgentApiFetchForTests(async (input, init) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      if (method === 'GET' && url.includes('/transcript')) {
        return new Response(
          JSON.stringify({ ok: true, events: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'POST' && url.endsWith('/api/agents') && !url.includes('/cancel')) {
        spawns += 1;
        const runId = spawns === 1 ? RUN_A : RUN_B;
        return new Response(
          JSON.stringify({
            ok: true,
            runId,
            status: 'running',
            run: {
              runId,
              type: 'explore',
              task: spawns === 1 ? 'scan A' : 'scan B',
              parentChatId: PARENT,
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
      return new Response(JSON.stringify({ ok: false, error: `unexpected ${method} ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    setSubAgentApiFetchForTests(null);
    setSubAgentOpenStreamForTests(null);
    resetSubAgentOrchestrator();
    setRuntimeSubAgentOverrides(null);
    resetSubAgentConfigCache();
    setStorageModeForTests(null);
  });

  test('two concurrent runs on one parent keep their own tool names and phases', async () => {
    const first = await spawnSubAgent({
      type: 'explore',
      task: 'scan A',
      wait: false,
      parentChatId: PARENT,
      parentTurnId: 'turn-1',
    });
    const second = await spawnSubAgent({
      type: 'explore',
      task: 'scan B',
      wait: false,
      parentChatId: PARENT,
      parentTurnId: 'turn-1',
    });
    assert.equal(first.runId, RUN_A);
    assert.equal(second.runId, RUN_B);

    bus.emit('live', {
      taskId: RUN_B,
      attemptId: ATTEMPT_B1,
      event: { type: 'tool_call', name: 'write_file' },
    });
    bus.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'thinking', text: 'looking at src/' },
    });
    bus.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'tool_call', name: 'read_file' },
    });
    bus.emit('live', {
      taskId: RUN_B,
      attemptId: ATTEMPT_B1,
      event: { type: 'thinking', text: 'sibling thought' },
    });

    const a = getSubAgentRun(RUN_A);
    const b = getSubAgentRun(RUN_B);
    assert.equal(a?.liveCurrentToolName, 'read_file');
    assert.equal(a?.livePhase, 'tools');
    assert.equal(a?.livePartialReasoning, 'looking at src/');
    assert.equal(b?.liveCurrentToolName, 'write_file');
    assert.equal(b?.livePhase, 'thinking');
    assert.equal(b?.livePartialReasoning, 'sibling thought');
  });

  test('terminal snapshot drops the generating tail', async () => {
    await spawnSubAgent({
      type: 'explore',
      task: 'scan A',
      wait: false,
      parentChatId: PARENT,
      parentTurnId: 'turn-1',
    });
    bus.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'delta', text: 'streaming a summary…' },
    });
    assert.equal(getSubAgentRun(RUN_A)?.livePartialText, 'streaming a summary…');

    bus.emit('snapshot', {
      seq: 9,
      parentChatId: PARENT,
      run: {
        ...runningSnapshot(RUN_A, [
          { attemptId: ATTEMPT_A1, ended: true, outcome: 'pass', summary: 'done' },
        ]).run,
        phase: 'passed',
        attempts: [
          { attemptId: ATTEMPT_A1, ended: true, outcome: 'pass', summary: 'done' },
        ],
      },
    });
    const settled = getSubAgentRun(RUN_A);
    assert.equal(settled?.status, 'completed');
    assert.equal(settled?.livePartialText, undefined);
    assert.equal(settled?.livePhase, undefined);
  });
});

describe('stale attemptId does not paint (P10-M)', () => {
  test('a previous attempt of the same run is ignored after retry', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit(
      'snapshot',
      runningSnapshot(RUN_A, [
        { attemptId: ATTEMPT_A1, ended: true },
        { attemptId: ATTEMPT_A2, ended: false },
      ]),
    );

    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'tool_call', name: 'stale_tool' },
    });
    assert.equal(client.getLive().toolName, null);
    assert.equal(client.getLive().phase, null);

    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A2,
      event: { type: 'tool_call', name: 'grep' },
    });
    assert.equal(client.getLive().toolName, 'grep');
    assert.equal(client.getLive().phase, 'tools');
    client.close();
  });
});

describe('live frames after cancel vs genuine end (P10-L)', () => {
  test('full cumulative prose and thoughts survive live frames and a terminal transition', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit('snapshot', runningSnapshot(RUN_A, [{ attemptId: ATTEMPT_A1, ended: false }]));
    const thought = 'Start of thoughts. ' + 'Detailed evidence. '.repeat(60) + ' End of thoughts.';
    const text = 'Start of response. ' + 'Verified results. '.repeat(60) + ' End of response.';
    const live = (event: unknown) => stream.emit('live', { taskId: RUN_A, attemptId: ATTEMPT_A1, event });
    live({ type: 'thinking', text: thought });
    assert.equal(client.getLive().thinking, thought);
    live({ type: 'delta', text });
    assert.equal(client.getLive().partialText, text);
    stream.emit('event', { type: 'run.cancelled', runId: RUN_A, reason: 'user', seq: 2 });
    stream.emit('event', { type: 'attempt.ended', runId: RUN_A, attemptId: ATTEMPT_A1, outcome: 'crashed', seq: 3 });
    assert.ok(client.getLive().messages.some((row) => (row as { reasoning?: string }).reasoning === thought));
    assert.ok(client.getLive().messages.some((row) => (row as { content?: string }).content === text));
    client.close();
  });

  test('a fetched history fills missing text without losing frames received while loading', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit('snapshot', runningSnapshot(RUN_A, [{ attemptId: ATTEMPT_A1, ended: false }]));
    stream.emit('live', { taskId: RUN_A, attemptId: ATTEMPT_A1, event: { type: 'tool_call', name: 'read_file', id: 'read' } });
    client.seedMessages([
      { role: 'assistant', content: '', reasoning: 'Earlier thoughts, fetched from disk.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    ]);
    stream.emit('live', { taskId: RUN_A, attemptId: ATTEMPT_A1, event: { type: 'tool_result', id: 'read', content: 'source' } });
    const messages = client.getLive().messages as Array<{ reasoning?: string; role?: string }>;
    assert.equal(messages[0].reasoning, 'Earlier thoughts, fetched from disk.');
    assert.equal(messages.at(-1)?.role, 'tool');
    assert.equal(messages.length, 3);
    client.close();
  });

  test('prose stays visible while tool arguments stream and is retained on the tool call', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit('snapshot', runningSnapshot(RUN_A, [{ attemptId: ATTEMPT_A1, ended: false }]));
    const live = (event: unknown) => stream.emit('live', { taskId: RUN_A, attemptId: ATTEMPT_A1, event });
    live({ type: 'delta', text: 'Here is the actual progress response.' });
    live({ type: 'tool_streaming', name: 'read_file' });
    assert.equal(client.getLive().partialText, 'Here is the actual progress response.');
    live({ type: 'tool_call', id: 'read', name: 'read_file' });
    const messages = client.getLive().messages as Array<{ content?: string }>;
    assert.equal(messages[0].content, 'Here is the actual progress response.');
    assert.equal(client.getLive().partialText, '');
    client.close();
  });
  test('paints a live frame during an open attempt after cancel is journaled', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit(
      'snapshot',
      runningSnapshot(RUN_A, [{ attemptId: ATTEMPT_A1, ended: false }]),
    );
    stream.emit('event', {
      v: 1,
      seq: 2,
      type: 'run.cancelled',
      runId: RUN_A,
      reason: 'user',
    });
    assert.equal(client.getRun()?.phase, 'cancelling');
    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'tool_call', name: 'read_file' },
    });
    assert.equal(client.getLive().toolName, 'read_file');
    assert.equal(client.getLive().phase, 'tools');
    client.close();
  });

  test('drops a replayed live frame after a genuine end', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit('snapshot', {
      seq: 3,
      parentChatId: PARENT,
      run: {
        ...runningSnapshot(RUN_A, [
          { attemptId: ATTEMPT_A1, ended: true },
        ]).run,
        phase: 'passed',
        attempts: [{ attemptId: ATTEMPT_A1, ended: true, outcome: 'pass' }],
      },
    });
    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'tool_call', name: 'stale_tool' },
    });
    assert.equal(client.getLive().toolName, null);
    assert.equal(client.getLive().phase, null);
    assert.equal(
      shouldPaintLiveFrame(
        { taskId: RUN_A, attemptId: ATTEMPT_A1, event: { type: 'tool_call' } },
        RUN_A,
        {
          phase: 'passed',
          attempts: [{ attemptId: ATTEMPT_A1, ended: true, outcome: 'pass' }],
        },
      ),
      false,
    );
    client.close();
  });

  test('translates phase so the pre-tool window is not generating-by-fallback', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit(
      'snapshot',
      runningSnapshot(RUN_A, [{ attemptId: ATTEMPT_A1, ended: false }]),
    );
    assert.equal(client.getLive().phase, null);
    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'phase', phase: 'thinking' },
    });
    assert.equal(client.getLive().phase, 'thinking');
    client.close();
  });

  test('zero-attempt cancel does not paint generating onto the card', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit('snapshot', {
      seq: 2,
      parentChatId: PARENT,
      run: {
        ...runningSnapshot(RUN_A, []).run,
        phase: 'cancelled',
        cancelledReason: 'user',
        attempts: [],
      },
    });
    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'phase', phase: 'generating' },
    });
    assert.equal(client.getRun()?.phase, 'cancelled');
    assert.equal(client.getLive().phase, null);
    client.close();
  });

  test('tool_call appends a message row; delta sets partialText', () => {
    const stream = new FakeStream();
    const client = createSubAgentRunClient(RUN_A, { openStream: () => stream });
    client.connect();
    stream.emit(
      'snapshot',
      runningSnapshot(RUN_A, [{ attemptId: ATTEMPT_A1, ended: false }]),
    );
    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'tool_call', name: 'read_file', id: 'call_read', arguments: { path: 'src/a.ts' } },
    });
    const afterTool = client.getLive();
    assert.equal(afterTool.messages.length, 1);
    const row = afterTool.messages[0] as { role?: string; tool_calls?: Array<{ function?: { name?: string } }> };
    assert.equal(row.role, 'assistant');
    assert.equal(row.tool_calls?.[0]?.function?.name, 'read_file');
    assert.equal(afterTool.partialText, '');

    stream.emit('live', {
      taskId: RUN_A,
      attemptId: ATTEMPT_A1,
      event: { type: 'delta', text: 'Here is what I found in src/.' },
    });
    assert.equal(client.getLive().partialText, 'Here is what I found in src/.');
    client.close();
  });
});
