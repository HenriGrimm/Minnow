import '../styles/code-overview.css';
import { iconHtml } from './icon';

import { listActiveSubAgentRuns } from '../agents/orchestrator';
import type { SubAgentRun } from '../agents/types';
import { fetchBrainCodeStatus, fetchBrainStatus } from '../brain/client';
import { fetchHardware } from '../models/hardware-client';
import {
  getCurrentRoute,
  launchApp,
  navigateToCodeChat,
  navigateToCodeOverview,
} from '../os/router';
import { fetchSchedulerJobs } from '../scheduler/client';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { getGroupsForWorkspace, isBoardOwnedChat, openBoardGroup, isLeftoverBoardRunning, leftoverBoardProgressPercent } from '../state/chat-groups';
import { gitStatus } from '../state/git-api';
import { getChatsForWorkspace, getChatLastMessageAt, getSidebarListedChatsForWorkspace } from '../state/session-workspace-scope';
import { sessionState } from '../state/sessions';
import { isLocalServerAvailable } from '../tools/config';
import { getWorkspaceLabel, getWorkspacePath } from '../state/workspace';
import { formatCompactCount } from '../usage/format-compact-count';
import type { Chat, ChatGroup } from '../types';
import type { CommitVisual, GitGraphHandle } from './git-graph';
import {
  showGitGraphCommitContextMenu,
  type GitGraphContextMenuCtx,
} from './git-graph-context-menu';
import { createChat, switchChat } from './sidebar';
import { gitUiCtx, showGitUiFailure } from './git-ui-op';
import { notifyCodeStageViewChanged, stripMainColumnOverlayClasses } from './main-column-overlay';
import {
  isMissingGitRepositoryError,
  renderGitNoRepositoryState,
} from './git-no-repo-state';

const ROOT_ID = 'codeOverviewRoot';
const CHAT_AREA_CLASS = 'chat-area--code-overview';
const MAIN_COLUMN_CLASS = 'main-column--code-overview';

const POLL_RUNS_MS = 3000;
const POLL_SLOW_MS = 10000;
const RECENT_SESSION_LIMIT = 8;

let initialized = false;
let returnChatId: string | null = null;
let runsTimer: number | undefined;
let slowTimer: number | undefined;
let gitGraphHandle: GitGraphHandle | null = null;
let overviewCurrentBranchName = '';
let refreshGen = 0;

/** True when the overview overlay is mounted in #chatArea. */
export function isCodeOverviewOpen(): boolean {
  return Boolean(document.getElementById(ROOT_ID));
}

/** Tear down code overview so sidebar navigation can repaint chat or board. */
export function dismissCodeOverviewForNavigation(): boolean {
  if (!isCodeOverviewOpen()) return false;
  closeCodeOverview({ skipNavigate: true, restoreChat: false });
  navigateToCodeChat();
  return true;
}

function formatRelativeTime(ts: number): string {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return '—';
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function isRunActive(run: SubAgentRun): boolean {
  return run.status === 'queued' || run.status === 'running';
}

function sumWorkspaceTokens(workspacePath: string): number {
  if (!sessionState) return 0;
  const chats = getChatsForWorkspace(workspacePath, sessionState);
  return chats.reduce((sum, chat) => sum + (chat.tokenLedger?.totals?.totalTokens ?? 0), 0);
}

function readStripText(id: string): string {
  return document.getElementById(id)?.textContent?.trim() ?? '—';
}

function setPulseValue(
  id: string,
  text: string,
  tone?: 'accent' | 'success' | 'warning' | 'danger',
): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove(
    'code-overview__pulse-value--accent',
    'code-overview__pulse-value--success',
    'code-overview__pulse-value--warning',
    'code-overview__pulse-value--danger',
  );
  if (tone) el.classList.add(`code-overview__pulse-value--${tone}`);
}

function renderSkeleton(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'code-overview__skeleton';
  for (let i = 0; i < 3; i += 1) {
    const line = document.createElement('div');
    line.className = 'code-overview__skeleton-line';
    wrap.appendChild(line);
  }
  host.appendChild(wrap);
}

function renderEmpty(host: HTMLElement, message: string): void {
  host.replaceChildren();
  const p = document.createElement('p');
  p.className = 'code-overview__empty';
  p.textContent = message;
  host.appendChild(p);
}

function renderError(host: HTMLElement, message: string, onRetry?: () => void): void {
  host.replaceChildren();
  const p = document.createElement('p');
  p.className = 'code-overview__error';
  p.textContent = message;
  host.appendChild(p);
  if (onRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-overview__retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', onRetry);
    host.appendChild(btn);
  }
}

/** Informational rail block when the workspace has no git metadata yet. */
function renderNoGitRepository(host: HTMLElement): void {
  // Shared default: stay on overview and run /git-setup in a background chat.
  renderGitNoRepositoryState(host);
}

function buildSparklineSvg(values: number[], className: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 80 28');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('code-overview__spark-svg', className);
  if (!values.length) return svg;

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = values.length === 1 ? 40 : (i / (values.length - 1)) * 80;
      const y = 26 - ((v - min) / range) * 24;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', 'currentColor');
  poly.setAttribute('stroke-width', '1.5');
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('points', points);
  svg.appendChild(poly);
  return svg;
}

