import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { upsertMessageRow } from '../../server/config/sessions-import.js';

const savedEnv = Object.fromEntries(['MINNOW_HOME', 'MINNOW_AGENT_CONVERSATIONS', 'MINNOW_ORDINARY_CHAT_EXECUTION', 'NODE_ENV', 'TOOLS_ALLOW_ALL_PATHS'].map(key => [key, process.env[key]]));
let root, composer, modules;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-production-chat-'));
  process.env.MINNOW_HOME = path.join(root, 'home');
  process.env.MINNOW_AGENT_CONVERSATIONS = '1'; process.env.NODE_ENV = 'test'; process.env.TOOLS_ALLOW_ALL_PATHS = '1';
  delete process.env.MINNOW_ORDINARY_CHAT_EXECUTION;
  const imports = await Promise.all([
    import('../../scripts/build-headless-runner.mjs'), import('../../server/chats/runtime.js'),
    import('../../server/chats/repository.js'), import('../../server/config/sessions-schema.js'),
    import('../../server/config/home.js'), import('../../server/config/store.js'),
    import('../../server/providers/store.js'), import('../../server/workspace/open-workspaces.js'),
    import('../../server/chat-turns/middleware.js'), import('../../server/runtime/path-access.js'),
    import('../../server/chats/middleware.js'), import('../../server/tools/builtin-catalog.js'),
    import('../../server/chats/policy.js'), import('../../server/generations/store.js'),
    import('../../server/config/sessions-db.js'),
  ]);
  modules = Object.assign({}, ...imports);
  modules.resetMinnowHomeCache(); await modules.ensureMinnowLayout();
  await modules.writeConfigJson('config.json', { toolSecurity: { filesystemAccess: 'full' } });
  const { outfile } = await modules.buildChatPreparation({ outfile: path.join(root, 'composer.mjs'), logLevel: 'error' });
  composer = await import(pathToFileURL(outfile).href);
});
after(async () => {
  modules?.deleteGenerationsForProviderShutdown(); modules?.closeSessionsDb();
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  modules?.resetMinnowHomeCache();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
const raw = (kind, id, body) => '---\nid: ' + id + '\nkind: ' + kind + '\nlabel: ' + id + '\nversion: 1\n---\n' + body;
const toolCall = (name, args, id = 'call') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function upstreamReply(response, value = 'Completed') {
  const calls = Array.isArray(value);
  const delta = calls ? { tool_calls: value.map((call, index) => ({ ...call, index })) } : { content: value };
  response.setHeader('Content-Type', 'text/event-stream');
  response.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: ' +
    JSON.stringify({ choices: [{ delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}
async function fixture(t, respond, extraNames = [], runtimeOptions = {}) {
  const workspace = await fs.mkdtemp(path.join(root, 'workspace-')); modules.openWorkspace(workspace);
  let runtime, server, db, upstream;
  t.after(async () => {
    await runtime?.dispose();
    for (const listener of [server, upstream]) {
      listener?.closeAllConnections();
      if (listener?.listening) await new Promise(resolve => listener.close(resolve));
    }
    modules.closeWorkspace(workspace); if (db?.open) db.close();
  });
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Production fixture workspace instructions.');
  const calls = [];
  upstream = http.createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'model' }] })); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); calls.push(input);
    try { upstreamReply(response, await respond(input, calls.length)); }
    catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const providerId = 'runtime-' + path.basename(workspace).replace(/[^A-Za-z0-9_-]/g, '').toLowerCase();
  const provider = await modules.createProvider({ id: providerId, label: 'Runtime fixture', apiKind: 'openai-v1',
    baseUrl: 'http://127.0.0.1:' + upstream.address().port });
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); modules.initSessionsSchema(db);
  const repository = modules.createChatRepository({ db });
  for (const id of ['chat', 'legacy']) repository.createChat({ id, name: id, workspacePath: workspace, providerId, modelId: 'model', modeId: 'build' });
  db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('legacy');
  const names = ['read_file', 'save_file', 'wait', ...extraNames];
  const settings = { meta: { features: { memoryInjection: false, codeMapInjectionDefault: false, contextDocumentsInjectionDefault: true },
    toolSecurity: { filesystemAccess: 'full' }, thinking: { defaultMode: 'off', thinkingBudgetTokens: null } },
    tools: { enabled: {}, permissions: { default: Object.fromEntries(names.map(name => [name, 'full'])) } }, rules: { version: 2, enabled: false, groups: [], rules: [] } };
  const preparationAdapters = {
    loadComposer: async () => composer, readSettings: async () => settings,
    listTools: async () => modules.BUILT_IN_TOOLS.filter(row => names.includes(row.id)).map(row => row.definition),
    loadWorkAgents: async () => ({ agents: [{ id: 'builder', label: 'Builder', kind: 'work-agent', version: '1', defaultForModes: ['build'], allowedTools: null }], overrides: {} }),
    loadSubAgentTypes: async () => ({ enabled: true, types: {}, defaultContextEnforcementPolicy: 'compact' }),
    loadPromptSources: async () => ({ builtinRaw: {
      'base/default.full.md': raw('base', 'default', 'REAL SHARED COMPOSER {{mode}} {{cwd}}'),
      'work-agents/builder/agent.full.md': raw('work-agent', 'builder', 'Build the requested feature.'),
      'info/general-assistant.full.md': raw('info', 'general-assistant', 'Current project context.'),
    }, userRaw: {} }),
    readTranscript: async chatId => repository.readTranscript(chatId),
    resolveModelContextLimit: async () => 32000,
  };
  const modelAdapters = { listProviders: async () => [provider], listModels: async () => [{ id: 'model' }],
    readCapabilities: async () => ({ models: { model: { tool_use: true, vision: false } } }), modelAvailability: async () => ({ available: true }) };
  const turns = modules.createChatTurnRegistry({ generations: () => [],
    isServerOwned: id => repository.getChat(id).chatCommandVersion === 1,
    extraTurns: () => runtime?.listTurns() ?? [], onRelease: (chatId, ownerId) => runtime?.releaseLegacy(chatId, ownerId),
  });
  runtime = modules.createProductionChatRuntime({ ...runtimeOptions, repository, turns, preparationAdapters, modelAdapters });
  const chatMiddleware = modules.createChatMiddleware({ getRuntime: () => runtime });
  const turnMiddleware = modules.createChatTurnsMiddleware(turns);
  server = http.createServer((req, res) => modules.runWithViewWorkspace(workspace, () =>
    chatMiddleware(req, res, () => turnMiddleware(req, res, () => { res.statusCode = 404; res.end('{}'); }))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await runtime.start();
  async function request(route, body, timeoutMs = 5000) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' }, signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { workspace, repository, db, runtime, turns, request, calls, settings };
}

test('production managed HTTP send runs the shared composer/transport/canonical host without UI or a report tool', { timeout: 15000 }, async t => {
  const f = await fixture(t, () => 'Root managed prose.');
  const accepted = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Do the work', clientRequestId: 'root-work' });
  assert.equal(accepted.status, 202); await f.runtime.service.idle('chat');
  const command = f.repository.getCommand(accepted.body.receipt.commandId);
  assert.equal(command.state, 'settled'); assert.equal(command.result.outcome, 'no_report');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].tools.some(row => row.function.name === 'report_outcome'), false);
  assert.match(f.calls[0].messages[0].content, /REAL SHARED COMPOSER build/);
  assert.match(f.calls[0].messages[0].content, /Production fixture workspace instructions/);
  assert.deepEqual(f.repository.readTranscript('chat').messages.map(row => row.role), ['user', 'assistant']);
  const receipt = await f.request('/api/chat-commands/' + command.commandId);
  assert.equal(receipt.body.receipt.assistantFinal, 'Root managed prose.');
  const rawClaim = await f.request('/api/chat-turns', { action: 'claim', chatId: 'chat', ownerId: 'late-renderer' });
  assert.equal(rawClaim.status, 409); assert.equal(rawClaim.body.ok, false);
});

