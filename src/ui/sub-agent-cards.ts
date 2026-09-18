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
import { initSubAgentDrawerLiveUpdates, openSubAgentDrawer } from './sub-agent-drawer';
import {
  subAgentLiveBadgeLabel,
  subAgentLiveStatusLine,
} from './sub-agent-live-status';

/** Maps run id to the card element for the current chat render. */
const cards = new Map<string, HTMLElement>();

let liveSubscriptionBound = false;
/** Pending coalesced tail scroll — one per frame, not one per card (MIN-793). */
let scrollBottomRaf: number | null = null;

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
}

function statusLabel(run: SubAgentRun | PersistedSubAgentRun, live: boolean): string {
  return subAgentLiveBadgeLabel(run, live);
}

function taskPreview(task: string): string {
  const t = task.trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
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

// ── Card fill ────────────────────────────────────────────────────────────────

/** Fills the card DOM from a live or persisted run row. */
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

  const mark = document.createElement('span');
  mark.className = 'sub-agent-card__mark';
  mark.appendChild(createIcon('appAgentActivity', { size: 15 }));

  const body = document.createElement('div');
  body.className = 'sub-agent-card__body';

  const head = document.createElement('div');
  head.className = 'sub-agent-card__head';

  const label = document.createElement('span');
  label.className = 'sub-agent-card__label';
  label.textContent = 'Sub-agent';

  const separator = document.createElement('span');
  separator.className = 'sub-agent-card__separator';
  separator.textContent = '·';

  const type = document.createElement('span');
  type.className = 'sub-agent-card__type';
  type.textContent = agentTypeLabel(run.type);

  head.append(label, separator, type);

  const badge = document.createElement('span');
  badge.className = 'sub-agent-card__badge';
  badge.textContent = statusLabel(run, live);

  const task = document.createElement('div');
  task.className = 'sub-agent-card__task';
  task.textContent = taskPreview(run.task);
  task.title = run.task.trim();

  const subtitle = document.createElement('div');
  subtitle.className = 'sub-agent-card__subtitle';
  const liveLine = live ? subAgentLiveStatusLine(run, true) : '';
  const activeRun = run as SubAgentRun;
  if (live && activeRun.startError) {
    subtitle.className = 'sub-agent-card__subtitle sub-agent-card__error';
    subtitle.textContent = `${activeRun.startError.message} (${activeRun.startError.consecutive})`;
  } else if (liveLine) {
    subtitle.textContent = liveLine;
  } else {
    const outcome =
      run.structuredOutcome ??
      (run.summary?.trim() ? legacyOutcomeFromSummary(run.summary) : null);
    if (outcome?.findings?.[0]?.title) {
      subtitle.textContent = outcome.findings[0].title;
    } else if (outcome?.summary?.trim()) {
      const s = outcome.summary.trim();
      subtitle.textContent = s.length > 100 ? `${s.slice(0, 100)}…` : s;
    }
  }

  body.append(head, task);
  if (subtitle.textContent) body.appendChild(subtitle);
  const toolRounds = toolRoundLabel(run);
  if (toolRounds) {
    const meta = document.createElement('div');
    meta.className = 'sub-agent-card__meta';
    meta.textContent = toolRounds;
    body.appendChild(meta);
  }

  const trailing = document.createElement('span');
  trailing.className = 'sub-agent-card__trailing';
  trailing.append(badge, createIcon('chevronRight', {
    className: 'sub-agent-card__chevron',
    size: 14,
  }));

  el.append(mark, body, trailing);
}

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

// ── Placement ────────────────────────────────────────────────────────────────

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

/** Sit the card directly under the spawn tool row. */
function placeSubAgentCard(
  el: HTMLElement,
  area: HTMLElement,
  run: SubAgentRun | PersistedSubAgentRun,
  persisted?: SubAgentRun | PersistedSubAgentRun,
): void {
  const anchorId =
    parentToolCallAnchorId(run) ?? (persisted ? parentToolCallAnchorId(persisted) : null);
  const anchor = anchorId ? findSpawnToolAnchor(area, anchorId) : null;
  const inThisTranscript = area.contains(el);
  const alreadyAdjacent =
    inThisTranscript && anchor != null && el.previousElementSibling === anchor;

  if (alreadyAdjacent) return;

  if (anchor?.parentNode) {
    anchor.insertAdjacentElement('afterend', el);
    return;
  }

  if (!inThisTranscript) {
    appendChatTranscriptNode(el, area);
  }
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

  const area = getActiveChatMountElement();

  let el = cards.get(run.runId);
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

  const displayRun = orchestratorRun ?? run;
  placeSubAgentCard(el, area, displayRun, run);
  el.setAttribute(
    'aria-label',
    `Sub-agent ${agentTypeLabel(displayRun.type)}, ${statusLabel(displayRun, isLive)}. ${taskPreview(displayRun.task)}`,
  );
  el.setAttribute('aria-busy', isLive ? 'true' : 'false');
  el.title = 'Open sub-agent details';
  fillCard(el, displayRun, isLive);
  scheduleScrollBottom();
  return el;
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
    const chatId = run.parentChatId;
    if (!chatId) return;
    upsertSubAgentCardForRun(run, chatId);
  });
}
