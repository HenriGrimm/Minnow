import { getChatRunActivity, subscribeChatRunActivity } from '../state/chat-run-activity';
import type { Chat, HomeIssueRun, IssueCard } from '../types';
import { getChatAbort, streamingChatIds } from '../app-state';
import { ensureSessionsReady, ensureChatHistoryLoaded, sessionState, scheduleSaveSessions, touchChat } from '../state/sessions';
import { ensureBackgroundChat } from '../state/background-chat';
import { appendIssueLinks, collectIssues, findIssueById, isIssuesStoreLoaded, requireIssueStatusForRole, saveIssuesNow, updateIssue, updateIssueAgentRun } from '../state/issues-store';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { subscribeIssuesChanges } from '../state/issues-events';
import { getWorkspacePath } from '../state/workspace';
import { workspacePathsEqual } from '../lib/normalize-workspace-path';
import { getAutopilotMetaSync, loadAutopilotMeta } from '../config/autopilot-meta';
import { getRouterConfigSync } from '../models/routers';
import { createManagedChatWorktree } from '../state/chat-worktree';
import { findLastPlanSavePath } from '../chat/plans/plan-from-history';
import { buildIssueContextBlock, buildIssuesPlanSeed, resolveIssuePlanPath } from '../chat/issues/workflow-seeds';
import { readSavedIssuePlan } from '../issues/saved-plan';
import { listMainTurnActivity } from '../chat/main-turn-activity';
import { subscribeChatStreamEnd } from '../chat/streaming-state';
import { batchIssues, blockers, flowColumn, issueChat } from './flow-model';

