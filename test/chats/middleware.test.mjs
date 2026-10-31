import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatContext } from '../../server/chats/context.js';
import { createChatPresentation } from '../../server/chats/presentation.js';
import { createChatMiddleware } from '../../server/chats/middleware.js';
import { createChatRequestService } from '../../server/chats/requests.js';
import { createChatHostCapabilities } from '../../server/chats/host-capabilities.js';
import { assertCallerCanTarget, assertExecutionCaller } from '../../server/chats/caller.js';
import { getAgentConversationsFeature } from '../../server/chats/feature.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { ChatContractError } from '../../server/chats/contracts.js';
import { createLegacyChatImporter } from '../../server/chats/legacy-import.js';
import { exportChatArchive } from '../../server/chats/archive.js';
import { createChatRecovery } from '../../server/chats/recovery.js';

const feature = () => getAgentConversationsFeature({ NODE_ENV: 'test', MINNOW_AGENT_CONVERSATIONS: '1' });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-http-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = root; resetMinnowHomeCache();
  const workspace = path.join(root, 'project'), foreign = path.join(root, 'foreign');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(foreign)]);
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  for (const [id, directory] of [['chat', workspace], ['second', workspace], ['foreign', foreign]]) {
    repository.createChat({ id, name: id, workspacePath: directory, providerId: 'provider', modelId: 'model', modeId: 'build' });
  }
  const resolvePolicyInput = async (chat, _scope, registry) => ({
    modeId: chat.modeId, toolPermissions: { read_file: 'full', save_file: 'full' },
    toolEffects: { read_file: 'read', save_file: 'file-write' }, workspaceIds: registry.entries.map(row => row.workspaceId),
    capabilities: options.capabilities ?? ['chat.read', 'chat.send', 'chat.stop', 'request.respond', 'execution.host'],
  });
  const context = createChatContext({ repository, resolvePolicyInput, validateRoot: async () => {}, runGit: async () => ({ code: 1, stdout: '' }) });
  const project = await context.project(workspace);
  for (const id of ['chat', 'second']) repository.ensureManagedChat(id, { projectId: project.projectId });
  let modelCalls = 0;
  const resolveModelSelection = async (input) => {
    const { target, selection } = input;
    modelCalls += 1;
    await options.beforeSelection?.(input);
    return { selection: target ?? selection };
  };
  const presentation = createChatPresentation({ repository, flushMs: 5 });
  const service = createChatCommandService({ repository, context, feature,
    resolveModelSelection: async ({ selection }) => (await resolveModelSelection({ selection })).selection,
    onEvent: event => presentation.onServiceEvent(event), onError: error => { throw error; },
  });
  const requests = createChatRequestService({ repository, pollMs: 10, onChange: request => presentation.changed(request.chatId),
    authorizeResponse: async (request, value) => {
      if (value?.target?.chat.id !== request.chatId) return false;
      assertCallerCanTarget(value.caller, value.target, { operation: 'respond', currentPolicy: value.target.currentPolicy, registry: value.target.registry });
      return true;
    },
  });
  const capabilities = createChatHostCapabilities({ repository, resolveProject: () => ({ projectId: project.projectId, workspaceRoot: workspace }), retryMs: 10_000 });
  const runtime = { repository, context, presentation, service, requests, capabilities, resolveModelSelection, resolvePolicyInput,
    hasExternalExecution: options.hasExternalExecution ?? (() => false) };
  runtime.recovery = createChatRecovery({ repository, service, requests, taskDelivery: { recover: async () => {} },
    verifyQuiescence: () => ({ verified: true, source: 'isolated-http', checkedAt: Date.now() }) });
  if (options.legacyImports) runtime.legacyImports = createLegacyChatImporter({ repository, context, feature,
    loadSource: async (_parent, runId) => ({ runId, type: 'explore', task: 'Historical assignment', source: 'saved_snapshot', partial: true, capped: true, truncated: true, messages: [{ role: 'assistant', content: 'Historical answer' }] }),
    loadConfig: async () => ({ types: { explore: { enabled: true } } }),
    resolveModelSelection: async () => ({ selection: { providerId: 'provider', modelId: 'model' }, source: 'parent', exactModel: true }),
    captureProfile: async (_chat, scope) => ({ policy: (await context.resolveTarget('chat')).policy, prompt: { sources: {} } }) });
  const middleware = createChatMiddleware({ getRuntime: () => runtime, feature });
  const server = http.createServer((req, res) => {
    if (req.headers['x-test-device'] === '1') req.minnowAuth = { kind: 'device' };
    else if (req.headers['x-test-host'] === '1') req.minnowAuth = { kind: 'host' };
    runWithViewWorkspace(req.headers['x-test-workspace'] === 'foreign' ? foreign : workspace, () => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await service.dispose(); presentation.dispose(); capabilities.dispose(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); db.close(); await fs.rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
  });
  async function request(route, { method = 'GET', body, headers } = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  function host(execute) { return service.registerHost({ id: 'scripted-host', kind: 'server', supportsSteer: true, execute }); }
  function append(input) {
    repository.appendMessage(input.command.chatId, { role: 'user', content: input.command.message,
      provenance: input.command.provenance, commandId: input.command.commandId },
    { fence: input.fence, commandId: input.command.commandId, messageId: 'input-' + input.command.commandId });
  }
  return { repository, context, project, workspace, db, service, presentation, requests, capabilities, request, host, append, base,
    modelCalls: () => modelCalls };
}

async function savedChild(f, id = 'child') {
  const target = await f.context.resolveTarget('chat');
  return f.repository.createChild({ chat: { id, name: id, workspacePath: f.workspace, providerId: 'provider', modelId: 'model', modeId: 'build' },
    projectId: f.project.projectId,
    relation: { version: 1, childChatId: id, parentChatId: 'chat', rootChatId: 'chat', journalOwnerId: 'chat', origin: 'delegated', createdAt: 1,
      capabilities: { canSend: true, canStop: true, canChooseModel: true } },
    profile: { profileId: `profile-${id}`, profileVersion: 1, snapshot: { policy: target.policy, modelSelection: { providerId: 'provider', modelId: 'model' } } },
  });
}

test('versioned archive HTTP transfers require local host and compatible writes, hold imported records and return the same receipt', async t => {
  const f = await fixture(t), headers = { 'x-test-host': '1' };
  assert.equal((await f.request('/api/chats/archive/export')).status, 403);
  assert.equal((await f.request('/api/chats/archive/export', { headers: { 'x-test-device': '1' } })).status, 403);
  const exported = await f.request('/api/chats/archive/export', { headers });
  assert.equal(exported.status, 200); assert.equal(exported.body.archive.clientProtocol, 1);
  const db = new Database(':memory:'); initSessionsSchema(db);
  const imported = createChatRepository({ db }); imported.createChat({ id: 'archive-child', name: 'Imported child', workspacePath: f.workspace });
  imported.ensureManagedChat('archive-child', { projectId: f.project.projectId });
  imported.admitCommand({ version: 1, commandId: 'import-command', chatId: 'archive-child', kind: 'send', requestedAt: 1,
    message: 'Held archive input', provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } }, { producerId: 'archive-human' });
  const archive = exportChatArchive(db); db.close();
  const body = { archive };
  assert.equal((await f.request('/api/chats/archive/import', { method: 'POST', body, headers: { ...headers, 'X-Minnow-Chat-Protocol': '0' } })).status, 409);
  assert.equal((await f.request('/api/chats/archive/import', { method: 'POST', body, headers: { 'x-test-device': '1' } })).status, 403);
  assert.equal((await f.request('/api/chats/archive/import', { method: 'POST', body: { archive, actor: 'human' }, headers })).status, 400);
  const first = await f.request('/api/chats/archive/import', { method: 'POST', body, headers });
  assert.equal(first.status, 200); assert.equal(first.body.receipt.replayed, false);
  assert.equal(f.repository.getCommand('import-command').held, true);
  const replay = await f.request('/api/chats/archive/import', { method: 'POST', body, headers });
  assert.equal(replay.status, 200); assert.equal(replay.body.receipt.replayed, true);
  assert.equal(replay.body.receipt.revision, first.body.receipt.revision);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM chats WHERE id='archive-child'").get().n, 1);
});