function buildShell(): HTMLElement {
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'code-overview-root is-open';
  root.innerHTML = `
    <div class="code-overview__scroll">
      <div class="code-overview__toolbar">
        <div class="code-overview__title-block">
          <h1 class="code-overview__title">Overview</h1>
          <p class="code-overview__lede" id="codeOverviewWorkspaceLede">Workspace status and telemetry</p>
        </div>
        <div class="code-overview__toolbar-actions">
          <button type="button" class="code-overview__btn-ghost" id="codeOverviewRefresh" aria-label="Refresh overview">↻</button>
          <button type="button" class="code-overview__btn-new" id="codeOverviewNewChat">New chat</button>
        </div>
      </div>

      <div class="code-overview__pulse" id="codeOverviewPulse">
        <button type="button" class="code-overview__pulse-expand" id="codeOverviewPulseExpand" aria-expanded="false">
          <span class="code-overview__pulse-expand-label">Live metrics</span>
          <span class="code-overview__pulse-expand-preview" id="codeOverviewPulsePreview">—</span>
          ${iconHtml('chevronDown', { className: 'code-overview__pulse-expand-chevron' })}
        </button>
        <div class="code-overview__pulse-grid">
          <div class="code-overview__pulse-cell">
            <div class="code-overview__pulse-label">Agents</div>
            <div class="code-overview__pulse-value" id="pulseAgents">—</div>
          </div>
          <div class="code-overview__pulse-cell">
            <div class="code-overview__pulse-label">Boards</div>
            <div class="code-overview__pulse-value" id="pulseBoards">—</div>
          </div>
          <div class="code-overview__pulse-cell">
            <div class="code-overview__pulse-label">TPS</div>
            <div class="code-overview__pulse-value" id="pulseTps">—</div>
          </div>
          <div class="code-overview__pulse-cell">
            <div class="code-overview__pulse-label">Context</div>
            <div class="code-overview__pulse-value" id="pulseContext">—</div>
          </div>
          <div class="code-overview__pulse-cell">
            <div class="code-overview__pulse-label">VRAM</div>
            <div class="code-overview__pulse-value" id="pulseVram">—</div>
          </div>
        </div>
      </div>

      <div class="code-overview__activity">
        <div class="code-overview__primary">
          <section class="code-overview__section" aria-labelledby="codeOverviewRunningTitle">
            <div class="code-overview__section-head">
              <h2 class="code-overview__section-title" id="codeOverviewRunningTitle">Running now</h2>
            </div>
            <div class="code-overview__section-body" id="codeOverviewRunningBody"></div>
          </section>
          <section class="code-overview__section" aria-labelledby="codeOverviewSessionsTitle">
            <div class="code-overview__section-head">
              <h2 class="code-overview__section-title" id="codeOverviewSessionsTitle">Recent sessions</h2>
            </div>
            <div class="code-overview__section-body" id="codeOverviewSessionsBody"></div>
          </section>
        </div>
        <div class="code-overview__rail">
          <section class="code-overview__section" aria-labelledby="codeOverviewGitTitle">
            <div class="code-overview__section-head" data-code-overview-rail-toggle>
              <h2 class="code-overview__section-title" id="codeOverviewGitTitle">Git</h2>
              ${iconHtml('chevronDown', { className: 'code-overview__section-chevron' })}
            </div>
            <div class="code-overview__section-body code-overview__section-body--git" id="codeOverviewGitBody"></div>
          </section>
          <section class="code-overview__section" aria-labelledby="codeOverviewSystemTitle">
            <div class="code-overview__section-head" data-code-overview-rail-toggle>
              <h2 class="code-overview__section-title" id="codeOverviewSystemTitle">System</h2>
              ${iconHtml('chevronDown', { className: 'code-overview__section-chevron' })}
            </div>
            <div class="code-overview__section-body" id="codeOverviewSystemBody"></div>
          </section>
          <section class="code-overview__section" aria-labelledby="codeOverviewSchedulerTitle">
            <div class="code-overview__section-head" data-code-overview-rail-toggle>
              <h2 class="code-overview__section-title" id="codeOverviewSchedulerTitle">Scheduler</h2>
              ${iconHtml('chevronDown', { className: 'code-overview__section-chevron' })}
            </div>
            <div class="code-overview__section-body" id="codeOverviewSchedulerBody"></div>
          </section>
          <section class="code-overview__section" aria-labelledby="codeOverviewWorkspaceTitle">
            <div class="code-overview__section-head" data-code-overview-rail-toggle>
              <h2 class="code-overview__section-title" id="codeOverviewWorkspaceTitle">Workspace</h2>
              ${iconHtml('chevronDown', { className: 'code-overview__section-chevron' })}
            </div>
            <div class="code-overview__section-body" id="codeOverviewWorkspaceBody"></div>
          </section>
        </div>
      </div>

      <div class="code-overview__telemetry" id="codeOverviewTelemetry">
        <button
          type="button"
          class="code-overview__telemetry-expand"
          id="codeOverviewTelemetryExpand"
          aria-expanded="false"
          aria-controls="codeOverviewTelemetryGrid"
        >
          <span class="code-overview__telemetry-expand-label">Telemetry</span>
          <span class="code-overview__telemetry-expand-preview" id="codeOverviewTelemetryPreview">—</span>
          ${iconHtml('chevronDown', { className: 'code-overview__telemetry-expand-chevron' })}
        </button>
        <div class="code-overview__telemetry-head">
          <h2 class="code-overview__section-title">Telemetry</h2>
        </div>
        <div class="code-overview__telemetry-grid" id="codeOverviewTelemetryGrid"></div>
      </div>
    </div>
  `;
  return root;
}

