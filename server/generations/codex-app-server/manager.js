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
import { beginAgentCliOutput, appendAgentCliOutput, endAgentCliOutput, updateAgentCliSessionOutput } from '../agent-cli/output.js';
import { retainCliSession, reserveCliProcess, createCliSessionPool, lockCliChat } from '../agent-cli/lifecycle.js';
import { cliCacheDir, cliHash, checkpointMatches, readCliCheckpoint, queueCliCheckpoint, removeCliCache } from '../agent-cli/checkpoints.js';
import { cliAccountIdentity } from '../agent-cli/auth-identity.js';

const closingProcesses = new Set();
const sessions = createCliSessionPool('codex', closingProcesses, closeCodexSession);
let invocationFactory;
async function nativeRolloutDigest(session, file) {
  if (typeof file !== 'string') return null;
  const resolved = path.resolve(session.home, file);
  if (!resolved.startsWith(`${path.resolve(session.home)}${path.sep}`)) return null;
  const relative = path.relative(session.home, resolved);
  let parent = session.home;
  for (const part of relative.split(path.sep)) {
    parent = path.join(parent, part);
    const stat = await fs.lstat(parent).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return null;
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
  return { nativeFile: relative, nativeFileDigest: cliHash(await fs.readFile(resolved)) };
}
async function removePrivateHome(session) {
  if (!session.home) return;
  const home = path.resolve(session.home);
  const root = path.resolve(session.homeRoot);
  if (!home.startsWith(`${root}${path.sep}`)) throw new Error('Codex private home escaped its temporary root.');
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
export function __setCodexInvocationForTests(factory) { invocationFactory = factory; }
export function lockCodexChat(key) {
  return lockCliChat(key);
}
export async function codexIdentity(runtime, workspace) {
  const settings = runtime.profile.agentCli;
  const authPath = runtime.secrets?.codexAuthPath || path.join(codexSourceHome(), 'auth.json');
  const auth = await fs.readFile(authPath).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const bin = invocationFactory ? null : await resolveAgentCliBin({ kind: 'codex', binPath: settings.binPath });
  const binaryStat = bin ? await fs.stat(bin.command).catch(() => ({})) : {};
  return { workspace, binPath: settings.binPath, profile: settings,
    binary: bin ? [bin.command, bin.argsPrefix, binaryStat.size, binaryStat.mtimeMs] : 'fixture',
    account: cliHash([cliAccountIdentity(auth), runtime.secrets, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY]),
    authLock: createHash('sha256').update(authPath).update(runtime.secrets?.cliToken ?? '').digest('hex') };
}
export function getCodexSession(key) { return sessions.get(key); }
export async function closeCodexSession(session, { forget = false } = {}) {
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
      try { await session.rpc?.close(); }
      catch (error) {
        const child = session.rpc?.child;
        if (child?.pid && child.exitCode == null && child.signalCode == null) throw error;
      }
      endAgentCliOutput(session.capture, session.rpc?.child.exitCode);
      try { await session.syncAuth?.(); }
      finally {
        await session.checkpointWrite?.catch(() => {});
        if (forget || !session.clean) {
          await removePrivateHome(session);
          if (session.cacheDir) await removeCliCache(session.cacheDir);
        } else {
          // A native home may contain a refreshed credential copy. Retain the
          // rollout, but seed credentials again from the guarded source later.
          await fs.rm(path.join(session.home, 'auth.json'), { force: true });
        }
      }
    } finally {
      const child = session.rpc?.child;
      if (!child?.pid || child.exitCode != null || child.signalCode != null) closingProcesses.delete(session);
      else child.once('close', () => {
        // The timeout preserved this child's reservation and home. Once exit
        // is confirmed, complete the same cleanup rather than leaking either.
        session.closed = false; session.closing = null;
        void closeCodexSession(session, { forget }).catch(() => {});
      });
    }
  });
  return session.closing;
}
export async function shutdownCodexSessions(filter = () => true, options = {}) {
  await Promise.all([...sessions.values(), ...closingProcesses].filter(filter).map(session => session.closing ?? closeCodexSession(session, options)));
}
export async function syncCodexCredentials(session, runtime) {
  await session.syncAuth?.();
  session.syncAuth = await prepareCodexAuth(session.home, runtime.secrets ?? {});
}
export async function createCodexSession({ key, state, candidate, runtime, identity, prepared, signal, onEvent, onRequest }) {
  // An interrupted predecessor must finish removing this chat's home before
  // its replacement creates files at the same durable path.
  await Promise.all([...closingProcesses].filter(row => row.key === key).map(row => row.closing));
  const session = { key, chatId: state.chatId, providerId: candidate.providerId, workspace: identity.workspace,
    signature: prepared.signature, accepted: prepared.messages, prepared, closed: false,
    active: true, waiting: false, pending: new Map(), handed: [], seen: new Map(), buffered: [], usage: {}, allocated: {},
    turnId: null, threadId: null, clean: false, method: 'new', tools: new Map(prepared.tools.map(tool => [tool.name, tool])) };
  // Reserve before spawning; concurrent accounts cannot race eviction and exceed the cap.
  const releaseAllocation = await admitAgentCli(`cli-allocation:${candidate.providerId}`, 1, signal);
  try {
    const limit = Math.max(1, Math.min(16, Number(runtime.profile.agentCli.maxConcurrent) || 1));
    await reserveCliProcess(sessions, closingProcesses, candidate.providerId, limit, closeCodexSession);
    sessions.set(key, session);
  } finally { releaseAllocation(); }
  try {
    const persistent = Boolean(state.chatId) && process.env.MINNOW_AGENT_CLI_REPLAY !== '1';
    session.cacheDir = persistent ? cliCacheDir(candidate.providerId, state.chatId) : null;
    const saved = persistent ? await readCliCheckpoint(candidate.providerId, state.chatId) : null;
    session.saved = checkpointMatches(saved, prepared.signature, prepared.messages) && saved.adapter === 'codex-app-server-v1' ? saved : null;
    if (saved && !session.saved) { await removeCliCache(session.cacheDir); session.method = 'rebuilt'; session.reason = 'Saved history or configuration changed.'; }
    const root = session.cacheDir || path.join(getMinnowHome(), 'tmp', 'codex-app-server');
    session.homeRoot = root;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    session.home = persistent ? path.join(root, 'native') : await fs.mkdtemp(path.join(root, 'conversation-'));
    await fs.mkdir(session.home, { recursive: true, mode: 0o700 });
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
    const startParams = {
      model: candidate.modelId, cwd: session.home, ephemeral: !persistent, sandbox: 'read-only', approvalPolicy: 'never',
      baseInstructions: prepared.instructions || 'You are the inference engine for Minnow. Use only the supplied tools.',
      developerInstructions: 'Minnow owns permissions and context. Never execute native tools. Return only the next assistant response.',
      dynamicTools: prepared.dynamicTools,
    };
    if (session.saved) { try {
      if (session.saved.nativeFile) {
        const digest = await nativeRolloutDigest(session, session.saved.nativeFile);
        if (!digest || digest.nativeFileDigest !== session.saved.nativeFileDigest) throw new Error('Saved Codex rollout changed.');
      }
      const read = await session.rpc.request('thread/read', { threadId: session.saved.nativeId, includeTurns: true }, { signal });
      if (!Array.isArray(read.thread?.turns) || cliHash(read.thread.turns) !== session.saved.nativeDigest) {
        throw new Error('Saved Codex native history failed verification.');
      }
      const resumed = await session.rpc.request('thread/resume', { ...startParams, threadId: session.saved.nativeId }, { signal });
      session.threadId = resumed.thread.id;
      if (session.threadId !== session.saved.nativeId) throw new Error('Codex resumed an unexpected thread.');
      session.accepted = prepared.messages.slice(0, session.saved.acceptedCount);
      session.restoredInput = prepared.messages.slice(session.saved.acceptedCount).map(row => ({ type: 'text', text: row.content }));
      session.allocated = session.saved.usageBaseline ?? {}; session.usage = { ...session.allocated }; session.method = 'resumed';
    } catch (error) { error.cliResumeRejected = true; throw error; }
    } else {
      const started = await session.rpc.request('thread/start', startParams, { signal });
      session.threadId = started.thread.id;
    }
    updateAgentCliSessionOutput(session.capture, { sessionState: 'active', transport: 'app-server', restartResumeSupported: persistent,
      continuation: session.method, reason: session.reason });
    return session;
  } catch (error) { await closeCodexSession(session); throw error; }
}
export function retainCodexSession(session, deadlineMs = 300_000) {
  session.active = false;
  updateAgentCliSessionOutput(session.capture, { sessionState: session.waiting ? 'awaiting-tools' : 'idle', restartResumeSupported: session.clean });
  retainCliSession(session, sessions, closeCodexSession, deadlineMs);
}
export async function checkpointCodexSession(session) {
  if (!session.cacheDir) return;
  const read = await session.rpc.request('thread/read', { threadId: session.threadId, includeTurns: true });
  if (session.closed) throw new Error('Codex closed before its checkpoint completed.');
  const rollout = read.thread?.path ? await nativeRolloutDigest(session, read.thread.path) : null;
  session.clean = Array.isArray(read.thread?.turns) && (!read.thread.path || Boolean(rollout));
  await queueCliCheckpoint(session, { providerId: session.providerId, chatId: session.chatId, workspace: session.workspace,
    adapter: 'codex-app-server-v1', fingerprint: session.signature, clean: session.clean,
    nativeId: session.threadId, nativeDigest: session.clean ? cliHash(read.thread.turns) : null,
    acceptedCount: session.accepted.length, acceptedHash: cliHash(session.accepted), usageBaseline: session.allocated, ...rollout });
}
export async function dirtyCodexSession(session) {
  session.clean = false;
  if (session.cacheDir) await queueCliCheckpoint(session, { providerId: session.providerId, chatId: session.chatId,
    workspace: session.workspace, adapter: 'codex-app-server-v1', fingerprint: session.signature, nativeId: session.threadId, clean: false });
}
export function codexSessionStats() { return { total: sessions.size + closingProcesses.size, idle: [...sessions.values()].filter(row => !row.active && !row.waiting).length }; }
export function codexSessionKey(state, candidate) { return `${candidate.providerId}\0${state.chatId || randomUUID()}`; }
registerCodexDisposal(shutdownCodexSessions);