test('human activity acknowledgement is scoped to the exact visible cursor and cannot clear a later reply', async t => {
  const f = await fixture(t);
  const first = f.repository.claimExecution({ chatId: 'chat', executionId: 'first-activity', ownerId: 'host' });
  f.repository.appendMessage('chat', { role: 'assistant', content: 'First result' }, { fence: first, messageId: 'first-result' });
  f.repository.updateExecution('first-activity', { status: 'completed' }, { fence: first }); f.repository.releaseLease('chat', first);
  const cursor = f.repository.getActivity('chat').agentActivityCursor;
  assert.equal((await f.request('/api/chats/chat/ack', { method: 'POST', body: { ...cursor, actor: 'human' } })).status, 400);
  assert.equal((await f.request('/api/chats/chat/ack', { method: 'POST', body: cursor, headers: { 'x-test-workspace': 'foreign' } })).status, 403);
  const read = await f.request('/api/chats/chat/ack', { method: 'POST', body: cursor, headers: { 'x-test-device': '1' } });
  assert.equal(read.status, 200); assert.equal(read.body.activity.unread, false);
  const second = f.repository.claimExecution({ chatId: 'chat', executionId: 'second-activity', ownerId: 'host' });
  f.repository.appendMessage('chat', { role: 'assistant', content: 'Second result' }, { fence: second, messageId: 'second-result' });
  f.repository.updateExecution('second-activity', { status: 'completed' }, { fence: second }); f.repository.releaseLease('chat', second);
  const stale = await f.request('/api/chats/chat/ack', { method: 'POST', body: cursor });
  assert.equal(stale.status, 200); assert.equal(stale.body.activity.unread, true);
});