function syncOverviewNavButtons(): void {
  const dashboardOpen = isCodeOverviewOpen();

  const sidebarBtn = document.getElementById('btnCodeOverviewSidebar');
  if (sidebarBtn) {
    if (dashboardOpen) sidebarBtn.setAttribute('aria-current', 'page');
    else sidebarBtn.removeAttribute('aria-current');
  }
}

async function closeCompetingMainColumnViews(): Promise<void> {
  const { closeOtherCodeStageViews } = await import('./main-column-overlay');
  await closeOtherCodeStageViews('overview');
}

function stopPolling(): void {
  if (runsTimer) window.clearInterval(runsTimer);
  if (slowTimer) window.clearInterval(slowTimer);
  runsTimer = undefined;
  slowTimer = undefined;
}

function startPolling(): void {
  stopPolling();
  runsTimer = window.setInterval(() => {
    if (document.hidden) return;
    void refreshRunningPanel();
    void refreshPulseBand();
  }, POLL_RUNS_MS);
  slowTimer = window.setInterval(() => {
    if (document.hidden) return;
    void refreshGitPanel();
    void refreshSystemPanel();
    void refreshSchedulerPanel();
    void refreshWorkspacePanel();
    refreshSessionsPanel();
    refreshTelemetryBand();
  }, POLL_SLOW_MS);
}

async function refreshPulseBand(): Promise<void> {
  const workspacePath = getWorkspacePath();
  const groups = sessionState ? getGroupsForWorkspace(workspacePath) : [];
  const boardGroups = groups.filter((g) => g.orchestrateBoard);
  const boardsActive = boardGroups.filter((g) => isLeftoverBoardRunning(g)).length;

  const agentCount = listActiveSubAgentRuns().filter(isRunActive).length;

  const tps = readStripText('stripTPS');
  const ctx = readStripText('stripCtx');
  let vramText = '—';
  let vramTone: 'warning' | 'danger' | undefined;

  if (isLocalServerAvailable()) {
    try {
      const res = await fetch('/api/system/vram', { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as {
          available?: boolean;
          usedMb?: number;
          totalMb?: number;
        };
        if (body.available && body.usedMb != null && body.totalMb) {
          const pct = Math.round((body.usedMb / body.totalMb) * 100);
          vramText = `${pct}%`;
          if (pct >= 90) vramTone = 'danger';
          else if (pct >= 70) vramTone = 'warning';
        } else {
          vramText = 'n/a';
        }
      }
    } catch {
      vramText = '—';
    }
  }

  setPulseValue('pulseAgents', String(agentCount), agentCount > 0 ? 'accent' : undefined);
  setPulseValue('pulseBoards', String(boardsActive), boardsActive > 0 ? 'accent' : undefined);
  setPulseValue('pulseTps', tps === '—' ? '—' : tps, tps !== '—' ? 'success' : undefined);
  setPulseValue('pulseContext', ctx, ctx !== '—' ? 'warning' : undefined);
  setPulseValue('pulseVram', vramText, vramTone);

  const preview = document.getElementById('codeOverviewPulsePreview');
  if (preview) {
    preview.textContent = `${agentCount} agents · ${boardsActive} boards`;
  }

  const lede = document.getElementById('codeOverviewWorkspaceLede');
  if (lede) {
    lede.textContent = `${getWorkspaceLabel()} — live status and telemetry`;
  }
}

function renderRunRow(run: SubAgentRun): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-overview__row is-entering';
  const dot = document.createElement('span');
  dot.className = `code-overview__status-dot ${run.status === 'running' ? 'ok' : 'warn'}`;
  dot.setAttribute('aria-hidden', 'true');

  const main = document.createElement('div');
  main.className = 'code-overview__row-main';
  const label = document.createElement('div');
  label.className = 'code-overview__row-label';
  label.textContent = run.task.trim() || run.type || run.runId;
  const sub = document.createElement('div');
  sub.className = 'code-overview__row-sub';
  sub.textContent = `${run.status} · ${formatElapsed(run.startedAt)}`;
  main.append(label, sub);

  const aside = document.createElement('div');
  aside.className = 'code-overview__row-aside';
  const chip = document.createElement('span');
  chip.className = 'code-overview__chip mode';
  chip.textContent = run.type || 'agent';
  aside.appendChild(chip);

  btn.append(dot, main, aside);
  btn.addEventListener('click', () => {
    void drillToRun(run);
  });
  return btn;
}

