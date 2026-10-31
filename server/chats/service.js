import { createHash, randomUUID } from 'node:crypto';
import { createChatRepository, hashChatPayload } from './repository.js';
import { assertCaller, assertCallerCanTarget } from './caller.js';
import { createChatPolicy, intersectChatPolicies } from './policy.js';
import { ChatContractError, validateChatCommand, validateChatId, validateModelSelection, validateChatTaskResult, validateChatError } from './contracts.js';
import { getAgentConversationsFeature } from './feature.js';
import { resolveAgentModelSelection } from './model-selection.js';

const ACTIVE = new Set(['running', 'waiting', 'waiting_for_model', 'loading_model', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval']);
const PENDING = ['accepted', 'queued', 'waiting_for_host'];
const hashId = (prefix, value) => prefix + '-' + createHash('sha256').update(value).digest('hex').slice(0, 40);
const same = (a, b) => hashChatPayload(a ?? null) === hashChatPayload(b ?? null);
function failure(code, message) { throw new ChatContractError(code, message); }
function checked(result) {
  if (!result.ok) throw new ChatContractError(result.error.code, result.error.message, result.error);
  return result.value;
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) failure('invalid_request', 'Expected command input');
  for (const key of Object.keys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!allowed.includes(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) failure('invalid_request', 'Unsupported command input field');
  }
}
function publicError(error) {
  return error instanceof ChatContractError ? error.toJSON()
    : { code: 'internal_error', message: 'Conversation execution failed', retryable: false };
}
function inputMessageId(commandId) {
  return commandId.length <= 154 ? 'input-' + commandId
    : 'input-' + createHash('sha256').update(commandId).digest('hex');
}
function receipt(record, replayed = false) {
  const disposition = record.result?.disposition
    ?? (record.state === 'running' ? 'started' : record.state === 'waiting_for_host' ? 'waiting_for_host'
      : record.state === 'queued' ? 'queued' : ['settled', 'failed', 'cancelled'].includes(record.state) ? 'settled' : 'accepted');
  return {
    commandId: record.commandId, chatId: record.chatId, state: record.state, disposition,
    position: record.position, revision: record.revision, executionId: record.executionId,
    runId: record.runId, messageId: record.messageId, held: record.held,
    result: record.result, error: record.error, replayed,
    link: '#/app/code/chat?chatId=' + encodeURIComponent(record.chatId),
  };
}

/**
 * Durable command admission and per-chat ownership. Hosts execute runTurn;
 * child task capacity/retry admission remains the injected subagent graph.
 * Transport adapters must create branded callers from authenticated context.
 */
export function createChatCommandService({
  repository = createChatRepository(), context, resolveModelSelection, captureProfile,
  feature = getAgentConversationsFeature, now = Date.now, id = randomUUID,
  hasExternalOwner = () => false, getExternalOwner, stopExternalOwner, isExternalExecutionActive, cancelTree, admitChildTask, admitCausality,
  onEvent, onCommand, canResumeQuestionExecution = () => false, onError = (error) => console.error('[chats] command execution failed:', error),
  leaseMs = 30000, maxPendingCommands = 100,
} = {}) {
  if (!context || typeof context.resolveTarget !== 'function') throw new TypeError('Chat service requires a trusted context resolver');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30 || !Number.isSafeInteger(maxPendingCommands) || maxPendingCommands < 1) {
    throw new TypeError('Invalid chat command service limits');
  }
  const hosts = new Map(), active = new Map(), pumps = new Map(), admissions = new Map(), backgroundErrors = new Map(), controlDrains = new Map();
  const commandObservers = new Map();
  const requestedPumps = new Set();
  let disposed = false;
  function emit(event) {
    if (typeof onEvent !== 'function') return;
    try { Promise.resolve(onEvent(event)).catch(() => {}); } catch { /* Presentation cannot reject a durable command. */ }
  }
  function announce(record, type = 'command') {
    emit({ type, chatId: record.chatId, commandId: record.commandId,
      ...(record.executionId ? { executionId: record.executionId } : {}), status: record.state });
    if (typeof onCommand === 'function') {
      const observer = Promise.resolve().then(() => onCommand(record)).catch(async error => {
        backgroundErrors.set(record.chatId, error);
        try { await onError(error); } catch { /* Error reporting does not own durable admission. */ }
      });
      commandObservers.set(observer, record.chatId);
      void observer.finally(() => commandObservers.delete(observer));
    }
  }
  function requireCaller(caller) {
    assertCaller(caller);
    if (caller.actor === 'agent') {
      const execution = repository.getExecution(caller.executionId);
      if (!execution && caller.executionActive === true && isExternalExecutionActive?.(caller) === true) return caller;
      const lease = repository.getLease(caller.chatId);
      if (!execution || execution.chatId !== caller.chatId || !ACTIVE.has(execution.status) || !lease
        || lease.executionId !== caller.executionId || caller.executionActive !== true ||
        execution.captured?.cancellationEpoch !== undefined && execution.captured.cancellationEpoch !== repository.getCancellationEpoch(caller.chatId)) {
        failure('caller_not_active', 'The sending execution is no longer active');
      }
      repository.assertFence(caller.chatId, lease);
    }
    return caller;
  }
  async function authorize(caller, chatId, operation) {
    requireCaller(caller); checked(validateChatId(chatId));
    const source = caller.actor === 'agent' ? await context.resolveTarget(caller.chatId) : null;
    const target = await context.resolveTarget(chatId, source && operation === 'read' ? { project: source.project } : {});
    assertCallerCanTarget(caller, { chatId, scope: target.scope, policy: target.policy }, {
      operation, currentPolicy: source?.currentPolicy ?? caller.policy, registry: target.registry,
    });
    return target;
  }
  function enabled(caller, input) {
    if (disposed) failure('capability_unavailable', 'The conversation service is stopping');
    const state = feature();
    const continuation = state?.recoveryEnabled && caller.actor === 'human' && input?.chatId
      && repository.getChat(input.chatId).chatCommandVersion === 1;
    if (!state?.creationEnabled && !continuation && !(state?.recoveryEnabled && caller.actor === 'system' && input?.delivery)) {
      failure('capability_disabled', 'Persistent agent conversation creation is disabled');
    }
  }
  function producer(caller) {
    return hashId('producer', [caller.actor, caller.ingress, caller.executionId ?? caller.chatId, caller.scope.projectId].join(':'));
  }
  function keyFor(input) {
    const key = input.clientRequestId ?? id();
    if (typeof key !== 'string' || !key.trim() || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) {
      failure('invalid_request', 'Invalid client request identity');
    }
    return key;
  }
  function provenance(caller, commandId, input) {
    if (caller.actor === 'agent') {
      const origin = repository.getExecution(caller.executionId);
      return { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message',
        sourceChatId: caller.chatId, sourceTurnId: caller.executionId, commandId,
        causalRootId: origin?.captured?.causalRootId ?? caller.executionId ?? commandId,
        ...(input.replyToCommandId ? { replyToCommandId: input.replyToCommandId } : {}) };
    }
    if (caller.actor === 'system') {
      if (!input.delivery) failure('policy_denied', 'System input requires an explicit task delivery');
      return { version: 1, actor: 'system', source: 'task_delivery', kind: 'delegation_result',
        commandId, runId: input.delivery.runId, deliveryId: input.delivery.deliveryId,
        causalRootId: input.delivery.causalRootId ?? commandId };
    }
    const source = { renderer: 'composer', device: 'device', cli: 'cli', scheduler: 'scheduler' }[caller.ingress];
    if (!source) failure('caller_denied', 'Human commands require an authenticated user ingress');
    return { version: 1, actor: 'human', source, kind: 'human_message', commandId, causalRootId: commandId };
  }
  async function replay(caller, input, key, intent) {
    const previous = repository.findCommandReceipt(producer(caller), key);
    if (!previous) return null;
    if (previous.captured.requestIntentHash !== intent) failure('idempotency_conflict', 'Request identity was reused with different input');
    await authorize(caller, previous.chatId, 'read');
    return receipt(previous, true);
  }
  function serialized(chatId, work) {
    const before = admissions.get(chatId) ?? Promise.resolve();
    const promise = before.catch(() => {}).then(work);
    admissions.set(chatId, promise);
    promise.finally(() => { if (admissions.get(chatId) === promise) admissions.delete(chatId); }).catch(() => {});
    return promise;
  }
  function queued(chatId) {
    return repository.listCommands({ chatId, states: PENDING, limit: 1000 });
  }
  function schedule(chatId) { void kick(chatId).catch(() => {}); }
  function externalOwner(chatId) {
    if (typeof getExternalOwner !== 'function') return null;
    const owner = getExternalOwner(chatId);
    if (!owner) return null;
    fields(owner, ['ownerId', 'executionId', 'runId']);
    checked(validateChatId(owner.ownerId));
    if (owner.executionId) checked(validateChatId(owner.executionId));
    if (owner.runId) checked(validateChatId(owner.runId));
    return { ...owner };
  }
  function externallyOwned(chatId) { return hasExternalOwner(chatId) || Boolean(externalOwner(chatId)); }
  function disposedDelivery(record) {
    return Boolean(record.captured?.delivery && (repository.getChat(record.chatId).subAgentAutoResumeBlocked === true ||
      record.captured.delivery.cancellationEpoch !== undefined && record.captured.delivery.cancellationEpoch !== repository.getCancellationEpoch(record.chatId)));
  }
  async function selectionFor(target, caller, input) {
    const stored = target.profile?.snapshot?.modelSelection ?? {
      providerId: target.chat.providerId, modelId: target.chat.modelId,
      ...(target.chat.reasoningEffort ? { options: { reasoningEffort: target.chat.reasoningEffort } } : {}),
    };
    const resolved = typeof resolveModelSelection === 'function'
      ? await resolveModelSelection({ target, caller, input, selection: stored })
      : await resolveAgentModelSelection({ parentSelection: stored }, { workspacePath: target.chat.worktreeRoot || target.chat.workspacePath });
    return checked(validateModelSelection(resolved?.selection ?? resolved));
  }
  async function sendCommand(caller, input, legacyCompletion = null) {
    requireCaller(caller);
    const assertLegacyAdmission = () => {
      if (legacyCompletion?.canAdmit && legacyCompletion.canAdmit() !== true) failure('capability_unavailable', 'Legacy completion admission is closing');
    };
    assertLegacyAdmission();
    if (legacyCompletion && (caller.actor !== 'system' || !input?.delivery)) failure('policy_denied', 'Legacy completions require the trusted task delivery ingress');
    fields(input, ['chatId', 'message', 'mode', 'clientRequestId', 'images', 'replyToCommandId', 'delivery']);
    if (input.delivery && caller.actor !== 'system') failure('policy_denied', 'Only task delivery can provide result provenance');
    if (input.delivery) {
      fields(input.delivery, ['runId', 'deliveryId', 'causalRootId', 'causalDepth', 'cancellationEpoch']);
      for (const key of ['runId', 'deliveryId']) checked(validateChatId(input.delivery[key]));
      if (input.delivery.cancellationEpoch !== undefined && (!Number.isSafeInteger(input.delivery.cancellationEpoch) || input.delivery.cancellationEpoch < 0)) failure('invalid_request', 'Invalid completion cancellation epoch');
      if (input.delivery.causalDepth !== undefined && (!Number.isSafeInteger(input.delivery.causalDepth) || input.delivery.causalDepth < 0 || input.delivery.causalDepth > 256)) failure('invalid_request', 'Invalid completion causal depth');
    }
    const mode = input.mode ?? 'auto';
    if (!['auto', 'queue', 'steer'].includes(mode)) failure('invalid_request', 'Unsupported send mode');
    checked(validateChatId(input.chatId));
    const key = keyFor(input), intent = hashChatPayload({ ...input, mode, clientRequestId: key,
      ...(legacyCompletion ? { legacyCompletion: true, retainOnly: legacyCompletion.retainOnly } : {}) });
    return serialized(input.chatId, async () => {
      assertLegacyAdmission();
      const previous = await replay(caller, input, key, intent);
      if (previous) return previous;
      enabled(caller, input);
      let target = await authorize(caller, input.chatId, 'send');
      if (target.chat.agentConversation?.capabilities?.canSend === false) failure('policy_denied', 'This conversation is inspect-only');
      const epoch = repository.getCancellationEpoch(input.chatId);
      if (legacyCompletion && (target.chat.chatCommandVersion !== 1 || mode !== 'queue')) failure('policy_denied', 'Legacy completions require an existing managed conversation and ordered delivery');
      if (legacyCompletion && (active.has(input.chatId) || externallyOwned(input.chatId) || repository.getLease(input.chatId)?.state === 'active' || firstRunnable(input.chatId))) failure('ownership_conflict', 'Legacy completion is deferred until the conversation is idle');
      if (!legacyCompletion && input.delivery?.cancellationEpoch !== undefined && input.delivery.cancellationEpoch !== epoch) failure('ownership_conflict', 'The automatic completion subscription was stopped');
      const live = active.get(input.chatId);
      if (mode === 'steer' && (!live || !live.host.supportsSteer || live.controller.signal.aborted)) {
        failure('steer_unsupported', 'This conversation has no active turn that supports steering');
      }
      if (queued(input.chatId).length >= maxPendingCommands) failure('queue_full', 'This conversation has too many pending inputs');
      const modelSelection = mode === 'steer' ? live.command.modelSelection : await selectionFor(target, caller, input);
      const capturedProfile = !target.profile && typeof captureProfile === 'function'
        ? await captureProfile({ target, selection: modelSelection, caller, input }) : null;
      if (capturedProfile) target = { ...target, profile: { ...capturedProfile, chatId: input.chatId } };
      requireCaller(caller);
      assertLegacyAdmission();
      if (!legacyCompletion && epoch !== repository.getCancellationEpoch(input.chatId)) failure('ownership_conflict', 'Input setup was stopped before admission');
      const commandId = hashId('command', producer(caller) + ':' + key);
      const command = checked(validateChatCommand({
        version: 1, commandId, chatId: input.chatId, kind: mode === 'steer' ? 'steer' : 'send',
        requestedAt: now(), provenance: provenance(caller, commandId, input), message: input.message,
        ...(mode === 'steer' ? {} : { mode }), clientRequestId: key,
        ...(input.images ? { images: input.images } : {}), modelSelection,
        ...(target.profile ? { profileReference: { profileId: target.profile.profileId, profileVersion: target.profile.profileVersion } } : {}),
      }));
      const record = repository.atomic(() => {
        assertLegacyAdmission();
        if (legacyCompletion && (repository.getChat(input.chatId).chatCommandVersion !== 1 || active.has(input.chatId) || externallyOwned(input.chatId)
          || repository.getLease(input.chatId)?.state === 'active' || firstRunnable(input.chatId))) failure('ownership_conflict', 'Legacy completion is deferred until the conversation is idle');
        if (!legacyCompletion && input.delivery && (repository.getChat(input.chatId).subAgentAutoResumeBlocked === true
          || input.delivery.cancellationEpoch !== undefined && repository.getCancellationEpoch(input.chatId) !== input.delivery.cancellationEpoch)) {
          failure('ownership_conflict', 'The automatic completion subscription was stopped');
        }
        if (caller.actor === 'human') repository.setAutoResumeBlocked(input.chatId, false);
        if (capturedProfile) repository.saveProfile(input.chatId, capturedProfile);
        const causal = caller.actor === 'system' ? { causalRootId: command.provenance.causalRootId, causalDepth: input.delivery?.causalDepth ?? 0 }
          : admitCausality?.({ caller, command }) ?? { causalRootId: command.provenance.causalRootId, causalDepth: 0 };
        const acceptedCommand = checked(validateChatCommand({ ...command, provenance: { ...command.provenance, causalRootId: causal.causalRootId } }));
        const admitted = repository.admitCommand(acceptedCommand, { producerId: producer(caller), requestKey: key, captured: {
          requestIntentHash: intent, policy: target.policy, scope: target.scope, projectId: target.scope.projectId,
          cancellationEpoch: epoch, ...causal,
          ...(legacyCompletion ? { legacyCompletion: true } : {}),
          ...(input.delivery ? { delivery: input.delivery } : {}),
          ...(target.profile ? { profile: target.profile } : {}),
        } });
        if (legacyCompletion) {
          const message = repository.appendAdmittedResult(admitted.commandId);
          const retainOnly = legacyCompletion.retainOnly || repository.getChat(input.chatId).subAgentAutoResumeBlocked === true
            || epoch !== repository.getCancellationEpoch(input.chatId)
            || input.delivery.cancellationEpoch !== undefined && input.delivery.cancellationEpoch !== repository.getCancellationEpoch(input.chatId);
          return repository.updateCommand(admitted.commandId, { state: retainOnly ? 'settled' : 'queued', messageId: message.messageId,
            ...(retainOnly ? { result: { disposition: 'local_only' } } : {}) });
        }
        return repository.updateCommand(admitted.commandId, {
          state: 'queued', ...(mode === 'steer' ? { executionId: live.execution.executionId } : {}),
        });
      });
      announce(record);
      if (mode !== 'steer' && record.state === 'queued') schedule(input.chatId);
      return receipt(record);
    });
  }
  const send = (caller, input) => sendCommand(caller, input);
  function admitLegacyCompletion(caller, input, options = {}) {
    fields(input, ['chatId', 'message', 'clientRequestId', 'delivery', 'retainOnly']);
    if (options.canAdmit !== undefined && typeof options.canAdmit !== 'function') failure('invalid_request', 'Invalid legacy admission guard');
    if (input.retainOnly !== undefined && typeof input.retainOnly !== 'boolean') failure('invalid_request', 'Invalid legacy completion disposition');
    const { retainOnly = false, ...command } = input;
    return sendCommand(caller, { ...command, mode: 'queue' }, { retainOnly, canAdmit: options.canAdmit });
  }
  async function control(caller, input, kind) {
    requireCaller(caller);
    fields(input, ['chatId', 'targetCommandId', 'expectedRevision', 'message', 'clientRequestId']);
    if (caller.actor !== 'human') failure('policy_denied', 'Queue editing is a human conversation control');
    const key = keyFor(input), intent = hashChatPayload({ ...input, kind, clientRequestId: key });
    return serialized(input.chatId, async () => {
      const previous = await replay(caller, input, key, intent); if (previous) return previous;
      const target = await authorize(caller, input.chatId, 'send');
      const original = repository.getCommand(input.targetCommandId);
      if (!original || original.chatId !== input.chatId) failure('command_not_found', 'Queued input does not belong to this conversation');
      if (original.runId && original.executionId) failure('stale_revision', 'Task input was already consumed by an attempt');
      const live = active.get(input.chatId);
      if (kind === 'push_queued' && live) {
        if (!live.host.supportsSteer || live.controller.signal.aborted) failure('steer_unsupported', 'The active turn does not support steering');
        if (!same(original.effectiveCommand.modelSelection, live.command.modelSelection)) {
          failure('options_unsupported', 'This queued input uses a different captured model; keep it queued or stop and switch');
        }
      }
      const commandId = hashId('command', producer(caller) + ':' + key);
      const command = checked(validateChatCommand({
        version: 1, commandId, chatId: input.chatId, kind, requestedAt: now(),
        provenance: provenance(caller, commandId, {}), clientRequestId: key,
        targetCommandId: input.targetCommandId, expectedRevision: input.expectedRevision,
        ...(kind === 'edit_queued' ? { message: input.message } : {}),
      }));
      const result = repository.atomic(() => {
        const admitted = repository.admitCommand(command, { producerId: producer(caller), requestKey: key,
          captured: { requestIntentHash: intent, projectId: target.scope.projectId } });
        let updated;
        if (kind === 'edit_queued') updated = repository.editQueuedCommand(input.targetCommandId, input);
        else if (kind === 'push_queued') updated = repository.promoteQueuedCommand(input.targetCommandId, {
          expectedRevision: input.expectedRevision, ...(live ? { executionId: live.execution.executionId } : {}),
        });
        else {
          if (!PENDING.includes(original.state) || original.revision !== input.expectedRevision) failure('stale_revision', 'Queued input changed or was consumed');
          updated = repository.updateCommand(input.targetCommandId, { state: 'cancelled', result: { disposition: 'removed', removedByCommandId: commandId } }, { expectedRevision: input.expectedRevision });
        }
        return repository.updateCommand(admitted.commandId, { state: 'settled', result: {
          disposition: kind === 'push_queued' && live ? 'steered' : 'settled',
          targetCommandId: updated.commandId, targetRevision: updated.revision,
        } });
      });
      announce(result);
      if (kind === 'push_queued' && !live) schedule(input.chatId);
      return receipt(result);
    });
  }
  async function stop(caller, input) {
    requireCaller(caller);
    fields(input, ['chatId', 'executionId', 'runId', 'scope', 'clientRequestId', 'expectedLegacyOwnerId']);
    if (input.expectedLegacyOwnerId !== undefined) {
      if (caller.actor !== 'human') failure('policy_denied', 'Only human Stop controls may pin a legacy owner');
      checked(validateChatId(input.expectedLegacyOwnerId));
    }
    const scope = input.scope ?? 'turn', key = keyFor(input);
    const agentsOnly = scope === 'agents', subtree = scope === 'tree' || agentsOnly;
    if (agentsOnly && caller.actor !== 'human') failure('policy_denied', 'Stopping only delegated agents requires an explicit human control');
    const intent = hashChatPayload({ ...input, scope, clientRequestId: key });
    const previous = await replay(caller, input, key, intent);
    if (previous) {
      if (PENDING.includes(previous.state)) await drainControls(input.chatId);
      return receipt(repository.getCommand(previous.commandId), true);
    }
    const target = await authorize(caller, input.chatId, 'stop');
    if (subtree && typeof cancelTree !== 'function') {
      failure('capability_unavailable', 'Stopping an agent subtree requires the task cancellation adapter');
    }
    const commandId = hashId('command', producer(caller) + ':' + key);
    const command = checked(validateChatCommand({
      version: 1, commandId, chatId: input.chatId, kind: 'stop', scope, requestedAt: now(),
      provenance: provenance(caller, commandId, {}), clientRequestId: key,
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    }));
    const current = active.get(input.chatId), external = current ? null : externalOwner(input.chatId);
    const owner = current?.execution ?? external;
    const pinned = (!input.executionId || owner?.executionId === input.executionId)
      && (!input.runId || owner?.runId === input.runId)
      && (input.expectedLegacyOwnerId === undefined || !current && external?.ownerId === input.expectedLegacyOwnerId);
    if (pinned && !agentsOnly && !current && externallyOwned(input.chatId) && (!external || typeof stopExternalOwner !== 'function')) {
      failure('capability_unavailable', 'The active legacy turn cannot be stopped without its bound owner adapter');
    }
    const requested = repository.atomic(() => {
      const cancellationEpoch = repository.getCancellationEpoch(input.chatId) + (pinned ? 1 : 0);
      const admitted = repository.admitCommand(command, { producerId: producer(caller), requestKey: key,
        captured: { requestIntentHash: intent, projectId: target.scope.projectId, cancellationEpoch, stopPinned: pinned,
          ...(input.expectedLegacyOwnerId ? { expectedLegacyOwnerId: input.expectedLegacyOwnerId } : {}),
          ...(external && pinned && !agentsOnly ? { externalOwner: external } : {}) } });
      if (pinned) {
        repository.advanceCancellationEpoch(input.chatId);
        if (!agentsOnly) repository.holdQueuedCommands(input.chatId, { throughPosition: admitted.position });
        if (current && !agentsOnly) {
          repository.requeueUnconsumedSteers(input.chatId, current.execution.executionId);
          repository.updateExecution(current.execution.executionId, { status: 'stopping' }, { fence: current.fence });
        }
      }
      return repository.updateCommand(admitted.commandId, { state: pinned && (subtree || external) ? 'queued' : 'settled', held: false, result: {
        disposition: current && pinned && !agentsOnly ? 'stopping' : 'settled', stopRequested: Boolean(current && pinned && !agentsOnly),
        executionId: current && pinned && !agentsOnly ? current.execution.executionId : null,
      } });
    });
    if (pinned && current && !agentsOnly) current.controller.abort(new ChatContractError('ownership_conflict', 'Conversation stopped'));
    announce(requested);
    if (pinned && (subtree || external)) await drainControls(input.chatId);
    return receipt(repository.getCommand(commandId));
  }
  async function applyControls(chatId) {
    const controls = queued(chatId).filter((record) => !record.held && record.effectiveCommand.kind === 'stop' && record.captured.stopPinned);
    for (const record of controls) {
      let result = { ...record.result };
      try {
        if (record.captured.externalOwner && !result.externalStopDispatched) {
          if (typeof stopExternalOwner !== 'function') return false;
          const response = await stopExternalOwner({ chatId, commandId: record.commandId, owner: record.captured.externalOwner,
            requestedAt: record.command.requestedAt });
          if (!response || typeof response.stopRequested !== 'boolean') failure('internal_error', 'Legacy stop adapter did not confirm its bound owner');
          result = { ...result, externalStopDispatched: true, stopRequested: response.stopRequested };
          repository.updateCommand(record.commandId, { result });
        }
        if (['tree', 'agents'].includes(record.effectiveCommand.scope) && !result.subtreeStopDispatched) {
          if (typeof cancelTree !== 'function') return false;
          await cancelTree({ chatId, commandId: record.commandId, cancellationEpoch: record.captured.cancellationEpoch,
            throughPosition: record.position, record });
          result.subtreeStopDispatched = true;
        }
      } catch (error) {
        announce(repository.updateCommand(record.commandId, { state: 'queued', error: publicError(error) }));
        return false;
      }
      announce(repository.updateCommand(record.commandId, { state: 'settled', result: {
        ...result, disposition: 'settled',
      } }));
    }
    return true;
  }
  function drainControls(chatId) {
    const current = controlDrains.get(chatId); if (current) return current;
    const promise = applyControls(chatId);
    controlDrains.set(chatId, promise);
    promise.finally(() => { if (controlDrains.get(chatId) === promise) controlDrains.delete(chatId); }).catch(() => {});
    return promise;
  }
  function consumeSteers(executionId, fence) {
    const entry = [...active.values()].find((value) => value.execution.executionId === executionId);
    if (!entry || entry.controller.signal.aborted) return null;
    const updates = [];
    const consumed = repository.atomic(() => {
      repository.assertFence(entry.command.chatId, fence);
      if (!same({ executionId: fence.executionId, ownerId: fence.ownerId, epoch: fence.epoch },
        { executionId: entry.fence.executionId, ownerId: entry.fence.ownerId, epoch: entry.fence.epoch })) {
        failure('ownership_conflict', 'Steering belongs to another execution');
      }
      const items = queued(entry.command.chatId).filter((row) => !row.held && row.executionId === executionId && row.effectiveCommand.kind === 'steer');
      const messages = [], rowIds = [];
      for (const record of items) {
        const command = record.effectiveCommand;
        const messageId = inputMessageId(command.commandId);
        const prior = repository.readMessageByIdentity(command.chatId, messageId)?.message;
        const createdAt = prior ? prior.createdAt : command.requestedAt;
        const message = { role: 'user', content: command.message, commandId: command.commandId,
          messageId, provenance: command.provenance, steer: true, ...(typeof createdAt === 'number' ? { createdAt } : {}) };
        const appended = repository.appendMessage(command.chatId, message, { fence, messageId, commandId: command.commandId });
        const updated = repository.updateCommand(command.commandId, { state: 'settled', messageId, result: { disposition: 'steered', executionId } });
        updates.push(updated); messages.push(message); rowIds.push(appended.rowId);
      }
      return { messages, rowIds };
    });
    for (const updated of updates) announce(updated);
    return consumed.messages.length ? consumed : null;
  }
  async function chooseHost(record, target, execution) {
    const required = execution?.result?.failure?.requiredCapabilities ?? record.captured.requiredCapabilities ?? [];
    for (const host of hosts.values()) {
      if (required.some((name) => !(host.capabilities ?? []).includes(name))) continue;
      if (typeof host.canRun === 'function' && !await host.canRun({ command: record.effectiveCommand, target, execution })) continue;
      return host;
    }
    return null;
  }
  function firstRunnable(chatId) {
    return repository.listCommands({ chatId, states: [...PENDING, 'running'], limit: 1000 })
      .find(record => !record.held && record.effectiveCommand.kind === 'send');
  }
  async function runExecution(entry) {
    const { command, execution, fence, host, controller } = entry;
    const chatId = command.chatId, executionId = execution.executionId;
    let result;
    try {
      try {
        if (!controller.signal.aborted) repository.markExecutionActivated(executionId, { fence });
        result = controller.signal.aborted ? { outcome: 'crashed', error: 'Conversation stopped' }
          : await host.execute({ command, execution, fence, signal: controller.signal,
            takeSteers: () => consumeSteers(executionId, fence) });
        if (!result || !['pass', 'fail', 'blocked', 'no_report', 'crashed', 'timeout'].includes(result.outcome)) {
          result = { outcome: 'crashed', error: 'Execution host returned an invalid turn result' };
        }
      } catch (error) {
        result = { outcome: 'crashed', error: error instanceof ChatContractError ? error.message : 'Conversation execution failed',
          ...(error?.code === 'capability_unavailable' ? { failure: { waitingForHost: true, code: error.code } } : {}) };
      }
      if (controller.signal.aborted) result = { ...result, failure: { ...result.failure, stopped: true } };
      const unresolved = repository.listUnsettledToolInvocations(executionId);
      const recovery = unresolved.length > 0 || result?.failure?.recoveryRequired === true
        || repository.getExecution(executionId)?.status === 'recovery_required';
      if (recovery) result = { ...result, outcome: 'crashed', error: 'A tool effect needs explicit recovery',
        failure: { ...result.failure, recoveryRequired: true } };
      const waiting = !controller.signal.aborted && result?.failure?.waitingForHost === true;
      const status = recovery ? 'recovery_required' : waiting ? 'waiting_for_host'
        : controller.signal.aborted ? 'stopped' : ['crashed', 'timeout'].includes(result?.outcome) ? 'failed' : 'completed';
      const updated = repository.atomic(() => {
        repository.updateExecution(executionId, { status, result }, { fence });
        repository.requeueUnconsumedSteers(chatId, executionId, { held: controller.signal.aborted || recovery });
        const state = entry.taskOwned ? waiting ? 'waiting_for_host' : 'queued'
          : waiting ? 'waiting_for_host' : status === 'completed' ? 'settled' : status === 'stopped' ? 'cancelled' : 'failed';
        const updated = repository.updateCommand(command.commandId, { state,
          held: entry.taskOwned && (controller.signal.aborted || recovery),
          result: entry.taskOwned ? { ...result, disposition: 'task_pending', executionId } : result,
          error: recovery ? { code: 'recovery_required', message: 'A tool effect needs explicit recovery', retryable: false } : null });
        if (!recovery) repository.releaseLease(chatId, fence);
        return updated;
      });
      announce(updated, 'execution');
      return result;
    } finally {
      clearInterval(entry.renewal);
      entry.externalSignal?.removeEventListener('abort', entry.abort);
      controller.signal.removeEventListener('abort', entry.activateIfStopped);
      if (active.get(chatId) === entry) active.delete(chatId);
    }
  }
  async function reserveExecution(record, target, { task, signal } = {}) {
    const capturedScope = record.captured?.scope;
    const capturedProject = record.captured?.projectId ?? repository.getChatProjectId(record.chatId);
    if (capturedProject && capturedProject !== target.scope.projectId || capturedScope &&
      (capturedScope.workspaceId !== target.scope.workspaceId || capturedScope.canonicalKey !== target.scope.canonicalKey)) {
      const held = repository.atomic(() => {
        const fresh = repository.getCommand(record.commandId);
        return fresh && PENDING.includes(fresh.state) ? repository.updateCommand(record.commandId, { state: 'waiting_for_host', held: true,
          error: { code: 'workspace_denied', message: 'The original conversation checkout changed. Restore its registered checkout before resuming this input.', retryable: true } }) : null;
      });
      if (held) announce(held);
      return { deferred: true, reason: 'workspace_changed' };
    }
    const chatId = record.chatId;
    const deferred = reason => ({ deferred: true, reason });
    if (disposed || signal?.aborted) return deferred('stopping');
    const current = active.get(chatId);
    if (current) {
      if (task && current.command.commandId === record.commandId && current.execution.runId === task.runId
        && current.execution.attemptId === task.attemptId) return current.handle;
      return deferred('owned');
    }
    if (externallyOwned(chatId) || repository.getLease(chatId)?.state === 'active') return deferred('owned');
    const previous = record.executionId ? repository.getExecution(record.executionId) : null;
    const host = await chooseHost(record, target, previous);
    if (!host) return deferred('waiting_for_host');
    const priorAttempt = task ? repository.findAttemptExecution(task.runId, task.attemptId) : null;
    const executionId = task ? priorAttempt?.result?.failure?.unstartedReservation === true
      ? hashId('execution', record.commandId + ':' + task.runId + ':' + task.attemptId + ':' + id())
      : priorAttempt?.executionId ?? hashId('execution', record.commandId + ':' + task.runId + ':' + task.attemptId)
      : previous && !['completed', 'failed', 'stopped', 'recovery_required'].includes(previous.status)
        ? previous.executionId : hashId('execution', record.commandId + ':' + id());
    const existing = repository.getExecution(executionId);
    if (existing && ['completed', 'failed', 'stopped', 'recovery_required'].includes(existing.status)) return deferred('attempt_settled');
    const policy = record.captured.policy
      ? intersectChatPolicies(createChatPolicy(record.captured.policy), target.currentPolicy) : target.policy;
    if (!policy.capabilities.includes('execution.host')) return deferred('capability_unavailable');
    let fence, execution, accepted;
    repository.atomic(() => {
      const fresh = repository.getCommand(record.commandId);
      if (disposed || signal?.aborted) { accepted = deferred('stopping'); return; }
      if (active.has(chatId) || externallyOwned(chatId) || repository.getLease(chatId)?.state === 'active') { accepted = deferred('owned'); return; }
      if (hosts.get(host.id) !== host) { accepted = deferred('waiting_for_host'); return; }
      if (!fresh || fresh.revision !== record.revision || firstRunnable(chatId)?.commandId !== record.commandId) { accepted = deferred('command_changed'); return; }
      if (disposedDelivery(fresh)) {
        repository.updateCommand(fresh.commandId, { state: 'cancelled', result: { disposition: 'subscription_disposed' } });
        accepted = deferred('command_changed'); return;
      }
      if (task && fresh.runId && fresh.runId !== task.runId) failure('ownership_conflict', 'Command belongs to another task');
      repository.ensureManagedChat(chatId, { projectId: target.scope.projectId });
      if (record.effectiveCommand.provenance.actor === 'human') repository.setAutoResumeBlocked(chatId, false);
      execution = existing ?? repository.createExecution({ chatId, executionId, commandId: record.commandId, kind: host.kind,
        ...(task ? task : {}), captured: {
          ...record.captured, policy, scope: record.captured.scope ?? target.scope, projectId: record.captured.projectId ?? target.scope.projectId,
          cancellationEpoch: repository.getCancellationEpoch(chatId), modelSelection: record.effectiveCommand.modelSelection,
          profileReference: record.effectiveCommand.profileReference, hostId: host.id,
          ...(task ? { taskOwned: true, completionPolicy: record.captured.completionPolicy ?? { version: 1, kind: 'local_only' } } : {}),
        } });
      fence = repository.claimExecution({ chatId, executionId, ownerId: host.id, kind: host.kind, leaseMs });
      execution = repository.getExecution(executionId);
      accepted = repository.updateCommand(record.commandId, { state: 'running', executionId,
        ...(task ? { runId: task.runId } : {}), messageId: inputMessageId(record.commandId), error: null });
    });
    if (accepted?.deferred) return accepted;
    const controller = new AbortController();
    let resolveFinished, rejectFinished;
    const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
    finished.catch(() => {});
    const entry = { command: record.effectiveCommand, execution, fence, host, controller, taskOwned: Boolean(task),
      externalSignal: signal, activated: false, finished };
    const activate = () => {
      if (!entry.activated) {
        entry.activated = true;
        void runExecution(entry).then(resolveFinished, rejectFinished);
      }
      return finished;
    };
    entry.activateIfStopped = () => { if (!entry.activated) void activate(); };
    entry.abort = () => controller.abort(signal?.reason ?? new ChatContractError('ownership_conflict', 'Conversation stopped'));
    entry.handle = { chatId, commandId: record.commandId, ...(task ? task : {}), executionId,
      activate, stop: () => controller.abort(new ChatContractError('ownership_conflict', 'Conversation stopped')), finished };
    active.set(chatId, entry);
    controller.signal.addEventListener('abort', entry.activateIfStopped, { once: true });
    signal?.addEventListener('abort', entry.abort, { once: true });
    entry.renewal = setInterval(() => {
      try { repository.renewLease(chatId, fence, leaseMs); }
      catch (error) { controller.abort(error); }
    }, Math.max(10, Math.floor(leaseMs / 3)));
    entry.renewal.unref?.();
    announce(accepted, 'execution');
    if (signal?.aborted) entry.abort();
    return entry.handle;
  }
  async function startAdmittedChildTask(input) {
    fields(input, ['commandId', 'runId', 'attemptId', 'signal']);
    for (const key of ['commandId', 'runId', 'attemptId']) checked(validateChatId(input[key]));
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) failure('invalid_request', 'Invalid task cancellation signal');
    const record = repository.getCommand(input.commandId);
    if (!record) failure('command_not_found', 'Task command does not exist');
    if (['settled', 'failed', 'cancelled'].includes(record.state) || record.held) return { deferred: true, reason: 'command_settled_or_held' };
    const target = await context.resolveTarget(record.chatId);
    if (!target.chat.agentConversation || target.chat.agentConversation.capabilities?.canSend === false) {
      failure('policy_denied', 'Only a persistent delegated conversation may reserve a task attempt');
    }
    if (record.runId && record.runId !== input.runId) failure('ownership_conflict', 'Command belongs to another task');
    return reserveExecution(record, target, { task: { runId: input.runId, attemptId: input.attemptId }, signal: input.signal });
  }
  function settleChildTask({ commandId, runId, result, error } = {}) {
    let alreadyConsumed = false;
    checked(validateChatId(commandId)); checked(validateChatId(runId));
    const terminal = checked(validateChatTaskResult(result));
    const issue = error === undefined ? null : checked(validateChatError(error));
    const settled = repository.atomic(() => {
      const record = repository.getCommand(commandId);
      if (!record) failure('command_not_found', 'Task command does not exist');
      const relation = repository.getRelation(record.chatId);
      if (!relation || record.runId !== runId || terminal.runId !== runId || terminal.childChatId !== record.chatId
        || terminal.journalOwnerId !== relation.journalOwnerId) failure('ownership_conflict', 'Task publication does not match the admitted child command');
      if (['settled', 'cancelled'].includes(record.state) && ['steered', 'removed'].includes(record.result?.disposition)) { alreadyConsumed = true; return record; }
      if (!['settled', 'failed', 'cancelled'].includes(record.state) && (active.has(record.chatId)
        || repository.getLease(record.chatId)?.state === 'active')) failure('ownership_conflict', 'Task execution must settle before terminal publication');
      if (terminal.executionId) {
        const execution = repository.getExecution(terminal.executionId);
        if (!execution || execution.chatId !== record.chatId || execution.runId !== runId
          || (terminal.attemptId && execution.attemptId !== terminal.attemptId)) failure('ownership_conflict', 'Task result references another execution');
      }
      return repository.updateCommand(commandId, { state: terminal.status === 'completed' ? 'settled'
        : terminal.status === 'cancelled' ? 'cancelled' : 'failed', result: terminal, error: issue, held: false });
    });
    if (!alreadyConsumed) { announce(settled, 'execution'); schedule(settled.chatId); }
    return receipt(settled);
  }
  async function pump(chatId) {
    while (!disposed) {
      if (!await drainControls(chatId) || active.has(chatId) || externallyOwned(chatId)) return;
      const pending = firstRunnable(chatId);
      if (!pending) return;
      let target;
      try { target = await context.resolveTarget(chatId); }
      catch (error) { announce(repository.updateCommand(pending.commandId, { state: 'failed', error: publicError(error) })); continue; }
      if (disposedDelivery(pending)) {
        announce(repository.updateCommand(pending.commandId, { state: 'cancelled', result: { disposition: 'subscription_disposed' } })); continue;
      }
      if (target.chat.agentConversation) {
        if (typeof admitChildTask !== 'function') {
          if (pending.state !== 'waiting_for_host') announce(repository.updateCommand(pending.commandId, { state: 'waiting_for_host',
            error: { code: 'capability_unavailable', message: 'The agent task scheduler is unavailable', retryable: true } }));
        } else {
          const task = await admitChildTask({ record: pending, target });
          if (task?.runId) {
            const current = repository.getCommand(pending.commandId);
            if (current.runId && current.runId !== task.runId) failure('ownership_conflict', 'Command already belongs to another task');
            if (!current.runId) repository.updateCommand(current.commandId, { runId: task.runId });
          }
        }
        return;
      }
      const reservation = await reserveExecution(pending, target);
      if (reservation.deferred) {
        if (reservation.reason === 'command_changed') continue;
        if (reservation.reason === 'workspace_changed') return;
        if (['waiting_for_host', 'capability_unavailable'].includes(reservation.reason) && pending.state !== 'waiting_for_host') {
          announce(repository.updateCommand(pending.commandId, { state: 'waiting_for_host',
            ...(reservation.reason === 'capability_unavailable' ? { error: { code: 'capability_unavailable',
              message: 'This execution configuration is currently disabled', retryable: true } } : {}) }));
        }
        return;
      }
      const result = await reservation.activate();
      if (result.failure?.waitingForHost || result.failure?.recoveryRequired) return;
    }
  }
  function kick(chatId) {
    checked(validateChatId(chatId));
    const current = pumps.get(chatId);
    if (current) { requestedPumps.add(chatId); return current; }
    const promise = Promise.resolve().then(async () => {
      do { requestedPumps.delete(chatId); await pump(chatId); }
      while (!disposed && requestedPumps.delete(chatId));
    }).finally(() => { if (pumps.get(chatId) === promise) pumps.delete(chatId); });
    pumps.set(chatId, promise); backgroundErrors.delete(chatId);
    promise.catch((error) => {
      backgroundErrors.set(chatId, error);
      emit({ type: 'execution_error', chatId, status: 'recovery_required' });
      onError(error);
    }).catch(() => {});
    return promise;
  }
  const service = {
    send, admitLegacyCompletion, stop, startAdmittedChildTask, settleChildTask,
    stopExecution(executionId) {
      checked(validateChatId(executionId));
      const entry = [...active.values()].find(value => value.execution.executionId === executionId);
      if (!entry) return false;
      entry.controller.abort(new ChatContractError('ownership_conflict', 'Conversation stopped'));
      return true;
    },
    waitExecution(executionId) {
      checked(validateChatId(executionId));
      const entry = [...active.values()].find(value => value.execution.executionId === executionId);
      return entry?.finished ?? Promise.resolve(repository.getExecution(executionId)?.result);
    },
    editQueued: (caller, input) => control(caller, input, 'edit_queued'),
    removeQueued: (caller, input) => control(caller, input, 'remove_queued'),
    pushQueued: (caller, input) => control(caller, input, 'push_queued'),
    async readCommand(caller, commandId) {
      const record = repository.getCommand(commandId); if (!record) failure('command_not_found', 'Command does not exist');
      await authorize(caller, record.chatId, 'read');
      return { ...receipt(record), command: record.command, effectiveCommand: record.effectiveCommand,
        ...(['settled', 'failed', 'cancelled'].includes(record.state) ? {
          assistantFinal: record.executionId ? repository.readExecutionFinalAssistant(record.executionId) : '',
        } : {}) };
    },
    async status(caller, chatId) {
      await authorize(caller, chatId, 'read');
      const source = repository.getChat(chatId);
      const execution = active.has(chatId) ? repository.getExecution(active.get(chatId).execution.executionId)
        : repository.getLatestExecution(chatId);
      return { chat: { id: source.id, name: source.name, workspacePath: source.workspacePath,
        providerId: source.providerId, modelId: source.modelId, modeId: source.modeId,
        messageCount: source.messageCount, lastMessageAt: source.lastMessageAt,
        ...(source.agentConversation ? { agentConversation: source.agentConversation } : {}),
        ...(source.chatCommandVersion ? { chatCommandVersion: source.chatCommandVersion } : {}) },
        execution: execution ? { executionId: execution.executionId, commandId: execution.commandId, runId: execution.runId,
          status: execution.status, createdAt: execution.createdAt, updatedAt: execution.updatedAt, settledAt: execution.settledAt } : null,
        pending: queued(chatId).map((record) => ({ ...receipt(record), kind: record.effectiveCommand.kind,
          preview: record.effectiveCommand.message?.slice(0, 240) ?? '' })) };
    },
    registerHost(host) {
      if (disposed || !host || !['server', 'renderer', 'cli', 'scheduler'].includes(host.kind) || typeof host.execute !== 'function') {
        throw new TypeError('A server-registered execution host is required');
      }
      checked(validateChatId(host.id));
      if (hosts.has(host.id)) failure('ownership_conflict', 'Execution host is already registered');
      hosts.set(host.id, host);
      for (const chatId of new Set(repository.listCommands({ states: PENDING, limit: 1000 }).map((record) => record.chatId))) schedule(chatId);
      return () => { if (hosts.get(host.id) === host) hosts.delete(host.id); };
    },
    kick, consumeSteers, drainControls,
    canResumeQuestionExecution,
    ownsExecution(executionId) { return [...active.values()].some(entry => entry.execution.executionId === executionId); },
    async idle(chatId) {
      while (true) {
        const pending = (chatId ? [pumps.get(chatId), admissions.get(chatId), controlDrains.get(chatId)]
          : [...pumps.values(), ...admissions.values(), ...controlDrains.values()]).filter(Boolean);
        for (const [observer, owner] of commandObservers) if (!chatId || owner === chatId) pending.push(observer);
        if (!pending.length) break;
        await Promise.all(pending);
      }
      const errors = chatId ? [backgroundErrors.get(chatId)] : [...backgroundErrors.values()];
      if (errors.find(Boolean)) throw errors.find(Boolean);
    },
    async recoverExecutions(verifyQuiescence) {
      if (typeof verifyQuiescence !== 'function') throw new TypeError('Runtime quiescence verifier is required');
      const recovered = [];
      for (const execution of repository.listExecutions({ statuses: [...ACTIVE, 'queued', 'waiting_for_host', 'stopping', 'recovery_required'], limit: 1000 })) {
        if (active.has(execution.chatId)) continue;
        const lease = repository.getLease(execution.chatId);
        if (!lease || lease.executionId !== execution.executionId || lease.state !== 'active') continue;
        const evidence = await verifyQuiescence(execution, lease);
        if (!evidence?.verified) continue;
        const result = repository.recoverExecution(execution.executionId, { fence: lease, quiescence: evidence });
        recovered.push(result);
        if (execution.commandId) {
          const command = repository.getCommand(execution.commandId);
          if (command && !['settled', 'failed', 'cancelled'].includes(command.state)) {
            const taskOwned = Boolean(execution.captured?.taskOwned || execution.runId && repository.getRelation(execution.chatId));
            announce(repository.updateCommand(command.commandId, { state: taskOwned ? 'queued' : 'failed',
              ...(taskOwned ? { held: result.status === 'recovery_required' } : {}), error: {
              code: result.status === 'recovery_required' ? 'recovery_required' : 'capability_unavailable',
              message: result.status === 'recovery_required' ? 'A tool effect needs explicit recovery' : 'Execution was interrupted; its committed conversation is preserved',
              retryable: false,
            } }));
          }
        }
      }
      return recovered;
    },
    notifyExecution(event) {
      const entry = active.get(event.chatId);
      if (entry?.execution.executionId === event.executionId) emit({ type: 'execution', chatId: event.chatId, executionId: event.executionId, status: event.status });
    },
    async dispose() {
      disposed = true;
      for (const entry of active.values()) entry.controller.abort(new Error('Conversation host is shutting down'));
      while (true) {
        const pending = [...pumps.values(), ...admissions.values(), ...controlDrains.values(), ...commandObservers.keys(),
          ...[...active.values()].map(entry => entry.finished)];
        if (!pending.length) break;
        await Promise.allSettled(pending);
      }
      hosts.clear();
    },
  };
  return service;
}
