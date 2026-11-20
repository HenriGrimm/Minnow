import { ChatContractError, CHAT_EXECUTION_STATES, validateChatId } from './contracts.js';
import { assertExecutionCaller, assertCallerCanTarget } from './caller.js';
import { assertChatToolAllowed } from './policy.js';
import { listAgentCapabilities } from './capabilities.js';
import { createChatPreparationAdapters } from './preparation.js';
import { getAgentConversationsFeature } from './feature.js';
import { AGENT_CHAT_TOOL_IDS } from './tool-catalog.js';
import { createChatTaskRepository } from './task-repository.js';
import { createChatToolReads } from './tool-reads.js';
import { CHAT_WAIT_TIMEOUT_MS } from '../tools/chat-catalog.js';
import { ordinaryChatConsentHash, ORDINARY_CONSENT_MS } from './ordinary-consent.js';
import { hashChatPayload } from './repository.js';

const terminal = new Set(['completed', 'failed', 'stopped', 'recovery_required']);
const recoveryTools = new Set(['chat_list', 'chat_read', 'chat_wait', 'chat_stop']);
const argumentNames = {
  agent_capabilities: ['search', 'cursor', 'limit'],
  chat_list: ['query', 'status', 'include_subagents', 'cursor', 'limit'],
  chat_create: ['title', 'message', 'provider_id', 'model_id', 'workspace_id', 'report_back', 'client_request_id'],
  chat_read: ['chat_id', 'view', 'after_sequence', 'limit'],
  chat_send: ['chat_id', 'message', 'mode', 'client_request_id', 'execution_id'],
  chat_wait: ['chat_id', 'execution_id', 'timeout_ms'],
  chat_stop: ['chat_id', 'execution_id', 'scope', 'client_request_id'],
};
const link = id => `#/app/code/chat?chatId=${encodeURIComponent(id)}`;
const fail = message => { throw new ChatContractError('invalid_request', message); };
function fields(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
      Reflect.ownKeys(args).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), 'value'))) fail('Unsupported conversation tool input');
}
function id(value) { const result = validateChatId(value); if (!result.ok) fail(result.error.message); return result.value; }
function integer(field, value, fallback, minimum, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(`${field} must be an integer from ${minimum} to ${maximum}`);
  return result;
}
function text(value, maximum, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)) fail('A bounded conversation string is required');
  return value;
}
function pause(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Every entry point takes branded runtime authority, never model-supplied authorship. */
export function createChatTools({ repository, context, service, validateCaller, capabilitiesContext,
  beforeWait, coordinationLimits, feature = getAgentConversationsFeature, now = Date.now } = {}) {
  if (!repository || !context || !service || typeof validateCaller !== 'function') throw new TypeError('Chat tools require a canonical runtime and live caller validator');
  const reads = createChatToolReads(repository);
  function active(caller, signal) {
    signal?.throwIfAborted(); assertExecutionCaller(caller);
    if (validateCaller(caller) !== true) throw new ChatContractError('caller_not_active', 'The sending execution no longer owns this conversation');
  }
  async function targetFor(caller, source, chatId, operation = 'read') {
    const target = await context.resolveTarget(id(chatId), { project: source.project });
    assertCallerCanTarget(caller, { chatId, scope: target.scope, policy: target.policy }, {
      operation, currentPolicy: source.currentPolicy, registry: target.registry,
    });
    return target;
  }
  const tools = {
    async execute(name, args = {}, { caller, toolCallId, signal, approvalGranted = false, requestOrdinaryConfirmation, settleOrdinaryCreation } = {}) {
      if (!AGENT_CHAT_TOOL_IDS.includes(name)) fail('Unknown conversation tool');
      fields(args, argumentNames[name]);
      active(caller, signal);
      const state = feature();
      if (!state.creationEnabled && !(state.recoveryEnabled && recoveryTools.has(name))) throw new ChatContractError('capability_disabled', 'Conversation coordination is not enabled');
      const source = await context.resolveTarget(caller.chatId);
      active(caller, signal);
      if (['chat_read', 'chat_send', 'chat_wait', 'chat_stop'].includes(name) &&
          !repository.getExecution(caller.executionId) && id(args.chat_id) !== caller.chatId && !repository.getRelation(args.chat_id)) {
        throw new ChatContractError('capability_unavailable', 'This host cannot collect explicit confirmation for ordinary chat actions');
      }
      assertChatToolAllowed(caller.policy, name, args, { currentPolicy: source.policy,
        approvalGranted: approvalGranted || name === 'chat_create' && typeof requestOrdinaryConfirmation === 'function' });
      const confirm = async (action, preview, title) => {
        active(caller, signal);
        if (typeof requestOrdinaryConfirmation !== 'function' || !toolCallId) {
          throw new ChatContractError('capability_unavailable', 'This host cannot collect explicit confirmation for ordinary chat actions');
        }
        const digest = ordinaryChatConsentHash(repository, caller, action);
        const requestId = await requestOrdinaryConfirmation({
          toolCallId: 'ordinary-' + hashChatPayload([toolCallId, digest]), kind: 'approval', title,
          expiresInMs: ORDINARY_CONSENT_MS, presentation: {
            ordinaryChatConsent: digest, toolName: name, arguments: preview,
          },
        });
        active(caller, signal);
        return { requestId, toolCallId, signal };
      };
      const confirmTarget = async (operation, input, title) => {
        const description = await service.describeOrdinaryAction(caller, operation, input);
        if (!description) return undefined;
        return confirm(description.action, description.preview, title);
      };
      if (name === 'chat_create') {
        if ((args.provider_id === undefined) !== (args.model_id === undefined)) fail('Specify both provider_id and model_id');
        if (args.report_back !== undefined && typeof args.report_back !== 'boolean') fail('report_back must be boolean');
        const input = { name: text(args.title, 240).trim(), clientRequestId: text(args.client_request_id ?? toolCallId, 256),
          reportBack: args.report_back === true,
          ...(args.message !== undefined ? { message: text(args.message, 24_000) } : {}),
          ...(args.workspace_id !== undefined ? { workspaceId: id(args.workspace_id) } : {}),
          ...(args.provider_id !== undefined ? { selection: { providerId: text(args.provider_id, 256), modelId: text(args.model_id, 512) } } : {}),
        };
        return service.createOrdinary(caller, input, { signal, settleReceipt: settleOrdinaryCreation,
          confirm: typeof requestOrdinaryConfirmation === 'function' ? (action, preview) => confirm(action, preview, 'Create a new chat?') : undefined });
      }
      if (name === 'agent_capabilities') {
        fields(args, ['search', 'cursor', 'limit']);
        const extra = capabilitiesContext ? await capabilitiesContext(caller, source, signal) : {
          inherited: repository.getExecution(caller.executionId)?.captured?.modelSelection ?? source.profile?.snapshot?.modelSelection ??
            { providerId: source.chat.providerId, modelId: source.chat.modelId },
          types: await createChatPreparationAdapters().loadSubAgentTypes(),
        };
        active(caller, signal);
        return { ...await listAgentCapabilities(args, { ...extra, signal, workspacePath: source.scope.canonicalKey }),
          ...(coordinationLimits ? { coordination_limits: coordinationLimits() } : {}) };
      }
      if (name === 'chat_list') {
        fields(args, ['query', 'status', 'include_subagents', 'cursor', 'limit']);
        const query = args.query === undefined ? '' : text(args.query, 200).trim().toLowerCase();
        if (args.status !== undefined && !['idle', ...CHAT_EXECUTION_STATES].includes(args.status)) fail('Unknown conversation status');
        if (args.include_subagents !== undefined && typeof args.include_subagents !== 'boolean') fail('include_subagents must be a boolean');
        const include = args.include_subagents === true, limit = integer('limit', args.limit, 20, 1, 100);
        let position = 0;
        if (args.cursor !== undefined) {
          if (typeof args.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(args.cursor)) fail('Invalid conversation cursor');
          let cursor;
          try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); } catch { fail('Invalid conversation cursor'); }
          if (cursor?.version !== 1 || cursor.projectId !== source.scope.projectId || cursor.query !== query ||
              cursor.status !== (args.status ?? null) || cursor.include !== include) fail('Conversation cursor does not match this query');
          position = integer('cursor.position', cursor.position, 0, 0, Number.MAX_SAFE_INTEGER);
        }
        const workspaceKeys = [...new Set(source.registry.entries
          .filter(row => row.projectId === source.scope.projectId && !row.revoked)
          .flatMap(row => row.aliases))];
        const candidates = reads.candidates(position, 201, include, workspaceKeys), chats = [];
        let visited = 0;
        for (const row of candidates.slice(0, 200)) {
          active(caller, signal); position = row.position; visited++;
          let target;
          try { target = await targetFor(caller, source, row.id); }
          catch (error) { if (['workspace_denied', 'cross_project_denied', 'chat_not_found', 'policy_denied'].includes(error.code)) continue; throw error; }
          const activity = reads.activity(row.id), status = activity.execution?.status ?? 'idle';
          if ((query && !`${target.chat.name} ${row.id}`.toLowerCase().includes(query)) || (args.status && args.status !== status)) continue;
          chats.push({ chat_id: row.id, title: String(target.chat.name ?? '').slice(0, 240), status,
            mode: target.policy.modeId, workspace_id: target.scope.workspaceId, model: { providerId: target.chat.providerId, modelId: target.chat.modelId },
            ...(target.chat.agentConversation ? { relationship: target.chat.agentConversation } : {}),
            execution_id: activity.execution?.executionId ?? null, pending_request_count: activity.pendingRequestCount,
            link: link(row.id) });
          if (chats.length === limit) break;
        }
        const hasMore = visited < candidates.length;
        const cursor = { version: 1, projectId: source.scope.projectId, query, status: args.status ?? null, include, position };
        return { chats, next_cursor: hasMore ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null, partial_scan: visited === 200 && hasMore };
      }
      if (name === 'chat_read') {
        fields(args, ['chat_id', 'view', 'after_sequence', 'limit']);
        const view = args.view ?? 'messages'; if (!['messages', 'activity'].includes(view)) fail('Choose messages or activity');
        const after = integer('after_sequence', args.after_sequence, -1, -1, Number.MAX_SAFE_INTEGER), limit = integer('limit', args.limit, 20, 1, 100);
        let target = await targetFor(caller, source, args.chat_id); active(caller, signal);
        if (!target.chat.agentConversation && target.chat.id !== caller.chatId) {
          const commandId = service.ordinaryReport(caller, target);
          if (commandId) {
            const record = repository.getCommand(commandId);
            const executionId = record?.executionId;
            return { chat_id: target.chat.id, link: link(target.chat.id), command_id: commandId, state: record?.state,
              ...(executionId ? { execution_id: executionId, ...reads.activity(target.chat.id, executionId),
                ...(view === 'messages' && terminal.has(reads.execution(target.chat.id, executionId)?.status)
                  ? { assistant_final: reads.finalText(executionId) } : {}) } : {}) };
          }
          const input = { chatId: target.chat.id, view, after, limit, requestKey: toolCallId ?? '' };
          const proof = await confirmTarget('read', input, 'Read another chat?');
          target = await targetFor(caller, source, args.chat_id);
          active(caller, signal);
          service.verifyOrdinaryAction(caller, 'read', input, target, proof);
        }
        const activity = reads.activity(target.chat.id);
        return { chat_id: target.chat.id, title: String(target.chat.name ?? '').slice(0, 240), link: link(target.chat.id), ...activity,
          ...(view === 'messages' ? reads.messages(target.chat.id, after, limit) : {}) };
      }
      if (name === 'chat_send') {
        fields(args, argumentNames.chat_send);
        const chatId = id(args.chat_id), message = text(args.message, 120000), mode = args.mode ?? 'auto';
        if (!['auto', 'queue', 'steer'].includes(mode)) fail('Choose auto, queue or steer');
        const key = text(args.client_request_id ?? toolCallId, 256); active(caller, signal);
        const input = { chatId, message, mode, clientRequestId: key,
          ...(args.execution_id !== undefined ? { executionId: id(args.execution_id) } : {}) };
        try {
          const prior = await service.replayAgentAction(caller, 'send', input);
          if (prior) return prior;
          const proof = await confirmTarget('send', input, mode === 'steer' ? 'Steer another chat?' : 'Send a message to another chat?');
          return await service.send(caller, input, proof);
        }
        catch (error) {
          if (error.reason === 'broader_target_denied' && repository.getRelation(caller.chatId)?.parentChatId === chatId) {
            const run = repository.getExecution(caller.executionId);
            const sub = run?.runId && createChatTaskRepository({ repository }).getSubscription(run.runId);
            if (sub?.recipientChatId === chatId && ['active', 'inline_hold'].includes(sub.state) &&
                sub.cancellationEpoch === repository.getCancellationEpoch(chatId) && !repository.getChat(chatId).subAgentAutoResumeBlocked) {
              error.message += '. Finish with your findings in this task. Completion delivers the result to your delegator.';
            }
          }
          throw error;
        }
      }
      if (name === 'chat_stop') {
        fields(args, ['chat_id', 'execution_id', 'scope', 'client_request_id']);
        const chatId = id(args.chat_id), scope = args.scope ?? 'turn';
        if (!['turn', 'tree'].includes(scope)) fail('Choose turn or tree');
        if (chatId === caller.chatId && scope === 'tree') throw new ChatContractError('policy_denied', 'Use turn scope to stop the current execution; its tree must be stopped from another conversation or human control');
        const key = text(args.client_request_id ?? toolCallId, 256); active(caller, signal);
        const input = { chatId, scope, clientRequestId: key, ...(args.execution_id !== undefined ? { executionId: id(args.execution_id) } : {}) };
        const prior = await service.replayAgentAction(caller, 'stop', input);
        if (prior) return prior;
        const proof = await confirmTarget('stop', input, 'Stop another chat?');
        return service.stop(caller, input, proof);
      }
      fields(args, ['chat_id', 'execution_id', 'timeout_ms']);
      const chatId = id(args.chat_id);
      const timeoutMs = integer('timeout_ms', args.timeout_ms, CHAT_WAIT_TIMEOUT_MS.default, CHAT_WAIT_TIMEOUT_MS.minimum, CHAT_WAIT_TIMEOUT_MS.maximum);
      let target = await targetFor(caller, source, chatId); active(caller, signal);
      const requestedId = args.execution_id === undefined ? undefined : id(args.execution_id);
      let selected = reads.execution(chatId, requestedId);
      let readProof, readInput, reportCommandId, deadline;
      if (!target.chat.agentConversation && target.chat.id !== caller.chatId) {
        reportCommandId = service.ordinaryReport(caller, target);
        if (reportCommandId) {
          deadline = now() + timeoutMs;
          for (;;) {
            const record = repository.getCommand(reportCommandId);
            if (record?.executionId) {
              if (requestedId && record.executionId !== requestedId) fail('Choose the execution covered by this confirmation');
              selected = reads.execution(chatId, record.executionId);
              break;
            }
            if (!record || ['failed', 'cancelled', 'settled'].includes(record.state)) {
              return { chat_id: chatId, command_id: reportCommandId, state: record?.state ?? 'unavailable', link: link(chatId) };
            }
            if (now() >= deadline) return { chat_id: chatId, command_id: reportCommandId, state: 'timed_out', status: record.state, link: link(chatId) };
            await pause(Math.min(250, Math.max(1, deadline - now())), signal);
            const currentSource = await context.resolveTarget(caller.chatId);
            assertChatToolAllowed(caller.policy, name, args, { currentPolicy: currentSource.policy, approvalGranted });
            target = await targetFor(caller, currentSource, chatId);
            if (service.ordinaryReport(caller, target) !== reportCommandId) throw new ChatContractError('policy_denied', 'Reporting authorization expired');
          }
        } else if (selected && (requestedId || !terminal.has(selected.status))) {
          readInput = { chatId, executionId: selected.executionId, timeoutMs, requestKey: toolCallId ?? '' };
          readProof = await confirmTarget('read', readInput, 'Wait for another chat’s result?');
        }
      }
      if (args.execution_id !== undefined && !selected) throw new ChatContractError('request_not_found', 'This execution does not belong to the selected conversation');
      if (!selected || (!reportCommandId && args.execution_id === undefined && terminal.has(selected.status))) return { chat_id: chatId, state: 'no_active_execution', execution_id: null, link: link(chatId) };
      if (selected.executionId === caller.executionId) throw new ChatContractError('wait_cycle', 'An execution cannot wait on itself');
      const release = await beforeWait?.({ caller, chatId, executionId: selected.executionId, signal });
      deadline ??= now() + timeoutMs;
      try {
        for (;;) {
          active(caller, signal);
          const currentSource = await context.resolveTarget(caller.chatId);
          assertChatToolAllowed(caller.policy, name, args, { currentPolicy: currentSource.policy, approvalGranted });
          const currentTarget = await targetFor(caller, currentSource, chatId);
          if (readInput) service.verifyOrdinaryAction(caller, 'read', readInput, currentTarget, readProof);
          if (reportCommandId && service.ordinaryReport(caller, currentTarget) !== reportCommandId) {
            throw new ChatContractError('policy_denied', 'Reporting authorization expired');
          }
          const activity = reads.activity(chatId, selected.executionId), current = activity.execution;
          if (!current) return { chat_id: chatId, execution_id: selected.executionId, state: 'unavailable', link: link(chatId) };
          if (terminal.has(current.status)) return { chat_id: chatId, execution_id: selected.executionId, state: 'terminal', status: current.status,
            assistant_final: reads.finalText(current.executionId), link: link(chatId) };
          if (activity.requests.length || ['waiting_for_input', 'waiting_for_approval', 'waiting_for_host', 'recovery_required'].includes(current.status)) return {
            chat_id: chatId, execution_id: selected.executionId, state: current.status === 'waiting_for_host' ? 'waiting_for_capability' : 'blocked',
            status: current.status, requests: activity.requests, link: link(chatId) };
          if (now() >= deadline) return { chat_id: chatId, execution_id: selected.executionId, state: 'timed_out', status: current.status, link: link(chatId) };
          await pause(Math.min(250, Math.max(1, deadline - now())), signal);
        }
      } finally { await release?.(); }
    },
  };
  return tools;
}

