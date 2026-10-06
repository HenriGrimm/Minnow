/**
 * Context compaction v2, Phase 2: checkpoints through the shared turn loop.
 *
 * A history-shaped store (UI-only `context` rows filtered on load, history
 * indices as row ids) stands in for the chat session store, so these cover the
 * rowShift / persistCursor invariant, reload, and prefix stability end to end.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { functionCallChunks, proseSseChunks } from '../../scripts/fake-model-server.mjs';
import { runTurn } from '../../server/runner/index.js';
import {
  COMPACTION_HEADER_PREFIX,
  RECALL_HISTORY_TOOL_NAME,
  fuseRecallRankings,
  runRecallHistory,
  latestCompactionCheckpoint,
  projectMessages,
  toPersistedCompaction,
  transcriptRowsWithIds,
} from '../../server/runner/compaction/index.js';
import { sanitizeToolPairing } from '../../server/runner/context-budget.js';
import { resetContextEstimateCalibrationForTests } from '../../server/runner/estimate-calibration.js';

const CHAT_ID = '22222222-2222-2222-2222-222222222222';
const SYSTEM = 'You are a coding agent.';
const WINDOW = 16_000;
const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};

const FILE_BODY = (n) => Array.from({ length: 150 }, (_, i) => `export const line_${n}_${i} = ${i};`).join('\n');

function sse(chunks) {
  return new Response(chunks.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function passthroughBatch(options) {
  const outcomes = [];
  for (const toolCall of options.toolCalls ?? []) {
    let args = {};
    try {
      args = JSON.parse(toolCall.function?.arguments || '{}');
    } catch {
      args = {};
    }
    const result = await options.execute(toolCall.function.name, args, { toolCallId: toolCall.id });
    const outcome = { toolCall, result };
    options.onToolDone?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

/** Chat-history-shaped store: context rows are UI-only, ids are history indices. */
function historyStore(history) {
  return {
    load() {
      const { rows, ids } = transcriptRowsWithIds(history);
      return { messages: rows, rowIds: ids, meta: {} };
    },
    append(_chatId, message) {
      history.push(message);
      return history.length - 1;
    },
    setMeta() {},
  };
}

function deps(store, post) {
  return {
    transcriptStore: store,
    postChatCompletions: post,
    runHeadlessToolBatch: passthroughBatch,
    resolveProvider: async () => ({ id: 'local-fake', label: 'Fake', baseUrl: 'http://127.0.0.1:9', apiKind: 'openai-v1', chatCompletionsPath: '/v1/chat/completions' }),
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
    resolveModelContextLimit: () => WINDOW,
    applyContextPolicy: async (input) => ({ applied: false, messages: input.messages }),
  };
}

/**
 * One send the way main chat does it: the user row is already in history,
 * the latest checkpoint is passed in, and a new checkpoint is appended as a row.
 */
async function send(history, userText, script, modelWindow = WINDOW) {
  history.push({ role: 'user', content: userText });
  const bodies = [];
  const compactions = [];
  let posts = 0;
  const store = historyStore(history);
  const result = await runTurn({
    chatId: CHAT_ID,
    seed: '',
    seedKind: 'continue',
    systemPrompt: SYSTEM,
    tools: [READ_TOOL],
    model: { providerId: 'local-fake', id: 'fake-model' },
    injectReportTool: false,
    nudgeToolUse: false,
    finalizeStructuredOutcome: false,
    transcript: store,
    limits: { modelContextLimit: modelWindow },
    compaction: latestCompactionCheckpoint(history)?.checkpoint ?? null,
    onCompaction: (event) => {
      compactions.push(event);
      history.push({
        role: 'context',
        policy: 'compact',
        droppedTurns: event.droppedTurns,
        summaryText: event.checkpoint.summary,
        createdAt: 1,
        compaction: toPersistedCompaction(event.checkpoint),
      });
    },
    execute: async (_name, args) => ({ content: FILE_BODY(String(args.path ?? '')) }),
    deps: deps(store, async (_provider, body) => {
      bodies.push({ messages: JSON.parse(JSON.stringify(body.messages)), tools: (body.tools ?? []).map((t) => t.function.name) });
      const step = script[posts] ?? { prose: 'Done.' };
      posts += 1;
      if (step.tool) return sse(functionCallChunks('read_file', { path: step.tool }, `call_${step.tool}`));
      return sse(proseSseChunks(step.prose));
    }),
  });
  assert.notEqual(result.outcome, 'crashed', JSON.stringify(result));
  return { bodies, compactions };
}

/** The projection a fresh load would send, from persisted history alone. */
function reloadProjection(history) {
  const { rows, ids } = transcriptRowsWithIds(history);
  const checkpoint = latestCompactionCheckpoint(history)?.checkpoint ?? null;
  const projected = projectMessages([{ role: 'system', content: SYSTEM }, ...rows], [null, ...ids], checkpoint);
  return sanitizeToolPairing(projected.messages);
}

