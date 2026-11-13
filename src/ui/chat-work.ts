import type { Chat, ChatTodo } from '../types';
import { CHAT_VIEW_CHANGED, getChatView, type ChatView } from '../appearance/chat-view';
import { collectTranscriptTurns, formatWorkDuration, type TranscriptTurn } from '../chat/transcript-turns';
import { formatTurnSummary, narrationSentence, summarizeTurn, type TurnSummary } from '../chat/turn-summary';
import { getPerFileChangeSummary } from '../usage/code-change-ledger';
import { createTurnChanges } from './chat-turn-changes';
import { getTurnPresentedFiles } from '../chat/presented-files';
import { createPresentedFileCards } from './presented-file-cards';
import { createTurnTodoPanel, getTurnTodos, updateTodoPanel } from './todo-panel';
import { getChatTodos } from '../state/sessions';
import { streamingChatIds } from '../app-state';
import { markPreviewOccluder } from './preview-occlusion';
import { createIcon } from './icon';
import { observeChatScrollLayout } from './chat-scroll';
import { supportsLocalHistoryMutation, supportsManagedHistoryMutation } from '../state/chat-relationships';
import { subscribeManagedChatMetadata } from '../chat/managed-chat-view';
import { groupWorkedToolRows } from './chat-work-tool-groups';
import { TOOL_START_INDICATOR_CHANGED } from './stream-status';

interface WorkGroup {
  button: HTMLButtonElement;
  status: HTMLElement;
  statusKey?: string;
  label: HTMLElement;
  detail: HTMLElement;
  activity: HTMLElement;
  expanded: boolean;
  card?: HTMLElement | null;
  cardKey?: string;
  presentedFiles?: HTMLElement | null;
  presentedFilesKey?: string;
  foot?: HTMLElement | null;
  replies?: HTMLElement[];
  todos?: HTMLDetailsElement | null;
  todosKey?: string;
  summary?: TurnSummary;
  summaryKey?: string;
  detailKey?: string;
}

/** Text that ticks on a timer during a stream; never worth a transcript walk. */
const LIVE_TEXT_LEAVES = '.stream-status__label, .stream-status__detail, .stream-status__elapsed, .tool-start-indicator__detail, .thoughts-toggle__label, .reasoning-summary-activity__elapsed';

const controllers = new WeakMap<HTMLElement, { chat: Chat; sync: () => void; dispose: () => void }>();
const expandedByChat = new WeakMap<Chat, Set<number>>();
const todoDisclosureByChat = new WeakMap<Chat, boolean>();
let nextId = 0;

/**
 * Keep assistant rows at their original mount. Tool groups reuse the original
 * call nodes and indices so history backfill and message actions stay attached.
 * The disclosure controls those rows via aria-controls and a visibility class.
 */