export function installChatTools(runtime, options = {}) {
  const tools = createChatTools({ repository: runtime.repository, context: runtime.context, service: runtime.service,
    validateCaller: runtime.isExecutionCallerActive,
    beforeWait: input => runtime.beginChatWait?.(input),
    coordinationLimits: () => runtime.causality?.limits,
    capabilitiesContext: async (caller, source) => ({
      inherited: await runtime.getSourceModelSelection?.(caller, source) ??
        runtime.repository.getExecution(caller.executionId)?.captured?.modelSelection ?? source.profile?.snapshot?.modelSelection ??
        { providerId: source.chat.providerId, modelId: source.chat.modelId },
      types: await createChatPreparationAdapters().loadSubAgentTypes(),
    }), ...options });
  const dispose = AGENT_CHAT_TOOL_IDS.map(name => runtime.setToolHandler(name, async ({ args, execution, toolContext, signal }) => {
    try {
      const { caller } = await runtime.context.executionCaller(execution.executionId);
      return { content: JSON.stringify(await tools.execute(name, args, { caller, toolCallId: toolContext?.toolCallId, signal,
        approvalGranted: toolContext?.approvalGranted === true, requestOrdinaryConfirmation: toolContext?.requestOrdinaryConfirmation,
        settleOrdinaryCreation: toolContext?.settleOrdinaryCreation })) };
    } catch (error) {
      // Public admission/read failures have a known receipt boundary. Keep them
      // in the tool transcript so the model can handle a refusal or wait cycle.
      // Unknown effects and persistence failures retain the host recovery barrier.
      if (error instanceof ChatContractError && !['internal_error', 'recovery_required'].includes(error.code)) {
        return { content: `Error: ${JSON.stringify(error.toJSON())}` };
      }
      throw error;
    }
  }));
  runtime.chatTools = tools;
  return { tools, dispose() { for (const unregister of dispose) unregister(); } };
}
