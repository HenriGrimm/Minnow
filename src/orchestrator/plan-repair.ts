/**
 * User-triggered repair of an unparseable board plan (Orchestrator V2 §5.9.4).
 *
 * Boards stays the surface: spawn `plan-repairer` in a background Plan chat
 * (never steal `sessionState.activeId` — MIN-637), wait, then retry
 * `POST /api/boards`. The parse pane owns status; this module does not toast.
 */

import type { ParseError } from '../../server/orchestrator/core/types';
import {
  cancelSubAgent,
  getSubAgentRun,
  spawnSubAgent,
  waitForSubAgent,
} from '../agents/orchestrator';
import { isSubAgentRunSuccessful } from '../agents/sub-agent-outcome';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { ensureBackgroundChat } from '../state/background-chat';
import { getWorkspacePath } from '../state/workspace';
import { createBoardFromPlan, PlanParseFailure } from './client';

/** Narrow repair contract repeated in the task so the agent does not need to guess. */
const PLAN_REPAIR_RULES = `Rewrite the file in place with schema and dependency corrections only:
- Keep the same waves, task ids, and intent. Do not split, merge, re-id, or invent work.
- Normalize headings to \`#\` title, \`## Wave Breakdown\`, \`### Wave N — Name\`, \`#### Task W1-A: Title\`.
- Every task needs \`- **Build:**\`, \`- **Test:**\`, \`- **Accept:**\`, \`- **Touches:**\`. Fill gaps from surrounding prose.
- YAML front matter needs \`name\` and a \`todos\` list whose ids match the \`#### Task\` headings one-to-one.
- Placeholder Depends on values (none, nothing, n/a) mean no dependencies.
- If an error names a missing task dependency, add that task id to the consumer's Depends on list. Do not change task implementation or scope.
- Overwrite only this path via save_file. No sidecar copy.`;

export interface StartPlanRepairInput {
  planPath: string;
  errors: ParseError[];
  boardId?: string;
  createBoard?: (
    planPath: string,
    options?: { boardId?: string; markdown?: string },
  ) => Promise<{ boardId: string }>;
}

/** Test seams — production callers omit these and use the live orchestrator. */
export interface PlanRepairHooks {
  spawnSubAgent?: typeof spawnSubAgent;
  waitForSubAgent?: typeof waitForSubAgent;
  getSubAgentRun?: typeof getSubAgentRun;
  cancelSubAgent?: typeof cancelSubAgent;
  ensureBackgroundChat?: typeof ensureBackgroundChat;
}

export type StartPlanRepairResult =
  | { ok: true; boardId: string }
  | { ok: false; alreadyRunning: true }
  | { ok: false; parseFailure: PlanParseFailure }
  | { ok: false; error: string };

type RunningRepair = {
  runId: string;
  cancel: typeof cancelSubAgent;
};

/** One in-flight repair per background key so a second click cannot double-spawn. */
const runningByKey = new Map<string, RunningRepair>();
/** Keys the user cancelled before spawn returned a run id. */
const cancelledKeys = new Set<string>();

/** Stable background identity: one repair chat per workspace + plan path. */
export function planRepairBackgroundKey(workspacePath: string, planPath: string): string {
  return `plan-repair:${normalizeWorkspacePath(workspacePath)}:${planPath.trim()}`;
}

/** Format parse errors the same way the REST 400 body does. */
function formatParseErrorsForTask(errors: ParseError[]): string {
  return errors
    .map((error) => `line ${error.line}:${error.column} — ${error.message}\n    hint: ${error.hint}`)
    .join('\n');
}

/** Task envelope: path, line errors, and narrow repair rules. */
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

/** Drop in-flight markers between unit tests. */
export function resetPlanRepairForTests(): void {
  runningByKey.clear();
  cancelledKeys.clear();
}

/**
 * Spawn `plan-repairer` in a background chat, wait, then retry board create.
 * Never assigns `sessionState.activeId`.
 */
export async function startPlanRepair(
  input: StartPlanRepairInput,
  hooks: PlanRepairHooks = {},
): Promise<StartPlanRepairResult> {
  const planPath = input.planPath.trim();
  if (!planPath) return { ok: false, error: 'Plan path is missing' };

  const spawn = hooks.spawnSubAgent ?? spawnSubAgent;
  const wait = hooks.waitForSubAgent ?? waitForSubAgent;
  const readRun = hooks.getSubAgentRun ?? getSubAgentRun;
  const cancel = hooks.cancelSubAgent ?? cancelSubAgent;
  const ensureChat = hooks.ensureBackgroundChat ?? ensureBackgroundChat;
  const createBoard = input.createBoard ?? createBoardFromPlan;

  const workspacePath = getWorkspacePath();
  const key = planRepairBackgroundKey(workspacePath, planPath);
  if (runningByKey.has(key)) return { ok: false, alreadyRunning: true };

  // Mark the key before spawn so a second click cannot race a duplicate agent.
  runningByKey.set(key, { runId: '', cancel });
  cancelledKeys.delete(key);

  const chat = ensureChat({
    key,
    name: 'Repair plan',
    workspacePath: workspacePath || undefined,
    modeId: 'plan',
  });
  if (!chat) {
    runningByKey.delete(key);
    return { ok: false, error: 'Sessions are not ready yet' };
  }

  let runId = '';
  try {
    const spawned = await spawn({
      type: 'plan-repairer',
      task: buildPlanRepairTask(planPath, input.errors),
      wait: false,
      parentChatId: chat.id,
      parentTurnId: null,
    });
    runId = 'runId' in spawned && typeof spawned.runId === 'string' ? spawned.runId : '';
  } catch (err) {
    runningByKey.delete(key);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!runId) {
    runningByKey.delete(key);
    return { ok: false, error: 'Failed to spawn plan repairer' };
  }

  runningByKey.set(key, { runId, cancel });

  // Clicked Cancel while spawn was in flight — stop before waiting.
  if (cancelledKeys.has(key)) {
    cancel(runId);
    cancelledKeys.delete(key);
    runningByKey.delete(key);
    return { ok: false, error: 'Repair cancelled' };
  }

  try {
    const settled = await wait(runId);
    const run = readRun(runId);
    const ok = run ? isSubAgentRunSuccessful(run) : settled.status === 'completed';
    if (settled.cancelled || settled.status === 'cancelled') {
      return { ok: false, error: 'Repair cancelled' };
    }
    if (!ok) {
      return {
        ok: false,
        error: settled.error?.trim() || settled.summary?.trim() || 'Plan repair failed',
      };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    runningByKey.delete(key);
    cancelledKeys.delete(key);
  }

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

/** Cancel the in-flight repair for this plan, if any. */
export function cancelPlanRepair(planPath: string, hooks: PlanRepairHooks = {}): void {
  const key = resolveRepairKey(planPath);
  cancelledKeys.add(key);
  const running = runningByKey.get(key);
  const cancel = hooks.cancelSubAgent ?? running?.cancel ?? cancelSubAgent;
  if (running?.runId) cancel(running.runId);
}
