import '../styles/home.css';
import '../styles/home-inbox.css';
import { getForegroundAppId, subscribeInstances } from '../os/instances';
import { launchApp, navigateToCodeBoards, navigateToCodeOrchestrate } from '../os/router';
import { getWorkspaceLabel, getWorkspacePath, loadWorkspaceFromServer } from '../state/workspace';
import { ensureSessionsReady, sessionState } from '../state/sessions';
import { getChatsForWorkspace, getSidebarListedChatsForWorkspace, getChatLastMessageAt } from '../state/session-workspace-scope';
import { listRecentViewerFiles } from '../state/recent-viewer-files';
import { gitStatus, gitDiffSummary } from '../state/git-api';
import { listMainTurnActivity } from '../chat/main-turn-activity';
import { sortedPriorities } from '../issues/taxonomy';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { workspacePathsEqual } from '../lib/normalize-workspace-path';
import { listBoards, type BoardSummary } from '../orchestrator/client';
import { fetchSchedulerJobs } from '../scheduler/client';
import { collectIssues, isIssuesStoreLoaded, loadIssuesFromStorage } from '../state/issues-store';
import { listChatsAwaitingAnswers } from '../tools/ask-question-queue';
import { listActiveSubAgentRuns } from '../agents/orchestrator';
import { isBoardOwnedChat } from '../state/chat-groups';
import { isMissingGitRepositoryError } from './git-no-repo-state';
import { iconHtml, type IconName } from './icon';
import { mountHomeActivity } from './home-activity';
import { showToast } from './toast';

let initialized = false;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let activityCleanup: (() => void) | undefined;
let mountedWorkspace = '';
let boards: BoardSummary[] = [];
let gitConflicts = 0;
let boardsAvailable = false;
let gitAvailable = false;
let runningScheduledJobs: string[] = [];
const fingerprints = new Map<string, string>();

export interface HomeResumeChoice {
  kind: 'chat' | 'board' | 'code';
  id?: string;
  label: string;
  detail: string;
}

interface HomeResumeInput {
  chats: Array<{ id: string; name?: string; lastMessageAt: number }>;
  turns: Array<{ chatId: string; phase: string }>;
  agentRuns: Array<{ parentChatId?: string | null; status: string }>;
  boards: Array<Pick<BoardSummary, 'boardId' | 'name' | 'status' | 'mergedCount' | 'taskCount'>>;
}

function phaseLabel(phase: string): string {
  return phase.replaceAll('_', ' ');
}

