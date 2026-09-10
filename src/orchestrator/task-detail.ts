import type { Attempt, BoardState, TaskState } from '../../server/orchestrator/core/types';
import { COLUMNS, columnOf, type ColumnId } from './board-columns';
import {
  OUTCOME_TONE,
  PHASE_TONE,
  formatElapsed,
  isStartable,
  phaseLabel,
  renderSkeleton,
  retryCount,
  retryLabel,
  type BoardActions,
  type BoardViewOptions,
  type FileDiffView,
  type TaskFilesView,
  type TranscriptView,
} from './board-render';
import { hasRunDebris } from '../../server/orchestrator/core/rewind.js';
import type { TaskFileStat, LiveActivity } from './client';
import { adaptAttemptTranscript, liveTailPhase, transcriptStructureKey } from './transcript-adapter';
import { renderAttemptScan, resetAttemptWriteUps } from './attempt-report';
import { humanizeAbandonReason } from './attempt-scan';
import { el, empty, pill } from './dom';
import { createIcon } from '../ui/icon';
import { renderUnifiedPromptDiff } from '../ui/prompt-diff-unified';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { appendTranscriptLiveTail, renderTranscriptView } from '../ui/transcript-view';
import type { SubAgentTranscriptLive } from '../ui/sub-agent-live-status';

const ui = {
  followThread: true,
  threadScrollTop: 0,
  specOpen: null as boolean | null,
  /** Files panel disclosure; defaults collapsed until the user opens it. */
  filesOpen: null as boolean | null,
  /** Live Thoughts toggles the user expanded, keyed by attempt id. */
  expandedLiveThoughts: new Set<string>(),
};

// ── Reset ────────────────────────────────────────────────────────────────────

export function resetTaskDetailLogUi(): void {
  ui.followThread = true;
  ui.threadScrollTop = 0;
}

export function resetTaskDetailUi(): void {
  resetTaskDetailLogUi();
  resetAttemptWriteUps();
  ui.expandedLiveThoughts.clear();
  ui.specOpen = null;
  ui.filesOpen = null;
}

// ── Detail ───────────────────────────────────────────────────────────────────

