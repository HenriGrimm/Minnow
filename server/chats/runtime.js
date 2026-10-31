import { createHash } from 'node:crypto';
import { createChatRepository } from './repository.js';
import { createChatContext } from './context.js';
import { createChatCommandService } from './service.js';
import { createChatPresentation } from './presentation.js';
import { createChatRequestService } from './requests.js';
import { createServerChatExecutionHost } from './execution-host.js';
import { createChatHostCapabilities } from './host-capabilities.js';
import { prepareChatExecution, resolveChatPolicyInput, captureChatProfile } from './preparation.js';
import { createChatTaskDelivery } from './task-delivery.js';
import { createChatCausality } from './causality.js';
import { createChatQuestionRecovery } from './question-recovery.js';
import { createChatRecovery } from './recovery.js';
import { createLegacyResultDelivery } from './legacy-result-delivery.js';
import { setProductionCanonicalDelivery } from '../sub-agents/runtime.js';
import { observePersistentAgentTurn } from './task-bridge.js';
import { createChatRunnerDeps } from './runner-deps.js';
import { resolveAgentModelSelection } from './model-selection.js';
import { executeConversationTool } from './conversation-tools.js';
import { createInProcessToolDispatch } from '../runner/tool-dispatch.js';
import { createChatPolicy, intersectChatPolicies, assertChatPolicyWithinCeiling, assertChatToolAllowed } from './policy.js';
import { assertCallerCanTarget, assertExecutionCaller, createChatCaller } from './caller.js';
import { ChatContractError } from './contracts.js';
import { listGenerationStates } from '../generations/store.js';

const normalStatuses = ['running', 'loading_model'];
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
let productionFactory, production, productionPromise;
export function setProductionChatRuntimeFactory(factory) { productionFactory = factory; production = undefined; productionPromise = undefined; }
export function peekProductionChatRuntime() { return production; }
export function publishProductionChatRuntime(runtime) { production = runtime; }
export function getProductionChatRuntime() {
  if (!productionFactory) throw new ChatContractError('capability_unavailable', 'The conversation runtime is not configured');
  productionPromise ??= Promise.resolve().then(productionFactory).then(runtime => { production = runtime; return runtime; }).catch(error => { productionPromise = undefined; throw error; });
  return productionPromise;
}

