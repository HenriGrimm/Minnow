import type { Chat } from '../types';
import { CHAT_VIEW_CHANGED, getChatView } from '../appearance/chat-view';
import { collectTranscriptTurns, formatWorkDuration, type TranscriptTurn } from '../chat/transcript-turns';
import { formatTurnSummary, narrationSentence, summarizeTurn, type TurnSummary } from '../chat/turn-summary';
import { getPerFileChangeSummary } from '../usage/code-change-ledger';
import { createTurnChanges } from './chat-turn-changes';
import { createTurnTodoPanel, getTurnTodos } from './todo-panel';
import { createIcon } from './icon';
import { observeChatScrollLayout } from './chat-scroll';

interface WorkGroup {
  button: HTMLButtonElement;
  label: HTMLElement;
  detail: HTMLElement;
  activity: HTMLElement;
  expanded: boolean;
  card?: HTMLElement | null;
  cardKey?: string;
  todos?: HTMLDetailsElement | null;
  todosKey?: string;
  summary?: TurnSummary;
  summaryKey?: string;
  detailKey?: string;
}

const controllers = new WeakMap<HTMLElement, { chat: Chat; sync: () => void; dispose: () => void }>();
const expandedByChat = new WeakMap<Chat, Set<number>>();
let nextId = 0;

/**
 * Keep transcript rows at their original mount: stream owners, tool insertion,
 * history backfill, and message actions all retain the same nodes and indices.
 * The disclosure controls those rows via aria-controls and a visibility class.
 */