function renderBoardRow(group: ChatGroup): HTMLButtonElement {
  const board = group.orchestrateBoard;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-overview__row is-entering';
  const running = isLeftoverBoardRunning(group);
  const dot = document.createElement('span');
  dot.className = `code-overview__status-dot ${running ? 'ok' : 'idle'}`;
  dot.setAttribute('aria-hidden', 'true');

  const main = document.createElement('div');
  main.className = 'code-overview__row-main';
  const label = document.createElement('div');
  label.className = 'code-overview__row-label';
  label.textContent = group.name;
  const sub = document.createElement('div');
  sub.className = 'code-overview__row-sub';
  const taskCount = board?.tasks.length ?? 0;
  sub.textContent = running ? 'board running' : `${taskCount} tasks`;
  main.append(label, sub);

  const aside = document.createElement('div');
  aside.className = 'code-overview__row-aside';
  if (board && taskCount > 0) {
    const pct = leftoverBoardProgressPercent(group);
    const track = document.createElement('div');
    track.className = 'code-overview__progress';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div');
    fill.className = 'code-overview__progress-fill';
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    aside.appendChild(track);
  }
  const chip = document.createElement('span');
  chip.className = 'code-overview__chip';
  chip.textContent = 'board';
  aside.appendChild(chip);

  btn.append(dot, main, aside);
  btn.addEventListener('click', () => {
    openBoardGroup(group.id);
    void enterCodeChat();
  });
  return btn;
}

function renderSessionRow(chat: Chat): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-overview__row';
  const dot = document.createElement('span');
  dot.className = 'code-overview__status-dot idle';
  dot.setAttribute('aria-hidden', 'true');

  const main = document.createElement('div');
  main.className = 'code-overview__row-main';
  const label = document.createElement('div');
  label.className = 'code-overview__row-label';
  label.textContent = chat.name?.trim() || 'Untitled chat';
  const sub = document.createElement('div');
  sub.className = 'code-overview__row-sub';
  const tokens = chat.tokenLedger?.totals?.totalTokens;
  const tokenPart = tokens ? ` · ${formatCompactCount(tokens)} tok` : '';
  sub.textContent = `${chat.modelId || 'no model'} · ${formatRelativeTime(getChatLastMessageAt(chat))}${tokenPart}`;
  main.append(label, sub);

  btn.append(dot, main);
  btn.addEventListener('click', () => {
    switchChat(chat.id);
  });
  return btn;
}

async function drillToRun(run: SubAgentRun): Promise<void> {
  if (run.parentChatId) {
    switchChat(run.parentChatId);
  }
  const { toggleAgentActivityPanel, isAgentActivityPanelOpen } = await import('./agent-activity-panel');
  if (!isAgentActivityPanelOpen()) toggleAgentActivityPanel();
}

async function enterCodeChat(): Promise<void> {
  closeCodeOverview({ skipNavigate: true, restoreChat: false });
  navigateToCodeChat();
  const { restoreCodeSessionOnForeground } = await import('../os/code-launch');
  await restoreCodeSessionOnForeground();
}

async function refreshRunningPanel(): Promise<void> {
  const host = document.getElementById('codeOverviewRunningBody');
  if (!host) return;

  const workspacePath = getWorkspacePath();
  const groups = sessionState ? getGroupsForWorkspace(workspacePath) : [];
  const boardGroups = groups.filter((g) => g.orchestrateBoard);

  const runs = listActiveSubAgentRuns().filter(isRunActive);

  const rows: HTMLElement[] = [];
  for (const run of runs.slice(0, 12)) {
    rows.push(renderRunRow(run));
  }
  for (const group of boardGroups.filter((g) => isLeftoverBoardRunning(g)).slice(0, 6)) {
    rows.push(renderBoardRow(group));
  }

  host.replaceChildren();
  if (!rows.length) {
    renderEmpty(host, 'No agents running. Start a board in Orchestrate or open a chat.');
    return;
  }
  const list = document.createElement('div');
  list.className = 'code-overview__row-list';
  rows.forEach((row) => list.appendChild(row));
  host.appendChild(list);
}

