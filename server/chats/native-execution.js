import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatContractError } from './contracts.js';
import { assertChatPolicy, intersectChatPolicies } from './policy.js';
import { readChatCheckoutIdentity } from './context.js';
import { createNativeExecutionContext } from '../generations/native-execution-context.js';
import { safeAgentCliDiagnostic } from '../generations/agent-cli/errors.js';
import { readCliCheckpoint } from '../generations/agent-cli/checkpoints.js';

// Shell can implement every one of these operations. A native write profile
// requires the equivalent filesystem/Git capabilities in the execution catalog.
export const NATIVE_READ_TOOLS = Object.freeze([
  'read_file', 'read_file_range', 'read_document', 'list_directory', 'find_files',
  'grep', 'search_in_file', 'get_file_metadata', 'execute_command', 'run_python', 'run_javascript',
  'git_status', 'git_diff', 'git_log', 'git_branch', 'repo_map', 'find_symbol', 'read_symbol', 'who_calls',
]);
export const NATIVE_WRITE_TOOLS = Object.freeze([
  'save_file', 'make_directory', 'append_file', 'insert_at_line', 'replace_text_in_file',
  'apply_patch', 'delete_path', 'move_file', 'copy_file', 'git_add', 'git_commit', 'git_checkout',
  'create_pdf', 'create_spreadsheet', 'create_word_document',
]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied = message => new ChatContractError('policy_denied', message);
const unavailable = message => new ChatContractError('capability_unavailable', message);
const uncertain = message => Object.assign(new ChatContractError('recovery_required', message), { checkpointUncertain: true, cliPolicyRejected: true });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const MAX_NATIVE_ARGUMENT_BYTES = 512 * 1024;
const NATIVE_GIT_READ_TOOLS = new Set(['git_status', 'git_diff', 'git_log', 'git_branch']);

// Redact before the shared diagnostic tail limit, including quoted JSON/env
// values and CLI flags that the ordinary error-message matcher does not cover.
function cleanObservation(value, secrets) {
  let text = String(value ?? '');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|authorization|password)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(--(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|authorization|password)\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '$1[redacted]');
  return safeAgentCliDiagnostic(text);
}

async function waitForBaseline(pending, signal) {
  signal.throwIfAborted();
  let cancel;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { if (cancel) signal.removeEventListener('abort', cancel); }
}

/** Conservative verified subset, not a ranking of mode labels or a preference grant. */
export function deriveChatNativePolicy({ capturedPolicy, currentPolicy, workspaceId, workspace, platform = process.platform, cliVersion, modelId }) {
  if (platform !== 'win32' || cliVersion !== '0.166.0' || modelId !== 'gpt-5.5') {
    throw unavailable('Native coding requires the verified Windows Codex 0.166.0 / gpt-5.5 adapter.');
  }
  const effective = intersectChatPolicies(assertChatPolicy(capturedPolicy), assertChatPolicy(currentPolicy));
  if (!workspaceId || !effective.workspaceIds.includes(workspaceId) || !path.isAbsolute(workspace ?? '')) {
    throw denied('Native execution is outside the captured/current workspace scope.');
  }
  if (!['general', 'build', 'debug', 'plan'].includes(effective.modeId)) throw denied('This mode has no verified native mapping.');
  for (const name of NATIVE_READ_TOOLS) {
    if (effective.toolPermissions[name] !== 'full') throw denied('Native shell requires the tool capability: ' + name + '.');
  }
  // Account for captured/current execution aliases even when the optional name
  // is not offered by today's built-in catalog. Metadata cannot label a shell
  // or Git mutation alias as "read" to evade this mapping.
  const toolNames = new Set([...Object.keys(capturedPolicy.toolPermissions), ...Object.keys(currentPolicy.toolPermissions),
    ...Object.keys(capturedPolicy.toolEffects), ...Object.keys(currentPolicy.toolEffects)]);
  for (const name of toolNames) {
    if ((name === 'execute_code' || capturedPolicy.toolEffects[name] === 'shell' || currentPolicy.toolEffects[name] === 'shell')
      && effective.toolPermissions[name] !== 'full') throw denied('Native shell requires the tool capability: ' + name + '.');
  }
  // Plan document writes remain guarded Minnow calls; approval must never turn
  // this read profile into a writable native workspace.
  const mode = effective.permissionLevel !== 'full' || effective.modeId === 'plan' || ['none', 'plans'].includes(effective.fileWriteScope) ? 'read-only' : 'workspace-write';
  if (mode === 'workspace-write') {
    for (const name of NATIVE_WRITE_TOOLS) {
      if (effective.toolPermissions[name] !== 'full') throw denied('Native writes require the tool capability: ' + name + '.');
    }
    for (const name of toolNames) {
      if (name.startsWith('git_') && !NATIVE_GIT_READ_TOOLS.has(name)
        || ['file-write', 'git-write'].includes(capturedPolicy.toolEffects[name]) || ['file-write', 'git-write'].includes(currentPolicy.toolEffects[name])) {
        if (effective.toolPermissions[name] !== 'full') throw denied('Native writes require the tool capability: ' + name + '.');
      }
    }
  }
  // No network permission exists in ChatPolicy. This subset has a fixed deny,
  // not an inferred network grant; the adapter must enforce it with MXC.
  return Object.freeze({ version: 1, workspace, mode, networkAccess: 'off',
    fingerprint: hash({ capabilityVersion: 'codex-mxc-0.166.0-v1', workspaceId, workspace, modelId,
      networkAccess: 'off', policy: effective }) });
}

