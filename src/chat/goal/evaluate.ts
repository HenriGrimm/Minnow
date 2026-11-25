import {
  ensureChatHistoryLoaded,
  getActiveGoal,
  isGoalLoopActive,
  recordChatMessage,
  requireHistory,
  scheduleSaveSessions,
  touchChat,
} from '../../state/sessions';
import type { ActiveGoalState, Chat } from '../../types';
import { resumeParentChatWithMessage } from '../run-turn-chat';
import { isStreamDomVisible } from '../streaming-state';
import { appendBubble } from '../../ui/messages';
import { scrollChatIfPinned } from '../../ui/chat-scroll';
import { markMessageGoalAchieved } from '../../ui/goal-affordance';
import { syncGoalActiveHint } from '../../ui/goal-active-hint';
import { renderSidebar } from '../../ui/sidebar';
import { runGoalEvalAgent, setGoalEvalAgentImplForTests, setGoalEvalPortFactoryForTests } from './eval-agent';
import type { GoalEvalAgentResult } from './eval-agent';
import {
  MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS,
  MIN_GOAL_TURNS_BEFORE_PASS,
} from './eval-tools';
import { syncGoalEvalUi } from '../../ui/goal-eval-status';
import { isGoalEvaluating, setGoalEvaluating } from './evaluating-state';
import { finishGoalEvalSession, patchGoalEvalSession, startGoalEvalSession } from './eval-session';
import { parseGoalEvalResponse } from './parse-response';
import type { ParsedGoalEvalResponse } from './parse-response';
import { isChatTurnInProgress } from '../chat-turn-guard';

export interface GoalEvaluationResult {
  met: boolean;
  reason: string;
  /** No verdict could be produced (evaluator model/config/provider failure). */
  failed?: boolean;
}

export { setGoalEvalAgentImplForTests, setGoalEvalPortFactoryForTests };

let goalEvalImpl: typeof runGoalEvalRequest = runGoalEvalRequest;

/** Replace evaluator request impl (unit tests). */
export function setGoalEvalImplForTests(
  impl: typeof runGoalEvalRequest | null,
): void {
  goalEvalImpl = impl ?? runGoalEvalRequest;
}

export function enforceGoalPassGates(
  parsed: ParsedGoalEvalResponse,
  goal: ActiveGoalState,
  agentResult: Pick<GoalEvalAgentResult, 'verificationToolCalls'>,
): ParsedGoalEvalResponse {
  if (!parsed.met) return parsed;

  if (goal.turnCount < MIN_GOAL_TURNS_BEFORE_PASS) {
    return {
      met: false,
      reason: `Pass blocked: at least ${MIN_GOAL_TURNS_BEFORE_PASS} goal turns required before achievement (currently ${goal.turnCount}).`,
    };
  }

  if (agentResult.verificationToolCalls < MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS) {
    return {
      met: false,
      reason: `Pass blocked: evaluator ran only ${agentResult.verificationToolCalls} verification tool call(s); minimum ${MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS} required.`,
    };
  }

  return parsed;
}

async function runGoalEvalRequest(
  chat: Chat,
  conditionText: string,
  signal: AbortSignal,
): Promise<GoalEvaluationResult> {
  const goal = getActiveGoal(chat);
  if (!goal) {
    finishGoalEvalSession(chat.id, {
      met: false,
      reason: 'No active goal.',
      rawVerdict: '',
      verificationToolCalls: 0,
    });
    return { met: false, reason: 'No active goal.' };
  }

  const agentResult = await runGoalEvalAgent(chat, conditionText, signal);
  if (agentResult.failed) {
    const reason = parseGoalEvalResponse(agentResult.raw).reason;
    finishGoalEvalSession(chat.id, {
      met: false,
      reason,
      rawVerdict: agentResult.raw,
      verificationToolCalls: agentResult.verificationToolCalls,
    });
    patchGoalEvalSession(chat.id, { status: 'failed' });
    return { met: false, reason, failed: true };
  }
  const parsed = parseGoalEvalResponse(agentResult.raw);
  const gated = enforceGoalPassGates(parsed, goal, agentResult);
  finishGoalEvalSession(chat.id, {
    met: gated.met,
    reason: gated.reason,
    rawVerdict: agentResult.raw,
    verificationToolCalls: agentResult.verificationToolCalls,
  });
  return gated;
}

