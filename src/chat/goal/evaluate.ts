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
import { setGoalEvaluating } from './evaluating-state';
import { finishGoalEvalSession, startGoalEvalSession } from './eval-session';
import { parseGoalEvalResponse } from './parse-response';
import type { ParsedGoalEvalResponse } from './parse-response';

export interface GoalEvaluationResult {
  met: boolean;
  reason: string;
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

export async function maybeContinueGoalAfterTurn(chat: Chat): Promise<void> {
  if (!isGoalLoopActive(chat)) return;

  const goal = getActiveGoal(chat);
  if (!goal) return;

  goal.turnCount += 1;
  touchChat(chat);
  scheduleSaveSessions();

  startGoalEvalSession(chat.id, goal.conditionText);
  setGoalEvaluating(chat.id, true);
  syncGoalEvalUi(chat.id);
  let result: GoalEvaluationResult;
  try {
    result = await evaluateGoal(chat);
  } finally {
    setGoalEvaluating(chat.id, false);
    syncGoalEvalUi(chat.id);
  }
  if (getActiveGoal(chat) !== goal) return;
  goal.lastReason = result.reason;

  if (result.met) {
    goal.achieved = true;
    await recordGoalAchieved(chat, result.reason);
    touchChat(chat);
    scheduleSaveSessions();
    syncGoalActiveHint();
    renderSidebar();
    return;
  }

  touchChat(chat);
  scheduleSaveSessions();
  syncGoalActiveHint();

  const directive = buildGoalContinuationMessage(goal.conditionText, result.reason);
  await resumeParentChatWithMessage(chat, directive, { goalDriven: true });
}
