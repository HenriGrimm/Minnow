import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatRequestService } from '../../server/chats/requests.js';
import { createServerChatExecutionHost, chatInputMessageId } from '../../server/chats/execution-host.js';
import { executeToolCallBatch } from '../../server/runner/tool-batch.js';
import { openWorkspace, closeWorkspace } from '../../server/workspace/open-workspaces.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createChatHostCapabilities } from '../../server/chats/host-capabilities.js';

const provenance = { version: 1, actor: 'human', source: 'composer', kind: 'human_message' };
const command = { version: 1, commandId: 'send', chatId: 'chat', requestedAt: 1000, kind: 'send', mode: 'auto', message: 'Work on this', provenance };
const tool = (name, args = {}, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function response(calls = []) {
  const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : { content: 'Completed.' };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
const schema = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });
function dependencies(post) {
  return {
    postChatCompletions: post, runHeadlessToolBatch: executeToolCallBatch,
    resolveProvider: async () => ({ id: 'fixture', apiKind: 'openai-v1' }),
    getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => ({ preset: {}, maxTokens: 100 }),
    resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => null, applyContextPolicy: async input => ({ applied: false, messages: input.messages }),
  };
}
function setup({ workspaceScratch = false } = {}) {
  const db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  // Windows sandbox temp paths can deny native realpath. Keep the production
  // path-boundary test inside the actual writable workspace, under an ignored
  // scratch directory, and retain the ordinary OS temp path for pure fixtures.
  const parent = workspaceScratch ? fileURLToPath(new URL('../../.minnow/', import.meta.url)) : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, 'minnow-chat-host-'));
  repository.createChat({ id: 'chat', name: 'Chat', workspacePath: scratch, providerId: 'fixture', modelId: 'model', modeId: 'build' });
  const fence = repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'server', commandId: command.commandId });
  const execution = repository.getExecution('execution');
  let policy = createChatPolicy({ modeId: 'build', toolPermissions: { save_file: 'full', read_file: 'full', ask_question: 'ask' },
    toolEffects: { ask_question: 'read' }, fileWriteScope: 'workspace', workspaceIds: ['project'], capabilities: ['execution.host', 'request.respond'] });
  const cleanup = () => { if (db.open) db.close(); assert.ok(path.resolve(scratch).startsWith(path.resolve(parent) + path.sep)); fs.rmSync(scratch, { recursive: true, force: true }); };
  const prepare = (post, extra = {}) => async () => ({
    systemPrompt: 'Normal chat prompt from the injected production seam.', tools: [schema('save_file'), schema('read_file'), schema('ask_question')],
    model: { providerId: 'fixture', id: 'model' }, cwd: scratch, policy, deps: dependencies(post),
    runOptions: { injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false }, ...extra,
  });
  return { db, repository, scratch, fence, execution, prepare, policy: () => policy, changePolicy: value => { policy = value; }, cleanup };
}
const dispatch = execute => ({ execute, runHeadlessToolBatch: executeToolCallBatch, cwd: 'fixture' });

test('canonical input identity agrees with command receipts even at the maximum command ID length', () => {
  assert.equal(chatInputMessageId('x'.repeat(154)), 'input-' + 'x'.repeat(154));
  assert.equal(chatInputMessageId('x'.repeat(160)), 'input-' + createHash('sha256').update('x'.repeat(160)).digest('hex'));
});

test('host uses canonical continue history, preserves input images and emits observer frames without observer ownership', async () => {
  const s = setup();
  try {
    let wire; let frames = 0;
    const host = createServerChatExecutionHost({ repository: s.repository, prepareExecution: s.prepare(async (_provider, body) => { wire = body; return response(); }),
      resolveCurrentPolicy: s.policy, onEvent() { frames++; throw new Error('Viewer closed'); } });
    const result = await host.execute({ command: { ...command, images: [{ name: 'x.png', dataUrl: 'data:image/png;base64,YQ==' }] }, execution: s.execution, fence: s.fence });
    assert.equal(result.outcome, 'no_report'); assert.ok(frames > 0); assert.equal(host.supportsSteer, true);
    const rows = s.repository.readTranscript('chat').messages;
    assert.deepEqual(rows.map(row => row.role), ['user', 'assistant']);
    assert.equal(rows[0].messageId, chatInputMessageId(command.commandId));
    assert.equal(rows[0].createdAt, command.requestedAt);
    assert.equal(rows[0].images[0].dataUrl, 'data:image/png;base64,YQ==');
    assert.equal(wire.messages.filter(row => row.role === 'user').length, 1);
    assert.equal(wire.messages.some(row => row.provenance || row.commandId || row.messageId || row.images || Object.hasOwn(row, 'createdAt')), false);
    assert.match(wire.messages.find(row => row.role === 'user').content, /Work on this/);
  } finally { s.cleanup(); }
});