async function containedPath(workspace, file) {
  if (typeof file !== 'string' || !file || Buffer.byteLength(file) > 4096 || /[\u0000-\u001f\u007f]/.test(file)) return false;
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(workspace, file);
  const relative = path.relative(workspace, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  let current = workspace;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) return false;
  }
  return true;
}

/**
 * Private host seam; not enabled by any HTTP body or preference.
 *
 * checkpoint is the EXISTING createChatCheckpointCoordinator().prepare result.
 * subscribePolicyChanges(listener) MUST synchronously install a live invalidation
 * subscription and return its disposer. Missing support means unavailable, not a
 * stale permission grant. The owner must also abort signal on Stop/lease loss.
 * The accepted command's captured.nativeExecution selection must be copied
 * unchanged into execution.captured: version, requestedMode/effectiveMode
 * ('native'), exact providerId/modelId/cliVersion, networkAccess ('off'). A
 * runtime preference or this function's requestedNative flag is not evidence
 * that the choice was captured before queueing.
 *
 * Adapter contract: runTurn encompasses only native running work, NEVER Minnow
 * dynamic dispatch/child waits. operation must return { nativeQuiescence: {
 * verified:true, source:'turn-completed'|'dynamic-tool-pause', generationId,
 * threadId, turnId } }. The adapter proves the entire native process/container
 * tree, including detached descendants, can no longer run effects (not merely
 * that the shell item or CLI parent completed),
 * drains record() writes, and verifies its native checkpoint before returning.
 * An ordinary returned tool handoff WITHOUT that proof is recovery, not success.
 * This module cannot infer quiescence from a protocol notification.
 */