export function installChatWorkView(mount: HTMLElement, chat: Chat, isStreaming: () => boolean): void {
  const view = mount.ownerDocument.defaultView;
  if (!view) return;
  const previous = controllers.get(mount);
  if (previous?.chat === chat) { previous.sync(); return; }
  previous?.dispose();
  const disposeScrollLayout = observeChatScrollLayout(mount);
  const groups = new Map<number, WorkGroup>();
  const expanded = expandedByChat.get(chat) ?? new Set<number>();
  expandedByChat.set(chat, expanded);
  let closedToolDetails = new WeakSet<Element>();
  let closedThoughts = new WeakSet<Element>();
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function schedule(): void {
    if (disposed || frame !== undefined) return;
    frame = view!.requestAnimationFrame(() => { frame = undefined; sync(); });
  }

  const observer = new view.MutationObserver((records) => {
    if (records.some((record) => {
      const target = record.target instanceof view.Element ? record.target : record.target.parentElement;
      if (!target) return false;
      // Streaming markdown can change every token; only structural/phase changes
      // affect the work disclosure. Never walk the transcript for prose deltas.
      if (target.closest('.chat-work, .chat-turn-changes, .chat-turn-todos, .msg-bubble, .thoughts-flow')) return false;
      return record.type === 'childList' || record.type === 'attributes';
    })) schedule();
  });

  function makeGroup(fork: number): WorkGroup {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-work';
    const label = document.createElement('span');
    label.className = 'chat-work__label';
    const detail = document.createElement('span');
    detail.className = 'chat-work__detail';
    const activity = document.createElement('span');
    activity.className = 'chat-work__activity';
    activity.setAttribute('role', 'status');
    button.append(label, createIcon('chevronRight', { className: 'chat-work__chevron', size: 14 }), detail, activity);
    const group: WorkGroup = { button, label, detail, activity, expanded: expanded.has(fork) };
    button.addEventListener('click', () => {
      group.expanded = !group.expanded;
      if (group.expanded) expanded.add(fork); else expanded.delete(fork);
      sync();
    });
    groups.set(fork, group);
    return group;
  }

  function showActivity(node: HTMLElement, show: boolean, group: WorkGroup): void {
    if (!show && node.contains(document.activeElement)) group.button.focus();
    node.classList.toggle('chat-work-hidden', !show);
    if (!node.id) node.id = `chat-work-item-${++nextId}`;
  }

  function primaryTurnFork(turns: TranscriptTurn[], live: boolean): number | null {
    let fork: number | null = null;
    for (const turn of turns) {
      if (live && turn === turns.at(-1)) continue;
      if (getPerFileChangeSummary(chat, turn.fork + 1, turn.end).length) fork = turn.fork;
    }
    return fork;
  }

  function syncTurnChangeActions(): void {
    void import('./code-change-strip-actions').then((m) => m.syncCodeChangeStripActionsVisibility(chat));
    void import('./composer-undo').then((m) => m.syncComposerUndoFromActiveChat());
  }

  function syncGroup(
    turn: TranscriptTurn,
    rows: HTMLElement[],
    live: boolean,
    full: boolean,
    primaryFork: number | null,
    activeCompactions: ReadonlySet<number> | undefined,
    activeKey: string,
  ): void {
    let group = groups.get(turn.fork);
    const assistants = rows.filter((row) => row.matches('.msg.assistant'));
    const final = live ? undefined : assistants.find((row) => Number(row.dataset.historyIndex) === turn.finalIndex)
      ?? assistants.filter((row) => !row.hasAttribute('data-history-index')
        && !row.matches('[data-turn-kind="assistant-tools"], .msg--awaiting-prose')).at(-1);
    const thoughts = final ? Array.from(final.querySelectorAll<HTMLElement>(':scope > .thoughts-panel-wrap, :scope > .thought-stage')) : [];
    const activity = rows.filter((row) => row !== final);
    if (final) {
      final.classList.remove('chat-work-hidden');
      final.classList.add('chat-turn-final');
    }
    // The active checkpoint divider is a boundary, not work: alone it earns no disclosure.
    const work = activity.filter((row) => !row.matches('.compaction-divider:not(.compaction-divider--superseded)'));
    if (!live && !work.length && !thoughts.length && !turn.toolCount) {
      group?.button.remove();
      return;
    }
    group ??= makeGroup(turn.fork);
    if ((group.todos?.nextElementSibling ?? group.button.nextElementSibling) !== rows[0]) mount.insertBefore(group.button, rows[0]);
    const todos = getTurnTodos(chat, turn.fork, turn.end);
    const todosKey = JSON.stringify(todos);
    if (group.todosKey !== todosKey) {
      const wasOpen = group.todos?.open;
      group.todos?.remove();
      group.todos = createTurnTodoPanel(todos);
      if (group.todos && wasOpen !== undefined) group.todos.open = wasOpen;
      group.todosKey = todosKey;
    }
    if (group.todos && group.button.nextElementSibling !== group.todos) group.button.after(group.todos);
    const show = full || group.expanded;
    group.button.setAttribute('aria-expanded', String(show));
    // Full view is deliberately always open; no misleading collapse affordance.
    group.button.disabled = full;
    group.button.classList.toggle('chat-work--live', live);
    const run = turn.run;
    const stopped = run?.status === 'stopped' || rows.some((row) => row.matches('.msg--stopped'));
    const failed = run?.status === 'failed' || rows.some((row) => row.matches('.msg--failed') || row.querySelector('.msg-bubble--error'));
    const duration = run && (live || run.endedAt != null)
      ? formatWorkDuration((live ? Date.now() : run.endedAt!) - run.createdAt) : '';
    group.label.textContent = live ? `Working${duration ? ` · ${duration}` : '…'}` : endLabel(run, failed, stopped, duration);

    const summaryKey = `${turn.end}:${run?.runId ?? ''}:${run?.endedAt ?? ''}:${activeKey}`;
    if (live || group.summaryKey !== summaryKey) {
      group.summary = summarizeTurn(chat.history, turn.fork, turn.end, { activeCompactions });
      group.summaryKey = summaryKey;
    }
    const runningAgents = rows.reduce((n, row) =>
      n + (row.matches('.sub-agent-card--active') ? 1 : 0) + row.querySelectorAll('.sub-agent-card--active').length, 0);
    const tally = full ? undefined : group.summary;
    paintTally(group, tally, runningAgents);

    let activityText = '';
    if (live) {
      const runningTool = rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>('.tool-call-summary--running'))).at(-1);
      const latestAssistant = assistants.at(-1);
      // Narration counts only when the round in flight wrote it; older prose is stale.
      const bubble = latestAssistant?.querySelector(':scope > .msg-bubble:not(.msg-bubble--awaiting):not(.msg-bubble--error)');
      const narration = bubble?.textContent ? narrationSentence(bubble.textContent) : '';
      const toolText = runningTool?.querySelector('.tool-call-action')?.textContent
        || latestAssistant?.querySelector('.tool-start-indicator__label')?.textContent;
      const runtime = latestAssistant?.querySelector('.stream-status__detail')?.textContent?.trim();
      const phaseLabel = latestAssistant?.querySelector('.stream-status:not(.hidden) .stream-status__label')?.textContent;
      const thinking = assistants.some((row) => row.dataset.streamPhase === 'thinking' || row.querySelector('.thoughts-panel-wrap--live'));
      activityText = [narration || toolText || (thinking ? 'Thinking' : phaseLabel || 'Generating response'), runtime].filter(Boolean).join(' · ');
    }
    if (group.activity.textContent !== activityText) group.activity.textContent = activityText;
    const tallyText = tally ? formatTurnSummary(tally) : '';
    group.button.setAttribute('aria-label', [group.label.textContent, tallyText,
      full ? 'Full transcript' : show ? 'Hide working transcript' : 'Show working transcript'].filter(Boolean).join('. '));
    const controlled: string[] = [];
    for (const row of activity) {
      // Recovery controls, the active checkpoint and open questions stay reachable while collapsed.
      const attention = row.matches('.msg--failed, .msg--stopped, .msg--truncated')
        || Boolean(row.querySelector('.msg-bubble--error'))
        || row.matches('.compaction-divider:not(.compaction-divider--superseded)')
        || (live && row.dataset.toolName === 'ask_question');
      showActivity(row, show || attention, group);
      for (const thought of row.querySelectorAll('.thoughts-panel-wrap, .thought-stage')) thought.classList.remove('chat-work-hidden');
      controlled.push(row.id);
    }
    for (const thought of thoughts) {
      showActivity(thought, show, group);
      controlled.push(thought.id);
    }
    group.button.setAttribute('aria-controls', controlled.join(' '));
    for (const row of rows) {
      for (const details of row.querySelectorAll<HTMLDetailsElement>('.tool-call-details')) {
        if (!closedToolDetails.has(details)) { details.open = false; closedToolDetails.add(details); }
      }
      for (const toggle of row.querySelectorAll<HTMLButtonElement>('.thoughts-toggle')) {
        if (closedThoughts.has(toggle)) continue;
        if (toggle.getAttribute('aria-expanded') === 'true') collapseThoughtsToggle(toggle);
        closedThoughts.add(toggle);
      }
    }
    if (!live) {
      const key = `${turn.end}:${run?.endedAt ?? ''}:${turn.fork === primaryFork ? 'primary' : ''}`;
      if (group.cardKey !== key) {
        group.card?.remove();
        group.card = createTurnChanges(chat, turn.fork + 1, turn.end, {
          primary: turn.fork === primaryFork,
        });
        group.cardKey = key;
        if (turn.fork === primaryFork) syncTurnChangeActions();
      }
      const last = rows.at(-1)!;
      if (group.card && last.nextElementSibling !== group.card) last.after(group.card);
    } else {
      group.card?.remove();
      group.cardKey = undefined;
    }
  }

  function sync(): void {
    if (disposed) return;
    observer.disconnect();
    if (timer) { clearTimeout(timer); timer = undefined; }
    const full = getChatView() === 'full';
    mount.classList.add('chat-thread');
    mount.dataset.chatView = full ? 'full' : 'compact';
    const turns = collectTranscriptTurns(chat);
    const byIndex = new Map<number, TranscriptTurn>();
    for (const turn of turns) for (let i = turn.fork; i <= turn.end; i++) byIndex.set(i, turn);
    const buckets = new Map<TranscriptTurn, HTMLElement[]>();
    let current: TranscriptTurn | undefined;
    for (const node of Array.from(mount.children)) {
      if (!(node instanceof HTMLElement) || node.matches('.chat-work, .chat-turn-changes, .chat-turn-todos')) continue;
      if (node.matches('#queuedTranscript, .queued-transcript')) continue;
      const index = node.dataset.historyIndex;
      if (index != null && Number(index) < (turns[0]?.fork ?? 0)) continue;
      current = (index != null ? byIndex.get(Number(index)) : undefined) ?? current ?? turns.at(-1);
      if (!current || node.matches('.msg.user')) continue;
      if (!node.matches('.msg.assistant, .tool-call-msg, .tool-start-indicator, .sub-agent-card, .msg-stopped-row, .compaction-divider')) continue;
      const bucket = buckets.get(current) ?? [];
      bucket.push(node);
      buckets.set(current, bucket);
    }
    const streaming = isStreaming();
    const primaryFork = primaryTurnFork(turns, streaming);
    const activeCompactions = new Set(Array.from(
      mount.querySelectorAll<HTMLElement>(':scope > .compaction-divider:not(.compaction-divider--superseded)'),
      (divider) => Number(divider.dataset.historyIndex),
    ).filter(Number.isFinite));
    const activeKey = [...activeCompactions].join(',');
    for (const [turn, rows] of buckets) {
      // No divider mounted yet (backfill still running): let the summary use the latest checkpoint.
      syncGroup(turn, rows, streaming && turn === turns.at(-1), full, primaryFork,
        activeCompactions.size ? activeCompactions : undefined, activeKey);
    }
    const mounted = new Set(Array.from(buckets.keys(), (turn) => turn.fork));
    for (const [fork, group] of groups) {
      if (mounted.has(fork)) continue;
      group.button.remove();
      group.card?.remove();
      group.todos?.remove();
      groups.delete(fork);
    }
    observer.observe(mount, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'data-history-index', 'data-stream-phase', 'data-turn-kind'] });
    if (streaming) timer = setTimeout(() => { if (mount.isConnected) sync(); else dispose(); }, 1000);
  }

  function onPreference(): void {
    if (!mount.isConnected) { dispose(); return; }
    closedToolDetails = new WeakSet<Element>();
    closedThoughts = new WeakSet<Element>();
    if (getChatView() === 'compact') {
      expanded.clear();
      for (const group of groups.values()) group.expanded = false;
    }
    sync();
  }
  function dispose(): void {
    disposed = true;
    disposeScrollLayout();
    observer.disconnect();
    for (const group of groups.values()) { group.button.remove(); group.card?.remove(); group.todos?.remove(); }
    for (const row of mount.querySelectorAll('.chat-work-hidden')) row.classList.remove('chat-work-hidden');
    if (frame !== undefined) view!.cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    view!.removeEventListener(CHAT_VIEW_CHANGED, onPreference);
    view!.removeEventListener('minnow:todos-changed', schedule);
    controllers.delete(mount);
  }
  view.addEventListener(CHAT_VIEW_CHANGED, onPreference);
  view.addEventListener('minnow:todos-changed', schedule);
  controllers.set(mount, { chat, sync, dispose });
  sync();
}

