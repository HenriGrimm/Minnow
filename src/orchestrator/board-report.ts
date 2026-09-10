import type { Attempt, BoardState, TaskState } from '../../server/orchestrator/core/types';
import { gitCommit, gitPush } from '../state/git-api.ts';
import {
  cleanupBoardWorktrees,
  mergeIntegrationIntoWorkspace,
  openWorkspacePr,
  workspaceLandingStats,
} from '../state/worktree-service.ts';
import { attachBoardFollowUpChip } from '../attachments/board-ref.ts';
import { refreshFileTreeViaBridge } from '../ui/file-tree-refresh-bridge.ts';
import { createChatWithMode } from '../ui/sidebar.ts';
import { countPhase, renderRunLedger } from './board-render';
import { el } from './dom';
import {
  clearAttemptReportUiForTests,
  renderBlockerList,
  renderCollapsedWriteUp,
} from './attempt-report';
import { collectAttemptFacts, humanizeAbandonReason } from './attempt-scan';
import {
  clearReportFilesForTests,
  loadMergedTaskFiles,
  onTaskFilesProgress,
  renderDiffStat,
  renderFileTable,
  taskFileSet,
  taskFilesPending,
} from './report-files';
import { reportBadge, reportDisclosure } from './report-evidence';
import { renderRunNotesMarkdown } from './report-notes';

/** Cap the report excerpt so the chip stays within typical text-attachment size. */
const FOLLOW_UP_REPORT_MAX_CHARS = 4000;

// ── Predicates ───────────────────────────────────────────────────────────────

/** Same formula as server/orchestrator/worktree-lifecycle.js — keep them aligned. */
export function integrationBranchName(boardId: string): string {
  return `minnow/board/${boardId}/integration`;
}

export function wantsReportScreen(state: BoardState): boolean {
  if (state.finished) return true;
  if (state.status !== 'stopped') return false;
  return state.stopReason === 'user' || state.stopReason === 'quota';
}

export function canReopenFailed(state: BoardState): boolean {
  for (const task of state.tasks.values()) {
    if (task.phase === 'abandoned' || task.phase === 'skipped') return true;
  }
  return state.finalTest?.outcome === 'fail';
}

export function canFixFinal(state: BoardState): boolean {
  return state.finalTest?.outcome === 'fail';
}

export interface BoardReportActions {
  dismiss: () => void;
  reopen: () => void;
  fixFinal: () => void;
  /** Wipe one unfinished task back to Planned. Merged cards are never offered it. */
  resetTask: (taskId: string) => void;
}

interface GitLanding {
  loading: boolean;
  filesTouched: number | null;
  additions: number | null;
  deletions: number | null;
  hasRemote: boolean;
  hasGh: boolean;
  alreadyLanded: boolean;
  error?: string;
}

type CommitAction = 'commit-only' | 'commit-push' | 'commit-push-pr';

const gitByBoard = new Map<string, GitLanding>();
const landedByBoard = new Set<string>();
const clearedByBoard = new Set<string>();

export function clearBoardReportStateForTests(): void {
  gitByBoard.clear();
  landedByBoard.clear();
  clearedByBoard.clear();
  clearAttemptReportUiForTests();
  clearReportFilesForTests();
}

// -- Report -------------------------------------------------------------------