/** Pick one honest continuation target, preferring work that is already moving. */
export function chooseHomeResumeTarget(input: HomeResumeInput): HomeResumeChoice {
  const byId = new Map(input.chats.map(chat => [chat.id, chat]));
  const activeTurn = input.turns.find(turn => byId.has(turn.chatId));
  if (activeTurn) {
    const chat = byId.get(activeTurn.chatId)!;
    return {
      kind: 'chat',
      id: chat.id,
      label: `Resume ${chat.name || 'Untitled chat'}`,
      detail: `${phaseLabel(activeTurn.phase)} in progress`,
    };
  }

  const activeAgentRun = input.agentRuns.find(run =>
    run.parentChatId && byId.has(run.parentChatId) && (run.status === 'running' || run.status === 'queued'));
  if (activeAgentRun?.parentChatId) {
    const chat = byId.get(activeAgentRun.parentChatId)!;
    const count = input.agentRuns.filter(run => run.parentChatId === chat.id && (run.status === 'running' || run.status === 'queued')).length;
    return {
      kind: 'chat',
      id: chat.id,
      label: `Resume ${chat.name || 'Untitled chat'}`,
      detail: `${count} ${count === 1 ? 'agent' : 'agents'} in flight`,
    };
  }

  const runningBoard = input.boards.find(board => board.status === 'running');
  if (runningBoard) {
    return {
      kind: 'board',
      id: runningBoard.boardId,
      label: `Open ${runningBoard.name}`,
      detail: `Board running · ${runningBoard.mergedCount ?? 0}/${runningBoard.taskCount} tasks merged`,
    };
  }

  const recent = input.chats[0];
  if (recent) {
    return {
      kind: 'chat',
      id: recent.id,
      label: `Resume ${recent.name || 'Untitled chat'}`,
      detail: age(recent.lastMessageAt),
    };
  }

  return { kind: 'code', label: 'Open Code', detail: 'Start work in this project' };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function button(label: string, action: () => void, primary = false): HTMLButtonElement {
  const node = el('button', label, primary ? 'home-button home-button--primary' : 'home-button');
  node.type = 'button'; node.onclick = action; return node;
}
function row(label: string, detail: string, action: () => void, icon: IconName = 'appChat'): HTMLButtonElement {
  const node = el('button', '', 'home-row'); node.type = 'button';
  const glyph = el('span', '', 'home-row-icon'); glyph.innerHTML = iconHtml(icon); glyph.setAttribute('aria-hidden', 'true');
  const content = el('span', '', 'home-row-content');
  content.append(el('span', label, 'home-row-title'), el('span', detail, 'home-muted'));
  node.append(glyph, content); node.title = label; node.onclick = action; return node;
}
function appendWithDisclosure(host: HTMLElement, items: HTMLElement[], limit: number): void {
  host.append(...items.slice(0, limit));
  if (items.length <= limit) return;
  const more = el('details', '', 'home-more');
  more.append(el('summary', `Show ${items.length - limit} more`));
  const body = el('div', '', 'home-more-body'); body.append(...items.slice(limit)); more.append(body);
  host.append(more);
}
function age(at: number): string {
  if (!at) return 'No recent activity';
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return mins < 1 ? 'Just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
}
function openChat(id: string): void { launchApp('code', { chatId: id }); }
async function openBoard(id: string): Promise<void> {
  navigateToCodeBoards();
  const view = await import('../orchestrator/boards-view');
  await view.openBoardsView(); view.showBoard(id);
}
async function openFile(path: string, workspace = mountedWorkspace): Promise<void> {
  launchApp('code');
  try {
    const { ensureCodeWorkspaceModules } = await import('../boot/code-workspace-modules');
    await ensureCodeWorkspaceModules();
    const { openFileInViewer } = await import('./file-viewer');
    const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(path) ? path : `${workspace.replace(/[\\/]$/, '')}/${path}`;
    await openFileInViewer(absolute, { asCode: true });
  } catch { showToast('Could not open this file. It may have moved or its worktree may have been removed.', 'error'); }
}
function section(id: string, title: string, actionLabel?: string, action?: () => void): HTMLElement {
  const node = el('section', '', `home-section home-${id}`);
  const heading = el('div', '', 'home-section-heading'); const h = el('h2', title); h.id = `home-${id}-title`;
  node.setAttribute('aria-labelledby', h.id); heading.append(h);
  if (actionLabel && action) heading.append(button(actionLabel, action));
  const body = el('div', '', 'home-section-body'); body.id = `home-${id}-body`;
  body.append(el('p', 'Loading…', 'home-muted')); node.append(heading, body); return node;
}
function paint(id: string, data: unknown, render: (host: HTMLElement) => void): void {
  const host = document.getElementById(`home-${id}-body`); if (!host) return;
  const fingerprint = JSON.stringify(data);
  host.querySelector('.home-section-error')?.remove();
  if (fingerprints.get(id) === fingerprint) return;
  fingerprints.set(id, fingerprint); host.replaceChildren(); render(host);
}
function unavailable(id: string, retry: () => void): void {
  const host = document.getElementById(`home-${id}-body`); if (!host) return;
  if (!fingerprints.has(id)) host.replaceChildren();
  host.querySelector('.home-section-error')?.remove();
  const message = el('div', '', 'home-section-error');
  message.append(el('p', fingerprints.has(id) ? 'Showing the last update. Could not refresh.' : 'Could not load this section.', 'home-muted'), button('Retry', retry));
  host.append(message);
}
function current(version: number, workspace: string): boolean {
  return generation === version && getForegroundAppId() === 'home' && getWorkspacePath() === workspace;
}

function setSectionVisible(id: string, visible: boolean): void {
  const host = document.getElementById(`home-${id}-body`);
  const sectionNode = host?.closest<HTMLElement>('.home-section');
  if (sectionNode) sectionNode.hidden = !visible;
}

function homeWorkState() {
  if (!sessionState) return null;
  const all = getChatsForWorkspace(mountedWorkspace, sessionState);
  const ids = new Set(all.map(chat => chat.id));
  const chats = getSidebarListedChatsForWorkspace(mountedWorkspace, sessionState)
    .filter(chat => !isBoardOwnedChat(chat));
  const turns = listMainTurnActivity().filter(turn => ids.has(turn.chatId));
  const runs = listActiveSubAgentRuns().filter(run =>
    run.parentChatId && ids.has(run.parentChatId) && (run.status === 'running' || run.status === 'queued'));
  return { all, chats, turns, runs };
}

function renderResume(): void {
  const state = homeWorkState();
  if (!state) return;
  const choice = chooseHomeResumeTarget({
    chats: state.chats.map(chat => ({
      id: chat.id,
      name: chat.name,
      lastMessageAt: getChatLastMessageAt(chat),
    })),
    turns: state.turns,
    agentRuns: state.runs,
    boards,
  });
  paint('resume', choice, host => {
    const action = choice.kind === 'chat' && choice.id
      ? () => openChat(choice.id!)
      : choice.kind === 'board' && choice.id
        ? () => void openBoard(choice.id!)
        : () => launchApp('code');
    const item = row(choice.label, choice.detail, action, choice.kind === 'board' ? 'modeOrchestrate' : 'appCode');
    item.classList.add('home-row--resume');
    item.querySelector('.home-row-content')?.prepend(el('span', 'PRIMARY ACTION', 'home-resume-label'));
    const arrow = el('span', '→', 'home-row-arrow'); arrow.setAttribute('aria-hidden', 'true'); item.append(arrow);
    host.append(item);
  });
}

function renderInFlight(): void {
  const state = homeWorkState();
  if (!state) return;
  const items: Array<{ key: string; label: string; detail: string; action: () => void; icon?: IconName }> = [];
  const coveredChats = new Set<string>();
  for (const turn of state.turns) {
    if (turn.phase === 'pending_question') continue;
    const chat = state.chats.find(candidate => candidate.id === turn.chatId);
    if (!chat) continue;
    const agents = state.runs.filter(run => run.parentChatId === chat.id).length;
    const detail = `${phaseLabel(turn.phase)}${agents ? ` · ${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}`;
    items.push({ key: `turn:${chat.id}`, label: chat.name || 'Untitled chat', detail, action: () => openChat(chat.id) });
    coveredChats.add(chat.id);
  }
  for (const run of state.runs) {
    if (!run.parentChatId || coveredChats.has(run.parentChatId)) continue;
    const chat = state.chats.find(candidate => candidate.id === run.parentChatId);
    if (!chat) continue;
    const agents = state.runs.filter(candidate => candidate.parentChatId === chat.id).length;
    items.push({
      key: `agents:${chat.id}`,
      label: chat.name || 'Untitled chat',
      detail: `${agents} ${agents === 1 ? 'agent' : 'agents'} in flight`,
      action: () => openChat(chat.id),
    });
    coveredChats.add(chat.id);
  }
  for (const board of boards.filter(candidate => candidate.status === 'running')) {
    items.push({
      key: `board:${board.boardId}`,
      label: board.name,
      detail: `${board.mergedCount ?? 0}/${board.taskCount} tasks merged`,
      action: () => void openBoard(board.boardId),
      icon: 'modeOrchestrate',
    });
  }
  for (const [index, label] of runningScheduledJobs.entries()) {
    items.push({
      key: `schedule:${index}:${label}`,
      label,
      detail: 'Scheduled run in progress',
      action: () => launchApp('scheduler'),
      icon: 'appScheduler',
    });
  }
  setSectionVisible('inflight', items.length > 0);
  paint('inflight', items.map(({ key, label, detail }) => [key, label, detail]), host => {
    appendWithDisclosure(host, items.map(item => row(item.label, item.detail, item.action, item.icon)), 5);
  });
  renderResume();
}

function renderAttention(): void {
  if (!sessionState) return;
  const chats = getChatsForWorkspace(mountedWorkspace, sessionState);
  const ids = new Set(chats.map(c => c.id));
  const questions = listChatsAwaitingAnswers().filter(id => ids.has(id));
  const troubled = boards.filter(b => (b.attentionCount ?? 0) > 0 || b.finalTestFailed);
  const issueFailures = collectIssues({ workspacePath: mountedWorkspace, scope: 'current_workspace', hideDone: true })
    .filter(i => i.agent?.phase === 'failed' || i.agent?.phase === 'awaiting_input');
  paint('attention', [questions, troubled, gitConflicts, issueFailures, boardsAvailable, gitAvailable], host => {
    const items: HTMLElement[] = [];
    for (const id of questions) items.push(row(chats.find(c => c.id === id)?.name || 'Chat needs an answer', 'Waiting for your answer', () => openChat(id)));
    for (const board of troubled) items.push(row(board.name, board.finalTestFailed ? 'Final check failed' : `${board.attentionCount} tasks need attention`, () => void openBoard(board.boardId), 'modeOrchestrate'));
    if (gitConflicts) items.push(row(`${gitConflicts} files have merge conflicts`, 'Review in Source Control', () => launchApp('source-control'), 'gitBranch'));
    for (const issue of issueFailures) items.push(row(`${issue.id} · ${issue.title}`, issue.agent?.step || 'Agent needs attention', () => { window.location.hash = `#/app/issues/${encodeURIComponent(issue.id)}`; }, 'appIssues'));
    if (items.length) appendWithDisclosure(host, items, 6);
    else host.append(el('p', boardsAvailable && gitAvailable ? 'Nothing needs your attention.' : 'No pending questions. Some project status is still unavailable.', 'home-muted home-all-clear'));
  });
}

