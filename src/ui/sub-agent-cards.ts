import { normalizeModeId } from '../chat/modes/types';
import { listActiveSubAgentRuns, getSubAgentRun, hydrateSubAgentRunsForParentChat, listSubAgentRunsForParentChat } from '../agents/orchestrator';
import { subscribeSubAgentRuns } from '../agents/sub-agent-events';
import type { SubAgentRun } from '../agents/types';
import { initSubAgentCompletionPush } from '../agents/sub-agent-completion-push';
import { initSubAgentSessionPersistence } from '../state/sub-agent-session-sync';
import { getActiveChat } from '../state/sessions';
import { legacyOutcomeFromSummary } from '../agents/sub-agent-structured-outcome';
import type { Chat, PersistedSubAgentRun } from '../types';
import { getActiveChatMountElement, appendChatTranscriptNode } from './chat-mount';
import { isBoardChatEmbedOpenForChat } from './orchestrate-board-chat-state';
import { isHubMounted } from './hub';
import { isMainColumnOverlaySuppressingChatDom } from './main-column-overlay';
import { isOrchestrateHubMounted } from './orchestrate-hub';
import { scrollBottom } from './input';
import { createIcon } from './icon';
import { formatWorkDuration } from '../chat/transcript-turns';
import { initSubAgentDrawerLiveUpdates, openSubAgentDrawer } from './sub-agent-drawer';
import {
  subAgentLiveBadgeLabel,
  subAgentLiveStatusLine,
} from './sub-agent-live-status';

/** Maps run id to the card element for the current chat render. */
const cards = new Map<string, HTMLElement>();
const cardRenderKeys = new WeakMap<HTMLElement, string>();

let liveSubscriptionBound = false;
/** Pending coalesced tail scroll — one per frame, not one per card (MIN-793). */
let scrollBottomRaf: number | null = null;
/** Latest live snapshot per run, painted at most once per frame. */
const pendingCardRuns = new Map<string, SubAgentRun>();
let cardRenderRaf: number | null = null;

/**
 * `scrollBottom` forces two layouts (scrollHeight read, scrollTop write, then the jump-chip
 * read). Re-mounting a chat upserts every run three times over, so it must not run per card.
 */
function scheduleScrollBottom(): void {
  if (typeof requestAnimationFrame !== 'function') {
    scrollBottom();
    return;
  }
  if (scrollBottomRaf != null) return;
  scrollBottomRaf = requestAnimationFrame(() => {
    scrollBottomRaf = null;
    scrollBottom();
  });
}

// ── Landing ──────────────────────────────────────────────────────────────────

/** Empty-chat landing pages (Vibe / Orchestrate hub) — not the transcript. */
function isEmptyChatLandingMounted(): boolean {
  return isHubMounted() || isOrchestrateHubMounted();
}

/** Clears the card registry when the chat DOM is rebuilt from history. */
export function clearSubAgentCardDomRegistry(): void {
  cards.clear();
  pendingCardRuns.clear();
  if (cardRenderRaf != null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(cardRenderRaf);
  }
  cardRenderRaf = null;
}

function statusLabel(run: SubAgentRun | PersistedSubAgentRun, live: boolean): string {
  return subAgentLiveBadgeLabel(run, live);
}