export function renderTaskDetail(
  state: BoardState,
  task: TaskState,
  actions: BoardActions,
  options: BoardViewOptions,
): HTMLElement {
  const titleId = `ov2-detail-title-${task.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const overlay = el('div', 'ov2-detail-overlay');
  overlay.dataset.focusKey = 'detail-overlay';
  overlay.dataset.taskId = task.id;
  overlay.dataset.phase = task.phase;
  overlay.dataset.attemptCount = String(task.attempts.length);
  overlay.addEventListener('click', () => actions.select(null));

  const detail = el('section', 'ov2-detail');
  detail.setAttribute('role', 'dialog');
  detail.setAttribute('aria-modal', 'true');
  detail.setAttribute('aria-labelledby', titleId);
  detail.addEventListener('click', (event) => event.stopPropagation());

  const dismissOnEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    actions.select(null);
  };
  overlay.addEventListener('keydown', dismissOnEscape);
  detail.addEventListener('keydown', dismissOnEscape);

  detail.appendChild(renderHead(state, task, actions, titleId));

  // Two panes: what the task is on the left, what an agent actually did on the
  // right. The thread is a conversation and needs its own height to read as one.
  const panes = el('div', 'ov2-detail__panes');

  const rail = el('div', 'ov2-detail__rail');
  for (const alert of renderAlerts(task)) rail.appendChild(alert);
  rail.appendChild(renderFilesSection(task, actions, options));
  rail.appendChild(renderWorkSection(task, actions, options));
  const spec = renderSpecSection(task);
  if (spec) rail.appendChild(spec);
  panes.appendChild(rail);

  panes.appendChild(renderThreadPane(task, options));
  detail.appendChild(panes);

  overlay.appendChild(detail);
  return overlay;
}

export type TaskDetailSyncMode = {
  /** Refresh the Work list (journal-rate: attempt started/ended). */
  syncWork?: boolean;
  /** How to refresh the right-hand thread. */
  thread?: 'tail' | 'body' | 'pane' | 'auto';
};

/**
 * Patch an already-open detail overlay instead of tearing it down.
 *
 * Live thinking must not remount this dialog: that restarts chat/tool
 * animations and drops the collapsed Thoughts caret.
 */
export function syncTaskDetailOverlay(
  overlay: HTMLElement,
  state: BoardState,
  task: TaskState,
  actions: BoardActions,
  options: BoardViewOptions,
  mode: TaskDetailSyncMode = {},
): void {
  overlay.dataset.taskId = task.id;
  overlay.dataset.phase = task.phase;
  overlay.dataset.attemptCount = String(task.attempts.length);

  syncFilesPanel(overlay, task, actions, options);

  if (mode.syncWork !== false) {
    syncWorkPanel(overlay, task, actions, options);
  }

  const thread = overlay.querySelector('.ov2-thread');
  if (thread instanceof HTMLElement) {
    syncThreadPane(thread, task, options, mode.thread ?? 'auto');
  }
}

function syncFilesPanel(
  overlay: HTMLElement,
  task: TaskState,
  actions: BoardActions,
  options: BoardViewOptions,
): void {
  const rail = overlay.querySelector('.ov2-detail__rail');
  if (!(rail instanceof HTMLElement)) return;
  const current = findRailPanel(rail, 'Files');
  const next = renderFilesSection(task, actions, options);
  if (current) current.replaceWith(next);
  else {
    const work = findRailPanel(rail, 'Work');
    if (work) rail.insertBefore(next, work);
    else rail.appendChild(next);
  }
}

function syncWorkPanel(
  overlay: HTMLElement,
  task: TaskState,
  actions: BoardActions,
  options: BoardViewOptions,
): void {
  const rail = overlay.querySelector('.ov2-detail__rail');
  if (!(rail instanceof HTMLElement)) return;
  const current = findRailPanel(rail, 'Work');
  const next = renderWorkSection(task, actions, options);
  if (current) current.replaceWith(next);
  else rail.appendChild(next);
}

function findRailPanel(rail: HTMLElement, title: string): HTMLElement | null {
  for (const panel of rail.querySelectorAll(':scope > .ov2-panel')) {
    if (!(panel instanceof HTMLElement)) continue;
    if (panel.querySelector('.ov2-panel__title')?.textContent === title) return panel;
  }
  return null;
}

function syncThreadPane(
  pane: HTMLElement,
  task: TaskState,
  options: BoardViewOptions,
  threadMode: NonNullable<TaskDetailSyncMode['thread']>,
): void {
  const view = options.transcript;
  const attempt = view
    ? task.attempts.find((a) => a.attemptId === view.attemptId)
    : undefined;
  const body = pane.querySelector<HTMLElement>('[data-thread-scroller]');

  if (!view || !attempt) {
    if (threadMode === 'tail') return;
    pane.replaceChildren(renderThreadPlaceholder(task));
    return;
  }

  let mode = threadMode;
  if (view.status === 'loading' || view.status === 'error') {
    if (mode === 'tail') return;
    mode = 'pane';
  } else if (mode === 'auto') {
    if (!body || body.dataset.threadScroller !== attempt.attemptId) mode = 'pane';
    else if ((attempt.ended ? '1' : '0') !== pane.dataset.attemptEnded) mode = 'pane';
    else if (
      view.status === 'ready' &&
      body.dataset.structureKey === transcriptStructureKey(view.events)
    ) {
      mode = 'tail';
    } else {
      mode = 'body';
    }
  }

  if (mode === 'pane' || !body) {
    const next = renderThreadPane(task, options);
    pane.replaceWith(next);
    return;
  }

  pane.dataset.attemptEnded = attempt.ended ? '1' : '0';

  if (mode === 'tail' && view.status === 'ready') {
    const { messages } = adaptAttemptTranscript(view.events);
    appendTranscriptLiveTail(
      body,
      threadLive(attempt, view, options.liveActivity?.get(task.id) ?? null),
      messages,
    );
    if (body.querySelector('.transcript-view__live-tail')) {
      body.querySelector('.ov2-empty')?.remove();
    }
    return;
  }

  paintThread(body, view, attempt, options.liveActivity?.get(task.id) ?? null);
}

// ── Head ─────────────────────────────────────────────────────────────────────

function renderHead(
  state: BoardState,
  task: TaskState,
  actions: BoardActions,
  titleId: string,
): HTMLElement {
  const head = el('header', 'ov2-detail__head');

  const top = el('div', 'ov2-detail__top');
  const ident = el('div', 'ov2-detail__ident');
  ident.appendChild(el('span', 'ov2-detail__id', task.id));
  const title = el('h2', 'ov2-detail__title', task.title);
  title.id = titleId;
  ident.appendChild(title);
  top.appendChild(ident);

  const phase = phaseLabel(state, task);
  top.appendChild(pill(phase, PHASE_TONE[task.phase]));

  const close = el('button', 'ov2-detail__close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close (Esc)';
  close.dataset.focusKey = 'detail-close';
  close.appendChild(createIcon('close', { size: 16 }));
  close.addEventListener('click', () => actions.select(null));
  top.appendChild(close);
  head.appendChild(top);

  const startable = isStartable(state, task);
  if (startable.can) {
    const retry = el(
      'button',
      startable.mode === 'rerun' ? 'ov2-btn ov2-btn--primary' : 'ov2-btn ov2-btn--ghost',
      startable.mode === 'rerun' || task.attempts.some((a) => a.ended) ? 'Retry' : 'Start',
    );
    retry.type = 'button';
    retry.title = startable.mode === 'rerun' ? `Rerun ${task.id}` : `Start ${task.id} now`;
    retry.addEventListener('click', () => {
      if (startable.mode === 'rerun') actions.rerun([task.id]);
      else actions.startTask(task.id);
    });
    head.appendChild(retry);
  }

  if (task.mergedSha !== null) {
    const rewind = el('button', 'ov2-btn ov2-btn--danger', 'Rewind');
    rewind.type = 'button';
    rewind.title =
      `Undo this merge and every task that landed after it. Restores integration to before ${task.id} merged. This is not Reset — Reset cannot touch a merged card.`;
    rewind.addEventListener('click', () => actions.rewindTask(task.id));
    head.appendChild(rewind);
  } else if (hasRunDebris(state, task)) {
    const reset = el('button', 'ov2-btn ov2-btn--danger', 'Reset');
    reset.type = 'button';
    reset.title =
      `Run ${task.id} from scratch. Deletes its attempt history, worktree, and branch. Integration is not changed. Retry keeps history; this does not.`;
    reset.addEventListener('click', () => actions.resetTask(task.id));
    head.appendChild(reset);
  }

  head.appendChild(renderFacts(state, task));
  return head;
}

function renderFacts(state: BoardState, task: TaskState): HTMLElement {
  const facts = el('dl', 'ov2-facts');
  const add = (label: string, value: string, mono = false) => {
    facts.appendChild(el('dt', 'ov2-facts__label', label));
    facts.appendChild(el('dd', mono ? 'ov2-facts__value ov2-facts__value--mono' : 'ov2-facts__value', value));
  };
  add('Column', columnLabel(columnOf(state, task)));
  add('Wave', String(task.wave));
  add('Needs', task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'nothing');
  const retries = retryCount(task);
  if (retries > 0) add('Retries', retryLabel(retries));
  if (task.mergedSha) add('Merged', task.mergedSha.slice(0, 10), true);
  return facts;
}

function columnLabel(id: ColumnId): string {
  return COLUMNS.find((c) => c.id === id)?.label ?? id;
}


/**
 * Only things that changed the outcome.
 *
 * Footprint overflow and unmatched globs used to shout here, one banner per
 * event, so a task that merged fine opened with three warnings about
 * package-lock.json. They are still on the journal; they are not what you came
 * to this panel to read.
 */
function renderAlerts(task: TaskState): HTMLElement[] {
  const alerts: HTMLElement[] = [];
  const add = (
    tone: 'bad' | 'warn',
    heading: string,
    detail: string,
    mono = false,
  ) => {
    const alert = el('div', `ov2-alert ov2-alert--${tone}`);
    alert.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
    alert.appendChild(el('span', 'ov2-alert__heading', heading));
    alert.appendChild(
      el('span', mono ? 'ov2-alert__detail ov2-alert__detail--mono' : 'ov2-alert__detail', detail),
    );
    alerts.push(alert);
  };

  if (task.abandonedReason) {
    add(
      'bad',
      'Abandoned',
      task.abandonedReason === 'user' ? 'Stopped by hand.' : humanizeAbandonReason(task.abandonedReason),
    );
  }
  if (task.skippedBy) {
    add('warn', 'Skipped', `${task.skippedBy} failed, so this never ran. It did not fail itself.`);
  }
  if (task.mergeConflicts && task.mergeConflicts.length > 0) {
    add('warn', 'Merge conflict', [...new Set(task.mergeConflicts)].join(', '), true);
  }
  return alerts;
}


function section(label: string, meta?: HTMLElement | null): HTMLElement {
  const wrap = el('section', 'ov2-panel');
  const head = el('div', 'ov2-panel__head');
  head.appendChild(el('h3', 'ov2-panel__title', label));
  if (meta) head.appendChild(meta);
  wrap.appendChild(head);
  return wrap;
}

function statsLine(files: number, additions: number, deletions: number): HTMLElement {
  const meta = el('div', 'ov2-panel__meta');
  meta.appendChild(el('span', 'ov2-panel__count', `${files} file${files === 1 ? '' : 's'}`));
  meta.appendChild(el('span', 'ov2-panel__sep', '·'));
  meta.appendChild(el('span', 'ov2-stat ov2-stat--add', `+${additions}`));
  meta.appendChild(el('span', 'ov2-stat ov2-stat--del', `−${deletions}`));
  return meta;
}

// ── Files ────────────────────────────────────────────────────────────────────

function taskFileCount(task: TaskState, view: TaskFilesView | null, merged: boolean): number {
  if (merged && view?.status === 'ready') return view.files.length;
  const planned = task.touchesExpanded?.length ? task.touchesExpanded : task.touches;
  return planned.length;
}

function renderFilesSection(
  task: TaskState,
  actions: BoardActions,
  options: BoardViewOptions,
): HTMLElement {
  const view = options.files?.taskId === task.id ? options.files : null;
  const merged = view?.status === 'ready' && view.source === 'merged' && view.files.length > 0;
  const fileCount = taskFileCount(task, view, merged);

  const details = el('details', 'ov2-panel ov2-files-panel');
  details.open = ui.filesOpen ?? false;
  details.addEventListener('toggle', () => {
    ui.filesOpen = details.open;
  });

  const summary = el('summary', 'ov2-panel__head ov2-files-panel__summary');
  summary.dataset.focusKey = 'files-toggle';

  const lead = el('div', 'ov2-files-panel__lead');
  lead.appendChild(createIcon('chevronRight', { size: 12, className: 'ov2-files-panel__chevron' }));
  lead.appendChild(el('h3', 'ov2-panel__title', 'Files'));
  const badge = el('span', 'ov2-files-panel__badge', String(fileCount));
  badge.setAttribute('aria-label', `${fileCount} file${fileCount === 1 ? '' : 's'}`);
  lead.appendChild(badge);
  summary.appendChild(lead);

  if (merged) summary.appendChild(statsLine(view.files.length, view.additions, view.deletions));
  details.appendChild(summary);

  const body = el('div', 'ov2-files-panel__body');

  if (view?.status === 'loading') {
    body.appendChild(renderSkeleton(3, 'ov2-skeleton ov2-skeleton--files'));
    details.appendChild(body);
    return details;
  }

  if (merged) {
    const list = el('div', 'ov2-files');
    for (const file of view.files) list.appendChild(renderFileRow(file, view, actions));
    body.appendChild(list);
    if (view.truncated) {
      body.appendChild(
        el('p', 'ov2-panel__note', 'Only the first 400 files are listed.'),
      );
    }
    details.appendChild(body);
    return details;
  }

  const planned = task.touchesExpanded?.length ? task.touchesExpanded : task.touches;
  if (planned.length === 0) {
    body.appendChild(empty('This task declared no file footprint.'));
    details.appendChild(body);
    return details;
  }
  const list = el('div', 'ov2-files ov2-files--planned');
  for (const path of planned) list.appendChild(renderPlannedRow(path, actions));
  body.appendChild(list);
  body.appendChild(
    el(
      'p',
      'ov2-panel__note',
      task.mergedSha
        ? 'Line counts need the merge commit, and git could not read it.'
        : 'Its declared footprint. Line counts arrive when the task merges.',
    ),
  );
  details.appendChild(body);
  return details;
}

function pathLabel(path: string): HTMLElement {
  const wrap = el('span', 'ov2-file__path');
  const cut = path.lastIndexOf('/');
  if (cut >= 0) wrap.appendChild(el('span', 'ov2-file__dir', path.slice(0, cut + 1)));
  wrap.appendChild(el('span', 'ov2-file__name', cut >= 0 ? path.slice(cut + 1) : path));
  return wrap;
}

function renderFileRow(
  file: TaskFileStat,
  view: TaskFilesView,
  actions: BoardActions,
): HTMLElement {
  const row = el('div', 'ov2-file');
  const header = el('div', 'ov2-file__header');
  const open = view.expanded.has(file.path);

  const toggle = el('button', 'ov2-file__toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} diff for ${file.path}`);
  toggle.dataset.focusKey = `file-toggle:${file.path}`;
  toggle.classList.toggle('is-open', open);
  toggle.appendChild(createIcon('chevronRight', { size: 12 }));
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.toggleFileDiff(file.path);
  });
  header.appendChild(toggle);

  const openFile = el('button', 'ov2-file__open');
  openFile.type = 'button';
  openFile.title = file.path;
  openFile.setAttribute('aria-label', `Open ${file.path}`);
  openFile.dataset.focusKey = `file-open:${file.path}`;
  openFile.appendChild(pathLabel(file.path));
  openFile.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.openFile(file.path);
  });
  header.appendChild(openFile);

  const stats = el('span', 'ov2-file__stats');
  if (file.binary) {
    stats.appendChild(el('span', 'ov2-file__binary', 'binary'));
  } else {
    if (file.additions > 0) {
      stats.appendChild(el('span', 'ov2-stat ov2-stat--add', `+${file.additions}`));
    }
    if (file.deletions > 0) {
      stats.appendChild(el('span', 'ov2-stat ov2-stat--del', `−${file.deletions}`));
    }
  }
  header.appendChild(stats);
  row.appendChild(header);

  if (open) row.appendChild(renderFileDiff(view.diffs.get(file.path)));
  return row;
}

