import {
  getSubAgentRun,
  spawnSubAgent,
  waitForSubAgent,
} from '../../agents/orchestrator.ts';
import { isSubAgentRunSuccessful } from '../../agents/sub-agent-outcome.ts';
import { ensureBackgroundChat } from '../../state/background-chat.ts';
import {
  appendIssueLinks,
  defaultIssuePlanPath,
  findIssueById,
  requireIssueStatusForRole,
  updateIssue,
} from '../../state/issues-store.ts';
import { findChatById, scheduleSaveSessions, touchChat } from '../../state/sessions.ts';
import {
  applyChatRunTargetChoice,
  type ChatRunTargetChoice,
} from '../../state/chat-worktree.ts';
import { routeCodeWindowCommand } from '../../os/code-window-command.ts';
import type { Chat, IssueCard, IssueMessageSnapshot } from '../../types.ts';
import { isTriageStatus } from '../../issues/taxonomy.ts';
import { getIssuesTaxonomySync } from '../../state/issues-taxonomy-store.ts';
import { buildIssueExpandTask, canExpandIssueWithAgent } from './expand-task.ts';
import {
  buildIssueDebugSeed,
  buildIssueForegroundModeSeed,
  buildIssueInvestigateTask,
  buildIssuePlanBackgroundTask,
  buildIssuePlanSeed,
  canInvestigateIssue,
  canRunIssueWorkflow,
  canSendIssueToBoard,
  issueActivityTarget,
  issueCodeRefsToLaunch,
  resolveIssuePlanPath,
  type IssueBackgroundChatMode,
  type IssueForegroundChatMode,
} from './workflow-seeds.ts';

export { buildIssueExpandTask, canExpandIssueWithAgent } from './expand-task.ts';
export { markIssuesReviewForBoardComplete } from './board-review.ts';
export {
  buildIssueContextBlock,
  buildIssueDebugSeed,
  buildIssueForegroundModeSeed,
  buildIssueInvestigateTask,
  buildIssuePlanBackgroundTask,
  buildIssuePlanSeed,
  canInvestigateIssue,
  ISSUE_BACKGROUND_CHAT_MODES,
  ISSUE_FOREGROUND_CHAT_MODES,
  canRunIssueWorkflow,
  canSendIssueToBoard,
  issueActivityChip,
  issueActivityTarget,
  issueCodeRefsToLaunch,
  resolveIssuePlanPath,
} from './workflow-seeds.ts';
export type { IssueActivityTarget } from './workflow-seeds.ts';
export type { ChatRunTargetChoice } from '../../state/chat-worktree.ts';

/** Stable background-chat key for an issue's workflow runs (one chat per issue). */
function issueBackgroundChatKey(issue: IssueCard): string {
  return `issue:${issue.id}`;
}

// ── Expand ───────────────────────────────────────────────────────────────────