test('replaying an older canonical input preserves absent timestamp metadata and its immutable row hash', async () => {
  const s = setup();
  try {
    const messageId = chatInputMessageId(command.commandId);
    const appended = s.repository.appendMessage('chat', { role: 'user', content: command.message, commandId: command.commandId, provenance },
      { fence: s.fence, commandId: command.commandId, messageId });
    const prior = s.repository.readMessageByIdentity('chat', messageId);
    assert.equal(prior.rowId, appended.rowId); assert.equal(Object.hasOwn(prior.message, 'createdAt'), false);
    const host = createServerChatExecutionHost({ repository: s.repository, prepareExecution: s.prepare(async () => response()), resolveCurrentPolicy: s.policy });
    assert.equal((await host.execute({ command, execution: s.execution, fence: s.fence })).outcome, 'no_report');
    assert.equal(s.repository.readMessageByIdentity('chat', messageId).rowHash, prior.rowHash);
    assert.equal(s.repository.readTranscript('chat').messages.filter(row => row.role === 'user').length, 1);
    assert.throws(() => s.repository.patchMessage('chat', prior.rowId, { createdAt: 2000 }, { fence: s.fence }), error => error.code === 'policy_denied');
  } finally { s.cleanup(); }
});

test('the actual shared host writes one canonical usage receipt per completion with routed model attribution', async () => {
  const s = setup();
  try {
    let calls = 0;
    const post = async () => {
      calls++;
      const delta = calls === 1 ? { tool_calls: [{ ...tool('read_file'), index: 0 }] } : { content: 'Completed.' };
      const chunks = [{ minnow_router: { phase: 'generating', providerId: 'actual-provider', modelId: 'actual-model' } },
        { choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }];
      return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const deps = { ...dependencies(post), resolveProvider: async id => ({ id, apiKind: 'openai-v1',
      pricing: { default: { inputPer1M: 1, outputPer1M: 2 } } }) };
    const host = createServerChatExecutionHost({ repository: s.repository, prepareExecution: s.prepare(post, { deps }),
      resolveCurrentPolicy: s.policy, createToolDispatch: () => dispatch(async () => ({ content: 'Evidence' })) });
    const result = await host.execute({ command, execution: s.execution, fence: s.fence });
    assert.equal(result.outcome, 'no_report'); assert.equal(calls, 2);
    const ledger = s.repository.getChat('chat').tokenLedger;
    assert.equal(ledger.entries.length, 2); assert.equal(ledger.totals.totalTokens, 300);
    assert.ok(ledger.entries.every(entry => entry.providerId === 'actual-provider' && entry.modelId === 'actual-model'));
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM chat_usage_receipts').get().n, 2);
    assert.equal(s.repository.getActivity('chat').agentExecution.resolvedModel.modelId, 'actual-model');
  } finally { s.cleanup(); }
});

test('a canonical usage write failure stops the shared host before another model request and holds recovery', async () => {
  const s = setup();
  try {
    let calls = 0;
    s.db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON chat_usage_receipts BEGIN SELECT RAISE(FAIL,'Injected usage persistence failure'); END");
    const post = async () => { calls++; return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); };
    const host = createServerChatExecutionHost({ repository: s.repository, prepareExecution: s.prepare(post), resolveCurrentPolicy: s.policy });
    const result = await host.execute({ command, execution: s.execution, fence: s.fence });
    assert.equal(calls, 1); assert.equal(result.failure.recoveryRequired, true);
    assert.equal(s.repository.getExecution('execution').status, 'recovery_required');
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM chat_usage_receipts').get().n, 0);
    assert.equal(s.repository.getChat('chat').tokenLedger, undefined);
  } finally { s.cleanup(); }
});

