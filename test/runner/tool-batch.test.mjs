/**
 * P2-D — server-side tool-batch semantics (MIN-701).
 *
 * Port of the renderer `execute-tool-batch` / `parallel-tool-policy` tests.
 * Do not invent new concurrency rules; these assertions must stay aligned
 * with `test/tools/execute-tool-batch.test.mts`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  executeToolCallBatch,
  STOPPED_TOOL_MSG,
} from '../../server/runner/tool-batch.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  toolCallTimeoutMs,
} from '../../server/runner/tool-timeouts.js';
import {
  isParallelSafeTool,
  MAX_PARALLEL_READ_TOOLS,
  partitionToolCalls,
} from '../../server/runner/parallel-tool-policy.js';

function tc(name, id = name, args = '{}') {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('isParallelSafeTool (server port)', () => {
  test('cacheable read tools are parallel-safe', () => {
    assert.equal(isParallelSafeTool('read_file'), true);
    assert.equal(isParallelSafeTool('grep'), true);
    assert.equal(isParallelSafeTool('git_status'), true);
    assert.equal(isParallelSafeTool('web_search'), true);
  });

  test('extra read utilities are parallel-safe', () => {
    assert.equal(isParallelSafeTool('get_datetime'), true);
    assert.equal(isParallelSafeTool('calculate'), true);
    assert.equal(isParallelSafeTool('wikipedia_search'), true);
    assert.equal(isParallelSafeTool('list_sub_agents'), true);
    assert.equal(isParallelSafeTool('get_sub_agent_status'), true);
  });

  test('mutating and interactive tools are sequential', () => {
    assert.equal(isParallelSafeTool('save_file'), false);
    assert.equal(isParallelSafeTool('git_commit'), false);
    assert.equal(isParallelSafeTool('execute_command'), false);
    assert.equal(isParallelSafeTool('ask_question'), false);
    assert.equal(isParallelSafeTool('spawn_sub_agent'), false);
    assert.equal(isParallelSafeTool('issue_update'), false);
  });

  test('clipboard and unknown-prefix tools are sequential', () => {
    assert.equal(isParallelSafeTool('read_clipboard'), false);
    assert.equal(isParallelSafeTool('write_clipboard'), false);
    assert.equal(isParallelSafeTool('browser_navigate'), false);
    assert.equal(isParallelSafeTool('mcp__foo'), false);
    assert.equal(isParallelSafeTool('plugin__bar'), false);
  });

  test('wiki mutators and destructive tools are sequential', () => {
    assert.equal(isParallelSafeTool('brain_write_page'), false);
    assert.equal(isParallelSafeTool('manage_brain'), false);
  });
});

describe('partitionToolCalls (server port)', () => {
  test('all parallel-safe calls form one parallel segment', () => {
    const calls = [tc('grep', 'a'), tc('read_file', 'b')];
    const segments = partitionToolCalls(calls);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].kind, 'parallel');
    assert.deepEqual(
      segments[0].calls.map((c) => c.id),
      ['a', 'b'],
    );
  });

  test('mutator splits parallel runs and preserves order', () => {
    const calls = [
      tc('grep', 'a'),
      tc('read_file', 'b'),
      tc('save_file', 'c'),
      tc('git_status', 'd'),
    ];
    const segments = partitionToolCalls(calls);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].kind, 'parallel');
    assert.deepEqual(
      segments[0].calls.map((c) => c.id),
      ['a', 'b'],
    );
    assert.equal(segments[1].kind, 'sequential');
    assert.equal(segments[1].calls[0].id, 'c');
    assert.equal(segments[2].kind, 'parallel');
    assert.equal(segments[2].calls[0].id, 'd');
  });

  test('single tool yields one segment', () => {
    const segments = partitionToolCalls([tc('save_file')]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].kind, 'sequential');
  });

  test('empty input yields no segments', () => {
    assert.deepEqual(partitionToolCalls([]), []);
  });
});

describe('executeToolCallBatch (server port)', () => {
  test('MAX_PARALLEL_READ_TOOLS matches the renderer constant', () => {
    assert.equal(MAX_PARALLEL_READ_TOOLS, 6);
  });

  test('parallel segment runs faster than sequential sum', async () => {
    const calls = [tc('grep', 'a'), tc('read_file', 'b'), tc('git_status', 'c')];
    const started = [];
    const start = Date.now();

    await executeToolCallBatch({
      toolCalls: calls,
      execute: async (name) => {
        started.push(name);
        await delay(40);
        return { content: name };
      },
    });

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `expected parallel ~40ms, got ${elapsed}ms`);
    assert.equal(started.length, 3);
  });

  test('mutator splits segments and runs writes after reads', async () => {
    const order = [];
    const calls = [
      tc('grep', 'a'),
      tc('read_file', 'b'),
      tc('save_file', 'c'),
      tc('git_status', 'd'),
    ];

    await executeToolCallBatch({
      toolCalls: calls,
      execute: async (name) => {
        order.push(name);
        await delay(5);
        return { content: name };
      },
    });

    assert.deepEqual(order, ['grep', 'read_file', 'save_file', 'git_status']);
  });

  test('outcomes preserve original tool_calls order', async () => {
    const calls = [tc('grep', 'z'), tc('save_file', 'y'), tc('read_file', 'x')];
    const outcomes = await executeToolCallBatch({
      toolCalls: calls,
      execute: async (name) => ({ content: name }),
    });

    assert.deepEqual(
      outcomes.map((o) => o.toolCall.id),
      ['z', 'y', 'x'],
    );
  });

  test('parse errors do not block siblings in a parallel segment', async () => {
    const calls = [tc('grep', 'a', '{bad'), tc('read_file', 'b')];
    const executed = [];

    const outcomes = await executeToolCallBatch({
      toolCalls: calls,
      constrained: true,
      execute: async (name) => {
        executed.push(name);
        return { content: 'ok' };
      },
    });

    assert.equal(outcomes[0].parseError, 'Tool arguments were not valid JSON.');
    assert.equal(outcomes[1].result?.content, 'ok');
    assert.deepEqual(executed, ['read_file']);
  });

  test('aborted signal skips not-yet-started calls', async () => {
    const controller = new AbortController();
    const calls = [tc('grep', 'a'), tc('save_file', 'b'), tc('read_file', 'c')];

    const outcomes = await executeToolCallBatch({
      toolCalls: calls,
      signal: controller.signal,
      execute: async (name) => {
        if (name === 'grep') {
          controller.abort();
        }
        await delay(5);
        return { content: name };
      },
    });

    assert.equal(outcomes[0].result?.content, 'grep');
    assert.equal(outcomes[1].result?.content, STOPPED_TOOL_MSG);
    assert.equal(outcomes[2].result?.content, STOPPED_TOOL_MSG);
  });

  test('abort past the pool worker cap leaves no gaps', async () => {
    const controller = new AbortController();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const calls = ids.map((id) => tc('read_file', id));
    const done = [];

    const outcomes = await executeToolCallBatch({
      toolCalls: calls,
      signal: controller.signal,
      execute: async (name) => {
        controller.abort();
        await delay(5);
        return { content: name };
      },
      onToolDone: (outcome) => done.push(outcome.toolCall.id),
    });

    assert.equal(outcomes.length, ids.length);
    assert.deepEqual(
      outcomes.map((o) => o.toolCall.id),
      ids,
    );
    for (const outcome of outcomes) {
      assert.ok(outcome.result || outcome.parseError, `no result for ${outcome.toolCall.id}`);
    }
    assert.deepEqual([...done].sort(), [...ids].sort());
    assert.equal(done.length, ids.length);
  });

  test('abort part-way through mutating calls still reports every call', async () => {
    const controller = new AbortController();
    const calls = [tc('save_file', 'a'), tc('save_file', 'b'), tc('save_file', 'c')];
    const done = [];

    const outcomes = await executeToolCallBatch({
      toolCalls: calls,
      signal: controller.signal,
      execute: async (name) => {
        controller.abort();
        return { content: name };
      },
      onToolDone: (outcome) => done.push(outcome.toolCall.id),
    });

    assert.deepEqual(done, ['a', 'b', 'c']);
    assert.equal(outcomes[1].result?.content, STOPPED_TOOL_MSG);
    assert.equal(outcomes[2].result?.content, STOPPED_TOOL_MSG);
  });
});

/**
 * A tool call that never settles used to strand the whole turn: `executeToolCallBatch`
 * awaits every call and the turn awaits the batch, so one hung promise wedged the attempt
 * with no recovery. Observed live — `repo_map` blocking on a full code reindex left an
 * orchestrator board sitting on one tool call indefinitely.
 */