export function renderBoardReport(
  state: BoardState,
  markdown: string | null,
  loading: boolean,
  actions: BoardReportActions,
): HTMLElement {
  const wrap = el('section', 'ov2-report-screen');
  wrap.setAttribute('aria-label', 'Run report');

  wrap.appendChild(renderHeader(state, markdown, actions));

  const status = el('p', 'ov2-report-screen__git-status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  wrap.appendChild(status);

  wrap.appendChild(renderStats(state));

  const attention = renderAttention(state, actions);
  if (attention) wrap.appendChild(attention);

  wrap.appendChild(renderTasksSection(state));
  wrap.appendChild(renderReferenceSection(state, markdown, loading, actions));

  void hydrateGitStats(wrap, state);
  void hydrateTaskFiles(wrap, state);
  return wrap;
}

// -- Header -------------------------------------------------------------------

function renderHeader(
  state: BoardState,
  markdown: string | null,
  actions: BoardReportActions,
): HTMLElement {
  const bar = el('header', 'ov2-report-screen__bar');
  const copy = el('div', 'ov2-report-screen__copy');
  copy.appendChild(el('p', 'ov2-report-screen__eyebrow', state.name || state.boardId));
  copy.appendChild(el('h3', 'ov2-report-screen__title', titleFor(state)));
  copy.appendChild(
    el('p', 'ov2-report-screen__lede', state.runSummary?.trim() || ledeFor(state)),
  );
  bar.appendChild(copy);
  bar.appendChild(renderActions(state, markdown, actions));
  return bar;
}

function titleFor(state: BoardState): string {
  if (state.stopReason === 'quota') return 'Out of usage';
  if (state.finalTest?.outcome === 'fail') return 'Board blocked';
  if (state.finished || state.stopReason === 'complete') return 'Board complete';
  return 'Board stopped';
}

function ledeFor(state: BoardState): string {
  if (state.stopReason === 'quota') {
    return 'The model provider stopped accepting requests because its usage allowance is spent. ' +
      'The remaining tasks were not attempted — reopen the board once usage resets.';
  }
  if (state.finalTest?.outcome === 'fail') return 'Tasks merged, but the integration check failed.';
  if (state.finished || state.stopReason === 'complete') return 'Every task reached a decision.';
  return 'Stopped before it finished. This is what the journal recorded.';
}

// -- Stats --------------------------------------------------------------------

type StatTone = 'neutral' | 'good' | 'warn' | 'bad';

function statTile(
  value: string,
  label: string,
  tone: StatTone = 'neutral',
  fill?: (node: HTMLElement) => void,
): HTMLElement {
  const tile = el('div', 'ov2-stat-tile');
  tile.dataset.tone = tone;
  const slot = el('span', 'ov2-stat-tile__value');
  if (fill) fill(slot);
  else slot.textContent = value;
  tile.appendChild(slot);
  tile.appendChild(el('span', 'ov2-stat-tile__label', label));
  return tile;
}

/** The handful of numbers that answer "what happened" without opening anything. */
function renderStats(state: BoardState): HTMLElement {
  const row = el('div', 'ov2-report-screen__stats');
  row.setAttribute('aria-label', 'Run stats');
  const merged = countPhase(state, 'merged');
  const abandoned = countPhase(state, 'abandoned');
  const skipped = countPhase(state, 'skipped');
  const runs = totalAttempts(state);
  const git = gitByBoard.get(state.boardId);

  row.appendChild(statTile(String(merged), 'merged', merged > 0 ? 'good' : 'neutral'));
  if (abandoned > 0) row.appendChild(statTile(String(abandoned), 'abandoned', 'warn'));
  if (skipped > 0) row.appendChild(statTile(String(skipped), 'skipped', 'warn'));
  row.appendChild(statTile(String(runs), runs === 1 ? 'run' : 'runs'));

  if (git?.loading) {
    row.appendChild(statTile('...', 'files'));
  } else if (git && git.filesTouched != null) {
    row.appendChild(statTile(String(git.filesTouched), 'files'));
    if (git.additions != null && git.deletions != null) {
      const additions = git.additions;
      const deletions = git.deletions;
      row.appendChild(
        statTile('', 'lines', 'neutral', (slot) => {
          slot.appendChild(el('span', 'ov2-stat ov2-stat--add', `+${additions}`));
          slot.appendChild(el('span', 'ov2-stat ov2-stat--del', `−${deletions}`));
        }),
      );
    }
  }

  const final = state.finalTest?.outcome;
  row.appendChild(
    statTile(
      final === 'pass' ? 'Pass' : final === 'fail' ? 'Fail' : '—',
      'integration',
      final === 'pass' ? 'good' : final === 'fail' ? 'bad' : 'neutral',
    ),
  );
  return row;
}

// -- Needs attention ----------------------------------------------------------

/** The most recent blocker any attempt journaled. */
function lastBlocker(task: TaskState): string | null {
  for (let i = task.attempts.length - 1; i >= 0; i -= 1) {
    const [first] = collectAttemptFacts(task.attempts[i].evidence).blockers;
    if (first) return first;
  }
  return null;
}

/** Why this card is on the list, in the fewest lines that stay actionable. */
function attentionIssues(task: TaskState): string[] {
  const lines: string[] = [];
  if (task.skippedBy) lines.push(`Waiting on ${task.skippedBy}, which did not finish.`);
  else if (task.abandonedReason) lines.push(humanizeAbandonReason(task.abandonedReason));
  if (task.mergeConflicts?.length) {
    lines.push(`Merge conflicts in ${[...new Set(task.mergeConflicts)].join(', ')}`);
  }
  const blocker = lastBlocker(task);
  if (blocker && !lines.includes(blocker)) lines.push(blocker);
  return lines.length ? lines : ['This task did not finish.'];
}

function renderAttention(state: BoardState, actions: BoardReportActions): HTMLElement | null {
  const rows: HTMLElement[] = [];
  if (state.finalTest?.outcome === 'fail') rows.push(renderFinalRow(state, actions));
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (!task) continue;
    if (task.phase !== 'abandoned' && task.phase !== 'skipped') continue;
    rows.push(renderAttentionRow(task, actions));
  }
  if (!rows.length) return null;

  const section = el('section', 'ov2-report-screen__group ov2-report-screen__group--attention');
  section.appendChild(sectionTitle('Needs attention', rows.length));
  const list = el('ul', 'ov2-attention');
  for (const row of rows) list.appendChild(row);
  section.appendChild(list);
  return section;
}

