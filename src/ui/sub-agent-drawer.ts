import {
  cancelSubAgent,
  getSubAgentRun,
  honestTerminalSummary,
  hydrateSubAgentRunsForParentChat,
  hydrateSubAgentTranscript,
  lastNonSystemPreview,
  listSubAgentRunsForParentChat,
} from '../agents/orchestrator';
import { subscribeSubAgentRuns } from '../agents/sub-agent-events';
import type { SubAgentRun } from '../agents/types';
import { findChatById } from '../state/sessions';
import { legacyOutcomeFromSummary } from '../agents/sub-agent-structured-outcome';
import type { SubAgentStructuredOutcome } from '../agents/sub-agent-structured-outcome';
import type { PersistedSubAgentRun } from '../types';
import { resolveSubAgentOverlayMount } from './chat-mount';
import {
  appendTranscriptLiveTail,
  renderTranscriptView,
} from './transcript-view.ts';
import {
  subAgentLiveStatusLine,
  subAgentTranscriptLiveFromRun,
} from './sub-agent-live-status';
import { iconHtml } from './icon';

type AnyRun = SubAgentRun | PersistedSubAgentRun;

/** Status tone drives the dot color and chip/label semantics. */
type StatusTone = 'working' | 'queued' | 'done' | 'failed' | 'cancelled';

/** DOM refs for the open overlay so run updates + switching can refresh in place. */
interface OverlayState {
  root: HTMLElement;
  sheet: HTMLElement;
  chatId: string;
  activeRunId: string;
  expanded: boolean;
  returnFocus: HTMLElement | null;
  onKey: (e: KeyboardEvent) => void;
  switcher: HTMLElement;
  headingType: HTMLElement;
  statusDot: HTMLElement;
  statusText: HTMLElement;
  runIdEl: HTMLElement;
  endedEl: HTMLElement;
  promptText: HTMLElement;
  promptToggle: HTMLButtonElement;
  scroll: HTMLElement;
  structuredRoot: HTMLElement;
  transcriptDetails: HTMLDetailsElement;
  transcriptBody: HTMLElement;
  footer: HTMLElement;
  renderedTask: string | null;
  renderedMessages: unknown[] | null;
  transcriptKey: string | null;
  structuredKey: string | null;
  footerKey: string | null;
  switcherKey: string | null;
  activityInitialized: boolean;
  refreshFrame: number | null;
}

let overlay: OverlayState | null = null;
let subscriptionBound = false;
let openRequest = 0;

// ── Status helpers ───────────────────────────────────────────────────────────

/** Terminal-state check shared by cancel-affordance and details defaults. */
function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Human label + tone for a run status. */
function statusMeta(status: string): { label: string; tone: StatusTone } {
  if (status === 'completed') return { label: 'Complete', tone: 'done' };
  if (status === 'failed') return { label: 'Failed', tone: 'failed' };
  if (status === 'cancelled') return { label: 'Cancelled', tone: 'cancelled' };
  if (status === 'queued') return { label: 'Queued', tone: 'queued' };
  if (status === 'running') return { label: 'Running', tone: 'working' };
  return { label: status, tone: 'working' };
}