test('production default dispatch writes a real scratch file with an intent committed before the effect and result receipt afterward', async () => {
  const s = setup({ workspaceScratch: true }); openWorkspace(s.scratch);
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(s.scratch, 'home');
  resetMinnowHomeCache();
  let rounds = 0;
  try {
    const host = createServerChatExecutionHost({ repository: s.repository,
      prepareExecution: s.prepare(async () => response(rounds++ === 0 ? [tool('save_file', { path: 'evidence.txt', content: 'Saved once' })] : [])), resolveCurrentPolicy: s.policy });
    const originalRecord = s.repository.recordToolIntent;
    s.repository.recordToolIntent = (...args) => {
      const receipt = originalRecord(...args);
      assert.equal(fs.existsSync(path.join(s.scratch, 'evidence.txt')), false);
      return receipt;
    };
    const result = await host.execute({ command, execution: s.execution, fence: s.fence });
    assert.equal(result.outcome, 'no_report');
    assert.doesNotMatch(s.repository.readTranscript('chat').messages.find(row => row.role === 'tool')?.content ?? '', /Error:|Not implemented/);
    assert.equal(fs.readFileSync(path.join(s.scratch, 'evidence.txt'), 'utf8'), 'Saved once');
    assert.equal(s.repository.listUnsettledToolInvocations('execution').length, 0);
    assert.equal(s.repository.readTranscript('chat').messages.filter(row => row.role === 'tool').length, 1);
    assert.equal(rounds, 2);
  } finally { closeWorkspace(s.scratch); if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome; resetMinnowHomeCache(); s.cleanup(); }
});

test('lost effect receipts create a recovery barrier and retry never repeats a real file mutation', async () => {
  const s = setup(); let effects = 0; let posts = 0;
  try {
    s.repository.settleToolInvocation = () => { throw new Error('SQLite commit failed after the mutation'); };
    const host = createServerChatExecutionHost({ repository: s.repository, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => { posts++; return response([tool('save_file', { path: 'effect.txt' })]); }),
      createToolDispatch: () => dispatch(async () => { effects++; fs.appendFileSync(path.join(s.scratch, 'effect.txt'), 'one\n'); return { content: 'Saved' }; }) });
    const first = await host.execute({ command, execution: s.execution, fence: s.fence });
    assert.equal(first.failure.code, 'recovery_required');
    assert.equal(s.repository.getExecution('execution').status, 'recovery_required');
    const retry = await host.execute({ command, execution: s.execution, fence: s.fence });
    assert.equal(retry.failure.code, 'recovery_required'); assert.equal(effects, 1); assert.equal(posts, 1);
    assert.equal(fs.readFileSync(path.join(s.scratch, 'effect.txt'), 'utf8'), 'one\n');
  } finally { s.cleanup(); }
});

test('a settled effect with missing canonical result still blocks automatic rerun until explicit reconciliation', async () => {
  const s = setup(); let effects = 0; let posts = 0;
  try {
    const append = s.repository.appendMessage;
    s.repository.appendMessage = (chatId, row, options) => {
      if (row.role === 'tool') throw new Error('Tool result transcript commit failed');
      return append(chatId, row, options);
    };
    const host = createServerChatExecutionHost({ repository: s.repository, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => { posts++; return response([tool('save_file')]); }),
      createToolDispatch: () => dispatch(async () => { effects++; return { content: 'Saved' }; }) });
    assert.equal((await host.execute({ command, execution: s.execution, fence: s.fence })).failure.code, 'recovery_required');
    assert.equal(s.repository.listUnsettledToolInvocations('execution').length, 0);
    assert.equal((await host.execute({ command, execution: s.execution, fence: s.fence })).failure.code, 'recovery_required');
    assert.equal(effects, 1); assert.equal(posts, 1);
  } finally { s.cleanup(); }
});

test('live policy revocation after durable approval blocks the side effect', async () => {
  const s = setup(); let effects = 0; let pending;
  s.changePolicy(createChatPolicy({ modeId: 'build', toolPermissions: { save_file: 'ask' }, fileWriteScope: 'workspace' }));
  try {
    const requests = createChatRequestService({ repository: s.repository, authorizeResponse: () => true, onChange: request => { if (request.state === 'pending') pending = request; } });
    const host = createServerChatExecutionHost({ repository: s.repository, requestService: requests, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => response([tool('save_file')])), createToolDispatch: () => dispatch(async () => { effects++; return { content: 'Saved' }; }) });
    const running = host.execute({ command, execution: s.execution, fence: s.fence });
    for (let n = 0; !pending && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(pending); assert.equal(s.repository.getExecution('execution').status, 'waiting_for_approval');
    s.changePolicy(createChatPolicy({ modeId: 'plan', toolPermissions: { save_file: 'off' }, fileWriteScope: 'plans' }));
    await requests.respond(pending.requestId, { answerCommandId: 'approval', answer: { decision: 'allow_once' } });
    const result = await running;
    assert.equal(result.outcome, 'crashed'); assert.match(result.error, /not allowed/); assert.equal(effects, 0);
    assert.equal(s.repository.listUnsettledToolInvocations('execution').length, 0);
  } finally { s.cleanup(); }
});