function renderAttentionRow(task: TaskState, actions: BoardReportActions): HTMLElement {
  const row = el('li', 'ov2-attention__row');
  row.dataset.taskId = task.id;
  row.appendChild(el('span', 'ov2-attention__id', task.id));

  const main = el('div', 'ov2-attention__main');
  main.appendChild(el('span', 'ov2-attention__title', task.title));
  for (const line of attentionIssues(task)) {
    main.appendChild(el('p', 'ov2-attention__issue', line));
  }
  row.appendChild(main);
  row.appendChild(reportBadge(task.phase));

  const reset = btn('ov2-attention__action board-btn board-btn--compact', 'Reset task');
  reset.title =
    `Reset ${task.id}: delete its attempts, transcript, worktree, and branch, ` +
    'and return the card to Planned. Integration is not changed.';
  reset.addEventListener('click', () => actions.resetTask(task.id));
  row.appendChild(reset);
  return row;
}

function renderFinalRow(state: BoardState, actions: BoardReportActions): HTMLElement {
  const row = el('li', 'ov2-attention__row ov2-attention__row--final');
  row.appendChild(el('span', 'ov2-attention__id', 'Final'));

  const main = el('div', 'ov2-attention__main');
  main.appendChild(el('span', 'ov2-attention__title', 'Integration check'));
  main.appendChild(el('p', 'ov2-attention__issue', finalFailText(state)));
  if (state.finalTest?.runInstructions) {
    const run = el('p', 'ov2-attention__run');
    run.appendChild(el('code', 'ov2-report-screen__run-cmd', state.finalTest.runInstructions));
    main.appendChild(run);
  }
  row.appendChild(main);
  row.appendChild(reportBadge('fail'));

  const fix = btn('ov2-attention__action board-btn board-btn--compact', 'Fix and re-verify');
  fix.title = 'Add a fix task and run the integration check again';
  fix.addEventListener('click', () => actions.fixFinal());
  row.appendChild(fix);
  return row;
}

function finalFailText(state: BoardState): string {
  const evidence = state.finalTest?.evidence;
  const summary =
    evidence &&
    typeof evidence === 'object' &&
    typeof (evidence as { summary?: unknown }).summary === 'string'
      ? String((evidence as { summary: string }).summary).trim()
      : '';
  return summary || 'The final integration test failed.';
}

// -- Tasks --------------------------------------------------------------------

function sectionTitle(text: string, count: number): HTMLElement {
  const heading = el('h4', 'ov2-report-screen__section-title', text);
  heading.appendChild(el('span', 'ov2-report-screen__count', String(count)));
  return heading;
}

/** Native <details> so several rows can stay open without a modal or accordion. */
function makeReportCard(options: {
  className?: string;
  open?: boolean;
  /** Mount the body now (open cards, or content that must stay in the DOM while closed). */
  eager?: boolean;
  fillHead: (head: HTMLElement) => void;
  body: () => HTMLElement;
}): HTMLDetailsElement {
  const card = el(
    'details',
    options.className ? `ov2-report-card ${options.className}` : 'ov2-report-card',
  );
  const head = el('summary', 'ov2-report-card__head');
  options.fillHead(head);
  const chevron = el('span', 'ov2-report-card__chevron');
  chevron.setAttribute('aria-hidden', 'true');
  head.appendChild(chevron);
  card.appendChild(head);

  const mount = (): void => {
    for (const child of card.children) {
      if (child.classList.contains('ov2-report-card__body')) return;
    }
    const body = options.body();
    body.classList.add('ov2-report-card__body');
    card.appendChild(body);
  };

  if (options.open) card.open = true;
  if (options.open || options.eager) mount();
  else {
    card.addEventListener('toggle', () => {
      if (card.open) mount();
    });
  }
  return card;
}

