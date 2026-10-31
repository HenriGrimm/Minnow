import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const [root, upstream] = process.argv.slice(2);
if (!root || !upstream) throw new Error('Owned fixture arguments are required');
process.env.MINNOW_HOME = path.join(root, 'home'); process.env.NODE_ENV = 'test'; process.env.MINNOW_AGENT_CONVERSATIONS = '1';
const modules = Object.assign({}, ...await Promise.all([
  import('../../scripts/build-headless-runner.mjs'), import('../../server/config/home.js'), import('../../server/config/sessions-schema.js'),
  import('../../server/chats/repository.js'), import('../../server/chats/runtime.js'), import('../../server/chats/middleware.js'),
  import('../../server/chats/tools.js'), import('../../server/chats/delegation.js'), import('../../server/chats/task-bridge.js'),
  import('../../server/chats/preparation.js'), import('../../server/sub-agents/middleware.js'), import('../../server/sub-agents/effector-runner.js'),
  import('../../server/sub-agents/derive.js'), import('../../server/sub-agents/journal.js'), import('../../server/orchestrator/engine.js'),
  import('../../server/workspace/open-workspaces.js'), import('../../server/runtime/path-access.js'), import('../../server/tools/builtin-catalog.js'),
  import('../../server/runner/tool-dispatch.js'),
]));
modules.resetMinnowHomeCache(); await modules.ensureMinnowLayout();
const workspace = path.join(root, 'workspace'); modules.openWorkspace(workspace);
const provider = path.join(process.env.MINNOW_HOME, 'providers', 'process-fixture'); await fs.mkdir(provider, { recursive: true });
await fs.writeFile(path.join(provider, 'profile.json'), JSON.stringify({ id: 'process-fixture', label: 'Owned process fixture', apiKind: 'openai-v1',
  enabled: true, baseUrl: upstream, authStyle: 'bearer', modelsPath: '/v1/models', chatCompletionsPath: '/v1/chat/completions' }));
const composerPath = path.join(root, 'composer.mjs');
try { await fs.access(composerPath); } catch { await modules.buildChatPreparation({ outfile: composerPath, logLevel: 'error' }); }
const composer = await import(pathToFileURL(composerPath).href);
const db = new Database(path.join(process.env.MINNOW_HOME, 'canonical.sqlite'));
db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON'); modules.initSessionsSchema(db);
const repository = modules.createChatRepository({ db });
try { repository.getChat('restart-parent'); }
catch { repository.createChat({ id: 'restart-parent', name: 'Restart controller', workspacePath: workspace, providerId: 'process-fixture', modelId: 'parent-model', modeId: 'build' }); }
const names = ['spawn_sub_agent', 'ask_question', 'read_file'];
const settings = { meta: { sampler: { maxTokens: 512 }, features: { memoryInjection: false, codeMapInjectionDefault: false, contextDocumentsInjectionDefault: false },
  toolSecurity: { filesystemAccess: 'workspace' }, thinking: { defaultMode: 'off', thinkingBudgetTokens: null } },
  tools: { enabled: {}, permissions: { default: Object.fromEntries(names.map(name => [name, 'full'])) } }, rules: { version: 2, enabled: false, rules: [], groups: [] } };
const config = { enabled: true, types: { reviewer: { enabled: true, allowedTools: null } } };
const raw = (kind, id, body) => `---\nid: ${id}\nkind: ${kind}\nlabel: ${id}\nversion: 1\n---\n${body}`;
const preparationAdapters = { loadComposer: async () => composer, readSettings: async () => settings,
  listTools: async () => modules.BUILT_IN_TOOLS.filter(tool => names.includes(tool.id)).map(tool => tool.definition),
  loadWorkAgents: async () => ({ agents: [{ id: 'restart-builder', kind: 'work-agent', version: '1', label: 'Builder', defaultForModes: ['build'], allowedTools: null }], overrides: {} }),
  loadSubAgentTypes: async () => config,
  loadPromptSources: async () => ({ builtinRaw: { 'base/default.full.md': raw('base', 'default', 'Use the supplied tools. {{mode}} {{cwd}}'),
    'info/general-assistant.full.md': raw('info', 'general-assistant', 'Owned process restart fixture.'),
    'work-agents/restart-builder/agent.full.md': raw('work-agent', 'restart-builder', 'Complete the current task with durable tool results.') }, userRaw: {} }),
  resolveModelContextLimit: async () => 32000 };
const runtime = modules.createProductionChatRuntime({ repository, preparationAdapters });
// Observe the actual server dispatcher, rather than infer execution from transcript rows.
const readLog = path.join(root, 'read-dispatch.jsonl');
runtime.setToolHandler('read_file', async input => {
  const dispatch = modules.createInProcessToolDispatch({ cwd: input.prepared.cwd, modeId: input.prepared.policy.modeId,
    allowedToolNames: Object.keys(input.prepared.policy.toolPermissions), filesystemAccessCeiling: input.prepared.policy.filesystemAccess,
    shellSandboxMode: input.prepared.policy.shellSandboxMode });
  const result = await dispatch.execute('read_file', input.args, input.toolContext);
  const handle = await fs.open(readLog, 'a');
  try { await handle.writeFile(JSON.stringify({ executionId: input.execution.executionId, toolCallId: input.toolContext.toolCallId }) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  return result;
});
modules.installChatTools(runtime);
modules.setAgentsEffectorFactory(owner => modules.createLazyPersistentSubAgentEffector({ legacyEffector: modules.createSubAgentEffector({ parentChatId: owner }),
  getRuntime: async () => runtime, getState: () => modules.peekEngine(owner, modules.AGENTS_NAMESPACE)?.getState() ?? modules.loadState(owner) }));
modules.installChatDelegation(runtime, { getEngine: modules.getAgentsEngine, loadConfig: async () => config,
  captureProfile: (chat, scope, options) => modules.captureChatProfile(chat, scope, { ...options, adapters: preparationAdapters }),
  resolveModelSelection: (input, options) => runtime.resolveModelSelection(input, options), cancelTree: input => runtime.taskDelivery.cancelTree(input) });
const middleware = modules.createChatMiddleware({ getRuntime: () => runtime });
const server = http.createServer((request, response) => {
  request.minnowAuth = { kind: 'host' };
  modules.runWithViewWorkspace(workspace, async () => {
    if (request.url === '/__fixture/state') {
      try {
        const chats = repository.listChatShells({ limit: 100 }).map(chat => ({ id: chat.id, relation: repository.getRelation(chat.id),
          execution: repository.getLatestExecution(chat.id), lease: repository.getLease(chat.id), requests: repository.listRequests(chat.id, null),
          commands: repository.listCommands({ chatId: chat.id, limit: 100 }), history: repository.readTranscript(chat.id).messages,
          questionWaiters: repository.listRequests(chat.id, 'pending').filter(row => runtime.requests.hasLiveWaiter(row.requestId)).map(row => row.requestId) }));
        const state = await modules.loadState('restart-parent');
        const reads = (await fs.readFile(readLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(row => JSON.parse(row));
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ chats, reads, runs: [...state.runs.values()],
          events: await modules.readEvents('restart-parent'), sqlite: { journal: db.pragma('journal_mode', { simple: true }), synchronous: db.pragma('synchronous', { simple: true }) } }));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message) })); }
      return;
    }
    await middleware(request, response, () => { response.statusCode = 404; response.end('{}'); });
  });
});
await runtime.start();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
process.send?.({ kind: 'ready', port: server.address().port });
