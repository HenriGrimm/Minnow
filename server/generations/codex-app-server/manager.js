import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getMinnowHome } from '../../config/home.js';
import { agentCliContextWindowTokens } from '../../models/agent-cli-context.js';
import { codexSourceHome, prepareCodexAuth } from '../agent-cli/codex-auth.js';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../agent-cli/resolve-bin.js';
import { createCodexRpc } from './rpc.js';
import { registerCodexDisposal } from './lifecycle.js';
import { admitAgentCli } from '../agent-cli/admission.js';
import { beginAgentCliOutput, appendAgentCliOutput, endAgentCliOutput } from '../agent-cli/output.js';

const sessions = new Map();
const busy = new Set();
const closingProcesses = new Set();
let invocationFactory;
async function removePrivateHome(session) {
  if (!session.home) return;
  const home = path.resolve(session.home);
  const root = path.resolve(session.homeRoot);
  if (!home.startsWith(`${root}${path.sep}`)) throw new Error('Codex private home escaped its temporary root.');
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
export function __setCodexInvocationForTests(factory) { invocationFactory = factory; }
export function lockCodexChat(key) {
  if (busy.has(key)) throw new Error('Codex is already running for this chat.');
  busy.add(key); return () => busy.delete(key);
}
export async function codexIdentity(runtime, workspace) {
  const settings = runtime.profile.agentCli;
  const authPath = runtime.secrets?.codexAuthPath || path.join(codexSourceHome(), 'auth.json');
  const auth = await fs.readFile(authPath).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return { workspace, binPath: settings.binPath, profile: settings,
    account: createHash('sha256').update(auth).update(JSON.stringify(runtime.secrets ?? {})).digest('hex'),
    authLock: createHash('sha256').update(authPath).update(runtime.secrets?.cliToken ?? '').digest('hex') };
}
export function getCodexSession(key) { return sessions.get(key); }
export async function closeCodexSession(session) {
  if (!session || session.closed || session.closing) return session?.closing;
  session.closed = true;
  clearTimeout(session.timer);
  closingProcesses.add(session);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  session.closing = Promise.resolve().then(async () => {
    try {
      const onFailure = session.onFailure; session.onFailure = null;
      onFailure?.(new Error('Codex conversation closed.'));
      // An unconfirmed exit must preserve the home and its process reservation.
      await session.rpc?.close();
      endAgentCliOutput(session.capture, session.rpc?.child.exitCode);
      try { await session.syncAuth?.(); }
      finally { await removePrivateHome(session); }
    } finally {
      const child = session.rpc?.child;
      if (!child?.pid || child.exitCode != null || child.signalCode != null) closingProcesses.delete(session);
    }
  });
  return session.closing;
}
export async function shutdownCodexSessions(filter = () => true) {
  await Promise.all([...sessions.values(), ...closingProcesses].filter(filter).map(session => session.closing ?? closeCodexSession(session)));
}
export async function syncCodexCredentials(session, runtime) {
  await session.syncAuth?.();
  session.syncAuth = await prepareCodexAuth(session.home, runtime.secrets ?? {});
}
export async function createCodexSession({ key, state, candidate, runtime, identity, prepared, signal, onEvent, onRequest }) {
  const session = { key, chatId: state.chatId, providerId: candidate.providerId, workspace: identity.workspace,
    signature: prepared.signature, accepted: prepared.messages, prepared, closed: false,
    active: true, waiting: false, pending: new Map(), handed: [], seen: new Map(), buffered: [], usage: {}, allocated: {},
    turnId: null, threadId: null, tools: new Map(prepared.tools.map(tool => [tool.name, tool])) };
  // Reserve before spawning; concurrent accounts cannot race eviction and exceed the cap.
  const releaseAllocation = await admitAgentCli('codex-process-allocation', 1, signal);
  try {
    const limit = Math.max(1, Math.min(16, Number(runtime.profile.agentCli.maxConcurrent) || 1));
    const idle = [...sessions.values()].filter(row => !row.active && !row.waiting).sort((a, b) => a.idleAt - b.idleAt);
    while (sessions.size + closingProcesses.size >= limit + 8 && idle.length) await closeCodexSession(idle.shift());
    if (sessions.size + closingProcesses.size >= limit + 8 && closingProcesses.size) await Promise.all([...closingProcesses].map(row => row.closing));
    if (sessions.size + closingProcesses.size >= limit + 8) throw new Error('Codex process limit reached; finish or stop a pending chat.');
    sessions.set(key, session);
  } finally { releaseAllocation(); }
  try {
    const root = path.join(getMinnowHome(), 'tmp', 'codex-app-server');
    session.homeRoot = root;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    session.home = await fs.mkdtemp(path.join(root, 'conversation-'));
    await syncCodexCredentials(session, runtime);
    const features = ['shell_tool', 'unified_exec', 'hooks', 'memories', 'multi_agent', 'skill_mcp_dependency_install',
      'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation',
      'in_app_browser', 'in_app_local_automation', 'request_permissions_tool', 'default_mode_request_user_input',
      'sleep_tool', 'view_image', 'workspace_dependencies', 'plugins', 'plugin_sharing', 'tool_suggest', 'skill_search', 'goals'];
    const contextWindow = agentCliContextWindowTokens(runtime.profile.agentCli.contextWindowTokens);
    await fs.writeFile(path.join(session.home, 'config.toml'), [
      'cli_auth_credentials_store = "file"', 'web_search = "disabled"', 'model_reasoning_summary = "auto"',
      ...(contextWindow ? [`model_context_window = ${contextWindow}`] : []),
      '[tools]', 'experimental_request_user_input = { enabled = false }', '[features]', ...features.map(name => `${name} = false`),
    ].join('\n'), { mode: 0o600 });
    const bin = await resolveAgentCliBin({ kind: 'codex', binPath: runtime.profile.agentCli.binPath });
    const env = {};
    for (const name of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.CODEX_HOME = session.home;
    env.HOME = session.home; env.USERPROFILE = session.home;
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY']) if (process.env[name]) env[name] = process.env[name];
    if (runtime.secrets?.cliToken) env.OPENAI_API_KEY = runtime.secrets.cliToken;
    const invocation = invocationFactory ? await invocationFactory(session) : { ...bin, cwd: session.home, env: applyAgentCliCaptureEnv(env, bin.command) };
    session.rpc = createCodexRpc(invocation, { onRequest: row => onRequest(session, row) });
    session.redactionSecrets = [...Object.values(runtime.secrets ?? {}), env.OPENAI_API_KEY, env.CODEX_API_KEY]
      .filter(value => typeof value === 'string');
    session.capture = beginAgentCliOutput(state.chatId, candidate.providerId, candidate.modelId, session.redactionSecrets);
    const auth = await fs.readFile(path.join(session.home, 'auth.json'), 'utf8').catch(() => '{}');
    try {
      const collect = object => { for (const [name, value] of Object.entries(object ?? {})) {
        if (typeof value === 'object') collect(value);
        else if (/token|password|api.?key/i.test(name) && typeof value === 'string') session.redactionSecrets.push(value);
      } };
      collect(JSON.parse(auth));
    } catch { /* Non-JSON auth is handled by the CLI, never logged. */ }
    session.rpc.child.stdout.on('data', chunk => appendAgentCliOutput(session.capture, chunk));
    session.rpc.subscribe(row => onEvent(session, row));
    session.rpc.onFailure(error => { session.onFailure?.(error); void closeCodexSession(session).catch(() => {}); });
    const info = await session.rpc.initialize({ experimentalApi: true, signal });
    const version = /\/(\d+)\.(\d+)\.(\d+)/.exec(info.userAgent ?? '');
    if (!invocationFactory && (!version || Number(version[1]) === 0
      && (Number(version[2]) < 153 || Number(version[2]) === 153 && Number(version[3]) < 4))) {
      throw new Error('Update Codex to CLI 0.153.4 or newer from Models → CLIs to use app-server.');
    }
    const started = await session.rpc.request('thread/start', {
      model: candidate.modelId, cwd: session.home, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      baseInstructions: prepared.instructions || 'You are the inference engine for Minnow. Use only the supplied tools.',
      developerInstructions: 'Minnow owns permissions and context. Never execute native tools. Return only the next assistant response.',
      dynamicTools: prepared.dynamicTools,
    }, { signal });
    session.threadId = started.thread.id;
    return session;
  } catch (error) { await closeCodexSession(session); throw error; }
}
export function retainCodexSession(session, deadlineMs = 300_000) {
  session.active = false; session.idleAt = Date.now();
  session.timer = setTimeout(() => { void closeCodexSession(session).catch(() => {}); }, deadlineMs);
  session.timer.unref?.();
  const idle = [...sessions.values()].filter(row => !row.active && !row.waiting).sort((a, b) => a.idleAt - b.idleAt);
  while (idle.length > 8) void closeCodexSession(idle.shift()).catch(() => {});
}
export function codexSessionStats() { return { total: sessions.size + closingProcesses.size, idle: [...sessions.values()].filter(row => !row.active && !row.waiting).length }; }
export function codexSessionKey(state, candidate) { return `${candidate.providerId}\0${state.chatId || randomUUID()}`; }
registerCodexDisposal(shutdownCodexSessions);
