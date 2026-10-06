/**
 * User-triggered repair of an unparseable board plan (Orchestrator V2 §5.9.4).
 *
 * Boards stays the surface: send the repair task as a regular turn in a
 * dedicated Plan chat (never steal `sessionState.activeId` — MIN-637), wait for
 * the turn, then retry `POST /api/boards`. The chat stays in the sidebar so the
 * user can open it, follow along, or keep talking to it. The parse pane owns
 * status; this module does not toast.
 */

import type { ParseError } from '../../server/orchestrator/core/types';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { ensureBackgroundChat } from '../state/background-chat';
import { getWorkspacePath } from '../state/workspace';
import type { Chat } from '../types';
import { createBoardFromPlan, PlanParseFailure } from './client';

/** Narrow repair contract repeated in the message so the agent does not need to guess. */
const PLAN_REPAIR_RULES = `Edit the file in place with schema and dependency corrections only. Change just the lines the errors point at; do not rewrite or regenerate the whole plan:
- Keep the same waves, task ids, and intent. Do not split, merge, re-id, or invent work.
- Normalize headings to \`#\` title, \`## Wave Breakdown\`, \`### Wave N — Name\`, \`#### Task W1-A: Title\`.
- Every task needs \`- **Build:**\`, \`- **Test:**\`, \`- **Accept:**\`, \`- **Touches:**\`. Fill gaps from surrounding prose.
- YAML front matter needs \`name\` and a \`todos\` list whose ids match the \`#### Task\` headings one-to-one.
- Placeholder Depends on values (none, nothing, n/a) mean no dependencies.
- If an error names a missing task dependency, add that task id to the consumer's Depends on list. Do not change task implementation or scope.
- Use targeted edits on this path (replace_text_in_file, insert_at_line). Do not save_file the whole plan, and no sidecar copy.

Boards retries the plan as soon as this turn ends. When the edits are done, reply with a one-line summary — no follow-up questions or mode handoff.`;

export interface StartPlanRepairInput {
  planPath: string;
  errors: ParseError[];
  boardId?: string;
  createBoard?: (
    planPath: string,
    options?: { boardId?: string; markdown?: string },
  ) => Promise<{ boardId: string }>;
}

/** Test seams — production callers omit these and use the live chat engine. */
export interface PlanRepairHooks {
  ensureBackgroundChat?: typeof ensureBackgroundChat;
  /** Run one turn in `chat`; rejects when the turn did not complete. */
  sendChatText?: (chat: Chat, text: string) => Promise<void>;
  /** True while `chat` already has a turn running or starting. */
  isChatBusy?: (chatId: string) => boolean | Promise<boolean>;
  /** Stop the running turn in `chatId`. */
  stopChat?: (chatId: string) => void | Promise<void>;
}

export type StartPlanRepairResult =
  | { ok: true; boardId: string }
  | { ok: false; alreadyRunning: true }
  | { ok: false; parseFailure: PlanParseFailure }
  | { ok: false; error: string };

type RunningRepair = {
  chatId: string;
  stop: (chatId: string) => void | Promise<void>;
};

/** One in-flight repair per chat key so a second click cannot double-send. */
const runningByKey = new Map<string, RunningRepair>();
/** Keys the user cancelled; the turn's rejection reads as a cancel, not a failure. */
const cancelledKeys = new Set<string>();

/** Stable chat identity: one repair chat per workspace + plan path. */
export function planRepairBackgroundKey(workspacePath: string, planPath: string): string {
  return `plan-repair:${normalizeWorkspacePath(workspacePath)}:${planPath.trim()}`;
}

/** Format parse errors the same way the REST 400 body does. */
function formatParseErrorsForTask(errors: ParseError[]): string {
  return errors
    .map((error) => `line ${error.line}:${error.column} — ${error.message}\n    hint: ${error.hint}`)
    .join('\n');
}

