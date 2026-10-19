import {
  cancelSubAgent, getSubAgentRun, hydrateSubAgentRunsForParentChat,
  hydrateSubAgentTranscript, listSubAgentRunsForParentChat, restartSubAgent,
} from '../agents/orchestrator';
import { subscribeSubAgentRuns } from '../agents/sub-agent-events';
import type { SubAgentRun } from '../agents/types';
import { findChatById } from '../state/sessions';
import { legacyOutcomeFromSummary } from '../agents/sub-agent-structured-outcome';
import type { SubAgentStructuredOutcome } from '../agents/sub-agent-structured-outcome';
import type { PersistedSubAgentRun } from '../types';
import { resolveSubAgentOverlayMount } from './chat-mount';
import { appendTranscriptLiveTail } from './transcript-view';
import { subAgentLiveStatusLine, subAgentTranscriptLiveFromRun } from './sub-agent-live-status';
import { createIcon, type IconName } from './icon';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { formatWorkDuration } from '../chat/transcript-turns';
import {
  formatSubAgentProse, renderSubAgentConversation, subAgentFinalResponse,
  type SubAgentConversationDisclosures,
} from './sub-agent-conversation';

type AnyRun = SubAgentRun | PersistedSubAgentRun;
type View = 'conversation' | 'result';
interface RunView {
  tab: View;
  thoughts: Map<string, boolean>;
  tools: Map<string, boolean>;
  groups: Map<string, boolean>;
  scroll: number;
  assignmentOpen: boolean;
}
interface OverlayState {
  root: HTMLElement;
  sheet: HTMLElement;
  chatId: string;
  activeRunId: string;
  expanded: boolean;
  returnFocus: HTMLElement | null;
  onKey: (e: KeyboardEvent) => void;
  switcher: HTMLElement;
  mobileSelect: HTMLSelectElement;
  count: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  assignment: HTMLDetailsElement;
  promptText: HTMLElement;
  scroll: HTMLElement;
  tabs: HTMLButtonElement[];
  structuredRoot: HTMLElement;
  transcriptBody: HTMLElement;
  notice: HTMLElement;
  details: HTMLElement;
  footer: HTMLElement;
  views: Map<string, RunView>;
  transcriptKey: string | null;
  resultKey: string | null;
  footerKey: string | null;
  switcherKey: string | null;
  loadingRunId: string | null;
  refreshFrame: number | null;
}
let overlay: OverlayState | null = null;
let unsubscribe: (() => void) | null = null;
let openRequest = 0;