test('guarded deletion retains child conversations and files, returns one scoped immutable receipt, and never recreates a tombstoned parent', async t => {
  const f = await fixture(t); await savedChild(f);
  const retainedFile = path.join(f.workspace, 'uncommitted.txt'); await fs.writeFile(retainedFile, 'Keep this work');
  const body = { clientRequestId: 'delete-parent' }, headers = { 'x-test-host': '1' };
  assert.equal((await f.request('/api/chats/chat', { method: 'DELETE', body })).status, 403);
  assert.equal((await f.request('/api/chats/foreign', { method: 'DELETE', body, headers })).status, 403);
  const first = await f.request('/api/chats/chat', { method: 'DELETE', body, headers });
  assert.equal(first.status, 200); assert.equal(first.body.receipt.retainedWorktree, true);
  assert.throws(() => f.repository.getChat('chat'), error => error.code === 'chat_not_found');
  const relation = f.repository.getRelation('child');
  assert.equal(relation.parentChatId, 'chat'); assert.equal(relation.missingParent, true); assert.equal(relation.journalOwnerId, 'chat');
  assert.equal(await fs.readFile(retainedFile, 'utf8'), 'Keep this work');
  const replay = await f.request('/api/chats/chat', { method: 'DELETE', body, headers });
  assert.equal(replay.status, 200); assert.equal(replay.body.receipt.replayed, true);
  assert.equal(replay.body.receipt.revision, first.body.receipt.revision);
  const foreignReplay = await f.request('/api/chats/chat', { method: 'DELETE', body, headers: { ...headers, 'x-test-workspace': 'foreign' } });
  assert.equal(foreignReplay.status, 404);
  assert.throws(() => f.repository.createChat({ id: 'chat', workspacePath: f.workspace }), error => error.code === 'chat_not_found');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM chat_outbox WHERE kind='conversation.deleted'").get().n, 1);
});

test('guarded deletion refuses active descendants, pending requests, queued assignments, and external renderer ownership before committing a receipt', async t => {
  let externallyBusy = false;
  const f = await fixture(t, { hasExternalExecution: id => externallyBusy && id === 'chat' }); await savedChild(f);
  const options = { method: 'DELETE', body: { clientRequestId: 'guarded-parent' }, headers: { 'x-test-host': '1' } };
  const fence = f.repository.claimExecution({ chatId: 'child', executionId: 'child-execution', ownerId: 'server' });
  assert.equal((await f.request('/api/chats/chat', options)).status, 409);
  f.repository.saveRequest({ version: 1, requestId: 'pending', chatId: 'child', executionId: fence.executionId, toolCallId: 'question', kind: 'question',
    state: 'pending', title: 'Choose', presentation: {}, createdAt: 1 }, { fence });
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('child', fence);
  assert.equal((await f.request('/api/chats/chat', options)).status, 409);
  f.repository.settleRequest('pending', { state: 'cancelled' });
  f.repository.admitCommand({ version: 1, commandId: 'pending-command', chatId: 'child', requestedAt: 1, kind: 'send', message: 'Queued task',
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } }, { producerId: 'human', requestKey: 'pending-command' });
  assert.equal((await f.request('/api/chats/chat', options)).status, 409);
  f.repository.updateCommand('pending-command', { state: 'cancelled' });
  externallyBusy = true; assert.equal((await f.request('/api/chats/chat', options)).status, 409);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM chat_outbox WHERE kind='conversation.deleted'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM chat_conversation_tombstones WHERE chat_id='chat'").get().n, 0);
  externallyBusy = false; assert.equal((await f.request('/api/chats/chat', options)).status, 200);
});

test('a deletion receipt commit failure rolls back the guarded delete, tombstone and revision together', async t => {
  const f = await fixture(t); await savedChild(f);
  const cache = path.join(process.env.MINNOW_HOME, 'cli-sessions', 'a'.repeat(64));
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, 'checkpoint.json'), JSON.stringify({ chatId: 'chat', providerId: 'fixture' }));
  const original = f.repository.finishOutbox;
  f.repository.finishOutbox = () => { throw new Error('Injected receipt acknowledgement failure'); };
  const options = { method: 'DELETE', body: { clientRequestId: 'delete-commit' }, headers: { 'x-test-host': '1' } };
  assert.equal((await f.request('/api/chats/chat', options)).status, 500);
  assert.equal(f.repository.getChat('chat').id, 'chat'); assert.equal(f.repository.getRelation('child').parentChatId, 'chat');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM chat_conversation_tombstones WHERE chat_id='chat'").get().n, 0);
  await fs.access(path.join(cache, 'checkpoint.json'));
  f.repository.finishOutbox = original;
  assert.equal((await f.request('/api/chats/chat', options)).status, 200);
  await assert.rejects(fs.access(cache), error => error.code === 'ENOENT');
});