const activeGroups = new Set<string>();
const activeTurns = new Set<string>();
let initialized = false, pumping = false;
let mergeBusy = false;
const listeners = new Set<() => void>();
export function subscribeHomeFlow(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function notify(): void { for (const listener of listeners) listener(); }
function members(issue: IssueCard): IssueCard[] {
  if (!issue.agent?.home) return [];
  return collectIssues({ scope: 'all', hideDone: false }).filter(i => i.agent?.home?.groupId === issue.agent?.home?.groupId && workspacePathsEqual(i.workspacePath, issue.workspacePath));
}
function patchGroup(issue: IssueCard, state: HomeIssueRun['state'], error?: string): void {
  for (const item of members(issue)) {
    const home = item.agent!.home!;
    updateIssueAgentRun(item.id, { home: { ...home, state }, phase: state === 'done' ? 'done' : state === 'planned' || state === 'ready' || state === 'conflict' ? 'review' : state === 'failed' ? 'failed' : state === 'held' || state === 'waitslot' ? 'queued' : state === 'paused' ? 'canceled' : 'running', error });
    if (state === 'planned') {
      const chat = issueChat(item, sessionState?.chats ?? []);
      const planPath = item.planPath || (chat && findLastPlanSavePath(chat.history));
      updateIssue(item.id, { status: requireIssueStatusForRole('planned'), ...(planPath ? { planPath } : {}) });
    }
    else if (state === 'ready' || state === 'conflict' || state === 'mergequeued' || state === 'merging') updateIssue(item.id, { status: requireIssueStatusForRole('review') });
    else if (state === 'done') updateIssue(item.id, { status: requireIssueStatusForRole('done') });
    else if (state !== 'held') updateIssue(item.id, { status: requireIssueStatusForRole('in_progress') });
  }
  notify();
}

export function homeAgentSlots(): number {
  const config = getRouterConfigSync();
  const router = config.routers.find(r => r.id === config.defaultRouterId && r.enabled);
  const capacity = router?.entries.filter(e => e.enabled).reduce((sum, e) => sum + e.concurrencyLimit, 0);
  return Math.max(1, capacity || getAutopilotMetaSync().maxConcurrentTasks);
}

export function initHomeFlow(): void {
  if (initialized) return;
  initialized = true;
  const observed = new Map<string, string>();
  subscribeChatRunActivity(() => {
    if (!isIssuesStoreLoaded()) return;
    for (const group of batchIssues(collectIssues({ scope: 'all', hideDone: false }).filter(i => i.agent?.home))) {
      const issue = group[0], chat = issueChat(issue, sessionState?.chats ?? []);
      if (!chat || issue.agent?.home?.boardId || ['done', 'merging', 'mergequeued'].includes(issue.agent!.home!.state)) continue;
      const status = getChatRunActivity(chat.id, chat);
      const previous = observed.get(chat.id);
      if (!status || status === previous) continue;
      observed.set(chat.id, status);
      if (status === 'running') patchGroup(issue, 'working');
      else if (previous === 'running') patchGroup(issue, status === 'completed' ? chat.modeId === 'plan' ? 'planned' : 'ready' : status === 'failed' ? 'failed' : 'paused');
    }
  });
  subscribeIssuesChanges(() => { queueMicrotask(() => void pumpHomeQueue()); });
  subscribeChatStreamEnd(() => { queueMicrotask(() => void pumpHomeQueue()); });
  void loadAutopilotMeta().then(() => pumpHomeQueue()).catch(() => {});
}

export async function sendHomeIssues(groups: IssueCard[][], options: { modelId: string; providerId?: string; mode: 'build' | 'plan'; baseBranch: string; instructions?: string; startNow?: boolean }): Promise<string[]> {
  if (!options.modelId) throw new Error('Choose a model before starting a chat.');
  const ids: string[] = [];
  for (const group of groups) {
    const groupId = crypto.randomUUID();
    for (const source of group) {
      const issue = findIssueById(source.id);
      if (!issue || issue.agent?.home || issue.agent?.chatId || !workspacePathsEqual(issue.workspacePath, getWorkspacePath()) || !['triage', 'ready'].includes(flowColumn(issue, getIssuesTaxonomySync()) ?? '')) continue;
      const home: HomeIssueRun = { ...options, groupId, state: 'waitslot' };
      updateIssue(issue.id, { agent: { agentId: 'builder', phase: 'queued', startedAt: Date.now(), updatedAt: Date.now(), home } });
      ids.push(issue.id);
    }
  }
  await saveIssuesNow();
  void pumpHomeQueue();
  return ids;
}

export async function pumpHomeQueue(): Promise<void> {
  if (pumping || !sessionState || !isIssuesStoreLoaded()) return;
  pumping = true;
  try {
    const all = collectIssues({ workspacePath: getWorkspacePath(), scope: 'current_workspace' });
    const groups = batchIssues(all.filter(i => i.agent?.home));
    const busyChats = new Set([...streamingChatIds, ...listMainTurnActivity().map(t => t.chatId)]);
    const occupied = new Set(groups.filter(g => ['working', 'rebasing'].includes(g[0].agent!.home!.state) || activeGroups.has(g[0].agent!.home!.groupId)).map(g => g[0].agent?.chatId || g[0].agent!.home!.groupId));
    for (const chatId of busyChats) occupied.add(chatId);
    let used = occupied.size;
    for (const group of groups) {
      const issue = group[0], home = issue.agent!.home!;
      if (!['held', 'waitslot'].includes(home.state) || activeGroups.has(home.groupId)) continue;
      const blocked = !home.startNow && group.some(i => blockers(i, all, getIssuesTaxonomySync()).length > 0);
      if (blocked) { if (home.state !== 'held') patchGroup(issue, 'held'); continue; }
      if (used >= homeAgentSlots()) { if (home.state !== 'waitslot') patchGroup(issue, 'waitslot'); continue; }
      used++; activeGroups.add(home.groupId); patchGroup(issue, 'working');
      void startGroup(group).finally(() => { activeGroups.delete(home.groupId); void pumpHomeQueue(); });
    }
  } finally { pumping = false; }
}

async function startGroup(group: IssueCard[]): Promise<void> {
  const issue = group[0], home = issue.agent!.home!;
  const workspace = issue.workspacePath;
  try {
    const { ensureCodeWorkspaceModules } = await import('../boot/code-workspace-modules');
    await ensureCodeWorkspaceModules(); await ensureSessionsReady();
    if (!workspacePathsEqual(getWorkspacePath(), workspace)) { patchGroup(issue, 'waitslot'); return; }
    const chat = ensureBackgroundChat({ key: `home:${home.groupId}`, name: group.length === 1 ? issue.title : `${issue.title} + ${group.length - 1}`, workspacePath: workspace, modeId: home.mode, modelId: home.modelId, providerId: home.providerId });
    if (!chat) throw new Error('Chats are still loading. Try again.');
    const result = await createManagedChatWorktree(chat, `wt/${issue.id.toLowerCase()}-${chat.id.slice(-6)}`, home.baseBranch);
    if (!result.ok) throw new Error(result.error || 'Could not prepare the worktree.');
    touchChat(chat); scheduleSaveSessions();
    for (const item of group) {
      appendIssueLinks(item.id, { chatId: chat.id });
      updateIssueAgentRun(item.id, { chatId: chat.id, worktreePath: chat.worktreeRoot, branch: chat.gitBranch });
    }
    await saveIssuesNow();
    const preparation = await fetch('/api/worktree', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Minnow-Workspace': workspace }, body: JSON.stringify({ op: 'prepare_chat', chatId: chat.id }) });
    const prepared = await preparation.json() as { ok: boolean; error?: string };
    if (!preparation.ok || !prepared.ok) throw new Error(prepared.error || 'Could not install the project dependencies.');
    if (findIssueById(issue.id)?.agent?.home?.state === 'paused') return;
    const planPath = home.mode === 'plan' ? resolveIssuePlanPath(issue) : undefined;
    if (planPath) for (const item of group) updateIssue(item.id, { planPath });
    const text = [planPath ? buildIssuesPlanSeed(group, planPath) : ['Implement these issues in this chat’s worktree. Run the relevant checks, report their actual results, and commit the completed changes. Stop for review. Do not merge or remove the worktree.', ...group.map(buildIssueContextBlock)].join('\n\n'), home.instructions || ''].join('\n\n');
    await runHomeTurn(issue, chat, text, true);
  } catch (error) { patchGroup(issue, 'failed', error instanceof Error ? error.message : String(error)); }
}

async function runHomeTurn(issue: IssueCard, chat: Chat, text: string, first = false): Promise<void> {
  activeTurns.add(chat.id);
  try {
    await ensureChatHistoryLoaded(chat.id);
    const { sendProgrammaticChatText } = await import('../chat/messaging');
    const snapshot = first ? { id: issue.id, title: issue.title, type: issue.type, description: issue.description, status: issue.status, priority: issue.priority, labels: issue.labels, workspacePath: issue.workspacePath } : undefined;
    await sendProgrammaticChatText(chat, text, { requireCompletedTurn: true, ownsGlobalStreaming: false, parseSlash: false, issue: snapshot });
    if (findIssueById(issue.id)?.agent?.home?.state === 'paused') return;
    patchGroup(issue, chat.modeId === 'plan' ? 'planned' : 'ready');
  } catch (error) {
    if (findIssueById(issue.id)?.agent?.home?.state !== 'paused') patchGroup(issue, 'failed', error instanceof Error ? error.message : String(error));
  } finally { activeTurns.delete(chat.id); await saveIssuesNow(); }
}

export async function replyHomeIssue(issue: IssueCard, text: string, build = false): Promise<void> {
  if (issue.agent?.home?.boardId) throw new Error('Open the orchestrator board to continue this work.');
  if (issue.agent?.home?.state === 'done') throw new Error('This work is merged. Start a new issue or open the chat in Code for further changes.');
  const chat = issueChat(issue, sessionState?.chats ?? []);
  if (!chat) throw new Error('Open the linked chat to continue this issue.');
  if (streamingChatIds.has(chat.id)) throw new Error('Wait for the current reply, or pause the agent first.');
  if (!issue.agent?.home) {
    await ensureChatHistoryLoaded(chat.id);
    const { sendProgrammaticChatText } = await import('../chat/messaging');
    await sendProgrammaticChatText(chat, text, { requireCompletedTurn: true, ownsGlobalStreaming: false, parseSlash: false });
    return;
  }
  if (build) {
    chat.modeId = 'build'; touchChat(chat); scheduleSaveSessions();
    for (const item of members(issue)) updateIssueAgentRun(item.id, { home: { ...item.agent!.home!, mode: 'build' } });
  }
  patchGroup(issue, 'working');
  await runHomeTurn(issue, chat, text);
  void pumpHomeQueue();
}

export function pauseHomeIssue(issue: IssueCard): void {
  patchGroup(issue, 'paused');
  if (issue.agent?.chatId) getChatAbort(issue.agent.chatId)?.abort();
  void pumpHomeQueue();
}

/** Interrupted work never silently restarts after a reload. Its worktree stays attached. */
export function reconcileHomeFlow(): void {
  if (!sessionState || !isIssuesStoreLoaded()) return;
  const all = collectIssues({ workspacePath: getWorkspacePath(), scope: 'current_workspace' });
  for (const group of batchIssues(all.filter(i => i.agent?.home))) {
    const issue = group[0], home = issue.agent!.home!, chat = sessionState.chats.find(c => c.id === issue.agent?.chatId);
    if (home.boardId) continue;
    if (activeGroups.has(home.groupId) || activeTurns.has(chat?.id || '')) continue;
    const activity = chat ? getChatRunActivity(chat.id, chat) : null;
    if (activity === 'running') continue;
    if (home.mode === 'plan' && (home.state === 'ready' || ['working', 'paused'].includes(home.state) && activity === 'completed')) { patchGroup(issue, 'planned'); continue; }
    if (['working', 'rebasing'].includes(home.state) && !chat?.currentGenerationId && !streamingChatIds.has(chat?.id || '')) patchGroup(issue, 'paused');
    if (home.state === 'merging' && !mergeBusy) patchGroup(issue, 'conflict', 'The merge was interrupted. Inspect the target and worktree in Source Control before approving again.');
  }
}

export async function retryHomeIssue(issue: IssueCard): Promise<void> {
  if (!issue.agent?.home || !['failed', 'paused'].includes(issue.agent.home.state)) return;
  patchGroup(issue, 'waitslot'); await saveIssuesNow(); void pumpHomeQueue();
}

export async function addToHomeChat(issues: IssueCard[], chat: Chat): Promise<string[]> {
  if (!chat.worktreeRoot || !workspacePathsEqual(chat.workspacePath, getWorkspacePath())) throw new Error('Choose an isolated chat in this project.');
  const all = collectIssues({ workspacePath: getWorkspacePath(), scope: 'current_workspace' });
  const accepted = issues.filter(i => !i.agent?.home && !i.agent?.chatId && ['triage', 'ready'].includes(flowColumn(i, getIssuesTaxonomySync()) ?? '') && !blockers(i, all, getIssuesTaxonomySync()).length);
  if (!accepted.length) throw new Error('The selected issues are blocked. They stay selected.');
  await ensureChatHistoryLoaded(chat.id);
  const existing = all.find(i => i.agent?.chatId === chat.id && i.agent.home);
  const home: HomeIssueRun = existing?.agent?.home ?? { groupId: crypto.randomUUID(), state: 'working', mode: chat.modeId === 'plan' ? 'plan' : 'build', modelId: chat.modelId, providerId: chat.providerId, baseBranch: 'main' };
  for (const issue of accepted) {
    appendIssueLinks(issue.id, { chatId: chat.id });
    updateIssue(issue.id, { status: requireIssueStatusForRole('in_progress'), agent: { agentId: 'builder', phase: 'running', startedAt: Date.now(), updatedAt: Date.now(), chatId: chat.id, branch: chat.gitBranch, worktreePath: chat.worktreeRoot, home: { ...home, state: 'working' } } });
  }
  patchGroup(accepted[0], 'working');
  const text = `Also work on these issues in this same worktree:\n\n${accepted.map(buildIssueContextBlock).join('\n\n')}`;
  if (streamingChatIds.has(chat.id)) {
    const { enqueueSteerMessage } = await import('../chat/steer-message');
    enqueueSteerMessage(chat, [chat.pendingSteerMessage, text].filter(Boolean).join('\n\n'));
  } else void runHomeTurn(accepted[0], chat, text);
  return accepted.map(i => i.id);
}

/** Approve the saved format, retaining the project as the board's workspace. */
export async function approveHomePlan(issue: IssueCard): Promise<void> {
  const home = issue.agent?.home;
  const chat = issueChat(issue, sessionState?.chats ?? []);
  if (!home || home.mode !== 'plan' || !chat || !['planned', 'ready'].includes(home.state)) throw new Error('Finish planning before approving the plan.');
  if (!workspacePathsEqual(issue.workspacePath, getWorkspacePath())) throw new Error('Open this issue’s project before approving the plan.');
  if (home.boardId) {
    const { openBoardsView, showBoard } = await import('../orchestrator/boards-view');
    const { navigateToCodeBoards } = await import('../os/router');
    await openBoardsView();
    navigateToCodeBoards();
    showBoard(home.boardId);
    return;
  }
  if (streamingChatIds.has(chat.id)) throw new Error('Wait for the planning turn to finish.');
  const plan = await readSavedIssuePlan(issue);
  if (plan.type === 'invalid') throw new Error('The saved plan has an invalid planType. Revise it to Build or Orchestrate.');
  if (plan.type === 'build') {
    await replyHomeIssue(issue, `The plan in \`${plan.path}\` is approved. Implement it, run checks, commit the work, and stop for review. Do not merge.`, true);
    return;
  }
  if (!workspacePathsEqual(plan.workspaceRoot, issue.workspacePath)) {
    const { executeTool } = await import('../tools/client');
    const saved = await executeTool('save_file', { path: plan.path, content: plan.markdown }, { workspaceRoot: issue.workspacePath, modeId: 'plan' });
    if (saved.content.startsWith('Error:')) throw new Error(saved.content);
  }
  const { launchBoardFromPlan } = await import('../ui/orchestrate-launch');
  const launched = await launchBoardFromPlan(plan.path, { baseBranch: home.baseBranch, providerId: chat.providerId, id: chat.modelId });
  if (!launched) throw new Error('Could not create the orchestrator board. The plan is preserved; try again.');
  for (const item of members(issue)) {
    updateIssueAgentRun(item.id, { home: { ...item.agent!.home!, boardId: launched.boardId }, phase: 'queued' });
    updateIssue(item.id, { status: requireIssueStatusForRole('in_progress') });
  }
  await saveIssuesNow();
  notify();
}

export async function approveHomeIssue(issue: IssueCard): Promise<void> {
  if (issue.agent?.home?.mode === 'plan' || !['ready', 'conflict'].includes(issue.agent?.home?.state || '')) return;
  if (issue.agent?.chatId && streamingChatIds.has(issue.agent.chatId)) throw new Error('Wait for the agent to finish before approving.');
  patchGroup(issue, 'mergequeued'); await saveIssuesNow();
  void drainHomeMerges();
}

export async function drainHomeMerges(): Promise<void> {
  if (mergeBusy) return;
  mergeBusy = true;
  try {
    const queued = batchIssues(collectIssues({ workspacePath: getWorkspacePath(), scope: 'current_workspace' }).filter(i => i.agent?.home?.state === 'mergequeued'));
    for (const group of queued) {
      const issue = group[0], agent = issue.agent!, home = agent.home!;
      patchGroup(issue, 'merging');
      try {
        const response = await fetch('/api/worktree', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Minnow-Workspace': issue.workspacePath }, body: JSON.stringify({ op: 'merge_chat', chatId: agent.chatId, branch: agent.branch, targetBranch: home.baseBranch }) });
        const result = await response.json() as { ok: boolean; conflict?: boolean; error?: string; removed?: boolean };
        if (!response.ok || !result.ok) throw new Error(result.error || 'Merge stopped. The worktree has been kept.');
        const chat = sessionState?.chats.find(c => c.id === agent.chatId);
        if (chat && result.removed) { delete chat.worktreeRoot; delete chat.chatWorktreeManaged; touchChat(chat); scheduleSaveSessions(); }
        patchGroup(issue, 'done');
      } catch (error) { patchGroup(issue, 'conflict', error instanceof Error ? error.message : String(error)); }
      await saveIssuesNow();
    }
  } finally { mergeBusy = false; void pumpHomeQueue(); }
}