function taskPreview(task: string): string {
  const t = task.trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

/** First meaningful line of the brief — the row's title; the full brief stays in the tooltip. */
function taskTitle(task: string): string {
  const line = task
    .split('\n')
    .map((l) => l.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, '').trim())
    .find(Boolean) ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function agentTypeLabel(type: string): string {
  const words = type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
  return words ? words.replace(/^\w/, (letter) => letter.toUpperCase()) : 'Agent';
}

function toolRoundLabel(run: SubAgentRun | PersistedSubAgentRun): string {
  const activeRun = run as SubAgentRun;
  const count = activeRun.liveNestedToolCalls ?? run.toolTurns;
  if (!count) return '';
  return `${count} tool ${count === 1 ? 'call' : 'calls'}`;
}

/** Wall time of a settled run; live runs show activity instead of a ticking clock. */
function durationLabel(run: SubAgentRun | PersistedSubAgentRun, live: boolean): string {
  if (live || !run.startedAt || !run.endedAt) return '';
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? formatWorkDuration(ms) : '';
}

/** Status · tool calls · duration — one quiet trailing line. */
function metaLabel(run: SubAgentRun | PersistedSubAgentRun, live: boolean): string {
  return [statusLabel(run, live), toolRoundLabel(run), durationLabel(run, live)]
    .filter(Boolean)
    .join(' · ');
}

/** Live activity, start error, or the settled outcome's headline. */
function detailLine(
  run: SubAgentRun | PersistedSubAgentRun,
  live: boolean,
): { text: string; error: boolean } {
  const activeRun = run as SubAgentRun;
  if (live && activeRun.startError) {
    return {
      text: `${activeRun.startError.message} (${activeRun.startError.consecutive})`,
      error: true,
    };
  }
  const liveLine = live ? subAgentLiveStatusLine(run, true) : '';
  if (liveLine) return { text: liveLine, error: false };
  if (run.status === 'failed' && run.error?.trim()) {
    return { text: run.error.trim(), error: true };
  }
  const outcome =
    run.structuredOutcome ??
    (run.summary?.trim() ? legacyOutcomeFromSummary(run.summary) : null);
  const text = outcome?.findings?.[0]?.title?.trim() || outcome?.summary?.trim() || '';
  return { text: text.length > 200 ? `${text.slice(0, 200)}…` : text, error: false };
}

/** Fields that can actually change the compact card. Streaming text is drawer-only. */
function cardRenderKey(
  run: SubAgentRun | PersistedSubAgentRun,
  live: boolean,
): string {
  const detail = detailLine(run, live);
  return JSON.stringify([
    run.status,
    run.type,
    run.task,
    metaLabel(run, live),
    detail.text,
    detail.error,
  ]);
}

// ── Card fill ────────────────────────────────────────────────────────────────

/**
 * One timeline step: icon · agent · brief title · status, then a single
 * detail line (live activity, error, or the result headline).
 */
function fillCard(
  el: HTMLElement,
  run: SubAgentRun | PersistedSubAgentRun,
  live: boolean,
): void {
  el.classList.toggle(
    'sub-agent-card--active',
    run.status === 'running' || run.status === 'queued',
  );
  el.dataset.status = run.status;
  el.replaceChildren();

  const body = document.createElement('div');
  body.className = 'sub-agent-card__body';

  const mark = document.createElement('span');
  mark.className = 'sub-agent-card__mark';
  mark.appendChild(createIcon('appAgentActivity', { size: 14 }));

  const type = document.createElement('span');
  type.className = 'sub-agent-card__type';
  type.textContent = agentTypeLabel(run.type);

  const task = document.createElement('span');
  task.className = 'sub-agent-card__task';
  task.textContent = taskTitle(run.task);
  task.title = run.task.trim();

  const meta = document.createElement('span');
  meta.className = 'sub-agent-card__meta';
  meta.textContent = metaLabel(run, live);

  body.append(
    mark,
    type,
    task,
    meta,
    createIcon('chevronRight', { className: 'sub-agent-card__chevron', size: 14 }),
  );

  const detail = detailLine(run, live);
  if (detail.text) {
    const line = document.createElement('div');
    line.className = detail.error
      ? 'sub-agent-card__detail sub-agent-card__error'
      : 'sub-agent-card__detail';
    line.textContent = detail.text;
    body.appendChild(line);
  }

  el.appendChild(body);
}

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

// ── Placement ────────────────────────────────────────────────────────────────

/** Spawn rows a card stands in for; the card is the only visible step. */
const DELEGATED_ROW = 'tool-call-msg--delegated';
const DELEGATED_BATCH = 'tool-call-batch--delegated';

/** Parent `spawn_sub_agent` tool-call id used to sit the card under that row. */
function parentToolCallAnchorId(
  run: SubAgentRun | PersistedSubAgentRun,
): string | null {
  if (!('parentToolCallId' in run) || !run.parentToolCallId) return null;
  const trimmed = run.parentToolCallId.trim();
  return trimmed || null;
}

/** The spawn tool row in this transcript, if it is mounted. */
function findSpawnToolAnchor(area: HTMLElement, anchorId: string): HTMLElement | null {
  const selector = `[data-tool-call-id="${escapeAttributeValue(anchorId)}"]`;
  return (
    area.querySelector<HTMLElement>(`.tool-call-msg${selector}`) ??
    area.querySelector<HTMLElement>(selector)
  );
}

/**
 * Parallel spawns share one collapsed round disclosure; their cards sit after
 * it at transcript level so they stay visible.
 */
function cardHost(anchor: HTMLElement): HTMLElement {
  return anchor.closest<HTMLElement>('.tool-call-batch') ?? anchor;
}

/** Hide the spawn row (and a round made only of spawns) behind its card. */
function markDelegated(anchor: HTMLElement): void {
  anchor.classList.add(DELEGATED_ROW);
  const batch = anchor.closest<HTMLElement>('.tool-call-batch');
  if (!batch) return;
  const rows = Array.from(
    batch.querySelectorAll<HTMLElement>(':scope > .tool-call-batch__body > .tool-call-msg'),
  );
  batch.classList.toggle(
    DELEGATED_BATCH,
    rows.length > 0 && rows.every((row) => row.classList.contains(DELEGATED_ROW)),
  );
}

/** True when only sibling cards separate `el` from its host row. */
function sitsAfterHost(el: HTMLElement, host: HTMLElement): boolean {
  let prev = el.previousElementSibling;
  while (prev && prev !== host && prev.matches('.sub-agent-card')) {
    prev = prev.previousElementSibling;
  }
  return prev === host;
}

/** After the host and any cards already queued behind it, so spawn order holds. */
function insertionPoint(host: HTMLElement, el: HTMLElement): Element {
  let at: Element = host;
  let next = host.nextElementSibling;
  while (next && next !== el && next.matches('.sub-agent-card')) {
    at = next;
    next = next.nextElementSibling;
  }
  return at;
}

/** Sit the card directly under the spawn tool row (or the round holding it). */
function placeSubAgentCard(
  el: HTMLElement,
  area: HTMLElement,
  run: SubAgentRun | PersistedSubAgentRun,
  persisted?: SubAgentRun | PersistedSubAgentRun,
): void {
  const anchorId =
    parentToolCallAnchorId(run) ?? (persisted ? parentToolCallAnchorId(persisted) : null);
  const anchor = anchorId ? findSpawnToolAnchor(area, anchorId) : null;

  if (anchor?.parentNode) {
    markDelegated(anchor);
    const host = cardHost(anchor);
    if (sitsAfterHost(el, host)) return;
    insertionPoint(host, el).insertAdjacentElement('afterend', el);
    return;
  }

  if (!area.contains(el)) {
    appendChatTranscriptNode(el, area);
  }
}

function isCardPlacementStable(
  el: HTMLElement,
  run: SubAgentRun | PersistedSubAgentRun,
): boolean {
  if (!el.isConnected) return false;
  const anchorId = parentToolCallAnchorId(run);
  if (!anchorId) return true;
  const area = el.parentElement;
  const anchor = area ? findSpawnToolAnchor(area, anchorId) : null;
  return (
    anchor != null &&
    anchor.classList.contains(DELEGATED_ROW) &&
    sitsAfterHost(el, cardHost(anchor))
  );
}

// ── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Creates or updates the card for this run when it belongs to the active chat.
 */
export function upsertSubAgentCardForRun(
  run: SubAgentRun | PersistedSubAgentRun,
  chatId: string,
): HTMLElement | null {
  const active = getActiveChat();
  if (active.id !== chatId) return null;
  const orchestratorRun = getSubAgentRun(run.runId);
  const isLive =
    run.status === 'running' ||
    run.status === 'queued' ||
    orchestratorRun?.status === 'running' ||
    orchestratorRun?.status === 'queued';
  if (
    normalizeModeId(active.modeId) === 'orchestrate' &&
    active.viewMode === 'board'
  ) {
    return null;
  }
  if (!isBoardChatEmbedOpenForChat(chatId) && isMainColumnOverlaySuppressingChatDom()) {
    return null;
  }
  if (isEmptyChatLandingMounted()) return null;

  let el = cards.get(run.runId);
  const displayRun = orchestratorRun ?? run;
  const renderKey = cardRenderKey(displayRun, isLive);
  if (
    el &&
    cardRenderKeys.get(el) === renderKey &&
    isCardPlacementStable(el, displayRun)
  ) {
    return el;
  }

  const area = getActiveChatMountElement();
  if (!el) {
    el = document.createElement('div');
    el.className = 'sub-agent-card';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-haspopup', 'dialog');
    el.dataset.runId = run.runId;
    el.dataset.chatId = chatId;
    cards.set(run.runId, el);

    const open = (): void => {
      openSubAgentDrawer(run.runId, chatId);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        open();
      }
    });
  }

  placeSubAgentCard(el, area, displayRun, run);
  if (cardRenderKeys.get(el) === renderKey) return el;

  el.setAttribute(
    'aria-label',
    `Sub-agent ${agentTypeLabel(displayRun.type)}, ${statusLabel(displayRun, isLive)}. ${taskPreview(displayRun.task)}`,
  );
  el.setAttribute('aria-busy', isLive ? 'true' : 'false');
  el.title = 'Open sub-agent details';
  fillCard(el, displayRun, isLive);
  cardRenderKeys.set(el, renderKey);
  scheduleScrollBottom();
  return el;
}

