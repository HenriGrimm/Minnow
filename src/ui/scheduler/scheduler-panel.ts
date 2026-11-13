import { appAlert, appConfirm, appPrompt } from '../app-dialog';
/**
 * Scheduler job list panel (shared by full-page and OS side-panel surfaces).
 */

import {
  deleteSchedulerJob,
  fetchSchedulerDefaultWorkspace,
  fetchSchedulerJobs,
  fetchSchedulerRuns,
  runSchedulerJobNow,
  updateSchedulerJob,
  type ScheduledJob,
  type SchedulerRun,
} from '../../scheduler/client';
import { describeSchedule } from '../../scheduler/schedule-display';
import { formatModelLabel } from '../../lib/format-model-label';
import { formatWorkDuration } from '../../chat/transcript-turns';
import { getPermissionLevelCached } from '../../config/tool-security-meta';
import { listProviders } from '../../providers/store';
import { createSettingsToggleRow } from '../settings-switch';
import { isLocalServerAvailable } from '../../tools/config';
import {
  formatSchedulerRunSummary,
  resolveSchedulerRunChatId,
} from '../../scheduler/run-summary';
import { findChatById, loadSessionsFromStorage, sessionState } from '../../state/sessions';
import { setWorkspacePath } from '../../config/workspace-api';
import { confirmAndStopBoardsForWorkspaceSwitch, dismissBoardViewOutsideWorkspace } from '../workspace-switch-guard';
import { createIcon } from '../icon';
import { getWorkspacePath, setWorkspaceFromServer } from '../../state/workspace';
import { launchApp } from '../../os/router';
import { switchChat, applyWorkspaceScopedSession } from '../sidebar';
import { getMode } from '../../chat/modes/registry';
import { fetchWatchedGithubIssues, retryWatchedGithubIssue } from '../../scheduler/client';

export interface SchedulerPanelOptions {
  onStatus?: (state: 'ok' | 'err', message: string) => void;
  /** Open the add-task editor (OS window or inline legacy flow). */
  onAddTask?: () => void;
  /** Open the edit-task editor for an existing job. */
  onEditJob?: (job: ScheduledJob) => void;
  /** Primary add control is rendered outside the panel (full-page app header). */
  externalAddControl?: boolean;
  /** Live job counts for page chrome (header summary). */
  onCountsChange?: (counts: { total: number; enabled: number }) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatRunTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day = date.toDateString() === today.toDateString() ? 'today'
    : date.toDateString() === yesterday.toDateString() ? 'yesterday'
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}

function formatNextRun(iso?: string): string {
  if (!iso) return '—';
  const remainingMinutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (remainingMinutes <= 0 || !Number.isFinite(remainingMinutes)) return formatWhen(iso);
  if (remainingMinutes < 60) return `in ${remainingMinutes}m`;
  if (remainingMinutes < 24 * 60) return `in ${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m`;
  return formatWhen(iso);
}

function modeLabel(modeId: string): string {
  try {
    return getMode(modeId as Parameters<typeof getMode>[0]).label;
  } catch {
    return modeId;
  }
}

function truncateText(text: string, max = 96): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Folder basename for workspace display. */
function workspaceBasename(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? absPath;
}

function formatJobWorkspaceLabel(
  job: Pick<ScheduledJob, 'workspacePath'>,
  defaultWorkspacePath: string,
  defaultLabel: string,
): string {
  const custom = job.workspacePath?.trim();
  if (!custom) {
    return `${defaultLabel} (default)`;
  }
  return workspaceBasename(custom);
}

/** Human-readable model label for job list rows. */
function formatJobModelLabel(
  job: Pick<ScheduledJob, 'providerId' | 'modelId'>,
  providerLabelById: Map<string, string>,
): string {
  const modelId = job.modelId?.trim();
  if (!modelId) {
    return 'Menubar default';
  }
  const { optionText } = formatModelLabel({ id: modelId });
  const providerId = job.providerId?.trim();
  const providerLabel = providerId ? providerLabelById.get(providerId) ?? providerId : '';
  return providerLabel ? `${optionText} — ${providerLabel}` : optionText;
}

/** Inline clock icon for the uptime notice. */
function createNoticeIcon(): HTMLElement {
  return createIcon('statusPending', { className: 'scheduler-notice__icon' });
}