function renderFileDiff(diff: FileDiffView | undefined): HTMLElement {
  const host = el('div', 'ov2-file__diff');
  if (!diff || diff.status === 'loading') {
    host.appendChild(renderSkeleton(3, 'ov2-skeleton ov2-skeleton--diff'));
    return host;
  }
  if (diff.status === 'error') {
    host.appendChild(el('p', 'ov2-panel__note', diff.error ?? 'Could not read this diff.'));
    return host;
  }
  if (diff.lines.length === 0) {
    host.appendChild(el('p', 'ov2-panel__note', 'No textual diff for this file.'));
    return host;
  }
  const body = el('div', 'ov2-file__diff-body');
  renderUnifiedPromptDiff(body, [...diff.lines]);
  host.appendChild(body);
  if (diff.truncated) {
    host.appendChild(el('p', 'ov2-panel__note', 'Diff shortened for display.'));
  }
  return host;
}

function renderPlannedRow(path: string, actions: BoardActions): HTMLElement {
  const row = el('div', 'ov2-file ov2-file--planned');
  const header = el('div', 'ov2-file__header');
  header.appendChild(el('span', 'ov2-file__toggle-spacer'));
  if (/[*?[\]]/.test(path)) {
    const label = el('span', 'ov2-file__open ov2-file__open--static');
    label.title = path;
    label.appendChild(pathLabel(path));
    header.appendChild(label);
  } else {
    const openFile = el('button', 'ov2-file__open');
    openFile.type = 'button';
    openFile.title = path;
    openFile.setAttribute('aria-label', `Open ${path}`);
    openFile.dataset.focusKey = `file-open:${path}`;
    openFile.appendChild(pathLabel(path));
    openFile.addEventListener('click', () => actions.openFile(path));
    header.appendChild(openFile);
  }
  row.appendChild(header);
  return row;
}