/** Chat message: path, line errors, and narrow repair rules. */
export function buildPlanRepairTask(planPath: string, errors: ParseError[]): string {
  const path = planPath.trim();
  return [
    `Repair the plan at \`${path}\` so parsePlan accepts it.`,
    '',
    'Parse errors:',
    formatParseErrorsForTask(errors),
    '',
    PLAN_REPAIR_RULES,
  ].join('\n');
}

function resolveRepairKey(planPath: string): string {
  return planRepairBackgroundKey(getWorkspacePath(), planPath);
}

async function sendRepairTurn(chat: Chat, text: string): Promise<void> {
  const { sendProgrammaticChatText } = await import('../chat/messaging');
  await sendProgrammaticChatText(chat, text, {
    parseSlash: false,
    ownsGlobalStreaming: false,
    requireCompletedTurn: true,
    reportStatus: () => {},
  });
}

async function isRepairChatBusy(chatId: string): Promise<boolean> {
  const [{ isChatStreaming }, { isChatTurnSetupPending }] = await Promise.all([
    import('../chat/streaming-state'),
    import('../chat/chat-turn-guard'),
  ]);
  return isChatStreaming(chatId) || isChatTurnSetupPending(chatId);
}

async function stopRepairChat(chatId: string): Promise<void> {
  const { stopGeneration } = await import('../chat/stop-generation');
  stopGeneration(chatId);
}

/** Drop in-flight markers between unit tests. */
export function resetPlanRepairForTests(): void {
  runningByKey.clear();
  cancelledKeys.clear();
}

/**
 * Send the repair task to the plan's repair chat, wait for the turn, then retry
 * board create. Never assigns `sessionState.activeId`.
 */
export async function startPlanRepair(
  input: StartPlanRepairInput,
  hooks: PlanRepairHooks = {},
): Promise<StartPlanRepairResult> {
  const planPath = input.planPath.trim();
  if (!planPath) return { ok: false, error: 'Plan path is missing' };

  const ensureChat = hooks.ensureBackgroundChat ?? ensureBackgroundChat;
  const send = hooks.sendChatText ?? sendRepairTurn;
  const isBusy = hooks.isChatBusy ?? isRepairChatBusy;
  const stop = hooks.stopChat ?? stopRepairChat;
  const createBoard = input.createBoard ?? createBoardFromPlan;

  const workspacePath = getWorkspacePath();
  const key = planRepairBackgroundKey(workspacePath, planPath);
  if (runningByKey.has(key)) return { ok: false, alreadyRunning: true };

  const chat = ensureChat({
    key,
    name: 'Repair plan',
    workspacePath: workspacePath || undefined,
    modeId: 'plan',
  });
  if (!chat) return { ok: false, error: 'Sessions are not ready yet' };

  // Mark the key before any await so a second click cannot race a duplicate turn.
  runningByKey.set(key, { chatId: chat.id, stop });
  cancelledKeys.delete(key);

  let failure: string | null = null;
  try {
    // The user may already be talking to this chat; do not queue over their turn.
    if (await isBusy(chat.id)) return { ok: false, alreadyRunning: true };
    if (!cancelledKeys.has(key)) {
      await send(chat, buildPlanRepairTask(planPath, input.errors));
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    runningByKey.delete(key);
  }

  if (cancelledKeys.delete(key)) return { ok: false, error: 'Repair cancelled' };
  if (failure !== null) return { ok: false, error: failure };

  try {
    const created = await createBoard(planPath, {
      ...(input.boardId?.trim() ? { boardId: input.boardId.trim() } : {}),
    });
    return { ok: true, boardId: created.boardId };
  } catch (err) {
    if (err instanceof PlanParseFailure) return { ok: false, parseFailure: err };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stop the in-flight repair turn for this plan, if any. */
export function cancelPlanRepair(planPath: string, hooks: PlanRepairHooks = {}): void {
  const key = resolveRepairKey(planPath);
  const running = runningByKey.get(key);
  if (!running) return;
  cancelledKeys.add(key);
  const stop = hooks.stopChat ?? running.stop;
  void Promise.resolve(stop(running.chatId)).catch(() => {});
}
