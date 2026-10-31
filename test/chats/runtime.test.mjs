import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const savedEnv = Object.fromEntries(['MINNOW_HOME', 'MINNOW_AGENT_CONVERSATIONS', 'NODE_ENV', 'TOOLS_ALLOW_ALL_PATHS'].map(key => [key, process.env[key]]));
let root, composer, modules;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-production-chat-'));
  process.env.MINNOW_HOME = path.join(root, 'home');
  process.env.MINNOW_AGENT_CONVERSATIONS = '1'; process.env.NODE_ENV = 'test'; process.env.TOOLS_ALLOW_ALL_PATHS = '1';
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
async function fixture(t, respond) {
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
  const names = ['read_file', 'save_file', 'wait'];
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
  runtime = modules.createProductionChatRuntime({ repository, turns, preparationAdapters, modelAdapters });
  const chatMiddleware = modules.createChatMiddleware({ getRuntime: () => runtime });
  const turnMiddleware = modules.createChatTurnsMiddleware(turns);
  server = http.createServer((req, res) => modules.runWithViewWorkspace(workspace, () =>
    chatMiddleware(req, res, () => turnMiddleware(req, res, () => { res.statusCode = 404; res.end('{}'); }))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await runtime.start();
  async function request(route, body) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' }, signal: AbortSignal.timeout(5000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { workspace, repository, db, runtime, turns, request, calls };
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

test('legacy renderer ownership drains before managed takeover and release kicks the durable queue', { timeout: 15000 }, async t => {
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
  await f.runtime.service.idle('legacy');
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.calls.length, 1);
  f.turns.release('legacy', 'old-renderer');
  await f.runtime.service.idle('legacy');
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, 1);
  assert.equal(f.repository.getCommand(queued.body.receipt.commandId).state, 'settled');
  assert.equal(f.calls.length, 2);
  assert.equal(f.turns.claim('legacy', 'late-renderer', 'desktop'), false);
  await assert.rejects(f.runtime.service.send(legacy.caller, { chatId: 'chat', message: 'After legacy release' }), error => error.code === 'caller_not_active');
});
