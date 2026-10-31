import { validateTodoWriteArgs, formatTodoProgress } from '../runner/todo-write.js';
import { validateProposeModeSwitchArgs } from '../runner/mode-proposal.js';
import { loadChatPreparationComposer } from './preparation.js';
import { assertChatToolAllowed, intersectChatPolicies } from './policy.js';
import { ChatContractError } from './contracts.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../runner/run-turn.js';

function present(callback, value) {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* State is already durable. */ }
}

/** Chat-owned state and human proposals use the same validation as normal Code. */
export async function executeConversationTool(name, args, context) {
  if (!['todo_write', 'propose_mode_switch'].includes(name)) return null;
  const { repository, execution, fence, prepared, requests, signal } = context;
  if (!repository || !execution || execution.executionId !== fence?.executionId) {
    throw new ChatContractError('caller_not_active', 'Conversation tools require the owning execution');
  }
  signal?.throwIfAborted();
  repository.assertFence(execution.chatId, fence);
  const currentPolicy = context.currentPolicy ?? prepared.policy;
  assertChatToolAllowed(prepared.policy, name, args, { currentPolicy, approvalGranted: true });
  if (name === 'todo_write') {
    const validated = validateTodoWriteArgs(args);
    if (!validated.ok) return { content: validated.error };
    const todos = validated.args.todos;
    repository.setTranscriptMeta(execution.chatId, { todos: todos.length ? todos : null,
      todosUpdatedAt: todos.length ? (context.now ?? Date.now)() : null }, { fence });
    present(context.onChange, execution.chatId);
    return { content: JSON.stringify({ progress: formatTodoProgress(todos), todos }) };
  }
  const proposal = validateProposeModeSwitchArgs(args);
  if (!proposal.ok) return { content: proposal.error };
  const composer = await (context.loadComposer ?? loadChatPreparationComposer)();
  const parsed = composer.validateAskQuestionArgs(proposal.args);
  if (!parsed.ok) return { content: composer.stringifyAskQuestionResult({ status: 'error', message: parsed.error }) };
  const effective = intersectChatPolicies(prepared.policy, currentPolicy);
  if (!effective.toolPermissions.ask_question || effective.toolPermissions.ask_question === 'off') {
    return { content: composer.stringifyAskQuestionResult({ status: 'error', message: 'ask_question is disabled for this conversation; no mode question was opened.' }) };
  }
  if (!requests || !context.toolCallId) throw new ChatContractError('capability_unavailable', 'A mode proposal requires a durable request service and tool call identity');
  const request = requests.open({ chatId: execution.chatId, executionId: execution.executionId, toolCallId: context.toolCallId,
    kind: 'question', title: parsed.args.title ?? 'Switch mode?', presentation: { question: parsed.args }, fence });
  const timeoutMs = typeof context.askTimeoutMs === 'number' && Number.isFinite(context.askTimeoutMs) && context.askTimeoutMs > 0
    ? Math.min(DEFAULT_ASK_TIMEOUT_MS, Math.floor(context.askTimeoutMs)) : DEFAULT_ASK_TIMEOUT_MS;
  const waitSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  repository.updateExecution(execution.executionId, { status: 'waiting_for_input' }, { fence });
  present(context.onStatus, { chatId: execution.chatId, executionId: execution.executionId, status: 'waiting_for_input' });
  try {
    const answer = await requests.wait(request.requestId, { signal: waitSignal });
    // A choice is returned to the model; changing mode is a separate operation
    // whose live policy ceiling is still enforced by the runtime.
    return { content: typeof answer === 'string' ? answer : JSON.stringify(answer) };
  } catch (error) {
    if (waitSignal.aborted && !signal?.aborted) {
      return { content: composer.stringifyAskQuestionResult({ status: 'error', message: 'Mode proposal timed out before an answer was received.' }) };
    }
    if (signal?.aborted || error?.code === 'request_expired') {
      return { content: composer.stringifyAskQuestionResult({ status: 'cancelled', answers: [] }) };
    }
    throw error;
  } finally {
    if (!signal?.aborted && repository.getExecution(execution.executionId)?.status === 'waiting_for_input') {
      repository.updateExecution(execution.executionId, { status: 'running' }, { fence });
      present(context.onStatus, { chatId: execution.chatId, executionId: execution.executionId, status: 'running' });
    }
    present(context.onChange, execution.chatId);
  }
}
