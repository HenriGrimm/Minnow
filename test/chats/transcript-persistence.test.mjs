import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createMemoryTranscriptStore } from '../../server/runner/transcript-store.js';
import { runTurn } from '../../server/runner/run-turn.js';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';
import { emptyCompactionState } from '../../server/runner/compaction/merge.js';

function response({ tool = false } = {}) {
  const name = typeof tool === 'string' ? tool : 'save_file';
  const delta = tool ? { tool_calls: [{ index: 0, id: 'write-once', type: 'function',
    function: { name, arguments: name === 'report_outcome' ? '{"outcome":"pass","summary":"Done"}' : '{"path":"evidence.txt"}' } }] } : { content: 'Done.' };
  const chunk = JSON.stringify({ choices: [{ delta }] });
  const finish = JSON.stringify({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] });
  return new Response(`data: ${chunk}\n\ndata: ${finish}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

function dependencies(store, post) {
  return {
    transcriptStore: store, postChatCompletions: post,
    async runHeadlessToolBatch(options) {
      const outcomes = [];
      for (const toolCall of options.toolCalls ?? []) {
        const result = await options.execute(toolCall.function.name, JSON.parse(toolCall.function.arguments), { toolCallId: toolCall.id });
        const outcome = { toolCall, result };
        options.onToolDone?.(outcome);
        outcomes.push(outcome);
      }
      return outcomes;
    },
    resolveProvider: async () => ({ id: 'fixture', apiKind: 'openai-v1' }),
    getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => ({ preset: {}, maxTokens: 100 }),
    resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => null, applyContextPolicy: async input => ({ applied: false, messages: input.messages }),
  };
}
const model = { providerId: 'fixture', id: 'model' };
const options = { chatId: 'chat', seed: 'Do the work', seedKind: 'continue', model, tools: [],
  injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false };

test('an authoritative late-row failure cannot disappear into a best-effort event callback', async () => {
  const memory = createMemoryTranscriptStore();
  memory.append('chat', { role: 'user', content: 'Do the work' });
  let observed = false;
  const store = { ...memory, observePersisted(_id, event) {
    if (event.type === 'round_end') { observed = true; throw new Error('durable patch failed'); }
  } };
  const result = await runTurn({ ...options, deps: dependencies(store, async () => response()), onEvent() { throw new Error('UI listener gone'); } });
  assert.equal(observed, true);
  assert.equal(result.outcome, 'crashed');
  assert.equal(result.failure.code, 'transcript_persistence_failed');
  assert.match(result.error, /durable patch failed/);
});

test('lost tool-result persistence fails the execution and never repeats its real scratch-file effect', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-transcript-effect-'));
  const output = path.join(scratch, 'evidence.txt');
  const memory = createMemoryTranscriptStore();
  memory.append('chat', { role: 'user', content: 'Do the work' });
  let effects = 0;
  let requests = 0;
  const store = { ...memory, append(id, row) {
    if (row.role === 'tool') throw new Error('tool result commit lost');
    return memory.append(id, row);
  } };
  try {
    const result = await runTurn({ ...options, cwd: scratch,
      tools: [{ type: 'function', function: { name: 'save_file', description: 'Save', parameters: { type: 'object', properties: {} } } }],
      deps: dependencies(store, async () => { requests++; return response({ tool: true }); }),
      execute: async () => { effects++; fs.writeFileSync(output, 'committed side effect'); return { content: 'Saved' }; },
    });
    assert.equal(result.outcome, 'crashed');
    assert.match(result.error, /tool result commit lost/);
    assert.equal(effects, 1);
    assert.equal(requests, 1);
    assert.equal(fs.readFileSync(output, 'utf8'), 'committed side effect');
    assert.equal(memory.load('chat').messages.some(row => row.role === 'tool'), false);
  } finally {
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('captured agent options and exact-model constraints stay out of the upstream body', async () => {
  const memory = createMemoryTranscriptStore();
  memory.append('chat', { role: 'user', content: 'Do the work' });
  let captured;
  await runTurn({ ...options, model: { ...model, options: { reasoningEffort: 'high' }, exactModel: true },
    deps: dependencies(memory, async (_provider, body, _signal, postOptions) => { captured = { body, postOptions }; return response(); }) });
  assert.deepEqual(captured.postOptions.agentModelOptions, { reasoningEffort: 'high' });
  assert.equal(captured.postOptions.exactModel, true);
  assert.equal(captured.body.agentModelOptions, undefined);
  assert.equal(captured.body.exactModel, undefined);
});

test('persistence failure after report capture takes precedence over its successful verdict', async () => {
  const memory = createMemoryTranscriptStore();
  memory.append('chat', { role: 'user', content: 'Do the work' });
  let reportSeen = false;
  const store = { ...memory, observePersisted(_chatId, event) {
    if (event.type === 'tool_result' && event.name === 'report_outcome') {
      reportSeen = true;
      throw new Error('outcome commit unavailable');
    }
  } };
  const result = await runTurn({ ...options, injectReportTool: true,
    deps: dependencies(store, async () => response({ tool: 'report_outcome' })) });
  assert.equal(reportSeen, true);
  assert.equal(result.outcome, 'crashed');
  assert.match(result.error, /outcome commit unavailable/);
  assert.equal(result.failure.code, 'transcript_persistence_failed');
});

test('production runner continues canonical SQLite history and stored compaction without losing original rows', async () => {
  const db = new Database(':memory:');
  initSessionsSchema(db);
  const repository = createChatRepository({ db, now: () => 100 });
  repository.createChat({ id: 'chat', name: 'Canonical chat', modelId: 'model', workspacePath: '/fixture' });
  const fence = repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'host' });
  const store = createChatTranscriptStore({ chatId: 'chat', repository, fence });
  try {
    for (let n = 0; n < 55; n++) {
      store.append('chat', { role: n % 2 ? 'assistant' : 'user', content: `Original saved row ${n}` });
    }
    store.append('chat', { role: 'assistant', content: 'Earlier work complete.' });
    const checkpoint = { version: 1, foldThroughRow: 1, elideThroughRow: 1, summary: 'Canonical checkpoint needle',
      state: emptyCompactionState(), trigger: 'manual', tokensBefore: 1000, tokensAfter: 300 };
    store.setCompaction('chat', checkpoint);
    let request;
    const result = await runTurn({ ...options, seed: 'Continue from earlier work',
      deps: dependencies(store, async (_provider, body) => { request = body; return response(); }) });
    assert.equal(result.outcome, 'no_report');
    assert.ok(request.messages.some(row => typeof row.content === 'string' && row.content.includes('Canonical checkpoint needle')));
    const transcript = repository.readTranscript('chat');
    assert.equal(transcript.messages[0].content, 'Original saved row 0');
    assert.equal(transcript.messages.length, 58);
    assert.equal(transcript.messages.at(-2).content, 'Continue from earlier work');
    assert.equal(transcript.messages.at(-1).content, 'Done.');
    assert.equal(new Set(transcript.messages.map(row => row.messageId)).size, 58);
    assert.deepEqual(transcript.compaction, checkpoint);
  } finally { db.close(); }
});

test('upstream requests omit application routing metadata while canonical history retains it', async () => {
  const memory = createMemoryTranscriptStore();
  const provenance = { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'source', sourceTurnId: 'turn' };
  memory.append('chat', { role: 'user', content: 'Do the work', messageId: 'message', commandId: 'command', provenance });
  let request;
  const result = await runTurn({ ...options, deps: dependencies(memory, async (_provider, body) => { request = body; return response(); }) });
  assert.equal(result.outcome, 'no_report');
  const sent = request.messages.find(row => row.role === 'user');
  assert.equal(sent.messageId, undefined);
  assert.equal(sent.commandId, undefined);
  assert.equal(sent.provenance, undefined);
  assert.deepEqual(memory.load('chat').messages[0].provenance, provenance);
  assert.equal(memory.load('chat').messages[0].messageId, 'message');
});

test('canonical load and captured-option metadata failures return failed results before any model request', async () => {
  for (const method of ['load', 'setMeta']) {
    const memory = createMemoryTranscriptStore();
    memory.append('chat', { role: 'user', content: 'Do the work' });
    let requests = 0;
    const store = { ...memory, [method]() { throw new Error(`${method} unavailable`); } };
    const result = await runTurn({ ...options, model: { ...model, options: { thinkingMode: 'on' } },
      deps: dependencies(store, async () => { requests++; return response(); }) });
    assert.equal(result.outcome, 'crashed');
    assert.equal(result.failure.code, 'transcript_persistence_failed');
    assert.match(result.error, new RegExp(`${method} unavailable`));
    assert.equal(requests, 0);
  }
});

test('an initial canonical turn skips its system row without duplicating input or retaining partial prose', async () => {
  const db = new Database(':memory:');
  initSessionsSchema(db);
  const repository = createChatRepository({ db, now: () => 100 });
  repository.createChat({ id: 'chat', name: 'New canonical chat', modelId: 'model', workspacePath: '/fixture' });
  const fence = repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'host' });
  const store = createChatTranscriptStore({ chatId: 'chat', repository, fence });
  try {
    const result = await runTurn({ ...options, seedKind: 'initial', systemPrompt: 'Private profile',
      deps: dependencies(store, async () => response()) });
    assert.equal(result.outcome, 'no_report');
    const rows = repository.readTranscript('chat').messages;
    assert.deepEqual(rows.map(row => [row.role, row.content]), [['user', 'Do the work'], ['assistant', 'Done.']]);
  } finally { db.close(); }
});

test('validated vision capability projects persisted image bytes only on the wire', async () => {
  const images = [{ name: 'diagram.png', dataUrl: 'data:image/png;base64,aA==' }];
  for (const vision of [true, false, undefined]) {
    const memory = createMemoryTranscriptStore();
    memory.append('chat', { role: 'user', content: 'Inspect [image: diagram.png]', images, messageId: 'image-input' });
    let request;
    const result = await runTurn({ ...options, seed: 'Inspect [image: diagram.png]', model: { ...model, vision },
      deps: dependencies(memory, async (_provider, body) => { request = body; return response(); }) });
    assert.equal(result.outcome, 'no_report');
    const sent = request.messages.find(row => row.role === 'user');
    assert.equal(sent.images, undefined);
    assert.equal(sent.messageId, undefined);
    assert.equal(request.messages.filter(row => row.role === 'user').length, 1);
    if (vision) {
      assert.deepEqual(sent.content, [{ type: 'text', text: 'Inspect [image: diagram.png]' },
        { type: 'image_url', image_url: { url: images[0].dataUrl, detail: 'auto' } }]);
    } else {
      assert.match(sent.content, /current model cannot accept image input/);
      assert.equal(JSON.stringify(sent).includes(images[0].dataUrl), false);
    }
    assert.deepEqual(memory.load('chat').messages[0].images, images);
    assert.equal(memory.load('chat').messages[0].content, 'Inspect [image: diagram.png]');
    assert.equal(memory.load('chat').messages.filter(row => row.role === 'user').length, 1);
  }
});