function refreshLocal(): void {
  const state = homeWorkState();
  if (!state || !sessionState) return;
  const workspace = mountedWorkspace;
  const { all, runs, turns } = state;
  const chats = state.chats.slice(0, 5);
  paint('chats', [chats.map(c => [c.id, c.name, age(getChatLastMessageAt(c)), c.modelId]), runs.map(r => [r.runId, r.status]), turns], host => {
    for (const chat of chats) {
      const active = runs.filter(r => r.parentChatId === chat.id && (r.status === 'running' || r.status === 'queued')).length;
      const turn = turns.find(t => t.chatId === chat.id);
      host.append(row(chat.name || 'Untitled chat', `${turn ? `${phaseLabel(turn.phase)} · ` : ''}${active ? `${active} agents running · ` : ''}${age(getChatLastMessageAt(chat))}${chat.modelId ? ` · ${chat.modelId}` : ''}`, () => openChat(chat.id)));
    }
    if (!chats.length) host.append(el('p', 'Start a chat to plan, build, or debug this project.', 'home-muted'));
  });
  const recent = listRecentViewerFiles(workspace).slice(0, 6);
  paint('files', recent, host => {
    for (const file of recent) host.append(row(file.path, age(file.openedAt), () => void openFile(file.path), 'fileText'));
    if (!recent.length) host.append(el('p', 'Files you open in Code appear here.', 'home-muted'), button('Browse files', () => launchApp('code')));
  });
  const priorities = sortedPriorities(getIssuesTaxonomySync());
  const rank = (id: string) => { const index = priorities.findIndex(p => p.id === id); return index < 0 ? priorities.length : index; };
  const issues = collectIssues({ workspacePath: workspace, scope: 'current_workspace', hideDone: true })
    .sort((a, b) => rank(a.priority) - rank(b.priority) || b.updatedAt - a.updatedAt).slice(0, 5);
  paint('issues', issues, host => {
    for (const issue of issues) host.append(row(`${issue.id} · ${issue.title}`, `${issue.status} · ${issue.priority}`, () => { window.location.hash = `#/app/issues/${encodeURIComponent(issue.id)}`; }, 'appIssues'));
    if (!issues.length) host.append(el('p', 'No open issues in this project.', 'home-muted'), button('Capture an issue', () => launchApp('issues')));
  });
  const tokens = all.reduce((sum, c) => sum + (c.tokenLedger?.totals?.totalTokens ?? 0), 0);
  paint('resources', tokens, host => {
    host.append(row('Brain', 'Project knowledge, memories, and code index', () => launchApp('brain'), 'appBrain'));
    host.append(row('Models & usage', `${tokens.toLocaleString()} tokens across project chats · cumulative`, () => launchApp('models', { modelsSection: 'usage' }), 'appModels'));
  });
  renderResume();
  renderInFlight();
  renderAttention();
}

