/**
 * One Orchestrate board: live progress, cards by column, run controls, and a
 * task sheet with specs, attempts, transcripts and changed files.
 */

import {
  createBoardClient,
  readAttemptTranscript,
  readBoardReport,
  readTaskFileDiff,
  readTaskFiles,
  type BoardClient,
  type LiveActivity,
} from '../orchestrator/client';
import { COLUMNS, columnOf, groupByWave, type ColumnId } from '../orchestrator/board-columns';
import {
  buildTaskCardMenuItems,
  formatElapsed,
  OUTCOME_TONE,
  PHASE_TONE,
  phaseLabel,
  retryCount,
  retryLabel,
  runningAttempt,
  thinkingGlimpse,
  type BoardActions,
} from '../orchestrator/board-render';
import { adaptAttemptTranscript } from '../orchestrator/transcript-adapter';
import { humanizeToolName } from '../ui/tool-messages';
import { setAssistantBubbleContent } from '../markdown/renderer';
import type { MenuActionItem } from '../ui/context-menu';
import type { Attempt, BoardState, TaskState } from '../../server/orchestrator/core/types';
import { boardStatus, outcomeText, PHASE_TEXT } from './board-status';
import { screenHeader, segmented } from './chrome';
import { renderDiff } from './diff';
import { el, emptyState, haptic, icon, iconButton } from './dom';
import { pushScreen, type MobileScreen } from './nav';
import { confirmSheet, openActionSheet, openSheet, pickFromSheet, promptSheet, type SheetHandle } from './sheet';

type Filter = 'all' | ColumnId;

