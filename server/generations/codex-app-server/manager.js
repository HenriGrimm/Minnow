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
import { codexUserInput } from './conversation.js';
import { MAX_TRANSCRIPT_BYTES } from '../agent-cli/prompt.js';
import { assertMinnowToolMode, hasUnsupportedCodexHistory } from '../../models/agent-cli-native.js';
import { CODEX_NATIVE_VERSION, CODEX_NATIVE_PROFILE, nativeConfig, nativeHistoryUnsupported, nativeHandoff, restoreNativeHandoff } from './native.js';

const closingProcesses = new Set();
const sessions = createCliSessionPool('codex', closingProcesses, closeCodexSession);
let invocationFactory;
async function nativeRolloutDigest(session, file) {
  if (typeof file !== 'string') return null;
  const resolved = path.resolve(session.home, file);
  // Restored Windows threads return \\?\ paths; compare like namespaces without
  // weakening containment or following a symlink out of the private home.
  const relative = path.relative(path.toNamespacedPath(path.resolve(session.home)), path.toNamespacedPath(resolved));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
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
    // Retain the credential-source fingerprint for existing checkpoint compatibility.
    authLock: createHash('sha256').update(authPath).update(runtime.secrets?.cliToken ?? '').digest('hex') };
}
export function getCodexSession(key) { return sessions.get(key); }
export async function closeCodexSession(session, { forget = false } = {}) {
  if (!session || session.closed || session.closing) return session?.closing;
  session.closed = true;
  if (session.nativeAbort) session.nativeExecution.signal.removeEventListener('abort', session.nativeAbort);
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
      try { if (!session.nativeRecoveryRequired) await session.syncAuth?.(); }
      finally {
        await session.checkpointWrite?.catch(() => {});
        if (forget || !session.clean && !session.nativeRecoveryRequired) {
          await removePrivateHome(session);
          if (session.cacheDir) await removeCliCache(session.cacheDir);
        } else {
          // A native home may contain a refreshed credential copy. Retain the
          // rollout, but seed credentials again from the guarded source later.
          if (session.home) await fs.rm(path.join(session.home, 'auth.json'), { force: true });
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
export async function createCodexSession({ key, state, candidate, runtime, identity, prepared, signal, onEvent, onRequest, nativeExecution, nativePolicy }) {
  if (!nativePolicy) assertMinnowToolMode(runtime.profile.agentCli);
  // An interrupted predecessor must finish removing this chat's home before
  // its replacement creates files at the same durable path.
  await Promise.all([...closingProcesses].filter(row => row.key === key).map(row => row.closing));
  const session = { key, chatId: state.chatId, providerId: candidate.providerId, workspace: identity.workspace,
    signature: prepared.signature, accepted: prepared.canonical, prepared, closed: false,
    active: true, waiting: false, pending: new Map(), handed: [], seen: new Map(), buffered: [], usage: {}, allocated: {},
    turnId: null, threadId: null, clean: false, method: 'new', nativeExecution, nativePolicy,
    tools: new Map(prepared.tools.map(tool => [tool.name, tool])) };
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
    const checkpoint = state.chatId ? await readCliCheckpoint(candidate.providerId, state.chatId) : null;
    if (checkpoint?.nativeRecoveryRequired) {
      session.nativeRecoveryRequired = true;
      throw codexNativeRecoveryError();
    }
    const saved = persistent ? checkpoint : null;
    session.saved = checkpointMatches(saved, prepared.signature, prepared.canonical) && saved.adapter === 'codex-app-server-v1' ? saved : null;
    if (saved?.nativeCoding && (!nativePolicy || !session.saved || saved.nativePolicyFingerprint !== nativePolicy.fingerprint)) {
      await quarantineCodexSession(session);
      const recovery = codexNativeRecoveryError();
      recovery.message += !nativePolicy ? ' Native policy missing.' : !session.saved ? ' Native canonical prefix or signature changed.' : ' Native policy fingerprint changed.';
      throw recovery;
    }
    if (saved && !session.saved) { await removeCliCache(session.cacheDir); session.method = 'rebuilt'; session.reason = 'Saved history or configuration changed.'; }
    const root = session.cacheDir || path.join(getMinnowHome(), 'tmp', 'codex-app-server');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    // Native Codex returns canonical rollout paths (e.g. /private/var on macOS).
    // Use the same root for containment checks and private-home cleanup.
    session.homeRoot = await fs.realpath(root);
    session.home = persistent ? path.join(session.homeRoot, 'native') : await fs.mkdtemp(path.join(session.homeRoot, 'conversation-'));
    await fs.mkdir(session.home, { recursive: true, mode: 0o700 });
    await syncCodexCredentials(session, runtime);
    const features = [...(!nativePolicy ? ['shell_tool', 'unified_exec'] : []), 'hooks', 'memories', 'multi_agent', 'skill_mcp_dependency_install',
      'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation',
      'in_app_browser', 'in_app_local_automation', 'request_permissions_tool', 'default_mode_request_user_input',
      'sleep_tool', 'view_image', 'workspace_dependencies', 'plugins', 'plugin_sharing', 'tool_suggest', 'skill_search', 'goals',
      'multi_agent_v2', 'send_message_to_user_async'];
    const contextWindow = agentCliContextWindowTokens(runtime.profile.agentCli.contextWindowTokens);
    await fs.writeFile(path.join(session.home, 'config.toml'), [
      'cli_auth_credentials_store = "file"', 'web_search = "disabled"', 'model_reasoning_summary = "auto"',
      ...(nativePolicy ? ['default_permissions = ' + JSON.stringify(CODEX_NATIVE_PROFILE), 'allow_login_shell = false'] : []),
      ...(contextWindow ? [`model_context_window = ${contextWindow}`] : []),
      '[tools]', 'experimental_request_user_input = { enabled = false }', '[agents]', 'enabled = false',
      '[features]', ...features.map(name => `${name} = false`),
      // Code-mode-only models cannot invoke dynamic tools without this isolated
      // executor. It has no filesystem/network API; calls still reach Minnow.
      'code_mode = ' + !nativePolicy,
      ...(nativePolicy ? ['shell_tool = true', 'unified_exec = true', await nativeConfig(nativePolicy, session.home, runtime)] : []),
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
    session.rpc = createCodexRpc(invocation, { maxBytes: MAX_TRANSCRIPT_BYTES + 1024 * 1024, onRequest: row => onRequest(session, row) });
    if (nativePolicy) {
      session.nativeAbort = () => { void quarantineCodexSession(session).catch(() => {}); void closeCodexSession(session).catch(() => {}); };
      nativeExecution.signal.addEventListener('abort', session.nativeAbort, { once: true });
      nativeExecution.signal.throwIfAborted();
    }
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
    if (nativePolicy && !info.userAgent?.includes('/' + CODEX_NATIVE_VERSION + ' ')) {
      throw Object.assign(new Error('Codex native coding requires the verified CLI ' + CODEX_NATIVE_VERSION + '.'), { cliPolicyRejected: true });
    }
    const version = /\/(\d+)\.(\d+)\.(\d+)/.exec(info.userAgent ?? '');
    if (!invocationFactory && (!version || Number(version[1]) === 0
      && (Number(version[2]) < 153 || Number(version[2]) === 153 && Number(version[3]) < 4))) {
      throw new Error('Update Codex to CLI 0.153.4 or newer from Models → CLIs to use app-server.');
    }
    const startParams = {
      model: candidate.modelId, cwd: session.home, ephemeral: !persistent, sandbox: 'read-only', approvalPolicy: 'never',
      environments: [],
      baseInstructions: prepared.instructions || 'You are the inference engine for Minnow. Use only the supplied tools.',
      developerInstructions: 'Minnow owns permissions and context. Use the supplied dynamic tools, including through code-mode exec when required. When mn_read_batch is advertised, you must group independent read-only lookups into one mn_read_batch request before waiting for results: it dispatches up to six ordinary Minnow calls concurrently despite native dynamic-tool serialization. Use original Minnow names in its calls array. In code-mode use one exec, for example text(await tools.mn_read_batch({calls:[{name:"read_file",arguments:{path:"a.txt"}},{name:"read_file",arguments:{path:"b.txt"}}]})). Separate dynamic calls, including Promise.all, may be serialized by the native CLI. Keep dependent calls, writes, shell commands, browser actions and interactive tools sequential. Wait for real results before dependent work; never invent tool output. Minnow executes those tools and returns their results. The native read-only sandbox applies only to Codex built-in tools, not the supplied Minnow tools: authorized edits and plugin authoring use those tools in the user workspace. Plugin apps, menus, DOM contributions and chat usage access do not require the Minnow core source workspace; inspect the plugin API reference first. Honor actual Minnow tool denials and Plan mode restrictions. Do not use built-in filesystem, shell, browser, agent or user-input tools. Return only the next assistant response.',
      dynamicTools: prepared.dynamicTools,
    };
    if (nativePolicy) {
      delete startParams.sandbox; delete startParams.environments;
      startParams.cwd = nativePolicy.workspace; startParams.permissions = CODEX_NATIVE_PROFILE;
      startParams.approvalPolicy = 'on-request';
      startParams.developerInstructions = 'Minnow owns current permissions, native approvals, durable action records and integrations. Native read/search/shell/edit are confined to the admitted workspace with network disabled. Use supplied Minnow tools for integrations and human questions. Do not use native agents, browser, plugins, image generation or permission escalation.';
    }
    if (session.saved) { try {
      // Inspect before ordinary integrity-mismatch reconstruction: native
      // actions cannot be dropped merely because their rollout hash changed.
      const read = await session.rpc.request('thread/read', { threadId: session.saved.nativeId, includeTurns: true }, { signal });
      if (nativePolicy ? nativeHistoryUnsupported(read.thread, true) : hasUnsupportedCodexHistory(read.thread)) {
        await quarantineCodexSession(session);
        throw codexNativeRecoveryError();
      }
      if (session.saved.nativeFile) {
        const digest = await nativeRolloutDigest(session, session.saved.nativeFile);
        if (!digest || digest.nativeFileDigest !== session.saved.nativeFileDigest) throw new Error('Saved Codex rollout changed.');
      }
      if (!Array.isArray(read.thread?.turns) || cliHash(read.thread.turns) !== session.saved.nativeDigest) {
        throw new Error('Saved Codex native history failed verification.');
      }
      const resumed = await session.rpc.request('thread/resume', { ...startParams, threadId: session.saved.nativeId }, { signal });
      session.threadId = resumed.thread.id;
      if (session.threadId !== session.saved.nativeId) throw new Error('Codex resumed an unexpected thread.');
      session.accepted = prepared.canonical.slice(0, session.saved.acceptedCount);
      if (nativePolicy && session.saved.nativeHandoff) restoreNativeHandoff(session, session.saved.nativeHandoff);
      else session.restoredInput = prepared.canonical.slice(session.saved.acceptedCount).flatMap(codexUserInput);
      session.allocated = session.saved.usageBaseline ?? {}; session.usage = { ...session.allocated }; session.method = 'resumed';
    } catch (error) {
      if (nativePolicy) {
        await quarantineCodexSession(session);
        const recovery = codexNativeRecoveryError();
        recovery.message += error.message === 'Saved Codex native history failed verification.' ? ' Native thread digest mismatch.' : ' Native resume preflight failed.';
        throw recovery;
      }
      if (!error.cliNativeRecoveryRequired) error.cliResumeRejected = true; throw error;
    }
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
export function checkpointCodexSession(session) {
  if (session.nativeRecoveryRequired) return Promise.reject(codexNativeRecoveryError());
  if (!session.cacheDir) return Promise.resolve();
  // Share only in-flight reads, never stat-only cached digests. Every later
  // checkpoint and every resume still verifies the full opaque native history.
  if (session.checkpointRead) return session.checkpointRead;
  const epoch = session.checkpointEpoch ?? 0;
  const current = () => !session.closed && epoch === (session.checkpointEpoch ?? 0);
  session.clean = false;
  session.checkpointRead = Promise.resolve().then(async () => {
    const timings = session.checkpointTimings = {};
    const readAt = performance.now();
    let read;
    try { read = await session.rpc.request('thread/read', { threadId: session.threadId, includeTurns: true }, { timeoutMs: 2000 }); }
    finally { timings.checkpoint_thread_read_ms = performance.now() - readAt; }
    if (!current()) throw new Error('Codex checkpoint was superseded or closed.');
    if (session.nativePolicy ? nativeHistoryUnsupported(read.thread, true) : hasUnsupportedCodexHistory(read.thread)) {
      await quarantineCodexSession(session);
      const recovery = codexNativeRecoveryError();
      recovery.message += ' Native checkpoint contains unsupported history.';
      throw recovery;
    }
    const digestAt = performance.now();
    const rollout = read.thread?.path ? await nativeRolloutDigest(session, read.thread.path) : null;
    timings.checkpoint_rollout_digest_ms = performance.now() - digestAt;
    if (!current()) throw new Error('Codex checkpoint was superseded or closed.');
    const clean = Array.isArray(read.thread?.turns) && (!read.thread.path || Boolean(rollout));
    if (session.nativePolicy) {
      const turn = read.thread?.turns?.find(row => row.id === session.turnId);
      if (!clean || !turn || !['completed', 'interrupted'].includes(turn.status)
        || turn.items.some(item => ['commandExecution', 'fileChange'].includes(item.type) && item.status === 'inProgress')) {
        const recovery = codexNativeRecoveryError();
        recovery.message += !clean ? ' Native checkpoint rollout was not verified.' : !turn ? ' Native checkpoint has no current turn.' : !['completed', 'interrupted'].includes(turn.status) ? ' Native checkpoint turn remains active.' : ' Native checkpoint contains active items.';
        throw recovery;
      }
      session.nativeVerifiedTurn = { threadId: session.threadId, turnId: turn.id, status: turn.status };
    }
    const hashAt = performance.now();
    const nativeDigest = clean ? cliHash(read.thread.turns) : null;
    const acceptedHash = cliHash(session.accepted);
    timings.checkpoint_history_hash_ms = performance.now() - hashAt;
    const writeAt = performance.now();
    await queueCliCheckpoint(session, { providerId: session.providerId, chatId: session.chatId, workspace: session.workspace,
      adapter: 'codex-app-server-v1', fingerprint: session.signature, clean,
      nativeId: session.threadId, nativeDigest,
      ...(session.nativePolicy ? { nativeCoding: true, nativePolicyFingerprint: session.nativePolicy.fingerprint } : {}),
      ...(session.nativePolicy && session.waiting ? { nativeHandoff: nativeHandoff(session), pendingCalls: session.handed.map(call => call.id) } : {}),
      acceptedCount: session.accepted.length, acceptedHash, usageBaseline: session.allocated, ...rollout });
    timings.checkpoint_write_ms = performance.now() - writeAt;
    if (current()) session.clean = clean;
  }).finally(() => { session.checkpointRead = null; });
  return session.checkpointRead;
}
export async function dirtyCodexSession(session) {
  session.checkpointEpoch = (session.checkpointEpoch ?? 0) + 1;
  session.clean = false;
  if (session.cacheDir) await queueCliCheckpoint(session, { providerId: session.providerId, chatId: session.chatId,
    workspace: session.workspace, adapter: 'codex-app-server-v1', fingerprint: session.signature, nativeId: session.threadId, clean: false,
    ...(session.nativePolicy ? { nativeCoding: true, nativePolicyFingerprint: session.nativePolicy.fingerprint } : {}),
    ...(session.nativeRecoveryRequired ? { nativeRecoveryRequired: true } : {}) });
}
export function codexNativeRecoveryError() {
  return Object.assign(new Error('Codex produced unsupported native action history. Recovery required: inspect its effects before starting a new conversation; this conversation will not resume or replay automatically.'),
    { cliNativeRecoveryRequired: true, cliPolicyRejected: true });
}
export function quarantineCodexSession(session) {
  session.nativeRecoveryRequired = true;
  return dirtyCodexSession(session);
}
export function codexSessionStats() { return { total: sessions.size + closingProcesses.size, idle: [...sessions.values()].filter(row => !row.active && !row.waiting).length }; }
export function codexSessionKey(state, candidate) { return `${candidate.providerId}\0${state.chatId || randomUUID()}`; }
registerCodexDisposal(shutdownCodexSessions);
