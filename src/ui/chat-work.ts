import type { Chat } from '../types';
import { CHAT_VIEW_CHANGED, getChatView } from '../appearance/chat-view';
import { collectTranscriptTurns, formatWorkDuration, type TranscriptTurn } from '../chat/transcript-turns';
import { getPerFileChangeSummary } from '../usage/code-change-ledger';
import { createTurnChanges } from './chat-turn-changes';
import { createIcon } from './icon';

interface WorkGroup {
  button: HTMLButtonElement;
  label: HTMLElement;
  detail: HTMLElement;
  expanded: boolean;
  card?: HTMLElement | null;
  cardKey?: string;
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
      if (target.closest('.chat-work, .chat-turn-changes, .msg-bubble, .thoughts-flow')) return false;
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
    detail.setAttribute('role', 'status');
    button.append(label, createIcon('chevronRight', { className: 'chat-work__chevron', size: 14 }), detail);
    const group = { button, label, detail, expanded: expanded.has(fork) };
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
    if (!live && !activity.length && !thoughts.length && !turn.toolCount) {
      group?.button.remove();
      return;
    }
    group ??= makeGroup(turn.fork);
    if (group.button.nextElementSibling !== rows[0]) mount.insertBefore(group.button, rows[0]);
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
    group.label.textContent = live ? `Working${duration ? ` · ${duration}` : '…'}`
      : `${failed ? 'Failed' : stopped ? 'Stopped' : 'Worked'}${duration ? ` for ${duration}` : ''}`;
    const runningTool = rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>('.tool-call-summary--running'))).at(-1);
    const latestAssistant = assistants.at(-1);
    const toolText = runningTool?.querySelector('.tool-call-action')?.textContent
      || latestAssistant?.querySelector('.tool-start-indicator__label')?.textContent;
    const runtime = latestAssistant?.querySelector('.stream-status__detail')?.textContent?.trim();
    const phaseLabel = latestAssistant?.querySelector('.stream-status:not(.hidden) .stream-status__label')?.textContent;
    const thinking = assistants.some((row) => row.dataset.streamPhase === 'thinking' || row.querySelector('.thoughts-panel-wrap--live'));
    const detailText = live ? [toolText || (thinking ? 'Thinking' : phaseLabel || 'Generating response'), runtime].filter(Boolean).join(' · ')
      : turn.toolCount ? `${turn.toolCount} tool call${turn.toolCount === 1 ? '' : 's'}` : '';
    if (group.detail.textContent !== detailText) group.detail.textContent = detailText;
    group.button.setAttribute('aria-label', `${group.label.textContent}. ${full ? 'Full transcript' : show ? 'Hide working transcript' : 'Show working transcript'}`);
    const controlled: string[] = [];
    for (const row of activity) {
      // Errors, stopped markers and questions remain actionable while collapsed.
      const attention = row.matches('.msg--failed, .msg--stopped, .msg--truncated, .tool-call-msg--fail')
        || Boolean(row.querySelector('.tool-call-error, .msg-bubble--error'))
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
      if (!(node instanceof HTMLElement) || node.matches('.chat-work, .chat-turn-changes')) continue;
      if (node.matches('#queuedTranscript, .queued-transcript')) continue;
      const index = node.dataset.historyIndex;
      if (index != null && Number(index) < (turns[0]?.fork ?? 0)) continue;
      current = (index != null ? byIndex.get(Number(index)) : undefined) ?? current ?? turns.at(-1);
      if (!current || node.matches('.msg.user')) continue;
      if (!node.matches('.msg.assistant, .tool-call-msg, .tool-start-indicator, .sub-agent-card, .msg-stopped-row')) continue;
      const bucket = buckets.get(current) ?? [];
      bucket.push(node);
      buckets.set(current, bucket);
    }
    const streaming = isStreaming();
    const primaryFork = primaryTurnFork(turns, streaming);
    for (const [turn, rows] of buckets) {
      syncGroup(turn, rows, streaming && turn === turns.at(-1), full, primaryFork);
    }
    const mounted = new Set(Array.from(buckets.keys(), (turn) => turn.fork));
    for (const [fork, group] of groups) {
      if (mounted.has(fork)) continue;
      group.button.remove();
      group.card?.remove();
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
    observer.disconnect();
    for (const group of groups.values()) { group.button.remove(); group.card?.remove(); }
    for (const row of mount.querySelectorAll('.chat-work-hidden')) row.classList.remove('chat-work-hidden');
    if (frame !== undefined) view!.cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    view!.removeEventListener(CHAT_VIEW_CHANGED, onPreference);
    controllers.delete(mount);
  }
  view.addEventListener(CHAT_VIEW_CHANGED, onPreference);
  controllers.set(mount, { chat, sync, dispose });
  sync();
}

export function disposeChatWorkView(mount: HTMLElement): void {
  controllers.get(mount)?.dispose();
}

/** Collapse an expanded thoughts toggle without toggling closed rows open. */
function collapseThoughtsToggle(toggle: HTMLButtonElement): void {
  const flowId = toggle.getAttribute('aria-controls');
  const flow = flowId ? toggle.ownerDocument.getElementById(flowId) : toggle.nextElementSibling;
  if (flow instanceof HTMLElement) flow.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.querySelector('.thoughts-caret')?.classList.remove('thoughts-caret--expanded');
}
