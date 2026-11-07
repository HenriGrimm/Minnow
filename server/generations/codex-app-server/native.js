import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../../config/home.js';
import { codexSourceHome } from '../agent-cli/codex-auth.js';
import { safeAgentCliDiagnostic } from '../agent-cli/errors.js';
import { assertNativeExecutionContext } from '../native-execution-context.js';

export const CODEX_NATIVE_VERSION = '0.166.0';
export const CODEX_NATIVE_PROFILE = 'minnow-native-v1';
const itemTypes = new Set(['commandExecution', 'fileChange']);
const reject = message => Object.assign(new Error(message), { cliPolicyRejected: true });
export const isCodexCodingItem = item => itemTypes.has(item?.type);

/**
 * Process-local branded WeakMap authority; never infer it from request JSON.
 * Host owns captured/current all-Full tool intersection, revocation signal,
 * durable identity, and the shared checkout intent/barrier. Native handoffs
 * interrupt the turn, verify the checkpoint and close the process before the
 * barrier returns. Actual dynamic results are injected only at the next region.
 *
 * { policy: {version:1, workspace, mode:'read-only'|'workspace-write', fingerprint},
 *   signal, runTurn(meta, operation), assertCurrent(meta), record(event),
 *   approve(request) -> 'decline'|'cancel' (escalations never accepted) }
 */
export function assertCodexNativeExecution(execution, state, candidate) {
  const body = JSON.parse(state.requestBody.toString('utf8'));
  assertNativeExecutionContext(execution, { chatId: state.chatId, providerId: candidate.providerId,
    modelId: candidate.modelId, body, fallbackRole: state.fallbackRole });
  const p = execution?.policy;
  if (process.platform !== 'win32' || !p || p.version !== 1
    || !['read-only', 'workspace-write'].includes(p.mode)
    || typeof p.workspace !== 'string' || !path.isAbsolute(p.workspace)
    || typeof p.fingerprint !== 'string' || !p.fingerprint || p.fingerprint.length > 512
    || !execution.signal || typeof execution.signal.addEventListener !== 'function'
    || !['runTurn', 'assertCurrent', 'record', 'approve'].every(key => typeof execution[key] === 'function')) {
    throw reject('Codex native coding requires a trusted Windows execution policy and durable host callbacks.');
  }
  if (candidate.modelId !== 'gpt-5.5') throw reject('Codex native coding currently supports the verified gpt-5.5 native-tool model only.');
  if (!state.chatId || body.tool_choice != null && body.tool_choice !== 'auto' || state.fallbackRole && state.fallbackRole !== 'default') {
    throw reject('Codex native coding requires an ordinary chat with automatic tool selection.');
  }
  execution.signal.throwIfAborted();
  return Object.freeze({ version: 1, workspace: path.resolve(p.workspace), mode: p.mode, fingerprint: p.fingerprint });
}

export function nativeMeta(session, extra = {}) {
  return { generationId: session.generationId, chatId: session.chatId, providerId: session.providerId,
    threadId: session.threadId, turnId: session.turnId, policyFingerprint: session.nativePolicy.fingerprint,
    workspace: session.nativePolicy.workspace, mode: session.nativePolicy.mode, ...extra };
}

/** A dynamic request does not park sibling native calls. Interrupt the turn
 * before checkpointing; the caller then closes the process tree. */
export async function pauseNativeTurn(session) {
  let timer;
  const terminal = new Promise((resolve, reject) => {
    session.nativePause = { resolve };
    timer = setTimeout(() => reject(new Error('Native handoff did not reach an interrupted turn.')), 3000);
  });
  try {
    const [, turn] = await Promise.all([
      session.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }, { timeoutMs: 2000 }), terminal,
    ]);
    if (turn.id !== session.turnId || turn.status !== 'interrupted') throw reject('Native handoff did not reach an interrupted turn.');
    return turn;
  } finally { clearTimeout(timer); session.nativePause = null; }
}

export function nativeHandoff(session) {
  const groups = new Set();
  for (const call of session.handed) {
    const entry = session.pending.get(call.id);
    if (!entry) throw reject('Native dynamic handoff lost its call identity.');
    groups.add(entry.group);
  }
  const value = { turnId: session.turnId, groups: [...groups].map(group => ({ nativeCallId: group.nativeCallId,
    tool: group.tool, calls: group.calls })) };
  // readCliCheckpoint intentionally caps records at 64 KiB. Never write a
  // nominally clean native checkpoint that its next reader would discard.
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) throw reject('Native handoff exceeds its durable checkpoint budget.');
  return value;
}

export function restoreNativeHandoff(session, saved) {
  if (!saved?.turnId || !Array.isArray(saved.groups) || !saved.groups.length || saved.groups.length > 64) {
    throw reject('Native dynamic handoff checkpoint is invalid.');
  }
  session.waiting = true; session.nativePaused = true; session.handed = [];
  for (const group of saved.groups) {
    if (typeof group.nativeCallId !== 'string' || !session.tools.has(group.tool) || !Array.isArray(group.calls)
      || !group.calls.length || group.calls.length > 8) throw reject('Native dynamic handoff checkpoint is invalid.');
    const restored = { ...group, requestIds: new Set(), results: new Map() };
    for (const call of group.calls) {
      if (!call?.id || session.pending.has(call.id)) throw reject('Native dynamic handoff call identity is invalid.');
      session.handed.push(call); session.pending.set(call.id, { call, group: restored });
    }
  }
}