function refreshSessionsPanel(): void {
  const host = document.getElementById('codeOverviewSessionsBody');
  if (!host || !sessionState) return;

  const chats = getSidebarListedChatsForWorkspace(getWorkspacePath(), sessionState)
    .filter((c) => !isBoardOwnedChat(c))
    .slice(0, RECENT_SESSION_LIMIT);

  host.replaceChildren();
  if (!chats.length) {
    renderEmpty(host, 'No sessions yet. Start with New chat.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'code-overview__row-list';
  for (const chat of chats) {
    list.appendChild(renderSessionRow(chat));
  }
  host.appendChild(list);
}

/** Context menu callbacks for the overview git graph (same menu as Source Control). */
function buildOverviewGraphContextMenuCtx(): GitGraphContextMenuCtx {
  const cwd = getWorkspacePath();
  return {
    cwd,
    onOpenChanges: (sha) => {
      void (async () => {
        await enterCodeChat();
        const { openGitCommitDiffPanel } = await import('./git-commit-diff-panel');
        await openGitCommitDiffPanel({ sha, cwd });
      })();
    },
    onRefresh: () => refreshGitPanel(),
    getCurrentBranch: () => overviewCurrentBranchName,
    onConflict: (message) =>
      showGitUiFailure(message, { chatKind: 'merge', ctx: gitUiCtx(cwd, overviewCurrentBranchName) }),
  };
}

async function refreshGitPanel(): Promise<void> {
  const host = document.getElementById('codeOverviewGitBody');
  if (!host) return;

  if (!isLocalServerAvailable()) {
    renderError(host, 'Git unavailable (Minnow is not running locally).', () => void refreshGitPanel());
    return;
  }

  const status = await gitStatus();
  if (!status.ok) {
    if (isMissingGitRepositoryError(status.error)) {
      renderNoGitRepository(host);
      return;
    }
    renderError(host, status.error ?? 'Could not load git status.', () => void refreshGitPanel());
    return;
  }

  overviewCurrentBranchName = status.branch ?? '';

  const summaryHost = document.createElement('div');
  summaryHost.className = 'code-overview__git-summary';
  const branchRow = document.createElement('div');
  branchRow.className = 'code-overview__stat-row';
  branchRow.innerHTML = `<span class="code-overview__stat-key">Branch</span><span class="code-overview__stat-val">${status.branch ?? '—'}</span>`;
  summaryHost.appendChild(branchRow);

  if (status.ahead != null || status.behind != null) {
    const syncRow = document.createElement('div');
    syncRow.className = 'code-overview__stat-row';
    const ahead = status.ahead ?? 0;
    const behind = status.behind ?? 0;
    const parts: string[] = [];
    if (ahead > 0) parts.push(`↑${ahead}`);
    if (behind > 0) parts.push(`↓${behind}`);
    const val = document.createElement('span');
    val.className = `code-overview__stat-val${ahead > 0 ? ' code-overview__stat-val--ahead' : behind > 0 ? ' code-overview__stat-val--behind' : ''}`;
    val.textContent = parts.length ? parts.join(' ') : 'in sync';
    syncRow.innerHTML = `<span class="code-overview__stat-key">Remote</span>`;
    syncRow.appendChild(val);
    summaryHost.appendChild(syncRow);
  }

  const staged = status.staged?.length ?? 0;
  const unstaged = status.unstaged?.length ?? 0;
  const untracked = status.untracked?.length ?? 0;
  const countsRow = document.createElement('div');
  countsRow.className = 'code-overview__stat-row';
  countsRow.innerHTML = `<span class="code-overview__stat-key">Changes</span><span class="code-overview__stat-val">${staged} staged · ${unstaged} unstaged · ${untracked} new</span>`;
  summaryHost.appendChild(countsRow);

  const graphMount = document.createElement('div');
  graphMount.id = 'codeOverviewGitGraph';

  host.replaceChildren(summaryHost, graphMount);

  gitGraphHandle?.destroy();
  const { renderGitGraph } = await import('./git-graph');
  gitGraphHandle = renderGitGraph(graphMount, {
    cwd: getWorkspacePath(),
    onSelectCommit: () => {
      void (async () => {
        await enterCodeChat();
        const { openGitSidePanel } = await import('./git-panel');
        await openGitSidePanel();
      })();
    },
    onContextMenu: (visual: CommitVisual, event: MouseEvent) => {
      void showGitGraphCommitContextMenu(visual, event, buildOverviewGraphContextMenuCtx());
    },
  });
  await gitGraphHandle.refresh();
}

async function refreshSystemPanel(): Promise<void> {
  const host = document.getElementById('codeOverviewSystemBody');
  if (!host) return;

  if (!isLocalServerAvailable()) {
    renderError(host, 'System metrics unavailable.', () => void refreshSystemPanel());
    return;
  }

  try {
    const [hw, vramRes] = await Promise.all([
      fetchHardware(),
      fetch('/api/system/vram', { cache: 'no-store' }),
    ]);
    host.replaceChildren();

    const cpuRow = document.createElement('div');
    cpuRow.className = 'code-overview__stat-row';
    cpuRow.innerHTML = `<span class="code-overview__stat-key">CPU</span><span class="code-overview__stat-val">${hw.cpuName} (${hw.cpuCores}c)</span>`;
    host.appendChild(cpuRow);

    const ramRow = document.createElement('div');
    ramRow.className = 'code-overview__stat-row';
    const ramUsed = hw.totalRamGb - hw.availableRamGb;
    ramRow.innerHTML = `<span class="code-overview__stat-key">RAM</span><span class="code-overview__stat-val">${ramUsed.toFixed(1)} / ${hw.totalRamGb.toFixed(0)} GB</span>`;
    host.appendChild(ramRow);

    if (vramRes.ok) {
      const vram = (await vramRes.json()) as {
        available?: boolean;
        usedMb?: number;
        totalMb?: number;
      };
      if (vram.available && vram.usedMb != null && vram.totalMb) {
        const pct = Math.round((vram.usedMb / vram.totalMb) * 100);
        const vramRow = document.createElement('div');
        vramRow.className = 'code-overview__stat-row';
        vramRow.innerHTML = `<span class="code-overview__stat-key">VRAM</span><span class="code-overview__stat-val">${(vram.usedMb / 1024).toFixed(1)} / ${(vram.totalMb / 1024).toFixed(1)} GB</span>`;
        host.appendChild(vramRow);
        const bar = document.createElement('div');
        bar.className = 'code-overview__vram-bar';
        const fill = document.createElement('div');
        fill.className = `code-overview__vram-fill${pct >= 85 ? ' is-high' : ''}`;
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        host.appendChild(bar);
      }
    }

    if (hw.gpuName) {
      const gpuRow = document.createElement('div');
      gpuRow.className = 'code-overview__stat-row';
      gpuRow.innerHTML = `<span class="code-overview__stat-key">GPU</span><span class="code-overview__stat-val">${hw.gpuName}</span>`;
      host.appendChild(gpuRow);
    }
  } catch {
    renderError(host, 'Could not load system metrics.', () => void refreshSystemPanel());
  }
}

async function refreshSchedulerPanel(): Promise<void> {
  const host = document.getElementById('codeOverviewSchedulerBody');
  if (!host) return;

  if (!isLocalServerAvailable()) {
    renderError(host, 'Scheduler unavailable.', () => void refreshSchedulerPanel());
    return;
  }

  try {
    const jobs = await fetchSchedulerJobs();
    host.replaceChildren();
    if (!jobs.length) {
      renderEmpty(host, 'No scheduled jobs. Open Scheduler to add one.');
      return;
    }

    const enabled = jobs.filter((j) => j.enabled);
    const nextJob = [...enabled]
      .filter((j) => j.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];

    const list = document.createElement('div');
    list.className = 'code-overview__row-list';

    if (nextJob?.nextRunAt) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'code-overview__row';
      row.innerHTML = `
        <span class="code-overview__status-dot ok" aria-hidden="true"></span>
        <div class="code-overview__row-main">
          <div class="code-overview__row-label">${nextJob.label}</div>
          <div class="code-overview__row-sub">Next · ${formatRelativeTime(Date.parse(nextJob.nextRunAt))}</div>
        </div>
      `;
      row.addEventListener('click', () => launchApp('scheduler'));
      list.appendChild(row);
    }

    const recent = [...jobs]
      .filter((j) => j.lastRunAt)
      .sort((a, b) => Date.parse(b.lastRunAt!) - Date.parse(a.lastRunAt!))
      .slice(0, 3);

    for (const job of recent) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'code-overview__row';
      const statusDot = job.running ? 'warn' : 'idle';
      row.innerHTML = `
        <span class="code-overview__status-dot ${statusDot}" aria-hidden="true"></span>
        <div class="code-overview__row-main">
          <div class="code-overview__row-label">${job.label}</div>
          <div class="code-overview__row-sub">Last · ${formatRelativeTime(Date.parse(job.lastRunAt!))}</div>
        </div>
      `;
      row.addEventListener('click', () => launchApp('scheduler'));
      list.appendChild(row);
    }

    host.appendChild(list);
  } catch {
    renderError(host, 'Could not load scheduler jobs.', () => void refreshSchedulerPanel());
  }
}