async function refreshBoards(version: number, workspace: string): Promise<void> {
  try {
    const data = await listBoards();
    if (!current(version, workspace)) return;
    boards = data; boardsAvailable = true;
    const sorted = [...data].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || Number(a.finished) - Number(b.finished));
    paint('boards', sorted, host => {
      for (const board of sorted.slice(0, 4)) {
        const node = row(board.name, `${board.finished ? 'Finished' : board.status} · ${board.mergedCount ?? 0}/${board.taskCount} tasks merged`, () => void openBoard(board.boardId), 'modeOrchestrate');
        if (board.taskCount) { const progress = el('progress'); progress.max = board.taskCount; progress.value = board.mergedCount ?? 0; progress.setAttribute('aria-label', `${board.name}: tasks merged`); node.append(progress); }
        host.append(node);
      }
      if (!data.length) host.append(el('p', 'Turn a plan into a board and follow the work here.', 'home-muted'), button('Create a board', navigateToCodeOrchestrate));
    });
    renderAttention();
    renderInFlight();
  } catch { if (current(version, workspace)) { boardsAvailable = false; unavailable('boards', () => void refreshBoards(version, workspace)); renderAttention(); } }
}

async function refreshGit(version: number, workspace: string): Promise<void> {
  try {
    const status = await gitStatus(workspace);
    if (!current(version, workspace)) return;
    if (!status.ok) {
      if (isMissingGitRepositoryError(status.error ?? '')) {
        gitAvailable = true; gitConflicts = 0;
        setSectionVisible('review', false);
        paint('repository', 'no-git', host => host.append(el('p', 'This folder does not have a Git repository.', 'home-muted'), button('Set up Git', () => launchApp('source-control'))));
        renderAttention(); return;
      }
      throw new Error(status.error);
    }
    const entries = [...(status.staged ?? []), ...(status.unstaged ?? []), ...(status.untracked ?? [])];
    const paths = [...new Map(entries.map(e => [e.path, e])).values()];
    gitConflicts = paths.filter(e => /U|AA|DD/.test(e.status)).length;
    gitAvailable = true;
    const diff = await gitDiffSummary(workspace);
    if (!current(version, workspace)) return;
    const additions = diff.additions ?? 0, deletions = diff.deletions ?? 0;
    paint('repository', [status, additions, deletions], host => {
      host.append(el('p', `${status.branch || 'Detached HEAD'} · ${status.ahead ?? 0} ahead · ${status.behind ?? 0} behind`, 'home-mono'));
      host.append(el('p', `${paths.length} changed files${diff.ok ? ` · +${additions} −${deletions} tracked lines` : ''}`, 'home-repo-total home-mono'));
      for (const file of paths.slice(0, 5)) host.append(row(file.path, file.status || 'Untracked', () => launchApp('source-control'), 'fileText'));
      if (!paths.length) host.append(el('p', 'Working tree is clean.', 'home-muted'));
    });
    setSectionVisible('review', paths.length > 0);
    paint('review', [status.branch, status.ahead, status.behind, paths.length, additions, deletions, diff.ok], host => {
      if (!paths.length) return;
      const conflictDetail = gitConflicts ? `${gitConflicts} conflicts · ` : '';
      const lineDetail = diff.ok ? ` · +${additions} −${deletions} tracked lines` : '';
      host.append(row(`${paths.length} ${paths.length === 1 ? 'file' : 'files'} ready to review`, `${conflictDetail}${status.branch || 'Detached HEAD'}${lineDetail}`, () => launchApp('source-control'), 'gitBranch'));
    });
    renderAttention();
  } catch { if (current(version, workspace)) { gitAvailable = false; setSectionVisible('review', false); unavailable('repository', () => void refreshGit(version, workspace)); renderAttention(); } }
}

