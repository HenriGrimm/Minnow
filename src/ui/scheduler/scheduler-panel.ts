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
  panel.appendChild(historyPanel);

  let selectedHistoryJobId: string | null = null;
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

  async function renderHistory(jobId: string): Promise<void> {
    selectedHistoryJobId = jobId;
    historyPanel.classList.remove('hidden');
    historyPanel.replaceChildren();

    const historyHead = el('div', 'scheduler-history__head');
    historyHead.appendChild(el('h3', 'scheduler-history__title', 'Run history'));
    const closeHistory = el('button', 'settings-inline-btn scheduler-history__close', 'Close');
    closeHistory.type = 'button';
    closeHistory.addEventListener('click', () => {
      historyPanel.classList.add('hidden');
      selectedHistoryJobId = null;
    });
    historyHead.appendChild(closeHistory);
    historyPanel.appendChild(historyHead);

    let runs: SchedulerRun[] = [];
    try {
      runs = await fetchSchedulerRuns(jobId);
    } catch (err) {
      historyPanel.appendChild(
        el('p', 'scheduler-field__hint', err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    if (runs.length === 0) {
      historyPanel.appendChild(el('p', 'scheduler-history__empty', 'No runs yet for this job.'));
      return;
    }

    const table = el('table', 'scheduler-runs-table');
    const headRow = el('tr');
    for (const col of ['Started', 'Status', 'Exit', 'Summary']) {
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

  function createJobRow(job: ScheduledJob): HTMLElement {
    const row = el('article', 'scheduler-job');
    row.setAttribute('role', 'listitem');
    if (!job.enabled) row.classList.add('is-disabled');

    const mainCol = el('div', 'scheduler-job__main');

    const jobHead = el('div', 'scheduler-job__head');
    jobHead.appendChild(el('h3', 'scheduler-job__title', job.label || 'Untitled job'));
    jobHead.appendChild(el('span', 'scheduler-job__mode', modeLabel(job.modeId)));
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
    mainCol.appendChild(scheduleLine);

    if (job.prompt.trim()) {
      mainCol.appendChild(
        el('p', 'scheduler-job__prompt', truncateText(job.prompt, 140)),
      );
    }

    mainCol.appendChild(
      el(
        'p',
        'scheduler-job__workspace',
        `Workspace · ${formatJobWorkspaceLabel(job, defaultWorkspacePath, defaultWorkspaceLabel)}`,
      ),
    );

    mainCol.appendChild(
      el(
        'p',
        'scheduler-job__model',
        `Model · ${formatJobModelLabel(job, providerLabelById)}`,
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

    const { row: toggleRow } = createSettingsToggleRow('On', {
      checked: job.enabled,
      onChange: (on) => {
        void (async () => {
          try {
            await updateSchedulerJob(job.id, { enabled: on });
            await refreshList();
          } catch (err) {
            notify('err', err instanceof Error ? err.message : String(err));
          }
        })();
      },
    });
    toggleRow.classList.add('scheduler-job__toggle');
    actions.appendChild(toggleRow);

    const btnRow = el('div', 'scheduler-job__btn-row');

    const runBtn = el('button', 'settings-inline-btn', 'Run now');
    runBtn.type = 'button';
    runBtn.disabled = Boolean(job.running);
    runBtn.addEventListener('click', () => {
      void (async () => {
        try {
          await runSchedulerJobNow(job.id);
          notify('ok', `Started "${job.label}"`);
          await refreshList();
          if (selectedHistoryJobId === job.id) await renderHistory(job.id);
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

    const deleteBtn = el('button', 'settings-inline-btn scheduler-job__delete', 'Delete');
    deleteBtn.type = 'button';
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

    btnRow.append(runBtn, editBtn, historyBtn, deleteBtn);
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
        el('p', 'scheduler-empty__action-hint', 'Use Add task above to create your first schedule.'),
      );
    }
    return empty;
  }

  async function refreshList(): Promise<void> {
    list.replaceChildren();
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
    publishCounts(jobs.length, enabledCount);
    list.classList.toggle('scheduler-jobs--empty', jobs.length === 0);
    listHead.classList.toggle('hidden', jobs.length === 0);

    if (jobs.length === 0) {
      list.appendChild(renderEmptyState());
      return;
    }

    for (const job of jobs) {
      list.appendChild(createJobRow(job));
    }
  }

  await refreshList();
}