export function disposeChatWorkView(mount: HTMLElement): void {
  controllers.get(mount)?.dispose();
}

function endLabel(run: TranscriptTurn['run'], failed: boolean, stopped: boolean, duration: string): string {
  const after = duration ? ` after ${duration}` : '';
  if (failed) return `Failed${after}`;
  if (stopped) {
    const reason = run?.stopReason;
    return `${reason === 'user' ? 'Stopped by you' : reason === 'timeout' ? 'Timed out' : reason === 'system' ? 'Interrupted' : 'Stopped'}${after}`;
  }
  if (run?.endReason === 'max_tool_turns') return `Hit tool limit${after}`;
  return `Worked${duration ? ` for ${duration}` : ''}`;
}

/** Tally spans; rebuilt only when the text changes so live ticks don't churn the button. */
function paintTally(group: WorkGroup, summary: TurnSummary | undefined, runningAgents: number): void {
  const key = summary ? `${formatTurnSummary(summary)}|${runningAgents}` : '';
  if (group.detailKey === key) return;
  group.detailKey = key;
  const parts: HTMLElement[] = [];
  for (const entry of summary?.entries ?? []) {
    const item = document.createElement('span');
    item.className = 'chat-work__item';
    item.dataset.kind = entry.kind;
    item.textContent = entry.kind === 'agents' && runningAgents ? `${entry.text} · ${runningAgents} running` : entry.text;
    if (entry.failed) {
      const failed = document.createElement('span');
      failed.className = 'chat-work__failed';
      failed.textContent = ` · ${entry.failed} failed`;
      item.append(failed);
    }
    parts.push(item);
  }
  if (summary?.overflow) {
    const more = document.createElement('span');
    more.className = 'chat-work__item chat-work__more';
    more.textContent = `+${summary.overflow} more`;
    parts.push(more);
  }
  group.detail.replaceChildren(...parts);
}

/** Collapse an expanded thoughts toggle without toggling closed rows open. */
function collapseThoughtsToggle(toggle: HTMLButtonElement): void {
  const flowId = toggle.getAttribute('aria-controls');
  const flow = flowId ? toggle.ownerDocument.getElementById(flowId) : toggle.nextElementSibling;
  if (flow instanceof HTMLElement) flow.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.querySelector('.thoughts-caret')?.classList.remove('thoughts-caret--expanded');
}