const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
function statusMeta(status: string): { label: string; tone: string; icon: IconName } {
  if (status === 'completed') return { label: 'Complete', tone: 'done', icon: 'statusPass' };
  if (status === 'failed') return { label: 'Failed', tone: 'failed', icon: 'statusFail' };
  if (status === 'cancelled') return { label: 'Stopped', tone: 'cancelled', icon: 'stop' };
  if (status === 'queued') return { label: 'Queued', tone: 'queued', icon: 'clock' };
  return { label: 'Working', tone: 'working', icon: 'appAgentActivity' };
}
function agentLabel(type: string): string {
  const text = type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function taskTitle(task: string): string {
  const first = task.split('\n').map((line) => line.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, '').trim()).find(Boolean) || 'Untitled assignment';
  return first.length > 110 ? `${first.slice(0, 110)}…` : first;
}
function badge(run: AnyRun): HTMLElement {
  const { label, tone, icon } = statusMeta(run.status);
  const span = document.createElement('span');
  span.className = `sub-agent-overlay__status sub-agent-overlay__status--${tone}`;
  span.append(createIcon(icon, { size: 13 }), document.createTextNode(label));
  return span;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function action(label: string, icon?: IconName): HTMLButtonElement {
  const button = el('button', 'sub-agent-overlay__action');
  button.type = 'button';
  if (icon) button.appendChild(createIcon(icon, { size: 14 }));
  button.appendChild(document.createTextNode(label));
  return button;
}
function viewFor(state: OverlayState): RunView {
  let view = state.views.get(state.activeRunId);
  if (!view) {
    view = { tab: 'conversation', thoughts: new Map(), tools: new Map(), groups: new Map(), scroll: 0, assignmentOpen: false };
    state.views.set(state.activeRunId, view);
  }
  return view;
}
function resolveRun(runId: string, chatId: string): { run: AnyRun; live: boolean } | null {
  const current = getSubAgentRun(runId);
  if (current?.parentChatId === chatId) return { run: current, live: !terminal(current.status) };
  const persisted = findChatById(chatId)?.subAgentRuns?.find((run) => run.runId === runId);
  return persisted ? { run: persisted, live: false } : null;
}
function chatRuns(chatId: string): AnyRun[] {
  const runs = new Map<string, AnyRun>();
  for (const run of findChatById(chatId)?.subAgentRuns ?? []) runs.set(run.runId, run);
  for (const run of listSubAgentRunsForParentChat(chatId)) runs.set(run.runId, run);
  return [...runs.values()].sort((a, b) => Date.parse(a.startedAt ?? '') - Date.parse(b.startedAt ?? ''));
}
export function resolveOutcome(run: AnyRun, _live = false): SubAgentStructuredOutcome | null {
  return run.structuredOutcome ?? (run.summary?.trim() ? legacyOutcomeFromSummary(run.summary) : null);
}

function renderSwitcher(state: OverlayState): void {
  const runs = chatRuns(state.chatId);
  const key = JSON.stringify([state.activeRunId, runs.map((run) => [run.runId, run.status, run.type, run.task])]);
  if (key === state.switcherKey) return;
  state.switcherKey = key;
  const focusedRun = state.switcher.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.runId : null;
  state.switcher.replaceChildren(el('p', 'sub-agent-overlay__rail-label', 'This conversation'));
  state.mobileSelect.replaceChildren();
  const working = runs.filter((run) => run.status === 'running').length;
  state.count.textContent = `${runs.length} ${runs.length === 1 ? 'agent' : 'agents'}${working ? ` · ${working} working` : ''}`;
  for (const run of runs) {
    const button = el('button', 'sub-agent-overlay__chip');
    button.type = 'button';
    button.dataset.runId = run.runId;
    button.setAttribute('aria-pressed', String(run.runId === state.activeRunId));
    button.title = run.task;
    button.append(el('span', 'sub-agent-overlay__chip-label', taskTitle(run.task)), el('span', 'sub-agent-overlay__chip-role', agentLabel(run.type)), badge(run));
    button.addEventListener('click', () => setActiveRun(run.runId));
    state.switcher.appendChild(button);
    const option = document.createElement('option');
    option.value = run.runId;
    option.textContent = `${taskTitle(run.task)} · ${statusMeta(run.status).label}`;
    option.selected = run.runId === state.activeRunId;
    state.mobileSelect.appendChild(option);
  }
  if (focusedRun) [...state.switcher.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.dataset.runId === focusedRun)?.focus();
}

function renderResult(root: HTMLElement, run: AnyRun): void {
  root.replaceChildren();
  const response = terminal(run.status) ? subAgentFinalResponse(run.messages) : '';
  const outcome = resolveOutcome(run);
  const text = response || (terminal(run.status) ? outcome?.summary ?? '' : '');
  if (text) {
    const heading = el('h3', 'sub-agent-conversation__speaker', run.status === 'completed' ? 'Final response' : 'Partial response');
    const prose = el('div', 'sub-agent-overlay__answer');
    setAssistantBubbleContent(prose, text);
    root.append(heading, prose);
  } else {
    const empty = run.status === 'queued' ? 'No response yet. The agent is waiting to start.'
      : run.status === 'running' ? 'No final response yet. Follow the Conversation tab for live thoughts and messages.'
      : 'No final response was recorded. The available conversation and tool activity are preserved.';
    root.appendChild(el('p', 'sub-agent-overlay__empty', empty));
  }
  if (!terminal(run.status) || !outcome) return;
  if (outcome.findings.length) {
    const list = el('ul', 'sub-agent-overlay__findings');
    for (const finding of outcome.findings) {
      const item = document.createElement('li');
      item.appendChild(el('strong', '', finding.title));
      if (finding.severity) item.appendChild(el('span', 'sub-agent-overlay__severity', finding.severity));
      item.appendChild(el('p', '', finding.detail));
      if (finding.paths?.length) item.appendChild(el('p', 'sub-agent-overlay__paths', finding.paths.join(', ')));
      list.appendChild(item);
    }
    root.appendChild(list);
  }
  if (outcome.artifacts.length) {
    const artifacts = el('div', 'sub-agent-overlay__artifacts');
    for (const artifact of outcome.artifacts) {
      const span = el('span', 'sub-agent-overlay__artifact', `${artifact.kind}: ${artifact.label}`);
      span.title = artifact.ref;
      artifacts.appendChild(span);
    }
    root.appendChild(artifacts);
  }
  if (run.budgetEvents?.length) {
    const events = el('ul', 'sub-agent-overlay__budget-events');
    for (const event of run.budgetEvents) events.appendChild(el('li', '', event.label));
    root.appendChild(events);
  }
}

function renderFooter(state: OverlayState, run: AnyRun, live: boolean): void {
  const text = subAgentFinalResponse(run.messages) || resolveOutcome(run)?.summary || '';
  const line = live ? subAgentLiveStatusLine(run, true) : run.status === 'completed' ? (text ? 'Agent complete' : 'Agent finished without a response') : 'Available conversation saved';
  const key = JSON.stringify([run.runId, run.status, line, text]);
  if (key === state.footerKey) return;
  state.footerKey = key;
  state.footer.replaceChildren(el('span', 'sub-agent-overlay__footer-status', line));
  if (live) {
    const stop = action('Stop agent', 'stop');
    stop.addEventListener('click', () => cancelSubAgent(run.runId, 'user_cancel'));
    state.footer.appendChild(stop);
  } else if (run.status === 'failed' || run.status === 'cancelled') {
    const retry = action('Retry agent', 'refresh');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        const next = await restartSubAgent(run.runId, { type: run.type, task: run.task, parentChatId: state.chatId, parentTurnId: run.parentTurnId });
        if (overlay === state) setActiveRun(next.runId);
      } catch {
        retry.textContent = 'Retry failed. Try again';
        retry.disabled = false;
      }
    });
    state.footer.appendChild(retry);
  }
  if (terminal(run.status) && text) {
    const copy = action('Copy response', 'copy');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Could not copy'; }
    });
    state.footer.appendChild(copy);
  }
}