test('ask_question is durable, attributed to its tool call and resumes the same turn after a scoped answer', async () => {
  const s = setup(); let pending; let rounds = 0;
  try {
    const requests = createChatRequestService({ repository: s.repository, authorizeResponse: () => true,
      onChange: request => { if (request.state === 'pending') pending = request; } });
    const host = createServerChatExecutionHost({ repository: s.repository, requestService: requests, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => response(rounds++ === 0 ? [tool('ask_question', { question: 'Which version?' }, 'question-call')] : [])) });
    const running = host.execute({ command, execution: s.execution, fence: s.fence });
    for (let n = 0; !pending && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(pending); assert.equal(pending.kind, 'question'); assert.equal(pending.toolCallId, 'question-call');
    assert.equal(s.repository.getExecution('execution').status, 'waiting_for_input');
    await requests.respond(pending.requestId, { answerCommandId: 'answer', answer: 'Version two' });
    assert.equal((await running).outcome, 'no_report');
    assert.equal(rounds, 2);
    assert.match(s.repository.readTranscript('chat').messages.find(row => row.role === 'tool').content, /Version two/);
    assert.equal(s.repository.getExecution('execution').status, 'running');
  } finally { s.cleanup(); }
});

test('missing host capability retains accepted input and offers a truthful waiting state without model work', async () => {
  const s = setup(); let posts = 0;
  try {
    const prepare = s.prepare(async () => { posts++; return response(); }, { hostToolNames: ['browser_click'] });
    const host = createServerChatExecutionHost({ repository: s.repository, prepareExecution: prepare, resolveCurrentPolicy: s.policy });
    const result = await host.execute({ command, execution: s.execution, fence: s.fence });
    assert.equal(result.failure.waitingForHost, true); assert.deepEqual(result.failure.requiredCapabilities, ['tool:browser_click']);
    assert.equal(posts, 0); assert.equal(s.repository.readTranscript('chat').messages.length, 1);
  } finally { s.cleanup(); }
});

test('bound host tools commit intent before waiting and never replay an unresolved remote effect', async () => {
  const s = setup(); let calls = 0; let rounds = 0; const states = [];
  s.changePolicy(createChatPolicy({ modeId: 'build', toolPermissions: { browser_click: 'full' }, fileWriteScope: 'workspace' }));
  try {
    const host = createServerChatExecutionHost({ repository: s.repository, resolveCurrentPolicy: s.policy, onStatus: event => states.push(event.status),
      prepareExecution: s.prepare(async () => response(rounds++ === 0 ? [tool('browser_click', { ref: 'button' })] : []), { tools: [schema('browser_click')], hostToolNames: ['browser_click'] }),
      executeHostTool: async input => { calls++; assert.equal(s.repository.listUnsettledToolInvocations('execution').length, 1);
        assert.equal(input.ctx.toolCallId, 'call-1'); assert.equal(input.fence, s.fence);
        throw Object.assign(new Error('Host lost after click'), { effectNotStarted: true }); } });
    assert.equal((await host.execute({ command, execution: s.execution, fence: s.fence })).failure.code, 'recovery_required');
    assert.equal((await host.execute({ command, execution: s.execution, fence: s.fence })).failure.code, 'recovery_required');
    assert.equal(calls, 1); assert.ok(states.includes('waiting_for_host')); assert.equal(states.at(-1), 'recovery_required');
  } finally { s.cleanup(); }
});