test('deleting the last conversation atomically keeps one empty independent replacement, including after a lost receipt retry', async t => {
  const f = await fixture(t); f.db.prepare("DELETE FROM chats WHERE id IN ('second','foreign')").run();
  const options = { method: 'DELETE', body: { clientRequestId: 'delete-last' }, headers: { 'x-test-host': '1' } };
  const first = await f.request('/api/chats/chat', options); assert.equal(first.status, 200);
  const replacement = first.body.receipt.replacementChat; assert.ok(replacement);
  assert.equal(replacement.modelId, '', 'an independent replacement does not inherit a child selection');
  assert.deepEqual(f.repository.readTranscript(replacement.id).messages, []);
  assert.equal(f.repository.getRelation(replacement.id), null);
  const replay = await f.request('/api/chats/chat', options);
  assert.equal(replay.body.receipt.replacementChat.id, replacement.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM chats').get().n, 1);
});

test('capabilities explicitly distinguish SQLite from the legacy JSON store without widening the strict feature contract', async t => {
  const f = await fixture(t);
  const sqlite = await f.request('/api/chats/capabilities'); assert.equal(sqlite.body.conversationStorage, 'sqlite');
  assert.equal(sqlite.body.creationEnabled, true); assert.equal(sqlite.body.reason, 'released'); assert.equal(sqlite.body.recoveryEnabled, true);
  assert.deepEqual(sqlite.body.clientProtocol, { version: 1, minReaderVersion: 1, minWriterVersion: 1 });
  const previous = process.env.MINNOW_SESSIONS_STORE;
  try {
    process.env.MINNOW_SESSIONS_STORE = 'json';
    const json = await f.request('/api/chats/capabilities');
    assert.equal(json.body.conversationStorage, 'json'); assert.equal(json.body.creationEnabled, false); assert.equal(json.body.reason, 'disabled');
    assert.equal(json.body.recoveryEnabled, true); assert.deepEqual(json.body.clientProtocol, sqlite.body.clientProtocol);
  } finally { if (previous === undefined) delete process.env.MINNOW_SESSIONS_STORE; else process.env.MINNOW_SESSIONS_STORE = previous; }
});

test('old connected clients can inspect but cannot mutate persistent chats or provide execution callbacks', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/chats/chat', { headers: { 'X-Minnow-Chat-Protocol': '' } })).status, 200);
  for (const protocol of ['', '0', '2', '1, 1']) {
    const response = await f.request('/api/chats/chat/commands', { method: 'POST', headers: { 'X-Minnow-Chat-Protocol': protocol },
      body: { action: 'send', text: 'Must not execute', clientRequestId: 'old-client' } });
    assert.equal(response.status, 409); assert.equal(response.body.error.code, 'unsupported_version');
  }
  assert.equal(f.repository.listCommands({ chatId: 'chat' }).length, 0);
  const host = await f.request('/api/chats/host?hostId=old&capabilities=[]', { headers: { 'X-Minnow-Chat-Protocol': '', 'x-test-host': '1' } });
  assert.equal(host.status, 409); assert.equal(f.capabilities.connectedHosts, 0);
});

test('navigation availability is scoped and contains no transcript, request bodies or private profiles', async t => {
  const f = await fixture(t);
  const own = await f.request('/api/chats/chat?view=navigation');
  assert.equal(own.status, 200); assert.deepEqual(own.body, { chatId: 'chat', available: true });
  assert.equal((await f.request('/api/chats/foreign?view=navigation')).status, 403);
  assert.equal((await f.request('/api/chats/deleted?view=navigation')).status, 404);
});

test('real HTTP command retries return one durable receipt and server-derived human provenance', async t => {
  const f = await fixture(t); let turns = 0;
  f.host(async input => { turns += 1; f.append(input); return { outcome: 'no_report' }; });
  const input = { action: 'send', text: 'Read the project', clientRequestId: 'http-request' };
  const first = await f.request('/api/chats/chat/commands', { method: 'POST', body: input });
  assert.equal(first.status, 202);
  await f.service.idle('chat');
  const replay = await f.request('/api/chats/chat/commands', { method: 'POST', body: input });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.receipt.commandId, first.body.receipt.commandId);
  assert.equal(replay.body.receipt.replayed, true);
  assert.equal(turns, 1); assert.equal(f.modelCalls(), 1);
  assert.equal(f.repository.readTranscript('chat').messages[0].provenance.actor, 'human');
  const receipt = await f.request('/api/chat-commands/' + first.body.receipt.commandId);
  assert.equal(receipt.body.receipt.command.provenance.source, 'composer');
  assert.equal(receipt.headers.get('cache-control'), 'no-store');
  const conflict = await f.request('/api/chats/chat/commands', { method: 'POST', body: { ...input, text: 'Changed input' } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'idempotency_conflict');
});