export function installChatWorkView(mount: HTMLElement, chat: Chat, isStreaming: () => boolean, options: { view?: ChatView; expanded?: Set<number>; isolated?: boolean } = {}): void {
  const view = mount.ownerDocument.defaultView;
  if (!view) return;
  const previous = controllers.get(mount);
  if (previous?.chat === chat) { previous.sync(); return; }
  previous?.dispose();
  const disposeScrollLayout = options.isolated ? () => {} : observeChatScrollLayout(mount);
  const todoViewport = !options.isolated && mount.parentElement?.matches('.chat-viewport') ? mount.parentElement : null;
  let todoPanel: HTMLDetailsElement | null = null;
  let todoPanelKey: string | undefined;
  let hadLiveTodos = false;
  const groups = new Map<number, WorkGroup>();
  const expanded = options.expanded ?? expandedByChat.get(chat) ?? new Set<number>();
  if (!options.expanded) expandedByChat.set(chat, expanded);
  const chatView = () => options.view ?? getChatView();
  const syncRunStatus = (duration: string | null, toolCount?: number) => {
    if (!options.isolated) paintRunStatus(duration, toolCount);
  };
  let closedToolDetails = new WeakSet<Element>();
  let closedThoughts = new WeakSet<Element>();
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** The live turn as of the last full sync; the 1s tick repaints its line from this alone. */
  let liveView: LiveView | null = null;

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
      if (target.closest('.chat-work, .chat-turn-changes, .chat-turn-todos, .chat-presented-files, .chat-reply-foot, .msg-bubble, .thoughts-flow, .managed-chat-requests')) return false;
      // Token counts and elapsed clocks rewrite every ~80ms while streaming; the
      // 1s live tick picks them up. Phase changes still land via classes/data-stream-phase.
      if (target.closest(LIVE_TEXT_LEAVES)) return false;
      return record.type === 'childList' || record.type === 'attributes';
    })) schedule();
  });

  function makeGroup(fork: number): WorkGroup {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-work';
    const status = document.createElement('span');
    status.className = 'chat-work__status';
    status.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'chat-work__label';
    const detail = document.createElement('span');
    detail.className = 'chat-work__detail';
    const activity = document.createElement('span');
    activity.className = 'chat-work__activity';
    activity.setAttribute('role', 'status');
    // Outcome glyph, duration and tally read as one quiet line; the chevron trails the tally.
    button.append(status, label, detail, createIcon('chevronRight', { className: 'chat-work__chevron', size: 14 }), activity);
    const group: WorkGroup = { button, status, label, detail, activity, expanded: expanded.has(fork) };
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
    if (options.isolated) return;
    void import('./code-change-strip-actions').then((m) => m.syncCodeChangeStripActionsVisibility(chat));
    void import('./composer-undo').then((m) => m.syncComposerUndoFromActiveChat());
  }

  function syncFloatingTodos(turns: TranscriptTurn[]): void {
    if (!todoViewport) return;
    let todos: ChatTodo[] | undefined;
    if (turns.length && mount.querySelector(':scope > .msg, :scope > .tool-call-msg, :scope > .tool-call-batch')) {
      const saved = getChatTodos(chat);
      const localStream = streamingChatIds.has(chat.id);
      if (localStream && saved) hadLiveTodos = true;
      // Live state can land ahead of the transcript receipt, including a clear.
      if (chat.chatCommandVersion === 1 || (localStream && hadLiveTodos)) {
        todos = saved;
      } else {
        for (let i = turns.length - 1; i >= 0 && todos === undefined; i--) {
          todos = getTurnTodos(chat, turns[i].fork, turns[i].end);
        }
        todos ??= saved;
      }
      if (!localStream) hadLiveTodos = false;
    }
    if (!todos?.length) {
      todoPanel?.remove();
      todoPanel = null;
      todoPanelKey = undefined;
      todoDisclosureByChat.delete(chat);
      return;
    }
    const key = JSON.stringify(todos);
    if (todoPanelKey === key) return;
    if (todoPanel) {
      updateTodoPanel(todoPanel, todos);
    } else {
      todoPanel = createTurnTodoPanel(todos, true)!;
      const panel = todoPanel;
      panel.querySelector('summary')!.addEventListener('click', () => todoDisclosureByChat.set(chat, !panel.open));
      markPreviewOccluder(panel);
      todoViewport.append(panel);
    }
    todoPanel.open = todoDisclosureByChat.get(chat) ?? todos.some(item => item.status !== 'completed');
    todoPanelKey = key;
  }

  function syncGroup(
    turn: TranscriptTurn,
    rows: HTMLElement[],
    live: boolean,
    full: boolean,
    primaryFork: number | null,
    activeCompactions: ReadonlySet<number> | undefined,
    activeKey: string,
    latest: boolean,
  ): void {
    const interrupted = turn.executionStatus ? ['failed', 'stopped', 'recovery_required'].includes(turn.executionStatus)
      : turn.run?.status === 'failed' || turn.run?.status === 'stopped';
    // A parent's prose round can settle before its children and their delivery.
    // Queued/waiting cards count too, even when they have no generating spinner.
    const waitingForAgents = !interrupted && !chat.subAgentAutoResumeBlocked && (
      latest && Boolean(chat.agentTaskAttention?.pendingCount)
      || rows.some(row => row.matches('.sub-agent-card--active, .sub-agent-card[data-status="running"], .sub-agent-card[data-status="queued"], .sub-agent-group[data-live="true"]')
        || Boolean(row.querySelector('.sub-agent-card--active, .sub-agent-card[data-status="running"], .sub-agent-card[data-status="queued"]'))));
    const parentSettled = turn.executionStatus == null || turn.executionStatus === 'completed';
    const executionStatus = parentSettled && !interrupted
      ? latest && chat.agentPendingCommand ? 'queued' : waitingForAgents ? 'waiting_for_agents' : turn.executionStatus
      : turn.executionStatus;
    const recovery = executionStatus === 'recovery_required';
    const terminal = executionStatus != null && ['completed', 'failed', 'stopped', 'recovery_required'].includes(executionStatus);
    live = live && !terminal;
    const pending = executionStatus != null && !terminal;
    const ongoing = live || pending;
    const firstMountedRow = rows[0];
    rows = rows.filter(row => !row.hidden);
    if (!ongoing) rows = groupWorkedToolRows(rows);
    const firstRow = rows[0] ?? firstMountedRow;
    let group = groups.get(turn.fork);
    const assistants = rows.filter((row) => row.matches('.msg.assistant'));
    const final = ongoing ? undefined : assistants.find((row) => Number(row.dataset.historyIndex) === turn.finalIndex)
      ?? assistants.filter((row) => !row.hasAttribute('data-history-index')
        && !row.matches('[data-turn-kind="assistant-tools"], .msg--awaiting-prose')).at(-1);
    const finalIndices = new Set(ongoing ? [] : turn.finalIndices);
    const replies = assistants.filter((row) => row === final || finalIndices.has(Number(row.dataset.historyIndex)));
    const replyRows = new Set(replies);
    const thoughts = replies.flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>(':scope > .thoughts-panel-wrap, :scope > .thought-stage')));
    const activity = rows.filter((row) => !replyRows.has(row));
    for (const row of assistants) {
      row.classList.toggle('chat-turn-final', replyRows.has(row));
      if (replyRows.has(row)) row.classList.remove('chat-work-hidden', ...STEP_CLASSES);
    }
    // The active checkpoint divider is a boundary, not work: alone it earns no disclosure.
    const work = activity.filter((row) => !row.matches('.compaction-divider:not(.compaction-divider--superseded)'));
    const hasActivity = Boolean(work.length || thoughts.length || turn.toolCount);
    const run = turn.run;
    const elapsedMs = run && (live || run.endedAt != null)
      ? (live ? Date.now() : run.endedAt!) - run.createdAt : live ? undefined : turn.workDurationMs;
    const duration = elapsedMs != null && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? formatWorkDuration(elapsedMs) : '';
    if (!ongoing && !hasActivity && !duration && !executionStatus) {
      group?.button.remove();
      return;
    }
    group ??= makeGroup(turn.fork);
    if ((group.todos?.nextElementSibling ?? group.button.nextElementSibling) !== firstRow) mount.insertBefore(group.button, firstRow);
    if (!todoViewport) {
      const todos = getTurnTodos(chat, turn.fork, turn.end) ?? [];
      const todosKey = JSON.stringify(todos);
      if (group.todosKey !== todosKey) {
        const wasOpen = group.todos?.open;
        group.todos?.remove();
        group.todos = createTurnTodoPanel(todos);
        if (group.todos && wasOpen !== undefined) group.todos.open = wasOpen;
        group.todosKey = todosKey;
      }
      if (group.todos && group.button.nextElementSibling !== group.todos) group.button.after(group.todos);
    }
    // A live turn draws its steps in place; the composer status line carries elapsed time.
    const show = full || group.expanded || live || pending && !options.isolated;
    group.button.classList.toggle('chat-work--live-hidden', live && !options.isolated);
    if (hasActivity) group.button.setAttribute('aria-expanded', String(show));
    else group.button.removeAttribute('aria-expanded');
    // Full view stays open; a duration alone has no activity to expand.
    group.button.disabled = full || !hasActivity;
    group.button.classList.toggle('chat-work--live', ongoing);
    const stopped = executionStatus ? executionStatus === 'stopped' : run?.status === 'stopped' || rows.some((row) => row.matches('.msg--stopped'));
    const failed = executionStatus ? executionStatus === 'failed' : run?.status === 'failed' || rows.some((row) => row.matches('.msg--failed') || row.querySelector('.msg-bubble--error'));
    setText(group.label, recovery ? `Needs recovery${duration ? ` after ${duration}` : ''}`
      : pending ? pendingLabel(executionStatus, duration) : live ? workingLabel(duration) : endLabel(run, failed, stopped, duration));
    const outcome: WorkOutcome = recovery ? 'recovery' : failed ? 'failed' : stopped ? 'stopped' : live || pending ? 'live' : 'done';
    paintStatus(group, outcome);
    group.button.dataset.outcome = outcome;

    const summaryKey = `${turn.end}:${run?.runId ?? ''}:${run?.endedAt ?? ''}:${activeKey}`;
    if (live || group.summaryKey !== summaryKey) {
      group.summary = summarizeTurn(chat.history, turn.fork, turn.end, { activeCompactions });
      group.summaryKey = summaryKey;
    }
    const runningAgents = rows.reduce((n, row) =>
      n + (row.matches('.sub-agent-card--active') ? 1 : 0) + row.querySelectorAll('.sub-agent-card--active').length, 0);
    const tally = full ? undefined : group.summary;
    paintTally(group, tally, runningAgents);

    setText(group.activity, live ? liveActivityText(mount, rows, assistants) : '');
    const ariaTail = [tally ? formatTurnSummary(tally) : '',
      hasActivity ? full ? 'Full transcript' : show ? 'Hide working transcript' : 'Show working transcript' : ''];
    setAttr(group.button, 'aria-label', workAriaLabel(group, ariaTail));
    if (live) liveView = { group, turn, rows, assistants, ariaTail, historyLength: chat.history.length };
    const controlled: string[] = [];
    for (const row of activity) {
      // Corrections, recovery controls, the active checkpoint and open questions stay visible while collapsed.
      const attention = row.matches('.msg--failed, .msg--stopped, .msg--truncated')
        || row.matches('.sub-agent-card--persistent:not([data-status="completed"]):not([data-status="cancelled"]), .sub-agent-group[data-live="true"]')
        || Boolean(row.querySelector('.sub-agent-card--persistent[data-status="failed"]'))
        || Boolean(row.querySelector('.msg-bubble--error'))
        || row.matches('.compaction-divider:not(.compaction-divider--superseded)')
        || (live && (row.dataset.toolName === 'ask_question'
          || Boolean(row.querySelector('[data-tool-name="ask_question"]'))));
      showActivity(row, show || attention, group);
      for (const thought of row.querySelectorAll('.thoughts-panel-wrap, .thought-stage')) thought.classList.remove('chat-work-hidden');
      controlled.push(row.id);
    }
    for (const thought of thoughts) {
      showActivity(thought, show, group);
      controlled.push(thought.id);
    }
    // Thousands of ids on a long run; rewriting them each sync churns the accessibility tree.
    if (controlled.length) setAttr(group.button, 'aria-controls', controlled.join(' '));
    else group.button.removeAttribute('aria-controls');
    paintSteps(activity, full, live);
    if (live) syncRunStatus(duration, turn.toolCount);
    for (const row of rows) {
      const toolDetails = [
        ...(row.matches('.tool-call-batch') ? [row as HTMLDetailsElement] : []),
        ...row.querySelectorAll<HTMLDetailsElement>('.tool-call-details'),
      ];
      for (const details of toolDetails) {
        if (!closedToolDetails.has(details)) { details.open = false; closedToolDetails.add(details); }
      }
      for (const toggle of row.querySelectorAll<HTMLButtonElement>('.thoughts-toggle')) {
        if (closedThoughts.has(toggle)) continue;
        if (toggle.getAttribute('aria-expanded') === 'true') collapseThoughtsToggle(toggle);
        closedThoughts.add(toggle);
      }
    }
    const presentedFiles = getTurnPresentedFiles(chat, turn.fork + 1, turn.end);
    const presentedFilesKey = JSON.stringify(presentedFiles);
    if (group.presentedFilesKey !== presentedFilesKey) {
      group.presentedFiles?.remove();
      group.presentedFiles = createPresentedFileCards(presentedFiles);
      group.presentedFilesKey = presentedFilesKey;
    }
    const lastRow = rows.at(-1) ?? firstRow;
    if (group.presentedFiles && lastRow.nextElementSibling !== group.presentedFiles) lastRow.after(group.presentedFiles);
    if (!ongoing) {
      const key = `${turn.end}:${run?.endedAt ?? ''}:${turn.fork === primaryFork ? 'primary' : ''}`;
      if (group.cardKey !== key) {
        group.card?.remove();
        group.card = createTurnChanges(chat, turn.fork + 1, turn.end, {
          primary: turn.fork === primaryFork,
        });
        group.cardKey = key;
        if (turn.fork === primaryFork) syncTurnChangeActions();
      }
      const last = group.presentedFiles ?? lastRow;
      if (group.card && last.nextElementSibling !== group.card) last.after(group.card);
      syncReplyFoot(group, replies, latest && !full, group.card ?? last, chat);
    } else {
      group.card?.remove();
      group.card = null;
      group.cardKey = undefined;
      syncReplyFoot(group, [], false, null, chat);
    }
  }

  function sync(): void {
    if (disposed) return;
    if (frame !== undefined) { view!.cancelAnimationFrame(frame); frame = undefined; }
    observer.disconnect();
    if (timer) { clearTimeout(timer); timer = undefined; }
    liveView = null;
    const full = chatView() === 'full';
    mount.classList.add('chat-thread');
    mount.dataset.chatView = full ? 'full' : 'compact';
    const turns = collectTranscriptTurns(chat);
    syncFloatingTodos(turns);
    const byIndex = new Map<number, TranscriptTurn>();
    for (const turn of turns) for (let i = turn.fork; i <= turn.end; i++) byIndex.set(i, turn);
    const buckets = new Map<TranscriptTurn, HTMLElement[]>();
    let current: TranscriptTurn | undefined;
    for (const node of Array.from(mount.children)) {
      if (!(node instanceof HTMLElement) || node.matches('.chat-work, .chat-turn-changes, .chat-turn-todos, .chat-presented-files, .chat-reply-foot')) continue;
      const index = node.dataset.historyIndex;
      if (index != null && Number(index) < (turns[0]?.fork ?? 0)) continue;
      current = (index != null ? byIndex.get(Number(index)) : undefined) ?? current ?? turns.at(-1);
      if (!current || node.matches('.msg.user')) continue;
      if (!node.matches('.msg.assistant, .tool-call-msg, .tool-call-batch, .tool-start-indicator, .sub-agent-card, .sub-agent-group, .msg-stopped-row, .compaction-divider')) continue;
      const bucket = buckets.get(current) ?? [];
      bucket.push(node);
      buckets.set(current, bucket);
    }
    const streaming = isStreaming();
    if (!streaming) syncRunStatus(null);
    const primaryFork = primaryTurnFork(turns, streaming);
    const activeCompactions = new Set(Array.from(
      mount.querySelectorAll<HTMLElement>(':scope > .compaction-divider:not(.compaction-divider--superseded)'),
      (divider) => Number(divider.dataset.historyIndex),
    ).filter(Number.isFinite));
    const activeKey = [...activeCompactions].join(',');
    for (const [turn, rows] of buckets) {
      // No divider mounted yet (backfill still running): let the summary use the latest checkpoint.
      syncGroup(turn, rows, streaming && turn === turns.at(-1), full, primaryFork,
        activeCompactions.size ? activeCompactions : undefined, activeKey, turn === turns.at(-1));
    }
    const mounted = new Set(Array.from(buckets.keys(), (turn) => turn.fork));
    for (const [fork, group] of groups) {
      if (mounted.has(fork)) continue;
      group.button.remove();
      group.card?.remove();
      group.presentedFiles?.remove();
      group.foot?.remove();
      group.todos?.remove();
      groups.delete(fork);
    }
    observer.observe(mount, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'data-history-index', 'data-stream-phase', 'data-turn-kind', 'data-status', 'data-live'] });
    if (streaming) scheduleTick();
  }

  function scheduleTick(): void {
    timer = setTimeout(() => { timer = undefined; if (mount.isConnected) tick(); else dispose(); }, 1000);
  }

  /**
   * The live clock, narration and token count change every second without any
   * structural mutation. Repaint just that line; a full sync walks every row of
   * the run, which grows with the session.
   */
  function tick(): void {
    const view = liveView;
    if (disposed) return;
    if (!view || !view.group.button.isConnected || !isStreaming() || chat.history.length !== view.historyLength) {
      sync();
      return;
    }
    const run = view.turn.run;
    const duration = run ? formatWorkDuration(Date.now() - run.createdAt) : '';
    setText(view.group.label, workingLabel(duration));
    setText(view.group.activity, liveActivityText(mount, view.rows, view.assistants));
    setAttr(view.group.button, 'aria-label', workAriaLabel(view.group, view.ariaTail));
    syncRunStatus(duration, view.turn.toolCount);
    scheduleTick();
  }

  function onPreference(): void {
    if (options.view) return;
    if (!mount.isConnected) { dispose(); return; }
    closedToolDetails = new WeakSet<Element>();
    closedThoughts = new WeakSet<Element>();
    if (chatView() === 'compact') {
      expanded.clear();
      for (const group of groups.values()) group.expanded = false;
    }
    sync();
  }
  function dispose(): void {
    disposed = true;
    disposeScrollLayout();
    todoPanel?.remove();
    observer.disconnect();
    for (const group of groups.values()) { group.button.remove(); group.card?.remove(); group.presentedFiles?.remove(); group.foot?.remove(); group.todos?.remove(); }
    for (const row of mount.querySelectorAll('.chat-work-hidden')) row.classList.remove('chat-work-hidden');
    clearSteps(mount);
    syncRunStatus(null);
    if (frame !== undefined) view!.cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    view!.removeEventListener(CHAT_VIEW_CHANGED, onPreference);
    view!.removeEventListener('minnow:todos-changed', schedule);
    mount.removeEventListener(TOOL_START_INDICATOR_CHANGED, schedule);
    unsubscribeMetadata();
    controllers.delete(mount);
  }
  view.addEventListener(CHAT_VIEW_CHANGED, onPreference);
  view.addEventListener('minnow:todos-changed', schedule);
  mount.addEventListener(TOOL_START_INDICATOR_CHANGED, schedule);
  const unsubscribeMetadata = subscribeManagedChatMetadata(chatId => { if (chatId === chat.id) schedule(); });
  controllers.set(mount, { chat, sync, dispose });
  sync();
}