async function toast(message: string, variant: 'success' | 'error' = 'success'): Promise<void> {
  const { showToast } = await import('../ui/toast');
  showToast(message, variant);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function needsAttention(task: TaskState): boolean {
  return (
    task.phase === 'abandoned' ||
    Boolean(task.mergeConflicts?.length) ||
    Boolean(task.mergeFailure) ||
    task.outcome === 'blocked'
  );
}

function activityLine(activity: LiveActivity | undefined): string {
  if (!activity) return '';
  if (activity.kind === 'thinking') return activity.text ? thinkingGlimpse(activity.text) : 'Thinking…';
  if (activity.kind === 'writing') return 'Writing…';
  const name = activity.text ? humanizeToolName(activity.text) : 'a tool';
  if (activity.preparing) return `Preparing ${name}…`;
  return activity.settled ? `Ran ${name}` : `Running ${name}…`;
}


/** The board's phase word, in plain language. */
function phaseText(state: BoardState, task: TaskState): string {
  const phase = phaseLabel(state, task);
  return PHASE_TEXT[phase] ?? phase;
}

function markdownBlock(markdown: string, className = 'm-md'): HTMLElement {
  const node = el('div', { className });
  setAssistantBubbleContent(node, markdown);
  return node;
}

function roleLabel(role: string): string {
  switch (role) {
    case 'builder':
      return 'Builder';
    case 'tester':
      return 'Tester';
    case 'merge':
      return 'Merge';
    case 'final':
      return 'Final test';
    default:
      return role;
  }
}

// ── Attempt transcript ───────────────────────────────────────────────────────

function createAttemptScreen(boardId: string, task: TaskState, attempt: Attempt): MobileScreen {
  const header = screenHeader({
    title: `${roleLabel(attempt.role)} · ${task.id}`,
    subtitle: attempt.ended ? outcomeText(attempt.outcome) : 'Running',
    back: true,
  });
  const body = el('div', { className: 'm-screen__body m-transcript' });
  body.append(el('div', { className: 'm-skeleton' }), el('div', { className: 'm-skeleton' }));
  const root = el('section', { className: 'm-screen', dataset: { screen: `attempt:${attempt.attemptId}` } }, header.el, body);
  let timer = 0;

  const load = async () => {
    try {
      const { events, truncated } = await readAttemptTranscript(boardId, attempt.attemptId, { limit: 4000 });
      const adapted = adaptAttemptTranscript(events);
      const { renderTranscriptView } = await import('../ui/transcript-view');
      const holder = el('div', { className: 'm-transcript__messages' });
      renderTranscriptView(holder, adapted.messages);
      const nodes: HTMLElement[] = [];
      if (truncated) nodes.push(el('p', { className: 'm-note', text: 'Showing the latest part of this run.' }));
      nodes.push(holder);
      if (adapted.end) {
        nodes.push(
          el(
            'div',
            { className: 'm-attempt-end' },
            el('span', { className: `m-pill m-pill--${OUTCOME_TONE[adapted.end.outcome] ?? 'neutral'}`, text: outcomeText(adapted.end.outcome) }),
            adapted.end.summary ? markdownBlock(adapted.end.summary) : null,
          ),
        );
      }
      if (!adapted.messages.length && !adapted.end) {
        nodes.push(emptyState({ glyph: 'fi-rr-hourglass-end', title: 'Nothing recorded yet' }));
      }
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      body.replaceChildren(...nodes);
      if (atBottom && !attempt.ended) body.scrollTop = body.scrollHeight;
    } catch (error) {
      body.replaceChildren(emptyState({ glyph: 'fi-rr-cloud-disabled', title: 'Could not load the run', body: errorText(error) }));
    }
  };

  return {
    key: `attempt:${attempt.attemptId}`,
    el: root,
    onShow() {
      void load();
      if (!attempt.ended) timer = window.setInterval(() => void load(), 5_000);
    },
    onHide() {
      window.clearInterval(timer);
    },
    dispose() {
      window.clearInterval(timer);
    },
  };
}

// ── Changed files ────────────────────────────────────────────────────────────

function createTaskFilesScreen(boardId: string, task: TaskState): MobileScreen {
  const header = screenHeader({ title: 'Changed files', subtitle: `${task.id} · ${task.title}`, back: true });
  const body = el('div', { className: 'm-screen__body' });
  const root = el('section', { className: 'm-screen', dataset: { screen: `files:${task.id}` } }, header.el, body);

  const load = async () => {
    body.replaceChildren(el('div', { className: 'm-skeleton' }));
    try {
      const result = await readTaskFiles(boardId, task.id);
      header.setSubtitle(`${result.source === 'merged' ? 'Merged' : 'In progress'} · +${result.additions} −${result.deletions}`);
      if (!result.files.length) {
        body.replaceChildren(emptyState({ glyph: 'fi-rr-document', title: 'No changes yet' }));
        return;
      }
      const list = el('div', { className: 'm-list', attrs: { role: 'list' } });
      for (const file of result.files) {
        const details = el('details', { className: 'm-file-diff' });
        const summary = el(
          'summary',
          { className: 'm-file-diff__summary' },
          el('span', { className: 'm-file-diff__path', text: file.path }),
          el('span', { className: 'm-file-diff__stat' },
            el('span', { className: 'm-add', text: `+${file.additions}` }),
            el('span', { className: 'm-del', text: `−${file.deletions}` }),
          ),
        );
        const content = el('div', { className: 'm-file-diff__body' });
        details.append(summary, content);
        details.addEventListener('toggle', () => {
          if (!details.open || content.childElementCount) return;
          if (file.binary) {
            content.append(el('p', { className: 'm-muted', text: 'Binary file.' }));
            return;
          }
          content.append(el('div', { className: 'm-skeleton' }));
          void readTaskFileDiff(boardId, task.id, file.path)
            .then((diff) => {
              content.replaceChildren(diff ? renderDiff(diff.lines) : el('p', { className: 'm-muted', text: 'No diff available.' }));
              if (diff?.truncated) content.append(el('p', { className: 'm-note', text: 'Diff truncated.' }));
            })
            .catch((error) => content.replaceChildren(el('p', { className: 'm-error', text: errorText(error) })));
        });
        list.append(details);
      }
      body.replaceChildren(list);
      if (result.truncated) body.append(el('p', { className: 'm-note', text: 'Some files are not shown.' }));
    } catch (error) {
      body.replaceChildren(emptyState({ glyph: 'fi-rr-cloud-disabled', title: 'Could not load changes', body: errorText(error) }));
    }
  };

  return { key: `files:${task.id}`, el: root, onShow: () => void load() };
}

// ── Board ────────────────────────────────────────────────────────────────────

export function createBoardScreen(boardId: string): MobileScreen {
  const client: BoardClient = createBoardClient(boardId);
  const pending = new Set<string>();
  let filter: Filter = 'all';
  let openTaskSheet: { taskId: string; sheet: SheetHandle; render: () => void } | null = null;
  let clock = 0;

  const header = screenHeader({
    title: 'Board',
    back: true,
    actions: [iconButton('fi-rr-menu-dots-vertical', 'Board actions', () => openBoardMenu())],
  });
  const progress = el('div', { className: 'm-board-progress' });
  const errors = el('div', { className: 'm-board-errors' });
  const filters = segmented<Filter>(
    'Columns',
    [{ value: 'all', label: 'All' }, ...COLUMNS.map((column) => ({ value: column.id as Filter, label: column.label }))],
    filter,
    (value) => {
      filter = value;
      renderTasks();
    },
  );
  const list = el('div', { className: 'm-tasks' });
  const body = el('div', { className: 'm-screen__body' }, progress, errors, filters.el, list);
  body.append(el('div', { className: 'm-skeleton' }), el('div', { className: 'm-skeleton' }));
  const controls = el('div', { className: 'm-board-controls' });
  const root = el('section', { className: 'm-screen m-board', dataset: { screen: `board:${boardId}` } }, header.el, body, controls);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      haptic();
      await action();
    } catch (error) {
      void toast(`${label}: ${errorText(error)}`, 'error');
    }
  };

  const withPending = (taskId: string, label: string, action: () => Promise<{ ok: boolean; error?: string } | boolean | void>) => {
    pending.add(taskId);
    renderAll();
    void run(label, async () => {
      const result = await action();
      if (result && typeof result === 'object' && !result.ok) void toast(result.error ?? `${label} was not possible`, 'error');
      if (result === false) void toast(`${label} was not possible`, 'error');
    }).finally(() => {
      pending.delete(taskId);
      renderAll();
    });
  };

  const actions: BoardActions = {
    startTask: (id) => withPending(id, 'Start', () => client.startTask(id)),
    abandonTask: (id) => {
      void confirmSheet({ title: `Abandon ${id}?`, body: 'Tasks that depend on it will be stranded too.', confirmLabel: 'Abandon', danger: true }).then((ok) => {
        if (ok) withPending(id, 'Abandon', () => client.abandonTask(id));
      });
    },
    editTask: () => {},
    skipTask: (id) => withPending(id, 'Skip', () => client.skipTask(id)),
    mergeAndSkipTask: (id) => withPending(id, 'Merge and skip', () => client.mergeAndSkipTask(id)),
    resetTask: (id) => {
      void confirmSheet({ title: `Reset ${id}?`, body: 'Deletes its attempt history, worktree and branch.', confirmLabel: 'Reset', danger: true }).then((ok) => {
        if (ok) withPending(id, 'Reset', () => client.resetTask(id));
      });
    },
    rewindTask: (id) => {
      void confirmSheet({ title: `Rewind ${id}?`, body: 'Undoes this merge and every task that landed after it.', confirmLabel: 'Rewind', danger: true }).then((ok) => {
        if (ok) withPending(id, 'Rewind', () => client.rewindTask(id));
      });
    },
    rerun: (ids) => void run('Retry', () => client.rerun(ids)),
    select: () => {},
    openTranscript: () => {},
    toggleFileDiff: () => {},
    openFile: () => {},
  };

  function summaryOf(state: BoardState) {
    let merged = 0;
    let attention = 0;
    for (const task of state.tasks.values()) {
      if (task.phase === 'merged') merged += 1;
      if (needsAttention(task)) attention += 1;
    }
    return { merged, attention, total: state.tasks.size };
  }

  function renderHeader(state: BoardState): void {
    const { merged, attention, total } = summaryOf(state);
    const status = boardStatus({ ...state, finalTestFailed: state.finalTest?.outcome === 'fail', attentionCount: attention });
    header.setTitle(state.name || boardId);
    header.setSubtitle(`${status.label} · ${merged} of ${total} merged`);
    const counts: Partial<Record<Filter, number>> = { all: total };
    for (const column of COLUMNS) counts[column.id] = 0;
    for (const task of state.tasks.values()) {
      const column = columnOf(state, task);
      counts[column] = (counts[column] ?? 0) + 1;
    }
    filters.setCounts(counts);
    const pct = total ? Math.round((merged / total) * 100) : 0;
    progress.replaceChildren(
      el('div', { className: 'm-progress m-progress--lg' }, el('span', { className: 'm-progress__fill', attrs: { style: `width: ${pct}%` } })),
      el(
        'div',
        { className: 'm-board-progress__meta' },
        el('span', { className: `m-pill m-pill--${status.tone}`, text: status.label }),
        el('span', { text: `${pct}% merged` }),
        attention ? el('span', { className: 'm-board-row__attention' }, icon('fi-rr-exclamation', 12), el('span', { text: `${attention} need${attention === 1 ? 's' : ''} you` })) : null,
        state.status === 'running' ? el('span', { text: `${state.concurrency} at a time` }) : null,
      ),
    );
    if (state.runSummary) progress.append(el('p', { className: 'm-board-progress__summary', text: state.runSummary }));
  }

  function renderErrors(): void {
    const items = [...client.getEngineErrors().values()];
    errors.replaceChildren(
      ...items.map((error) =>
        el(
          'div',
          { className: 'm-banner m-banner--bad', attrs: { role: 'alert' } },
          icon('fi-rr-triangle-warning', 16),
          el('span', { text: `${error.taskId ?? 'Board'} · ${roleLabel(error.role)}: ${error.message}${error.consecutive > 1 ? ` (×${error.consecutive})` : ''}` }),
        ),
      ),
    );
  }

  function taskCard(state: BoardState, task: TaskState): HTMLElement {
    const phase = phaseText(state, task);
    const tone = needsAttention(task) ? 'bad' : PHASE_TONE[task.phase];
    const live = client.getLiveActivity().get(task.id);
    const attempt = runningAttempt(task);
    const started = attempt ? client.getAttemptStartedAt().get(attempt.attemptId) : undefined;
    const retries = retryCount(task);
    const detail = attempt
      ? activityLine(live) || `${roleLabel(attempt.role)} working…`
      : task.abandonedReason ?? (task.mergeConflicts?.length ? `Conflicts in ${task.mergeConflicts.length} file${task.mergeConflicts.length === 1 ? '' : 's'}` : '');
    return el(
      'button',
      {
        className: `m-task m-task--${tone}${pending.has(task.id) ? ' is-pending' : ''}`,
        attrs: { type: 'button' },
        dataset: { taskId: task.id },
        on: { click: () => openTask(task.id) },
      },
      el(
        'span',
        { className: 'm-task__top' },
        el('span', { className: 'm-task__id', text: task.id }),
        el('span', { className: `m-pill m-pill--${tone}`, text: phase }),
        started && attempt
          ? el('span', { className: 'm-task__clock', text: formatElapsed(Date.now() - started), dataset: { startedAt: String(started) } })
          : null,
      ),
      el('span', { className: 'm-task__title', text: task.title }),
      detail ? el('span', { className: `m-task__detail${attempt ? ' is-live' : ''}`, text: detail }) : null,
      retries ? el('span', { className: 'm-task__retries', text: retryLabel(retries) }) : null,
    );
  }

  function renderTasks(): void {
    const state = client.getState();
    if (!state) return;
    const nodes: HTMLElement[] = [];
    if (filter === 'all') {
      const waveNames = new Map(state.waves.map((wave) => [wave.n, wave.name]));
      for (const [wave, ids] of groupByWave(state)) {
        const tasks = ids.map((id) => state.tasks.get(id)).filter((task): task is TaskState => Boolean(task));
        const done = tasks.filter((task) => task.phase === 'merged').length;
        nodes.push(
          el(
            'h2',
            { className: 'm-section-label m-section-label--wave' },
            el('span', { text: waveNames.get(wave) ? `Wave ${wave} · ${waveNames.get(wave)}` : `Wave ${wave}` }),
            el('span', { className: 'm-section-label__count', text: `${done}/${tasks.length}` }),
          ),
        );
        for (const task of tasks) nodes.push(taskCard(state, task));
      }
    } else {
      for (const id of state.taskOrder) {
        const task = state.tasks.get(id);
        if (task && columnOf(state, task) === filter) nodes.push(taskCard(state, task));
      }
    }
    if (!nodes.length) {
      const label = COLUMNS.find((column) => column.id === filter)?.label ?? 'this column';
      nodes.push(emptyState({ glyph: 'fi-rr-inbox', title: `Nothing in ${label}` }));
    }
    list.replaceChildren(...nodes);
  }

  function renderControls(state: BoardState): void {
    const buttons: HTMLElement[] = [];
    const btn = (label: string, glyph: string, className: string, onClick: () => void) =>
      el('button', { className: `m-btn ${className}`, attrs: { type: 'button' }, on: { click: onClick } }, icon(glyph, 16), el('span', { text: label }));
    if (state.status === 'running') {
      buttons.push(btn('Pause', 'fi-rr-pause', '', () => void run('Pause', () => client.pause())));
      buttons.push(btn('Stop', 'fi-rr-stop', 'm-btn--danger-ghost', () => {
        void confirmSheet({ title: 'Stop this board?', body: 'Running agents are stopped. You can resume later.', confirmLabel: 'Stop', danger: true }).then((ok) => {
          if (ok) void run('Stop', () => client.stop());
        });
      }));
    } else if (state.finished) {
      const failed = [...state.tasks.values()].filter((task) => task.phase === 'abandoned');
      if (failed.length) {
        buttons.push(btn(`Retry ${failed.length} failed`, 'fi-rr-rotate-right', 'm-btn--primary', () => void run('Retry', () => client.rerun())));
      }
      buttons.push(btn('Report', 'fi-rr-document', '', () => void openReport()));
    } else {
      buttons.push(btn(state.status === 'created' ? 'Start board' : 'Resume', 'fi-rr-play', 'm-btn--primary', () => void run('Start', () => client.start())));
    }
    controls.replaceChildren(...buttons);
    controls.hidden = buttons.length === 0;
  }

  function renderAll(): void {
    const state = client.getState();
    if (!state) return;
    renderHeader(state);
    renderErrors();
    renderTasks();
    renderControls(state);
    openTaskSheet?.render();
    const running = [...state.tasks.values()].some((task) => runningAttempt(task));
    if (running && !clock) clock = window.setInterval(tickClocks, 1_000);
    if (!running && clock) {
      window.clearInterval(clock);
      clock = 0;
    }
  }

  /** Rewrite running cards' activity lines without rebuilding the list. */
  function patchLiveLines(): void {
    const state = client.getState();
    if (!state) return;
    for (const card of list.querySelectorAll<HTMLElement>('.m-task[data-task-id]')) {
      const task = state.tasks.get(card.dataset.taskId ?? '');
      const attempt = task ? runningAttempt(task) : null;
      if (!task || !attempt) continue;
      const text = activityLine(client.getLiveActivity().get(task.id)) || `${roleLabel(attempt.role)} working…`;
      let line = card.querySelector<HTMLElement>('.m-task__detail');
      if (!line) {
        line = el('span', { className: 'm-task__detail is-live' });
        card.querySelector('.m-task__title')?.after(line);
      }
      if (line.textContent !== text) line.textContent = text;
    }
  }

  /** Move elapsed times in place; rebuilding cards every second would eat taps. */
  function tickClocks(): void {
    const now = Date.now();
    for (const node of list.querySelectorAll<HTMLElement>('.m-task__clock[data-started-at]')) {
      node.textContent = formatElapsed(now - Number(node.dataset.startedAt));
    }
  }

  // ── Task sheet ────────────────────────────────────────────────────────────

  function openTask(taskId: string): void {
    const content = el('div', { className: 'm-task-sheet' });
    const render = () => {
      const state = client.getState();
      const task = state?.tasks.get(taskId);
      if (!state || !task) {
        content.replaceChildren(emptyState({ glyph: 'fi-rr-cross-circle', title: 'This task is gone' }));
        return;
      }
      const phase = phaseText(state, task);
      const tone = needsAttention(task) ? 'bad' : PHASE_TONE[task.phase];
      const live = client.getLiveActivity().get(task.id);
      const sections: (HTMLElement | null)[] = [];
      sections.push(
        el(
          'div',
          { className: 'm-task-sheet__head' },
          el('span', { className: 'm-task__id', text: `${task.id} · Wave ${task.wave}` }),
          el('h3', { className: 'm-task-sheet__title', text: task.title }),
          el('div', { className: 'm-chip-row' },
            el('span', { className: `m-pill m-pill--${tone}`, text: phase }),
            task.mergedSha ? el('span', { className: 'm-chip m-chip--mono', text: task.mergedSha.slice(0, 7) }) : null,
            ...task.dependsOn.map((dep) => el('span', { className: 'm-chip', text: `after ${dep}` })),
          ),
          live && runningAttempt(task) ? el('p', { className: 'm-task__detail is-live', text: activityLine(live) }) : null,
        ),
      );
      if (task.abandonedReason) sections.push(el('div', { className: 'm-banner m-banner--bad' }, icon('fi-rr-triangle-warning', 16), el('span', { text: task.abandonedReason })));
      if (task.mergeConflicts?.length) {
        sections.push(el('div', { className: 'm-banner m-banner--warn' }, icon('fi-rr-code-merge', 16), el('span', { text: `Merge conflicts: ${task.mergeConflicts.join(', ')}` })));
      }
      if (task.mergeFailure) {
        sections.push(el('div', { className: 'm-banner m-banner--bad' }, icon('fi-rr-code-merge', 16), el('span', { text: task.mergeFailure.summary ?? task.mergeFailure.reason })));
      }

      // Actions, from the same menu the desktop card uses.
      const items = buildTaskCardMenuItems(state, task, actions, {
        selectedTaskId: taskId,
        pendingTaskIds: pending,
        liveActivity: client.getLiveActivity(),
      }).filter((item): item is MenuActionItem => !item.kind || item.kind === 'action');
      if (items.length) {
        sections.push(
          el(
            'div',
            { className: 'm-task-sheet__actions' },
            ...items.map((item) =>
              el(
                'button',
                {
                  className: `m-btn${item.danger ? ' m-btn--danger-ghost' : ''}`,
                  attrs: { type: 'button', disabled: Boolean(item.disabled), title: item.hint ?? null },
                  on: { click: () => item.onSelect?.() },
                },
                el('span', { text: item.label }),
              ),
            ),
          ),
        );
      }

      sections.push(
        el(
          'button',
          {
            className: 'm-row-link',
            attrs: { type: 'button' },
            on: { click: () => { openTaskSheet?.sheet.close(); pushScreen(createTaskFilesScreen(boardId, task)); } },
          },
          icon('fi-rr-document', 16),
          el('span', { text: 'Changed files' }),
          icon('fi-rr-angle-small-right', 18),
        ),
      );

      const attempts = task.attempts.filter((attempt) => attempt.role !== 'merge');
      if (attempts.length) {
        const rows = attempts
          .slice()
          .reverse()
          .map((attempt) => {
            const tone2 = attempt.ended ? (OUTCOME_TONE[attempt.outcome ?? ''] ?? 'neutral') : 'live';
            const started = client.getAttemptStartedAt().get(attempt.attemptId);
            const ended = client.getAttemptEndedAt().get(attempt.attemptId);
            const duration = started ? formatElapsed((ended ?? Date.now()) - started) : '';
            return el(
              'button',
              {
                className: 'm-attempt',
                attrs: { type: 'button' },
                on: { click: () => { openTaskSheet?.sheet.close(); pushScreen(createAttemptScreen(boardId, task, attempt)); } },
              },
              el(
                'span',
                { className: 'm-attempt__top' },
                el('span', { className: 'm-attempt__role', text: roleLabel(attempt.role) }),
                el('span', { className: `m-pill m-pill--${tone2}`, text: attempt.ended ? outcomeText(attempt.outcome) : 'Running' }),
                duration ? el('span', { className: 'm-attempt__time', text: duration }) : null,
                icon('fi-rr-angle-small-right', 16),
              ),
              attempt.summary ? el('span', { className: 'm-attempt__summary', text: attempt.summary }) : null,
            );
          });
        sections.push(el('h4', { className: 'm-section-label', text: 'Runs' }), el('div', { className: 'm-attempts' }, ...rows));
      }

      const spec = (label: string, text: string | null) =>
        text?.trim()
          ? el('details', { className: 'm-spec', attrs: { open: label === 'Build' } }, el('summary', { text: label }), markdownBlock(text))
          : null;
      sections.push(el('h4', { className: 'm-section-label', text: 'Spec' }));
      sections.push(spec('Build', task.buildSpec), spec('Test', task.testSpec), spec('Accept', task.accept));
      if (task.touches.length) {
        sections.push(
          el('details', { className: 'm-spec' }, el('summary', { text: `Touches (${task.touches.length})` }),
            el('ul', { className: 'm-touches' }, ...task.touches.map((glob) => el('li', { text: glob }))),
          ),
        );
      }
      const scroll = openTaskSheet?.sheet.body.scrollTop ?? 0;
      content.replaceChildren(...sections.filter((node): node is HTMLElement => Boolean(node)));
      if (openTaskSheet) openTaskSheet.sheet.body.scrollTop = scroll;
    };
    render();
    const sheet = openSheet(content, {
      tall: true,
      onClose: () => {
        if (openTaskSheet?.taskId === taskId) openTaskSheet = null;
      },
    });
    openTaskSheet = { taskId, sheet, render };
  }

  // ── Board menu ────────────────────────────────────────────────────────────

  async function openReport(): Promise<void> {
    const content = el('div', { className: 'm-report' }, el('div', { className: 'm-skeleton' }));
    openSheet(content, { title: 'Report', tall: true });
    try {
      const { markdown } = await readBoardReport(boardId);
      content.replaceChildren(markdown.trim() ? markdownBlock(markdown) : emptyState({ glyph: 'fi-rr-document', title: 'No report yet' }));
    } catch (error) {
      content.replaceChildren(emptyState({ glyph: 'fi-rr-cloud-disabled', title: 'Could not load the report', body: errorText(error) }));
    }
  }

  function openBoardMenu(): void {
    const state = client.getState();
    if (!state) return;
    openActionSheet(state.name || 'Board', [
      {
        label: `Agents at a time: ${state.concurrency}`,
        glyph: 'fi-rr-users',
        run: async () => {
          const next = await pickFromSheet(
            'Agents at a time',
            [1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: String(n), selected: n === state.concurrency })),
          );
          if (next != null && next !== state.concurrency) await run('Concurrency', () => client.setConcurrency(next));
        },
      },
      {
        label: 'Rename',
        glyph: 'fi-rr-pencil',
        run: async () => {
          const name = await promptSheet({ title: 'Rename board', value: state.name, confirmLabel: 'Rename' });
          if (name) await run('Rename', () => client.rename(name));
        },
      },
      { label: 'Report', glyph: 'fi-rr-document', run: () => openReport() },
    ]);
  }

  // Live frames arrive per token; coalesce them to one card repaint per frame.
  let liveFrame = 0;
  const unsubs = [
    client.subscribe(() => {
      for (const node of body.querySelectorAll(':scope > .m-skeleton')) node.remove();
      renderAll();
    }),
    client.subscribeLive(() => {
      if (liveFrame) return;
      liveFrame = requestAnimationFrame(() => {
        liveFrame = 0;
        patchLiveLines();
        // The sheet holds buttons; rewrite only its activity line.
        const line = openTaskSheet?.sheet.body.querySelector<HTMLElement>('.m-task-sheet__head .is-live');
        const activity = openTaskSheet ? client.getLiveActivity().get(openTaskSheet.taskId) : undefined;
        if (line && activity) line.textContent = activityLine(activity);
      });
    }),
  ];

  return {
    key: `board:${boardId}`,
    el: root,
    onShow() {
      client.connect();
      renderAll();
    },
    onHide() {
      window.clearInterval(clock);
      clock = 0;
    },
    dispose() {
      for (const unsub of unsubs) unsub();
      window.clearInterval(clock);
      cancelAnimationFrame(liveFrame);
      openTaskSheet?.sheet.close();
      client.close();
    },
  };
}