test('transport rejects forged authority, unknown fields, cross-action fields and malformed JSON before admission', async t => {
  const f = await fixture(t);
  for (const extra of [{ actor: 'agent' }, { provenance: { actor: 'agent' } }, { modelSelection: { providerId: 'evil', modelId: 'evil' } },
    { executionId: 'forged-execution' }, { scope: 'tree' }, { itemId: 'unrelated-command' }]) {
    const response = await f.request('/api/chats/chat/commands', { method: 'POST', body: { action: 'send', text: 'Forged', ...extra } });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.equal(response.body.error.code, 'invalid_request');
  }
  const malformed = await f.request('/api/chats/chat/commands', { method: 'POST', body: '{invalid json' });
  assert.equal(malformed.status, 400);
  assert.equal(f.repository.listCommands({ chatId: 'chat' }).length, 0);
  assert.equal(f.modelCalls(), 0);
});

test('project-bound HTTP cannot inspect, send, configure or answer in another project', async t => {
  const f = await fixture(t);
  for (const [route, method, body] of [
    ['/api/chats/foreign', 'GET'],
    ['/api/chats/foreign/requests', 'GET'],
    ['/api/chats/foreign/commands', 'POST', { action: 'send', text: 'Cross-project' }],
    ['/api/chats/foreign/configuration', 'PATCH', { selection: { providerId: 'provider', modelId: 'other' }, clientRequestId: 'foreign-config' }],
  ]) {
    const response = await f.request(route, { method, body });
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'workspace_denied');
  }
  const events = await f.request('/api/chats/events?chatId=foreign');
  assert.equal(events.status, 403);
});

test('a device can submit human input but cannot forge execution-host or agent authority', async t => {
  const f = await fixture(t); let received;
  f.host(async input => { received = input; f.append(input); return { outcome: 'no_report' }; });
  const response = await f.request('/api/chats/chat/commands', { method: 'POST', headers: { 'x-test-device': '1', 'x-minnow-chat-client': 'cli' },
    body: { action: 'send', text: 'From phone', clientRequestId: 'device-send' } });
  assert.equal(response.status, 202); await f.service.idle('chat');
  assert.equal(received.command.provenance.source, 'device');
  assert.equal(received.command.provenance.actor, 'human');
  assert.equal(received.execution.kind, 'server');
  for (const action of ['claim', 'execute', 'publish']) {
    const denied = await f.request('/api/chats/chat/commands', { method: 'POST', headers: { 'x-test-device': '1' }, body: { action, text: 'No owner claim' } });
    assert.equal(denied.status, 400);
  }
  const caller = await f.context.humanCaller('chat', { workspacePath: f.workspace, ingress: 'device' });
  assert.throws(() => assertExecutionCaller(caller.caller), error => error.code === 'caller_not_active');
});

test('configuration captures exact pairs and immutable profiles with atomic lost-receipt retry and stale revision checks', async t => {
  const f = await fixture(t);
  const body = { action: 'configure', selection: { providerId: 'next-provider', modelId: 'next-model', options: { reasoningEffort: 'high' } },
    expectedProfileVersion: 0, clientRequestId: 'configuration' };
  const first = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body });
  assert.equal(first.status, 200);
  assert.equal(f.repository.getLatestProfile('chat').snapshot.modelSelection.options.reasoningEffort, 'high');
  const calls = f.modelCalls();
  const repeated = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body });
  assert.equal(repeated.status, 200); assert.equal(repeated.body.receipt.replayed, true);
  assert.equal(f.modelCalls(), calls); assert.equal(f.repository.getLatestProfile('chat').profileVersion, 1);
  const conflict = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: { ...body, selection: { providerId: 'other', modelId: 'other' } } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'idempotency_conflict');
  const stale = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: { ...body, clientRequestId: 'stale' } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'stale_revision');
  const partial = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: { selection: { modelId: 'partial' }, clientRequestId: 'partial' } });
  assert.equal(partial.status, 400);
  const invalidSelection = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: { selection: null, clientRequestId: 'null-pair' } });
  assert.equal(invalidSelection.status, 400);
  const rename = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: { name: 'Renamed', pinned: true, expectedProfileVersion: 1, clientRequestId: 'rename' } });
  assert.equal(rename.status, 200);
  const pinnedAt = f.repository.getChat('chat').pinnedAt;
  assert.ok(Number.isFinite(pinnedAt) && pinnedAt > 0);
  const renameRetry = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: { name: 'Renamed', pinned: true, expectedProfileVersion: 1, clientRequestId: 'rename' } });
  assert.equal(renameRetry.status, 200); assert.equal(renameRetry.body.receipt.replayed, true);
  assert.equal(f.repository.getChat('chat').pinnedAt, pinnedAt);
  assert.equal(f.repository.getLatestProfile('chat').profileVersion, 1);
});