test('default production routing promotes an idle historical root and continues server execution after rollback without a renderer', { timeout: 30000 }, async t => {
  const previous = process.env.MINNOW_ORDINARY_CHAT_EXECUTION;
  delete process.env.MINNOW_ORDINARY_CHAT_EXECUTION;
  t.after(() => { if (previous === undefined) delete process.env.MINNOW_ORDINARY_CHAT_EXECUTION; else process.env.MINNOW_ORDINARY_CHAT_EXECUTION = previous; });
  const f = await fixture(t, () => 'Server-owned after promotion.');
  const dbRows = [{ role: 'user', content: 'Saved earlier task' },
    { role: 'assistant', content: '', tool_calls: [toolCall('save_file', { path: 'old.txt', content: 'historical' }, 'saved-old-call')] },
    { role: 'tool', tool_call_id: 'saved-old-call', content: 'Saved previously' }, { role: 'assistant', content: 'Earlier task complete' }];
  for (const [index, row] of dbRows.entries()) f.repository.getDatabase().prepare('INSERT INTO messages(chat_id,seq,payload_json,row_hash) VALUES(?,?,?,?)')
    .run('legacy', index, JSON.stringify(row), 'fixture-' + index);
  f.db.prepare('UPDATE chats SET message_count=? WHERE id=?').run(dbRows.length, 'legacy');
  const capability = await f.request('/api/chats/capabilities');
  assert.equal(capability.body.ordinaryExecution.admissionEnabled, true);
  const route = await f.request('/api/chats/legacy/ordinary-routing');
  assert.equal(route.body.eligible, true, JSON.stringify(route.body));
  const promoted = await f.request('/api/chats/legacy/ordinary-routing', { expectedRevision: route.body.revision, clientRequestId: 'production-promotion' });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(f.calls.length, 0); assert.deepEqual(f.repository.readTranscript('legacy').messages, dbRows);
  process.env.MINNOW_ORDINARY_CHAT_EXECUTION = '0';
  const accepted = await f.request('/api/chats/legacy/commands', { action: 'send', text: 'Continue on server', clientRequestId: 'after-promotion-rollback' });
  assert.equal(accepted.status, 202); await f.runtime.service.idle('legacy');
  assert.equal(f.repository.getCommand(accepted.body.receipt.commandId).state, 'settled');
  assert.equal(f.calls.length, 1); assert.equal(f.repository.getChat('legacy').chatCommandVersion, 1);
  const recorded = f.repository.getCommand(accepted.body.receipt.commandId).result.timings;
  assert.equal(recorded.intervalsOverlap, true);
  assert.ok(recorded.totals.host_execution.count > 0);
  assert.ok(recorded.events.every(row => row.correlationId));
  await assert.rejects(fs.access(path.join(f.workspace, 'old.txt')), { code: 'ENOENT' });
});

