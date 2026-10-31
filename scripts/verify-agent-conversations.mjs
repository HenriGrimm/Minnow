import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CHAT_ERROR_HTTP_STATUS, validateModelSelection } from '../server/chats/contracts.js';

const script = fileURLToPath(import.meta.url);
const kinds = ['api', 'cli', 'pool', 'local'];
const safeId = /^[A-Za-z0-9_-]{1,100}$/;
const safeCodes = new Set([...Object.keys(CHAT_ERROR_HTTP_STATUS), 'provider_unavailable', 'credentials_unavailable', 'pool_unavailable', 'local_unavailable',
  'local_not_loaded', 'cli_unavailable', 'evaluator_pool_requires_explicit_smoke_members', 'provider_kind_mismatch', 'execution_failed',
  'captured_selection_changed', 'tool_round_missing', 'final_marker_missing', 'resolved_model_changed', 'pool_capture_missing', 'pool_capture_changed', 'workspace_changed']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
async function json(file, fallback = null) {
  try { const raw = await fs.readFile(file); if (raw.length > 2 * 1024 * 1024) fail('metadata_too_large'); return JSON.parse(raw); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function selection(value) { const parsed = validateModelSelection(value); if (!parsed.ok) fail('invalid_selection'); return parsed.value; }
export function validateSmokeTargets(value) {
  if (value?.version !== 1 || !Array.isArray(value.targets) || value.targets.length > 4 || Object.keys(value).some(key => !['version', 'targets'].includes(key))) fail('invalid_targets');
  const seen = new Set();
  return value.targets.map(target => {
    if (!target || !kinds.includes(target.kind) || seen.has(target.kind) || Object.keys(target).some(key => !['kind', 'selection', 'pool'].includes(key))) fail('invalid_targets');
    seen.add(target.kind);
    const chosen = selection({ ...target.selection, options: target.selection?.options ?? {} });
    if (chosen.providerId !== 'minnow-router' && !safeId.test(chosen.providerId)) fail('invalid_selection');
    if (target.kind === 'pool' && chosen.providerId !== 'minnow-router' || target.kind !== 'pool' && chosen.providerId === 'minnow-router') fail('invalid_targets');
    let pool;
    if (target.pool) {
      if (target.kind !== 'pool' || !Array.isArray(target.pool.members) || target.pool.members.length < 1 || target.pool.members.length > 4 || Object.keys(target.pool).some(key => key !== 'members')) fail('invalid_pool');
      pool = { members: target.pool.members.map(member => selection({ ...member, options: member?.options ?? {} })) };
      if (pool.members.some(member => !safeId.test(member.providerId) || ['minnow-router', 'minnow-library'].includes(member.providerId))) fail('invalid_pool');
      if (!safeId.test(chosen.modelId) || pool.members.some(member => Object.keys(member.options).length)) fail('invalid_pool');
      if (new Set(pool.members.map(member => JSON.stringify([member.providerId, member.modelId]))).size !== pool.members.length) fail('invalid_pool');
    }
    return { kind: target.kind, selection: chosen, ...(pool ? { pool } : {}) };
  });
}

/** Deliberately bypass stores which migrate or seed a live home while reading. */
export async function discoverSmokeConfiguration(sourceHome) {
  const entries = await fs.readdir(path.join(sourceHome, 'providers'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const providers = [];
  for (const entry of entries.filter(row => row.isDirectory() && safeId.test(row.name)).slice(0, 100)) {
    const root = path.join(sourceHome, 'providers', entry.name), profile = await json(path.join(root, 'profile.json'));
    if (!profile || profile.id !== entry.name) continue;
    const caps = await json(path.join(root, 'capabilities.json'));
    providers.push({ id: profile.id, apiKind: profile.apiKind, enabled: profile.enabled !== false,
      ...(profile.agentCli?.kind ? { cliKind: profile.agentCli.kind } : {}), models: Object.keys(caps?.models ?? {}).slice(0, 32) });
  }
  const remembered = await json(path.join(sourceHome, 'default-model.json'));
  const poolFile = await json(path.join(sourceHome, 'model-routers', 'global-v2.json'));
  return { providers, remembered: typeof remembered?.value === 'string' ? remembered.value : null,
    pools: (poolFile?.routers ?? []).slice(0, 32).map(pool => ({ id: pool.id, enabled: pool.enabled !== false, policy: pool.policy,
      members: (pool.entries ?? []).slice(0, 8).map(row => ({ providerId: row.providerId, modelId: row.modelId, enabled: row.enabled !== false })) })) };
}

async function stageSelectedConfiguration(sourceHome, scratch, target) {
  const home = path.join(scratch, 'home'); await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const { resetMinnowHomeCache } = await import('../server/config/home.js');
  const secrets = await import('../server/security/secret-box.js');
  let pool;
  if (target.kind === 'pool') {
    if (target.pool) pool = { id: target.selection.modelId, name: 'Agent smoke pool', policy: 'priority', enabled: true,
      entries: target.pool.members.map((member, index) => ({ id: `entry-${index}`, providerId: member.providerId, modelId: member.modelId, enabled: true, concurrencyLimit: 1 })) };
    else pool = (await json(path.join(sourceHome, 'model-routers', 'global-v2.json')))?.routers?.find(row => row.id === target.selection.modelId);
    if (!pool || pool.enabled === false || !pool.entries?.length || pool.entries.length > 4) fail('pool_unavailable');
    // Automatic evaluators add another unbounded provider dependency. Select an explicit small priority pool for this smoke.
    if (pool.policy === 'evaluate') fail('evaluator_pool_requires_explicit_smoke_members');
  }
  const providerIds = [...new Set(pool ? pool.entries.filter(row => row.enabled !== false).map(row => row.providerId) : [target.selection.providerId])];
  const loaded = [];
  for (const id of providerIds) {
    if (!safeId.test(id)) fail('provider_unavailable');
    const directory = path.join(sourceHome, 'providers', id), profile = await json(path.join(directory, 'profile.json'));
    if (!profile || profile.id !== id || profile.enabled === false) fail('provider_unavailable');
    if (target.kind === 'cli' && profile.apiKind !== 'agent-cli-v1' || target.kind !== 'cli' && target.kind !== 'pool' && profile.apiKind === 'agent-cli-v1') fail('provider_kind_mismatch');
    if (target.kind === 'local') {
      let host; try { host = new URL(profile.baseUrl).hostname; } catch { fail('local_unavailable'); }
      if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) fail('local_unavailable');
    }
    const envelope = await json(path.join(directory, 'secrets.json'), {});
    let credential = envelope;
    if (secrets.isEncryptedSecretPayload(envelope)) {
      if (!(await fs.stat(path.join(sourceHome, '.key')).catch(() => null))?.isFile()) fail('credentials_unavailable');
      process.env.MINNOW_HOME = sourceHome; resetMinnowHomeCache(); secrets.resetSecretBoxCacheForTests();
      credential = JSON.parse(await secrets.decryptSecretPayload(envelope));
    }
    loaded.push({ id, profile, credential, capabilities: await json(path.join(directory, 'capabilities.json')) });
  }
  process.env.MINNOW_HOME = home; resetMinnowHomeCache(); secrets.resetSecretBoxCacheForTests();
  for (const row of loaded) {
    const directory = path.join(home, 'providers', row.id); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'profile.json'), JSON.stringify(row.profile), { mode: 0o600 });
    await secrets.writeEncryptedJsonFile(path.join(directory, 'secrets.json'), row.credential);
    if (row.capabilities) await fs.writeFile(path.join(directory, 'capabilities.json'), JSON.stringify(row.capabilities), { mode: 0o600 });
  }
  if (pool) {
    await fs.mkdir(path.join(home, 'model-routers'), { recursive: true });
    await fs.writeFile(path.join(home, 'model-routers', 'global-v2.json'), JSON.stringify({ version: 2, revision: 1,
      routers: [pool], defaultRouterId: null, assignments: {}, decisions: {}, aliases: {}, legacyDefaults: {} }), { mode: 0o600 });
  }
  for (const kind of new Set(loaded.map(row => row.profile.agentCli?.kind).filter(Boolean))) {
    if (!['codex', 'claude', 'cursor'].includes(kind)) fail('cli_unavailable');
    const key = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', cursor: 'CURSOR_CONFIG_DIR' }[kind];
    const from = process.env[key] || path.join(os.homedir(), `.${kind}`), to = path.join(scratch, `${kind}-auth`);
    await fs.mkdir(to, { recursive: true, mode: 0o700 });
    for (const file of kind === 'claude' ? ['.credentials.json', 'credentials.json'] : ['auth.json']) {
      const bytes = await fs.readFile(path.join(from, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (bytes) { if (bytes.length > 2 * 1024 * 1024) fail('credentials_unavailable'); await fs.writeFile(path.join(to, file), bytes, { mode: 0o600 }); }
    }
    process.env[key] = to;
  }
  return { home, pool };
}

async function manifest(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push([path.relative(root, file), createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
      else fail('unexpected_workspace_entry');
    }
  }
  await walk(root); return JSON.stringify(result.sort((a, b) => a[0].localeCompare(b[0])));
}

async function productionCase({ sourceHome, scratch, target, timeoutMs, maxTokens }) {
  const started = Date.now(); let runtime, installation, db, modules, phase = 'stage';
  try {
    const staged = await stageSelectedConfiguration(sourceHome, scratch, target);
    phase = 'production_boot';
    process.env.MINNOW_AGENT_CONVERSATIONS = '1'; process.env.NODE_ENV = 'test';
    const imported = await Promise.all([import('./build-headless-runner.mjs'), import('../server/chats/runtime.js'), import('../server/chats/repository.js'),
      import('../server/config/sessions-schema.js'), import('../server/config/home.js'), import('../server/workspace/open-workspaces.js'),
      import('../server/chats/preparation.js'), import('../server/chats/tools.js'), import('../server/tools/builtin-catalog.js'),
      import('../server/chats/model-selection.js'), import('../server/generations/store.js'), import('../server/generations/codex-app-server/lifecycle.js'),
      import('../server/chats/delegation.js'), import('../server/chats/task-bridge.js'), import('../server/sub-agents/middleware.js'),
      import('../server/sub-agents/effector-runner.js'), import('../server/sub-agents/derive.js'), import('../server/sub-agents/journal.js'), import('../server/orchestrator/engine.js')]);
    modules = Object.assign({}, ...imported); await modules.ensureMinnowLayout();
    const { default: Database } = await import('better-sqlite3');
    const composerFile = await modules.buildChatPreparation({ outfile: path.join(scratch, 'composer.mjs'), logLevel: 'error' });
    const composer = await import(pathToFileURL(composerFile.outfile).href);
    const workspace = path.join(scratch, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'sentinel.txt'), 'Smoke must leave this unchanged.');
    modules.openWorkspace(workspace); const before = await manifest(workspace);
    db = new Database(':memory:'); db.pragma('foreign_keys=ON'); modules.initSessionsSchema(db);
    const repository = modules.createChatRepository({ db });
    const settings = { meta: { sampler: { maxTokens }, features: { memoryInjection: false, codeMapInjectionDefault: false, contextDocumentsInjectionDefault: false },
      toolSecurity: { filesystemAccess: 'workspace' }, thinking: { defaultMode: 'off', thinkingBudgetTokens: null } },
      tools: { enabled: {}, permissions: { default: { agent_capabilities: 'full' } } }, rules: { version: 2, enabled: false, rules: [], groups: [] } };
    const preparationAdapters = { loadComposer: async () => composer, readSettings: async () => settings,
      listTools: async () => modules.BUILT_IN_TOOLS.filter(tool => tool.id === 'agent_capabilities').map(tool => tool.definition) };
    runtime = modules.createProductionChatRuntime({ repository, preparationAdapters,
      prepare: async (input, options) => { const prepared = await modules.prepareChatExecution(input, options);
        prepared.model.sampler = { ...prepared.model.sampler, preset: { ...prepared.model.sampler?.preset }, maxTokens };
        prepared.limits = { ...prepared.limits, maxTurns: 2, wallClockMs: timeoutMs, providerWaitMs: 0, maxRepeatedToolCalls: 1 }; return prepared; } });
    installation = modules.installChatTools(runtime);
    modules.setAgentsEffectorFactory(owner => modules.createLazyPersistentSubAgentEffector({ legacyEffector: modules.createSubAgentEffector({ parentChatId: owner }),
      getRuntime: async () => runtime, getState: () => modules.peekEngine(owner, modules.AGENTS_NAMESPACE)?.getState() ?? modules.loadState(owner) }));
    modules.installChatDelegation(runtime, { getEngine: modules.getAgentsEngine,
      captureProfile: (chat, scope, options) => modules.captureChatProfile(chat, scope, { ...options, adapters: preparationAdapters }),
      resolveModelSelection: (input, options) => runtime.resolveModelSelection(input, options), cancelTree: input => runtime.taskDelivery.cancelTree(input) });
    await runtime.start();
    phase = 'preflight';
    const resolved = await runtime.resolveModelSelection({ target: target.selection }, { workspacePath: workspace });
    if (target.kind === 'local') {
      const inspected = await modules.inspectAgentModel(target.selection);
      if (!['loaded', 'running'].includes(inspected.model.state)) fail('local_not_loaded');
    }
    phase = 'capture';
    const project = await runtime.context.project(workspace), chatId = `smoke-${randomUUID()}`, parentChatId = `smoke-parent-${randomUUID()}`;
    repository.createChat({ id: parentChatId, name: 'Smoke controller', workspacePath: workspace, providerId: resolved.selection.providerId, modelId: resolved.selection.modelId, modeId: 'plan' });
    const initial = await runtime.context.resolveTarget(parentChatId);
    const child = { id: chatId, name: 'Agent smoke', agentTypeId: 'generalPurpose', workspacePath: workspace, providerId: resolved.selection.providerId, modelId: resolved.selection.modelId, modeId: 'plan' };
    const captured = await modules.captureChatProfile(child, initial.scope, { adapters: preparationAdapters,
      workspaceIds: initial.policy.workspaceIds, modelSelection: resolved.selection, exactModel: resolved.exactModel });
    if (resolved.pool) captured.pool = resolved.pool;
    repository.createChild({ chat: child, projectId: project.projectId,
      relation: { version: 1, childChatId: chatId, parentChatId, rootChatId: parentChatId, journalOwnerId: parentChatId,
        origin: 'delegated', createdAt: Date.now(), capabilities: { canSend: true, canStop: true, canChooseModel: true } },
      profile: { profileId: `profile-${chatId}`, profileVersion: 1, snapshot: captured } });
    const { caller } = await runtime.context.humanCaller(chatId, { workspacePath: workspace, ingress: 'cli' });
    const marker = `MINNOW_SMOKE_${randomUUID().replaceAll('-', '')}`;
    phase = 'execute';
    const receipt = await runtime.service.send(caller, { chatId, message: `Call the supplied agent_capabilities tool exactly once with {"limit":1}. Then reply with only ${marker}. Do not call any other tool, write files, run shell commands, or spawn agents.`, clientRequestId: randomUUID() });
    let completed;
    const deadline = Date.now() + timeoutMs;
    do {
      completed = await runtime.service.readCommand(caller, receipt.commandId);
      if (['settled', 'failed', 'cancelled'].includes(completed.state)) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    const execution = repository.getLatestExecution(chatId);
    const activity = repository.getActivity(chatId), transcript = repository.readTranscript(chatId).messages;
    phase = 'verify';
    if (completed.state !== 'settled' || execution?.status !== 'completed') {
      const code = completed.error?.code ?? execution?.result?.error?.code;
      fail(safeCodes.has(code) ? code : 'execution_failed');
    }
    if (!isDeepStrictEqual(execution.captured?.modelSelection, resolved.selection)) fail('captured_selection_changed');
    const calls = transcript.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []);
    if (calls.length !== 1 || calls[0].function?.name !== 'agent_capabilities' || !transcript.some(message => message.role === 'tool')) fail('tool_round_missing');
    if (!completed.assistantFinal?.includes(marker)) fail('final_marker_missing');
    const actual = activity.agentExecution?.resolvedModel;
    if (!actual || target.kind !== 'pool' && (actual.providerId !== resolved.selection.providerId || actual.modelId !== resolved.selection.modelId)) fail('resolved_model_changed');
    if (target.kind === 'pool' && !resolved.pool?.eligibleEntryIds?.length) fail('pool_capture_missing');
    if (target.kind === 'pool' && (!staged.pool.entries.some(member => member.enabled !== false && member.providerId === actual.providerId && member.modelId === actual.modelId)
      || !isDeepStrictEqual(execution.captured.profile?.snapshot?.pool, resolved.pool))) fail('pool_capture_changed');
    if (await manifest(workspace) !== before) fail('workspace_changed');
    return { kind: target.kind, status: 'PASS', code: 'production_tool_round', selection: resolved.selection,
      capturedSelection: execution.captured.modelSelection, resolvedSelection: actual, ...(resolved.pool ? { pool: resolved.pool } : {}), durationMs: Date.now() - started };
  } catch (error) {
    const unavailable = new Set(['provider_unavailable', 'model_unavailable', 'options_unsupported', 'credentials_unavailable', 'pool_unavailable',
      'local_unavailable', 'local_not_loaded', 'cli_unavailable', 'evaluator_pool_requires_explicit_smoke_members']);
    return { kind: target.kind, status: unavailable.has(error.code) ? 'SKIP' : 'FAIL', code: safeCodes.has(error.code) ? error.code : 'smoke_failed',
      selection: target.selection, phase, durationMs: Date.now() - started };
  } finally {
    await runtime?.dispose(); installation?.dispose(); modules?.disposeEngines?.(); await modules?.disposeCodexSessions?.();
    if (db?.open) db.close(); modules?.deleteGenerationsForProviderShutdown?.();
  }
}

async function killOwnedWorker(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') await new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); killer.once('close', resolve); killer.once('error', resolve);
  });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
export async function runSmokeCase({ sourceHome, target, timeoutMs = 60000, maxTokens = 512 }) {
  [target] = validateSmokeTargets({ version: 1, targets: [target] });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 2048) fail('invalid_limits');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-smoke-'));
  try {
    const input = path.join(root, 'input.json'); await fs.writeFile(input, JSON.stringify({ sourceHome: path.resolve(sourceHome), scratch: root, target, timeoutMs, maxTokens }), { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      let report, finished = false;
      const child = fork(script, ['--worker', input], { cwd: root, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], env: { ...process.env, MINNOW_HOME: path.join(root, 'home') } });
      child.stdout.resume(); child.stderr.resume();
      const timer = setTimeout(() => { void killOwnedWorker(child); }, timeoutMs + 15000); timer.unref?.();
      child.on('message', value => { if (value?.kind === target.kind && ['PASS', 'SKIP', 'FAIL'].includes(value.status)) report = value; });
      child.once('error', error => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } });
      child.once('close', () => { if (finished) return; finished = true; clearTimeout(timer);
        resolve(report ?? { kind: target.kind, status: 'FAIL', code: 'worker_timeout_or_exit', selection: target.selection }); });
    });
  } finally {
    const absolute = path.resolve(root), temporary = path.resolve(os.tmpdir());
    if (path.dirname(absolute).toLowerCase() !== temporary.toLowerCase() || !path.basename(absolute).startsWith('minnow-agent-smoke-')) fail('unsafe_cleanup');
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--worker') { const input = await json(argv[1]); const report = await productionCase(input); process.send?.(report); process.disconnect?.(); return; }
  const flags = new Map();
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--run' || argv[index] === '--help') flags.set(argv[index], true);
    else if (['--source-home', '--targets-file', '--timeout-ms', '--max-tokens'].includes(argv[index]) && argv[index + 1]) flags.set(argv[index], argv[++index]);
    else fail('invalid_arguments');
  }
  if (flags.has('--help')) { process.stdout.write('Usage: node scripts/verify-agent-conversations.mjs --source-home PATH --targets-file JSON [--run] [--timeout-ms 60000] [--max-tokens 512]\nDefault discovery is read-only and performs no inference. --run uses isolated production runtime workers and selected configured credentials.\n'); return; }
  const sourceHome = path.resolve(flags.get('--source-home') || process.env.MINNOW_HOME || path.join(os.homedir(), '.minnow'));
  const targets = validateSmokeTargets(flags.has('--targets-file') ? await json(flags.get('--targets-file')) : { version: 1, targets: [] });
  const discovery = await discoverSmokeConfiguration(sourceHome), paths = [];
  for (const kind of kinds) {
    const target = targets.find(row => row.kind === kind);
    paths.push(!target ? { kind, status: 'SKIP', code: 'no_configured_target' } : !flags.has('--run') ? { kind, status: 'SKIP', code: 'not_run', selection: target.selection }
      : await runSmokeCase({ sourceHome, target, timeoutMs: Number(flags.get('--timeout-ms') || 60000), maxTokens: Number(flags.get('--max-tokens') || 512) }));
  }
  process.stdout.write(JSON.stringify({ version: 1, inference: flags.has('--run'), discovery, paths }, null, 2) + '\n');
  if (paths.some(row => row.status === 'FAIL')) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(() => {
  if (process.send) { process.send({ status: 'FAIL', code: 'smoke_failed' }); process.disconnect(); }
  else { process.stderr.write('Agent conversation verification failed; no credentials or provider error output was printed.\n'); process.exitCode = 1; }
});
