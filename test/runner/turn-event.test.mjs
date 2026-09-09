/**
 * P10-B — TurnEvent contract (MIN-767).
 *
 * One test per new member, plus parseError / abort `tool_result` and ordering.
 * Chat-shaped options (no report tool, no nudge, no finalization) so a prose
 * or tool round is not followed by extra inner completions.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  createFakeModelServer,
  proseSseChunks,
} from '../../scripts/fake-model-server.mjs';
import {
  createMemoryTranscriptStore,
  isHighFrequencyTurnEvent,
  shouldEmitSubAgentLiveTurnEvent,
  postChatCompletionsHttp,
  runTurn,
} from '../../server/runner/index.js';
import {
  executeToolCallBatch,
  STOPPED_TOOL_MSG,
} from '../../server/runner/tool-batch.js';

const CHAT_UUID = '550e8400-e29b-41d4-a716-446655440000';

const DATETIME_TOOL = {
  type: 'function',
  function: {
    name: 'get_datetime',
    description: 'Get the current date and time',
    parameters: { type: 'object', properties: {} },
  },
};

function functionCallChunks(name, args, toolCallId = 'call_1') {
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

function reasoningThenProseChunks(reasoning, prose) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: prose } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

function reasoningXmlToolChunks(reasoning, name, args) {
  const xml = `<tool_call>{"name":${JSON.stringify(name)},"arguments":${JSON.stringify(args)}}</tool_call>`;
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: xml } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

function reasoningQwenXmlToolChunks(reasoning, name) {
  const xml = `<tool_call>\n<function=${name}>\n</function>\n</tool_call>`;
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: xml } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

function reasoningThenToolChunks(reasoning, name, args, toolCallId = 'call_1') {
  const argStr = typeof args === 'string' ? args : JSON.stringify(args);
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
    `data: ${JSON.stringify({
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
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

function proseSseChunksWithUsage(text, usage) {
  const delta = JSON.stringify({
    choices: [{ delta: { content: text } }],
  });
  const finish = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage,
    stats: { tokens_per_second: 12 },
    model: 'fake-model',
  });
  return [
    `data: ${delta}\n\n`,
    `data: ${finish}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

async function passthroughBatch(options) {
  const toolCalls = options.toolCalls ?? [];
  const outcomes = [];
  for (const toolCall of toolCalls) {
    let args = {};
    try {
      args = JSON.parse(toolCall.function?.arguments || '{}');
    } catch {
      args = {};
    }
    const result = await options.execute(toolCall.function.name, args, {
      toolCallId: toolCall.id,
    });
    const outcome = { toolCall, result };
    options.onToolDone?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

function stubDeps(baseUrl, overrides = {}) {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: postChatCompletionsHttp,
    runHeadlessToolBatch: runHeadlessToolBatchDefault,
    resolveProvider: async () => ({
      id: 'local-fake',
      label: 'Local fake',
      baseUrl,
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
    ...overrides,
  };
}

async function runHeadlessToolBatchDefault(options) {
  return passthroughBatch(options);
}

const CHAT_SHAPED = {
  injectReportTool: false,
  nudgeToolUse: false,
  finalizeStructuredOutcome: false,
};

async function withFake(scenario, fn) {
  const fake = createFakeModelServer({ scenario });
  fake.reset();
  const port = await fake.listen(0);
  try {
    await fn(`http://127.0.0.1:${port}`, fake);
  } finally {
    await fake.close();
  }
}

describe('isHighFrequencyTurnEvent', () => {
  const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  test('classifies stream chrome and token deltas, not round_end', () => {
    for (const type of [
      'stream_meta',
      'phase',
      'round_start',
      'reasoning_end',
      'token',
      'delta',
      'reasoning_delta',
    ]) {
      assert.equal(isHighFrequencyTurnEvent(type), true, type);
    }
    assert.equal(isHighFrequencyTurnEvent('round_end'), false);
    assert.equal(isHighFrequencyTurnEvent('tool_call'), false);
    assert.equal(isHighFrequencyTurnEvent('tool_result'), false);
    assert.equal(isHighFrequencyTurnEvent('thinking'), false);
  });

  test('transcripts.js uses the runner predicate, not a second list', () => {
    const source = fs.readFileSync(
      path.join(PROJECT_ROOT, 'server', 'orchestrator', 'transcripts.js'),
      'utf8',
    );
    assert.match(source, /isHighFrequencyTurnEvent/);
    assert.equal(source.includes("type === 'token' || type === 'delta'"), false);
  });

  test('live SSE forwards phase; only the disk transcript still drops it (P10-L)', () => {
    assert.equal(shouldEmitSubAgentLiveTurnEvent('phase'), true);
    assert.equal(shouldEmitSubAgentLiveTurnEvent('tool_call'), true);
    assert.equal(shouldEmitSubAgentLiveTurnEvent('thinking'), true);
    for (const type of ['stream_meta', 'delta', 'token', 'reasoning_delta', 'round_start', 'reasoning_end']) {
      assert.equal(shouldEmitSubAgentLiveTurnEvent(type), false, type);
      assert.equal(isHighFrequencyTurnEvent(type), true, type);
    }
    assert.equal(isHighFrequencyTurnEvent('phase'), true);

    // The transcript is the durable record and phase says nothing durable.
    const transcripts = fs.readFileSync(
      path.join(PROJECT_ROOT, 'server', 'orchestrator', 'transcripts.js'),
      'utf8',
    );
    assert.match(transcripts, /isHighFrequencyTurnEvent/);
    assert.equal(transcripts.includes('shouldEmitSubAgentLiveTurnEvent'), false);

    // Boards take the same live filter as sub-agents. `phase` is the only frame
    // that says the model went back to writing, and without it a card held the
    // tool it had just finished and read as stuck.
    for (const dir of ['orchestrator', 'sub-agents']) {
      const source = fs.readFileSync(
        path.join(PROJECT_ROOT, 'server', dir, 'effector-runner.js'),
        'utf8',
      );
      assert.match(source, /shouldEmitSubAgentLiveTurnEvent/, dir);
    }
  });
});

describe('TurnEvent members (P10-B)', () => {
  test('phase: forwards generating then thinking then generating', { timeout: 20_000 }, async () => {
    await withFake([{ emit: reasoningThenProseChunks('hmm', 'Hello.') }], async (baseUrl) => {
      const events = [];
      await runTurn({
        chatId: CHAT_UUID,
        seed: 'Hi.',
        tools: [],
        model: { providerId: 'local-fake', id: 'fake-model' },
        onEvent: (event) => events.push(event),
        deps: stubDeps(baseUrl),
        ...CHAT_SHAPED,
      });
      const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase);
      assert.ok(phases.includes('generating'), 'expected generating phase');
      assert.ok(phases.includes('thinking'), 'expected thinking phase');
    });
  });

  test('reasoning_end: fires once when the round leaves the reasoning channel', { timeout: 20_000 }, async () => {
    await withFake([{ emit: reasoningThenProseChunks('plan first', 'Done.') }], async (baseUrl) => {
      const events = [];
      await runTurn({
        chatId: CHAT_UUID,
        seed: 'Hi.',
        tools: [],
        model: { providerId: 'local-fake', id: 'fake-model' },
        onEvent: (event) => events.push(event),
        deps: stubDeps(baseUrl),
        ...CHAT_SHAPED,
      });
      const ends = events.filter((e) => e.type === 'reasoning_end');
      assert.equal(ends.length, 1);
      const types = events.map((e) => e.type);
      assert.ok(types.indexOf('thinking') < types.indexOf('reasoning_end'));
      assert.ok(types.indexOf('reasoning_end') < types.lastIndexOf('delta') || types.includes('delta'));
    });
  });

  test('stream_meta: forwards merged usage and stats', { timeout: 20_000 }, async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
    await withFake([{ emit: proseSseChunksWithUsage('Hi.', usage) }], async (baseUrl) => {
      const events = [];
      await runTurn({
        chatId: CHAT_UUID,
        seed: 'Hi.',
        tools: [],
        model: { providerId: 'local-fake', id: 'fake-model' },
        onEvent: (event) => events.push(event),
        deps: stubDeps(baseUrl),
        ...CHAT_SHAPED,
      });
      const metas = events.filter((e) => e.type === 'stream_meta');
      assert.ok(metas.length >= 1, 'expected at least one stream_meta');
      const withUsage = metas.find((e) => e.usage?.prompt_tokens === 10);
      assert.ok(withUsage, 'expected usage on stream_meta');
      assert.equal(withUsage.stats?.tokens_per_second, 12);
      assert.equal(withUsage.model, 'fake-model');
      assert.equal(withUsage.finishReason, 'stop');
    });
  });

  test('round_start and round_end: one pair for a prose round', { timeout: 20_000 }, async () => {
    await withFake([{ emit: proseSseChunks('Hello.') }], async (baseUrl) => {
      const events = [];
      await runTurn({
        chatId: CHAT_UUID,
        seed: 'Hi.',
        tools: [],
        model: { providerId: 'local-fake', id: 'fake-model' },
        onEvent: (event) => events.push(event),
        deps: stubDeps(baseUrl),
        ...CHAT_SHAPED,
      });
      const starts = events.filter((e) => e.type === 'round_start');
      const ends = events.filter((e) => e.type === 'round_end');
      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1);
      assert.equal(starts[0].index, 0);
      assert.equal(ends[0].index, 0);
      assert.equal(ends[0].text, 'Hello.');
      assert.equal(ends[0].toolCallCount, 0);
      assert.equal(typeof ends[0].t0, 'number');
      assert.equal(typeof ends[0].tEnd, 'number');
      assert.ok(ends[0].tFirst === null || typeof ends[0].tFirst === 'number');
    });
  });

  test('ordering: round_start then reasoning_end then tools then round_end', { timeout: 20_000 }, async () => {
    await withFake(
      [
        {
          match: { nth: 0 },
          emit: reasoningThenToolChunks('think', 'get_datetime', {}, 'call_dt'),
        },
        { emit: proseSseChunks('It is noon.') },
      ],
      async (baseUrl) => {
        const events = [];
        await runTurn({
          chatId: CHAT_UUID,
          seed: 'What time is it?',
          tools: [DATETIME_TOOL],
          model: { providerId: 'local-fake', id: 'fake-model' },
          onEvent: (event) => events.push(event),
          deps: stubDeps(baseUrl, { runHeadlessToolBatch: passthroughBatch }),
          execute: async () => ({ content: '2026-09-01T12:00:00.000Z' }),
          ...CHAT_SHAPED,
        });
        const types = events.map((e) => e.type);
        const start0 = types.indexOf('round_start');
        const reasoningEnd = types.indexOf('reasoning_end');
        const streaming = types.indexOf('tool_streaming');
        const call = types.indexOf('tool_call');
        const result = types.indexOf('tool_result');
        const end0 = types.indexOf('round_end');
        assert.ok(start0 !== -1 && end0 !== -1);
        assert.ok(start0 < reasoningEnd, 'round_start before reasoning_end');
        assert.ok(reasoningEnd < call, 'reasoning_end before tool_call');
        if (streaming !== -1) {
          assert.ok(reasoningEnd <= streaming, 'reasoning_end before or at tool_streaming');
          assert.ok(streaming < call, 'tool_streaming before tool_call');
        }
        assert.ok(call < result, 'tool_call before tool_result');
        assert.ok(result < end0, 'tool_result before round_end');
        assert.equal(events[end0].toolCallCount, 1);
      },
    );
  });

  test('recovers a JSON tool_call from native reasoning_content (MTPLX)', { timeout: 20_000 }, async () => {
    await withFake(
      [
        {
          match: { nth: 0 },
          emit: reasoningXmlToolChunks('I should check the clock.', 'get_datetime', {}),
        },
        { emit: proseSseChunks('It is noon.') },
      ],
      async (baseUrl) => {
        const events = [];
        await runTurn({
          chatId: CHAT_UUID,
          seed: 'What time is it?',
          tools: [DATETIME_TOOL],
          model: { providerId: 'local-fake', id: 'fake-model' },
          onEvent: (event) => events.push(event),
          deps: stubDeps(baseUrl, { runHeadlessToolBatch: passthroughBatch }),
          execute: async () => ({ content: '2026-09-01T12:00:00.000Z' }),
          ...CHAT_SHAPED,
        });
        const thinking = events.filter((e) => e.type === 'thinking').at(-1);
        assert.equal(thinking?.text?.includes('tool_call'), false, 'markup must not stay in Thoughts');
        assert.match(String(thinking?.text ?? ''), /I should check the clock/);
        const streaming = events.find((e) => e.type === 'tool_streaming');
        assert.equal(streaming?.name, 'get_datetime');
        const call = events.find((e) => e.type === 'tool_call');
        assert.equal(call?.name, 'get_datetime');
        const result = events.find((e) => e.type === 'tool_result');
        assert.ok(result, 'tool must execute');
      },
    );
  });

  test('recovers a Qwen XML tool_call from native reasoning_content', { timeout: 20_000 }, async () => {
    await withFake(
      [
        {
          match: { nth: 0 },
          emit: reasoningQwenXmlToolChunks('Need the clock.', 'get_datetime'),
        },
        { emit: proseSseChunks('It is noon.') },
      ],
      async (baseUrl) => {
        const events = [];
        await runTurn({
          chatId: CHAT_UUID,
          seed: 'What time is it?',
          tools: [DATETIME_TOOL],
          model: { providerId: 'local-fake', id: 'fake-model' },
          onEvent: (event) => events.push(event),
          deps: stubDeps(baseUrl, { runHeadlessToolBatch: passthroughBatch }),
          execute: async () => ({ content: '2026-09-01T12:00:00.000Z' }),
          ...CHAT_SHAPED,
        });
        const thinking = events.filter((e) => e.type === 'thinking').at(-1);
        assert.equal(thinking?.text?.includes('function='), false);
        assert.equal(events.some((e) => e.type === 'tool_call' && e.name === 'get_datetime'), true);
      },
    );
  });

  test('tool_result carries attachments and codeChange', { timeout: 20_000 }, async () => {
    await withFake(
      [
        {
          match: { nth: 0 },
          emit: functionCallChunks('get_datetime', {}, 'call_dt'),
        },
        { emit: proseSseChunks('It is noon.') },
      ],
      async (baseUrl) => {
        const events = [];
        await runTurn({
          chatId: CHAT_UUID,
          seed: 'What time is it?',
          tools: [DATETIME_TOOL],
          model: { providerId: 'local-fake', id: 'fake-model' },
          onEvent: (event) => events.push(event),
          deps: stubDeps(baseUrl, { runHeadlessToolBatch: passthroughBatch }),
          execute: async () => ({
            content: 'noon',
            attachments: [{ kind: 'image', url: 'data:image/png;base64,xx' }],
            codeChange: { additions: 1, deletions: 0 },
          }),
          ...CHAT_SHAPED,
        });
        const result = events.find((e) => e.type === 'tool_result');
        assert.ok(result);
        assert.equal(result.content, 'noon');
        assert.equal(result.attachments.length, 1);
        assert.equal(result.codeChange.additions, 1);
      },
    );
  });

  test('tool_result fires for a parseError outcome', { timeout: 20_000 }, async () => {
    await withFake(
      [
        {
          match: { nth: 0 },
          emit: functionCallChunks('get_datetime', '{', 'call_bad'),
        },
        { emit: proseSseChunks('Recovered.') },
      ],
      async (baseUrl) => {
        let executed = 0;
        const events = [];
        await runTurn({
          chatId: CHAT_UUID,
          seed: 'Call it.',
          tools: [DATETIME_TOOL],
          model: { providerId: 'local-fake', id: 'fake-model' },
          onEvent: (event) => events.push(event),
          deps: stubDeps(baseUrl, {
            runHeadlessToolBatch: (opts) =>
              executeToolCallBatch({ ...opts, constrained: true }),
          }),
          execute: async () => {
            executed += 1;
            return { content: 'should not run' };
          },
          ...CHAT_SHAPED,
        });
        assert.equal(executed, 0, 'parseError must not call execute');
        const result = events.find((e) => e.type === 'tool_result' && e.id === 'call_bad');
        assert.ok(result, 'parseError must still emit tool_result');
        assert.equal(result.isError, true);
        assert.match(String(result.content), /JSON/i);
      },
    );
  });

  test('tool_result fires for an abort-fill outcome', { timeout: 20_000 }, async () => {
    await withFake(
      [
        {
          match: { nth: 0 },
          emit: functionCallChunks('get_datetime', {}, 'call_aborted'),
        },
        { emit: proseSseChunks('Stopped.') },
      ],
      async (baseUrl) => {
        let executed = 0;
        const events = [];
        const aborted = new AbortController();
        aborted.abort();
        await runTurn({
          chatId: CHAT_UUID,
          seed: 'Call it.',
          tools: [DATETIME_TOOL],
          model: { providerId: 'local-fake', id: 'fake-model' },
          onEvent: (event) => events.push(event),
          deps: stubDeps(baseUrl, {
            runHeadlessToolBatch: (opts) =>
              executeToolCallBatch({ ...opts, signal: aborted.signal }),
          }),
          execute: async () => {
            executed += 1;
            return { content: 'should not run' };
          },
          ...CHAT_SHAPED,
        });
        assert.equal(executed, 0, 'abort fill must not call execute');
        const result = events.find((e) => e.type === 'tool_result' && e.id === 'call_aborted');
        assert.ok(result, 'abort fill must still emit tool_result');
        assert.equal(result.content, STOPPED_TOOL_MSG);
        assert.equal(result.isError, true);
      },
    );
  });

  function burstProseChunks(parts, finishReason = 'stop') {
    // One TCP dump of many content deltas — used to leave the UI on the first word.
    return [
      ...parts.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
      'event: end\ndata: {"status":"complete"}\n\n',
    ];
  }

  function proseThenToolArgChunks(proseParts, name, argFragments, toolCallId = 'call_save') {
    // Prose first, then a long argument stream (the save_file screenshot case).
    const chunks = proseParts.map(
      (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: toolCallId,
                  type: 'function',
                  function: { name, arguments: '' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
    );
    for (const frag of argFragments) {
      chunks.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: frag } }],
              },
            },
          ],
        })}\n\n`,
      );
    }
    chunks.push(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    );
    chunks.push('event: end\ndata: {"status":"complete"}\n\n');
    return chunks;
  }

  test('burst content deltas emit the full prose, not only the first token', { timeout: 20_000 }, async () => {
    // Leading-only persist used to paint "Paths" and drop the rest of this burst.
    const parts = ['Paths', ' verified.', ' Writing the plan file now.'];
    const full = parts.join('');
    await withFake([{ emit: burstProseChunks(parts) }], async (baseUrl) => {
      const events = [];
      await runTurn({
        chatId: CHAT_UUID,
        seed: 'Write the plan.',
        tools: [],
        model: { providerId: 'local-fake', id: 'fake-model' },
        onEvent: (event) => events.push(event),
        deps: stubDeps(baseUrl),
        ...CHAT_SHAPED,
      });
      const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
      assert.ok(
        deltas.some((text) => text === full),
        `expected a live delta with full prose, got ${JSON.stringify(deltas)}`,
      );
    });
  });

  test('full prose is live before a long tool-argument stream finishes', { timeout: 20_000 }, async () => {
    // Screenshot case: first word + Calling… until save_file args finished.
    const parts = ['Paths', ' verified.', ' Writing the plan file now.'];
    const full = parts.join('');
    const argFrags = ['{"path":', '"documentation/plans/x.md",', '"content":"', 'x'.repeat(200), '"}'];
    await withFake(
      [
        { match: { nth: 0 }, emit: proseThenToolArgChunks(parts, 'get_datetime', argFrags, 'call_dt') },
        { emit: proseSseChunks('Done.') },
      ],
      async (baseUrl) => {
        const events = [];
        let proseBeforeExecute = '';
        await runTurn({
          chatId: CHAT_UUID,
          seed: 'Write the plan.',
          tools: [DATETIME_TOOL],
          model: { providerId: 'local-fake', id: 'fake-model' },
          onEvent: (event) => events.push(event),
          deps: stubDeps(baseUrl, { runHeadlessToolBatch: passthroughBatch }),
          execute: async () => {
            const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
            proseBeforeExecute = deltas.find((text) => text === full) ?? deltas[deltas.length - 1] ?? '';
            return { content: 'ok' };
          },
          ...CHAT_SHAPED,
        });
        assert.equal(proseBeforeExecute, full, 'full prose must be live before execute');
        const streamingAt = events.findIndex((e) => e.type === 'tool_streaming');
        assert.ok(streamingAt >= 0, 'expected tool_streaming');
        const deltasBeforeStreaming = events
          .slice(0, streamingAt + 1)
          .filter((e) => e.type === 'delta')
          .map((e) => e.text);
        assert.ok(
          deltasBeforeStreaming.includes(full),
          `expected full prose at or before tool_streaming, got ${JSON.stringify(deltasBeforeStreaming)}`,
        );
      },
    );
  });
});