test('ordinary HTTP worktree send binds the final checkout before inference and later turns retain it', { timeout: 30000 }, async t => {
  const f = await fixture(t, input => input.messages.some(row => row.role === 'tool')
    ? 'Verified isolated checkout.' : [toolCall('save_file', { path: 'isolated.txt', content: 'only in checkout' }, 'isolated-write')]);
  const git = args => promisify(execFile)('git', args, { cwd: f.workspace, windowsHide: true });
  await git(['init']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['add', '.']); await git(['commit', '-m', 'seed']);
  f.db.prepare("UPDATE chats SET meta_json=json_set(meta_json,'$.worktreeEnabled',json('true')) WHERE id='chat'").run();
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('chat');
  const eligible = await f.request('/api/chats/chat/ordinary-routing');
  assert.equal(eligible.body.reason, 'new_root'); assert.equal(eligible.body.eligible, true);
  const promotion = await f.request('/api/chats/chat/ordinary-routing', { expectedRevision: eligible.body.revision, clientRequestId: 'worktree-promotion' });
  assert.equal(promotion.status, 200, JSON.stringify(promotion.body));
  assert.equal(promotion.body.receipt.disposition, 'promoted');
  assert.equal(f.calls.length, 0, 'promotion never starts inference');
  const first = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Use isolated worktree', clientRequestId: 'worktree-first' });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const initial = f.repository.getCommand(first.body.receipt.commandId);
  assert.ok(initial.captured.workspacePreparation?.id);
  await f.runtime.service.idle('chat');
  const saved = f.repository.getChat('chat');
  assert.equal(saved.workspacePreparation.status, 'ready', saved.workspacePreparation.error);
  assert.equal(f.repository.getCommand(initial.commandId).state, 'settled', JSON.stringify(f.repository.getCommand(initial.commandId)));
  assert.ok(saved.worktreeRoot && saved.worktreeRoot !== f.workspace);
  assert.match(f.calls[0].messages[0].content, new RegExp(saved.worktreeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), 'prompt cwd must be the final checkout');
  assert.equal(await fs.readFile(path.join(saved.worktreeRoot, 'isolated.txt'), 'utf8'), 'only in checkout');
  await assert.rejects(fs.access(path.join(f.workspace, 'isolated.txt')), { code: 'ENOENT' });
  const second = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Continue there', clientRequestId: 'worktree-next' });
  assert.equal(second.status, 202, JSON.stringify(second.body)); await f.runtime.service.idle('chat');
  assert.equal(f.repository.getCommand(second.body.receipt.commandId).state, 'settled');
  assert.equal(f.repository.getChat('chat').worktreeRoot, saved.worktreeRoot);
  const snapshot = await f.request('/api/chats/chat');
  assert.equal(snapshot.body.chat.workspacePreparation.intent.id, initial.captured.workspacePreparation.id);
});