async function refreshWorkspacePanel(): Promise<void> {
  const host = document.getElementById('codeOverviewWorkspaceBody');
  if (!host) return;

  host.replaceChildren();
  renderSkeleton(host);

  const rows: Array<{ key: string; val: string }> = [];

  if (isLocalServerAvailable()) {
    const [brain, codeIndex, termRes] = await Promise.all([
      fetchBrainStatus(),
      fetchBrainCodeStatus(),
      fetch('/api/terminal/sessions', { cache: 'no-store' }).catch(() => null),
    ]);

    if (brain) {
      rows.push({ key: 'Brain pages', val: String(brain.pageCount) });
    }
    if (codeIndex) {
      rows.push({
        key: 'Code index',
        val: codeIndex.lastIndexedAt
          ? `${codeIndex.symbolCount ?? 0} symbols`
          : 'not indexed',
      });
    }
    if (termRes?.ok) {
      const body = (await termRes.json()) as { sessions?: unknown[] };
      rows.push({ key: 'Terminal sessions', val: String(body.sessions?.length ?? 0) });
    }
  }

  host.replaceChildren();
  if (!rows.length) {
    renderEmpty(host, 'Workspace services offline. Open Minnow for Brain and terminal counts.');
    return;
  }

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'code-overview__stat-row';
    el.innerHTML = `<span class="code-overview__stat-key">${row.key}</span><span class="code-overview__stat-val">${row.val}</span>`;
    host.appendChild(el);
  }
}

function buildTelemetryTile(
  label: string,
  value: string,
  options?: { uninstrumented?: boolean; detail?: string },
): HTMLElement {
  const tile = document.createElement('div');
  tile.className = 'code-overview__spark-tile';

  const lbl = document.createElement('div');
  lbl.className = 'code-overview__spark-label';
  lbl.textContent = label;

  const val = document.createElement('div');
  val.className = 'code-overview__spark-value';
  val.textContent = value;

  tile.append(lbl, val);

  if (options?.uninstrumented) {
    const note = document.createElement('p');
    note.className = 'code-overview__empty';
    note.style.fontSize = '11px';
    note.style.padding = '0';
    note.textContent = options.detail ?? 'Not tracked yet';
    tile.appendChild(note);
  }

  return tile;
}