export async function nativeConfig(policy, home, runtime) {
  const workspace = await fs.realpath(policy.workspace);
  if (path.resolve(workspace).toLowerCase() !== path.resolve(policy.workspace).toLowerCase()) {
    throw reject('Native workspace must use its canonical path.');
  }
  const denied = [...new Set([home, getMinnowHome(), codexSourceHome(),
    runtime.secrets?.codexAuthPath].filter(Boolean).map(file => path.resolve(file)))];
  for (const file of denied) {
    if (workspace.toLowerCase() === file.toLowerCase()
      || workspace.toLowerCase().startsWith(file.toLowerCase() + path.sep)) {
      throw reject('Native workspace overlaps a private credential/configuration root.');
    }
  }
  // Explicit allowlist: the provider process can authenticate, native children
  // must not receive its credential/proxy/config environment.
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = home; env.USERPROFILE = home;
  return [
    '[shell_environment_policy]', 'inherit = "none"', 'ignore_default_excludes = false',
    '[shell_environment_policy.set]', ...Object.entries(env).map(([key, value]) => JSON.stringify(key) + ' = ' + JSON.stringify(value)),
    '[windows]', 'sandbox = "mxc"',
    '[permissions.' + CODEX_NATIVE_PROFILE + '.filesystem]', '":minimal" = "read"',
    JSON.stringify(workspace) + ' = ' + JSON.stringify(policy.mode === 'read-only' ? 'read' : 'write'),
    ...denied.map(file => JSON.stringify(file) + ' = "deny"'),
    '[permissions.' + CODEX_NATIVE_PROFILE + '.network]', 'enabled = false',
  ].join('\n');
}

export function nativeHistoryUnsupported(thread, native) {
  return Array.isArray(thread?.turns) && thread.turns.some(turn => !turn || turn.items !== undefined && (!Array.isArray(turn.items) || turn.items.some(item =>
    !['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall', 'functionCallOutput'].includes(item?.type)
    && !(native && isCodexCodingItem(item)))));
}

export function queueNativeRecord(session, event) {
  const p = event.params;
  const item = p.item;
  const key = p.turnId + '\0' + item.id + '\0' + event.method;
  const digest = JSON.stringify(item);
  session.nativeSeen ??= new Map();
  const previous = session.nativeSeen.get(key);
  if (previous === digest) return session.nativeRecords;
  if (previous || session.nativeSeen.size >= 1024 || Buffer.byteLength(digest) > 512 * 1024) {
    throw reject('Native item identity or bounded record limit was violated.');
  }
  session.nativeSeen.set(key, digest);
  const clean = value => typeof value === 'string' ? safeAgentCliDiagnostic(value, session.redactionSecrets)
    : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child)])) : value;
  const record = nativeMeta(session, { method: event.method, item: clean(item) });
  session.nativeRecords = (session.nativeRecords ?? Promise.resolve()).then(async () => {
    session.nativeExecution.signal.throwIfAborted();
    await session.nativeExecution.assertCurrent(nativeMeta(session));
    await session.nativeExecution.record(record);
  });
  return session.nativeRecords;
}

async function containedFile(workspace, file) {
  const resolved = path.resolve(file);
  const relative = path.relative(workspace, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  let current = workspace;
  // Do not approve an edit through a junction/symlink or replaced directory.
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) return false;
  }
  return true;
}

export async function nativeApproval(session, request) {
  const p = request.params;
  if (request.method !== 'item/fileChange/requestApproval' || session.nativePolicy.mode !== 'workspace-write'
    || p.threadId !== session.threadId || p.turnId !== session.turnId || p.grantRoot != null) return 'decline';
  await session.nativeRecords;
  const row = session.nativeSeen?.get(p.turnId + '\0' + p.itemId + '\0item/started');
  const item = row ? JSON.parse(row) : null;
  if (item?.type !== 'fileChange' || !item.changes?.length || item.changes.length > 100) return 'decline';
  for (const change of item.changes) {
    if (typeof change.path !== 'string' || !await containedFile(session.nativePolicy.workspace, change.path)
      || change.kind?.movePath && !await containedFile(session.nativePolicy.workspace, change.kind.movePath)) return 'decline';
  }
  session.nativeExecution.signal.throwIfAborted();
  await session.nativeExecution.assertCurrent(nativeMeta(session, { itemId: p.itemId }));
  const decision = await session.nativeExecution.approve(nativeMeta(session, { requestId: request.id,
    method: request.method, itemId: p.itemId, changes: item.changes, allowedDecisions: ['decline', 'cancel'] }));
  // Full-only native capabilities use their OS profile without approvals.
  // Even an in-root accepted patch can widen that profile; no native escalation
  // or Ask capability is granted by this initial subset.
  if (!['decline', 'cancel'].includes(decision)) throw reject('Native escalation approvals are not supported; use a guarded Minnow tool.');
  session.nativeExecution.signal.throwIfAborted();
  await session.nativeExecution.assertCurrent(nativeMeta(session, { itemId: p.itemId }));
  return decision;
}
