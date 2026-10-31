import { normalizeModeId, type ModeId } from '../chat/modes/types';
import { listModes } from '../chat/modes/registry';
import { clearPendingMode } from '../chat/pending-mode';
import { normalizeOrchestratePlanPath } from '../chat/plans/plan-path';
import { findChatById, getActiveChat } from '../state/sessions';
import { launchBoardFromPlan } from '../ui/orchestrate-launch';
import { createChatWithMode } from '../ui/sidebar';
import { setChatMode } from '../ui/mode-selector';
import { enqueueAskQuestion } from './ask-question-queue';
import { validateProposeModeSwitchArgs } from '../../server/runner/mode-proposal.js';
import {
  validateAskQuestionArgs,
  stringifyAskQuestionResult,
} from './ask-question-types';

const HANDOFF_MODES = new Set<ModeId>([
  'general',
  'plan',
  'build',
  'orchestrate',
]);

// ── Set ──────────────────────────────────────────────────────────────────────

/** Change active chat operating mode (browser). */
export function executeSetChatMode(args: Record<string, unknown>, chatId?: string): string {
  const modeRaw = typeof args.mode_id === 'string' ? args.mode_id : typeof args.modeId === 'string' ? args.modeId : '';
  const modeId = normalizeModeId(modeRaw || undefined);
  if (!HANDOFF_MODES.has(modeId)) {
    return `Error: mode_id must be one of: ${[...HANDOFF_MODES].join(', ')}`;
  }

  const chat = chatId ? findChatById(chatId) : getActiveChat();
  if (!chat) return 'Error: chat not found';
  const modeLabel = listModes().find((m) => m.id === modeId)?.label ?? modeId;

  if (chat.modeId === modeId) {
    clearPendingMode(chat);
    return JSON.stringify({ ok: true, modeId, label: modeLabel });
  }

  const result = setChatMode(modeId, chat, true);
  if (!result.ok) {
    return `Error: ${result.error ?? 'could not switch mode'}`;
  }
  clearPendingMode(chat);
  return JSON.stringify({ ok: true, modeId, label: result.label ?? modeId });
}

// ── Create ───────────────────────────────────────────────────────────────────

/** Create a new chat with a given mode and optional plan path (browser). */
export async function executeCreateChatWithMode(args: Record<string, unknown>): Promise<string> {
  const modeRaw = typeof args.mode_id === 'string' ? args.mode_id : typeof args.modeId === 'string' ? args.modeId : '';
  const modeId = normalizeModeId(modeRaw || undefined);
  if (!HANDOFF_MODES.has(modeId)) {
    return `Error: mode_id must be one of: ${[...HANDOFF_MODES].join(', ')}`;
  }

  const planPath =
    typeof args.plan_path === 'string'
      ? args.plan_path.trim()
      : typeof args.planPath === 'string'
        ? args.planPath.trim()
        : '';
  const normalizedPlan = planPath ? normalizeOrchestratePlanPath(planPath) : undefined;

  const initialUserMessage =
    typeof args.initial_user_message === 'string'
      ? args.initial_user_message.trim()
      : typeof args.initialUserMessage === 'string'
        ? args.initialUserMessage.trim()
        : '';

  if (modeId === 'orchestrate') {
    if (normalizedPlan) {
      void launchBoardFromPlan(normalizedPlan);
    } else {
      void import('../orchestrator/boards-view').then(async (m) => {
        await m.openBoardsView();
        const { navigateToCodeBoards } = await import('../os/router');
        navigateToCodeBoards();
      });
    }
    return JSON.stringify({
      ok: true,
      modeId: 'orchestrate',
      ...(normalizedPlan ? { orchestratePlanPath: normalizedPlan } : {}),
      boardLaunched: true,
      chatCreated: false,
    });
  }

  const result = await createChatWithMode({
    modeId,
    orchestratePlanPath: normalizedPlan ?? undefined,
    initialUserMessage: initialUserMessage || undefined,
  });

  if (!result.ok) {
    return `Error: ${result.error ?? 'could not create chat'}`;
  }

  return JSON.stringify({
    ok: true,
    chatId: result.chatId,
    modeId: result.modeId,
    orchestratePlanPath: result.orchestratePlanPath ?? null,
  });
}

/** Standard mode-handoff multiple-choice via ask_question UI. */
export async function executeProposeModeSwitch(
  args: Record<string, unknown>,
  context: { subAgentType?: string; chatId?: string },
): Promise<string> {
  const proposal = validateProposeModeSwitchArgs(args);
  if (!proposal.ok) return proposal.error;
  const askArgs = proposal.args;
  const parsed = validateAskQuestionArgs(askArgs);
  if (parsed.ok === false) {
    return stringifyAskQuestionResult({ status: 'error', message: parsed.error });
  }

  return enqueueAskQuestion(
    parsed.args,
    {
      subAgentType: context.subAgentType,
    },
    context.chatId,
  );
}
