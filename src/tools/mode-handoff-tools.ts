import { normalizeModeId, type ModeId } from '../chat/modes/types';
import { listModes } from '../chat/modes/registry';
import { clearPendingMode } from '../chat/pending-mode';
import { normalizeOrchestratePlanPath } from '../chat/plans/plan-path';
import { findChatById, getActiveChat } from '../state/sessions';
import { launchBoardFromPlan } from '../ui/orchestrate-launch';
import { createChatWithMode } from '../ui/sidebar';
import { setChatMode } from '../ui/mode-selector';
import { enqueueAskQuestion } from './ask-question-queue';
import {
  validateAskQuestionArgs,
  stringifyAskQuestionResult,
  type AskQuestionArgs,
  type AskQuestionAnswerEntry,
  type AskQuestionToolResult,
} from './ask-question-types';

const HANDOFF_MODES = new Set<ModeId>([
  'general',
  'plan',
  'build',
  'orchestrate',
]);

type HandoffSituation =
  | 'plan_complete'
  | 'implement_in_wrong_mode'
  | 'plan_in_build';

// ── Propose ──────────────────────────────────────────────────────────────────

/** Preset ask_question payloads per situation. */
function buildProposeModeSwitchQuestions(
  situation: HandoffSituation,
  planPath?: string,
): AskQuestionArgs {
  const planHint = planPath?.trim() ? ` (${planPath})` : '';

  if (situation === 'plan_complete') {
    return {
      title: 'Plan ready',
      questions: [
        {
          id: 'next_step',
          prompt: `The plan${planHint} is saved. What should we do next?`,
          options: [
            {
              id: 'orchestrate_new',
              label: 'Open on Boards',
              description: 'Create a V2 board from this plan. Opens Boards, not a chat.',
            },
            {
              id: 'stay_plan',
              label: 'Stay in Plan',
              description: 'Keep refining the plan in this chat.',
            },
            {
              id: 'build_here',
              label: 'Implement in Build (this chat)',
              description: 'Switch this chat to Build and start coding.',
            },
          ],
        },
      ],
    };
  }

  if (situation === 'implement_in_wrong_mode') {
    return {
      title: 'Switch mode?',
      questions: [
        {
          id: 'mode_switch',
          prompt: 'Implementation needs Build mode. How do you want to proceed?',
          options: [
            {
              id: 'build',
              label: 'Switch to Build',
              description: 'Change this chat to Build mode.',
            },
            {
              id: 'stay',
              label: 'Stay in current mode',
              description: 'Continue without switching (limited tools).',
            },
          ],
        },
      ],
    };
  }

  if (situation === 'plan_in_build') {
    return {
      title: 'Switch mode?',
      questions: [
        {
          id: 'mode_switch',
          prompt: 'Planning works best in Plan mode. Switch?',
          options: [
            {
              id: 'plan',
              label: 'Switch to Plan',
              description: 'Change this chat to Plan mode.',
            },
            {
              id: 'stay_build',
              label: 'Stay in Build',
              description: 'Keep planning informally in Build.',
            },
          ],
        },
      ],
    };
  }

  throw new Error(`Unknown handoff situation: ${String(situation)}`);
}

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

/** Whether plan_complete handoff picked the orchestrator board launch option. */
export function isPlanCompleteOrchestrateNewChoice(
  answers: AskQuestionAnswerEntry[],
): boolean {
  const entry = answers.find((answer) => answer.questionId === 'next_step');
  return entry?.selectedIds.includes('orchestrate_new') === true;
}

function parseAskQuestionToolContent(content: string): AskQuestionToolResult | null {
  try {
    return JSON.parse(content) as AskQuestionToolResult;
  } catch {
    return null;
  }
}

/** Launch the orchestrator board when plan_complete handoff chose orchestrate_new. */
function applyPlanCompleteOrchestrateHandoff(
  situation: HandoffSituation,
  planPath: string | undefined,
  content: string,
): void {
  if (situation !== 'plan_complete') return;
  const normalizedPlan = planPath?.trim()
    ? normalizeOrchestratePlanPath(planPath.trim())
    : undefined;
  if (!normalizedPlan) return;

  const parsed = parseAskQuestionToolContent(content);
  if (!parsed || parsed.status !== 'answered') return;
  if (!isPlanCompleteOrchestrateNewChoice(parsed.answers)) return;

  void launchBoardFromPlan(normalizedPlan);
}

// ── Create ───────────────────────────────────────────────────────────────────

/** Create a new chat with a given mode and optional plan path (browser). */
export function executeCreateChatWithMode(args: Record<string, unknown>): string {
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

  const result = createChatWithMode({
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
  const situationRaw =
    typeof args.situation === 'string' ? args.situation.trim() : '';
  const validSituations = new Set<HandoffSituation>([
    'plan_complete',
    'implement_in_wrong_mode',
    'plan_in_build',
  ]);
  if (!validSituations.has(situationRaw as HandoffSituation)) {
    return `Error: situation must be one of: ${[...validSituations].join(', ')}`;
  }

  const planPath =
    typeof args.plan_path === 'string'
      ? args.plan_path.trim()
      : typeof args.planPath === 'string'
        ? args.planPath.trim()
        : undefined;

  const askArgs = buildProposeModeSwitchQuestions(
    situationRaw as HandoffSituation,
    planPath,
  );
  const parsed = validateAskQuestionArgs(askArgs);
  if (parsed.ok === false) {
    return stringifyAskQuestionResult({ status: 'error', message: parsed.error });
  }

  const content = await enqueueAskQuestion(
    parsed.args,
    {
      subAgentType: context.subAgentType,
    },
    context.chatId,
  );
  const parsedAnswer = parseAskQuestionToolContent(content);
  applyPlanCompleteOrchestrateHandoff(
    situationRaw as HandoffSituation,
    planPath,
    content,
  );
  if (
    situationRaw === 'plan_complete' &&
    parsedAnswer?.status === 'answered' &&
    isPlanCompleteOrchestrateNewChoice(parsedAnswer.answers)
  ) {
    return JSON.stringify({
      ...parsedAnswer,
      boardLaunched: true,
      handoffNote:
        'The orchestrator board is already open for this plan. Do not call create_chat_with_mode.',
    });
  }
  return content;
}
