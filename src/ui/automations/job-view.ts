/**
 * One automation: its work queue, its runs, and the selected run painted with
 * the chat renderer — live while it works, from its saved transcript after.
 */

import {
  deleteSchedulerJob,
  fetchAutomationRun,
  fetchPrReviewQueue,
  fetchSchedulerRuns,
  fetchWatchedGithubIssues,
  retryPrReviewPull,
  retryWatchedGithubIssue,
  startAutomation,
  stopAutomationRun,
  updateSchedulerJob,
  type AutomationJob,
  type AutomationLiveRun,
  type AutomationLiveState,
  type AutomationRunDetail,
  type PrReviewQueue,
  type PrReviewRow,
  type SchedulerRun,
  type WatchedGithubIssue,
} from '../../scheduler/client';
import { formatSchedulerRunSummary, resolveSchedulerRunChatId } from '../../scheduler/run-summary';
import { PR_PASS_ACTIONS, presetCapabilities } from '../../lib/automation-presets.mjs';
import { formatModelLabel } from '../../lib/format-model-label';
import { appConfirm } from '../app-dialog';
import { createEmbeddedChatTranscript } from '../embedded-chat-transcript';
import { findChatById, loadSessionsFromStorage, sessionState } from '../../state/sessions';
import { setWorkspacePath } from '../../config/workspace-api';
import { confirmAndStopBoardsForWorkspaceSwitch, dismissBoardViewOutsideWorkspace } from '../workspace-switch-guard';
import { getWorkspacePath, setWorkspaceFromServer } from '../../state/workspace';
import { launchApp } from '../../os/router';
import { applyWorkspaceScopedSession, switchChat } from '../sidebar';
import type { Chat, Message } from '../../types';
import {
  button, chip, clockTime, displayPath, el, elapsedText, enter, icon, liveDot, runTone, statusWord, streamingText, untilText,
} from './dom';
import { jobIcon, jobSubtitle, presetFor, triggerText } from './app';

export interface JobViewHandle {
  root: HTMLElement;
  update(job: AutomationJob): void;
  dispose(): void;
}

interface JobViewOptions {
  job: AutomationJob;
  runId?: string;
  notify: (state: 'ok' | 'err', message: string) => void;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void | Promise<void>;
  onChanged: () => void;
}

const LIVE_POLL_MS = 1000;
const QUEUE_POLL_MS = 5000;

const PHASE_LABEL: Record<string, string> = {
  claimed: 'Claiming', reviewing: 'Reviewing', acting: 'Acting on the verdict',
  queued: 'Passed · in merge queue', merged: 'Passed · merged', approved: 'Passed · approved', commented: 'Passed · commented',
  changes_requested: 'Changes requested', skipped: 'Skipped', blocked: 'Needs attention',
};

function phaseTone(phase: string): 'ok' | 'fail' | 'skip' | 'warn' | 'run' {
  if (['queued', 'merged', 'approved', 'commented'].includes(phase)) return 'ok';
  if (phase === 'changes_requested') return 'fail';
  if (phase === 'blocked') return 'warn';
  if (phase === 'skipped') return 'skip';
  return 'run';
}

async function openRunChatInCode(chatId: string, notify: JobViewOptions['notify']): Promise<void> {
  try {
    await loadSessionsFromStorage({ force: true });
  } catch {
    notify('err', 'Could not reload chats from the server.');
    return;
  }
  const chat = findChatById(chatId);
  if (!chat) {
    notify('err', 'The chat for this run is not available yet.');
    return;
  }
  const chatWorkspace = chat.workspacePath?.trim();
  if (chatWorkspace && chatWorkspace !== getWorkspacePath()) {
    try {
      if (!await confirmAndStopBoardsForWorkspaceSwitch(chatWorkspace)) return;
      setWorkspaceFromServer(await setWorkspacePath(chatWorkspace));
      await dismissBoardViewOutsideWorkspace(chatWorkspace);
      await applyWorkspaceScopedSession(chatWorkspace);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
      return;
    }
  }
  launchApp('code');
  if (sessionState?.activeId !== chatId) await switchChat(chatId);
}