function renderTasksSection(state: BoardState): HTMLElement {
  const section = el('section', 'ov2-report-screen__group ov2-report-screen__group--tasks');
  section.appendChild(sectionTitle('Tasks', state.taskOrder.length));
  if (!state.taskOrder.length) {
    section.appendChild(el('p', 'ov2-report-screen__quiet', 'No tasks recorded for this run.'));
    return section;
  }
  const stack = el('div', 'ov2-report-screen__cards');
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (task) stack.appendChild(renderTaskCard(state.boardId, task));
  }
  section.appendChild(stack);
  return section;
}

/** One row per task: outcome, how many runs it took, and what it changed. */
function renderTaskCard(boardId: string, task: TaskState): HTMLDetailsElement {
  const card = makeReportCard({
    className: 'ov2-report-task',
    fillHead: (head) => {
      head.appendChild(el('span', 'ov2-report-card__id', task.id));
      head.appendChild(el('span', 'ov2-report-card__title ov2-report-task__title', task.title));
      head.appendChild(reportBadge(task.phase));
      const runs = task.attempts.length;
      head.appendChild(
        el('span', 'ov2-report-task__runs', `${runs} ${runs === 1 ? 'run' : 'runs'}`),
      );
      head.appendChild(
        renderDiffStat(taskFileSet(boardId, task), taskFilesPending(boardId, task)),
      );
    },
    body: () => renderTaskBody(boardId, task),
  });
  card.dataset.taskId = task.id;
  return card;
}

function renderTaskBody(boardId: string, task: TaskState): HTMLElement {
  const body = el('div', 'ov2-report-task__body');
  const runs = renderRuns(task);
  if (runs) body.appendChild(runs);

  const files = el('div', 'ov2-report-task__files');
  files.appendChild(el('h5', 'ov2-report-task__subhead', 'Files'));
  files.appendChild(renderFileTable(taskFileSet(boardId, task), taskFilesPending(boardId, task)));
  body.appendChild(files);

  if (task.mergedSha) {
    body.appendChild(
      el('p', 'ov2-report-screen__quiet', `Merged as ${task.mergedSha.slice(0, 12)}`),
    );
  }
  return body;
}

function renderRuns(task: TaskState): HTMLElement | null {
  if (!task.attempts.length) return null;
  const wrap = el('div', 'ov2-report-task__runs-block');
  wrap.appendChild(el('h5', 'ov2-report-task__subhead', 'Runs'));
  const list = el('ol', 'ov2-runs');
  task.attempts.forEach((attempt, index) => list.appendChild(renderRun(attempt, index + 1)));
  wrap.appendChild(list);
  return wrap;
}

function testOutputOf(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const value = (evidence as { testOutput?: unknown }).testOutput;
  return typeof value === 'string' && value.trim() ? value : null;
}

/** One attempt: what it was, how it ended, and the one line that explains it. */
function renderRun(attempt: Attempt, n: number): HTMLElement {
  const item = el('li', 'ov2-run');
  const head = el('div', 'ov2-run__head');
  head.appendChild(el('span', 'ov2-run__n', String(n)));
  head.appendChild(
    el('span', 'ov2-run__role', attempt.role.charAt(0).toUpperCase() + attempt.role.slice(1)),
  );
  head.appendChild(reportBadge(attempt.outcome || (attempt.ended ? 'ended' : 'in progress')));
  if (attempt.retired) head.appendChild(el('span', 'ov2-run__tag', 'Previous run'));
  item.appendChild(head);

  const facts = collectAttemptFacts(attempt.evidence);
  const blockers = renderBlockerList(facts.blockers);
  if (blockers) item.appendChild(blockers);
  if (facts.needs.length) {
    item.appendChild(el('p', 'ov2-run__needs', `Needs ${facts.needs.join(', ')}`));
  }
  if (attempt.summary) {
    item.appendChild(
      renderCollapsedWriteUp(attempt.summary, { key: `report:${attempt.attemptId}` }),
    );
  }
  const output = testOutputOf(attempt.evidence);
  if (output) {
    item.appendChild(
      reportDisclosure('View test output', () => {
        const pre = el('pre', 'ov2-report-evidence__log', output);
        pre.tabIndex = 0;
        return pre;
      }),
    );
  }
  return item;
}