export function disposeChatWorkView(mount: HTMLElement): void {
  controllers.get(mount)?.dispose();
}

interface LiveView {
  group: WorkGroup;
  turn: TranscriptTurn;
  rows: HTMLElement[];
  assistants: HTMLElement[];
  ariaTail: string[];
  historyLength: number;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function workingLabel(duration: string): string {
  return `Working${duration ? ` · ${duration}` : '…'}`;
}

function pendingLabel(status: NonNullable<TranscriptTurn['executionStatus']>, duration: string): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'waiting_for_host': return 'Waiting for host';
    case 'waiting_for_model': return 'Waiting for model';
    case 'loading_model': return 'Loading model…';
    case 'waiting_for_agents': return 'Waiting for agents';
    case 'waiting_for_input': return 'Waiting for your answer';
    case 'waiting_for_approval': return 'Needs approval';
    case 'stopping': return 'Stopping…';
    case 'waiting': return 'Waiting';
    default: return workingLabel(duration);
  }
}

function workAriaLabel(group: WorkGroup, tail: string[]): string {
  return [group.label.textContent, ...tail].filter(Boolean).join('. ');
}

/**
 * "Running tests · 1,234 tokens". Scans from the tail: the work in flight is at
 * the end of the run, so a long turn costs a few rows, not all of them.
 */
