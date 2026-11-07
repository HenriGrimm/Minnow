import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runProcess } from '../process-runner.js';
import { runWithToolContext } from '../runtime/path-access.js';
import { enableChatWorktree } from '../worktree/worktree-ops.js';
import { getChatWorktreePath } from '../worktree/paths.js';
import { readChatCheckoutIdentity } from './context.js';
import { assertCaller, assertCallerCanTarget, resolveProjectScope } from './caller.js';
import { ChatContractError } from './contracts.js';
import { createChatPolicy } from './policy.js';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = isDeepStrictEqual;
const fail = (code, message) => { throw new ChatContractError(code, message, { retryable: true }); };
const pendingStates = ['accepted', 'queued', 'waiting_for_host'];
const active = new Set(['running', 'waiting', 'loading_model', 'waiting_for_model', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval', 'waiting_for_host']);

/** Rebind only the already-authorized source workspace, without widening tools,
 * filesystem, mode, shell or peer-workspace authority. Also used on immutable
 * profile snapshots by prompt preparation, after verifying the binding. */
export function rebindChatWorkspacePolicy(policy, { sourceWorkspaceId, workspaceId }) {
  const validated = createChatPolicy(policy);
  if (!validated.workspaceIds.includes(sourceWorkspaceId) && !validated.workspaceIds.includes(workspaceId)) {
    fail('workspace_denied', 'The admitted policy does not authorize the worktree source workspace');
  }
  return createChatPolicy({ ...validated, workspaceIds: validated.workspaceIds.map(id => id === sourceWorkspaceId ? workspaceId : id) });
}

/**
 * Server-owned ordinary worktree preparation, using the canonical sessions DB.
 *
 * Wiring: capture(target) before admission; persist its result in
 * command.captured.workspacePreparation and call admit(chatId, intent) in that
 * SAME admission transaction, before returning the receipt. After claiming the
 * execution fence, call prepare(input) BEFORE prompt/model preparation. Replace
 * input.execution with the returned execution: its scope is now the final,
 * verified checkout, not the source checkout. Never catch setup failure and run
 * inference in the source workspace. chooseLocal is authenticated human-only at
 * the transport/service boundary; it cancels unstarted automatic inputs.
 */
export function createChatWorkspacePreparation({ repository, context, enableWorktree = enableChatWorktree,
  onChange = () => {}, id = randomUUID } = {}) {
  if (!repository?.getDatabase || !context?.project || !context?.resolveTarget) {
    throw new TypeError('Workspace preparation requires the canonical repository and trusted context');
  }
  const db = repository.getDatabase(), preparing = new Map(), retries = new Map();
  const read = chatId => repository.getChat(chatId).workspacePreparation ?? null;
  function changed(chatId) { try { Promise.resolve(onChange(chatId)).catch(() => {}); } catch { /* presentation */ } }
  function write(chatId, state, updates = {}) {
    const row = db.prepare('SELECT meta_json FROM chat_conversation_state WHERE chat_id=?').get(chatId);
    if (!row) fail('capability_unavailable', 'Workspace preparation requires a canonical conversation');
    const meta = JSON.parse(row.meta_json);
    db.prepare('UPDATE chat_conversation_state SET meta_json=? WHERE chat_id=?')
      .run(JSON.stringify({ ...meta, workspacePreparation: state, ...updates }), chatId);
    // Use the repository's canonical revision/notification bookkeeping.
    repository.ensureManagedChat(chatId);
  }
  async function git(args, cwd) {
    const result = await runProcess('git', args, { cwd, timeout: 10_000 });
    if (result.code !== 0 || result.accumulationTruncated) fail('workspace_denied', 'Cannot verify the worktree repository. Inspect it in Source Control before retrying.');
    return result.stdout.trim();
  }
  async function binding(cwd) {
    try {
      const canonical = await fs.realpath(cwd);
      const common = await fs.realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], canonical));
      const gitDir = await fs.realpath(await git(['rev-parse', '--path-format=absolute', '--git-dir'], canonical));
      const branch = await git(['symbolic-ref', '--short', 'HEAD'], canonical);
      return { path: canonical, checkoutIdentity: await readChatCheckoutIdentity(canonical),
        commonIdentity: await readChatCheckoutIdentity(common), gitIdentity: await readChatCheckoutIdentity(gitDir), branch,
        head: await git(['rev-parse', '--verify', 'HEAD'], canonical) };
    } catch (error) {
      if (error instanceof ChatContractError) throw error;
      fail('workspace_denied', 'The selected checkout is unavailable or cannot be verified. Restore it before retrying, or explicitly choose Local.');
    }
  }
  async function assertBinding(expected) {
    const current = await binding(expected.path);
    if (!same(current, expected)) fail('workspace_denied', 'The selected checkout or branch changed. Restore the original checkout before retrying, or explicitly choose Local.');
    return current;
  }
  async function capture(target, choice) {
    const chat = target.chat, previous = read(chat.id);
    if (choice?.kind === 'local') return null;
    if (choice && choice.kind !== 'automatic') fail('invalid_request', 'Server deferred setup supports automatic worktrees or explicit Local only');
    const requested = choice?.kind === 'automatic' || chat.worktreeSetupRequired === true || chat.worktreeEnabled === true;
    if (!requested) return null;
    if (chat.agentConversation) fail('policy_denied', 'Deferred setup is available only to ordinary conversations');
    if (chat.worktreeRoot && previous?.status === 'ready') return null;
    if (chat.worktreeRoot) fail('workspace_denied', 'Detach the existing checkout explicitly before requesting automatic setup');
    if (previous?.intent && previous.status !== 'local') return previous.intent;
    const source = await binding(chat.workspacePath);
    if (source.checkoutIdentity !== target.checkoutIdentity || key(source.path) !== target.scope.canonicalKey) {
      fail('workspace_denied', 'The source checkout changed before worktree admission');
    }
    return { version: 1, kind: 'automatic', id: id(), chatId: chat.id, projectId: target.scope.projectId,
      source, sourceWorkspaceId: target.scope.workspaceId,
      slotPath: getChatWorktreePath(chat.id, source.path), title: String(chat.name || 'worktree').slice(0, 512) };
  }
  function admit(chatId, intent) {
    if (!intent) return;
    if (intent.version !== 1 || intent.kind !== 'automatic' || intent.chatId !== chatId) fail('invalid_request', 'Invalid server workspace intent');
    const previous = read(chatId);
    if (previous?.intent?.id === intent.id) return;
    if (previous && previous.status !== 'local') fail('stale_revision', 'The selected workspace preparation changed');
    write(chatId, { intent, status: 'pending', binding: previous?.binding ?? null },
      { worktreeEnabled: true, worktreeSetupRequired: true });
  }
  function assertOwner(input, intent) {
    input.signal?.throwIfAborted();
    repository.assertFence(input.command.chatId, input.fence);
    const execution = repository.getExecution(input.execution.executionId);
    if (!execution || !active.has(execution.status) || execution.commandId !== input.command.commandId ||
        execution.captured?.workspacePreparation?.id !== intent.id ||
        repository.getCancellationEpoch(input.command.chatId) !== execution.captured.cancellationEpoch) {
      fail('ownership_conflict', 'Worktree setup no longer owns this conversation');
    }
    const current = read(input.command.chatId);
    if (current?.intent?.id !== intent.id || current.status === 'local') fail('workspace_denied', 'The selected worktree setup changed');
    return current;
  }
  async function verifiedSlot(intent, expected, { ready = false } = {}) {
    if (key(getChatWorktreePath(intent.chatId, intent.source.path)) !== key(intent.slotPath)) {
      fail('workspace_denied', 'The managed worktree storage location changed');
    }
    const current = await binding(intent.slotPath);
    // Once setup is ready, prior turns may legitimately commit on this branch.
    // HEAD is a setup fence, not an immutable execution-directory identity.
    const comparable = value => ready ? { ...value, head: null } : value;
    if (expected && !same(comparable(current), comparable(expected))) fail('workspace_denied', 'The prepared worktree was replaced or its branch changed. Inspect it in Source Control; no input was executed.');
    if (current.commonIdentity !== intent.source.commonIdentity) fail('workspace_denied', 'The prepared checkout belongs to another repository');
    const project = await context.project(intent.source.path);
    const scope = resolveProjectScope(project.registry, { projectId: intent.projectId, workspaceKey: key(current.path) });
    if (scope.projectId !== intent.projectId) fail('workspace_denied', 'The prepared checkout is no longer in the original project');
    return { binding: current, scope };
  }
  async function perform(input) {
    const { command, signal } = input;
    const intent = input.execution.captured?.workspacePreparation;
    if (!intent) {
      const chat = repository.getChat(command.chatId);
      if (chat.worktreeSetupRequired || chat.worktreeEnabled && !chat.worktreeRoot) {
        fail('capability_unavailable', 'This input has no durable worktree setup intent. Retry the send or explicitly choose Local.');
      }
      return { execution: input.execution, target: await context.resolveTarget(command.chatId) };
    }
    let current = assertOwner(input, intent);
    try {
      if (current.status !== 'ready') await assertBinding(intent.source);
      if (current.binding) await verifiedSlot(intent, current.binding, { ready: current.status === 'ready' });
      else {
        // A crash may leave an allocated folder without a durable binding. Never
        // adopt it automatically: an unrelated replacement must not inherit it.
        if (await fs.lstat(intent.slotPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
          fail('recovery_required', 'An unconfirmed worktree allocation exists. Inspect it in Source Control before retrying; it will not be replaced.');
        }
      }
      if (current.status !== 'ready') {
        repository.atomic(() => { current = assertOwner(input, intent); write(command.chatId, { ...current, status: 'preparing', error: null }); });
        changed(command.chatId);
        let bound = false;
        const result = await runWithToolContext(() => enableWorktree({ chatId: command.chatId, title: intent.title, signal,
          onCheckout: async result => {
            assertOwner(input, intent);
            await assertBinding(intent.source);
            if (!result.path || key(result.path) !== key(intent.slotPath)) fail('workspace_denied', 'Worktree setup returned an unexpected checkout');
            const verified = await verifiedSlot(intent, read(command.chatId).binding);
            repository.atomic(() => {
              const latest = assertOwner(input, intent);
              write(command.chatId, { ...latest, binding: verified.binding });
            });
            bound = true;
          } }), { workspaceRoot: intent.source.path });
        assertOwner(input, intent);
        if (!bound) fail('recovery_required', 'Worktree setup did not confirm its checkout before dependency preparation. Inspect it before retrying.');
        if (!result?.ok) fail('capability_unavailable', String(result?.error || 'Dependency preparation failed. The worktree has been kept.').slice(0, 3200) + ' Retry setup or explicitly choose Local.');
        current = read(command.chatId);
      }
      if (current.status !== 'ready') await assertBinding(intent.source);
      const verified = await verifiedSlot(intent, current.binding, { ready: current.status === 'ready' });
      const policyBinding = { sourceWorkspaceId: intent.sourceWorkspaceId, workspaceId: verified.scope.workspaceId };
      const rebind = captured => ({ ...captured, scope: verified.scope, checkoutIdentity: verified.binding.checkoutIdentity,
        workspacePolicyBinding: policyBinding,
        ...(captured.policy ? { policy: rebindChatWorkspacePolicy(captured.policy, policyBinding) } : {}) });
      repository.atomic(() => {
        current = assertOwner(input, intent);
        const chat = repository.getChat(command.chatId);
        if (chat.worktreeRoot && key(chat.worktreeRoot) !== key(verified.binding.path)) fail('workspace_denied', 'The conversation run target changed during setup');
        db.prepare('UPDATE chats SET worktree_root=?,git_branch=? WHERE id=?').run(verified.binding.path, verified.binding.branch, command.chatId);
        write(command.chatId, { ...current, binding: verified.binding, status: 'ready', error: null },
          { worktreeEnabled: false, worktreeSetupRequired: false, chatWorktreeManaged: true });
        // Queued sends admitted during this setup must bind this SAME allocation,
        // not become stranded on the captured source scope after the first send.
        const rows = db.prepare("SELECT command_id,captured_json FROM chat_commands WHERE chat_id=? AND state IN ('accepted','queued','waiting_for_host','running')").all(command.chatId);
        for (const row of rows) {
          const captured = JSON.parse(row.captured_json);
          if (captured.workspacePreparation?.id !== intent.id) continue;
          db.prepare('UPDATE chat_commands SET captured_json=? WHERE command_id=?')
            .run(JSON.stringify(rebind(captured)), row.command_id);
        }
        const execution = repository.getExecution(input.execution.executionId);
        db.prepare('UPDATE chat_executions SET captured_json=? WHERE execution_id=?').run(JSON.stringify(rebind(execution.captured)), execution.executionId);
      });
      const target = await context.resolveTarget(command.chatId);
      assertOwner(input, intent);
      if (target.checkoutIdentity !== verified.binding.checkoutIdentity || target.scope.canonicalKey !== verified.scope.canonicalKey) {
        fail('workspace_denied', 'The final worktree target changed before inference');
      }
      changed(command.chatId);
      return { execution: repository.getExecution(input.execution.executionId), target };
    } catch (error) {
      // Losing the fence must not let a stale setup overwrite a newer decision.
      try {
        repository.atomic(() => {
          const latest = assertOwner({ ...input, signal: undefined }, intent);
          write(command.chatId, { ...latest, status: signal?.aborted ? 'cancelled' : 'failed',
            error: String(error?.message || 'Worktree setup failed').slice(0, 3600) },
          { worktreeEnabled: true, worktreeSetupRequired: true });
        });
        changed(command.chatId);
      } catch { /* stale ownership */ }
      throw error;
    }
  }
  function prepare(input) {
    const id = input.execution.executionId;
    const existing = preparing.get(id);
    if (existing) return existing;
    const promise = perform(input).finally(() => { if (preparing.get(id) === promise) preparing.delete(id); });
    preparing.set(id, promise);
    return promise;
  }
  function chooseLocal({ chatId, expectedIntentId }) {
    if (typeof expectedIntentId !== 'string' || !expectedIntentId) fail('invalid_request', 'A saved worktree setup identity is required');
    const result = repository.atomic(() => {
      const current = read(chatId);
      if (current?.intent?.id !== expectedIntentId) fail('stale_revision', 'Worktree setup changed. Refresh before choosing Local.');
      if (repository.getLease(chatId)?.state === 'active') fail('ownership_conflict', 'Stop the active setup or turn before choosing Local');
      for (const record of repository.listCommands({ chatId, states: pendingStates, limit: 1000 })) {
        if (record.captured.workspacePreparation?.id === expectedIntentId) repository.updateCommand(record.commandId,
          { state: 'cancelled', result: { disposition: 'worktree_detached' } });
      }
      db.prepare("UPDATE chats SET worktree_root='',git_branch='' WHERE id=?").run(chatId);
      write(chatId, { ...current, status: 'local', error: null },
        { worktreeEnabled: false, worktreeSetupRequired: false, chatWorktreeManaged: false });
      return repository.getChat(chatId);
    });
    changed(chatId);
    return result;
  }
  /** Explicit human Retry: setup only, never replay the failed model command. */
  function retry({ chatId, expectedIntentId, signal }) {
    if (typeof expectedIntentId !== 'string' || !expectedIntentId) fail('invalid_request', 'A saved worktree setup identity is required');
    const existing = retries.get(chatId);
    if (existing) {
      if (existing.intentId !== expectedIntentId) fail('stale_revision', 'The pending worktree retry changed');
      return existing.promise;
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = (async () => {
      let input, renewal;
      repository.atomic(() => {
        const state = read(chatId);
        if (state?.intent?.id !== expectedIntentId || state.status === 'local') fail('stale_revision', 'Workspace setup changed. Refresh before retrying.');
        if (state.status === 'ready') return;
        if (repository.getLease(chatId)?.state === 'active') fail('ownership_conflict', 'Stop the active setup or turn before retrying');
        const command = repository.listCommands({ chatId, states: ['failed', 'cancelled'], limit: 1000 })
          .findLast(row => row.captured.workspacePreparation?.id === expectedIntentId);
        if (!command) fail('capability_unavailable', 'Send your message to prepare the selected worktree');
        const executionId = 'workspace-' + id();
        const execution = repository.createExecution({ executionId, chatId, commandId: command.commandId, kind: 'server',
          captured: { ...command.captured, cancellationEpoch: repository.getCancellationEpoch(chatId), workspaceSetupOnly: true } });
        const fence = repository.claimExecution({ executionId, chatId, ownerId: 'workspace-setup', leaseMs: 30000 });
        input = { command: command.effectiveCommand, execution: repository.getExecution(execution.executionId), fence, signal: combined };
      });
      if (!input) return repository.getChat(chatId);
      renewal = setInterval(() => {
        try {
          if (repository.getCancellationEpoch(chatId) !== input.execution.captured.cancellationEpoch) {
            controller.abort(new DOMException('Worktree setup stopped', 'AbortError')); return;
          }
          repository.renewLease(chatId, input.fence, 30000);
        } catch (error) { controller.abort(error); }
      }, 100);
      renewal.unref?.();
      try {
        await prepare(input);
        repository.updateExecution(input.execution.executionId, { status: 'completed', result: { workspaceSetupOnly: true } }, { fence: input.fence });
        return repository.getChat(chatId);
      } catch (error) {
        repository.updateExecution(input.execution.executionId, { status: combined.aborted ? 'stopped' : 'failed',
          result: { workspaceSetupOnly: true, error: String(error?.message || 'Setup failed').slice(0, 3600) } }, { fence: input.fence });
        throw error;
      } finally {
        clearInterval(renewal);
        repository.releaseLease(chatId, input.fence);
        changed(chatId);
      }
    })().finally(() => { if (retries.get(chatId)?.promise === promise) retries.delete(chatId); });
    retries.set(chatId, { intentId: expectedIntentId, controller, promise });
    return promise;
  }
  function stopRetry(chatId, executionId) {
    const entry = retries.get(chatId);
    if (!entry) return false;
    const lease = repository.getLease(chatId);
    if (executionId && executionId !== lease?.executionId) return false;
    entry.controller.abort(new DOMException('Worktree setup stopped', 'AbortError'));
    return true;
  }
  /** POST /api/chats/:id/workspace authenticated adapter. The command service
   * should serialize this with human configuration/admission for the same chat.
   * Do not pass the HTTP disconnect signal: setup is server-owned. */
  async function applyChoice(caller, input) {
    assertCaller(caller);
    if (caller.actor !== 'human' || !['renderer', 'device', 'cli'].includes(caller.ingress)) {
      fail('caller_denied', 'Only a human may retry setup or explicitly choose Local');
    }
    if (!input || Object.keys(input).some(key => !['chatId', 'action', 'expectedIntentId', 'clientRequestId'].includes(key)) ||
        !['retry', 'local'].includes(input.action) || typeof input.expectedIntentId !== 'string') {
      fail('invalid_request', 'Invalid worktree recovery choice');
    }
    const target = await context.resolveTarget(input.chatId);
    assertCallerCanTarget(caller, target, { operation: 'send', currentPolicy: target.currentPolicy, registry: target.registry });
    if (target.chat.agentConversation || target.chat.chatCommandVersion !== 1) fail('policy_denied', 'This control requires an ordinary canonical conversation');
    return { chat: input.action === 'local' ? chooseLocal(input) : await retry(input) };
  }
  return { capture, admit, prepare, read, chooseLocal, retry, stopRetry, applyChoice };
}