const ROLE_ICON = {
  builder: 'boardBuild',
  tester: 'boardTest',
  merge: 'boardGroup',
  final: 'boardTest',
} as const;

/** What to call each role in the panel. "builder" is a role; "Builder" is who did it. */
const ROLE_LABEL: Record<string, string> = {
  builder: 'Builder',
  tester: 'Tester',
  merge: 'Merge',
  final: 'Final test',
};

/** Roles run by an agent, and so the only ones with a thread to read. */
const AGENT_ROLES = new Set(['builder', 'tester']);

/** Why an agent was sent in again. `initial` is the first go, not a retry. */
const SEED_LABEL: Record<string, string> = {
  'failure-aware': 'after a failure',
  repair: 'repair',
  continue: 'continued',
  fix: 'fix',
  rebase: 'rebased',
  'integration-fix': 'integration fix',
};

// ── Work ─────────────────────────────────────────────────────────────────────

/**
 * Everything that has been done to this task, in order.
 *
 * Builder and tester are agents and open a thread. Merge and the final test are
 * the engine's own steps: they belong in the sequence, but they have no
 * transcript and no agent, so they are rendered as the thinner thing they are.
 */
function renderWorkSection(
  task: TaskState,
  actions: BoardActions,
  options: BoardViewOptions,
): HTMLElement {
  const agents = task.attempts.filter((a) => AGENT_ROLES.has(a.role)).length;
  const meta = agents > 0 ? el('div', 'ov2-panel__meta') : null;
  if (meta) {
    meta.appendChild(el('span', 'ov2-panel__count', `${agents} agent${agents === 1 ? '' : 's'}`));
  }
  const wrap = section('Work', meta);

  if (task.attempts.length === 0) {
    wrap.appendChild(empty('Nothing has been done to this task yet.'));
    return wrap;
  }
  const list = el('ol', 'ov2-work');
  task.attempts.forEach((attempt, index) => {
    list.appendChild(renderWorkRow(attempt, index + 1, actions, options));
  });
  wrap.appendChild(list);
  return wrap;
}

