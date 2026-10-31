import { createHash } from 'node:crypto';
import { ChatContractError, validateModelSelection } from './contracts.js';
import { assertExecutionCaller, assertCallerCanTarget, projectChatPolicyToWorkspace } from './caller.js';
import { assertChatPolicy, createChatPolicy, intersectChatPolicies } from './policy.js';
import { hashChatPayload } from './repository.js';
import { getAgentConversationsFeature } from './feature.js';
import { resolveAgentModelSelection } from './model-selection.js';
import { captureChatProfile } from './preparation.js';
import { loadSubAgentFile } from '../sub-agents/config.js';
import { makeEvent } from '../sub-agents/events.js';
import { createChatOutbox } from './outbox.js';

const stableId = (prefix, value) => `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 48)}`;
const fail = (code, message) => { throw new ChatContractError(code, message); };
const keys = new Set(['type', 'task', 'title', 'target', 'workspace_strategy', 'workspace_id', 'client_request_id', 'wait', 'providerId', 'modelId', 'category', 'board_task_id']);
const disabledChildTools = new Set(['spawn_sub_agent', 'cancel_sub_agent', 'list_sub_agents', 'get_sub_agent_status']);

function normalize(input, toolCallId) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.has(key))) fail('invalid_request', 'Unsupported delegation input');
  if (typeof input.type !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.type)) fail('invalid_request', 'A known agent type is required');
  if (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 120000) fail('invalid_request', 'A bounded task is required');
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 240)) fail('invalid_request', 'A delegation title must be at most 240 characters');
  if (input.wait !== undefined && typeof input.wait !== 'boolean') fail('invalid_request', 'wait must be a boolean');
  if (input.wait === true && (typeof toolCallId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(toolCallId))) fail('invalid_request', 'Inline delegation waits require a bound tool call');
  const requestKey = input.client_request_id ?? toolCallId;
  if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 256 || /[\u0000-\u001f\u007f]/.test(requestKey)) fail('invalid_request', 'A stable delegation request identity is required');
  let strategy = input.workspace_strategy ?? 'shared', workspaceId = input.workspace_id;
  if (strategy && typeof strategy === 'object' && !Array.isArray(strategy)) {
    if (Object.keys(strategy).some(key => !['kind', 'workspaceId'].includes(key))) fail('invalid_request', 'Unsupported checkout binding');
    workspaceId ??= strategy.workspaceId; strategy = strategy.kind;
  }
  if (!['shared', 'new_worktree', 'existing_worktree'].includes(strategy) ||
      (strategy === 'existing_worktree' ? typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(workspaceId) : workspaceId !== undefined)) fail('invalid_request', 'Choose a known checkout strategy and registered checkout identity');
  let target = input.target;
  if (input.providerId !== undefined || input.modelId !== undefined) {
    const legacy = validateModelSelection({ providerId: input.providerId, modelId: input.modelId });
    if (!legacy.ok) fail(legacy.error.code, legacy.error.message);
    if (target && hashChatPayload(target) !== hashChatPayload(legacy.value)) fail('invalid_request', 'Conflicting explicit model targets');
    target ??= legacy.value;
  }
  if (target !== undefined) {
    const parsed = validateModelSelection(target);
    if (!parsed.ok) fail(parsed.error.code, parsed.error.message);
    target = parsed.value;
  }
  return { type: input.type, task: input.task.trim(), title: input.title?.trim() ?? input.task.trim().slice(0, 120),
    ...(target ? { target } : {}), strategy: { kind: strategy, ...(workspaceId ? { workspaceId } : {}) }, requestKey, wait: input.wait === true,
    ...(typeof input.category === 'string' ? { category: input.category.slice(0, 160) } : {}),
    ...(typeof input.board_task_id === 'string' ? { boardTaskId: input.board_task_id.slice(0, 160) } : {}) };
}