export async function createChatNativeExecution({
  repository, checkpoint, capturedPolicy, resolveCurrentPolicy, subscribePolicyChanges,
  chatId, executionId, fence, cwd, workspaceId, providerId, modelId, cliVersion,
  platform = process.platform, signal, waitForApproval, redactionSecrets = [], requestedNative = false,
} = {}) {
  if (!repository || !checkpoint?.baseline || typeof checkpoint.effect !== 'function'
    || typeof resolveCurrentPolicy !== 'function' || typeof subscribePolicyChanges !== 'function'
    || requestedNative !== true || !signal || !id(chatId) || !id(executionId) || !id(providerId) || fence?.executionId !== executionId) {
    throw unavailable('Native execution needs a captured opt-in, fenced host, checkpoint and live policy invalidation subscription.');
  }
  if (!Array.isArray(redactionSecrets) || redactionSecrets.length > 128
    || redactionSecrets.some(secret => typeof secret !== 'string' || Buffer.byteLength(secret) > 64 * 1024)
    || Buffer.byteLength(JSON.stringify(redactionSecrets)) > 256 * 1024) {
    throw unavailable('Native redaction secrets require a bounded array of strings.');
  }
  const secrets = Object.freeze([...redactionSecrets]);
  const clean = value => cleanObservation(value, secrets);
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, stop.signal]);
  const workspace = await fs.realpath(cwd);
  const checkoutIdentity = await readChatCheckoutIdentity(workspace);
  const executionFence = Object.freeze({ ...fence });
  // Native histories already contain these exact actions. Keep their canonical
  // observational rows for other adapters/UI, but do not inject duplicate prose
  // into the same verified native thread and invalidate its accepted prefix.
  const observationContents = new Set(repository.getDatabase().prepare("SELECT json_extract(payload_json,'$.content') AS content FROM messages WHERE chat_id=? AND json_type(payload_json,'$.nativeAction')='object' ORDER BY seq DESC LIMIT 4096")
    .all(chatId).map(row => row.content).filter(value => typeof value === 'string'));
  const selection = repository.getExecution(executionId)?.captured?.nativeExecution;
  if (!selection || selection.version !== 1 || selection.requestedMode !== 'native' || selection.effectiveMode !== 'native'
    || selection.providerId !== providerId || selection.modelId !== modelId || selection.cliVersion !== cliVersion
    || selection.networkAccess !== 'off') {
    throw unavailable('Native choice must be captured immutably at server command admission; runtime preferences or request JSON cannot supply it.');
  }
  const capturedSelectionHash = hash(selection);
  let active = null, disposed = false, unsubscribe;
  const cancelledAtAdmission = repository.getCancellationEpoch(chatId);
  const policyInput = { capturedPolicy, workspaceId, workspace, platform, cliVersion, modelId };
  let policy;
  const revoke = error => { if (!stop.signal.aborted) stop.abort(error); };
  const check = async () => {
    try {
    combined.throwIfAborted();
    if (disposed) throw denied('Native execution authority has been disposed.');
    repository.assertFence(chatId, executionFence);
    if (repository.getCancellationEpoch(chatId) !== cancelledAtAdmission) throw denied('Native execution was cancelled.');
    const execution = repository.getExecution(executionId);
    if (!execution || execution.chatId !== chatId || execution.status !== 'running') throw denied('Native execution is no longer running.');
    if (hash(execution.captured?.nativeExecution ?? null) !== capturedSelectionHash) throw denied('The admitted native selection changed.');
    if (await readChatCheckoutIdentity(workspace) !== checkoutIdentity || key(await fs.realpath(cwd)) !== key(workspace)) {
      throw denied('The native checkout changed identity.');
    }
    const current = deriveChatNativePolicy({ ...policyInput, currentPolicy: await resolveCurrentPolicy() });
    if (policy && current.fingerprint !== policy.fingerprint) throw denied('Native policy changed; a new admission is required.');
    // Fence once more after asynchronous policy/filesystem reads.
    repository.assertFence(chatId, executionFence);
    combined.throwIfAborted();
    return current;
    } catch (error) { revoke(error); throw error; }
  };
  try {
    // Invalidation is synchronous: even a transient revoke/regrant must not
    // retain a native grant. Ordinary new admissions may use the new policy.
    unsubscribe = subscribePolicyChanges(() => revoke(denied('Native policy invalidated; stop and reconcile this turn.')));
    if (typeof unsubscribe !== 'function') throw unavailable('Native policy invalidation has no lifecycle disposer.');
    policy = await check();
    if (observationContents.size) {
      const saved = await readCliCheckpoint(providerId, chatId);
      if (!saved?.nativeCoding || saved.nativeRecoveryRequired || saved.nativePolicyFingerprint !== policy.fingerprint) {
        throw unavailable('Saved native observations require their compatible verified native checkpoint; choose explicit recovery rather than rebuilding past actions.');
      }
    }
  } catch (error) {
    if (typeof unsubscribe === 'function') unsubscribe();
    throw error;
  }

  const assertMeta = (meta, regionRequired = true) => {
    if (!meta || meta.chatId !== chatId || meta.providerId !== providerId || meta.workspace !== workspace
      || meta.mode !== policy.mode || meta.policyFingerprint !== policy.fingerprint || !id(meta.generationId)
      || meta.threadId != null && !id(meta.threadId)) {
      throw denied('Native callback identity does not match its admitted execution.');
    }
    if (regionRequired) {
      if (!active || active.generationId !== meta.generationId || active.threadId && active.threadId !== meta.threadId) throw denied('Native callback is outside its running region.');
      if (meta.threadId != null) active.threadId ??= meta.threadId;
      if (active.turnId && meta.turnId !== active.turnId) throw denied('Native callback is outside its admitted turn.');
      if (meta.turnId != null) {
        if (!id(meta.turnId) || active.turnId && active.turnId !== meta.turnId) throw denied('Native turn identity changed.');
        active.turnId ??= meta.turnId;
      }
    }
  };
  const seenGenerations = new Set();
  const authority = Object.freeze({
    policy, signal: combined,
    projectMessages(messages) {
      if (!Array.isArray(messages)) throw unavailable('Native observation projection requires a message array.');
      const projected = new Set();
      return messages.filter(row => {
        if (row?.role !== 'assistant' || typeof row.content !== 'string' || !observationContents.has(row.content)) return true;
        // Provider sanitization removes row metadata. Content equality is only
        // safe for unambiguous observational prose, never executable calls or
        // repeated quoted copies whose provenance can no longer be established.
        if (row.tool_calls != null || row.tool_call_id != null || projected.has(row.content)) {
          throw unavailable('Native observation projection is ambiguous; explicit recovery is required before continuing.');
        }
        projected.add(row.content);
        return false;
      });
    },
    async assertCurrent(meta) {
      try { assertMeta(meta); await check(); }
      catch (error) { revoke(error); throw error; }
    },
    async runTurn(meta, operation) {
      assertMeta(meta, false);
      if (active || seenGenerations.has(meta.generationId) || typeof operation !== 'function') {
        throw uncertain('A native running region cannot overlap or be automatically replayed.');
      }
      await check();
      // Unlike external-tool model preparation, native inference can itself
      // mutate. Finish a REAL Git baseline before entering turn/start.
      const baseline = await waitForBaseline(checkpoint.baseline, combined);
      if (!baseline?.sha) throw unavailable('Native execution requires a captured Git safety baseline.');
      await check();
      const region = { generationId: meta.generationId, threadId: meta.threadId ?? null, turnId: meta.turnId ?? null, items: new Map(), approvals: new Set(), bytes: 0 };
      const checkpointId = 'native-' + hash([executionId, meta.generationId]);
      seenGenerations.add(meta.generationId);
      active = region; // Reserve before waiting for another checkout's lock.
      try {
        return await checkpoint.effect(checkpointId, async () => {
          await check(); // The lock wait must not preserve a stale policy.
          const result = await operation();
          await check();
          const proof = result?.nativeQuiescence;
          if (!proof || proof.verified !== true || !['turn-completed', 'dynamic-tool-pause'].includes(proof.source)
            || proof.generationId !== region.generationId || proof.threadId !== region.threadId
            || !id(proof.turnId) || region.turnId !== proof.turnId
            || [...region.items.values()].some(item => !item.completed)) {
            throw uncertain('Native pause/checkpoint quiescence was not verified before releasing the checkout boundary.');
          }
          return result;
        });
      } catch (error) { revoke(error); throw error; }
      finally { active = null; }
    },
    async record(event) {
      try {
      await authority.assertCurrent(event);
      const region = active;
      const item = event.item;
      if (!id(event.threadId) || !id(event.turnId) || !id(item?.id) || !['commandExecution', 'fileChange'].includes(item.type)
        || !['item/started', 'item/completed'].includes(event.method)) throw uncertain('Unsupported native observation.');
      const encoded = JSON.stringify(item);
      const bytes = Buffer.byteLength(encoded);
      if (bytes > MAX_NATIVE_ARGUMENT_BYTES || (region.bytes += bytes) > 4 * 1024 * 1024 || region.items.size >= 1024 && !region.items.has(item.id)) {
        throw uncertain('Native observations exceeded their bounded storage budget.');
      }
      let observed = region.items.get(item.id);
      if (!observed) { observed = { type: item.type }; region.items.set(item.id, observed); }
      if (observed.type !== item.type) throw uncertain('Native item identity changed type.');
      const stage = event.method === 'item/completed' ? 'completed' : 'started';
      if (policy.mode === 'read-only' && item.type === 'fileChange' && stage === 'completed' && item.status === 'completed') {
        throw uncertain('A native file change completed under a read-only policy; explicit recovery is required.');
      }
      const digest = hash(item);
      if (observed[stage]) {
        if (observed[stage] !== digest) throw uncertain('Native observation changed after durable acknowledgement.');
        return;
      }
      if (stage === 'completed' && !observed.started || stage === 'started' && observed.completed) throw uncertain('Native observations arrived out of order.');
      if (item.type === 'fileChange') {
        if (!Array.isArray(item.changes) || !item.changes.length || item.changes.length > 100) throw uncertain('Invalid native file change observation.');
        for (const change of item.changes) {
          if (!await containedPath(workspace, change.path) || change.kind?.movePath && !await containedPath(workspace, change.kind.movePath)) {
            throw uncertain('Native observed a file change outside its admitted paths.');
          }
        }
      }
      // Canonical assistant prose + observational metadata, NEVER tool_calls or
      // executable tool roles. Rebuild can read the facts, not replay an action.
      const record = { executionId, generationId: event.generationId, threadId: event.threadId, turnId: event.turnId,
        itemId: clean(item.id), type: item.type, stage, status: clean(item.status ?? stage),
        ...(item.type === 'commandExecution' ? { command: clean(item.command ?? ''), output: clean(item.aggregatedOutput ?? ''),
          ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}) }
          : { changes: item.changes.map(change => ({ path: clean(change.path), kind: clean(change.kind?.type ?? ''),
            ...(change.kind?.movePath ? { movePath: clean(change.kind.movePath) } : {}) })) }) };
      await authority.assertCurrent(event);
      const content = 'Native Codex observation (not a tool call): ' + JSON.stringify(record);
      repository.appendMessage(chatId, { role: 'assistant', content,
        nativeAction: record }, { fence: executionFence, messageId: 'native-' + hash([executionId, event.threadId, event.turnId, item.id, stage]) });
      observationContents.add(content);
      observed[stage] = digest;
      if (stage === 'started') observed.original = JSON.parse(encoded);
      } catch (error) { revoke(error); throw error; }
    },
    async approve(request) {
      try {
      await authority.assertCurrent(request);
      const region = active;
      // No native approval may override Plan/read-only, Ask/Off, a path deny,
      // grantRoot, a shell/network escalation or a session-wide decision.
      if (request.allowedDecisions !== undefined && (!Array.isArray(request.allowedDecisions)
        || request.allowedDecisions.length > 3
        || !request.allowedDecisions.includes('accept')
        || request.allowedDecisions.some(decision => !['accept', 'decline', 'cancel'].includes(decision)))) return 'decline';
      if (policy.mode !== 'workspace-write' || request.method !== 'item/fileChange/requestApproval'
        || request.grantRoot != null || !id(request.itemId) || !id(request.threadId) || !id(request.turnId)
        || !(typeof request.requestId === 'number' && Number.isSafeInteger(request.requestId) || id(request.requestId))
        || typeof waitForApproval !== 'function') return 'decline';
      if (!Array.isArray(request.changes) || !request.changes.length || request.changes.length > 100
        || Buffer.byteLength(JSON.stringify(request.changes)) > MAX_NATIVE_ARGUMENT_BYTES) return 'decline';
      const observed = region.items.get(request.itemId);
      if (!observed?.started || observed.completed || observed.type !== 'fileChange'
        || hash(request.changes) !== hash(observed.original.changes)) return 'decline';
      const requestKey = String(request.requestId);
      if (region.approvals.has(requestKey)) throw uncertain('A native approval request cannot be repeated.');
      for (const change of request.changes) {
        if (!await containedPath(workspace, change.path) || change.kind?.movePath && !await containedPath(workspace, change.kind.movePath)) return 'decline';
        // Never ask approval for a hidden/truncated sensitive path. Guarded
        // Minnow tools can present any unsupported case separately.
        if (clean(change.path) !== change.path || change.kind?.movePath && clean(change.kind.movePath) !== change.kind.movePath) return 'decline';
      }
      region.approvals.add(requestKey);
      const answer = await waitForApproval({ kind: 'approval', toolCallId: 'native-approval-' + hash([executionId, region.threadId, region.turnId, requestKey]),
        title: 'Allow native file change?', presentation: { executionId, generationId: region.generationId, threadId: region.threadId,
          turnId: region.turnId, itemId: request.itemId, requestId: request.requestId, workspaceRoot: workspace,
          paths: request.changes.map(change => change.path) } }, combined);
      await authority.assertCurrent(request);
      for (const change of request.changes) {
        if (!await containedPath(workspace, change.path) || change.kind?.movePath && !await containedPath(workspace, change.kind.movePath)) return 'decline';
      }
      return ['allow_once', 'allow_chat'].includes(typeof answer === 'string' ? answer : answer?.decision) ? 'accept' : answer === 'cancel' ? 'cancel' : 'decline';
      } catch (error) { revoke(error); throw error; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; revoke(denied('Native authority disposed.')); unsubscribe();
    },
  });
  return createNativeExecutionContext(authority, { chatId, providerId, modelId });
}