function refreshTelemetryBand(): void {
  const grid = document.getElementById('codeOverviewTelemetryGrid');
  if (!grid) return;

  const workspacePath = getWorkspacePath();
  const tokens = sumWorkspaceTokens(workspacePath);
  const tpsRaw = readStripText('stripTPS');
  const ttftRaw = readStripText('stripTTFT');
  const ctxRaw = readStripText('stripCtx');

  const promptTokens = sessionState
    ? getChatsForWorkspace(workspacePath, sessionState).reduce(
        (s, c) => s + (c.tokenLedger?.totals?.promptTokens ?? 0),
        0,
      )
    : 0;
  const completionTokens = sessionState
    ? getChatsForWorkspace(workspacePath, sessionState).reduce(
        (s, c) => s + (c.tokenLedger?.totals?.completionTokens ?? 0),
        0,
      )
    : 0;
  const totalTok = promptTokens + completionTokens || 1;
  const promptPct = Math.round((promptTokens / totalTok) * 100);

  const contextTile = buildTelemetryTile('Context high-water', ctxRaw);
  const track = document.createElement('div');
  track.className = 'code-overview__token-track';
  track.setAttribute('aria-hidden', 'true');
  const promptFill = document.createElement('div');
  promptFill.className = 'code-overview__token-fill code-overview__token-fill--prompt';
  promptFill.style.width = `${promptPct}%`;
  const completionFill = document.createElement('div');
  completionFill.className = 'code-overview__token-fill code-overview__token-fill--completion';
  completionFill.style.width = `${100 - promptPct}%`;
  track.append(promptFill, completionFill);
  contextTile.appendChild(track);

  grid.replaceChildren(
    buildTelemetryTile('Tokens (session)', formatCompactCount(tokens), {
      uninstrumented: true,
      detail: 'Token history not tracked yet. Showing in-memory session totals only.',
    }),
    buildTelemetryTile('TPS trend', tpsRaw, {
      uninstrumented: true,
      detail: 'TPS history not tracked yet.',
    }),
    buildTelemetryTile('TTFT', ttftRaw, {
      uninstrumented: true,
      detail: 'TTFT history not tracked yet.',
    }),
    contextTile,
    buildTelemetryTile('Est. cost', '—', {
      uninstrumented: true,
      detail: 'Cost estimation needs a pricing table.',
    }),
  );

  const telemetryPreview = document.getElementById('codeOverviewTelemetryPreview');
  if (telemetryPreview) {
    const tpsLabel = tpsRaw === '—' ? '—' : `${tpsRaw} tok/s`;
    telemetryPreview.textContent = `${formatCompactCount(tokens)} tok · ${tpsLabel}`;
  }
}

async function refreshAllPanels(): Promise<void> {
  const gen = (refreshGen += 1);
  const running = document.getElementById('codeOverviewRunningBody');
  const git = document.getElementById('codeOverviewGitBody');
  const system = document.getElementById('codeOverviewSystemBody');
  const scheduler = document.getElementById('codeOverviewSchedulerBody');
  const workspace = document.getElementById('codeOverviewWorkspaceBody');
  if (running) renderSkeleton(running);
  if (git) renderSkeleton(git);
  if (system) renderSkeleton(system);
  if (scheduler) renderSkeleton(scheduler);
  if (workspace) renderSkeleton(workspace);

  await Promise.all([
    refreshPulseBand(),
    refreshRunningPanel(),
    Promise.resolve(refreshSessionsPanel()),
    refreshGitPanel(),
    refreshSystemPanel(),
    refreshSchedulerPanel(),
    refreshWorkspacePanel(),
    Promise.resolve(refreshTelemetryBand()),
  ]);

  if (gen !== refreshGen) return;
}

/** Mount the overview dashboard in #chatArea. */
export async function openCodeOverview(): Promise<void> {
  if (isCodeOverviewOpen()) {
    void refreshAllPanels();
    return;
  }

  await closeCompetingMainColumnViews();

  const area = document.getElementById('chatArea');
  if (!area) return;

  if (!returnChatId && sessionState?.activeId) {
    returnChatId = sessionState.activeId;
  }

  area.replaceChildren();
  area.appendChild(buildShell());
  stripMainColumnOverlayClasses();
  area.classList.add(CHAT_AREA_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_CLASS);

  wireShellEvents();
  syncOverviewNavButtons();
  startPolling();
  await refreshAllPanels();
  notifyAskQuestionDisplayContextChanged();
  void import('./preview-electron-visibility').then((m) =>
    m.scheduleElectronPreviewHostVisibilitySync(),
  );
  notifyCodeStageViewChanged();
}