test('one-time approval executes once and a disconnected viewer cannot turn it into a permanent grant', async () => {
  const s = setup(); let pending; let effects = 0; let rounds = 0;
  s.changePolicy(createChatPolicy({ modeId: 'build', toolPermissions: { save_file: 'ask' }, fileWriteScope: 'workspace' }));
  try {
    const requests = createChatRequestService({ repository: s.repository, authorizeResponse: () => true,
      onChange: request => { if (request.state === 'pending') pending = request; } });
    const host = createServerChatExecutionHost({ repository: s.repository, requestService: requests, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => response(rounds++ === 0 ? [tool('save_file')] : [])),
      createToolDispatch: () => dispatch(async () => { effects++; return { content: 'Saved' }; }) });
    const running = host.execute({ command, execution: s.execution, fence: s.fence });
    for (let n = 0; !pending && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(pending);
    await requests.respond(pending.requestId, { answerCommandId: 'allow', answer: { decision: 'allow_once' } });
    assert.equal((await running).outcome, 'no_report'); assert.equal(effects, 1);
    assert.equal(s.policy().toolPermissions.save_file, 'ask');
    assert.equal(s.repository.getRequest(pending.requestId).answerCommandId, 'allow');
  } finally { s.cleanup(); }
});

test('stop cancels a durable question without starting another model request or claiming a successful report', async () => {
  const s = setup(); let pending; let rounds = 0;
  try {
    const requests = createChatRequestService({ repository: s.repository, authorizeResponse: () => true,
      onChange: request => { if (request.state === 'pending') pending = request; } });
    const stop = new AbortController();
    const host = createServerChatExecutionHost({ repository: s.repository, requestService: requests, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => { rounds++; return response([tool('ask_question', { question: 'Continue?' })]); }) });
    const running = host.execute({ command, execution: s.execution, fence: s.fence, signal: stop.signal });
    for (let n = 0; !pending && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(pending); stop.abort(new DOMException('Stopped', 'AbortError'));
    const result = await running;
    assert.equal(result.failure.stopped, true); assert.equal(rounds, 1);
    assert.equal(s.repository.getRequest(pending.requestId).state, 'cancelled');
    await assert.rejects(requests.respond(pending.requestId, { answerCommandId: 'late', answer: 'Yes' }), { code: 'request_expired' });
  } finally { s.cleanup(); }
});

test('ordered durable steers enter the current runner once with stable provenance and never leak routing fields', async () => {
  const s = setup(); let rounds = 0; let taken = false; let wire;
  const peer = { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'peer', sourceTurnId: 'peer-turn' };
  try {
    const host = createServerChatExecutionHost({ repository: s.repository, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async (_provider, body) => { wire = body; return response(rounds++ === 0 ? [tool('read_file')] : []); }),
      createToolDispatch: () => dispatch(async () => ({ content: 'Read' })) });
    const result = await host.execute({ command, execution: s.execution, fence: s.fence, takeSteers() {
      if (taken || rounds === 0) return null;
      taken = true;
      const rows = ['First correction', 'Second correction'].map((content, index) => ({ role: 'user', content,
        messageId: `steer-${index}`, commandId: `steer-command-${index}`, provenance: peer }));
      const ids = rows.map(row => s.repository.appendMessage('chat', row, { fence: s.fence, messageId: row.messageId }).rowId);
      return { messages: rows, rowIds: ids };
    } });
    assert.equal(result.outcome, 'no_report'); assert.equal(rounds, 2);
    const steers = s.repository.readTranscript('chat').messages.filter(row => row.messageId?.startsWith('steer-'));
    assert.equal(steers.length, 2); assert.deepEqual(steers.map(row => row.content), ['First correction', 'Second correction']);
    assert.deepEqual(steers[0].provenance, peer);
    assert.equal(wire.messages.some(row => row.provenance || row.commandId || row.messageId), false);
    const sentCorrections = wire.messages.filter(row => row.content?.includes?.('correction')).map(row => row.content);
    assert.equal(sentCorrections.length, 2);
    for (const [index, text] of sentCorrections.entries()) {
      assert.match(text, /Agent message from chat peer/);
      assert.ok(text.endsWith(['First correction', 'Second correction'][index]));
    }
  } finally { s.cleanup(); }
});

test('a durable steer failure cannot be swallowed by the inner boundary callback', async () => {
  const s = setup(); let rounds = 0;
  try {
    const host = createServerChatExecutionHost({ repository: s.repository, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => { rounds++; return response([tool('read_file')]); }),
      createToolDispatch: () => dispatch(async () => ({ content: 'Read' })) });
    const result = await host.execute({ command, execution: s.execution, fence: s.fence, takeSteers() { throw new Error('Steer receipt commit failed'); } });
    assert.equal(result.outcome, 'crashed'); assert.equal(result.failure.code, 'transcript_persistence_failed');
    assert.match(result.error, /Steer receipt/); assert.equal(rounds, 0);
  } finally { s.cleanup(); }
});