function renderActiveRun(state: OverlayState, scroll: 'initial' | 'sticky' = 'sticky'): void {
  const resolved = resolveRun(state.activeRunId, state.chatId);
  if (!resolved) return;
  const { run, live } = resolved;
  const view = viewFor(state);
  const wasNearBottom = state.scroll.scrollHeight - state.scroll.scrollTop - state.scroll.clientHeight < 56;
  state.sheet.setAttribute('aria-label', `Subagent ${taskTitle(run.task)}, ${statusMeta(run.status).label}`);
  state.title.textContent = taskTitle(run.task);
  state.title.title = run.task;
  const duration = run.startedAt && run.endedAt ? formatWorkDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : '';
  state.meta.replaceChildren(badge(run), el('span', '', agentLabel(run.type)));
  if (duration) state.meta.appendChild(el('span', '', duration));
  if (run.toolTurns) state.meta.appendChild(el('span', '', `${run.toolTurns} tool ${run.toolTurns === 1 ? 'call' : 'calls'}`));
  state.promptText.textContent = run.task || 'No assignment was recorded.';
  state.assignment.open = view.assignmentOpen;
  state.details.textContent = `Run ${run.runId}${run.startedAt ? ` · Started ${new Date(run.startedAt).toLocaleString()}` : ''}${run.endedAt ? ` · Ended ${new Date(run.endedAt).toLocaleString()}` : ''}${'modelId' in run && run.modelId ? ` · ${run.modelId}` : ''}`;
  if ('modelSource' in run && run.modelSource) state.details.textContent += ` · ${({ parent: 'Following parent', routing: 'Sub-agent routing', type: 'Type override', explicit: 'Explicit model' } as Record<string, string>)[run.modelSource] || 'Recorded model'}`;
  if (run.resolvedModel && run.resolvedModel.id !== run.modelId) state.details.textContent += ` · Ran on ${run.resolvedModel.id}`;
  for (const tab of state.tabs) {
    const selected = tab.dataset.view === view.tab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  state.transcriptBody.hidden = view.tab !== 'conversation';
  state.structuredRoot.hidden = view.tab !== 'result';
  state.scroll.setAttribute('aria-labelledby', `sub-agent-tab-${view.tab}`);

  const active = run as SubAgentRun;
  const error = active.startError?.message || run.error;
  state.notice.hidden = !error && run.status !== 'queued' && run.status !== 'cancelled';
  const notice = error || (run.status === 'queued' ? 'Waiting for an available agent slot. The conversation will appear when this agent starts.' : run.status === 'cancelled' ? 'Agent stopped. Its available thoughts, responses and tool activity are preserved below.' : '');
  if (state.notice.textContent !== notice) state.notice.textContent = notice;
  state.notice.classList.toggle('sub-agent-overlay__notice--error', Boolean(error));

  const liveTail = subAgentTranscriptLiveFromRun(run, live);
  const disclosures: SubAgentConversationDisclosures = {
    groups: view.groups,
    isThoughtExpanded: (key) => view.thoughts.get(key) ?? true,
    onThoughtExpandedChange: (key, value) => view.thoughts.set(key, value),
    isToolExpanded: (key) => view.tools.get(key) ?? false,
    onToolExpandedChange: (key, value) => view.tools.set(key, value),
  };
  if (liveTail) {
    liveTail.thoughtsExpanded = view.thoughts.get('live') ?? true;
    liveTail.onThoughtsExpandedChange = (open) => view.thoughts.set('live', open);
  }
  // Patch a growing thought in place. Equal-length hydrated corrections must
  // still invalidate every other settled message in the conversation.
  const last = run.messages.length - 1;
  const key = JSON.stringify([run.status, liveTail?.phase, run.messages.map((raw, i) => {
    if (i !== last || liveTail?.phase !== 'thinking' || !raw || typeof raw !== 'object') return raw;
    const row = raw as Record<string, unknown>;
    return { ...row, reasoning: row.reasoning ? true : undefined, reasoning_content: row.reasoning_content ? true : undefined };
  })]);
  if (state.transcriptKey !== key) {
    state.transcriptKey = key;
    renderSubAgentConversation(state.transcriptBody, run.messages, liveTail, run.status, disclosures);
  } else {
    appendTranscriptLiveTail(state.transcriptBody, liveTail, run.messages);
    formatSubAgentProse(state.transcriptBody, liveTail?.partialText);
  }
  if (!run.messages.length && !liveTail && state.transcriptBody.childElementCount === 0) {
    state.transcriptBody.appendChild(el('p', 'sub-agent-overlay__empty', state.loadingRunId === run.runId ? 'Loading conversation…' : run.status === 'queued' ? 'No messages yet.' : 'No conversation was recorded for this run.'));
  }
  const resultKey = JSON.stringify([run.status, run.summary, run.structuredOutcome, run.budgetEvents, subAgentFinalResponse(run.messages)]);
  if (state.resultKey !== resultKey) {
    state.resultKey = resultKey;
    renderResult(state.structuredRoot, run);
  }
  let fallback = state.transcriptBody.querySelector<HTMLElement>('.sub-agent-conversation__reported-result');
  const fallbackText = terminal(run.status) && !subAgentFinalResponse(run.messages) ? resolveOutcome(run)?.summary : '';
  if (fallbackText) {
    state.transcriptBody.querySelector('.sub-agent-overlay__empty')?.remove();
    if (!fallback) { fallback = el('section', 'sub-agent-conversation__reported-result'); state.transcriptBody.appendChild(fallback); }
    if (fallback.dataset.text !== fallbackText) {
      fallback.dataset.text = fallbackText;
      fallback.replaceChildren(el('h3', 'sub-agent-conversation__speaker', run.status === 'completed' ? 'Final response' : 'Reported result'));
      const prose = el('div', 'sub-agent-overlay__answer');
      setAssistantBubbleContent(prose, fallbackText);
      fallback.appendChild(prose);
    }
  } else fallback?.remove();
  renderFooter(state, run, live);
  renderSwitcher(state);
  if (scroll === 'initial') state.scroll.scrollTop = view.scroll || (live ? state.scroll.scrollHeight : 0);
  else if (wasNearBottom && view.tab === 'conversation') state.scroll.scrollTop = state.scroll.scrollHeight;
}

async function loadTranscript(state: OverlayState, runId: string): Promise<void> {
  state.loadingRunId = runId;
  await hydrateSubAgentTranscript(runId);
  if (overlay !== state || state.activeRunId !== runId) return;
  state.loadingRunId = null;
  state.transcriptKey = null;
  renderActiveRun(state);
}
function setActiveRun(runId: string): void {
  if (!overlay || overlay.activeRunId === runId) return;
  const state = overlay;
  viewFor(state).scroll = state.scroll.scrollTop;
  state.activeRunId = runId;
  state.transcriptKey = state.resultKey = state.footerKey = null;
  renderActiveRun(state, 'initial');
  void loadTranscript(state, runId);
}
function handleKey(e: KeyboardEvent): void {
  if (!overlay) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSubAgentDrawer(); return; }
  if (e.key !== 'Tab') return;
  const visible = [...overlay.sheet.querySelectorAll<HTMLElement>('button:not(:disabled), select, summary, [href], [tabindex="0"]')]
    .filter((node) => !node.hidden && node.offsetParent !== null && !node.closest('[hidden]'));
  const first = visible[0], last = visible.at(-1);
  if (!first || !last) return;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function bindSubscription(): void {
  unsubscribe?.();
  unsubscribe = subscribeSubAgentRuns((run) => {
    const state = overlay;
    if (!state || run.parentChatId !== state.chatId || state.refreshFrame != null) return;
    state.refreshFrame = -1;
    const handle = requestAnimationFrame(() => {
      state.refreshFrame = null;
      if (overlay === state) renderActiveRun(state);
    });
    if (state.refreshFrame === -1) state.refreshFrame = handle;
  });
}
export function initSubAgentDrawerLiveUpdates(): void { bindSubscription(); }
export function closeSubAgentDrawer(): void {
  openRequest += 1;
  if (!overlay) return;
  const state = overlay;
  overlay = null;
  document.removeEventListener('keydown', state.onKey, true);
  if (state.refreshFrame != null && state.refreshFrame >= 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.refreshFrame);
  state.root.remove();
  if (state.returnFocus?.isConnected) state.returnFocus.focus();
}
export async function openSubAgentDrawer(runId: string, chatId: string): Promise<void> {
  closeSubAgentDrawer();
  bindSubscription();
  if (resolveRun(runId, chatId)) mountSubAgentDrawer(runId, chatId);
  const request = ++openRequest;
  await hydrateSubAgentRunsForParentChat(chatId, { force: true });
  if (request !== openRequest) return;
  if (!overlay) mountSubAgentDrawer(runId, chatId);
  const state = overlay;
  if (state) await loadTranscript(state, runId);
}
function mountSubAgentDrawer(runId: string, chatId: string): void {
  const mount = resolveSubAgentOverlayMount();
  if (!mount || !resolveRun(runId, chatId)) return;
  const returnFocus = document.activeElement as HTMLElement | null;
  const root = el('div', 'sub-agent-overlay');
  const scrim = el('div', 'sub-agent-overlay__scrim');
  scrim.addEventListener('click', closeSubAgentDrawer);
  const sheet = el('div', 'sub-agent-overlay__sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  const header = el('header', 'sub-agent-overlay__header');
  const heading = el('h2', 'sub-agent-overlay__heading', 'Subagents');
  heading.prepend(createIcon('gitBranch', { size: 16 }));
  const count = el('span', 'sub-agent-overlay__count');
  const expand = action('Expand', 'expand');
  expand.className = 'sub-agent-overlay__icon-btn';
  expand.setAttribute('aria-label', 'Expand panel');
  expand.setAttribute('aria-pressed', 'false');
  expand.replaceChildren(createIcon('expand', { size: 16 }));
  expand.addEventListener('click', () => {
    if (!overlay) return;
    overlay.expanded = !overlay.expanded;
    root.classList.toggle('sub-agent-overlay--expanded', overlay.expanded);
    expand.setAttribute('aria-pressed', String(overlay.expanded));
    expand.setAttribute('aria-label', overlay.expanded ? 'Restore panel size' : 'Expand panel');
    expand.replaceChildren(createIcon(overlay.expanded ? 'compress' : 'expand', { size: 16 }));
  });
  const close = action('Close', 'close');
  close.className = 'sub-agent-overlay__icon-btn';
  close.setAttribute('aria-label', 'Close subagents');
  close.replaceChildren(createIcon('close', { size: 16 }));
  close.addEventListener('click', closeSubAgentDrawer);
  header.append(heading, count, expand, close);
  const layout = el('div', 'sub-agent-overlay__layout');
  const switcher = el('nav', 'sub-agent-overlay__switcher');
  switcher.setAttribute('aria-label', 'Subagents in this chat');
  const main = el('div', 'sub-agent-overlay__main');
  const top = el('div', 'sub-agent-overlay__top');
  const mobileSelect = el('select', 'sub-agent-overlay__mobile-select');
  mobileSelect.setAttribute('aria-label', 'Choose agent');
  mobileSelect.addEventListener('change', () => setActiveRun(mobileSelect.value));
  const title = el('h3', 'sub-agent-overlay__title');
  const meta = el('div', 'sub-agent-overlay__meta');
  const tabsRoot = el('div', 'sub-agent-overlay__tabs');
  tabsRoot.setAttribute('role', 'tablist');
  tabsRoot.setAttribute('aria-label', 'Agent view');
  const tabs = (['conversation', 'result'] as const).map((view) => {
    const tab = action(view === 'conversation' ? 'Conversation' : 'Result');
    tab.className = 'sub-agent-overlay__tab';
    tab.id = `sub-agent-tab-${view}`;
    tab.dataset.view = view;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'sub-agent-view');
    tab.addEventListener('click', () => {
      if (!overlay) return;
      viewFor(overlay).tab = view;
      renderActiveRun(overlay);
      overlay.scroll.scrollTop = 0;
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : view === 'conversation' ? 1 : 0];
      next.click(); next.focus();
    });
    tabsRoot.appendChild(tab);
    return tab;
  });
  top.append(mobileSelect, title, meta, tabsRoot);
  const scroll = el('div', 'sub-agent-overlay__scroll');
  scroll.id = 'sub-agent-view';
  scroll.setAttribute('role', 'tabpanel');
  const assignment = el('details', 'sub-agent-overlay__prompt');
  const summary = el('summary', '', 'Assignment');
  summary.prepend(createIcon('fileText', { size: 14 }));
  const promptText = el('p', 'sub-agent-overlay__prompt-text');
  assignment.append(summary, promptText);
  assignment.addEventListener('toggle', () => { if (overlay) viewFor(overlay).assignmentOpen = assignment.open; });
  const notice = el('div', 'sub-agent-overlay__notice');
  notice.setAttribute('role', 'status');
  const transcriptBody = el('div', 'sub-agent-overlay__body');
  const structuredRoot = el('div', 'sub-agent-overlay__structured');
  const runDetails = el('details', 'sub-agent-overlay__run-details');
  const details = el('p', 'sub-agent-overlay__run-id');
  runDetails.append(el('summary', '', 'Run details'), details);
  scroll.append(assignment, notice, transcriptBody, structuredRoot, runDetails);
  main.append(top, scroll);
  layout.append(switcher, main);
  const footer = el('footer', 'sub-agent-overlay__footer');
  sheet.append(header, layout, footer);
  root.append(scrim, sheet);
  mount.appendChild(root);
  const onKey = (event: KeyboardEvent) => handleKey(event);
  document.addEventListener('keydown', onKey, true);
  overlay = { root, sheet, chatId, activeRunId: runId, expanded: false, returnFocus, onKey,
    switcher, mobileSelect, count, title, meta, assignment, promptText, scroll, tabs,
    structuredRoot, transcriptBody, notice, details, footer, views: new Map(),
    transcriptKey: null, resultKey: null, footerKey: null, switcherKey: null, loadingRunId: runId, refreshFrame: null };
  renderActiveRun(overlay, 'initial');
  requestAnimationFrame(() => root.classList.add('is-open'));
  close.focus();
}