/** One production command service and host, shared by every transport. */
export function createProductionChatRuntime({ turns, stopExternalOwner, repository = createChatRepository(),
  preparationAdapters, modelAdapters, prepare = prepareChatExecution, createRunnerDeps = createChatRunnerDeps,
  generations = listGenerationStates } = {}) {
  let ready = false, taskAdapter, taskDelivery, causality, questionRecovery;
  let removeLegacyDelivery;
  let releaseReady;
  const startupReady = new Promise(resolve => { releaseReady = resolve; });
  async function awaitReady({ signal }) {
    if (ready) return;
    signal.throwIfAborted();
    let abort;
    try { await Promise.race([startupReady, new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Stopped', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
    })]); } finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  preparationAdapters = {
    readTranscript: async chatId => repository.readTranscript(chatId),
    readProfile: async reference => repository.getProfile(reference.profileId, reference.profileVersion),
    ...preparationAdapters,
  };
  const legacyContexts = new Map();
  const legacyCallers = new WeakSet();
  const requestNotifications = new Set();
  const executionWaits = new Map();
  const toolHandlers = new Map();
  const resolvePolicyInput = (chat, scope, registry) => resolveChatPolicyInput(chat, scope, {
    adapters: preparationAdapters,
    workspaceIds: registry.entries.filter(row => row.projectId === scope.projectId && !row.revoked).map(row => row.workspaceId),
  });
  const context = createChatContext({ repository, resolvePolicyInput });
  function assertExecutionScope(execution, target) {
    const captured = execution.captured ?? {}, scope = captured.scope;
    if (captured.projectId && captured.projectId !== target.scope.projectId || scope &&
      (scope.workspaceId !== target.scope.workspaceId || scope.canonicalKey !== target.scope.canonicalKey)) {
      throw new ChatContractError('workspace_denied', 'The original execution checkout changed; this operation cannot use a replacement project');
    }
    return target;
  }
  const presentation = createChatPresentation({ repository });
  const requests = createChatRequestService({ repository,
    assertLegacyOwner: caller => isExternalExecutionActive(caller),
    authorizeResponse(request, input) {
      if (input?.caller?.actor !== 'human' || input.target?.chat.id !== request.chatId) return false;
      assertCallerCanTarget(input.caller, input.target, { operation: 'respond', currentPolicy: input.target.currentPolicy, registry: input.target.registry });
      return true;
    },
    onChange: request => {
      if (repository.getChatProjectId(request.chatId)) { presentation.changed(request.chatId); return; }
      const notification = context.resolveTarget(request.chatId).then(target => presentation.externalRequestChanged({
        chatId: request.chatId, projectId: target.scope.projectId,
      }));
      requestNotifications.add(notification);
      notification.finally(() => requestNotifications.delete(notification)).catch(() => {});
      return notification;
    },
  });
  const capabilities = createChatHostCapabilities({ repository,
    resolveProject: async input => {
      const target = await context.resolveTarget(input.chatId);
      return { projectId: target.scope.projectId, workspaceRoot: target.scope.canonicalKey };
    },
    beforeDispatch: async input => {
      const { assertChatToolAllowed } = await import('./policy.js');
      const target = await context.resolveTarget(input.chatId);
      assertExecutionScope(input.execution, target);
      assertChatToolAllowed(input.prepared.policy, input.name, input.args, { currentPolicy: target.currentPolicy, approvalGranted: true });
    },
    onChange: input => presentation.changed(input.chatId),
  });
  const getExternalOwner = chatId => {
    const current = turns?.listLegacy?.().find(row => row.chatId === chatId) ?? turns?.list?.().find(row => row.chatId === chatId && row.hostId !== 'minnow-server');
    return current ? { ownerId: current.ownerId } : null;
  };
  const isExternalExecutionActive = caller => {
    const entry = legacyContexts.get(caller.executionId);
    return legacyCallers.has(caller) && entry?.caller === caller && entry.chatId === caller.chatId &&
      getExternalOwner(caller.chatId)?.ownerId === entry.ownerId && repository.getCancellationEpoch(caller.chatId) === entry.cancellationEpoch;
  };
  function expireLegacyOwner(chatId, ownerId, state = 'cancelled') {
    for (const entry of legacyContexts.values()) {
      if (entry.chatId === chatId && entry.ownerId === ownerId) requests.expireExecution(entry.executionId, chatId, state);
    }
  }
  const service = createChatCommandService({ repository, context,
    canResumeQuestionExecution: executionId => questionRecovery?.canResume(repository.getExecution(executionId)) === true,
    admitCausality: input => causality.admit(input),
    hasExternalOwner: chatId => Boolean(getExternalOwner(chatId)) || generations().some(row => row.chatId === chatId &&
      ['pending', 'streaming'].includes(row.status) && repository.getLease(chatId)?.ownerId !== 'minnow-server'),
    getExternalOwner,
    stopExternalOwner: typeof stopExternalOwner === 'function' ? async input => {
      expireLegacyOwner(input.chatId, input.owner.ownerId);
      return stopExternalOwner(input);
    } : undefined,
    isExternalExecutionActive,
    captureProfile: async ({ target, selection }) => ({
      profileId: 'profile-' + digest(target.chat.id), profileVersion: 1,
      snapshot: await captureChatProfile(target.chat, target.scope, { adapters: preparationAdapters,
        workspaceIds: target.currentPolicy.workspaceIds, modelSelection: selection }),
    }),
    resolveModelSelection: ({ target, selection, input }) => resolveAgentModelSelection({ target: selection }, {
      adapters: modelAdapters, workspacePath: target.scope.canonicalKey,
      ...(input.images?.length ? { request: { messages: [{ role: 'user', content: input.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } })) }] } } : {}),
    }),
    admitChildTask: input => taskAdapter ? taskAdapter.admitChildTask(input) : { ready: false },
    cancelTree: input => {
      if (!taskAdapter) throw new ChatContractError('capability_unavailable', 'The task cancellation adapter is unavailable');
      return taskAdapter.cancelTree(input);
    },
    onCommand: record => taskAdapter?.onCommand?.(record),
    onEvent: event => { presentation.onServiceEvent(event); taskDelivery?.onServiceEvent(event); },
  });
  const host = createServerChatExecutionHost({ repository, requestService: requests,
    hydrateRecoveredQuestions: input => questionRecovery?.hydrate(input), beforeInference: awaitReady,
    prepareExecution: async input => {
      const prepared = await prepare(input, { resolveTarget: async (chatId, options) =>
        assertExecutionScope(input.execution, await context.resolveTarget(chatId, options)), adapters: preparationAdapters,
        modelAdapters, createRunnerDeps });
      prepared.runOptions = { ...prepared.runOptions, injectReportTool: input.execution.captured?.completionPolicy?.kind === 'wake_delegator',
        nudgeToolUse: false, finalizeStructuredOutcome: false };
      prepared.hostToolNames = (prepared.hostToolNames ?? []).filter(name => !['set_chat_mode', 'create_chat_with_mode', 'propose_mode_switch', 'todo_write'].includes(name) && !toolHandlers.has(name));
      return prepared;
    },
    resolveCurrentPolicy: async input => assertExecutionScope(input.execution, await context.resolveTarget(input.command.chatId)).policy,
    executeHostTool: input => capabilities.executeHostTool(input),
    onEvent: event => { presentation.onEvent(event); observePersistentAgentTurn(event); taskDelivery?.onHostEvent(event); },
    onStatus: event => { service.notifyExecution(event); presentation.changed(event.chatId); },
    createToolDispatch: async (prepared, executionContext) => {
      const { command, execution, fence, signal, runtimeOwner } = executionContext;
      const base = createInProcessToolDispatch({ cwd: prepared.cwd, modeId: prepared.policy.modeId,
        allowedToolNames: Object.keys(prepared.policy.toolPermissions), runtimeOwner, activityChatId: command.chatId,
        filesystemAccessCeiling: prepared.policy.filesystemAccess, shellSandboxMode: prepared.policy.shellSandboxMode });
      return { ...base, execute: async (name, args, toolContext) => {
        if (toolHandlers.has(name)) return toolHandlers.get(name)({ name, args, toolContext, ...executionContext, prepared, context, service, repository });
        const target = await context.resolveTarget(command.chatId);
        const policy = intersectChatPolicies(prepared.policy, target.policy);
        assertChatToolAllowed(prepared.policy, name, args ?? {}, { currentPolicy: target.policy, approvalGranted: toolContext?.approvalGranted === true });
        if (name === 'todo_write' || name === 'propose_mode_switch') return executeConversationTool(name, args, {
          repository, requests, execution, fence, prepared, signal, toolCallId: toolContext?.toolCallId,
          currentPolicy: policy, onChange: chatId => presentation.changed(chatId), onStatus: event => service.notifyExecution(event),
        });
        if (name === 'set_chat_mode') {
          const modeId = args?.mode_id;
          if (!['general', 'build', 'plan', 'debug'].includes(modeId)) throw new ChatContractError('policy_denied', 'Choose an independent conversation for broader authority');
          const narrowed = createChatPolicy(await resolvePolicyInput({ ...target.chat, modeId }, target.scope, target.registry));
          assertChatPolicyWithinCeiling(narrowed, policy);
          repository.configureChat(command.chatId, { modeId }, { expectedProfileVersion: target.profile?.profileVersion ?? 0,
            profile: { profileId: target.profile?.profileId ?? `profile-${command.chatId}`, profileVersion: (target.profile?.profileVersion ?? 0) + 1,
              snapshot: { ...(target.profile?.snapshot ?? {}), policy: narrowed } } });
          presentation.changed(command.chatId);
          return { content: `Mode set to ${modeId}. Existing authority restrictions continue to apply.` };
        }
        if (name === 'create_chat_with_mode') throw new ChatContractError('policy_denied', 'Use the existing conversation tools to contact another chat, or ask the user to create an independent chat');
        const dispatch = createInProcessToolDispatch({ cwd: prepared.cwd, modeId: policy.modeId,
          allowedToolNames: Object.keys(policy.toolPermissions), runtimeOwner, activityChatId: command.chatId,
          filesystemAccessCeiling: policy.filesystemAccess, shellSandboxMode: policy.shellSandboxMode,
          interactiveApproval: toolContext?.approvalGranted === true });
        if (name !== 'wait') return dispatch.execute(name, args, { ...toolContext, signal });
        repository.updateExecution(execution.executionId, { status: 'waiting' }, { fence });
        service.notifyExecution({ chatId: command.chatId, executionId: execution.executionId, status: 'waiting' });
        presentation.changed(command.chatId);
        try { return await dispatch.execute(name, args, { ...toolContext, signal }); }
        finally {
          if (!signal.aborted) repository.updateExecution(execution.executionId, { status: 'running' }, { fence });
          presentation.changed(command.chatId);
        }
      } };
    },
  });
  const unregisterHost = service.registerHost({ id: 'minnow-server', kind: 'server', supportsSteer: true,
    canRun: ({ execution }) => ready || questionRecovery?.canResume(execution) === true, execute: input => host.execute(input) });
  const runtime = { repository, context, service, requests, capabilities, presentation, host, resolvePolicyInput,
    async beginChatWait(input) {
      const release = await causality.beforeWait(input);
      const execution = repository.getExecution(input.caller.executionId);
      const fence = execution ? repository.getLease(input.caller.chatId) : null;
      let group = execution ? executionWaits.get(execution.executionId) : null;
      try {
        if (execution && fence?.executionId === execution.executionId) {
          if (group) group.count++;
          else {
            group = { count: 1, restore: execution.status === 'running', executionId: execution.executionId, chatId: execution.chatId, fence };
            if (group.restore) {
              repository.updateExecution(execution.executionId, { status: 'waiting_for_agents' }, { fence });
              service.notifyExecution({ chatId: execution.chatId, executionId: execution.executionId, status: 'waiting_for_agents' });
              presentation.changed(execution.chatId);
            }
            executionWaits.set(execution.executionId, group);
          }
        }
      } catch (error) { release?.(); throw error; }
      let released = false;
      return () => {
        if (released) return; released = true;
        release?.();
        if (!group || --group.count > 0) return;
        executionWaits.delete(group.executionId);
        if (!group.restore) return;
        try {
          if (repository.getExecution(group.executionId)?.status !== 'waiting_for_agents') return;
          repository.updateExecution(group.executionId, { status: 'running' }, { fence: group.fence });
          service.notifyExecution({ chatId: group.chatId, executionId: group.executionId, status: 'running' });
          presentation.changed(group.chatId);
        } catch { /* Stop or ownership settlement superseded the waiting state. */ }
      };
    },
    isExternalExecutionActive(caller) {
      try { assertExecutionCaller(caller); return isExternalExecutionActive(caller); } catch { return false; }
    },
    hasExternalExecution: chatId => Boolean(getExternalOwner(chatId))
      || generations().some(row => row.chatId === chatId && ['pending', 'streaming'].includes(row.status)),
    isExecutionCallerActive(caller) {
      try {
        assertExecutionCaller(caller);
        const execution = repository.getExecution(caller.executionId);
        if (!execution) return isExternalExecutionActive(caller);
        const lease = repository.getLease(caller.chatId);
        if (execution.chatId !== caller.chatId || !['running', 'waiting', 'loading_model', 'waiting_for_model', 'waiting_for_host', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval'].includes(execution.status) || lease?.executionId !== caller.executionId) return false;
        repository.assertFence(caller.chatId, lease);
        return execution.captured?.cancellationEpoch === undefined || execution.captured.cancellationEpoch === repository.getCancellationEpoch(caller.chatId);
      } catch { return false; }
    },
    getSourceModelSelection(caller, target) {
      const inherited = repository.getExecution(caller.executionId)?.captured?.modelSelection ?? legacyContexts.get(caller.executionId)?.modelSelection;
      return inherited ?? target.profile?.snapshot?.modelSelection ?? { providerId: target.chat.providerId, modelId: target.chat.modelId };
    },
    resolveModelSelection: (input, options = {}) => resolveAgentModelSelection(input, { adapters: modelAdapters, ...options }),
    setTaskAdapter(adapter) { taskAdapter = adapter; },
    setToolHandler(name, handler) { toolHandlers.set(name, handler); return () => toolHandlers.delete(name); },
    listTurns() { return repository.listExecutions({ statuses: normalStatuses, limit: 1000 }).map(row => ({ chatId: row.chatId, ownerId: 'minnow-server', hostId: 'minnow-server', executionId: row.executionId })); },
    async legacyCaller({ chatId, ownerId }) {
      const current = getExternalOwner(chatId);
      if (!current || current.ownerId !== ownerId) throw new ChatContractError('caller_not_active', 'The sending renderer no longer owns this chat');
      const sourceEpoch = turns?.getCancellationEpoch?.(chatId, ownerId) ?? repository.getCancellationEpoch(chatId);
      if (sourceEpoch !== repository.getCancellationEpoch(chatId)) throw new ChatContractError('caller_not_active', 'This renderer turn was stopped before delegation');
      const target = await context.resolveTarget(chatId);
      const executionId = `renderer-${digest(chatId + ':' + ownerId)}`;
      let entry = legacyContexts.get(executionId);
      if (!entry) {
        if (legacyContexts.size >= 1024) throw new ChatContractError('queue_full', 'Too many renderer turns are awaiting legacy settlement');
        const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId, executionId, executionActive: true,
          scope: target.scope, policy: target.policy });
        legacyCallers.add(caller);
        const modelSelection = turns?.getModelSelection?.(chatId, ownerId) ?? target.profile?.snapshot?.modelSelection ?? {
          providerId: target.chat.providerId, modelId: target.chat.modelId,
          ...(target.chat.reasoningEffort ? { options: { reasoningEffort: target.chat.reasoningEffort } } : {}),
        };
        entry = { caller, chatId, ownerId, executionId, modelSelection, cancellationEpoch: sourceEpoch };
        legacyContexts.set(executionId, entry);
      }
      // Legacy history remains writable until that renderer flushes and releases
      // its existing lease. Only subsequent service-owned work marks it managed.
      return { caller: entry.caller, target, execution: { executionId, chatId, kind: 'renderer', captured: { policy: entry.caller.policy } } };
    },
    renewLegacy() {},
    releaseLegacy(chatId, ownerId) {
      expireLegacyOwner(chatId, ownerId);
      for (const [executionId, entry] of legacyContexts) if (entry.chatId === chatId && entry.ownerId === ownerId) legacyContexts.delete(executionId);
      taskDelivery?.onLegacyReleased(chatId);
      void service.kick(chatId).catch(error => console.error('[chats] deferred input failed:', error.message));
    },
    async start() {
      await runtime.recovery.run({ reason: 'startup' });
      ready = true;
      releaseReady();
      removeLegacyDelivery?.();
      removeLegacyDelivery = setProductionCanonicalDelivery(runtime.legacyResultDelivery.deliver);
      await taskDelivery.start();
      for (const chatId of new Set(repository.listCommands({ states: ['accepted', 'queued', 'waiting_for_host'], limit: 1000 }).map(row => row.chatId))) void service.kick(chatId).catch(() => {});
    },
    async dispose() {
      ready = false; removeLegacyDelivery?.(); await runtime.legacyResultDelivery.dispose();
      causality.dispose(); unregisterHost(); await taskDelivery.dispose();
      for (const entry of legacyContexts.values()) requests.expireExecution(entry.executionId, entry.chatId, 'expired');
      await service.dispose(); await Promise.allSettled([...requestNotifications]);
      legacyContexts.clear(); executionWaits.clear(); capabilities.dispose?.(); presentation.dispose();
    },
  };
  causality = createChatCausality({ repository, isCallerActive: runtime.isExecutionCallerActive });
  runtime.causality = causality;
  runtime.legacyResultDelivery = createLegacyResultDelivery({ repository, context, service, isReady: () => ready,
    isBusy: chatId => runtime.hasExternalExecution(chatId) || repository.getLease(chatId)?.state === 'active',
    onChange: chatId => presentation.changed(chatId) });
  questionRecovery = createChatQuestionRecovery({ repository, requests, onChange: chatId => presentation.changed(chatId),
    validateBoundary: async execution => {
      const target = assertExecutionScope(execution, await context.resolveTarget(execution.chatId));
      const policy = execution.captured?.policy ? createChatPolicy(execution.captured.policy) : target.policy;
      assertChatToolAllowed(policy, 'ask_question', {}, { currentPolicy: target.currentPolicy, approvalGranted: true });
      return target.currentPolicy.capabilities.includes('execution.host');
    },
    verifyQuiescence: execution => !service.ownsExecution(execution.executionId) && !getExternalOwner(execution.chatId) &&
      !generations().some(row => row.chatId === execution.chatId && ['pending', 'streaming'].includes(row.status))
      ? { verified: true, source: 'server-start/question-hosts-and-generations-quiescent', checkedAt: Date.now() } : null });
  runtime.questionRecovery = questionRecovery;
  taskDelivery = createChatTaskDelivery({ repository, context, service, isReady: () => ready,
    isRecipientBusy: chatId => Boolean(getExternalOwner(chatId)) || repository.getLease(chatId)?.state === 'active'
      || generations().some(row => row.chatId === chatId && ['pending', 'streaming'].includes(row.status)),
    isSourceActive: ({ chatId, executionId }) => {
      const entry = legacyContexts.get(executionId);
      return entry?.chatId === chatId && getExternalOwner(chatId)?.ownerId === entry.ownerId
        && repository.getCancellationEpoch(chatId) === entry.cancellationEpoch;
    },
    onChange: chatId => presentation.changed(chatId),
  });
  runtime.taskDelivery = taskDelivery;
  runtime.recovery = createChatRecovery({ repository, service, requests, taskDelivery,
    getTaskAdapter: () => taskAdapter,
    beforeExecutionRecovery: input => runtime.questionRecovery?.beforeExecutionRecovery(input),
    // Timeout alone never establishes effect quiescence. Only this process can
    // verify that its execution hosts and model streams do not own the lease.
    verifyQuiescence: execution => !service.ownsExecution(execution.executionId) && !getExternalOwner(execution.chatId) &&
      !generations().some(row => row.chatId === execution.chatId && ['pending', 'streaming'].includes(row.status))
      ? { verified: true, source: 'server-start/hosts-and-generations-quiescent', checkedAt: Date.now() } : null,
  });
  return runtime;
}
