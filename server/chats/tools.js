import { ChatContractError, CHAT_EXECUTION_STATES, validateChatId } from './contracts.js';
import { assertExecutionCaller, assertCallerCanTarget } from './caller.js';
import { assertChatToolAllowed } from './policy.js';
import { listAgentCapabilities } from './capabilities.js';
import { createChatPreparationAdapters } from './preparation.js';
import { getAgentConversationsFeature } from './feature.js';
import { AGENT_CHAT_TOOL_IDS } from './tool-catalog.js';
import { createChatToolReads } from './tool-reads.js';

const terminal = new Set(['completed', 'failed', 'stopped', 'recovery_required']);
const recoveryTools = new Set(['chat_list', 'chat_read', 'chat_wait', 'chat_stop']);
const argumentNames = {
  agent_capabilities: ['search', 'cursor', 'limit'],
  chat_list: ['query', 'status', 'include_subagents', 'cursor', 'limit'],
  chat_read: ['chat_id', 'view', 'after_sequence', 'limit'],
  chat_send: ['chat_id', 'message', 'mode', 'client_request_id'],
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
function integer(value, fallback, minimum, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail('Conversation limit is outside its supported range');
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
    async execute(name, args = {}, { caller, toolCallId, signal, approvalGranted = false } = {}) {
      if (!AGENT_CHAT_TOOL_IDS.includes(name)) fail('Unknown conversation tool');
      fields(args, argumentNames[name]);
      active(caller, signal);
      const state = feature();
      if (!state.creationEnabled && !(state.recoveryEnabled && recoveryTools.has(name))) throw new ChatContractError('capability_disabled', 'Conversation coordination is not enabled');
      const source = await context.resolveTarget(caller.chatId);
      active(caller, signal);
      assertChatToolAllowed(caller.policy, name, args, { currentPolicy: source.policy, approvalGranted });
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
        const include = args.include_subagents === true, limit = integer(args.limit, 20, 1, 100);
        let position = 0;
        if (args.cursor !== undefined) {
          if (typeof args.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(args.cursor)) fail('Invalid conversation cursor');
          let cursor;
          try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); } catch { fail('Invalid conversation cursor'); }
          if (cursor?.version !== 1 || cursor.projectId !== source.scope.projectId || cursor.query !== query ||
              cursor.status !== (args.status ?? null) || cursor.include !== include) fail('Conversation cursor does not match this query');
          position = integer(cursor.position, 0, 0, Number.MAX_SAFE_INTEGER);
        }
        const candidates = reads.candidates(position, 201, include), chats = [];
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
        const after = integer(args.after_sequence, -1, -1, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 20, 1, 100);
        const target = await targetFor(caller, source, args.chat_id); active(caller, signal);
        const activity = reads.activity(target.chat.id);
        return { chat_id: target.chat.id, title: String(target.chat.name ?? '').slice(0, 240), link: link(target.chat.id), ...activity,
          ...(view === 'messages' ? reads.messages(target.chat.id, after, limit) : {}) };
      }
      if (name === 'chat_send') {
        fields(args, ['chat_id', 'message', 'mode', 'client_request_id']);
        const chatId = id(args.chat_id), message = text(args.message, 120000), mode = args.mode ?? 'auto';
        if (!['auto', 'queue', 'steer'].includes(mode)) fail('Choose auto, queue or steer');
        const key = text(args.client_request_id ?? toolCallId, 256); active(caller, signal);
        return service.send(caller, { chatId, message, mode, clientRequestId: key });
      }
      if (name === 'chat_stop') {
        fields(args, ['chat_id', 'execution_id', 'scope', 'client_request_id']);
        const chatId = id(args.chat_id), scope = args.scope ?? 'turn';
        if (!['turn', 'tree'].includes(scope)) fail('Choose turn or tree');
        if (chatId === caller.chatId && scope === 'tree') throw new ChatContractError('policy_denied', 'Use turn scope to stop the current execution; its tree must be stopped from another conversation or human control');
        const key = text(args.client_request_id ?? toolCallId, 256); active(caller, signal);
        return service.stop(caller, { chatId, scope, clientRequestId: key, ...(args.execution_id !== undefined ? { executionId: id(args.execution_id) } : {}) });
      }
      fields(args, ['chat_id', 'execution_id', 'timeout_ms']);
      const chatId = id(args.chat_id), timeoutMs = integer(args.timeout_ms, 10000, 0, 60000);
      await targetFor(caller, source, chatId); active(caller, signal);
      const selected = reads.execution(chatId, args.execution_id === undefined ? undefined : id(args.execution_id));
      if (args.execution_id !== undefined && !selected) throw new ChatContractError('request_not_found', 'This execution does not belong to the selected conversation');
      if (!selected || (args.execution_id === undefined && terminal.has(selected.status))) return { chat_id: chatId, state: 'no_active_execution', execution_id: null, link: link(chatId) };
      if (selected.executionId === caller.executionId) throw new ChatContractError('wait_cycle', 'An execution cannot wait on itself');
      const release = await beforeWait?.({ caller, chatId, executionId: selected.executionId, signal });
      const deadline = now() + timeoutMs;
      try {
        for (;;) {
          active(caller, signal);
          const currentSource = await context.resolveTarget(caller.chatId);
          assertChatToolAllowed(caller.policy, name, args, { currentPolicy: currentSource.policy, approvalGranted });
          await targetFor(caller, currentSource, chatId);
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
        approvalGranted: toolContext?.approvalGranted === true })) };
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