// -- Reference ----------------------------------------------------------------

/** The model's prose and the raw journal, both closed. Neither is the headline. */
function renderReferenceSection(
  state: BoardState,
  markdown: string | null,
  loading: boolean,
  actions: BoardReportActions,
): HTMLElement {
  const section = el('section', 'ov2-report-screen__group ov2-report-screen__group--reference');
  const stack = el('div', 'ov2-report-screen__cards');
  stack.appendChild(renderNotesCard(markdown, loading));
  const ledger = renderRunLedger(state, { rerun: () => actions.reopen() });
  if (ledger) stack.appendChild(renderJournalCard(ledger));
  section.appendChild(stack);
  return section;
}

function renderNotesCard(markdown: string | null, loading: boolean): HTMLDetailsElement {
  return makeReportCard({
    className: 'ov2-report-notes',
    open: false,
    eager: true,
    fillHead: (head) => {
      head.appendChild(el('span', 'ov2-report-card__title', 'Run notes'));
      if (loading && !markdown) {
        head.appendChild(el('span', 'ov2-report-card__meta ov2-report-screen__pending', 'Writing...'));
      } else if (!markdown) {
        head.appendChild(el('span', 'ov2-report-card__meta', 'None yet'));
      }
    },
    body: () => renderNotesBody(markdown, loading),
  });
}

function renderNotesBody(markdown: string | null, loading: boolean): HTMLElement {
  const body = el('div', 'ov2-report-screen__markdown');
  if (loading && !markdown) {
    body.appendChild(el('p', 'ov2-report-screen__pending', 'Writing the end-of-run report...'));
    return body;
  }
  if (!markdown) {
    body.appendChild(el('p', 'ov2-report-screen__quiet', 'No report yet.'));
    return body;
  }
  body.appendChild(renderRunNotesMarkdown(markdown));
  return body;
}

function renderJournalCard(ledger: HTMLElement): HTMLDetailsElement {
  ledger.classList.add('ov2-report-screen__ledger');
  return makeReportCard({
    className: 'ov2-report-journal',
    open: false,
    eager: true,
    fillHead: (head) => {
      head.appendChild(el('span', 'ov2-report-card__title', 'What the journal says'));
    },
    body: () => ledger,
  });
}

// -- Actions ------------------------------------------------------------------

/** The four things you can do with a finished board, in the header bar. */
function renderActions(
  state: BoardState,
  markdown: string | null,
  actions: BoardReportActions,
): HTMLElement {
  const row = el('div', 'ov2-report-screen__actions');

  const back = btn('ov2-report-screen__btn board-btn board-btn--compact', 'Back to board');
  back.addEventListener('click', () => actions.dismiss());
  row.appendChild(back);

  if (canReopenFailed(state)) {
    const nAbandoned = [...state.tasks.values()].filter(
      (task) => task.phase === 'abandoned' || task.phase === 'skipped',
    ).length;
    const rerun = btn(
      'ov2-report-screen__btn board-btn board-btn--compact',
      nAbandoned > 0
        ? `Rerun ${nAbandoned} failed task${nAbandoned === 1 ? '' : 's'}`
        : 'Add a fix task and re-verify',
    );
    rerun.title = 'Reopen failed work and start the board again';
    rerun.addEventListener('click', () => {
      rerun.disabled = true;
      actions.reopen();
    });
    row.appendChild(rerun);
  }

  const follow = btn('ov2-report-screen__btn board-btn board-btn--compact', 'Start follow-up chat');
  follow.addEventListener('click', () => {
    void startFollowUp(state, markdown);
  });
  row.appendChild(follow);

  row.appendChild(buildGitAction(state, markdown));
  return row;
}

function btn(className: string, label: string): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

/**
 * Plain-text board snapshot for the follow-up chip (injected on send).
 * Includes every task and its phase; omits the old auto-send review prompt.
 */