/** Parse ISO or epoch time to ms for stable ordering; NaN sorts last. */
function timeKey(v: string | number | null | undefined): number {
  if (v == null || v === '') return Number.POSITIVE_INFINITY;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Format ISO or epoch ended time for display. */
function formatEndedAt(endedAt: string | number | null | undefined): string | null {
  if (endedAt == null || endedAt === '') return null;
  const ms = typeof endedAt === 'number' ? endedAt : Date.parse(String(endedAt));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString();
}

function taskPreview(task: string, max = 90): string {
  const t = (task ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function contentShape(content: unknown): string {
  if (typeof content === 'string') return `s${content.length}`;
  if (Array.isArray(content)) return `a${content.length}`;
  if (content == null) return 'n';
  return 'o';
}

/** Transcript structure excluding live reasoning, which updates in place. */
function transcriptRenderKey(messages: unknown[]): string {
  return messages.map((raw) => {
    if (!raw || typeof raw !== 'object') return typeof raw;
    const msg = raw as Record<string, unknown>;
    const role = String(msg.role ?? '');
    const calls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((entry) => {
          if (!entry || typeof entry !== 'object') return '';
          const call = entry as {
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          return `${String(call.id ?? '')}:${String(call.function?.name ?? '')}:${String(call.function?.arguments ?? '').length}`;
        }).join(',')
      : '';
    const attachments = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
    return `${role}:${contentShape(msg.content)}:${String(msg.tool_call_id ?? '')}:${calls}:${attachments}`;
  }).join('|');
}

function resetRenderCache(state: OverlayState): void {
  state.renderedTask = null;
  state.renderedMessages = null;
  state.transcriptKey = null;
  state.structuredKey = null;
  state.footerKey = null;
  state.switcherKey = null;
  state.activityInitialized = false;
}

// ── Run list ─────────────────────────────────────────────────────────────────

/** All runs for a chat (persisted + live store), de-duped, ordered by start time. */
function listChatRuns(chatId: string): Array<{ run: AnyRun; live: boolean }> {
  const byId = new Map<string, { run: AnyRun; live: boolean }>();
  const chat = findChatById(chatId);
  for (const row of chat?.subAgentRuns ?? []) {
    byId.set(row.runId, { run: row, live: false });
  }
  for (const run of listSubAgentRunsForParentChat(chatId)) {
    const live = run.status === 'running' || run.status === 'queued';
    byId.set(run.runId, { run, live });
  }
  return [...byId.values()].sort(
    (a, b) => timeKey(a.run.startedAt) - timeKey(b.run.startedAt),
  );
}

/** Resolve a single run from live orchestrator state or persisted snapshot. */
function resolveRunSnapshot(
  runId: string,
  chatId: string,
): { run: AnyRun; live: boolean } | null {
  const live = getSubAgentRun(runId);
  if (live && live.parentChatId === chatId) return { run: live, live: true };
  const persisted = findChatById(chatId)?.subAgentRuns?.find((r) => r.runId === runId);
  return persisted ? { run: persisted, live: false } : null;
}

/** Real structured answer only — same rule as spawn cards. */
export function resolveOutcome(run: AnyRun, _live = false): SubAgentStructuredOutcome | null {
  if (run.structuredOutcome) return run.structuredOutcome;
  if (run.summary?.trim()) return legacyOutcomeFromSummary(run.summary);
  return null;
}

/** Activity stays open unless a real fold outcome exists on a terminal run. */
export function shouldExpandSubAgentActivity(run: AnyRun): boolean {
  return !resolveOutcome(run) || !isTerminal(run.status);
}

/** Live status line when a structured outcome is not ready yet. */
function liveStatusLine(run: SubAgentRun): string {
  return subAgentLiveStatusLine(run, true);
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Structured summary / findings / artifacts above the activity stream. */
function renderStructuredBlock(root: HTMLElement, run: AnyRun, live: boolean): void {
  root.replaceChildren();
  const outcome = resolveOutcome(run, live);
  if (!outcome) {
    const line = !isTerminal(run.status)
      ? live
        ? liveStatusLine(run as SubAgentRun)
        : ''
      : lastNonSystemPreview(run.messages) || honestTerminalSummary(run);
    if (line) {
      const p = document.createElement('p');
      p.className = 'sub-agent-overlay__summary';
      p.textContent = line;
      root.appendChild(p);
    }
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'sub-agent-overlay__summary';
  summary.textContent = outcome.summary;
  root.appendChild(summary);

  if (outcome.findings.length > 0) {
    const list = document.createElement('ul');
    list.className = 'sub-agent-overlay__findings';
    for (const f of outcome.findings) {
      const li = document.createElement('li');
      li.className = 'sub-agent-overlay__finding';
      const title = document.createElement('strong');
      title.textContent = f.title;
      li.appendChild(title);
      if (f.severity) {
        const sev = document.createElement('span');
        sev.className = `sub-agent-overlay__severity sub-agent-overlay__severity--${f.severity}`;
        sev.textContent = f.severity;
        li.appendChild(sev);
      }
      const detail = document.createElement('p');
      detail.textContent = f.detail;
      li.appendChild(detail);
      if (f.paths?.length) {
        const paths = document.createElement('p');
        paths.className = 'sub-agent-overlay__paths';
        paths.textContent = f.paths.join(', ');
        li.appendChild(paths);
      }
      list.appendChild(li);
    }
    root.appendChild(list);
  }

  if (outcome.artifacts.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'sub-agent-overlay__artifacts';
    for (const a of outcome.artifacts) {
      const chip = document.createElement('span');
      chip.className = 'sub-agent-overlay__artifact';
      chip.textContent = `${a.kind}: ${a.label}`;
      chip.title = a.ref;
      chips.appendChild(chip);
    }
    root.appendChild(chips);
  }

  const liveRun = run as SubAgentRun;
  if (liveRun.budgetEvents?.length) {
    const budget = document.createElement('ul');
    budget.className = 'sub-agent-overlay__budget-events';
    for (const ev of liveRun.budgetEvents) {
      const li = document.createElement('li');
      li.textContent = ev.label;
      budget.appendChild(li);
    }
    root.appendChild(budget);
  }
}

/** Rebuild the run switcher rail (hidden when the chat has one run). */
function renderSwitcher(state: OverlayState): void {
  const runs = listChatRuns(state.chatId);
  const key = runs.map(({ run }) => `${run.runId}:${run.status}:${run.type}:${run.task}`).join('|');
  if (state.switcherKey === key) return;
  state.switcherKey = key;
  state.switcher.replaceChildren();
  state.switcher.hidden = runs.length <= 1;
  if (runs.length <= 1) return;

  for (const { run } of runs) {
    const { tone, label } = statusMeta(run.status);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sub-agent-overlay__chip';
    chip.dataset.runId = run.runId;
    chip.title = `${run.type} · ${label}\n${taskPreview(run.task, 140)}`;
    const active = run.runId === state.activeRunId;
    chip.classList.toggle('is-active', active);
    if (active) chip.setAttribute('aria-current', 'true');

    const dot = document.createElement('span');
    dot.className = `sub-agent-overlay__dot sub-agent-overlay__dot--${tone}`;
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'sub-agent-overlay__chip-label';
    text.textContent = run.type;

    chip.appendChild(dot);
    chip.appendChild(text);
    chip.addEventListener('click', () => setActiveRun(run.runId));
    state.switcher.appendChild(chip);
  }
}

/** Fill header, prompt, outcome, activity, and footer for the active run. */
function renderActiveRun(state: OverlayState, opts: { scroll: 'end' | 'sticky' }): void {
  const resolved = resolveRunSnapshot(state.activeRunId, state.chatId);
  if (!resolved) {
    closeSubAgentDrawer();
    return;
  }
  const { run, live } = resolved;
  const { label, tone } = statusMeta(run.status);

  const wasNearBottom =
    state.scroll.scrollHeight - state.scroll.scrollTop - state.scroll.clientHeight <
    48;

  state.sheet.setAttribute('aria-label', `Sub-agent ${run.type}, ${label}`);
  if (state.headingType.textContent !== run.type) state.headingType.textContent = run.type;
  const liveRunHeader = run as SubAgentRun;
  if (live && liveRunHeader.startError) {
    const next = `Start failed (${liveRunHeader.startError.consecutive})`;
    if (state.statusText.textContent !== next) state.statusText.textContent = next;
  } else {
    if (state.statusText.textContent !== label) state.statusText.textContent = label;
  }
  const statusClass = `sub-agent-overlay__dot sub-agent-overlay__dot--${tone}`;
  if (state.statusDot.className !== statusClass) state.statusDot.className = statusClass;
  if (state.runIdEl.textContent !== run.runId) state.runIdEl.textContent = run.runId;

  const ended = formatEndedAt(run.endedAt);
  const endedText = ended ? `Ended ${ended}` : '';
  if (state.endedEl.textContent !== endedText) state.endedEl.textContent = endedText;
  state.endedEl.hidden = !ended;

  const task = run.task?.trim() || '(no task provided)';
  if (state.renderedTask !== task) {
    state.renderedTask = task;
    state.promptText.textContent = task;
    state.promptText.classList.add('is-clamped');
    state.promptToggle.hidden = true;
    state.promptToggle.textContent = 'Show more';
    state.promptToggle.setAttribute('aria-expanded', 'false');
    requestAnimationFrame(() => {
      if (!overlay || overlay !== state) return;
      const overflowing =
        state.promptText.scrollHeight - state.promptText.clientHeight > 2;
      state.promptToggle.hidden = !overflowing;
    });
  }

  const liveRun = run as SubAgentRun;
  const structuredKey = JSON.stringify([
    run.status,
    run.summary,
    run.error,
    live ? liveStatusLine(liveRun) : '',
    liveRun.startError?.message ?? '',
    liveRun.startError?.consecutive ?? 0,
    liveRun.budgetEvents?.length ?? 0,
    run.structuredOutcome ?? null,
  ]);
  if (state.structuredKey !== structuredKey) {
    state.structuredKey = structuredKey;
    renderStructuredBlock(state.structuredRoot, run, live);
    if (live && liveRun.startError) {
      const err = document.createElement('p');
      err.className = 'sub-agent-overlay__error';
      err.textContent = `${liveRun.startError.message} (${liveRun.startError.consecutive})`;
      state.structuredRoot.appendChild(err);
    }
  }

  if (!state.activityInitialized) {
    state.transcriptDetails.open = shouldExpandSubAgentActivity(run);
    state.activityInitialized = true;
  }
  const messages = run.messages as unknown[];
  const liveTail = subAgentTranscriptLiveFromRun(run, live);
  if (messages !== state.renderedMessages) {
    const nextTranscriptKey = transcriptRenderKey(messages);
    if (state.transcriptKey !== nextTranscriptKey) {
      renderTranscriptView(state.transcriptBody, messages, liveTail);
      state.transcriptKey = nextTranscriptKey;
    } else {
      appendTranscriptLiveTail(state.transcriptBody, liveTail, messages);
    }
    state.renderedMessages = messages;
  } else {
    appendTranscriptLiveTail(state.transcriptBody, liveTail, messages);
  }

  const cancellable = live && (run.status === 'running' || run.status === 'queued');
  const footerLine = cancellable
    ? liveRun.startError
      ? `${liveRun.startError.message} (${liveRun.startError.consecutive})`
      : liveStatusLine(liveRun) || 'Working…'
    : '';
  const footerKey = `${cancellable}:${footerLine}`;
  if (state.footerKey !== footerKey) {
    state.footerKey = footerKey;
    state.footer.replaceChildren();
    state.footer.hidden = !cancellable;
  }
  if (cancellable && state.footer.childElementCount === 0) {
    const line = document.createElement('span');
    line.className = 'sub-agent-overlay__footer-status';
    line.textContent = footerLine;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'sub-agent-overlay__cancel';
    cancelBtn.textContent = 'Cancel run';
    cancelBtn.addEventListener('click', () => {
      cancelSubAgent(state.activeRunId, 'user_cancel');
    });
    state.footer.appendChild(line);
    state.footer.appendChild(cancelBtn);
  }

  renderSwitcher(state);

  const shouldScroll = opts.scroll === 'end' || (opts.scroll === 'sticky' && wasNearBottom);
  if (shouldScroll && state.transcriptDetails.open) {
    state.scroll.scrollTop = state.scroll.scrollHeight;
  }
}

// ── Overlay ──────────────────────────────────────────────────────────────────

/** Switch the overlay to a different run in the same chat without reopening. */
function setActiveRun(runId: string): void {
  if (!overlay || overlay.activeRunId === runId) return;
  overlay.activeRunId = runId;
  resetRenderCache(overlay);
  renderActiveRun(overlay, { scroll: 'end' });
  void hydrateSubAgentTranscript(runId).then(() => {
    if (!overlay || overlay.activeRunId !== runId) return;
    renderActiveRun(overlay, { scroll: 'end' });
  });
}

/** Toggle inset ↔ full-column presentation. */
function toggleExpanded(btn: HTMLButtonElement): void {
  if (!overlay) return;
  overlay.expanded = !overlay.expanded;
  overlay.root.classList.toggle('sub-agent-overlay--expanded', overlay.expanded);
  btn.setAttribute('aria-pressed', String(overlay.expanded));
  btn.setAttribute('aria-label', overlay.expanded ? 'Collapse' : 'Expand');
  btn.title = overlay.expanded ? 'Collapse' : 'Expand';
}

/** Trap Tab focus within the sheet; Esc closes. */
function handleKey(e: KeyboardEvent): void {
  if (!overlay) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSubAgentDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = overlay.sheet.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
  );
  const visible = [...focusables].filter(
    (el) => !el.hidden && el.offsetParent !== null,
  );
  if (visible.length === 0) return;
  const first = visible[0];
  const last = visible[visible.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  } else if (active && !overlay.sheet.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

function bindSubscription(): void {
  if (subscriptionBound) return;
  subscriptionBound = true;
  subscribeSubAgentRuns((run) => {
    if (!overlay || run.parentChatId !== overlay.chatId) return;
    const state = overlay;
    if (state.refreshFrame != null) return;
    state.refreshFrame = -1;
    const handle = requestAnimationFrame(() => {
      state.refreshFrame = null;
      if (overlay !== state) return;
      renderActiveRun(state, { scroll: 'sticky' });
    });
    if (state.refreshFrame === -1) state.refreshFrame = handle;
  });
}

// ── Open drawer ──────────────────────────────────────────────────────────────

/** Wire overlay refresh to orchestrator pub/sub (called from initSubAgentUi). */
export function initSubAgentDrawerLiveUpdates(): void {
  bindSubscription();
}

export function closeSubAgentDrawer(): void {
  openRequest += 1;
  if (!overlay) return;
  const state = overlay;
  overlay = null;
  document.removeEventListener('keydown', state.onKey, true);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cleanup = (): void => {
    state.root.remove();
    if (state.returnFocus?.isConnected) state.returnFocus.focus();
  };
  if (reduce) {
    cleanup();
    return;
  }
  state.root.classList.remove('is-open');
  state.root.classList.add('is-closing');
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    cleanup();
  };
  state.sheet.addEventListener('transitionend', finish, { once: true });
  window.setTimeout(finish, 260);
}

/** Opens the overlay for one sub-agent run (live or persisted on the given chat). */
export async function openSubAgentDrawer(runId: string, chatId: string): Promise<void> {
  bindSubscription();
  closeSubAgentDrawer();
  // Paint the existing snapshot before any network work, including in another window.
  if (resolveRunSnapshot(runId, chatId)) mountSubAgentDrawer(runId, chatId);
  const request = ++openRequest;
  // Opening the drawer is an explicit request for the current state, so bypass the hydrate TTL.
  await hydrateSubAgentRunsForParentChat(chatId, { force: true });
  if (request !== openRequest) return;
  if (!overlay) mountSubAgentDrawer(runId, chatId);
  await hydrateSubAgentTranscript(runId);
  if (overlay?.activeRunId === runId && overlay.chatId === chatId) {
    renderActiveRun(overlay, { scroll: 'sticky' });
  }
}

function mountSubAgentDrawer(runId: string, chatId: string): void {
  const returnFocus = (document.activeElement as HTMLElement | null) ?? null;
  closeSubAgentDrawer();
  if (!resolveRunSnapshot(runId, chatId)) return;

  const main = resolveSubAgentOverlayMount();
  if (!main) return;

  const root = document.createElement('div');
  root.className = 'sub-agent-overlay';

  const scrim = document.createElement('div');
  scrim.className = 'sub-agent-overlay__scrim';
  scrim.setAttribute('role', 'presentation');
  scrim.addEventListener('click', () => closeSubAgentDrawer());

  const sheet = document.createElement('div');
  sheet.className = 'sub-agent-overlay__sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');

  const header = document.createElement('header');
  header.className = 'sub-agent-overlay__header';

  const heading = document.createElement('div');
  heading.className = 'sub-agent-overlay__heading';
  const kicker = document.createElement('span');
  kicker.className = 'sub-agent-overlay__kicker';
  kicker.textContent = 'Sub-agent';
  const headingType = document.createElement('h2');
  headingType.className = 'sub-agent-overlay__title';
  const status = document.createElement('span');
  status.className = 'sub-agent-overlay__status';
  const statusDot = document.createElement('span');
  statusDot.className = 'sub-agent-overlay__dot';
  statusDot.setAttribute('aria-hidden', 'true');
  const statusText = document.createElement('span');
  statusText.className = 'sub-agent-overlay__status-text';
  status.appendChild(statusDot);
  status.appendChild(statusText);
  heading.appendChild(kicker);
  heading.appendChild(headingType);
  heading.appendChild(status);

  const tools = document.createElement('div');
  tools.className = 'sub-agent-overlay__tools';
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'sub-agent-overlay__icon-btn';
  expandBtn.setAttribute('aria-pressed', 'false');
  expandBtn.setAttribute('aria-label', 'Expand');
  expandBtn.title = 'Expand';
  expandBtn.innerHTML = expandIconSvg();
  expandBtn.addEventListener('click', () => toggleExpanded(expandBtn));
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sub-agent-overlay__icon-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.title = 'Close';
  closeBtn.innerHTML = closeIconSvg();
  closeBtn.addEventListener('click', () => closeSubAgentDrawer());
  tools.appendChild(expandBtn);
  tools.appendChild(closeBtn);

  header.appendChild(heading);
  header.appendChild(tools);

  const meta = document.createElement('div');
  meta.className = 'sub-agent-overlay__meta';
  const runIdEl = document.createElement('span');
  runIdEl.className = 'sub-agent-overlay__run-id';
  const endedEl = document.createElement('span');
  endedEl.className = 'sub-agent-overlay__ended';
  endedEl.hidden = true;
  meta.appendChild(runIdEl);
  meta.appendChild(endedEl);

  const switcher = document.createElement('nav');
  switcher.className = 'sub-agent-overlay__switcher';
  switcher.setAttribute('aria-label', 'Sub-agents in this chat');

  const promptWrap = document.createElement('section');
  promptWrap.className = 'sub-agent-overlay__prompt';
  const promptLabel = document.createElement('span');
  promptLabel.className = 'sub-agent-overlay__prompt-label';
  promptLabel.textContent = 'Task';
  const promptText = document.createElement('p');
  promptText.className = 'sub-agent-overlay__prompt-text is-clamped';
  const promptToggle = document.createElement('button');
  promptToggle.type = 'button';
  promptToggle.className = 'sub-agent-overlay__prompt-toggle';
  promptToggle.hidden = true;
  promptToggle.textContent = 'Show more';
  promptToggle.setAttribute('aria-expanded', 'false');
  promptToggle.addEventListener('click', () => {
    const clamped = promptText.classList.toggle('is-clamped');
    promptToggle.textContent = clamped ? 'Show more' : 'Show less';
    promptToggle.setAttribute('aria-expanded', String(!clamped));
  });
  promptWrap.appendChild(promptLabel);
  promptWrap.appendChild(promptText);
  promptWrap.appendChild(promptToggle);

  const scroll = document.createElement('div');
  scroll.className = 'sub-agent-overlay__scroll';
  const structuredRoot = document.createElement('div');
  structuredRoot.className = 'sub-agent-overlay__structured';
  const transcriptDetails = document.createElement('details');
  transcriptDetails.className = 'sub-agent-overlay__activity';
  const transcriptSummary = document.createElement('summary');
  transcriptSummary.textContent = 'Activity';
  const transcriptBody = document.createElement('div');
  transcriptBody.className = 'sub-agent-overlay__body';
  transcriptDetails.appendChild(transcriptSummary);
  transcriptDetails.appendChild(transcriptBody);
  scroll.appendChild(structuredRoot);
  scroll.appendChild(transcriptDetails);

  const footer = document.createElement('footer');
  footer.className = 'sub-agent-overlay__footer';
  footer.hidden = true;

  sheet.appendChild(header);
  sheet.appendChild(meta);
  sheet.appendChild(switcher);
  sheet.appendChild(promptWrap);
  sheet.appendChild(scroll);
  sheet.appendChild(footer);

  root.appendChild(scrim);
  root.appendChild(sheet);
  main.appendChild(root);

  const onKey = (e: KeyboardEvent): void => handleKey(e);
  document.addEventListener('keydown', onKey, true);

  overlay = {
    root,
    sheet,
    chatId,
    activeRunId: runId,
    expanded: false,
    returnFocus,
    onKey,
    switcher,
    headingType,
    statusDot,
    statusText,
    runIdEl,
    endedEl,
    promptText,
    promptToggle,
    scroll,
    structuredRoot,
    transcriptDetails,
    transcriptBody,
    footer,
    renderedTask: null,
    renderedMessages: null,
    transcriptKey: null,
    structuredKey: null,
    footerKey: null,
    switcherKey: null,
    activityInitialized: false,
    refreshFrame: null,
  };

  renderActiveRun(overlay, { scroll: 'end' });

  requestAnimationFrame(() => {
    if (overlay?.root === root) root.classList.add('is-open');
  });

  closeBtn.focus();
}

/** Diagonal expand icon for full-column toggle. */
function expandIconSvg(): string {
  return iconHtml('expand', { size: 16 });
}

/** Close icon for overlay dismiss. */
function closeIconSvg(): string {
  return iconHtml('close', { size: 16 });
}