function assertPairedHistory(history) {
  const rows = history.filter((m) => m.role !== 'context');
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.role !== 'assistant' || !row.tool_calls?.length) continue;
    for (const call of row.tool_calls) {
      assert.equal(rows[i + 1]?.role, 'tool', `no result after ${call.id}`);
      assert.equal(rows[i + 1]?.tool_call_id, call.id, `result for ${call.id} persisted out of place`);
    }
  }
  const ids = rows.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.equal(new Set(ids).size, ids.length, 'a tool row was persisted twice');
}

describe('compaction through runTurn', () => {
  afterEach(() => resetContextEstimateCalibrationForTests());

  test('a mid-loop checkpoint persists as a row; later rows land at the right indices; reload matches', async () => {
    const history = [];
    const reads = Array.from({ length: 9 }, (_, i) => ({ tool: `src/file${i}.ts` }));
    const first = await send(history, 'Refactor every module under src/ to the new logger.', [...reads, { prose: 'All modules use the new logger.' }]);

    assert.ok(first.compactions.length >= 1, 'the loop compacted mid-turn');
    const checkpointRows = history.filter((m) => m.role === 'context');
    assert.equal(checkpointRows.length, first.compactions.length);
    assertPairedHistory(history);
    assert.equal(history.filter((m) => m.role === 'tool').length, 9, 'every tool result persisted once');
    assert.equal(history.at(-1).content, 'All modules use the new logger.');

    // Every request stayed under the ceiling and kept the request verbatim.
    for (const body of first.bodies) {
      assert.ok(
        body.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.endsWith('Refactor every module under src/ to the new logger.')),
        'the request stays in every request',
      );
      assert.deepEqual(sanitizeToolPairing(body.messages), body.messages, 'pairing valid on the wire');
    }
    const afterCheckpoint = first.bodies.at(-1);
    assert.ok(afterCheckpoint.messages.some((m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER_PREFIX)));
    assert.ok(afterCheckpoint.tools.includes(RECALL_HISTORY_TOOL_NAME), 'recall is offered once a checkpoint exists');

    // The folded rows are still in history; the checkpoint names real history rows.
    const cp = latestCompactionCheckpoint(history).checkpoint;
    assert.equal(history[cp.foldThroughRow].role !== 'context', true);
    assert.ok(history.filter((m) => m.role !== 'context').length > afterCheckpoint.messages.length - 1);

    // Reload: the next send opens on exactly the persisted projection.
    const second = await send(history, 'Also add a unit test.', [{ prose: 'Added.' }]);
    const expected = reloadProjection(history.slice(0, history.findLastIndex((m) => m.role === 'user') + 1));
    assert.equal(JSON.stringify(second.bodies[0].messages), JSON.stringify(expected));
  });

  test('a larger window reopens previously folded source rows on resume', async () => {
    const history = [];
    await send(history, 'Refactor the logger.', [
      ...Array.from({ length: 9 }, (_, i) => ({ tool: `src/file${i}.ts` })),
      { prose: 'Paused.' },
    ]);
    assert.ok(latestCompactionCheckpoint(history));
    const resumed = await send(history, 'Continue the implementation.', [{ prose: 'Continuing.' }], 160_000);
    assert.equal(resumed.compactions.length, 0);
    assert.ok(!resumed.bodies[0].messages.some(m => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER_PREFIX)));
    assert.ok(resumed.bodies[0].messages.some(m => m.role === 'tool' && m.content.includes('line_src/file0.ts_0')));
  });

  test('two sends after a checkpoint share a byte-identical prefix', async () => {
    const history = [];
    await send(history, 'Refactor every module under src/ to the new logger.', [
      ...Array.from({ length: 9 }, (_, i) => ({ tool: `src/file${i}.ts` })),
      { prose: 'Done with the logger.' },
    ]);
    const a = await send(history, 'Thanks. What changed in file 8?', [{ prose: 'It now imports the logger.' }]);
    const b = await send(history, 'And file 7?', [{ prose: 'Same change.' }]);
    assert.equal(a.compactions.length, 0, 'under the high-water mark nothing re-compacts');
    assert.equal(b.compactions.length, 0);
    const prefixA = a.bodies[0].messages;
    assert.ok(prefixA.some((m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER_PREFIX)), 'the prefix carries the checkpoint');
    const prefixB = b.bodies[0].messages.slice(0, prefixA.length);
    assert.equal(JSON.stringify(prefixB), JSON.stringify(prefixA));
  });

  test('truncating history below the checkpoint (edit / retry) drops it', async () => {
    const history = [];
    await send(history, 'Refactor every module under src/ to the new logger.', [
      ...Array.from({ length: 9 }, (_, i) => ({ tool: `src/file${i}.ts` })),
      { prose: 'Done.' },
    ]);
    const at = history.findIndex((m) => m.role === 'context');
    assert.ok(at > 0);
    const edited = history.slice(0, at);
    assert.equal(latestCompactionCheckpoint(edited), null);
    assert.ok(!reloadProjection(edited).some((m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER_PREFIX)));
  });

  test('recall_history reads folded rows back verbatim', async () => {
    const history = [];
    const reads = Array.from({ length: 9 }, (_, i) => ({ tool: `src/file${i}.ts` }));
    let recallContent = '';
    const first = await send(history, 'Refactor every module under src/ to the new logger.', [...reads, { prose: 'Done.' }]);
    assert.ok(first.compactions.length >= 1);
    history.push({ role: 'user', content: 'What was on line 3 of file0?' });
    const store = historyStore(history);
    let posts = 0;
    await runTurn({
      chatId: CHAT_ID,
      seed: '',
      seedKind: 'continue',
      systemPrompt: SYSTEM,
      tools: [READ_TOOL],
      model: { providerId: 'local-fake', id: 'fake-model' },
      injectReportTool: false,
      nudgeToolUse: false,
      finalizeStructuredOutcome: false,
      transcript: store,
      limits: { modelContextLimit: WINDOW },
      compaction: latestCompactionCheckpoint(history).checkpoint,
      onEvent: (event) => {
        if (event.type === 'tool_result' && event.name === RECALL_HISTORY_TOOL_NAME) recallContent = event.content;
      },
      deps: deps(store, async () => {
        posts += 1;
        if (posts === 1) return sse(functionCallChunks(RECALL_HISTORY_TOOL_NAME, { query: 'line_src/file0.ts_3' }, 'call_recall'));
        return sse(proseSseChunks('Line 3 exports a constant.'));
      }),
    });
    assert.match(recallContent, /match/);
    assert.match(recallContent, /#\d+ tool read_file src\/file0\.ts/);
  });

  test('recallHistory hook gets the unprojected rows; a call is answered before any checkpoint', async () => {
    const history = [
      { role: 'user', content: 'Remember the deploy token is rotated weekly.' },
      { role: 'assistant', content: 'Noted: weekly rotation.' },
      { role: 'user', content: 'What did I say about the token?' },
    ];
    const store = historyStore(history);
    let posts = 0;
    let hookEntries = null;
    let recallContent = '';
    await runTurn({
      chatId: CHAT_ID,
      seed: '',
      seedKind: 'continue',
      systemPrompt: SYSTEM,
      tools: [READ_TOOL],
      model: { providerId: 'local-fake', id: 'fake-model' },
      injectReportTool: false,
      nudgeToolUse: false,
      finalizeStructuredOutcome: false,
      transcript: store,
      limits: { modelContextLimit: WINDOW },
      compaction: null,
      recallHistory: async ({ args, entries }) => {
        hookEntries = entries;
        return runRecallHistory(entries, args, { ranking: [1] });
      },
      onEvent: (event) => {
        if (event.type === 'tool_result' && event.name === RECALL_HISTORY_TOOL_NAME) recallContent = event.content;
      },
      deps: deps(store, async () => {
        posts += 1;
        if (posts === 1) return sse(functionCallChunks(RECALL_HISTORY_TOOL_NAME, { query: 'token rotation' }, 'call_recall'));
        return sse(proseSseChunks('Weekly.'));
      }),
    });
    assert.ok(Array.isArray(hookEntries), 'the hook answered the call');
    assert.deepEqual(hookEntries.slice(0, 3).map((e) => e.id), [0, 1, 2]);
    assert.match(recallContent, /> #0 user: Remember the deploy token/);
    assert.match(recallContent, /> #1 assistant: Noted: weekly rotation/);
  });
});

describe('recall ranking fusion', () => {
  test('reciprocal-rank fusion rewards rows both rankers agree on', () => {
    const fused = fuseRecallRankings([[5, 2, 9], [2, 7]]);
    assert.equal(fused[0].id, 2);
    assert.deepEqual(new Set(fused.map((f) => f.id)), new Set([5, 2, 9, 7]));
  });

  test('an external ranking surfaces rows the local ranker misses, and drops unknown ids', () => {
    const entries = [
      { id: 0, row: { role: 'user', content: 'reconciliation job keeps failing' } },
      { id: 1, row: { role: 'assistant', content: 'retries added' } },
    ];
    // "reconciling" is not a local token match for "reconciliation"; FTS (stemmed) ranked it.
    const local = runRecallHistory(entries, { query: 'reconciling' });
    assert.match(local, /^No earlier rows match/);
    const fused = runRecallHistory(entries, { query: 'reconciling' }, { ranking: [0, 42] });
    assert.match(fused, /> #0 user: reconciliation job/);
    assert.doesNotMatch(fused, /#42/);
  });
});