test('default idle HTTP promotion preserves saved history; rollback only blocks new ownership', { timeout: 15000 }, async t => {
  const f = await fixture(t, () => 'Continued saved history.');
  const history = [{ role: 'user', content: 'Saved earlier question' }, { role: 'assistant', content: 'Saved earlier answer' }];
  history.forEach((message, index) => upsertMessageRow(f.db, 'legacy', index, message));
  f.db.prepare('UPDATE chats SET message_count=? WHERE id=?').run(history.length, 'legacy');
  const eligible = await f.request('/api/chats/legacy/ordinary-routing');
  assert.equal(eligible.body.reason, 'idle_root'); assert.equal(eligible.body.eligible, true);
  const input = { expectedRevision: eligible.body.revision, clientRequestId: 'idle-promotion' };
  const promoted = await f.request('/api/chats/legacy/ordinary-routing', input);
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.frame.fields.chatCommandVersion, 1);
  assert.equal(f.calls.length, 0);
  process.env.MINNOW_ORDINARY_CHAT_EXECUTION = '0';
  t.after(() => { delete process.env.MINNOW_ORDINARY_CHAT_EXECUTION; });
  const capability = await f.request('/api/chats/capabilities');
  assert.equal(capability.body.ordinaryExecution.admissionEnabled, false);
  assert.equal(capability.body.ordinaryExecution.recoveryEnabled, true);
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('chat');
  const disabled = await f.request('/api/chats/chat/ordinary-routing');
  assert.equal(disabled.body.reason, 'disabled'); assert.equal(disabled.body.eligible, false);
  const denied = await f.request('/api/chats/chat/ordinary-routing', { expectedRevision: disabled.body.revision, clientRequestId: 'disabled-promotion' });
  assert.equal(denied.status, 409);
  const retry = await f.request('/api/chats/legacy/ordinary-routing', input);
  assert.equal(retry.status, 200); assert.equal(retry.body.receipt.replayed, true);
  const send = await f.request('/api/chats/legacy/commands', { action: 'send', text: 'Continue without taking a renderer lease', clientRequestId: 'idle-followup' });
  assert.equal(send.status, 202, JSON.stringify(send.body));
  await f.runtime.service.idle('legacy');
  assert.equal(f.repository.getCommand(send.body.receipt.commandId).state, 'settled');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].messages.some(row => row.content === history[0].content));
  assert.ok(f.calls[0].messages.some(row => row.content === history[1].content));
  assert.deepEqual(f.repository.readTranscript('legacy').messages.slice(0, 2).map(row => row.content), history.map(row => row.content));
});