export async function runIssueExpandWithAgent(
  issueId: string,
): Promise<{ ok: boolean; error?: string; runId?: string }> {
  const issue = findIssueById(issueId);
  if (!issue) return { ok: false, error: 'Issue not found' };
  if (!canExpandIssueWithAgent(issue)) {
    return { ok: false, error: 'Expand with agent is only available in triage' };
  }

  const parentChatId = ensureIssueWorkflowChat(issue, 'Expand')?.id ?? null;

  try {
    const result = await spawnSubAgent({
      type: 'issue-writer',
      task: buildIssueExpandTask(issue),
      wait: false,
      parentChatId,
      parentTurnId: null,
      category: 'research',
    });

    const runId =
      'runId' in result && typeof result.runId === 'string' ? result.runId : null;
    if (!runId) return { ok: false, error: 'Failed to spawn issue-writer' };

    updateIssue(issueId, { investigateRunId: runId });

    const settled = await waitForSubAgent(runId);
    const ok = settled.status === 'completed' && !settled.cancelled;
    if (!ok) {
      const err = settled.error?.trim() || settled.summary?.trim() || 'Expand failed';
      return { ok: false, error: err, runId };
    }

    const latest = findIssueById(issueId);
    const taxonomy = getIssuesTaxonomySync();
    if (latest && !isTriageStatus(taxonomy, latest.status)) {
      updateIssue(issueId, { status: requireIssueStatusForRole('triage') });
    }

    return { ok: true, runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Parent chat for a workflow sub-agent run (live registry, persisted snapshot, or last link). */
export function resolveIssueSubAgentChatId(
  issue: IssueCard,
  runId: string,
): string | null {
  const live = getSubAgentRun(runId);
  if (live?.parentChatId?.trim()) return live.parentChatId.trim();

  for (const chatId of issue.chatIds ?? []) {
    const id = chatId?.trim();
    if (!id) continue;
    const chat = findChatById(id);
    if (chat?.subAgentRuns?.some((row) => row.runId === runId)) return id;
  }

  const last = issue.chatIds?.at(-1)?.trim();
  return last || null;
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** Open the sub-agent drawer or board chat behind the workflow activity chip. */
export async function openIssueActivity(issue: IssueCard): Promise<boolean> {
  const target = issueActivityTarget(issue);
  if (!target) return false;

  const { switchChat } = await import('../../ui/sidebar.ts');

  if (target.kind === 'board_chat') {
    if (await routeCodeWindowCommand({ kind: 'chat', chatId: target.chatId, workspacePath: issue.workspacePath })) return true;
    switchChat(target.chatId);
    return true;
  }

  const chatId = resolveIssueSubAgentChatId(issue, target.runId);
  if (!chatId) return false;
  if (await routeCodeWindowCommand({ kind: 'activity', chatId, runId: target.runId, workspacePath: issue.workspacePath })) return true;

  switchChat(chatId);
  const { openSubAgentDrawer } = await import('../../ui/sub-agent-drawer.ts');
  openSubAgentDrawer(target.runId, chatId);
  return true;
}

function ensureIssueWorkflowChat(issue: IssueCard, namePrefix: string): Chat | null {
  const existingId = issue.chatIds?.length
    ? issue.chatIds[issue.chatIds.length - 1]
    : undefined;
  if (existingId) {
    const existing = findChatById(existingId);
    if (existing) return existing;
  }

  const chat = ensureBackgroundChat({
    key: issueBackgroundChatKey(issue),
    name: `${namePrefix}: ${issue.title.slice(0, 48)}`,
    workspacePath: issue.workspacePath,
    modeId: 'build',
  });
  if (!chat) return null;

  appendIssueLinks(issue.id, { chatId: chat.id });
  return chat;
}

/** Attach the chosen run target to a workflow chat before a sub-agent spawn. */
async function applyIssueWorkflowRunTarget(
  chat: Chat,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; error?: string }> {
  if (!runTarget) return { ok: true };
  const applied = await applyChatRunTargetChoice(chat, runTarget);
  if (!applied.ok) return applied;
  touchChat(chat);
  scheduleSaveSessions();
  return { ok: true };
}

/** Foreground Code (no seed) then apply seeded launch; returns new chat id when created. */
async function launchCodeSeededChat(options: {
  issueId?: string;
  issue?: IssueMessageSnapshot;
  modeId: IssueForegroundChatMode;
  seed: string;
  workspacePath?: string;
  codeRefs?: ReturnType<typeof issueCodeRefsToLaunch>;
  runTarget?: ChatRunTargetChoice;
}): Promise<{ chatId?: string; error?: string }> {
  if (await routeCodeWindowCommand({ kind: 'seed', ...options, workspacePath: options.workspacePath || '' })) return {};
  const { ensureCodeWorkspaceModules } = await import('../../boot/code-workspace-modules.ts');
  await ensureCodeWorkspaceModules();
  const { launchApp } = await import('../../os/router.ts');
  const { applyCodeLaunchOptions } = await import('../../os/code-launch.ts');

  launchApp('code', {
    codeSection: 'chat',
    workspacePath: options.workspacePath,
  });
  await new Promise((r) => setTimeout(r, 0));

  return applyCodeLaunchOptions({
    modeId: options.modeId,
    seed: options.seed,
    autoRun: true,
    workspacePath: options.workspacePath,
    codeRefs: options.codeRefs,
    runTarget: options.runTarget,
  });
}

/**
 * Investigate: spawn debugger sub-agent, link chat, notes on settle; status → in_progress.
 */
export async function runIssueInvestigate(
  issueId: string,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; error?: string; chatId?: string }> {
  const issue = findIssueById(issueId);
  if (!issue) return { ok: false, error: 'Issue not found' };
  if (!canInvestigateIssue(issue)) {
    return { ok: false, error: 'Issue is closed' };
  }

  const chat = ensureIssueWorkflowChat(issue, 'Investigate');
  if (!chat) return { ok: false, error: 'Could not create investigation chat' };

  const attached = await applyIssueWorkflowRunTarget(chat, runTarget);
  if (!attached.ok) return { ok: false, error: attached.error, chatId: chat.id };

  updateIssue(issueId, { status: requireIssueStatusForRole('in_progress') });
  appendIssueLinks(issueId, { chatId: chat.id });

  try {
    const result = await spawnSubAgent({
      type: 'debugger',
      task: buildIssueInvestigateTask(issue),
      wait: false,
      parentChatId: chat.id,
      parentTurnId: null,
      category: 'fix',
    });

    const runId =
      'runId' in result && typeof result.runId === 'string' ? result.runId : null;
    if (!runId) return { ok: false, error: 'Failed to spawn debugger', chatId: chat.id };

    updateIssue(issueId, {
      investigateRunId: runId,
      status: requireIssueStatusForRole('in_progress'),
    });

    const settled = await waitForSubAgent(runId);
    const run = getSubAgentRun(runId);
    const ok = run ? isSubAgentRunSuccessful(run) : settled.status === 'completed';
    const summary = settled.summary?.trim() || settled.error?.trim() || '(no summary)';

    updateIssue(issueId, {
      notes: summary.slice(0, 4000),
      status: requireIssueStatusForRole('in_progress'),
    });

    return {
      ok,
      error: ok ? undefined : summary,
      chatId: chat.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, chatId: chat.id };
  }
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export async function runIssuePlanChat(
  issueId: string,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; error?: string; chatId?: string; planPath?: string }> {
  const issue = findIssueById(issueId);
  if (!issue) return { ok: false, error: 'Issue not found' };
  if (!canRunIssueWorkflow(issue)) {
    return { ok: false, error: 'Issue is closed' };
  }

  const planPath = resolveIssuePlanPath(issue);
  const seed = buildIssuePlanSeed(issue, planPath);
  const codeRefs = issueCodeRefsToLaunch(issue);

  updateIssue(issueId, { planPath, status: requireIssueStatusForRole('planned') });

  try {
    const launched = await launchCodeSeededChat({
      issueId,
      issue: issueMessageSnapshot(issue),
      modeId: 'plan',
      seed,
      workspacePath: issue.workspacePath,
      codeRefs,
      runTarget,
    });
    if (launched.chatId) appendIssueLinks(issueId, { chatId: launched.chatId });
    if (launched.error) {
      return { ok: false, error: launched.error, chatId: launched.chatId, planPath };
    }
    return { ok: true, chatId: launched.chatId, planPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, planPath };
  }
}

/**
 * Plan in background: bug-planner-style sub-agent writing documentation/plans/issues/<id>.md.
 */
export async function runIssuePlanBackground(
  issueId: string,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; planPath?: string; error?: string }> {
  const issue = findIssueById(issueId);
  if (!issue) return { ok: false, error: 'Issue not found' };
  if (!canRunIssueWorkflow(issue)) {
    return { ok: false, error: 'Issue is closed' };
  }

  const chat = ensureIssueWorkflowChat(issue, 'Plan');
  if (!chat) return { ok: false, error: 'Could not create planning chat' };

  const attached = await applyIssueWorkflowRunTarget(chat, runTarget);
  if (!attached.ok) return { ok: false, error: attached.error };

  const planPath = resolveIssuePlanPath(issue);

  try {
    const result = await spawnSubAgent({
      type: 'bug-planner',
      task: buildIssuePlanBackgroundTask(issue, planPath),
      wait: false,
      parentChatId: chat.id,
      parentTurnId: null,
      category: 'fix',
    });

    const runId =
      'runId' in result && typeof result.runId === 'string' ? result.runId : null;
    if (!runId) return { ok: false, error: 'Failed to spawn planner' };

    updateIssue(issueId, {
      planRunId: runId,
      planPath,
      status: requireIssueStatusForRole('in_progress'),
    });

    const settled = await waitForSubAgent(runId);
    const run = getSubAgentRun(runId);
    const ok = run ? isSubAgentRunSuccessful(run) : settled.status === 'completed';

    if (ok) {
      const notes = issue.notes
        ? `${issue.notes}\n\n---\nPlan: ${planPath}`
        : `Plan ready: ${planPath}`;
      updateIssue(issueId, {
        status: requireIssueStatusForRole('planned'),
        planPath,
        notes,
      });
      return { ok: true, planPath };
    }
    return {
      ok: false,
      error: settled.summary?.trim() || settled.error || 'Plan failed',
      planPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, planPath };
  }
}

// ── Debug ────────────────────────────────────────────────────────────────────

/**
 * Debug chat: Code Debug-mode seeded with full issue context; status → in_progress.
 */
export async function runIssueDebugChat(
  issueId: string,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; error?: string; chatId?: string }> {
  return runIssueForegroundChat(issueId, 'debug', runTarget);
}

/**
 * Foreground chat: open Code in the chosen composer mode with issue context seeded.
 */
export async function runIssueForegroundChat(
  issueId: string,
  modeId: IssueForegroundChatMode,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; error?: string; chatId?: string; planPath?: string }> {
  const issue = findIssueById(issueId);
  if (!issue) return { ok: false, error: 'Issue not found' };
  if (!canRunIssueWorkflow(issue)) {
    return { ok: false, error: 'Issue is closed' };
  }

  if (modeId === 'plan') {
    return runIssuePlanChat(issueId, runTarget);
  }

  const seed = buildIssueForegroundModeSeed(issue, modeId);
  const codeRefs = issueCodeRefsToLaunch(issue);

  updateIssue(issueId, { status: requireIssueStatusForRole('in_progress') });

  try {
    const launched = await launchCodeSeededChat({
      issueId,
      issue: issueMessageSnapshot(issue),
      modeId,
      seed,
      workspacePath: issue.workspacePath,
      codeRefs,
      runTarget,
    });
    if (launched.chatId) appendIssueLinks(issueId, { chatId: launched.chatId });
    if (launched.error) {
      return { ok: false, error: launched.error, chatId: launched.chatId };
    }
    return { ok: true, chatId: launched.chatId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Keep sent tickets stable even when the source issue changes later. */
function issueMessageSnapshot(issue: IssueCard): IssueMessageSnapshot {
  return {
    id: issue.id,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    labels: [...issue.labels],
  };
}

/**
 * Background chat: spawn a sub-agent for the chosen mode (debugger or planner).
 */
export async function runIssueBackgroundChat(
  issueId: string,
  modeId: IssueBackgroundChatMode,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; error?: string; chatId?: string; planPath?: string }> {
  if (modeId === 'debug') return runIssueInvestigate(issueId, runTarget);
  return runIssuePlanBackground(issueId, runTarget);
}

// ── Board ────────────────────────────────────────────────────────────────────

/**
 * Send to board: requires planPath; launchBoardFromPlan; store boardChatId; status → in_progress.
 */
export async function runIssueSendToBoard(
  issueId: string,
): Promise<{ ok: boolean; error?: string; boardChatId?: string }> {
  const issue = findIssueById(issueId);
  if (!issue) return { ok: false, error: 'Issue not found' };
  if (!canSendIssueToBoard(issue)) {
    return { ok: false, error: 'Save a plan first (Send to chat or Send to background in Plan mode)' };
  }

  const planPath = issue.planPath!.trim();

  try {
    if (await routeCodeWindowCommand({ kind: 'board', issueId, workspacePath: issue.workspacePath })) return { ok: true };
    const { launchApp } = await import('../../os/router.ts');
    launchApp('code', { codeSection: 'chat', workspacePath: issue.workspacePath });
    await new Promise((r) => setTimeout(r, 0));

    const { launchBoardFromPlan } = await import('../../ui/orchestrate-launch.ts');
    const launched = await launchBoardFromPlan(planPath);

    updateIssue(issueId, {
      status: requireIssueStatusForRole('in_progress'),
    });

    return { ok: Boolean(launched) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function openIssuePlanInEditor(
  planPath: string,
  workspacePath?: string,
): Promise<void> {
  const path = planPath.trim();
  if (!path) return;
  if (await routeCodeWindowCommand({ kind: 'file', path, workspacePath: workspacePath || '' })) return;

  const targetWs = workspacePath?.trim() || '';
  const { isCurrentWindowWorkspace } = await import('../../state/workspace.ts');
  const alreadyHere = !targetWs || isCurrentWindowWorkspace(targetWs);

  // Folder already open in another window: focus that view. Retargeting this
  // one would either recreate it or steal the folder from the window that owns it.
  if (!alreadyHere) {
    const { readOpenWorkspaceWindows } = await import('../../lib/open-workspace-windows.ts');
    const { normalizeWorkspacePath } = await import('../../lib/normalize-workspace-path.ts');
    const openWorkspace = window.minnow?.window?.openWorkspace;
    const openMap = await readOpenWorkspaceWindows();
    if (openWorkspace && openMap.has(normalizeWorkspacePath(targetWs))) {
      await openWorkspace(targetWs);
      return;
    }
  }

  const { getForegroundAppId } = await import('../../os/instances.ts');
  // Foreground Code when Issues is the app, and still pass workspacePath when
  // this window is on a different folder (embedded Issues + all-workspaces).
  if (getForegroundAppId() !== 'code' || (!alreadyHere && targetWs)) {
    const { launchApp } = await import('../../os/router.ts');
    launchApp('code', {
      codeSection: 'chat',
      // Omit when we are already on this folder so Code launch does not retarget.
      workspacePath: alreadyHere ? undefined : targetWs || undefined,
    });
    await new Promise((r) => setTimeout(r, 0));
  }

  const { openFileInViewer } = await import('../../ui/file-viewer.ts');
  await openFileInViewer(path);
}

/** Path helper re-export for callers that import from pipeline. */
export { defaultIssuePlanPath };