/** Durable spawn and assignment registration; all actual capacity comes from the existing graph. */
export function createChatDelegation({ repository, context, service, getEngine, validateSourceCaller,
  feature = getAgentConversationsFeature, loadConfig = loadSubAgentFile, captureProfile = captureChatProfile,
  resolveModelSelection = resolveAgentModelSelection, resolveWorkspace, getSourceModelSelection, inheritCausality, now = Date.now, onChange, onTerminal, cancelTree } = {}) {
  if (!repository || !context || !service || typeof getEngine !== 'function' || typeof validateSourceCaller !== 'function') throw new TypeError('Delegation requires its trusted runtime, task graph and source validator');
  const owners = new Set();
  const appendJournal = async record => {
    const { journalOwnerId, event } = record.payload;
    const engine = await getEngine(journalOwnerId);
    await engine.append([event], { idempotencyKey: record.outboxId });
    owners.add(journalOwnerId);
  };
  const outbox = createChatOutbox({ repository, handlers: {
    'agent.journal.request': appendJournal,
    'agent.journal.cancel': appendJournal,
  } });
  const changed = chatId => { try { onChange?.(chatId); } catch {} };
  function assertSource(caller, epoch) {
    assertExecutionCaller(caller);
    if (validateSourceCaller(caller) !== true || repository.getCancellationEpoch(caller.chatId) !== epoch) fail('caller_not_active', 'The delegating execution is no longer active');
  }
  function eventFor(record, target, relation, runId) {
    const command = record.effectiveCommand;
    const profile = command.profileReference ? repository.getProfile(command.profileReference.profileId, command.profileReference.profileVersion) : target.profile;
    if (!profile) fail('capability_unavailable', 'The saved agent profile is unavailable');
    const completionPolicy = record.captured?.completionPolicy ?? { version: 1, kind: 'local_only' };
    return makeEvent('run.requested', {
      runId, agentType: target.chat.agentTypeId ?? profile.snapshot.typeId,
      task: command.message, parentChatId: relation.journalOwnerId, cwd: target.scope.canonicalKey,
      requestedAt: command.requestedAt, childChatId: command.chatId, journalOwnerId: relation.journalOwnerId,
      commandId: command.commandId, executionKind: 'chat', profileReference: { profileId: profile.profileId, profileVersion: profile.profileVersion },
      policy: record.captured?.policy ?? profile.snapshot.policy,
      model: { providerId: command.modelSelection?.providerId ?? target.chat.providerId, id: command.modelSelection?.modelId ?? target.chat.modelId },
      ...(command.modelSelection?.options !== undefined ? { modelOptions: command.modelSelection.options } : {}),
      completionPolicy, ...(record.captured?.modelSource ? { modelSource: record.captured.modelSource } : {}),
      ...(record.captured?.parentTurnId ? { parentTurnId: record.captured.parentTurnId } : {}),
      ...(record.captured?.parentToolCallId ? { parentToolCallId: record.captured.parentToolCallId } : {}),
    });
  }
  async function flush() {
    const result = await outbox.drain({ limit: 1000 });
    const ready = [...owners]; owners.clear();
    for (const owner of ready) await (await getEngine(owner)).tick();
    return result;
  }
  function receipt(record, replayed) {
    const relation = repository.getRelation(record.chatId);
    return { runId: record.runId ?? record.captured?.runId, childChatId: record.chatId, commandId: record.commandId,
      executionId: record.executionId, status: record.state === 'accepted' ? 'queued' : record.state,
      link: `#/app/code/chat?chatId=${encodeURIComponent(record.chatId)}`, modelSelection: record.effectiveCommand.modelSelection,
      modelSource: record.captured?.modelSource, completionPolicy: record.captured?.completionPolicy,
      journalOwnerId: relation?.journalOwnerId, replayed };
  }
  const delegation = {
    async spawn(caller, input, { toolCallId, signal } = {}) {
      assertExecutionCaller(caller);
      const epoch = repository.getCancellationEpoch(caller.chatId);
      const assertLive = () => { signal?.throwIfAborted(); assertSource(caller, epoch); };
      assertLive();
      if (feature().creationEnabled !== true) fail('capability_disabled', 'Persistent agent conversations are not enabled');
      const intent = normalize(input, toolCallId);
      const producerId = stableId('spawn', [caller.chatId, caller.executionId]);
      const identity = [producerId, intent.requestKey];
      const childChatId = stableId('agent', identity), runId = stableId('task', identity), commandId = stableId('assignment', identity);
      const allocationId = stableId('checkout', identity);
      const profileReference = { profileId: stableId('profile', identity), profileVersion: 1 };
      const spawnIntentHash = hashChatPayload({ ...intent, sourceChatId: caller.chatId, sourceExecutionId: caller.executionId, cancellationEpoch: epoch });
      const previous = repository.findCommandReceipt(producerId, intent.requestKey);
      if (previous) {
        if (previous.captured?.spawnIntentHash !== spawnIntentHash) fail('idempotency_conflict', 'Delegation request identity was reused with different work');
        await flush(); return receipt(repository.getCommand(previous.commandId), true);
      }
      const target = await context.resolveTarget(caller.chatId);
      assertLive();
      let sourcePolicy = intersectChatPolicies(caller.policy, target.policy);
      if (!sourcePolicy.capabilities.includes('agent.spawn')) fail('policy_denied', 'This agent cannot delegate work');
      const config = await loadConfig(); assertLive();
      const type = config.types?.[intent.type];
      if (config.enabled === false || !type || type.enabled === false) fail('capability_unavailable', 'This agent type is disabled or unavailable');
      if (intent.strategy.kind !== 'shared' && typeof resolveWorkspace !== 'function') fail('capability_unavailable', 'This checkout strategy is not available on the current host');
      const parentSelection = getSourceModelSelection ? await getSourceModelSelection(caller, target)
        : repository.getExecution(caller.executionId)?.captured?.modelSelection ?? target.profile?.snapshot?.modelSelection ??
          { providerId: target.chat.providerId, modelId: target.chat.modelId,
            ...(target.chat.modelOptions ? { options: target.chat.modelOptions } : {}) };
      assertLive();
      const model = await resolveModelSelection({ ...(intent.target ? { target: intent.target } : {}), typeConfig: type,
        defaultModel: config.defaultModel, parentSelection }, { workspacePath: target.scope.canonicalKey });
      assertLive();
      const workspace = resolveWorkspace ? await resolveWorkspace({ caller, target, strategy: intent.strategy, allocationId, childChatId, signal })
        : { workspacePath: target.scope.canonicalKey, scope: target.scope, registry: target.registry };
      assertLive();
      if (!workspace?.scope || !workspace.registry || (workspace.worktreeRoot || workspace.workspacePath) !== workspace.scope.canonicalKey) fail('workspace_denied', 'A verified child checkout is required');
      sourcePolicy = projectChatPolicyToWorkspace(sourcePolicy, workspace.scope, workspace.registry);
      const shell = { id: childChatId, name: intent.title, workspacePath: workspace.workspacePath,
        ...(workspace.worktreeRoot ? { worktreeRoot: workspace.worktreeRoot } : {}),
        ...(workspace.binding ? { gitBranch: workspace.binding.branch ?? '', chatWorktreeManaged: workspace.binding.strategy === 'new_worktree' } : {}),
        modeId: sourcePolicy.modeId, agentTypeId: intent.type, providerId: model.selection.providerId, modelId: model.selection.modelId };
      const snapshot = await captureProfile(shell, workspace.scope, { modelSelection: model.selection, exactModel: model.exactModel, workspaceIds: sourcePolicy.workspaceIds });
      assertLive();
      const currentTarget = await context.resolveTarget(caller.chatId);
      assertLive();
      if (currentTarget.scope.workspaceId !== target.scope.workspaceId) fail('workspace_denied', 'The delegating checkout changed during preparation');
      sourcePolicy = projectChatPolicyToWorkspace(intersectChatPolicies(caller.policy, currentTarget.policy), workspace.scope, currentTarget.registry);
      if (!sourcePolicy.capabilities.includes('agent.spawn')) fail('policy_denied', 'Delegation permission was revoked during preparation');
      const intersection = intersectChatPolicies(sourcePolicy, assertChatPolicy(snapshot.policy));
      const policy = createChatPolicy({ ...intersection,
        toolPermissions: Object.fromEntries(Object.entries(intersection.toolPermissions).map(([name, value]) => [name, disabledChildTools.has(name) ? 'off' : value])),
        capabilities: intersection.capabilities.filter(value => value !== 'agent.spawn') });
      shell.modeId = policy.modeId;
      assertCallerCanTarget(caller, { chatId: childChatId, scope: workspace.scope, policy },
        { operation: 'spawn', currentPolicy: currentTarget.currentPolicy, registry: currentTarget.registry });
      const journalOwnerId = repository.getRelation(caller.chatId)?.journalOwnerId ?? caller.chatId;
      const rootChatId = repository.getRelation(caller.chatId)?.rootChatId ?? caller.chatId;
      const stamp = now();
      const completionPolicy = { version: 1, kind: 'wake_delegator', recipientChatId: caller.chatId,
        subscriptionId: stableId('wake', identity), cancellationEpoch: epoch };
      const causal = inheritCausality?.(caller) ?? { causalRootId: repository.getExecution(caller.executionId)?.captured?.causalRootId ?? caller.executionId, causalDepth: 1 };
      const command = { version: 1, commandId, chatId: childChatId, requestedAt: stamp, kind: 'send', mode: 'auto', message: intent.task,
        modelSelection: model.selection, profileReference, provenance: { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message',
          sourceChatId: caller.chatId, sourceTurnId: caller.executionId, commandId, runId, causalRootId: causal.causalRootId } };
      const captured = { spawnIntentHash, runId, modelSelection: model.selection, modelSource: model.source,
        exactModel: model.exactModel, policy, completionPolicy, journalOwnerId, profileReference,
        parentTurnId: caller.executionId, ...(toolCallId ? { parentToolCallId: toolCallId } : {}),
        ...(intent.wait ? { inlineWait: { chatId: caller.chatId, executionId: caller.executionId, toolCallId } } : {}),
        sourceCancellationEpoch: epoch, scope: workspace.scope, projectId: workspace.scope.projectId, ...causal,
        ...(intent.category ? { category: intent.category } : {}), ...(intent.boardTaskId ? { boardTaskId: intent.boardTaskId } : {}) };
      const relation = { version: 1, childChatId, parentChatId: caller.chatId, rootChatId, journalOwnerId, origin: 'delegated',
        createdAt: stamp, initialRunId: runId, profileReference, capabilities: { canSend: true, canStop: true, canChooseModel: true } };
      const event = makeEvent('run.requested', { runId, agentType: intent.type, task: intent.task, parentChatId: journalOwnerId,
        cwd: workspace.scope.canonicalKey, requestedAt: stamp, parentTurnId: caller.executionId,
        ...(toolCallId ? { parentToolCallId: toolCallId } : {}), model: { providerId: model.selection.providerId, id: model.selection.modelId },
        modelSource: model.source, ...(model.selection.options !== undefined ? { modelOptions: model.selection.options } : {}),
        childChatId, journalOwnerId, commandId, executionKind: 'chat', policy, profileReference, completionPolicy,
        ...(workspace.binding ? { workspaceBinding: workspace.binding } : {}) });
      const created = repository.atomic(() => {
        assertLive();
        const created = repository.createChild({ chat: shell, relation, profile: { ...profileReference, snapshot: { ...snapshot, policy, modelSelection: model.selection, exactModel: model.exactModel,
          ...(workspace.binding ? { workspaceBinding: workspace.binding } : {}) } },
          projectId: workspace.scope.projectId, command, producerId, requestKey: intent.requestKey, spawnIntentHash, captured,
          outbox: [{ outboxId: `request-${runId}`, chatId: childChatId, kind: 'agent.journal.request', payload: { journalOwnerId, event } }] });
        if (!created.replayed) repository.updateCommand(created.command.commandId, { runId });
        return created;
      });
      changed(childChatId);
      await flush();
      return receipt(repository.getCommand(created.command.commandId), created.replayed);
    },
    async admitChildTask({ record, target }) {
      const relation = repository.getRelation(record.chatId);
      if (!relation || !['accepted', 'queued', 'waiting_for_host'].includes(record.state) || record.held) return { ready: false };
      const runId = record.runId ?? stableId('task', [record.chatId, record.commandId]);
      repository.atomic(() => {
        const current = repository.getCommand(record.commandId);
        if (!current || current.held || !['accepted', 'queued', 'waiting_for_host'].includes(current.state)) return;
        const outboxId = `request-${runId}`;
        if (!repository.getOutbox(outboxId)) repository.putOutbox({ outboxId, chatId: record.chatId, kind: 'agent.journal.request',
          payload: { journalOwnerId: relation.journalOwnerId, event: eventFor(current, target, relation, runId) } });
        if (!current.runId) repository.updateCommand(record.commandId, { runId });
      });
      await flush();
      await (await getEngine(relation.journalOwnerId)).tick();
      return { ready: false, runId };
    },
    async onCommand(record) {
      if (record.effectiveCommand.kind === 'remove_queued') {
        const target = repository.getCommand(record.effectiveCommand.targetCommandId);
        if (target) return delegation.onCommand(target);
      }
      if (record.runId && (record.state === 'cancelled' && record.result?.disposition === 'removed' ||
          record.state === 'settled' && record.result?.disposition === 'steered')) {
        const relation = repository.getRelation(record.chatId);
        if (!relation) return;
        const outboxId = stableId('queue-task-cancel', [record.commandId, record.runId]);
        repository.putOutbox({ outboxId, chatId: record.chatId, kind: 'agent.journal.cancel', payload: {
          journalOwnerId: relation.journalOwnerId, event: makeEvent('run.cancelled', { runId: record.runId, reason: 'user' }),
        } });
        await flush();
        const run = (await getEngine(relation.journalOwnerId)).getState().runs.get(record.runId);
        if (run?.phase === 'cancelled') await onTerminal?.({ run, result: { outcome: 'crashed', error: 'Queued input no longer needs a separate execution' } });
        return;
      }
      if (record.effectiveCommand.kind !== 'send' || !repository.getRelation(record.chatId) || record.held || !['accepted', 'queued', 'waiting_for_host'].includes(record.state)) return;
      return delegation.admitChildTask({ record, target: await context.resolveTarget(record.chatId) });
    },
    flush,
    async recover() {
      await flush();
      for (const record of repository.listCommands({ states: ['accepted', 'queued', 'waiting_for_host'], limit: 1000 })) {
        if (repository.getRelation(record.chatId)) await delegation.onCommand(record);
      }
      for (const record of repository.listCommands({ states: ['cancelled', 'settled'], limit: 1000 })) {
        if (record.runId && ['removed', 'steered'].includes(record.result?.disposition)) await delegation.onCommand(record);
      }
    },
    async cancelTree(input) {
      if (typeof cancelTree !== 'function') fail('capability_unavailable', 'The durable task cancellation adapter is unavailable');
      return cancelTree(input);
    },
    onTerminal,
  };
  return delegation;
}