test('failed worktree dependency setup has HTTP Retry and explicit Local without replaying the accepted inference', { timeout: 45000 }, async t => {
  const f = await fixture(t, () => 'Must not run during setup');
  const git = args => promisify(execFile)('git', args, { cwd: f.workspace, windowsHide: true });
  await git(['init']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(f.workspace, 'package.json'), JSON.stringify({ name: 'workspace-http-fixture', version: '1.0.0', private: true,
    scripts: { install: 'node -e "process.exit(1)"' } }));
  await git(['add', '.']); await git(['commit', '-m', 'failing setup fixture']);
  f.db.prepare("UPDATE chats SET meta_json=json_set(meta_json,'$.worktreeEnabled',json('true')) WHERE id='chat'").run();
  const sent = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Prepare first', clientRequestId: 'setup-failure' });
  assert.equal(sent.status, 202); await f.runtime.service.idle('chat');
  const failed = f.repository.getChat('chat').workspacePreparation;
  assert.equal(failed.status, 'failed'); assert.equal(f.calls.length, 0);
  await fs.writeFile(path.join(failed.binding.path, 'package.json'), JSON.stringify({ name: 'workspace-http-fixture', version: '1.0.0', private: true }));
  const retry = await f.request('/api/chats/chat/workspace', { action: 'retry', expectedIntentId: failed.intent.id, clientRequestId: 'retry-setup' }, 30000);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.chat.workspacePreparation.status, 'ready'); assert.equal(f.calls.length, 0);
  assert.equal(f.repository.getCommand(sent.body.receipt.commandId).state, 'failed', 'Retry setup never repeats inference');
  const local = await f.request('/api/chats/chat/workspace', { action: 'local', expectedIntentId: failed.intent.id, clientRequestId: 'back-local' });
  assert.equal(local.status, 200, JSON.stringify(local.body)); assert.equal(local.body.chat.worktreeRoot || '', '');
  assert.equal(local.body.chat.workspacePreparation.status, 'local');
  assert.equal(await fs.readFile(path.join(failed.binding.path, 'AGENTS.md'), 'utf8'), 'Production fixture workspace instructions.');
});

test('production native file dispatch records one real effect and enforces captured workspace ceiling despite global full access', { timeout: 15000 }, async t => {
  let outside;
  const f = await fixture(t, input => {
    const last = input.messages.filter(row => row.role === 'user').at(-1)?.content;
    if (last === 'Attempt outside') return input.messages.some(row => row.role === 'tool' && row.tool_call_id === 'outside-write')
      ? 'Outside access was blocked.' : [toolCall('save_file', { path: outside, content: 'Must not exist' }, 'outside-write')];
    if (!input.messages.some(row => row.role === 'tool')) return [toolCall('save_file', { path: 'evidence.txt', content: 'Saved once' }, 'inside-write')];
    return 'File saved.';
  });
  outside = path.join(root, 'outside-' + path.basename(f.workspace) + '.txt');
  const target = await f.runtime.context.resolveTarget('chat');
  assert.equal(target.currentPolicy.filesystemAccess, 'full');
  const restricted = modules.createChatPolicy({ ...target.policy, filesystemAccess: 'workspace', fileWriteScope: 'workspace' });
  f.repository.saveProfile('chat', { profileId: 'workspace-ceiling', profileVersion: 1, snapshot: { policy: restricted } });
  const originalIntent = f.repository.recordToolIntent; let intents = 0;
  f.repository.recordToolIntent = (...args) => { intents += 1; return originalIntent(...args); };
  const first = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Save once', clientRequestId: 'save' });
  await f.runtime.service.idle('chat');
  assert.equal(f.repository.getCommand(first.body.receipt.commandId).state, 'settled');
  assert.equal(await fs.readFile(path.join(f.workspace, 'evidence.txt'), 'utf8'), 'Saved once');
  assert.equal(intents, 1);
  const second = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Attempt outside', clientRequestId: 'outside' });
  await f.runtime.service.idle('chat');
  assert.equal(f.repository.getCommand(second.body.receipt.commandId).state, 'settled');
  assert.match(f.repository.readTranscript('chat').messages.find(row => row.tool_call_id === 'outside-write').content, /Error:|outside|workspace/i);
  await assert.rejects(fs.access(outside), error => error.code === 'ENOENT');
  assert.equal((await f.runtime.context.resolveTarget('chat')).policy.filesystemAccess, 'workspace');
  assert.equal(f.repository.listUnsettledToolInvocations(f.repository.getCommand(first.body.receipt.commandId).executionId).length, 0);
});

