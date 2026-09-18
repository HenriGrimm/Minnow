/**
 * MIN-584 — sub-agent EventSources must not leak across spawn→complete
 * cycles or chat-switch hydrates (HTTP/1.1 six-socket pool).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  countOpenSubAgentStreams,
  hydrateSubAgentRunsForParentChat,
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
import type { EventStream } from '../../src/agents/sub-agent-client.ts';

const CHAT_A = '11111111-1111-1111-1111-aaaaaaaaaaaa';
const CHAT_B = '11111111-1111-1111-1111-bbbbbbbbbbbb';

/** In-memory EventSource that records close() (Node has no EventSource). */
class CountingStream implements EventStream {
  closeCount = 0;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closeCount += 1;
  }

  emit(type: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

function passedFold(runId: string, parentChatId: string): Record<string, unknown> {
  return {
    runId,
    type: 'explore',
    task: 'scan',
    parentChatId,
    cwd: '/tmp',
    requestedAt: 1,
    phase: 'passed',
    attempts: [{ ended: true, summary: 'done', outcome: 'pass' }],
    delivered: true,
  };
}

function runningFold(runId: string, parentChatId: string): Record<string, unknown> {
  return {
    runId,
    type: 'explore',
    task: 'scan',
    parentChatId,
    cwd: '/tmp',
    requestedAt: 1,
    phase: 'running',
    attempts: [],
    delivered: false,
  };
}

describe('sub-agent SSE stream lifecycle (MIN-584)', () => {
  const streams: CountingStream[] = [];
  let spawnCount = 0;

  beforeEach(() => {
    streams.length = 0;
    spawnCount = 0;
    resetSubAgentOrchestrator();
    setStorageModeForTests('localStorage');
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides({});
    setSubAgentOpenStreamForTests(() => {
      const stream = new CountingStream();
      streams.push(stream);
      return stream;
    });
    setSubAgentApiFetchForTests(async (input, init) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      if (method === 'GET' && url.includes('/transcript')) {
        return new Response(JSON.stringify({ ok: true, events: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'GET' && url.includes('parentChatId=')) {
        const parentChatId = new URL(url, 'http://local.invalid').searchParams.get('parentChatId') ?? '';
        const runs =
          parentChatId === CHAT_A
            ? [
                passedFold('run-term-1', CHAT_A),
                passedFold('run-term-2', CHAT_A),
                runningFold('run-live-a', CHAT_A),
              ]
            : [passedFold('run-term-b1', CHAT_B), passedFold('run-term-b2', CHAT_B)];
        return new Response(JSON.stringify({ ok: true, state: { runs } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && url.endsWith('/api/agents') && !url.includes('/cancel')) {
        spawnCount += 1;
        const runId = `run-spawn-${spawnCount}`;
        return new Response(
          JSON.stringify({
            ok: true,
            runId,
            status: 'running',
            run: runningFold(runId, CHAT_A),
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

  test('spawn then terminal snapshot leaves zero open streams after N cycles', async () => {
    for (let i = 1; i <= 6; i += 1) {
      const result = await spawnSubAgent({
        type: 'explore',
        task: 'scan',
        wait: false,
        parentChatId: CHAT_A,
        parentTurnId: 'turn-1',
      });
      assert.equal(countOpenSubAgentStreams(), 1, `cycle ${i} should hold one live stream`);
      const stream = streams[i - 1];
      assert.ok(stream, `cycle ${i} should have opened a stream`);
      stream.emit('snapshot', {
        seq: 1,
        parentChatId: CHAT_A,
        run: passedFold(result.runId, CHAT_A),
        status: 'completed',
      });
      assert.equal(countOpenSubAgentStreams(), 0, `cycle ${i} must close on terminal`);
      assert.ok(stream.closeCount >= 1, `cycle ${i} EventSource.close must run`);
    }
    assert.equal(streams.length, 6);
  });

  test('hydrate connects only the live run, not journal-terminal history', async () => {
    await hydrateSubAgentRunsForParentChat(CHAT_A);
    assert.equal(countOpenSubAgentStreams(), 1);
    assert.equal(streams.length, 1);

    await hydrateSubAgentRunsForParentChat(CHAT_B);
    assert.equal(countOpenSubAgentStreams(), 1, 'terminal-only parent must not open sockets');
    assert.equal(streams.length, 1);
  });

  test('concurrent children of one chat share one physical stream', async () => {
    const first = await spawnSubAgent({
      type: 'explore',
      task: 'scan one',
      wait: false,
      parentChatId: CHAT_A,
      parentTurnId: 'turn-1',
    });
    const second = await spawnSubAgent({
      type: 'explore',
      task: 'scan two',
      wait: false,
      parentChatId: CHAT_A,
      parentTurnId: 'turn-1',
    });

    assert.equal(streams.length, 1, 'siblings must multiplex onto one EventSource');
    assert.equal(countOpenSubAgentStreams(), 1);

    streams[0].emit('snapshot', {
      seq: 10,
      parentChatId: CHAT_A,
      run: passedFold(first.runId, CHAT_A),
      status: 'completed',
    });
    assert.equal(countOpenSubAgentStreams(), 1, 'the sibling still owns the shared stream');
    assert.equal(streams[0].closeCount, 0);

    streams[0].emit('snapshot', {
      seq: 11,
      parentChatId: CHAT_A,
      run: passedFold(second.runId, CHAT_A),
      status: 'completed',
    });
    assert.equal(countOpenSubAgentStreams(), 0);
    assert.equal(streams[0].closeCount, 1);
  });

  test('re-hydrating two terminal-only parents never opens a stream', async () => {
    await hydrateSubAgentRunsForParentChat(CHAT_B);
    await hydrateSubAgentRunsForParentChat(CHAT_B);
    assert.equal(countOpenSubAgentStreams(), 0);
    assert.equal(streams.length, 0);
  });
});