function renderWorkRow(
  attempt: Attempt,
  index: number,
  actions: BoardActions,
  options: BoardViewOptions,
): HTMLElement {
  const readable = AGENT_ROLES.has(attempt.role);
  const item = el('li', readable ? 'ov2-work__item' : 'ov2-work__item ov2-work__item--engine');
  const open = readable && options.transcript?.attemptId === attempt.attemptId;
  item.classList.toggle('is-open', open);

  const header = readable ? el('button', 'ov2-work__header') : el('div', 'ov2-work__header');
  if (header instanceof HTMLButtonElement) {
    header.type = 'button';
    header.setAttribute('aria-expanded', open ? 'true' : 'false');
    header.dataset.focusKey = `transcript:${attempt.attemptId}`;
    header.title = `Read what the ${ROLE_LABEL[attempt.role] ?? attempt.role} did`;
    header.addEventListener('click', () => actions.openTranscript(attempt.attemptId));
  } else {
    header.classList.add('ov2-work__header--static');
    header.title = 'An engine step. It has no agent and no transcript.';
  }

  const marker = el('span', 'ov2-work__index', String(index));
  marker.setAttribute('aria-hidden', 'true');
  header.appendChild(marker);

  header.appendChild(
    createIcon(ROLE_ICON[attempt.role as keyof typeof ROLE_ICON] ?? 'boardBuild', {
      size: 13,
      className: 'ov2-work__icon',
    }),
  );
  header.appendChild(el('span', 'ov2-work__role', ROLE_LABEL[attempt.role] ?? attempt.role));

  const seed =
    attempt.seedKind && attempt.seedKind !== 'initial'
      ? (SEED_LABEL[attempt.seedKind] ?? attempt.seedKind.replace(/-/g, ' '))
      : '';
  if (seed) header.appendChild(el('span', 'ov2-work__seed', seed));
  if (attempt.manual && !attempt.ended) header.appendChild(pill('by hand', 'neutral'));

  if (attempt.ended) {
    header.appendChild(
      pill(attempt.outcome ?? 'ended', OUTCOME_TONE[attempt.outcome ?? ''] ?? 'neutral'),
    );
  } else {
    header.appendChild(
      renderRunningState(attempt, options.attemptStartedAt, options.now),
    );
  }

  if (readable) {
    header.appendChild(createIcon('chevronRight', { size: 12, className: 'ov2-work__chevron' }));
  }
  item.appendChild(header);

  const scan = renderAttemptScan(attempt);
  if (scan) item.appendChild(scan);
  return item;
}