test('production timer wait keeps its execution identity while a second human input queues and executes once', { timeout: 15000 }, async t => {
  const f = await fixture(t, input => {
    const last = input.messages.filter(row => row.role === 'user').at(-1)?.content;
    if (last === 'Queued follow-up') return 'Second complete.';
    return input.messages.some(row => row.role === 'tool') ? 'First complete.' : [toolCall('wait', { duration: 0.15, reason: 'Fixture wait' }, 'timer')];
  });
  let resolveWaiting; const waiting = new Promise(resolve => { resolveWaiting = resolve; });
  const update = f.repository.updateExecution;
  f.repository.updateExecution = (...args) => { const result = update(...args); if (result.status === 'waiting') resolveWaiting(result); return result; };
  const first = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Timer task', clientRequestId: 'timer' });
  const paused = await waiting;
  const pausedFrame = f.runtime.presentation.frame('chat');
  assert.equal(pausedFrame.running, false); assert.equal(pausedFrame.fields.agentExecution.status, 'waiting');
  const queued = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Queued follow-up', clientRequestId: 'queued' });
  assert.equal(queued.status, 202);
  assert.equal(f.repository.getCommand(queued.body.receipt.commandId).state, 'queued');
  assert.equal(f.repository.getLatestExecution('chat').executionId, paused.executionId);
  await f.runtime.service.idle('chat');
  assert.equal(f.repository.getCommand(first.body.receipt.commandId).state, 'settled');
  assert.equal(f.repository.getCommand(queued.body.receipt.commandId).state, 'settled');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.repository.readTranscript('chat').messages.filter(row => row.role === 'user').map(row => row.content), ['Timer task', 'Queued follow-up']);
});

test('legacy renderer authority drains without bypassing ordinary admission parity gates', { timeout: 15000 }, async t => {
  const f = await fixture(t, () => 'After legacy drain.');
  assert.equal(f.turns.claim('legacy', 'old-renderer', 'desktop'), true);
  const legacy = await f.runtime.legacyCaller({ chatId: 'legacy', ownerId: 'old-renderer' });
  assert.equal((await f.runtime.legacyCaller({ chatId: 'legacy', ownerId: 'old-renderer' })).caller, legacy.caller);
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.repository.getExecution(legacy.execution.executionId), null);
  await assert.rejects(f.runtime.legacyCaller({ chatId: 'legacy', ownerId: 'forged-owner' }), error => error.code === 'caller_not_active');
  const peer = await f.runtime.service.send(legacy.caller, { chatId: 'chat', message: 'Peer input from draining renderer', clientRequestId: 'legacy-peer' });
  await f.runtime.service.idle('chat');
  assert.equal(f.repository.getCommand(peer.commandId).command.provenance.causalRootId, legacy.execution.executionId);
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  await assert.rejects(f.runtime.service.send({ ...legacy.caller }, { chatId: 'chat', message: 'Forged caller' }), error => error.code === 'caller_denied');
  const queued = await f.request('/api/chats/legacy/commands', { action: 'send', text: 'After old flush', clientRequestId: 'legacy-follow-up' });
  assert.equal(queued.status, 409);
  assert.match(JSON.stringify(queued.body), /promotion/);
  await f.runtime.service.idle('legacy');
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.calls.length, 1);
  f.turns.release('legacy', 'old-renderer');
  await f.runtime.service.idle('legacy');
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.runtime.service.send(legacy.caller, { chatId: 'chat', message: 'After legacy release' }), error => error.code === 'caller_not_active');
  assert.equal(f.turns.claim('legacy', 'late-renderer', 'desktop'), true);
});


