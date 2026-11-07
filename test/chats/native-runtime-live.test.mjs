import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { createNativeEnforcementFixture } from '../fixtures/codex-native-enforcement.mjs';
import { __setCodexInvocationForTests, shutdownCodexSessions } from '../../server/generations/codex-app-server/manager.js';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../../server/generations/agent-cli/resolve-bin.js';
import { createProductionChatRuntime } from '../../server/chats/runtime.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { resetMinnowHomeCache, ensureMinnowLayout } from '../../server/config/home.js';
import { setAgentCliProviderEnabled, updateAgentCliProviderSettings, getProvider } from '../../server/providers/store.js';
import { openWorkspace, closeWorkspace } from '../../server/workspace/open-workspaces.js';
import { BUILT_IN_TOOLS } from '../../server/tools/builtin-catalog.js';
import { NATIVE_READ_TOOLS, NATIVE_WRITE_TOOLS } from '../../server/chats/native-execution.js';
import { createServerRunnerDeps } from '../../server/runtime/server-runner-deps.js';
import { postChatCompletionsInProcess } from '../../server/runner/generation-binding.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { buildChatPreparation } from '../../scripts/build-headless-runner.mjs';

test('production server commands capture native preference, enforce real policy, settle action journals and resume without repeating effects', {
  skip: process.env.MINNOW_CODEX_NATIVE_ENFORCEMENT !== '1' || process.platform !== 'win32', timeout: 120000,
}, async t => {
  const f = await createNativeEnforcementFixture();
  const prior = { MINNOW_HOME: process.env.MINNOW_HOME, CODEX_HOME: process.env.CODEX_HOME };
  let runtime, db;
  t.after(async () => {
    await runtime?.dispose(); await shutdownCodexSessions(); __setCodexInvocationForTests();
    deleteGenerationsForProviderShutdown(); if (db?.open) db.close(); closeWorkspace(f.workspace);
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetMinnowHomeCache(); await f.close();
  });
  process.env.MINNOW_HOME = path.join(f.root, 'minnow'); process.env.CODEX_HOME = f.home;
  resetMinnowHomeCache(); await ensureMinnowLayout(); openWorkspace(f.workspace);
  await fs.writeFile(path.join(f.home, 'auth.json'), '{}');
  const git = promisify(execFile);
  await git('git', ['init', f.workspace]);
  await git('git', ['-C', f.workspace, 'add', 'allowed.txt']);
  await git('git', ['-C', f.workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'seed']);
  const bin = await resolveAgentCliBin({ kind: 'codex' });
  __setCodexInvocationForTests(async session => {
    const config = await fs.readFile(path.join(session.home, 'config.toml'), 'utf8');
    await fs.writeFile(path.join(session.home, 'config.toml'), 'model_provider = "fixture"\n' + config + '\n[model_providers.fixture]\nname = "Fixture"\nbase_url = ' + JSON.stringify(f.endpoint.baseUrl) + '\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { CODEX_HOME: session.home, HOME: session.home, USERPROFILE: session.home });
    return { ...bin, cwd: session.home, env: applyAgentCliCaptureEnv(env, bin.command) };
  });
  await setAgentCliProviderEnabled('codex', true);
  await updateAgentCliProviderSettings('codex', { nativeCodingTools: true });
  const provider = await getProvider('codex-cli');
  db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'native-runtime', name: 'Native runtime', workspacePath: f.workspace, providerId: 'codex-cli', modelId: 'gpt-5.5', modeId: 'build' });
  const { outfile } = await buildChatPreparation({ outfile: path.join(f.root, 'composer.mjs'), logLevel: 'error' });
  const composer = await import(pathToFileURL(outfile).href);
  const names = [...new Set([...NATIVE_READ_TOOLS, ...NATIVE_WRITE_TOOLS])];
  const tools = BUILT_IN_TOOLS.filter(row => names.includes(row.id)).map(row => row.definition);
  const raw = (kind, id) => '---\nid: ' + id + '\nkind: ' + kind + '\nlabel: ' + id + '\nversion: 1\n---\nRun the fixture safely.';
  const settings = { meta: { features: { memoryInjection: false, codeMapInjectionDefault: false, contextDocumentsInjectionDefault: false },
    toolSecurity: { filesystemAccess: 'workspace', shellSandbox: 'require' }, thinking: { defaultMode: 'off' } },
    tools: { enabled: {}, permissions: { default: Object.fromEntries(names.map(name => [name, 'full'])) } },
    rules: { version: 2, enabled: false, groups: [], rules: [] } };
  runtime = createProductionChatRuntime({ repository, generations: () => [],
    preparationAdapters: { loadComposer: async () => composer, readSettings: async () => settings,
      listTools: async () => tools, loadWorkAgents: async () => ({ agents: [{ id: 'builder', kind: 'work-agent', label: 'Builder', version: '1', defaultForModes: ['build'], allowedTools: null }], overrides: {} }),
      loadSubAgentTypes: async () => ({ enabled: true, types: {} }),
      loadPromptSources: async () => ({ builtinRaw: { 'base/default.full.md': raw('base', 'default'), 'work-agents/builder/agent.full.md': raw('work-agent', 'builder') }, userRaw: {} }) },
    modelAdapters: { listProviders: async () => [provider], listModels: async () => [{ id: 'gpt-5.5' }],
      readCapabilities: async () => ({ models: { 'gpt-5.5': { tool_use: true } } }), modelAvailability: async () => ({ available: true }) },
    prepare: async (input, options) => {
      const target = await options.resolveTarget(input.execution.chatId);
      const deps = createServerRunnerDeps(async (...args) => {
        try { const response = await postChatCompletionsInProcess(...args);
          return new Response(await response.text(), { headers: { 'Content-Type': 'text/event-stream' } }); }
        catch (error) { t.diagnostic('Native fixture upstream: ' + error.stack); throw error; }
      });
      deps.resolveSamplerPreset = () => ({ preset: {}, maxTokens: 1000 });
      deps.resolveThinkingMode = () => ({ mode: 'off' }); deps.resolveThinkingBudgetTokens = () => ({ budgetTokens: null });
      deps.resolveModelContextLimit = async () => 32000;
      deps.applyContextPolicy = async value => ({ applied: false, messages: value.messages });
      return { systemPrompt: 'Isolated production native runtime fixture.', cwd: target.scope.canonicalKey,
        checkoutIdentity: target.checkoutIdentity, policy: target.policy, tools: [tools.find(row => row.function.name === 'read_file')],
        model: { providerId: 'codex-cli', id: 'gpt-5.5', exactModel: true }, deps, runOptions: { lazyTools: false } };
    },
  });
  await runtime.start();
  const { caller } = await runtime.context.humanCaller('native-runtime', { workspacePath: f.workspace, ingress: 'renderer' });
  f.endpoint.scripts.push(
    { calls: [{ id: 'runtime-edit', name: 'apply_patch', code: '*** Begin Patch\n*** Add File: runtime-native.txt\n+RUNTIME_NATIVE_EDIT\n*** End Patch' }] },
    { calls: [{ id: 'runtime-minnow-read', name: 'mn_tool_0', args: { path: 'runtime-native.txt' } }] },
    { text: 'Native runtime first command settled.' },
  );
  const first = await runtime.service.send(caller, { chatId: 'native-runtime', message: 'Edit then read with Minnow.', clientRequestId: 'runtime-native-1' });
  await runtime.service.idle('native-runtime');
  const settled = repository.getCommand(first.commandId);
  assert.equal(settled.state, 'settled', JSON.stringify(settled.result));
  assert.equal(settled.captured.nativeExecution.requestedMode, 'native');
  assert.equal(await fs.readFile(path.join(f.workspace, 'runtime-native.txt'), 'utf8'), 'RUNTIME_NATIVE_EDIT\n');
  assert.ok(repository.readTranscript('native-runtime').messages.some(row => row.role === 'tool' && row.content.includes('RUNTIME_NATIVE_EDIT')));
  f.endpoint.scripts.push({ calls: [{ id: 'runtime-next-read', name: 'exec_command', args: { cmd: 'Get-Content runtime-native.txt', login: false } }] }, { text: 'Native runtime second command settled.' });
  const next = await runtime.service.send(caller, { chatId: 'native-runtime', message: 'Read the saved edit, do not repeat it.', clientRequestId: 'runtime-native-2' });
  await runtime.service.idle('native-runtime');
  assert.equal(repository.getCommand(next.commandId).state, 'settled', JSON.stringify(repository.getCommand(next.commandId).result));
  assert.equal(repository.readTranscript('native-runtime').messages.filter(row => row.nativeAction?.type === 'fileChange' && row.nativeAction.stage === 'completed').length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_workspace_checkpoints WHERE state!='settled'").get().n, 0);
  assert.equal(repository.getLatestExecution('native-runtime').status, 'completed');
});