/** Render scheduler list UI into the supplied mount element. */
export async function renderSchedulerPanel(
  mount: HTMLElement,
  options: SchedulerPanelOptions = {},
): Promise<void> {
  if (!mount?.isConnected) return;
  const notify = (state: 'ok' | 'err', message: string) => {
    options.onStatus?.(state, message);
  };

  const openAddTask = (): void => {
    options.onAddTask?.();
  };

  const openEditJob = (job: ScheduledJob): void => {
    options.onEditJob?.(job);
  };

  mount.replaceChildren();
  mount.classList.add('scheduler-panel-mount');
  const headerControls = mount.closest('#schedulerView')?.querySelector('.scheduler-header__controls');
  headerControls?.querySelector('.scheduler-graphite-modes')?.remove();

  const panel = el('div', 'scheduler-panel');
  mount.appendChild(panel);

  const notice = el('aside', 'scheduler-notice');
  notice.setAttribute('role', 'note');
  notice.appendChild(createNoticeIcon());
  notice.appendChild(
    el(
      'p',
      'scheduler-notice__text',
      'Jobs run only while Minnow is open. Closing the app pauses every schedule.',
    ),
  );
  panel.appendChild(notice);

  if (!isLocalServerAvailable()) {
    const offline = el('div', 'scheduler-offline');
    offline.appendChild(
      el('p', 'scheduler-offline__title', 'Tool server offline'),
    );
    offline.appendChild(
      el(
        'p',
        'scheduler-offline__hint',
        'Open Minnow to create and manage scheduled jobs.',
      ),
    );
    panel.appendChild(offline);
    return;
  }

  const useExternalAdd = Boolean(options.externalAddControl);
  const graphite = useExternalAdd && document.documentElement.classList.contains('mn-graphite-workspace');
  panel.classList.toggle('scheduler-panel--graphite', graphite);

  let toolbarSummary: HTMLElement | null = null;
  if (!useExternalAdd) {
    const toolbar = el('div', 'scheduler-toolbar');
    toolbarSummary = el('p', 'scheduler-toolbar__summary', '—');
    toolbarSummary.setAttribute('aria-live', 'polite');
    toolbar.appendChild(toolbarSummary);

    const toolbarAddBtn = el(
      'button',
      'scheduler-btn scheduler-btn--primary scheduler-toolbar__add',
      'Add task',
    ) as HTMLButtonElement;
    toolbarAddBtn.type = 'button';
    toolbarAddBtn.addEventListener('click', openAddTask);
    toolbar.appendChild(toolbarAddBtn);
    panel.appendChild(toolbar);
  }

  function formatCountsSummary(total: number, enabled: number): string {
    if (total === 0) {
      return 'No jobs yet · schedules pause when Minnow closes';
    }
    const enabledPart =
      enabled === total ? `${enabled} enabled` : `${enabled} of ${total} enabled`;
    return `${total} job${total === 1 ? '' : 's'} · ${enabledPart}`;
  }

  function publishCounts(total: number, enabled: number): void {
    if (toolbarSummary) {
      toolbarSummary.textContent = formatCountsSummary(total, enabled);
    }
    options.onCountsChange?.({ total, enabled });
  }

  const main = el('div', 'scheduler-panel-main');
  panel.appendChild(main);

  const listHead = el('div', 'scheduler-jobs-head hidden');
  listHead.appendChild(el('h2', 'scheduler-jobs-head__title', 'Scheduled jobs'));
  main.appendChild(listHead);

  const list = el('div', 'scheduler-jobs');
  list.setAttribute('role', 'list');
  main.appendChild(list);

  const historyPanel = el('section', 'scheduler-history hidden');
  historyPanel.setAttribute('aria-label', 'Run history');
  const details = el('aside', 'scheduler-graphite-details');
  details.setAttribute('aria-label', 'Scheduled job details');
  const detailsContent = el('div', 'scheduler-graphite-details__content');
  if (graphite) {
    main.appendChild(details);
    details.append(detailsContent, historyPanel);
    const modes = el('div', 'scheduler-graphite-modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Scheduler view');
    const jobsButton = el('button', undefined, 'Jobs');
    const runsButton = el('button', undefined, 'All runs');
    jobsButton.type = runsButton.type = 'button';
    const setMode = (showRuns: boolean) => {
      list.hidden = showRuns;
      details.classList.toggle('scheduler-graphite-details--all', showRuns);
      detailsContent.hidden = showRuns;
      jobsButton.setAttribute('aria-pressed', String(!showRuns));
      runsButton.setAttribute('aria-pressed', String(showRuns));
      if (showRuns) void renderHistory(null);
      else if (selectedJobId) void renderHistory(selectedJobId);
      else {
        historyRequest++;
        historyPanel.classList.add('hidden');
      }
    };
    jobsButton.setAttribute('aria-pressed', 'true');
    runsButton.setAttribute('aria-pressed', 'false');
    jobsButton.addEventListener('click', () => setMode(false));
    runsButton.addEventListener('click', () => setMode(true));
    modes.append(jobsButton, runsButton);
    (headerControls ?? panel).prepend(modes);
  } else {
    panel.appendChild(historyPanel);
  }

  let selectedHistoryJobId: string | null = null;
  let selectedJobId: string | null = null;
  let renderedJobs: ScheduledJob[] = [];
  let historyRequest = 0;
  let defaultWorkspacePath = '';
  let defaultWorkspaceLabel = 'Scheduler';
  const providerLabelById = new Map<string, string>();

  try {
    const defaultWorkspace = await fetchSchedulerDefaultWorkspace();
    defaultWorkspacePath = defaultWorkspace.path;
    defaultWorkspaceLabel = defaultWorkspace.label || 'Scheduler';
  } catch {
  }

  try {
    const { providers } = await listProviders();
    for (const provider of providers) {
      providerLabelById.set(provider.id, provider.label || provider.id);
    }
  } catch {
  }

  async function openSchedulerRunChat(chatId: string): Promise<void> {
    try {
      await loadSessionsFromStorage({ force: true });
    } catch {
      notify('err', 'Could not reload chats from the server.');
      return;
    }

    const chat = findChatById(chatId);
    if (!chat) {
      notify('err', 'Chat for this run is not available yet.');
      return;
    }

    const chatWorkspace = chat.workspacePath?.trim();
    if (chatWorkspace && chatWorkspace !== getWorkspacePath()) {
      try {
        const allowed = await confirmAndStopBoardsForWorkspaceSwitch(chatWorkspace);
        if (!allowed) {
          return;
        }
        const info = await setWorkspacePath(chatWorkspace);
        setWorkspaceFromServer(info);
        await dismissBoardViewOutsideWorkspace(chatWorkspace);
        await applyWorkspaceScopedSession(chatWorkspace);
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
        return;
      }
    }

    launchApp('code');
    if (sessionState?.activeId !== chatId) {
      await switchChat(chatId);
    }
  }

  async function renderHistory(jobId: string | null): Promise<void> {
    const request = ++historyRequest;
    selectedHistoryJobId = jobId;
    historyPanel.classList.remove('hidden');
    historyPanel.replaceChildren();

    const historyHead = el('div', 'scheduler-history__head');
    historyHead.appendChild(el('h3', 'scheduler-history__title', jobId ? 'Run history' : 'All runs'));
    const closeHistory = el('button', 'settings-inline-btn scheduler-history__close', 'Close');
    closeHistory.type = 'button';
    closeHistory.addEventListener('click', () => {
      historyRequest++;
      historyPanel.classList.add('hidden');
      selectedHistoryJobId = null;
    });
    if (!graphite) historyHead.appendChild(closeHistory);
    historyPanel.appendChild(historyHead);

    let runs: SchedulerRun[] = [];
    try {
      if (jobId) {
        runs = await fetchSchedulerRuns(jobId);
      } else {
        const results: SchedulerRun[] = [];
        for (let i = 0; i < renderedJobs.length && request === historyRequest; i += 6) {
          const batch = await Promise.all(renderedJobs.slice(i, i + 6).map((job) => fetchSchedulerRuns(job.id)));
          results.push(...batch.flat());
        }
        runs = results.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      }
    } catch (err) {
      if (request !== historyRequest) return;
      historyPanel.appendChild(
        el('p', 'scheduler-field__hint', err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (request !== historyRequest) return;

    if (runs.length === 0) {
      historyPanel.appendChild(el('p', 'scheduler-history__empty', jobId ? 'No runs yet for this job.' : 'No scheduled runs yet.'));
      return;
    }

    if (graphite && jobId) {
      const history = el('ul', 'scheduler-graphite-history');
      for (const run of runs) {
        const item = el('li');
        const chatId = resolveSchedulerRunChatId(run);
        const entry = chatId ? el('button', 'scheduler-graphite-run') : el('div', 'scheduler-graphite-run');
        if (entry instanceof HTMLButtonElement && chatId) {
          entry.type = 'button';
          entry.addEventListener('click', () => void openSchedulerRunChat(chatId));
        }
        entry.dataset.status = run.status;
        const icon = createIcon(run.status === 'completed' ? 'statusPass' : run.status === 'failed' || run.status === 'timeout' ? 'statusFail' : 'statusPending', { size: 15 });
        const caption = el('span', 'scheduler-graphite-run__caption');
        const started = formatRunTime(run.startedAt);
        const elapsed = run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : NaN;
        caption.append(el('span', undefined, formatSchedulerRunSummary(run, 120) || run.status));
        caption.append(el('small', undefined, Number.isFinite(elapsed) && elapsed >= 0
          ? `${started} · ${formatWorkDuration(elapsed)}` : `${run.status} · ${started}`));
        entry.append(icon, caption);
        if (chatId) entry.append(createIcon('chevronRight', { size: 13 }));
        item.append(entry);
        history.append(item);
      }
      historyPanel.append(history);
      return;
    }

    const table = el('table', 'scheduler-runs-table');
    const headRow = el('tr');
    const labelsById = new Map(renderedJobs.map((job) => [job.id, job.label]));
    for (const col of [...(jobId ? [] : ['Job']), 'Started', 'Status', 'Exit', 'Summary']) {
      headRow.appendChild(el('th', undefined, col));
    }
    table.appendChild(el('thead')).appendChild(headRow);

    const body = el('tbody');
    for (const run of runs) {
      const row = el('tr');
      const chatId = resolveSchedulerRunChatId(run);
      if (chatId) {
        row.classList.add('scheduler-runs-table__row--clickable');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.title = 'Open chat for this run';
        row.setAttribute('aria-label', `Open chat for run started ${formatWhen(run.startedAt)}`);
        const openRunChat = (): void => {
          void openSchedulerRunChat(chatId);
        };
        row.addEventListener('click', openRunChat);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openRunChat();
          }
        });
      }
      if (!jobId) row.appendChild(el('td', undefined, labelsById.get(run.jobId) ?? 'Scheduled job'));
      row.appendChild(el('td', 'scheduler-runs-table__time', formatWhen(run.startedAt)));
      const statusCell = el('td');
      const status = el('span', `scheduler-run-status scheduler-run-status--${run.status}`);
      status.textContent = run.status;
      statusCell.appendChild(status);
      row.appendChild(statusCell);
      row.appendChild(
        el('td', 'scheduler-runs-table__mono', run.exitCode != null ? String(run.exitCode) : '—'),
      );
      row.appendChild(
        el('td', undefined, formatSchedulerRunSummary(run, 120)),
      );
      body.appendChild(row);
    }
    table.appendChild(body);
    historyPanel.appendChild(table);
  }

  function createJobToggle(job: ScheduledJob): HTMLElement {
    const { row } = createSettingsToggleRow(`Enable ${job.label || 'job'}`, {
      checked: job.enabled,
      onChange: (enabled) => {
        void (async () => {
          try {
            await updateSchedulerJob(job.id, { enabled });
            await refreshList();
          } catch (err) {
            notify('err', err instanceof Error ? err.message : String(err));
          }
        })();
      },
    });
    row.classList.add('scheduler-job__toggle');
    return row;
  }

  function selectGraphiteJob(job: ScheduledJob): void {
    selectedJobId = job.id;
    for (const button of list.querySelectorAll('[data-job-id]')) {
      button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.jobId === job.id));
    }
    detailsContent.replaceChildren(createJobRow(job));
    if (!list.hidden) void renderHistory(job.id);
  }

  function createGraphiteJobRow(job: ScheduledJob): HTMLElement {
    const row = el('article', 'scheduler-graphite-job');
    row.setAttribute('role', 'listitem');
    row.classList.toggle('is-enabled', job.enabled);
    const button = el('button', 'scheduler-graphite-job__select');
    button.type = 'button';
    button.dataset.jobId = job.id;
    button.setAttribute('aria-pressed', String(selectedJobId === job.id));
    button.addEventListener('click', () => selectGraphiteJob(job));
    const identity = el('span', 'scheduler-graphite-job__identity');
    identity.append(el('span', undefined, job.label || 'Untitled job'));
    identity.append(el('span', 'scheduler-graphite-job__secondary', job.prompt || job.githubWatch?.repository || ''));
    const schedule = el('span', 'scheduler-graphite-job__cadence');
    schedule.append(el('span', undefined, describeSchedule(job.schedule)));
    schedule.append(el('span', 'scheduler-graphite-job__secondary', job.schedule.kind === 'cron' ? job.schedule.value : 'Interval'));
    const next = job.running ? 'Running' : job.enabled ? formatNextRun(job.nextRunAt) : 'Off';
    const nextLabel = el('span', 'scheduler-graphite-job__secondary', next);
    if (job.enabled && job.nextRunAt) nextLabel.title = formatWhen(job.nextRunAt);
    button.append(identity, schedule, nextLabel, el('span', 'scheduler-graphite-job__secondary', formatWhen(job.lastRunAt)));
    row.append(button, createJobToggle(job));
    return row;
  }

  function createJobRow(job: ScheduledJob): HTMLElement {
    const row = el('article', 'scheduler-job');
    row.setAttribute('role', 'listitem');
    if (!job.enabled) row.classList.add('is-disabled');

    const mainCol = el('div', 'scheduler-job__main');

    const jobHead = el('div', 'scheduler-job__head');
    jobHead.appendChild(el('h3', 'scheduler-job__title', job.label || 'Untitled job'));
    const jobMode = job.githubWatch ? 'GitHub issue watcher' : modeLabel(job.modeId);
    if (graphite) {
      const editTitle = el('button', 'settings-inline-btn');
      editTitle.type = 'button';
      editTitle.title = 'Edit job';
      editTitle.setAttribute('aria-label', 'Edit job');
      editTitle.append(createIcon('compose', { size: 14 }));
      editTitle.addEventListener('click', () => openEditJob(job));
      jobHead.append(editTitle);
    } else jobHead.appendChild(el('span', 'scheduler-job__mode', jobMode));
    mainCol.appendChild(jobHead);

    const scheduleLine = el('div', 'scheduler-job__schedule');
    scheduleLine.appendChild(
      el(
        'span',
        'scheduler-job__cadence',
        describeSchedule(job.schedule),
      ),
    );
    const next = el('span', 'scheduler-job__next', `Next ${formatWhen(job.nextRunAt)}`);
    scheduleLine.appendChild(next);
    if (!graphite) mainCol.appendChild(scheduleLine);
    if (job.githubWatch) mainCol.appendChild(el('p', 'scheduler-job__workspace', `${job.githubWatch.repository} · label: minnow`));

    if (job.prompt.trim()) {
      mainCol.appendChild(
        el('p', 'scheduler-job__prompt', graphite ? job.prompt : truncateText(job.prompt, 140)),
      );
    }

    const workspaceLabel = formatJobWorkspaceLabel(job, defaultWorkspacePath, defaultWorkspaceLabel);
    const modelLabel = formatJobModelLabel(job, providerLabelById);
    if (graphite) {
      const metadata = el('dl', 'scheduler-graphite-job-meta');
      const fields = [
        ['Schedule', describeSchedule(job.schedule)],
        ['Next run', job.running ? 'Running' : job.enabled ? formatNextRun(job.nextRunAt) : 'Off'],
        ['Permission', { manual: 'Manual', auto: 'Auto', full: 'Full access' }[getPermissionLevelCached()]],
        ['Model', modelLabel],
        ['Workspace', job.workspacePath || workspaceLabel],
        ['Mode', jobMode],
        ['Tell me on', job.channels.map((channel) => ({ in_app: 'In app', email: 'Email', webhook: 'Webhook' })[channel]).join(', ') || '—'],
      ];
      for (const [label, value] of fields) metadata.append(el('dt', undefined, label), el('dd', undefined, value));
      mainCol.append(metadata);
    } else mainCol.append(
      el(
        'p',
        'scheduler-job__workspace',
        `Workspace · ${workspaceLabel}`,
      ),
      el(
        'p',
        'scheduler-job__model',
        `Model · ${modelLabel}`,
      ),
    );

    if (job.running) {
      const running = el('span', 'scheduler-job__running');
      const dot = el('span', 'scheduler-job__running-dot');
      dot.setAttribute('aria-hidden', 'true');
      running.append(dot, el('span', undefined, 'Running'));
      mainCol.appendChild(running);
    }

    row.appendChild(mainCol);

    const actions = el('div', 'scheduler-job__actions');

    if (!graphite) actions.appendChild(createJobToggle(job));

    const btnRow = el('div', 'scheduler-job__btn-row');

    const runBtn = el('button', 'settings-inline-btn', 'Run now');
    runBtn.type = 'button';
    if (graphite) {
      runBtn.classList.add('scheduler-graphite-run-now');
      runBtn.prepend(createIcon('forward', { size: 13 }));
    }
    runBtn.disabled = Boolean(job.running);
    runBtn.addEventListener('click', () => {
      void (async () => {
        try {
          await runSchedulerJobNow(job.id);
          notify('ok', `Started "${job.label}"`);
          await refreshList();
          if (!graphite && selectedHistoryJobId === job.id) await renderHistory(job.id);
        } catch (err) {
          notify('err', err instanceof Error ? err.message : String(err));
        }
      })();
    });

    const editBtn = el('button', 'settings-inline-btn', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => {
      openEditJob(job);
    });

    const historyBtn = el('button', 'settings-inline-btn', 'History');
    historyBtn.type = 'button';
    historyBtn.addEventListener('click', () => {
      void renderHistory(job.id);
    });

    if (job.githubWatch) {
      const issuesBtn = el('button', 'settings-inline-btn', 'Issues');
      issuesBtn.type = 'button';
      const issueList = el('div', 'scheduler-watched-issues');
      issueList.hidden = true;
      issueList.setAttribute('aria-live', 'polite');
      const showIssues = async () => {
        issuesBtn.disabled = true;
        try {
          const issues = await fetchWatchedGithubIssues(job.id);
          issueList.replaceChildren();
          issueList.hidden = false;
          if (!issues.length) issueList.appendChild(el('p', undefined, 'No issues claimed yet. Use Run now to check GitHub.'));
          for (const issue of issues) {
            const item = el('div');
            const link = el('a', undefined, `#${issue.number} ${issue.title}`);
            link.href = `https://github.com/${job.githubWatch!.repository}/issues/${issue.number}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            item.append(link, el('p', undefined, `${issue.phase} · Board: ${issue.boardId}`));
            if (issue.boardCreated) {
              const board = el('button', 'settings-inline-btn', 'Open board');
              board.type = 'button';
              board.addEventListener('click', () => {
                void (async () => {
                  try {
                    if (job.workspacePath && job.workspacePath !== getWorkspacePath()) {
                      if (!await confirmAndStopBoardsForWorkspaceSwitch(job.workspacePath)) return;
                      setWorkspaceFromServer(await setWorkspacePath(job.workspacePath));
                      await dismissBoardViewOutsideWorkspace(job.workspacePath);
                      await applyWorkspaceScopedSession(job.workspacePath);
                    }
                    const { navigateToCodeBoards } = await import('../../os/router');
                    const { openBoardsView, showBoard } = await import('../../orchestrator/boards-view');
                    navigateToCodeBoards();
                    await openBoardsView();
                    showBoard(issue.boardId);
                  } catch (error) { notify('err', error instanceof Error ? error.message : String(error)); }
                })();
              });
              item.appendChild(board);
            }
            if (issue.error) item.appendChild(el('p', undefined, issue.error));
            if (issue.prUrl?.startsWith('https://github.com/')) {
              const pr = el('a', undefined, 'Review pull request');
              pr.href = issue.prUrl;
              pr.target = '_blank';
              pr.rel = 'noopener noreferrer';
              item.appendChild(pr);
            }
            if (issue.phase === 'blocked') {
              const retry = el('button', 'settings-inline-btn', `Retry #${issue.number}`);
              retry.type = 'button';
              retry.addEventListener('click', () => {
                retry.disabled = true;
                void retryWatchedGithubIssue(job.id, issue.number).then(showIssues).catch(error => {
                  notify('err', error instanceof Error ? error.message : String(error));
                  retry.disabled = false;
                });
              });
              item.appendChild(retry);
            }
            issueList.appendChild(item);
          }
        } catch (error) {
          notify('err', error instanceof Error ? error.message : String(error));
        } finally { issuesBtn.disabled = false; }
      };
      issuesBtn.addEventListener('click', () => { void showIssues(); });
      btnRow.appendChild(issuesBtn);
      mainCol.appendChild(issueList);
    }

    const deleteBtn = el('button', 'settings-inline-btn scheduler-job__delete', 'Delete');
    deleteBtn.type = 'button';
    if (graphite) {
      deleteBtn.setAttribute('aria-label', 'Delete job');
      deleteBtn.title = 'Delete job';
      deleteBtn.replaceChildren(createIcon('trash', { size: 14 }));
    }
    deleteBtn.addEventListener('click', () => {
      void (async () => {
        if (!await appConfirm(`Delete scheduled job "${job.label}"?`)) return;
        try {
          await deleteSchedulerJob(job.id);
          notify('ok', 'Job deleted');
          if (selectedHistoryJobId === job.id) {
            historyPanel.classList.add('hidden');
            selectedHistoryJobId = null;
          }
          await refreshList();
        } catch (err) {
          notify('err', err instanceof Error ? err.message : String(err));
        }
      })();
    });

    btnRow.append(runBtn, editBtn);
    if (!graphite) btnRow.appendChild(historyBtn);
    btnRow.appendChild(deleteBtn);
    actions.appendChild(btnRow);
    row.appendChild(actions);
    return row;
  }

  function renderEmptyState(): HTMLElement {
    const empty = el('div', 'scheduler-empty');
    empty.appendChild(el('p', 'scheduler-empty__title', 'No scheduled jobs yet'));
    empty.appendChild(
      el(
        'p',
        'scheduler-empty__hint',
        'Run a prompt on a timer while Minnow stays open. Standups, reminders, and recurring checks work well here.',
      ),
    );
    if (!useExternalAdd) {
      const cta = el('button', 'scheduler-btn scheduler-btn--primary', 'Add task');
      cta.type = 'button';
      cta.addEventListener('click', openAddTask);
      empty.appendChild(cta);
    } else {
      empty.appendChild(
        el('p', 'scheduler-empty__action-hint', graphite
          ? 'Use New job above to create your first schedule.'
          : 'Use Add task above to create your first schedule.'),
      );
    }
    return empty;
  }

  async function refreshList(): Promise<void> {
    list.replaceChildren();
    list.removeAttribute('role');
    let jobs: ScheduledJob[] = [];
    try {
      jobs = await fetchSchedulerJobs();
    } catch (err) {
      list.appendChild(
        el('p', 'scheduler-field__hint', err instanceof Error ? err.message : String(err)),
      );
      if (toolbarSummary) {
        toolbarSummary.textContent = 'Could not load jobs';
      }
      options.onCountsChange?.({ total: -1, enabled: -1 });
      return;
    }

    const enabledCount = jobs.filter((job) => job.enabled).length;
    renderedJobs = jobs;
    publishCounts(jobs.length, enabledCount);
    list.classList.toggle('scheduler-jobs--empty', jobs.length === 0);
    listHead.classList.toggle('hidden', jobs.length === 0);

    if (jobs.length === 0) {
      list.appendChild(renderEmptyState());
      detailsContent.replaceChildren();
      if (graphite) historyPanel.classList.add('hidden');
      return;
    }

    for (const job of jobs) {
      list.appendChild(graphite ? createGraphiteJobRow(job) : createJobRow(job));
    }
    list.setAttribute('role', 'list');
    if (graphite) {
      if (list.hidden) void renderHistory(null);
      else selectGraphiteJob(jobs.find((job) => job.id === selectedJobId) ?? jobs[0]);
    }
  }

  await refreshList();
}