export function buildBoardFollowUpContext(
  state: BoardState,
  markdown: string | null,
): string {
  const taskLines: string[] = [];
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (!task) continue;
    taskLines.push(`- ${task.id} [${task.phase}]: ${task.title}`);
  }
  const report =
    markdown && markdown.trim()
      ? 'End-of-run report:\n\n' + markdown.slice(0, FOLLOW_UP_REPORT_MAX_CHARS)
      : '';
  return [
    'Follow-up on a completed Orchestrate board.',
    '',
    `Board: ${state.name || state.boardId}`,
    `Board id: ${state.boardId}`,
    `Plan: ${state.planPath || '(none)'}`,
    `Integration branch: ${integrationBranchName(state.boardId)}`,
    state.runSummary ? `Summary: ${state.runSummary}` : '',
    '',
    'Tasks:',
    taskLines.join('\n') || '(none)',
    '',
    report,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Leave the V2 Boards overlay, open an empty General Code chat, and attach
 * board context as a file-style chip. Does not queue or send a user message.
 */
export async function startFollowUp(
  state: BoardState,
  markdown: string | null,
): Promise<void> {
  const title = (state.name || state.boardId).trim() || state.boardId;
  const text = buildBoardFollowUpContext(state, markdown);
  const { closeBoardsView } = await import('./boards-view.ts');
  await closeBoardsView({ restoreChat: false });
  createChatWithMode({ modeId: 'general' });
  attachBoardFollowUpChip({ name: title, text });
}

// ── Git ──────────────────────────────────────────────────────────────────────

function buildGitAction(state: BoardState, markdown: string | null): HTMLElement {
  if (clearedByBoard.has(state.boardId)) {
    const done = el('span', 'ov2-report-screen__git-done', 'Worktrees cleared');
    done.dataset.boardGitAction = 'cleared';
    return done;
  }
  if (landedByBoard.has(state.boardId)) {
    return buildClearWorktrees(state);
  }
  return buildCommitSplit(state, markdown);
}

function buildClearWorktrees(state: BoardState): HTMLElement {
  const clearBtn = btn(
    'ov2-report-screen__btn board-btn board-btn--primary',
    'Clear worktrees',
  );
  clearBtn.dataset.boardGitAction = 'clear';
  clearBtn.title = 'Remove all git worktrees created for this board';
  let busy = false;
  clearBtn.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    clearBtn.disabled = true;
    const status = clearBtn.closest('.ov2-report-screen')?.querySelector('.ov2-report-screen__git-status');
    setGitStatus(status, 'Removing board worktrees…', 'info');
    void cleanupBoardWorktrees({ boardId: state.boardId, includeIntegration: true }).then((res) => {
      busy = false;
      if (!res.ok) {
        clearBtn.disabled = false;
        setGitStatus(status, res.error || 'Failed to clear worktrees', 'err');
        return;
      }
      clearedByBoard.add(state.boardId);
      clearBtn.replaceWith(el('span', 'ov2-report-screen__git-done', 'Worktrees cleared'));
      const removed = res.removed ?? 0;
      setGitStatus(
        status,
        removed > 0
          ? `Removed ${removed} worktree${removed === 1 ? '' : 's'}.`
          : 'Board worktrees cleared.',
        'ok',
      );
    });
  });
  return clearBtn;
}

function buildCommitSplit(state: BoardState, markdown: string | null): HTMLElement {
  const wrap = el('div', 'ov2-report-screen__commit');
  wrap.dataset.boardGitAction = 'commit';
  const git = gitByBoard.get(state.boardId);

  const primary = btn(
    'ov2-report-screen__btn board-btn board-btn--primary ov2-report-screen__commit-primary',
    'Commit',
  );
  const caret = btn('ov2-report-screen__commit-caret', '');
  caret.setAttribute('aria-label', 'More commit options');
  caret.setAttribute('aria-haspopup', 'menu');
  caret.setAttribute('aria-expanded', 'false');
  caret.textContent = '▾';

  let openMenu: HTMLElement | null = null;

  const closeMenu = (): void => {
    openMenu?.remove();
    openMenu = null;
    caret.setAttribute('aria-expanded', 'false');
  };

  const kick = (action: CommitAction): void => {
    closeMenu();
    primary.disabled = true;
    caret.disabled = true;
    void runCommitChain(state, markdown, action, wrap, () => {
      primary.disabled = false;
      caret.disabled = false;
    });
  };

  primary.addEventListener('click', () => kick('commit-push-pr'));

  caret.addEventListener('click', (event) => {
    event.stopPropagation();
    if (openMenu) {
      closeMenu();
      return;
    }
    const menu = el('div', 'ov2-report-screen__commit-menu');
    menu.setAttribute('role', 'menu');
    const items: Array<{ action: CommitAction; label: string; disabled?: boolean }> = [
      { action: 'commit-only', label: 'Commit only' },
      { action: 'commit-push', label: 'Commit and push', disabled: git?.hasRemote === false },
      {
        action: 'commit-push-pr',
        label: 'Commit, push, and open PR',
        disabled: git?.hasRemote === false || git?.hasGh === false,
      },
    ];
    for (const item of items) {
      const itemBtn = btn('ov2-report-screen__commit-menuitem', item.label);
      itemBtn.setAttribute('role', 'menuitem');
      itemBtn.disabled = item.disabled === true || git?.loading === true;
      itemBtn.addEventListener('click', () => kick(item.action));
      menu.appendChild(itemBtn);
    }
    wrap.appendChild(menu);
    openMenu = menu;
    caret.setAttribute('aria-expanded', 'true');
    const dismiss = (ev: MouseEvent): void => {
      if (wrap.contains(ev.target as Node)) return;
      closeMenu();
      document.removeEventListener('mousedown', dismiss);
    };
    document.addEventListener('mousedown', dismiss);
  });

  wrap.appendChild(primary);
  wrap.appendChild(caret);
  return wrap;
}