export function shouldEvaluateGoalAfterTurn(chat: Chat, goalDriven: boolean): boolean {
  return goalDriven || isGoalLoopActive(chat);
}

/** Call the configured goal-eval model once after a goal-driven turn. */
export async function evaluateGoal(chat: Chat): Promise<GoalEvaluationResult> {
  const goal = getActiveGoal(chat);
  if (!goal) {
    return { met: false, reason: 'No active goal.' };
  }

  const controller = new AbortController();
  return goalEvalImpl(chat, goal.conditionText, controller.signal);
}

/** User-visible continuation directive after a failed evaluation. */
export function buildGoalContinuationMessage(
  conditionText: string,
  evaluatorReason: string,
): string {
  return [
    'Continue working toward the active goal.',
    '',
    `Goal: ${conditionText}`,
    '',
    `Evaluator feedback: ${evaluatorReason}`,
    '',
    'Next steps:',
    '- Re-read every changed file and confirm the diff matches your claims.',
    '- Run the full relevant test suite, typecheck, or build and fix any failures.',
    '- For UI or user-facing work, verify in the browser (navigate, snapshot, interact).',
    '- Do not claim the goal is done in prose alone — produce verifiable evidence.',
  ].join('\n');
}

/** Persist and optionally render the achieved marker row. */
export async function recordGoalAchieved(chat: Chat, reason: string): Promise<void> {
  const content = `Goal achieved: ${reason}`;
  await ensureChatHistoryLoaded(chat.id);
  const history = requireHistory(chat);
  history.push({ role: 'user', content, goalAchieved: true });
  recordChatMessage(chat);
  touchChat(chat);
  scheduleSaveSessions();

  if (!isStreamDomVisible(chat.id)) return;

  const historyIndex = history.length - 1;
  const { wrap } = appendBubble('user', content, {
    historyIndex,
    turnKind: 'user',
    chatId: chat.id,
  });
  markMessageGoalAchieved(wrap);
  scrollChatIfPinned();
}

const MANAGED_SETTLED_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'recovery_required']);

/** A turn is running or queued, so evaluating now would race the agent. */
export function isGoalTurnBusy(chat: Chat): boolean {
  if (isChatTurnInProgress(chat.id)) return true;
  if (chat.chatCommandVersion !== 1) return false;
  const status = chat.agentExecution?.status;
  return Boolean(chat.agentPendingCommand) || Boolean(status && !MANAGED_SETTLED_STATUSES.has(status));
}

async function defaultContinueGoalTurn(chat: Chat, directive: string): Promise<void> {
  const requiredSkillId = getActiveGoal(chat)?.skillId;
  if (requiredSkillId || chat.chatCommandVersion === 1) {
    // A goal-owned skill needs its instructions on each new turn.
    const { sendProgrammaticChatText } = await import('../messaging');
    await sendProgrammaticChatText(chat, directive, { requiredSkillId, goalDriven: true, parseSlash: false, clearComposerOnSend: false });
    return;
  }
  await resumeParentChatWithMessage(chat, directive, { goalDriven: true });
}

let continueGoalTurnImpl: (chat: Chat, directive: string) => Promise<void> = defaultContinueGoalTurn;

/** Replace the continuation send (unit tests). */
export function setGoalContinuationForTests(impl: ((chat: Chat, directive: string) => Promise<void>) | null): void {
  continueGoalTurnImpl = impl ?? defaultContinueGoalTurn;
}

function settleGoalUi(): void {
  syncGoalActiveHint();
  renderSidebar();
}

