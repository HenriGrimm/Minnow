import '../styles/home.css';
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
const fingerprints = new Map<string, string>();

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
function age(at: number): string {
  if (!at) return 'No recent activity';
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return mins < 1 ? 'Just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
}
function openChat(id: string): void { launchApp('code', { chatId: id }); }
async function newChat(): Promise<void> {
  try {
    const workspace = getWorkspacePath();
    const { ensureCodeWorkspaceModules } = await import('../boot/code-workspace-modules');
    await ensureCodeWorkspaceModules();
    await ensureSessionsReady();
    if (getWorkspacePath() !== workspace || getForegroundAppId() !== 'home') return;
    const { createChatWithMode } = await import('./sidebar');
    const created = createChatWithMode({ modeId: 'general' });
    if (created.ok && created.chatId) openChat(created.chatId);
  } catch { showToast('Could not create a chat. Try again.', 'error'); }
}
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

function renderAttention(): void {
  if (!sessionState) return;
  const chats = getChatsForWorkspace(mountedWorkspace, sessionState);
  const ids = new Set(chats.map(c => c.id));
  const questions = listChatsAwaitingAnswers().filter(id => ids.has(id));
  const troubled = boards.filter(b => (b.attentionCount ?? 0) > 0 || b.finalTestFailed);
  const issueFailures = collectIssues({ workspacePath: mountedWorkspace, scope: 'current_workspace', hideDone: true })
    .filter(i => i.agent?.phase === 'failed' || i.agent?.phase === 'awaiting_input');
  paint('attention', [questions, troubled, gitConflicts, issueFailures, boardsAvailable, gitAvailable], host => {
    for (const id of questions) host.append(row(chats.find(c => c.id === id)?.name || 'Chat needs an answer', 'Waiting for your answer', () => openChat(id)));
    for (const board of troubled.slice(0, 4)) host.append(row(board.name, board.finalTestFailed ? 'Final check failed' : `${board.attentionCount} tasks need attention`, () => void openBoard(board.boardId), 'modeOrchestrate'));
    if (gitConflicts) host.append(row(`${gitConflicts} files have merge conflicts`, 'Review in Source Control', () => launchApp('source-control'), 'gitBranch'));
    for (const issue of issueFailures.slice(0, 4)) host.append(row(`${issue.id} · ${issue.title}`, issue.agent?.step || 'Agent needs attention', () => { window.location.hash = `#/app/issues/${encodeURIComponent(issue.id)}`; }, 'appIssues'));
    if (!host.childElementCount) host.append(el('p', boardsAvailable && gitAvailable ? 'Nothing needs your attention.' : 'No pending questions. Some project status is still unavailable.', 'home-muted home-all-clear'));
  });
}