describe('tool call liveness', () => {
  test('a call that never settles is abandoned with a recoverable result', async () => {
    const outcomes = await executeToolCallBatch({
      toolCalls: [tc('repo_map')],
      toolTimeoutMs: 25,
      execute: () => new Promise(() => {}),
    });

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].abandoned, 'timeout');
    assert.match(outcomes[0].result.content, /repo_map did not return within/);
  });

  test('one hung call does not strand the rest of the batch', async () => {
    const calls = [tc('read_file', 'a'), tc('repo_map', 'b'), tc('grep', 'c')];

    const outcomes = await executeToolCallBatch({
      toolCalls: calls,
      toolTimeoutMs: 25,
      execute: async (name) => {
        if (name === 'repo_map') return new Promise(() => {});
        return { content: name };
      },
    });

    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0].result.content, 'read_file');
    assert.equal(outcomes[1].abandoned, 'timeout');
    assert.equal(outcomes[2].result.content, 'grep');
  });

  test('a call inside the ceiling is untouched', async () => {
    const outcomes = await executeToolCallBatch({
      toolCalls: [tc('read_file')],
      toolTimeoutMs: 5000,
      execute: async () => {
        await delay(5);
        return { content: 'ok' };
      },
    });

    assert.equal(outcomes[0].result.content, 'ok');
    assert.equal(outcomes[0].abandoned, undefined);
  });

  test('abort stops waiting on a call that ignores it', async () => {
    const controller = new AbortController();
    const calls = [tc('save_file', 'a'), tc('save_file', 'b')];

    const outcomes = await executeToolCallBatch({
      toolCalls: calls,
      signal: controller.signal,
      execute: (name) => {
        controller.abort();
        return new Promise(() => {});
      },
    });

    assert.equal(outcomes[0].abandoned, 'aborted');
    assert.equal(outcomes[0].result.content, STOPPED_TOOL_MSG);
    assert.equal(outcomes[1].result.content, STOPPED_TOOL_MSG);
  });

  test('an aborted call that finishes inside the grace window keeps its result', async () => {
    const controller = new AbortController();

    const outcomes = await executeToolCallBatch({
      toolCalls: [tc('save_file', 'a')],
      signal: controller.signal,
      execute: async (name) => {
        controller.abort();
        await delay(5);
        return { content: name };
      },
    });

    assert.equal(outcomes[0].result.content, 'save_file');
    assert.equal(outcomes[0].abandoned, undefined);
  });

  test('every tool has a ceiling except the ones that own their own liveness', () => {
    assert.equal(toolCallTimeoutMs('repo_map'), DEFAULT_TOOL_TIMEOUT_MS);
    assert.equal(toolCallTimeoutMs('execute_command'), DEFAULT_TOOL_TIMEOUT_MS);
    assert.equal(toolCallTimeoutMs('some_future_tool'), DEFAULT_TOOL_TIMEOUT_MS);
    assert.equal(toolCallTimeoutMs('ask_question'), null);
    assert.equal(toolCallTimeoutMs('spawn_sub_agent'), null);
  });
});