test('production connected-host dispatch revalidates the stored execution rather than trusting input authority', { timeout: 15000 }, async t => {
  const f = await fixture(t, input => input.messages.some(row => row.role === 'tool')
    ? 'Host result received.' : [toolCall('read_clipboard', {}, 'host-read')], ['read_clipboard']);
  const target = await f.runtime.context.resolveTarget('chat');
  const envelopes = [];
  const disconnect = f.runtime.capabilities.register({ hostId: 'fixture-host', projectId: target.scope.projectId,
    capabilities: ['tool:read_clipboard'], send(envelope) {
      if (envelope.type !== 'execute') return;
      envelopes.push(envelope);
      queueMicrotask(() => f.runtime.capabilities.respond({ hostId: 'fixture-host', invocationId: envelope.invocationId,
        result: { content: 'Synthetic clipboard context' } }, { projectId: target.scope.projectId }));
    } });
  t.after(disconnect);
  const accepted = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Read fixture host context', clientRequestId: 'host-context' });
  assert.equal(accepted.status, 202);
  await f.runtime.service.idle('chat');
  assert.equal(envelopes.length, 1);
  const command = f.repository.getCommand(accepted.body.receipt.commandId);
  assert.equal(command.state, 'settled');
  assert.match(f.repository.readTranscript('chat').messages.at(-1).content, /Host result received/);
  assert.equal(envelopes[0].executionId, command.executionId);
});


test('directory replacement after receipt cannot rebind preparation before inference', { timeout: 15000 }, async t => {
  let replaced = false;
  const f = await fixture(t, () => 'Must not dispatch', [], {
    prepare: async (input, options) => {
      const cwd = input.execution.captured.scope.canonicalKey;
      await fs.rename(cwd, cwd + '-retired');
      await fs.mkdir(cwd);
      replaced = true;
      const { prepareChatExecution } = await import('../../server/chats/preparation.js');
      return prepareChatExecution(input, options);
    },
  });
  const accepted = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Original checkout only', clientRequestId: 'before-prepare-replacement' });
  assert.equal(accepted.status, 202);
  await f.runtime.service.idle('chat');
  assert.equal(replaced, true);
  assert.equal(f.calls.length, 0);
  const command = f.repository.getCommand(accepted.body.receipt.commandId);
  assert.ok(command.captured.checkoutIdentity);
  assert.equal(command.state, 'failed');
  assert.match(JSON.stringify(command.result), /checkout changed|replacement project/);
});

test('directory replacement during provider wait cannot inherit the prepared tool checkout', { timeout: 15000 }, async t => {
  let replaced = false;
  const f = await fixture(t, async input => {
    if (input.messages.some(row => row.role === 'tool')) return 'Replacement refused.';
    if (!replaced) {
      replaced = true;
      await fs.rename(f.workspace, f.workspace + '-original');
      await fs.mkdir(f.workspace);
    }
    return [toolCall('save_file', { path: 'must-not-write.txt', content: 'Untrusted replacement' }, 'replacement-write')];
  });
  const accepted = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Attempt replacement', clientRequestId: 'replacement' });
  assert.equal(accepted.status, 202);
  await f.runtime.service.idle('chat');
  assert.ok(replaced);
  await assert.rejects(fs.access(path.join(f.workspace, 'must-not-write.txt')), error => error.code === 'ENOENT');
  const message = f.repository.readTranscript('chat').messages.find(row => row.tool_call_id === 'replacement-write');
  assert.match(message?.content ?? JSON.stringify(f.repository.getCommand(accepted.body.receipt.commandId).result), /checkout changed|replacement project/);
});


test('permission revoked after the host check is denied again by ordinary dispatch', { timeout: 15000 }, async t => {
  const f = await fixture(t, input => input.messages.some(row => row.role === 'tool')
    ? 'Revocation observed.' : [toolCall('save_file', { path: 'revoked-write.txt', content: 'Forbidden' }, 'revoked-write')]);
  let checked = false;
  const record = f.repository.recordToolIntent;
  f.repository.recordToolIntent = (...args) => {
    checked = true;
    f.settings.tools.permissions.default.save_file = 'off';
    return record(...args);
  };
  const accepted = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Try a revoked write', clientRequestId: 'revoked-write' });
  assert.equal(accepted.status, 202);
  await f.runtime.service.idle('chat');
  assert.ok(checked, 'revocation happened after the initial tool check, at durable intent');
  await assert.rejects(fs.access(path.join(f.workspace, 'revoked-write.txt')), error => error.code === 'ENOENT');
  const result = f.repository.getCommand(accepted.body.receipt.commandId).result;
  // The durable intent already exists: the host conservatively requires
  // recovery rather than claiming a settled effect or replaying it.
  assert.equal(result.failure.code, 'recovery_required');
  assert.equal(f.calls.length, 1);
});