/** Tear down overview and optionally restore chat view. */
export function closeCodeOverview(options?: {
  skipNavigate?: boolean;
  restoreChat?: boolean;
}): void {
  if (!isCodeOverviewOpen()) return;

  stopPolling();
  gitGraphHandle?.destroy();
  gitGraphHandle = null;

  const savedReturnChatId = returnChatId;
  document.getElementById(ROOT_ID)?.remove();
  stripMainColumnOverlayClasses();
  returnChatId = null;
  syncOverviewNavButtons();

  if (options?.restoreChat === false) {
    notifyCodeStageViewChanged();
    if (!options?.skipNavigate) {
      void import('../os/router').then((m) => m.navigateToCodeChatIfCurrentSection('overview'));
    }
    return;
  }

  const targetId =
    savedReturnChatId && sessionState?.chats.some((c) => c.id === savedReturnChatId)
      ? savedReturnChatId
      : sessionState?.activeId;

  const chat = targetId ? sessionState?.chats.find((c) => c.id === targetId) : undefined;
  const area = document.getElementById('chatArea');
  if (chat) {
    void import('./messages').then((m) => m.renderChatFromHistory(chat));
  } else if (area) {
    area.replaceChildren();
  }
  notifyAskQuestionDisplayContextChanged();
  void import('./preview-electron-visibility').then((m) =>
    m.scheduleElectronPreviewHostVisibilitySync(),
  );
  notifyCodeStageViewChanged();
  if (!options?.skipNavigate) {
    void import('../os/router').then((m) => m.navigateToCodeChatIfCurrentSection('overview'));
  }
}

const PHONE_LAYOUT_MQ = '(max-width: 600px)';

function syncRailSectionCollapseForViewport(): void {
  const phone = window.matchMedia(PHONE_LAYOUT_MQ).matches;
  const sections = document.querySelectorAll<HTMLElement>(
    '.code-overview__rail > .code-overview__section',
  );
  sections.forEach((section, index) => {
    if (!phone) {
      section.classList.remove('is-collapsed');
      return;
    }
    if (index === 0) section.classList.remove('is-collapsed');
    else if (!section.dataset.userExpanded) section.classList.add('is-collapsed');
  });
}

function wireRailSectionCollapsibles(): void {
  syncRailSectionCollapseForViewport();
  if (!window.matchMedia(PHONE_LAYOUT_MQ).addEventListener) return;
  window.matchMedia(PHONE_LAYOUT_MQ).addEventListener('change', syncRailSectionCollapseForViewport);

  document.querySelectorAll<HTMLElement>('[data-code-overview-rail-toggle]').forEach((head) => {
    if (head.dataset.bound === '1') return;
    head.dataset.bound = '1';
    head.addEventListener('click', () => {
      if (!window.matchMedia(PHONE_LAYOUT_MQ).matches) return;
      const section = head.closest('.code-overview__section') as HTMLElement | null;
      if (!section) return;
      const collapsed = section.classList.toggle('is-collapsed');
      if (!collapsed) section.dataset.userExpanded = '1';
      else delete section.dataset.userExpanded;
    });
    head.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      head.click();
    });
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
  });
}

function wireShellEvents(): void {
  document.getElementById('codeOverviewNewChat')?.addEventListener('click', () => {
    createChat();
    void enterCodeChat();
  });

  document.getElementById('codeOverviewRefresh')?.addEventListener('click', () => {
    void refreshAllPanels();
  });

  document.getElementById('codeOverviewPulseExpand')?.addEventListener('click', () => {
    const pulse = document.getElementById('codeOverviewPulse');
    const btn = document.getElementById('codeOverviewPulseExpand');
    if (!pulse || !btn) return;
    const expanded = pulse.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  document.getElementById('codeOverviewTelemetryExpand')?.addEventListener('click', () => {
    const band = document.getElementById('codeOverviewTelemetry');
    const btn = document.getElementById('codeOverviewTelemetryExpand');
    if (!band || !btn) return;
    const expanded = band.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  wireRailSectionCollapsibles();
}

function onHashChange(): void {
  const route = getCurrentRoute();
  if (route.appId !== 'code') {
    if (isCodeOverviewOpen()) closeCodeOverview({ restoreChat: false });
    syncOverviewNavButtons();
    return;
  }

  if (route.codeSection === 'overview') {
    void openCodeOverview();
    syncOverviewNavButtons();
    return;
  }

  if (isCodeOverviewOpen()) {
    closeCodeOverview({ skipNavigate: true, restoreChat: false });
  }
  syncOverviewNavButtons();
}

function wireOverviewNavButtons(): void {
  const goOverview = (): void => {
    if (isCodeOverviewOpen()) {
      void enterCodeChat();
      return;
    }
    navigateToCodeOverview();
  };
  document.getElementById('btnCodeOverviewSidebar')?.addEventListener('click', goOverview);
}

/** Idempotent init: hash routing, overview nav buttons, visibility pause. */
export function initCodeOverview(): void {
  if (initialized) return;
  initialized = true;

  wireOverviewNavButtons();

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isCodeOverviewOpen()) {
      void refreshPulseBand();
    }
  });

  const route = getCurrentRoute();
  if (route.appId === 'code' && route.codeSection === 'overview') {
    void openCodeOverview();
  }
  syncOverviewNavButtons();
}