test('human model configuration replaces option overrides without rebinding queued work, and unsupported options leave the profile intact', async t => {
  const inputs = [], f = await fixture(t, { beforeSelection: input => {
    inputs.push(input);
    if (input.target?.options?.reasoningEffort === 'unsupported') throw new ChatContractError('options_unsupported', 'This effort is unavailable.');
  } });
  const target = await f.context.resolveTarget('chat');
  const previous = { providerId: 'provider', modelId: 'model', options: { reasoningEffort: 'high', thinkingMode: 'on' } };
  f.repository.saveProfile('chat', { profileId: 'profile', profileVersion: 1, snapshot: { policy: target.policy, modelSelection: previous } });
  f.repository.admitCommand({ version: 1, chatId: 'chat', commandId: 'queued-before-config', kind: 'send', requestedAt: 1, message: 'Already queued', modelSelection: previous,
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } }, { producerId: 'human', requestKey: 'queued-before-config' });
  const cleared = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: {
    selection: { providerId: 'provider', modelId: 'model' }, expectedProfileVersion: 1, clientRequestId: 'clear-overrides' } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(inputs[0], { target: { providerId: 'provider', modelId: 'model', options: {} } });
  assert.deepEqual(f.repository.getLatestProfile('chat').snapshot.modelSelection.options, {});
  assert.deepEqual(f.repository.getProfile('profile', 1).snapshot.modelSelection, previous);
  assert.deepEqual(f.repository.getCommand('queued-before-config').effectiveCommand.modelSelection, previous);
  const rejected = await f.request('/api/chats/chat/configuration', { method: 'PATCH', body: { selection: {
    providerId: 'provider', modelId: 'model', options: { reasoningEffort: 'unsupported' } }, expectedProfileVersion: 2, clientRequestId: 'unsupported-overrides' } });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error.code, 'options_unsupported');
  assert.equal(f.repository.getLatestProfile('chat').profileVersion, 2);
});

test('concurrent retries of one configuration receipt commit one immutable profile and both recover its original result', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let resolving = 0;
  const f = await fixture(t, { beforeSelection: async () => { if (++resolving === 2) release(); await gate; } });
  const body = { action: 'configure', selection: { providerId: 'parallel-provider', modelId: 'parallel-model' },
    expectedProfileVersion: 0, clientRequestId: 'parallel-config' };
  const results = await Promise.all([1, 2].map(() => f.request('/api/chats/chat/configuration', { method: 'PATCH', body })));
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(f.repository.getLatestProfile('chat').profileVersion, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM chat_execution_profiles WHERE chat_id=?').get('chat').count, 1);
});

test('independent durable questions respond to the owning request and reject cross-chat and expired approval callbacks', async t => {
  const f = await fixture(t);
  const firstFence = f.repository.claimExecution({ chatId: 'chat', executionId: 'question-execution', ownerId: 'question-host' });
  const secondFence = f.repository.claimExecution({ chatId: 'second', executionId: 'second-execution', ownerId: 'question-host' });
  const question = (chatId, fence, toolCallId, kind = 'question') => f.requests.open({ chatId, executionId: fence.executionId, fence,
    toolCallId, kind, title: 'Choose', presentation: { options: ['one', 'two'] } });
  const first = question('chat', firstFence, 'question-one'), second = question('chat', firstFence, 'question-two');
  const foreign = question('second', secondFence, 'other-question');
  const pending = await f.request('/api/chats/chat/requests');
  assert.deepEqual(pending.body.requests.map(row => row.requestId).sort(), [first.requestId, second.requestId].sort());
  const answered = await f.request('/api/chats/chat/requests/' + first.requestId + '/respond', { method: 'POST', body: { answer: { choice: 'one' }, clientRequestId: 'answer-one' } });
  assert.equal(answered.status, 200); assert.equal(f.repository.getRequest(second.requestId).state, 'pending');
  const retry = await f.request('/api/chats/chat/requests/' + first.requestId + '/respond', { method: 'POST', body: { answer: { choice: 'one' }, clientRequestId: 'answer-one' } });
  assert.equal(retry.status, 200);
  const wrong = await f.request('/api/chats/chat/requests/' + foreign.requestId + '/respond', { method: 'POST', body: { answer: 'wrong', clientRequestId: 'wrong' } });
  assert.equal(wrong.status, 404);
  const approval = question('chat', firstFence, 'approval', 'approval');
  const expired = await f.request('/api/chats/chat/requests/' + approval.requestId + '/respond', { method: 'POST', body: { answer: true, clientRequestId: 'expired-approval' } });
  assert.equal(expired.status, 409); assert.equal(expired.body.error.code, 'request_expired');
  for (const [chatId, fence] of [['chat', firstFence], ['second', secondFence]]) {
    f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease(chatId, fence);
  }
});