async function refreshSchedule(version: number, workspace: string): Promise<void> {
  try {
    const data = (await fetchSchedulerJobs()).filter(j => j.workspacePath && workspacePathsEqual(j.workspacePath, workspace));
    if (!current(version, workspace)) return;
    runningScheduledJobs = data.filter(job => job.running).map(job => job.label);
    data.sort((a, b) => Number(b.running) - Number(a.running) || Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));
    paint('schedule', data, host => {
      for (const job of data.slice(0, 4)) host.append(row(job.label, job.running ? 'Running now' : !job.enabled ? 'Paused' : job.nextRunAt ? `Next: ${new Date(job.nextRunAt).toLocaleString()}` : 'Scheduled', () => launchApp('scheduler'), 'appScheduler'));
      if (!data.length) host.append(el('p', 'No scheduled jobs for this project.', 'home-muted'), button('Schedule work', () => launchApp('scheduler')));
    });
    renderInFlight();
  } catch { if (current(version, workspace)) { runningScheduledJobs = []; unavailable('schedule', () => void refreshSchedule(version, workspace)); renderInFlight(); } }
}

async function refresh(): Promise<void> {
  clearTimeout(timer);
  if (getForegroundAppId() !== 'home' || document.hidden) return;
  if (getWorkspacePath() !== mountedWorkspace) { openHome(); return; }
  const version = generation, workspace = mountedWorkspace;
  try {
    await ensureSessionsReady();
    if (!isIssuesStoreLoaded()) await loadIssuesFromStorage();
    if (!current(version, workspace)) return;
    refreshLocal();
  } catch { if (current(version, workspace)) { unavailable('chats', () => void refresh()); unavailable('issues', () => void refresh()); } }
  await Promise.allSettled([refreshBoards(version, workspace), refreshGit(version, workspace), refreshSchedule(version, workspace)]);
  if (current(version, workspace)) timer = setTimeout(() => void refresh(), 10000);
}