export async function maybeContinueGoalAfterTurn(chat: Chat): Promise<void> {
  if (chat.activeGoal?.factoryRunId || !isGoalLoopActive(chat)) return;
  // One evaluation at a time, and never while the agent is still working.
  if (isGoalEvaluating(chat.id) || isGoalTurnBusy(chat)) return;

  const goal = getActiveGoal(chat);
  if (!goal) return;

  goal.turnCount += 1;
  delete goal.paused;
  touchChat(chat);
  scheduleSaveSessions();

  startGoalEvalSession(chat.id, goal.conditionText);
  setGoalEvaluating(chat.id, true);
  syncGoalEvalUi(chat.id);
  let result: GoalEvaluationResult;
  try {
    // Background server-run chats may not have their transcript in memory yet.
    await ensureChatHistoryLoaded(chat.id);
    result = await evaluateGoal(chat);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { met: false, reason: `Goal evaluator failed: ${message}`, failed: true };
    patchGoalEvalSession(chat.id, { status: 'failed', endedAt: Date.now(), met: false, reason: result.reason, liveCurrentToolName: undefined });
  } finally {
    setGoalEvaluating(chat.id, false);
    syncGoalEvalUi(chat.id);
  }
  if (getActiveGoal(chat) !== goal) return;
  goal.lastReason = result.reason;
  touchChat(chat);
  scheduleSaveSessions();

  if (result.met) {
    goal.achieved = true;
    // Server-run transcripts are written only by the server; keep the marker in goal state.
    if (chat.chatCommandVersion !== 1) await recordGoalAchieved(chat, result.reason);
    touchChat(chat);
    scheduleSaveSessions();
    settleGoalUi();
    return;
  }

  if (result.failed) {
    // Without a verdict, continuing would re-run the agent on an error message forever.
    // Pause until the user resumes from the Goal popover after fixing the evaluator model.
    goal.paused = true;
    goal.lastReason = `Paused: ${result.reason}`;
    settleGoalUi();
    return;
  }

  syncGoalActiveHint();
  // The user may have sent another message during evaluation; its completion re-evaluates.
  if (isGoalTurnBusy(chat)) return;
  const directive = buildGoalContinuationMessage(goal.conditionText, result.reason);
  try {
    await continueGoalTurnImpl(chat, directive);
  } catch (error) {
    if (getActiveGoal(chat) !== goal) return;
    goal.paused = true;
    goal.lastReason = `Paused: could not continue the goal: ${error instanceof Error ? error.message : String(error)}`;
    touchChat(chat);
    scheduleSaveSessions();
    settleGoalUi();
  }
}

const MANAGED_STOPPED_STATUSES = new Set(['failed', 'stopped', 'stopping', 'cancelled', 'recovery_required']);
/** Server executions observed while a goal was active, keyed by chat id. */
const managedGoalExecutions = new Map<string, string>();

/** Forget observed executions (unit tests). */
export function resetManagedGoalExecutionsForTests(): void {
  managedGoalExecutions.clear();
}

/**
 * Server-run chats settle outside the renderer turn loop. Continue the goal once
 * per execution that this window saw running and then complete; an execution
 * that was already complete when first observed (reload, reconnect) never
 * starts an evaluation on its own.
 */
export function noteManagedGoalExecution(
  chat: Chat,
  execution: { executionId: string; status: string } | undefined = chat.agentExecution,
  continueGoal: (chat: Chat) => Promise<void> = maybeContinueGoalAfterTurn,
): void {
  if (chat.chatCommandVersion !== 1 || !execution?.executionId) return;
  if (chat.activeGoal?.factoryRunId || !isGoalLoopActive(chat) || MANAGED_STOPPED_STATUSES.has(execution.status)) {
    managedGoalExecutions.delete(chat.id);
    return;
  }
  if (execution.status !== 'completed') {
    managedGoalExecutions.set(chat.id, execution.executionId);
    return;
  }
  if (managedGoalExecutions.get(chat.id) !== execution.executionId) return;
  managedGoalExecutions.delete(chat.id);
  void continueGoal(chat).catch(() => {});
}