function scheduleSubAgentCardUpdate(run: SubAgentRun): void {
  pendingCardRuns.set(run.runId, run);
  if (cardRenderRaf != null) return;
  if (typeof requestAnimationFrame !== 'function') {
    const pending = [...pendingCardRuns.values()];
    pendingCardRuns.clear();
    for (const latest of pending) {
      if (latest.parentChatId) upsertSubAgentCardForRun(latest, latest.parentChatId);
    }
    return;
  }
  cardRenderRaf = -1;
  const handle = requestAnimationFrame(() => {
    cardRenderRaf = null;
    const pending = [...pendingCardRuns.values()];
    pendingCardRuns.clear();
    for (const latest of pending) {
      if (latest.parentChatId) upsertSubAgentCardForRun(latest, latest.parentChatId);
    }
  });
  if (cardRenderRaf === -1) cardRenderRaf = handle;
}

/** Re-mount persisted and in-flight cards after `renderChatFromHistory` rebuilds the transcript. */
export function renderPersistedSubAgentCardsForChat(chat: Chat): void {
  for (const row of chat.subAgentRuns ?? []) {
    upsertSubAgentCardForRun(row, chat.id);
  }
  for (const run of listActiveSubAgentRuns()) {
    if (run.parentChatId === chat.id) {
      upsertSubAgentCardForRun(run, chat.id);
    }
  }
  void hydrateSubAgentRunsForParentChat(chat.id).then(() => {
    for (const run of listSubAgentRunsForParentChat(chat.id)) {
      upsertSubAgentCardForRun(run, chat.id);
    }
  });
}

/**
 * One-time init: persist settled runs to the session blob and subscribe for live cards.
 */
export function initSubAgentUi(): void {
  initSubAgentSessionPersistence();
  initSubAgentCompletionPush();
  initSubAgentDrawerLiveUpdates();
  try {
    const chat = getActiveChat();
    if (chat?.id) void hydrateSubAgentRunsForParentChat(chat.id);
  } catch {
  }
  if (liveSubscriptionBound) return;
  liveSubscriptionBound = true;
  subscribeSubAgentRuns((run) => {
    if (run.parentChatId) scheduleSubAgentCardUpdate(run);
  });
}