test('request presentation pages preserve every pending identity and bound old history after authenticated scope checks', async t => {
  const f = await fixture(t);
  const fence = f.repository.claimExecution({ chatId: 'chat', executionId: 'paged-questions', ownerId: 'host' });
  for (let index = 0; index < 48; index++) {
    const requestId = `page-request-${String(index).padStart(3, '0')}`;
    f.repository.saveRequest({ version: 1, requestId, chatId: 'chat', executionId: fence.executionId, toolCallId: `tool-${index}`, kind: 'question',
      state: 'pending', title: 'Saved question', presentation: { question: index }, createdAt: index }, { fence });
    if (index < 8) f.repository.settleRequest(requestId, { state: 'cancelled', settledAt: 100 + index });
  }
  const first = await f.request('/api/chats/chat/requests?limit=32');
  assert.equal(first.status, 200); assert.equal(first.body.pendingCount, 40); assert.equal(first.body.requests.length, 40);
  assert.equal(first.body.requests.filter(item => item.state === 'pending').length, 32); assert.equal(first.body.truncated, true);
  const next = await f.request('/api/chats/chat/requests?limit=32&pending_cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.equal(next.status, 200); assert.equal(next.body.requests.length, 8); assert.equal(next.body.nextCursor, null);
  assert.equal(new Set([...first.body.requests, ...next.body.requests].filter(item => item.state === 'pending').map(item => item.requestId)).size, 40);
  for (const query of ['limit=33', 'limit=1&limit=2', 'pending_cursor=bad%2Fcursor', 'unexpected=true']) assert.equal((await f.request('/api/chats/chat/requests?' + query)).status, 400);
  assert.equal((await f.request('/api/chats/foreign/requests?limit=32')).status, 403);
});

test('legacy Continue is a scoped human protocol-v1 write and ignores no browser-supplied history or task authority', async t => {
  const f = await fixture(t, { legacyImports: true }); const route = '/api/chats/chat/legacy/old-task/continue';
  const options = { method: 'POST', body: { clientRequestId: 'legacy-continue' }, headers: { 'x-test-host': '1' } };
  assert.equal((await f.request(route, { ...options, headers: {} })).status, 403);
  assert.equal((await f.request(route, { ...options, headers: { 'x-test-host': '1', 'X-Minnow-Chat-Protocol': '0' } })).status, 409);
  assert.equal((await f.request('/api/chats/foreign/legacy/old-task/continue', options)).status, 403);
  assert.equal((await f.request(route, { ...options, body: { ...options.body, history: [{ role: 'assistant', content: 'Forged' }] } })).status, 400);
  const created = await f.request(route, options); assert.equal(created.status, 200);
  const childId = created.body.receipt.childChatId; assert.equal(f.repository.getRelation(childId).origin, 'legacy_import');
  assert.match(f.repository.readTranscript(childId).messages[0].content, /Historical answer/);
  assert.equal(f.repository.listExecutions({ chatId: childId }).length, 0); assert.equal(f.repository.listCommands({ chatId: childId }).length, 0);
  const replay = await f.request(route, options); assert.equal(replay.body.receipt.childChatId, childId); assert.equal(replay.body.receipt.replayed, true);
});

test('transport requires read authority for snapshots and send authority for managed configuration', async t => {
  const unreadable = await fixture(t, { capabilities: [] });
  for (const route of ['/api/chats/chat', '/api/chats/chat/requests']) {
    const response = await unreadable.request(route);
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'policy_denied');
  }
  const events = await unreadable.request('/api/chats/events?chatId=chat');
  assert.equal(events.status, 403);
  const readOnly = await fixture(t, { capabilities: ['chat.read'] });
  const rename = await readOnly.request('/api/chats/chat/configuration', { method: 'PATCH',
    body: { name: 'Unauthorized rename', clientRequestId: 'rename' } });
  assert.equal(rename.status, 403);
  assert.equal(readOnly.repository.getChat('chat').name, 'chat');
});