/** Spinner, the word, and how long — the three things "is it stuck?" needs. */
function renderRunningState(
  attempt: Attempt,
  startedAtById?: ReadonlyMap<string, number>,
  now?: number,
): HTMLElement {
  const wrap = el('span', 'ov2-work__running');
  wrap.setAttribute('role', 'status');

  const spinner = el('span', 'tool-call-spinner ov2-work__spinner');
  spinner.setAttribute('aria-hidden', 'true');
  wrap.appendChild(spinner);
  wrap.appendChild(el('span', 'ov2-work__running-label', 'running'));

  const startedAt = startedAtById?.get(attempt.attemptId);
  if (typeof startedAt === 'number' && startedAt > 0) {
    const at = typeof now === 'number' ? now : Date.now();
    const clock = el('span', 'ov2-activity__elapsed', formatElapsed(at - startedAt));
    clock.dataset.startedAt = String(startedAt);
    clock.title = 'How long this has been running';
    wrap.appendChild(clock);
  }
  return wrap;
}


// ── Thread ───────────────────────────────────────────────────────────────────

/**
 * The right pane: one agent's attempt, rendered as the conversation it was.
 *
 * The board records the same turn events chat does, so it goes through the same
 * renderer — tool cards, diffs, thought panels and all — rather than a second,
 * worse one that would drift from it.
 */