export function renderJobView(options: JobViewOptions): JobViewHandle {
  let job = options.job;
  const preset = presetFor(job);
  const engine = preset?.engine ?? 'prompt';
  let disposed = false;
  let runs: SchedulerRun[] = [];
  let queue: PrReviewQueue | null = null;
  let issues: WatchedGithubIssue[] = [];
  let selectedRunId: string | null = options.runId ?? job.live?.runId ?? null;
  let selectedChild: string | null = null;
  let detail: AutomationRunDetail | null = null;
  let childDetail: AutomationRunDetail | null = null;
  let showQuiet = false;
  let pickedByUser = Boolean(options.runId);
  let liveTimer: number | undefined;
  let queueTimer: number | undefined;
  let lastRunsKey = '';

  const root = el('div', 'auto-job');

  // ---------- top bar ----------
  const bar = el('header', 'auto-job__bar');
  const crumbs = el('nav', 'auto-crumbs');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const back = el('button', 'auto-crumbs__link', 'Automations');
  back.type = 'button';
  back.addEventListener('click', options.onBack);
  const title = el('h1', 'auto-crumbs__here');
  crumbs.append(back, el('span', 'auto-crumbs__sep', '/'), title);
  const repoChip = chip('', 'auto-chip--mono');
  const status = el('span', 'auto-job__status');
  const spacer = el('span', 'auto-spacer');
  const stats = el('span', 'auto-job__stats');
  stats.hidden = true;
  const runBtn = button('Run now', { icon: 'forward' });
  const pauseBtn = button('Pause', { icon: 'pause' });
  const editBtn = button('Edit', { variant: 'ghost' });
  const deleteBtn = button('', { variant: 'ghost', icon: 'trash', title: 'Delete automation' });
  bar.append(crumbs, repoChip, status, spacer, runBtn, pauseBtn, editBtn, deleteBtn);

  function recentSummary(): string {
    const settled = job.recentRuns.filter((run) => run.status !== 'running');
    if (!settled.length) return job.live ? 'First run in progress' : 'No runs yet';
    const done = settled.filter((run) => run.status === 'completed' && !run.quiet).length;
    const quiet = settled.filter((run) => run.quiet).length;
    const failed = settled.filter((run) => run.status === 'failed' || run.status === 'timeout').length;
    return [`${done} done`, quiet ? `${quiet} quiet` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ')
      + ` in the last ${settled.length}`;
  }

  runBtn.addEventListener('click', () => {
    void (async () => {
      runBtn.disabled = true;
      try {
        if (job.live) {
          await stopAutomationRun(job.live.runId);
          options.notify('ok', 'Stopping the run');
        } else {
          const result = await startAutomation(job.id);
          if (!result.started) options.notify('err', result.reason === 'concurrency_cap' ? 'Two automations are already running. This one starts when a slot frees up.' : 'It is already running.');
          else if (result.runId) selectRun(result.runId);
        }
        options.onChanged();
      } catch (error) {
        options.notify('err', error instanceof Error ? error.message : String(error));
      } finally {
        runBtn.disabled = false;
      }
    })();
  });
  pauseBtn.addEventListener('click', () => {
    void (async () => {
      try {
        await updateSchedulerJob(job.id, { enabled: !job.enabled });
        options.notify('ok', job.enabled ? `${job.label} is paused` : `${job.label} is on`);
        options.onChanged();
      } catch (error) {
        options.notify('err', error instanceof Error ? error.message : String(error));
      }
    })();
  });
  editBtn.addEventListener('click', options.onEdit);
  deleteBtn.addEventListener('click', () => {
    void (async () => {
      if (!await appConfirm(`Delete “${job.label}”? Its run history goes with it.`)) return;
      try {
        await deleteSchedulerJob(job.id);
        options.notify('ok', 'Automation deleted');
        await options.onDeleted();
      } catch (error) {
        options.notify('err', error instanceof Error ? error.message : String(error));
      }
    })();
  });

  // ---------- body ----------
  const body = el('div', 'auto-job__body');
  const list = el('aside', 'auto-job__list');
  list.setAttribute('aria-label', 'Work and runs');
  const center = el('section', 'auto-job__run');
  const rail = el('aside', 'auto-job__rail');
  body.append(list, center, rail);
  root.append(bar, body);

  const runHead = el('div', 'auto-runhead');
  const reviewers = el('div', 'auto-reviewers');
  reviewers.setAttribute('role', 'tablist');
  reviewers.setAttribute('aria-label', 'Reviewers');
  const scroller = el('div', 'auto-transcript');
  const transcriptMeta = el('div', 'auto-transcript__meta');
  const transcriptBody = el('div', 'auto-transcript__body chat-thread');
  const transcriptEmpty = el('div', 'auto-transcript__empty');
  scroller.append(transcriptMeta, transcriptBody, transcriptEmpty);
  const footer = el('div', 'auto-runfoot');
  center.append(runHead, reviewers, scroller, footer);
  const transcript = createEmbeddedChatTranscript(transcriptBody, scroller);
  let paintedChat: Chat | null = null;
  let paintedKey = '';

  // ---------- header state ----------
  function renderBar(): void {
    title.textContent = job.label;
    repoChip.textContent = jobSubtitle(job);
    const live = job.live;
    status.replaceChildren();
    if (live) {
      status.append(liveDot('run'), el('span', undefined, live.focus ? `${PHASE_LABEL[live.focus.phase ?? ''] ?? 'Working on'} #${live.focus.number}` : 'Running'));
      status.className = 'auto-job__status is-run';
    } else if (!job.enabled) {
      status.append(liveDot('idle'), el('span', undefined, 'Paused'));
      status.className = 'auto-job__status';
    } else {
      status.append(liveDot('ok'), el('span', undefined, job.schedule.kind === 'manual' ? 'Runs when you start it' : `Next ${untilText(job.nextRunAt) || 'soon'}`));
      status.className = 'auto-job__status';
    }
    stats.textContent = recentSummary();
    runBtn.replaceChildren(icon(live ? 'stop' : 'forward', 14), el('span', undefined, live ? 'Stop run' : 'Run now'));
    runBtn.classList.toggle('auto-btn--danger', Boolean(live));
    pauseBtn.replaceChildren(icon(job.enabled ? 'pause' : 'forward', 14), el('span', undefined, job.enabled ? 'Pause' : 'Resume'));
  }

  // ---------- left list ----------
  function listSection(label: string, count?: number): HTMLElement {
    const head = el('div', 'auto-list__head');
    head.append(el('span', undefined, label));
    if (count !== undefined) head.append(el('span', 'auto-mono', String(count)));
    list.append(head);
    return head;
  }

  function listItem(opts: { number?: string; title: string; sub?: string; tone?: string; selected?: boolean; onClick?: () => void; trailing?: HTMLElement }): HTMLElement {
    const item = el(opts.onClick ? 'button' : 'div', `auto-qi${opts.selected ? ' is-selected' : ''}`);
    if (item instanceof HTMLButtonElement) { item.type = 'button'; item.addEventListener('click', opts.onClick!); }
    if (opts.number) item.append(el('span', 'auto-qi__n', opts.number));
    const text = el('span', 'auto-qi__text');
    text.append(el('span', 'auto-qi__title', opts.title));
    if (opts.sub) text.append(el('span', `auto-qi__sub${opts.tone ? ` is-${opts.tone}` : ''}`, opts.sub));
    item.append(text);
    if (opts.trailing) item.append(opts.trailing);
    else if (opts.tone) item.append(liveDot(opts.tone as 'ok'));
    if (opts.selected) item.setAttribute('aria-current', 'true');
    return item;
  }

  function renderList(): void {
    list.replaceChildren();
    const live = job.live;
    if (engine === 'pr-review') {
      const handled = new Set((queue?.pulls ?? []).map((row) => `${row.number}:${row.headSha}`));
      const reviewing = live?.focus;
      listSection('Reviewing', reviewing ? 1 : 0);
      if (reviewing) {
        list.append(listItem({ number: `#${reviewing.number}`, title: reviewing.title, sub: `@${reviewing.author ?? ''} · ${live!.children.length ? `${live!.children.filter((c) => c.status === 'running').length} reviewers working` : PHASE_LABEL[reviewing.phase ?? ''] ?? 'Working'}`,
          tone: 'run', selected: selectedRunId === live!.runId, onClick: () => selectRun(live!.runId, null, true) }));
      } else {
        list.append(el('p', 'auto-list__none', 'Nothing in review.'));
      }
      const upNext = (queue?.queue ?? []).filter((p) => !handled.has(`${p.number}:${p.headSha}`) && p.number !== reviewing?.number);
      listSection('Up next', upNext.length);
      if (!upNext.length) list.append(el('p', 'auto-list__none', queue?.checkedAt ? `Checked ${clockTime(queue.checkedAt)}. Nothing waiting.` : 'Not checked yet.'));
      for (const p of upNext.slice(0, 8)) list.append(listItem({ number: `#${p.number}`, title: p.title, sub: `@${p.author} · opened ${clockTime(p.createdAt)}` }));
      const done = [...(queue?.pulls ?? [])].filter((row) => row.phase !== 'claimed' && row.phase !== 'reviewing' && row.phase !== 'acting').reverse().slice(0, 12);
      listSection('Done', done.length);
      for (const row of done) list.append(prRowItem(row));
    } else if (engine === 'github-watch') {
      listSection('Issues', issues.length);
      if (!issues.length) list.append(el('p', 'auto-list__none', 'No issues labeled minnow yet.'));
      for (const issue of issues.slice(0, 12)) {
        const tone = issue.phase === 'complete' ? 'ok' : issue.phase === 'blocked' ? 'warn' : 'run';
        const retry = issue.phase === 'blocked' ? button('Retry', { small: true, variant: 'ghost' }) : undefined;
        retry?.addEventListener('click', (event) => {
          event.stopPropagation();
          void retryWatchedGithubIssue(job.id, issue.number).then(() => { options.notify('ok', `Issue #${issue.number} will retry on the next poll`); void loadSideData(true); })
            .catch((error) => options.notify('err', error instanceof Error ? error.message : String(error)));
        });
        list.append(listItem({ number: `#${issue.number}`, title: issue.title,
          sub: issue.error ? issue.error : issue.prUrl ? `PR opened` : issue.phase, tone, trailing: retry,
          onClick: issue.prUrl ? () => window.open(issue.prUrl, '_blank', 'noopener') : undefined }));
      }
    }
    const visible = runs.filter((run) => showQuiet || !run.quiet || run.id === selectedRunId || run.status === 'running');
    const quietCount = runs.filter((run) => run.quiet).length;
    listSection('Runs', runs.length);
    if (!runs.length) list.append(el('p', 'auto-list__none', job.schedule.kind === 'manual' ? 'No runs yet. Press Run now.' : 'No runs yet.'));
    for (const run of visible) {
      const tone = runTone({ status: run.status, quiet: Boolean(run.quiet) });
      const summary = run.status === 'running' ? (job.live?.headline || job.live?.step || 'Running') : run.headline || formatSchedulerRunSummary(run, 90);
      const when = run.completedAt ? `${clockTime(run.startedAt)} · ${elapsedText(run.startedAt, run.completedAt)}` : clockTime(run.startedAt);
      list.append(listItem({ title: summary === '—' ? statusWord(run.status, run.quiet) : summary, sub: `${statusWord(run.status, run.quiet)} · ${when}${run.trigger === 'manual' ? ' · by you' : ''}`,
        tone: tone === 'idle' ? undefined : tone, selected: run.id === selectedRunId, onClick: () => selectRun(run.id, null, true) }));
    }
    if (quietCount) {
      const toggle = el('button', 'auto-list__toggle', showQuiet ? 'Hide quiet checks' : `${quietCount} quiet check${quietCount === 1 ? '' : 's'} had nothing to do`);
      toggle.type = 'button';
      toggle.addEventListener('click', () => { showQuiet = !showQuiet; renderList(); });
      list.append(toggle);
    }
  }

  function prRowItem(row: PrReviewRow): HTMLElement {
    const tone = phaseTone(row.phase);
    let trailing: HTMLElement | undefined;
    if (row.phase === 'blocked') {
      trailing = button('Retry', { small: true, variant: 'ghost' });
      trailing.addEventListener('click', (event) => {
        event.stopPropagation();
        void retryPrReviewPull(job.id, row.number).then(() => { options.notify('ok', `#${row.number} will be reviewed again on the next run`); void loadSideData(true); })
          .catch((error) => options.notify('err', error instanceof Error ? error.message : String(error)));
      });
    }
    const sub = row.phase === 'skipped' ? `Skipped · ${row.reason ?? ''}` : row.phase === 'blocked' ? (row.error ?? 'Needs attention') : PHASE_LABEL[row.phase] ?? row.phase;
    return listItem({ number: `#${row.number}`, title: row.title, sub, tone, trailing, selected: Boolean(row.runId && row.runId === selectedRunId),
      onClick: row.runId && runs.some((run) => run.id === row.runId) ? () => selectRun(row.runId!, null, true) : undefined });
  }

  // ---------- center ----------
  function selectRun(runId: string | null, child: string | null = null, byUser = false): void {
    if (byUser) pickedByUser = runId !== job.live?.runId;
    selectedRunId = runId;
    selectedChild = child;
    detail = null;
    childDetail = null;
    paintedKey = '';
    transcript.reset();
    paintedChat = null;
    renderList();
    void loadRun(true);
  }

  function defaultRunId(): string | null {
    if (job.live) return job.live.runId;
    return runs.find((run) => !run.quiet)?.id ?? runs[0]?.id ?? null;
  }

  async function loadRun(scroll = false): Promise<void> {
    if (liveTimer) { window.clearTimeout(liveTimer); liveTimer = undefined; }
    if (disposed) return;
    if (!selectedRunId) {
      selectedRunId = defaultRunId();
      if (!selectedRunId) { renderCenter(); return; }
      renderList();
    }
    const runId = selectedRunId;
    try {
      const next = await fetchAutomationRun(job.id, runId);
      if (disposed || runId !== selectedRunId) return;
      detail = next;
      const children = next.live?.children ?? next.transcript?.children ?? [];
      if (children.length) {
        if (!selectedChild || !children.some((c) => c.runId === selectedChild)) {
          selectedChild = (children.find((c) => c.status === 'running') ?? children[0]).runId;
        }
        if (next.live?.status === 'running') {
          const childRun = await fetchAutomationRun(job.id, selectedChild).catch(() => null);
          if (disposed || runId !== selectedRunId) return;
          childDetail = childRun;
        } else {
          childDetail = null;
        }
      }
    } catch (error) {
      detail = { run: runs.find((run) => run.id === runId) ?? null, live: null, transcript: null };
    }
    renderCenter(scroll);
    if (detail?.live?.status === 'running') liveTimer = window.setTimeout(() => { void loadRun(); }, LIVE_POLL_MS);
  }

  function chatFor(key: string, messages: Message[], label: string): Chat {
    if (!paintedChat || paintedKey !== key) {
      paintedChat = { id: `automation-${key}`, name: label, history: [], modeId: 'build', providerId: '', modelId: '', workspacePath: job.workspacePath ?? '' } as unknown as Chat;
      paintedKey = key;
    }
    const history = paintedChat.history as Message[];
    // Keep one chat object so the renderer only repaints when rows arrive.
    if (history.length !== messages.length || history.at(-1) !== messages.at(-1)) {
      paintedChat.history = messages.slice();
    }
    return paintedChat;
  }

  function renderCenter(scroll = false): void {
    const run = detail?.run ?? runs.find((row) => row.id === selectedRunId) ?? null;
    const live = detail?.live?.status === 'running' ? detail.live : null;
    const saved = detail?.transcript ?? null;
    runHead.replaceChildren();
    reviewers.replaceChildren();
    footer.replaceChildren();
    transcriptMeta.replaceChildren();
    transcriptEmpty.replaceChildren();
    transcriptEmpty.hidden = true;

    if (!selectedRunId || (!run && !live)) {
      transcript.reset();
      paintedChat = null;
      transcriptEmpty.hidden = false;
      const ico = el('span', 'auto-ico auto-ico--lg');
      ico.append(icon(jobIcon(job), 18));
      transcriptEmpty.append(ico, el('p', 'auto-transcript__empty-title', 'No runs yet'),
        el('p', 'auto-muted', job.schedule.kind === 'manual' ? 'Press Run now to start it.' : `First run ${untilText(job.nextRunAt) || 'soon'}. Press Run now to start it sooner.`));
      return;
    }

    // Meta line, like a chat's header row.
    const started = live?.startedAt ?? run?.startedAt ?? saved?.startedAt;
    const metaParts = [
      started ? `Started ${clockTime(started)}` : '',
      run?.trigger === 'manual' ? 'by you' : run ? 'on schedule' : '',
      job.modelId ? formatModelLabel({ id: job.modelId }).optionText : 'Menubar model',
    ].filter(Boolean);
    for (const part of metaParts) transcriptMeta.append(el('span', undefined, part));

    const focus = live?.focus ?? saved?.focus;
    if (focus) {
      const card = el('div', 'auto-focus');
      const head = el('div', 'auto-focus__head');
      head.append(el('span', 'auto-mono auto-muted', `#${focus.number}`), el('span', 'auto-focus__title', focus.title));
      card.append(head);
      const sub = el('div', 'auto-focus__sub');
      if (focus.author) sub.append(el('span', undefined, `@${focus.author}`));
      const headline = live?.headline ?? saved?.headline ?? run?.headline;
      if (headline) sub.append(live ? streamingText('span', '', headline) : el('span', undefined, headline));
      card.append(sub);
      runHead.append(card);
    }

    // Reviewer tabs (PR Reviewer runs).
    const children = live?.children ?? saved?.children?.map((c) => ({ ...c, step: '', label: c.roleLabel, children: [], live: null })) ?? [];
    for (const child of children) {
      const tab = el('button', `auto-reviewer${child.runId === selectedChild ? ' is-selected' : ''}`);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(child.runId === selectedChild));
      const running = child.status === 'running';
      const verdict = parseVerdictWord(('result' in child ? child.result?.assistantFinal : '') ?? '');
      const mark = running ? el('span', 'auto-spin') : icon(child.status === 'completed' ? (verdict === 'fail' ? 'statusFail' : 'statusPass') : 'statusFail', 14);
      if (!running) mark.classList.add(child.status === 'completed' && verdict !== 'fail' ? 'is-ok' : 'is-fail');
      const text = el('span', 'auto-reviewer__text');
      text.append(el('span', 'auto-reviewer__name', child.roleLabel ?? child.label));
      const line = running ? (child as AutomationLiveRun).step : child.status === 'completed' ? (verdict === 'fail' ? 'Blocking findings' : verdict === 'pass' ? 'Pass' : 'Done') : statusWord(child.status);
      text.append(running ? streamingText('span', 'auto-reviewer__step', line) : el('span', 'auto-reviewer__step', line));
      const time = el('span', `auto-mono auto-muted${running ? ' auto-elapsed' : ''}`, elapsedText(child.startedAt, child.finishedAt));
      if (running) time.dataset.since = child.startedAt;
      tab.append(mark, text, time);
      tab.addEventListener('click', () => {
        selectedChild = child.runId;
        paintedKey = '';
        transcript.reset();
        paintedChat = null;
        void loadRun(true);
      });
      reviewers.append(tab);
    }
    reviewers.hidden = children.length === 0;

    // Messages for the transcript.
    let messages: Message[] = [];
    let liveState: AutomationLiveState | null = null;
    let key = selectedRunId;
    if (children.length && selectedChild) {
      key = selectedChild;
      if (live) {
        messages = (childDetail?.live?.messages ?? []) as Message[];
        liveState = childDetail?.live?.status === 'running' ? childDetail.live.live : null;
      } else {
        messages = (saved?.children.find((c) => c.runId === selectedChild)?.messages ?? []) as Message[];
      }
    } else if (live) {
      messages = (live.messages ?? []) as Message[];
      liveState = live.live;
    } else if (saved) {
      messages = saved.messages as Message[];
    }

    if (!messages.length && !liveState) {
      transcript.reset();
      paintedChat = null;
      transcriptEmpty.hidden = false;
      if (live) {
        transcriptEmpty.append(el('span', 'auto-spin auto-spin--lg'), streamingText('p', '', live.step || 'Starting'));
      } else {
        const text = run ? (formatSchedulerRunSummary(run, 600) === '—' ? statusWord(run.status, run.quiet) : formatSchedulerRunSummary(run, 600)) : 'This run left no transcript.';
        transcriptEmpty.append(el('p', 'auto-transcript__empty-title', run?.quiet ? 'Nothing to do' : statusWord(run?.status ?? 'completed')), el('p', 'auto-muted', text));
      }
    } else {
      transcript.sync(chatFor(key, messages, job.label), liveState ?? undefined);
      if (scroll) scroller.scrollTop = scroller.scrollHeight;
    }

    // Footer actions.
    if (live) {
      const stop = button('Stop run', { variant: 'danger', icon: 'stop' });
      stop.addEventListener('click', () => {
        void stopAutomationRun(live.runId).then(() => options.notify('ok', 'Stopping the run')).catch((error) => options.notify('err', String(error)));
      });
      const working = el('span', 'auto-runfoot__live');
      const elapsed = el('span', 'auto-elapsed auto-mono', elapsedText(live.startedAt));
      elapsed.dataset.since = live.startedAt;
      working.append(el('span', 'auto-spin'), el('span', undefined, 'Working for '), elapsed);
      const counts = live.stats;
      if (counts.toolCalls) working.append(el('span', 'auto-muted', ` · ${counts.filesRead} read · ${counts.filesEdited} edited · ${counts.commands} commands`));
      footer.append(working, el('span', 'auto-spacer'), stop);
    } else if (run) {
      const chatId = resolveSchedulerRunChatId(run);
      footer.append(el('span', 'auto-muted', `${statusWord(run.status, run.quiet)}${run.completedAt ? ` · ${elapsedText(run.startedAt, run.completedAt)}` : ''}`), el('span', 'auto-spacer'));
      if (chatId) {
        const open = button('Continue in Code', { icon: 'appCode' });
        open.addEventListener('click', () => void openRunChatInCode(chatId, options.notify));
        footer.append(open);
      }
    }
  }

  function parseVerdictWord(text: string): 'pass' | 'fail' | null {
    const match = /"verdict"\s*:\s*"(pass|fail)"/.exec(text);
    if (!match) return null;
    return /"severity"\s*:\s*"blocking"/.test(text) ? 'fail' : match[1] as 'pass' | 'fail';
  }

  // ---------- rail ----------
  function kv(rows: [string, string | HTMLElement][]): HTMLElement {
    const dl = el('dl', 'auto-kv');
    for (const [k, v] of rows) {
      dl.append(el('dt', undefined, k));
      const dd = el('dd');
      if (typeof v === 'string') dd.textContent = v; else dd.append(v);
      dl.append(dd);
    }
    return dl;
  }

  function renderRail(): void {
    rail.replaceChildren();
    const config = job.preset?.config ?? {};
    if (engine === 'pr-review') {
      const live = job.live?.focus;
      const row = (queue?.pulls ?? []).find((p) => p.runId === selectedRunId) ?? null;
      const pr = live && selectedRunId === job.live?.runId ? { ...live, phase: live.phase } : row;
      if (pr) {
        const block = el('div', 'auto-rail__block');
        block.append(el('div', 'auto-rail__eyebrow auto-mono', `#${pr.number}`), el('div', 'auto-rail__title', pr.title));
        const pass = PR_PASS_ACTIONS.find((a) => a.id === config.onPass)?.label ?? 'Add to merge queue';
        const verdict = row?.verdict ? (row.verdict === 'pass' ? 'Pass' : 'Changes requested') : 'Reviewing…';
        const verdictNode = row?.verdict ? el('span', row.verdict === 'pass' ? 'is-ok' : 'is-fail', verdict) : streamingText('span', '', verdict);
        block.append(kv([
          ['Author', `@${pr.author ?? ''}`],
          ['Claim', config.claim ? 'Comment, then re-check' : 'Off'],
          ['Verdict', verdictNode],
          ['If passes', pass],
          ['If fails', config.onFail === 'comment' ? 'Comment only' : 'Request changes'],
        ]));
        if (row?.findings?.length) {
          const findings = el('ul', 'auto-findings');
          for (const f of row.findings.slice(0, 6)) {
            const li = el('li', f.severity === 'blocking' ? 'is-blocking' : '');
            li.append(el('span', 'auto-mono', `${f.file ?? ''}${f.line ? `:${f.line}` : ''}`), el('span', undefined, f.note));
            findings.append(li);
          }
          block.append(findings);
        }
        if (pr.url) {
          const link = el('a', 'auto-link');
          link.href = pr.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.append(el('span', undefined, 'Open on GitHub'), icon('externalLink', 12));
          block.append(link);
        }
        rail.append(block);
      }
    }
    const about = el('div', 'auto-rail__block');
    about.append(el('div', 'auto-rail__eyebrow', 'This automation'));
    const capabilities = preset ? presetCapabilities(preset.id, config) : ['read', 'write', 'run commands'];
    const can = el('span', 'auto-cans');
    for (const c of capabilities) can.append(el('span', 'auto-can', c));
    about.append(kv([
      ['Runs', triggerText(job)],
      ['Next', job.live ? 'After this run' : !job.enabled ? 'Paused' : job.schedule.kind === 'manual' ? 'When you start it' : untilText(job.nextRunAt) || '—'],
      ['Recent', recentSummary()],
      ['Model', job.modelId ? formatModelLabel({ id: job.modelId }).optionText : 'Menubar default'],
      ['Workspace', job.workspacePath ? displayPath(job.workspacePath) : 'Scheduler workspace'],
      ['Can', can],
    ]));
    rail.append(about);
  }

  // ---------- data ----------
  async function loadSideData(force = false): Promise<void> {
    if (queueTimer) { window.clearTimeout(queueTimer); queueTimer = undefined; }
    if (disposed) return;
    try {
      const nextRuns = await fetchSchedulerRuns(job.id);
      const key = nextRuns.map((run) => `${run.id}:${run.status}`).join(',');
      runs = nextRuns;
      if (engine === 'pr-review') queue = await fetchPrReviewQueue(job.id).catch(() => queue);
      if (engine === 'github-watch') issues = await fetchWatchedGithubIssues(job.id).catch(() => issues);
      if (disposed) return;
      if (force || key !== lastRunsKey) {
        lastRunsKey = key;
        renderList();
        renderRail();
        if (!selectedRunId) void loadRun(true);
      } else {
        renderList();
        renderRail();
      }
    } catch (error) {
      options.notify('err', error instanceof Error ? error.message : String(error));
    }
    queueTimer = window.setTimeout(() => { void loadSideData(); }, QUEUE_POLL_MS);
  }

  renderBar();
  renderList();
  renderRail();
  renderCenter();
  enter(root);
  void loadSideData(true).then(() => loadRun(true));

  return {
    root,
    update(next: AutomationJob) {
      const startedNewRun = Boolean(next.live && next.live.runId !== job.live?.runId);
      const finished = Boolean(job.live && !next.live);
      job = next;
      renderBar();
      // Follow new live runs unless the person picked an older run to read.
      if (startedNewRun && !pickedByUser) selectRun(next.live!.runId);
      if (finished) void loadSideData(true).then(() => loadRun());
    },
    dispose() {
      disposed = true;
      if (liveTimer) window.clearTimeout(liveTimer);
      if (queueTimer) window.clearTimeout(queueTimer);
      transcript.dispose();
    },
  };
}