test('real SSE connection receives an initial canonical frame then scoped coalesced progress', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(f.base + '/api/chats/events?chatId=chat', { signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  async function nextFrame() {
    let buffer = '';
    while (true) {
      const chunk = await reader.read(); if (chunk.done) throw new Error('SSE ended');
      buffer += decoder.decode(chunk.value, { stream: true });
      const data = buffer.split('\n').find(line => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
    }
  }
  assert.equal((await nextFrame()).frame.chatId, 'chat');
  const fence = f.repository.claimExecution({ chatId: 'chat', executionId: 'sse-execution', ownerId: 'sse-host' });
  f.presentation.onEvent({ chatId: 'chat', executionId: fence.executionId, event: { type: 'round_start' } });
  f.presentation.onEvent({ chatId: 'chat', executionId: fence.executionId, event: { type: 'delta', text: 'Cumulative progress' } });
  const progress = await nextFrame();
  assert.equal(progress.frame.live.lastDelta, 'Cumulative progress');
  assert.equal(f.repository.readTranscript('chat').messages.length, 0);
  controller.abort(); await reader.cancel().catch(() => {});
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('chat', fence);
});

test('host capability registration and result submission reject devices and body-supplied project authority', async t => {
  const f = await fixture(t);
  const route = '/api/chats/host?hostId=desktop&capabilities=' + encodeURIComponent(JSON.stringify(['tool:browser_click']));
  const device = await f.request(route, { headers: { 'x-test-device': '1' } });
  assert.equal(device.status, 403); assert.equal(device.body.error.code, 'caller_denied');
  const result = await f.request('/api/chats/host/results', { method: 'POST', headers: { 'x-test-device': '1' },
    body: { hostId: 'desktop', invocationId: 'invocation', result: { content: 'Forged' } } });
  assert.equal(result.status, 403);
  const foreign = await f.request(route + '&projectId=foreign-project', { headers: { 'x-test-host': '1' } });
  assert.equal(foreign.status, 400);
  const malformed = await f.request('/api/chats/host?hostId=desktop&capabilities=not-json', { headers: { 'x-test-host': '1' } });
  assert.equal(malformed.status, 400);
  const oversized = await f.request('/api/chats/host?hostId=desktop&capabilities=' + encodeURIComponent(JSON.stringify(Array(257).fill('tool:browser_click'))),
    { headers: { 'x-test-host': '1' } });
  assert.equal(oversized.status, 400);
  assert.equal(f.capabilities.connectedHosts, 0);
});

test('authenticated host SSE dispatches an exact scoped invocation and immutable result receipts settle its original waiter', async t => {
  const f = await fixture(t), controller = new AbortController();
  const route = '/api/chats/host?hostId=desktop&capabilities=' + encodeURIComponent(JSON.stringify(['tool:browser_click']));
  const response = await fetch(f.base + route, { headers: { 'x-test-host': '1', 'X-Minnow-Chat-Protocol': '1' },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
  assert.equal(response.status, 200); assert.equal(f.capabilities.connectedHosts, 1);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const fence = f.repository.claimExecution({ chatId: 'chat', executionId: 'browser-execution', ownerId: 'server' });
  const target = await f.context.resolveTarget('chat');
  const resultPromise = f.capabilities.executeHostTool({ name: 'browser_click', args: { selector: '#save' }, ctx: { toolCallId: 'browser-call' },
    chatId: 'chat', executionId: fence.executionId, fence, signal: new AbortController().signal,
    prepared: { policy: target.policy, toolContext: { modeId: 'build', workspaceRoot: f.workspace } } });
  let buffer = '';
  while (!buffer.split('\n').some(line => line.startsWith('data: '))) {
    const chunk = await reader.read(); if (chunk.done) throw new Error('Host SSE ended'); buffer += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(buffer, /event: host-tool\n/);
  const envelope = JSON.parse(buffer.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal(envelope.projectId, f.project.projectId);
  assert.equal(envelope.context.workspaceRoot, f.workspace);
  assert.equal(envelope.executionId, fence.executionId);
  const invalid = await f.request('/api/chats/host/results', { method: 'POST', headers: { 'x-test-host': '1' },
    body: { hostId: 'desktop', invocationId: envelope.invocationId, result: { content: 'Clicked' }, projectId: 'forged' } });
  assert.equal(invalid.status, 400);
  const body = { hostId: 'desktop', invocationId: envelope.invocationId, result: { content: 'Clicked' } };
  const accepted = await f.request('/api/chats/host/results', { method: 'POST', headers: { 'x-test-host': '1' }, body });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.accepted, true);
  assert.deepEqual(await resultPromise, { content: 'Clicked' });
  const repeated = await f.request('/api/chats/host/results', { method: 'POST', headers: { 'x-test-host': '1' }, body });
  assert.equal(repeated.body.replayed, true);
  const conflict = await f.request('/api/chats/host/results', { method: 'POST', headers: { 'x-test-host': '1' },
    body: { ...body, result: { content: 'Changed result' } } });
  assert.equal(conflict.status, 409);
  controller.abort(); await reader.cancel().catch(() => {});
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('chat', fence);
});