function renderThreadPane(task: TaskState, options: BoardViewOptions): HTMLElement {
  const pane = el('div', 'ov2-thread');
  const attempt = options.transcript
    ? task.attempts.find((a) => a.attemptId === options.transcript?.attemptId)
    : undefined;
  pane.dataset.attemptEnded = attempt && !attempt.ended ? '0' : attempt?.ended ? '1' : '';

  if (!options.transcript || !attempt) {
    pane.appendChild(renderThreadPlaceholder(task));
    return pane;
  }

  pane.appendChild(renderThreadHead(attempt, options));

  const body = el('div', 'ov2-thread__body transcript-view__body');
  body.dataset.threadScroller = attempt.attemptId;
  pane.appendChild(body);

  const view = options.transcript;
  if (view.status === 'loading') {
    body.appendChild(renderSkeleton(5, 'ov2-skeleton ov2-skeleton--log'));
    return pane;
  }
  if (view.status === 'error') {
    body.appendChild(
      el('p', 'ov2-panel__note', view.error ?? 'Could not read what this agent did.'),
    );
    return pane;
  }

  paintThread(body, view, attempt, options.liveActivity?.get(task.id) ?? null);
  return pane;
}

function renderThreadHead(attempt: Attempt, options: BoardViewOptions): HTMLElement {
  const head = el('div', 'ov2-thread__head');
  head.appendChild(
    createIcon(ROLE_ICON[attempt.role as keyof typeof ROLE_ICON] ?? 'boardBuild', {
      size: 14,
      className: 'ov2-thread__icon',
    }),
  );
  head.appendChild(el('h3', 'ov2-thread__title', ROLE_LABEL[attempt.role] ?? attempt.role));
  if (attempt.seedKind && attempt.seedKind !== 'initial') {
    head.appendChild(
      el(
        'span',
        'ov2-work__seed',
        SEED_LABEL[attempt.seedKind] ?? attempt.seedKind.replace(/-/g, ' '),
      ),
    );
  }
  head.appendChild(
    attempt.ended
      ? pill(attempt.outcome ?? 'ended', OUTCOME_TONE[attempt.outcome ?? ''] ?? 'neutral')
      : renderRunningState(attempt, options.attemptStartedAt, options.now),
  );
  return head;
}

function renderThreadPlaceholder(task: TaskState): HTMLElement {
  const readable = task.attempts.some((a) => AGENT_ROLES.has(a.role));
  const wrap = el('div', 'ov2-thread__blank');
  wrap.appendChild(
    el(
      'p',
      'ov2-thread__blank-title',
      readable ? 'Pick a Builder or Tester to read it.' : 'No agent has worked on this yet.',
    ),
  );
  wrap.appendChild(
    el(
      'p',
      'ov2-thread__blank-body',
      readable
        ? 'Everything it thought, ran and wrote shows up here.'
        : 'Once one starts, everything it thinks and runs shows up here as it happens.',
    ),
  );
  return wrap;
}

/**
 * Live tail for the open thread: prefer the SSE activity map (token-fresh)
 * over the last coalesced disk event.
 */
function threadLive(
  attempt: Attempt,
  view: TranscriptView,
  activity?: LiveActivity | null,
): SubAgentTranscriptLive | undefined {
  if (attempt.ended) return undefined;
  const tail = liveTailPhase(view.events);
  const thinking = activity?.kind === 'thinking';
  const tool = activity?.kind === 'tool';
  const writing = activity?.kind === 'writing';
  // A phase frame can land before the frame that names what is happening, so an
  // empty live text falls back to the transcript's tail rather than blanking.
  const reasoning = thinking && activity.text ? activity.text : tail.reasoning;
  const toolName = tool && activity.text ? activity.text : tail.toolName;
  const phase = thinking ? 'thinking' : tool ? 'tools' : writing ? 'generating' : tail.phase;
  return {
    isLive: true,
    phase,
    currentToolName: toolName ?? null,
    ...(reasoning ? { partialReasoning: reasoning } : {}),
    thoughtsExpanded: ui.expandedLiveThoughts.has(attempt.attemptId),
    onThoughtsExpandedChange: (expanded) => {
      if (expanded) ui.expandedLiveThoughts.add(attempt.attemptId);
      else ui.expandedLiveThoughts.delete(attempt.attemptId);
    },
  };
}