function refreshLocal(): void {
  if (!sessionState) return;
  const workspace = mountedWorkspace;
  const all = getChatsForWorkspace(workspace, sessionState);
  const ids = new Set(all.map(c => c.id));
  const runs = listActiveSubAgentRuns().filter(r => r.parentChatId && ids.has(r.parentChatId));
  const turns = listMainTurnActivity().filter(t => ids.has(t.chatId));
  const chats = getSidebarListedChatsForWorkspace(workspace, sessionState).filter(c => !isBoardOwnedChat(c)).slice(0, 5);
  paint('chats', [chats.map(c => [c.id, c.name, age(getChatLastMessageAt(c)), c.modelId]), runs.map(r => [r.runId, r.status]), turns], host => {
    for (const chat of chats) {
      const active = runs.filter(r => r.parentChatId === chat.id && (r.status === 'running' || r.status === 'queued')).length;
      const turn = turns.find(t => t.chatId === chat.id);
      host.append(row(chat.name || 'Untitled chat', `${turn ? `${turn.phase.replaceAll('_', ' ')} · ` : ''}${active ? `${active} agents running · ` : ''}${age(getChatLastMessageAt(chat))}${chat.modelId ? ` · ${chat.modelId}` : ''}`, () => openChat(chat.id)));
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
  } catch { if (current(version, workspace)) { boardsAvailable = false; unavailable('boards', () => void refreshBoards(version, workspace)); renderAttention(); } }
}

async function refreshGit(version: number, workspace: string): Promise<void> {
  try {
    const status = await gitStatus(workspace);
    if (!current(version, workspace)) return;
    if (!status.ok) {
      if (isMissingGitRepositoryError(status.error ?? '')) {
        gitAvailable = true; gitConflicts = 0;
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
    renderAttention();
  } catch { if (current(version, workspace)) { gitAvailable = false; unavailable('repository', () => void refreshGit(version, workspace)); renderAttention(); } }
}

async function refreshSchedule(version: number, workspace: string): Promise<void> {
  try {
    const data = (await fetchSchedulerJobs()).filter(j => j.workspacePath && workspacePathsEqual(j.workspacePath, workspace));
    if (!current(version, workspace)) return;
    data.sort((a, b) => Number(b.running) - Number(a.running) || Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));
    paint('schedule', data, host => {
      for (const job of data.slice(0, 4)) host.append(row(job.label, job.running ? 'Running now' : !job.enabled ? 'Paused' : job.nextRunAt ? `Next: ${new Date(job.nextRunAt).toLocaleString()}` : 'Scheduled', () => launchApp('scheduler'), 'appScheduler'));
      if (!data.length) host.append(el('p', 'No scheduled jobs for this project.', 'home-muted'), button('Schedule work', () => launchApp('scheduler')));
    });
  } catch { if (current(version, workspace)) unavailable('schedule', () => void refreshSchedule(version, workspace)); }
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
  mountedWorkspace = getWorkspacePath(); boards = []; gitConflicts = 0; boardsAvailable = false; gitAvailable = false;
  const root = document.getElementById('homeView')!;
  root.classList.add('is-open'); root.replaceChildren();
  const page = el('div', '', 'home-page');
  const header = el('header', '', 'home-header');
  const title = el('div'); title.append(el('p', 'HOME', 'home-eyebrow'), el('h1', getWorkspaceLabel() || 'Your project'));
  const path = el('p', mountedWorkspace || 'Choose a workspace to get started', 'home-muted home-path'); path.title = mountedWorkspace; title.append(path);
  const actions = el('div', '', 'home-actions');
  actions.append(button('Switch project', () => { void import('../os/workspace-gate').then(m => m.openWorkspaceGate({ switch: true })); }),
    button('New chat', () => void newChat()), button('New board', navigateToCodeOrchestrate), button('Open Code', () => launchApp('code'), true));
  header.append(title, actions); page.append(header);
  page.append(section('attention', 'Needs attention'));
  const grid = el('div', '', 'home-work-grid');
  const work = el('div', '', 'home-work'); work.append(el('h2', 'Continue working', 'home-group-title'), section('chats', 'Chats', 'View all', () => launchApp('code')), section('boards', 'Boards', 'View all', navigateToCodeBoards));
  const context = el('div', '', 'home-context'); context.append(section('repository', 'Repository', 'Review changes', () => launchApp('source-control')), section('issues', 'Issues', 'View all', () => launchApp('issues')));
  grid.append(work, context); page.append(grid);
  const activity = el('section', '', 'home-section home-activity'); activity.setAttribute('aria-label', 'AI code edits'); page.append(activity);
  const bottom = el('div', '', 'home-bottom-grid'); bottom.append(section('files', 'Recent files'), section('schedule', 'Scheduled work'), section('resources', 'Project resources')); page.append(bottom);
  const footer = el('footer', '', 'home-footer'); footer.append(el('span', 'Project summaries refresh every 10 seconds', 'home-muted'), button('Refresh', () => openHome())); page.append(footer);
  root.append(page);
  const version = generation, workspace = mountedWorkspace;
  if (workspace) activityCleanup = mountHomeActivity(activity, workspace, () => current(version, workspace), (path, root) => void openFile(path, root), openChat);
  else activity.append(el('p', 'Choose a project to see its code activity.', 'home-muted'));
  if (workspace) void refresh();
  else for (const id of ['attention', 'chats', 'boards', 'repository', 'issues', 'files', 'schedule', 'resources']) {
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