async function runCommitChain(
  state: BoardState,
  markdown: string | null,
  action: CommitAction,
  wrap: HTMLElement,
  done: () => void,
): Promise<void> {
  const status = wrap.closest('.ov2-report-screen')?.querySelector('.ov2-report-screen__git-status');
  const git = gitByBoard.get(state.boardId);
  const branch = integrationBranchName(state.boardId);
  const planName = state.planPath.split('/').pop()?.replace(/\.md$/i, '') || state.name || 'board';
  const commitMsg = `feat: ${planName} (orchestrate board ${state.boardId})`;

  const primary = wrap.querySelector<HTMLButtonElement>('.ov2-report-screen__commit-primary');
  const caret = wrap.querySelector<HTMLButtonElement>('.ov2-report-screen__commit-caret');
  if (primary) primary.disabled = true;
  if (caret) caret.disabled = true;

  try {
    setGitStatus(status, 'Merging integration branch into workspace…', 'info');
    const mergeRes = await mergeIntegrationIntoWorkspace({
      branch,
      message: `Merge ${branch}`,
    });
    if (!mergeRes.ok) {
      const detail = mergeRes.output || mergeRes.error || 'Merge failed';
      if (mergeRes.error === 'merge_conflict' || mergeRes.conflict) {
        setGitStatus(
          status,
          `Merge conflict — resolve in your workspace, then try again. ${detail}`,
          'err',
        );
      } else {
        setGitStatus(status, detail, 'err');
      }
      return;
    }
    const merged = mergeRes.merged === true;

    setGitStatus(status, 'Committing…', 'info');
    const commitRes = await gitCommit({ message: commitMsg });
    const commitClean =
      !commitRes.ok &&
      typeof commitRes.error === 'string' &&
      commitRes.error.includes('nothing to commit');
    if (!commitRes.ok && !commitClean) {
      setGitStatus(status, commitRes.error || 'Commit failed', 'err');
      return;
    }
    const hadNewCommit = commitRes.ok === true;

    if (action === 'commit-only') {
      setGitStatus(
        status,
        hadNewCommit
          ? 'Merged and committed to your current branch.'
          : merged
            ? 'Merged integration branch into your current branch.'
            : 'Integration branch already merged; workspace is clean.',
        hadNewCommit || merged ? 'ok' : 'info',
      );
      markLanded(state, wrap);
      return;
    }

    if (git?.hasRemote !== true) {
      setGitStatus(
        status,
        hadNewCommit || merged
          ? 'Committed locally. No origin remote — push skipped.'
          : 'No origin remote — push skipped.',
        'ok',
      );
      markLanded(state, wrap);
      return;
    }

    setGitStatus(status, 'Pushing current branch…', 'info');
    const pushRes = await gitPush({});
    if (!pushRes.ok) {
      setGitStatus(status, pushRes.error || pushRes.stdout || 'Push failed', 'err');
      markLanded(state, wrap);
      return;
    }

    if (action === 'commit-push') {
      setGitStatus(status, 'Merged and pushed your current branch.', 'ok');
      markLanded(state, wrap);
      return;
    }

    if (git?.hasGh !== true) {
      setGitStatus(status, 'Committed and pushed. GitHub CLI not available — PR skipped.', 'ok');
      markLanded(state, wrap);
      return;
    }

    setGitStatus(status, 'Opening pull request…', 'info');
    const prRes = await openWorkspacePr({
      title: commitMsg,
      body: markdown?.slice(0, 4000) || `Orchestrate board ${state.boardId}`,
    });
    if (!prRes.ok) {
      setGitStatus(
        status,
        `Committed and pushed. PR failed: ${prRes.output || prRes.error || 'unknown'}`,
        'err',
      );
    } else {
      const url = prRes.url ? ` ${prRes.url}` : '';
      setGitStatus(status, `Committed, pushed, and opened PR.${url}`, 'ok');
    }
    markLanded(state, wrap);
  } finally {
    done();
  }
}