function liveActivityText(mount: HTMLElement, rows: HTMLElement[], assistants: HTMLElement[]): string {
  let runningTool: HTMLElement | undefined;
  for (let i = rows.length - 1; i >= 0 && !runningTool; i--) {
    runningTool = Array.from(rows[i]!.querySelectorAll<HTMLElement>('.tool-call-summary--running')).at(-1);
  }
  const latestAssistant = assistants.at(-1);
  // Narration counts only when the round in flight wrote it; older prose is stale.
  const bubble = latestAssistant?.querySelector(':scope > .msg-bubble:not(.msg-bubble--awaiting):not(.msg-bubble--error)');
  const narration = bubble?.textContent ? narrationSentence(bubble.textContent) : '';
  const toolText = runningTool?.querySelector('.tool-call-action')?.textContent
    || latestAssistant?.querySelector('.tool-start-indicator__label')?.textContent;
  const runtime = latestAssistant?.querySelector('.stream-status__detail')?.textContent?.trim();
  const phaseLabel = latestAssistant?.querySelector('.stream-status:not(.hidden) .stream-status__label')?.textContent;
  // One native lookup instead of a query per assistant row.
  const owners = new Set(Array.from(mount.querySelectorAll('.thoughts-panel-wrap--live'), (panel) => panel.closest('.msg')));
  const thinking = assistants.some((row) => row.dataset.streamPhase === 'thinking' || owners.has(row));
  const summary = latestAssistant?.querySelector('.reasoning-summary-activity');
  return [narration || toolText || (summary ? 'Working' : thinking ? 'Thinking' : phaseLabel || 'Generating response'), runtime].filter(Boolean).join(' · ');
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

type WorkOutcome = 'live' | 'done' | 'failed' | 'stopped' | 'recovery';

/** "101 tok/s · 103k tok" from the reply's metric chips (hidden in compact view). */
function replyStatsText(final: HTMLElement): string {
  const rate = final.querySelector('.msg-stats .stat-chip.c span')?.textContent?.trim();
  const total = final.querySelector('.msg-stats .stat-chip.r span')?.textContent?.trim();
  return [rate ? `${Math.round(Number(rate)) || rate} tok/s` : '', total ? `${total} tok` : ''].filter(Boolean).join(' · ');
}

function footButton(icon: 'copy' | 'refresh', label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-reply-foot__btn';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(createIcon(icon, { size: 13 }));
  button.addEventListener('click', onClick);
  return button;
}

/** Copy, Remake and the reply's speed under the latest settled answer. */
function syncReplyFoot(
  group: WorkGroup,
  replies: HTMLElement[],
  show: boolean,
  after: Element | null,
  chat: Chat,
): void {
  group.replies = replies;
  const final = replies.at(-1);
  const index = final ? Number(final.dataset.historyIndex) : Number.NaN;
  if (!show || !final || !after || !Number.isFinite(index)) {
    group.foot?.remove();
    group.foot = null;
    return;
  }
  let foot = group.foot;
  const canRewrite = supportsLocalHistoryMutation(chat) || supportsManagedHistoryMutation(chat);
  if (!foot || foot.dataset.index !== String(index) || foot.dataset.canRewrite !== String(canRewrite)) {
    foot?.remove();
    foot = document.createElement('div');
    foot.className = 'chat-reply-foot';
    foot.dataset.index = String(index);
    foot.dataset.canRewrite = String(canRewrite);
    const stats = document.createElement('span');
    stats.className = 'chat-reply-foot__stats';
    foot.append(
      footButton('copy', 'Copy reply', () => {
        void import('./message-actions').then((m) => m.copyMessageRows(group.replies ?? []));
      }),
      ...(canRewrite ? [footButton('refresh', 'Remake reply', () => {
        void import('./message-actions').then((m) => m.remakeAssistantRow(chat.id, index));
      })] : []),
      stats,
    );
    group.foot = foot;
  }
  const stats = foot.querySelector('.chat-reply-foot__stats');
  const text = replyStatsText(final);
  if (stats && stats.textContent !== text) stats.textContent = text;
  if (after.nextElementSibling !== foot) after.after(foot);
}

/** Pending work has no completion glyph; settled glyphs follow the run outcome. */
function paintStatus(group: WorkGroup, outcome: WorkOutcome): void {
  if (group.statusKey === outcome) return;
  group.statusKey = outcome;
  if (outcome === 'live') { group.status.replaceChildren(); return; }
  const name = outcome === 'failed' || outcome === 'recovery' ? 'statusFail' : outcome === 'stopped' ? 'stop' : 'check';
  group.status.replaceChildren(createIcon(name, { className: 'chat-work__status-icon', size: 12 }));
}

const STEP_CLASSES = ['chat-step', 'chat-step--joined', 'chat-step--continued'] as const;
const TOOL_ROW = '.tool-call-msg, .tool-call-batch, .tool-start-indicator, .sub-agent-card';
/** Hidden activity and spawn rows represented by sub-agent cards. */
const OFF_RAIL = '.chat-work-hidden, [hidden], .tool-call-msg--delegated, .tool-call-batch--delegated';

function hasProse(row: HTMLElement): boolean {
  const bubble = row.querySelector(':scope > .msg-bubble:not(.msg-bubble--awaiting)');
  return Boolean(bubble?.textContent?.trim());
}

/**
 * True when the row owns a settled Thoughts panel. Mid-run rounds are labelled
 * plain "Thoughts" until the duration is known; a live panel is not settled yet.
 */
function hasSettledThoughts(row: HTMLElement): boolean {
  if (row.dataset.streamPhase === 'thinking' || row.querySelector('.thoughts-panel-wrap--live')) return false;
  return Boolean(row.querySelector(':scope > .thoughts-panel-wrap'));
}

/**
 * Compact view draws a turn's work as a rail of steps. Rows stay where they
 * were mounted; only classes change. A thinking-only round keeps its own step:
 * its Thoughts panel is the only place the reasoning can be read, so folding
 * the row into the tool round it led to would hide it entirely.
 *
 * Classes are diffed, never cleared and re-added: a live turn holds every row
 * of the run, and an unchanged remove+add still restyles each row (~140ms per
 * sync at 66k elements).
 */
function paintSteps(activity: HTMLElement[], full: boolean, live: boolean): void {
  const steps = new Set<HTMLElement>();
  const joined = new Set<HTMLElement>();
  const continued = new Set<HTMLElement>();
  if (!full) {
    const visible = activity.filter((row) => !row.matches(OFF_RAIL));
    visible.forEach((row) => {
      if (row.matches(TOOL_ROW)) { steps.add(row); return; }
      if (!row.matches('.msg.assistant') || row.matches('.msg--failed, .msg--stopped, .msg--truncated')) return;
      // A thinking-only round (live, or one that settled without prose) is its own step.
      if (!hasProse(row) && (hasSettledThoughts(row)
        || (live && row.querySelector('.thoughts-panel-wrap--live, .tool-start-indicator')))) steps.add(row);
    });
    const ordered = visible.filter((row) => steps.has(row));
    ordered.forEach((row, i) => {
      let sibling = row.nextElementSibling;
      while (sibling instanceof HTMLElement && sibling.matches(OFF_RAIL)) {
        sibling = sibling.nextElementSibling;
      }
      const next = ordered[i + 1];
      if (next && sibling === next) {
        joined.add(row);
        continued.add(next);
      }
    });
  }
  for (const row of activity) {
    setClass(row, 'chat-step', steps.has(row));
    setClass(row, 'chat-step--joined', joined.has(row));
    setClass(row, 'chat-step--continued', continued.has(row));
  }
}

function setClass(row: HTMLElement, cls: string, on: boolean): void {
  if (row.classList.contains(cls) !== on) row.classList.toggle(cls, on);
}

function clearSteps(mount: HTMLElement): void {
  for (const cls of STEP_CLASSES) {
    for (const row of mount.querySelectorAll(`.${cls}`)) row.classList.remove(cls);
  }
}

/** The line above the composer while a run is live: pulse, elapsed time, actions so far. */
function paintRunStatus(elapsed: string | null, actions = 0): void {
  const host = document.getElementById('composerRunStatus');
  if (!host) return;
  if (elapsed === null) {
    if (!host.hidden) host.hidden = true;
    return;
  }
  if (host.hidden) host.hidden = false;
  const time = host.querySelector('.composer-run-status__time');
  if (time && time.textContent !== elapsed) time.textContent = elapsed;
  const count = host.querySelector('.composer-run-status__count');
  const text = actions ? `${actions} action${actions === 1 ? '' : 's'}` : '';
  if (count && count.textContent !== text) count.textContent = text;
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