/** Runtime supplies graph factories lazily, avoiding runtime/middleware cycles. */
export function installChatDelegation(runtime, options) {
  const delegation = createChatDelegation({ repository: runtime.repository, context: runtime.context, service: runtime.service,
    validateSourceCaller: runtime.isExecutionCallerActive, getSourceModelSelection: runtime.getSourceModelSelection,
    inheritCausality: caller => runtime.causality?.inherit(caller), onTerminal: input => runtime.taskDelivery?.onSettled(input), ...options });
  runtime.delegation = delegation;
  runtime.setTaskAdapter(delegation);
  runtime.taskDelivery?.setEngineResolver(options.getEngine);
  runtime.setToolHandler?.('spawn_sub_agent', async ({ args, toolContext, execution, signal }) => {
    try {
      const { caller } = await runtime.context.executionCaller(execution.executionId);
      const receipt = await delegation.spawn(caller, args, { toolCallId: toolContext?.toolCallId, signal });
      if (args.wait === true) return { content: JSON.stringify(await runtime.taskDelivery.waitForRun({ caller,
        runId: receipt.runId, journalOwnerId: receipt.journalOwnerId, toolCallId: toolContext?.toolCallId, signal })) };
      return { content: JSON.stringify(receipt) };
    } catch (error) {
      if (error instanceof ChatContractError && !['internal_error', 'recovery_required'].includes(error.code)) {
        return { content: `Error: ${JSON.stringify(error.toJSON())}` };
      }
      throw error;
    }
  });
  return delegation;
}