function markLanded(state: BoardState, wrap: HTMLElement): void {
  landedByBoard.add(state.boardId);
  wrap.replaceWith(buildClearWorktrees(state));
  void refreshFileTreeViaBridge();
}

function setGitStatus(
  node: Element | null | undefined,
  text: string,
  kind: 'info' | 'ok' | 'err',
): void {
  if (!(node instanceof HTMLElement)) return;
  node.textContent = text;
  node.dataset.kind = kind;
  node.hidden = !text;
}

async function hydrateGitStats(root: HTMLElement, state: BoardState): Promise<void> {
  const existing = gitByBoard.get(state.boardId);
  if (existing && !existing.loading) {
    if (existing.alreadyLanded) landedByBoard.add(state.boardId);
    return;
  }
  gitByBoard.set(state.boardId, {
    loading: true,
    filesTouched: null,
    additions: null,
    deletions: null,
    hasRemote: false,
    hasGh: false,
    alreadyLanded: false,
  });
  try {
    const res = await workspaceLandingStats({ branch: integrationBranchName(state.boardId) });
    const next: GitLanding = {
      loading: false,
      filesTouched: typeof res.fileCount === 'number' ? res.fileCount : null,
      additions: typeof res.additions === 'number' ? res.additions : null,
      deletions: typeof res.deletions === 'number' ? res.deletions : null,
      hasRemote: res.hasRemote === true,
      hasGh: res.hasGh === true,
      alreadyLanded: res.alreadyLanded === true,
      error: res.ok ? undefined : res.error,
    };
    gitByBoard.set(state.boardId, next);
    if (next.alreadyLanded) landedByBoard.add(state.boardId);
    const stats = root.querySelector('.ov2-report-screen__stats');
    if (stats) stats.replaceWith(renderStats(state));
    const gitSlot = root.querySelector('[data-board-git-action]');
    if (gitSlot && next.alreadyLanded && gitSlot.getAttribute('data-board-git-action') === 'commit') {
      gitSlot.replaceWith(buildClearWorktrees(state));
    }
  } catch (err) {
    gitByBoard.set(state.boardId, {
      loading: false,
      filesTouched: null,
      additions: null,
      deletions: null,
      hasRemote: false,
      hasGh: false,
      alreadyLanded: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fill in per-file line counts for merged tasks once git answers. Rows render
 * from journaled paths first so the report is never blocked on a numstat.
 */
async function hydrateTaskFiles(root: HTMLElement, state: BoardState): Promise<void> {
  const tasks: TaskState[] = [];
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (task) tasks.push(task);
  }
  if (!tasks.some((task) => task.mergedSha != null)) return;
  // Subscribe before awaiting: this render may be joining a fetch already running.
  const stop = onTaskFilesProgress(state.boardId, () => {
    for (const task of tasks) patchTaskFiles(root, state.boardId, task);
  });
  try {
    await loadMergedTaskFiles(state.boardId, tasks);
  } finally {
    stop();
  }
}

function patchTaskFiles(root: HTMLElement, boardId: string, task: TaskState): void {
  for (const card of root.querySelectorAll<HTMLElement>('.ov2-report-task')) {
    if (card.dataset.taskId !== task.id) continue;
    const set = taskFileSet(boardId, task);
    const pending = taskFilesPending(boardId, task);
    card.querySelector('.ov2-report-card__head > .ov2-diffstat')
      ?.replaceWith(renderDiffStat(set, pending));
    card.querySelector('.ov2-report-task__files > .ov2-report-files-block')
      ?.replaceWith(renderFileTable(set, pending));
    return;
  }
}

function totalAttempts(state: BoardState): number {
  let n = 0;
  for (const task of state.tasks.values()) n += task.attempts.filter((a) => a.ended).length;
  return n;
}