function paintThread(
  body: HTMLElement,
  view: TranscriptView,
  attempt: Attempt,
  activity?: LiveActivity | null,
): void {
  const { messages, end } = adaptAttemptTranscript(view.events);
  const live = !attempt.ended;
  body.dataset.structureKey = transcriptStructureKey(view.events);

  if (messages.length === 0 && !end) {
    body.replaceChildren();
    if (live) {
      appendTranscriptLiveTail(body, threadLive(attempt, view, activity), messages);
      if (body.childNodes.length > 0) {
        restoreThreadScroll(body, true);
        return;
      }
    }
    body.appendChild(
      empty(
        live
          ? 'Nothing yet. The thread starts at the first thought or tool call.'
          : 'Nothing was recorded for this attempt.',
      ),
    );
    return;
  }

  // The shared renderer owns this element and clears it, so the note about a
  // shortened thread goes in after, not before.
  renderTranscriptView(body, messages);

  if (view.capped || view.truncated) {
    body.prepend(
      el(
        'p',
        'ov2-panel__note ov2-thread__note',
        view.capped
          ? 'This attempt ran longer than the transcript keeps. The earliest of it was dropped.'
          : 'Showing the most recent of a long thread.',
      ),
    );
  }

  if (live) {
    appendTranscriptLiveTail(body, threadLive(attempt, view, activity), messages);
  } else if (end) {
    body.appendChild(renderThreadEnd(end.outcome, end.summary));
  }

  restoreThreadScroll(body, live);
}

function renderThreadEnd(outcome: string, summary: string): HTMLElement {
  const wrap = el('div', `ov2-thread__end ov2-thread__end--${OUTCOME_TONE[outcome] ?? 'neutral'}`);
  wrap.appendChild(el('span', 'ov2-thread__end-label', 'Ended'));
  wrap.appendChild(pill(outcome, OUTCOME_TONE[outcome] ?? 'neutral'));
  if (summary.trim()) {
    const prose = el('div', 'ov2-thread__end-summary');
    setAssistantBubbleContent(prose, summary);
    wrap.appendChild(prose);
  }
  return wrap;
}

/** Stick to the bottom while an agent is working; hold position once it stops. */
function restoreThreadScroll(body: HTMLElement, live: boolean): void {
  if (!body.dataset.scrollBound) {
    body.dataset.scrollBound = '1';
    body.addEventListener('scroll', () => {
      const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
      ui.followThread = distance <= 32;
      ui.threadScrollTop = body.scrollTop;
    });
  }
  queueMicrotask(() => {
    if (!body.isConnected) return;
    body.scrollTop = live && ui.followThread ? body.scrollHeight : ui.threadScrollTop;
  });
}

// ── Spec ─────────────────────────────────────────────────────────────────────

function renderSpecSection(task: TaskState): HTMLElement | null {
  const parts: Array<[string, string]> = [];
  for (const [label, value] of [
    ['Build', task.buildSpec],
    ['Test', task.testSpec],
    ['Accept', task.accept],
  ] as const) {
    if (value) parts.push([label, value]);
  }
  if (parts.length === 0) return null;

  const details = el('details', 'ov2-spec');
  details.open = ui.specOpen ?? task.attempts.length === 0;
  details.addEventListener('toggle', () => {
    ui.specOpen = details.open;
  });

  const summary = el('summary', 'ov2-spec__summary');
  summary.dataset.focusKey = 'spec-toggle';
  summary.appendChild(createIcon('chevronRight', { size: 12, className: 'ov2-spec__chevron' }));
  summary.appendChild(el('span', 'ov2-panel__title', 'Spec'));
  summary.appendChild(
    el('span', 'ov2-spec__hint', parts.map(([label]) => label.toLowerCase()).join(' · ')),
  );
  details.appendChild(summary);

  const body = el('div', 'ov2-spec__body');
  for (const [label, value] of parts) {
    const block = el('div', 'ov2-spec__block');
    block.appendChild(el('h4', 'ov2-spec__label', label));
    const prose = el('div', 'ov2-spec__prose');
    setAssistantBubbleContent(prose, value);
    block.appendChild(prose);
    body.appendChild(block);
  }
  details.appendChild(body);
  return details;
}