export async function openHome(): Promise<void> {
  initHomePage();
  generation++; clearTimeout(timer); activityCleanup?.(); fingerprints.clear();
  const opening = generation;
  if (!getWorkspacePath()) await loadWorkspaceFromServer();
  if (generation !== opening || getForegroundAppId() !== 'home') return;
  mountedWorkspace = getWorkspacePath(); boards = []; gitConflicts = 0; boardsAvailable = false; gitAvailable = false; runningScheduledJobs = [];
  const root = document.getElementById('homeView')!;
  root.classList.add('is-open'); root.replaceChildren();
  const page = el('div', '', 'home-page');
  const header = el('header', '', 'home-header');
  const identity = el('div', '', 'home-identity');
  const mark = el('span', '', 'home-project-mark'); mark.innerHTML = iconHtml('appCode'); mark.setAttribute('aria-hidden', 'true');
  const title = el('div', '', 'home-title'); title.append(el('p', 'ACTION INBOX', 'home-eyebrow'), el('h1', getWorkspaceLabel() || 'Your project'));
  const path = el('p', mountedWorkspace || 'Choose a workspace to get started', 'home-muted home-path'); path.title = mountedWorkspace; title.append(path);
  const actions = el('div', '', 'home-actions');
  actions.append(button('Switch project', () => { void import('../os/workspace-gate').then(m => m.openWorkspaceGate({ switch: true })); }));
  identity.append(mark, title); header.append(identity, actions); page.append(header);
  const inbox = el('div', '', 'home-action-inbox');
  const inflight = section('inflight', 'In flight'); inflight.hidden = true;
  const review = section('review', 'Review changes'); review.hidden = true;
  inbox.append(section('resume', 'Resume work'), section('attention', 'Needs attention'), inflight, review);
  page.append(inbox);

  const overview = el('details', '', 'home-overview');
  const overviewSummary = el('summary', '', 'home-overview-summary');
  const overviewLabel = el('span', '', 'home-overview-label');
  overviewLabel.append(el('strong', 'Project overview'), el('span', 'Boards, repository, issues, recent files, schedules, activity, and resources', 'home-muted'));
  const overviewChevron = el('span', '', 'home-overview-chevron');
  overviewChevron.innerHTML = iconHtml('chevronRight'); overviewChevron.setAttribute('aria-hidden', 'true');
  overviewSummary.append(overviewLabel, overviewChevron);
  const overviewBody = el('div', '', 'home-overview-body');
  const grid = el('div', '', 'home-work-grid');
  const work = el('div', '', 'home-work');
  const projectWork = el('div', '', 'home-project-work');
  projectWork.append(section('boards', 'Boards', 'View all', navigateToCodeBoards), section('files', 'Recent files'), section('schedule', 'Scheduled work'));
  work.append(section('chats', 'Recent chats', 'View all', () => launchApp('code')), projectWork);
  const context = el('div', '', 'home-context'); context.append(section('repository', 'Repository', 'Review changes', () => launchApp('source-control')), section('issues', 'Issues', 'View all', () => launchApp('issues')));
  grid.append(work, context); overviewBody.append(grid);
  const activity = el('section', '', 'home-section home-activity'); activity.setAttribute('aria-label', 'AI code edits'); overviewBody.append(activity);
  overviewBody.append(section('resources', 'Project resources'));
  overview.append(overviewSummary, overviewBody); page.append(overview);
  const footer = el('footer', '', 'home-footer'); footer.append(el('span', 'Project summaries refresh every 10 seconds', 'home-muted'), button('Refresh', () => openHome())); page.append(footer);
  root.append(page);
  const version = generation, workspace = mountedWorkspace;
  if (workspace) activityCleanup = mountHomeActivity(activity, workspace, () => current(version, workspace), (path, root) => void openFile(path, root), openChat,
    id => Boolean(sessionState?.chats.some(chat => chat.id === id)));
  else activity.append(el('p', 'Choose a project to see its code activity.', 'home-muted'));
  if (workspace) void refresh();
  else for (const id of ['resume', 'attention', 'chats', 'boards', 'repository', 'issues', 'files', 'schedule', 'resources']) {
    paint(id, 'no-workspace', host => host.append(el('p', 'Choose a project to see its work here.', 'home-muted')));
  }
}

export function initHomePage(): void {
  if (!document.getElementById('homeView')) {
    const root = el('main', '', 'mn-os-app-layer'); root.id = 'homeView'; root.dataset.osApp = 'home';
    document.getElementById('osAppsLayer')?.append(root);
  }
  if (initialized) return;
  initialized = true;
  subscribeInstances(() => {
    if (getForegroundAppId() !== 'home') { generation++; clearTimeout(timer); activityCleanup?.(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (getForegroundAppId() === 'home') void refresh(); });
}