test('Full to Ask while awaiting a host opens a durable approval before dispatch and reuses it on receipt replay', async () => {
  const s = setup(); let pending; let asks = 0; let frames = 0; let rounds = 0;
  s.changePolicy(createChatPolicy({ modeId: 'build', toolPermissions: { browser_click: 'full' }, fileWriteScope: 'workspace' }));
  const requests = createChatRequestService({ repository: s.repository, authorizeResponse: () => true,
    onChange: request => { if (request.state === 'pending') { pending = request; asks++; } } });
  const broker = createChatHostCapabilities({ repository: s.repository, retryMs: 10,
    resolveProject: () => ({ projectId: 'project', workspaceRoot: s.scratch }),
    beforeDispatch: () => s.changePolicy(createChatPolicy({ modeId: 'build', toolPermissions: { browser_click: 'ask' }, fileWriteScope: 'workspace' })) });
  broker.register({ hostId: 'browser', projectId: 'project', capabilities: ['tool:browser_click'], send: frame => {
    if (frame.type !== 'execute') return;
    if (++frames === 2) broker.respond({ hostId: 'browser', invocationId: frame.invocationId, result: { content: 'Clicked once; cached receipt' } });
  } });
  try {
    const host = createServerChatExecutionHost({ repository: s.repository, requestService: requests, resolveCurrentPolicy: s.policy,
      prepareExecution: s.prepare(async () => response(rounds++ === 0 ? [tool('browser_click')] : []), { tools: [schema('browser_click')], hostToolNames: ['browser_click'] }),
      executeHostTool: input => broker.executeHostTool(input) });
    const running = host.execute({ command, execution: s.execution, fence: s.fence });
    for (let n = 0; !pending && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(pending); assert.equal(frames, 0); assert.equal(s.repository.getExecution('execution').status, 'waiting_for_approval');
    await requests.respond(pending.requestId, { answerCommandId: 'allow-host', answer: { decision: 'allow_once' } });
    assert.equal((await running).outcome, 'no_report');
    assert.equal(asks, 1); assert.equal(frames, 2); assert.equal(s.repository.listUnsettledToolInvocations('execution').length, 0);
  } finally { broker.dispose(); s.cleanup(); }
});

test('new Ask denial or Off before first host dispatch settles a known non-effect instead of inventing uncertainty', async () => {
  for (const permission of ['ask', 'off']) {
    const s = setup(); let pending; let frames = 0; let rounds = 0;
    s.changePolicy(createChatPolicy({ modeId: 'build', toolPermissions: { browser_click: 'full' }, fileWriteScope: 'workspace' }));
    const requests = createChatRequestService({ repository: s.repository, authorizeResponse: () => true,
      onChange: request => { if (request.state === 'pending') pending = request; } });
    const broker = createChatHostCapabilities({ repository: s.repository,
      resolveProject: () => ({ projectId: 'project', workspaceRoot: s.scratch }),
      beforeDispatch: () => s.changePolicy(createChatPolicy({ modeId: 'build', toolPermissions: { browser_click: permission }, fileWriteScope: 'workspace' })) });
    broker.register({ hostId: 'browser', projectId: 'project', capabilities: ['tool:browser_click'], send: () => { frames++; } });
    try {
      const host = createServerChatExecutionHost({ repository: s.repository, requestService: requests, resolveCurrentPolicy: s.policy,
        prepareExecution: s.prepare(async () => response(rounds++ === 0 ? [tool('browser_click')] : []), { tools: [schema('browser_click')], hostToolNames: ['browser_click'] }),
        executeHostTool: input => broker.executeHostTool(input) });
      const running = host.execute({ command, execution: s.execution, fence: s.fence });
      if (permission === 'ask') {
        for (let n = 0; !pending && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(pending); await requests.respond(pending.requestId, { answerCommandId: 'deny-host', answer: { decision: 'deny' } });
      }
      assert.equal((await running).outcome, 'no_report'); assert.equal(frames, 0);
      assert.equal(s.repository.listUnsettledToolInvocations('execution').length, 0);
      assert.match(s.repository.readTranscript('chat').messages.find(row => row.role === 'tool').content, /Error:/);
      assert.equal(s.repository.getExecution('execution').status, 'running');
    } finally { broker.dispose(); s.cleanup(); }
  }
});
