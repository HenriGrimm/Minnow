import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

/** A real production chat runtime with only persisted settings/catalog and upstream model responses controlled. */
export async function createProductionRuntimeTestEnvironment() {
  const saved = Object.fromEntries(['MINNOW_HOME', 'MINNOW_AGENT_CONVERSATIONS', 'NODE_ENV'].map(key => [key, process.env[key]]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-coordination-runtime-'));
  process.env.MINNOW_HOME = path.join(root, 'home'); process.env.MINNOW_AGENT_CONVERSATIONS = '1'; process.env.NODE_ENV = 'test';
  const imports = await Promise.all([
    import('../../scripts/build-headless-runner.mjs'), import('../../server/chats/runtime.js'),
    import('../../server/chats/repository.js'), import('../../server/config/sessions-schema.js'),
    import('../../server/config/home.js'), import('../../server/config/store.js'),
    import('../../server/providers/store.js'), import('../../server/workspace/open-workspaces.js'),
    import('../../server/chat-turns/middleware.js'), import('../../server/runtime/path-access.js'),
    import('../../server/chats/middleware.js'), import('../../server/tools/builtin-catalog.js'),
    import('../../server/chats/policy.js'), import('../../server/generations/store.js'), import('../../server/config/sessions-db.js'),
  ]);
  const modules = Object.assign({}, ...imports);
  modules.resetMinnowHomeCache(); await modules.ensureMinnowLayout();
  const { outfile } = await modules.buildChatPreparation({ outfile: path.join(root, 'composer.mjs'), logLevel: 'error' });
  const composer = await import(pathToFileURL(outfile).href);
  const raw = (kind, id, body) => '---\nid: ' + id + '\nkind: ' + kind + '\nlabel: ' + id + '\nversion: 1\n---\n' + body;
  return {
    modules, root,
    async fixture(t, { respond, toolNames, chats, install, agentMiddleware, runtimeOptions, subAgentTypes, usage } = {}) {
      const workspace = await fs.mkdtemp(path.join(root, 'workspace-'));
      const foreign = await fs.mkdtemp(path.join(root, 'foreign-'));
      modules.openWorkspace(workspace); modules.openWorkspace(foreign);
      let runtime, upstream, server, db, installation;
      t.after(async () => {
        await runtime?.dispose();
        await installation?.dispose?.();
        for (const listener of [server, upstream]) {
          listener?.closeAllConnections(); if (listener?.listening) await new Promise(resolve => listener.close(resolve));
        }
        modules.closeWorkspace(workspace); modules.closeWorkspace(foreign); if (db?.open) db.close();
      });
      const calls = [];
      upstream = http.createServer(async (request, response) => {
        if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'model' }] })); return; }
        let encoded = ''; for await (const chunk of request) encoded += chunk;
        const body = JSON.parse(encoded); const ordinal = calls.push(body);
        let value;
        try { value = await respond(body, ordinal); } catch (error) { response.statusCode = 500; response.end(String(error)); return; }
        const tools = Array.isArray(value), delta = tools ? { tool_calls: value.map((item, index) => ({ ...item, index })) } : { content: value ?? 'Completed.' };
        const measured = typeof usage === 'function' ? usage(body, ordinal) : usage;
        response.setHeader('Content-Type', 'text/event-stream');
        response.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: ' +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], ...(measured ? { usage: measured } : {}) }) + '\n\ndata: [DONE]\n\n');
      });
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const providerId = 'coordination-' + path.basename(workspace).toLowerCase();
      const provider = await modules.createProvider({ id: providerId, label: 'Coordination fixture', apiKind: 'openai-v1',
        baseUrl: 'http://127.0.0.1:' + upstream.address().port });
      db = new Database(':memory:'); db.pragma('foreign_keys=ON'); modules.initSessionsSchema(db);
      const repository = modules.createChatRepository({ db });
      for (const [id, config] of Object.entries(chats ?? { coordinator: {}, peer: {}, legacy: {}, foreign: { foreign: true } })) {
        repository.createChat({ id, name: id, workspacePath: config.foreign ? foreign : workspace, providerId,
          modelId: 'model', modeId: config.modeId ?? 'build' });
        if (id === 'legacy') db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run(id);
      }
      const names = toolNames ?? ['agent_capabilities', 'chat_list', 'chat_read', 'chat_send', 'chat_wait', 'chat_stop', 'read_file'];
      const settings = { meta: { features: { memoryInjection: false, codeMapInjectionDefault: false, contextDocumentsInjectionDefault: false },
        toolSecurity: { filesystemAccess: 'workspace' }, thinking: { defaultMode: 'off', thinkingBudgetTokens: null } },
        tools: { enabled: {}, permissions: { default: Object.fromEntries(names.map(name => [name, 'full'])) } },
        rules: { version: 2, enabled: false, groups: [], rules: [] } };
      const preparationAdapters = {
        loadComposer: async () => composer, readSettings: async () => settings,
        listTools: async () => modules.BUILT_IN_TOOLS.filter(row => names.includes(row.id)).map(row => row.definition),
        loadWorkAgents: async () => ({ agents: ['build', 'plan'].map(mode => ({ id: mode + '-fixture', label: mode,
          kind: 'work-agent', version: '1', defaultForModes: [mode], allowedTools: null })), overrides: {} }),
        loadSubAgentTypes: async () => subAgentTypes ?? { enabled: true, types: {}, defaultContextEnforcementPolicy: 'compact' },
        loadPromptSources: async agents => ({ builtinRaw: {
          'base/default.full.md': raw('base', 'default', 'REAL COORDINATION COMPOSER {{mode}} {{cwd}}'),
          'info/general-assistant.full.md': raw('info', 'general-assistant', 'Current project context.'),
          ...Object.fromEntries(agents.map(agent => ['work-agents/' + agent.id + '/agent.full.md', raw('work-agent', agent.id, 'Complete this ' + agent.label + ' task.')])) },
        userRaw: {} }),
        resolveModelContextLimit: async () => 32000,
      };
      const modelAdapters = { listProviders: async () => [provider], listModels: async () => [{ id: 'model' }],
        readCapabilities: async () => ({ models: { model: { tool_use: true, vision: false } } }), modelAvailability: async () => ({ available: true }) };
      const turns = modules.createChatTurnRegistry({ generations: () => [],
        isServerOwned: id => repository.getChat(id).chatCommandVersion === 1,
        extraTurns: () => runtime?.listTurns() ?? [], onRelease: (chatId, ownerId) => runtime?.releaseLegacy(chatId, ownerId) });
      runtime = modules.createProductionChatRuntime({ repository, turns, preparationAdapters, modelAdapters, ...runtimeOptions });
      installation = await install?.(runtime, { providerId, provider, modelAdapters, preparationAdapters, workspace });
      const chatMiddleware = modules.createChatMiddleware({ getRuntime: () => runtime });
      const rawTurns = modules.createChatTurnsMiddleware(turns);
      const agent = agentMiddleware?.({ getRuntime: () => runtime });
      server = http.createServer((request, response) => {
        request.minnowAuth = { kind: request.headers['x-test-device'] === '1' ? 'device' : 'host' };
        modules.runWithViewWorkspace(workspace, () => {
          const normal = () => chatMiddleware(request, response, () => rawTurns(request, response, () => { response.statusCode = 404; response.end('{}'); }));
          return agent ? agent(request, response, normal) : normal();
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await runtime.start();
      async function request(route, body, headers = {}) {
        const response = await fetch('http://127.0.0.1:' + server.address().port + route, { method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1', ...headers }, signal: AbortSignal.timeout(10000),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      }
      return { runtime, repository, db, calls, workspace, foreign, turns, providerId, request, settings,
        preparationAdapters, modelAdapters, installation };
    },
    async dispose() {
      modules.deleteGenerationsForProviderShutdown(); modules.closeSessionsDb();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      modules.resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true });
    },
  };
}
