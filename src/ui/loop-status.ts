import { createTextInput, setControlClassName } from './components';
import { createButton, setButtonClassName } from './components';
import {
  INITIAL_LOOP_AUTO_DELAY_MS,
  MAX_LOOP_AUTO_DELAY_MS,
  MIN_LOOP_INTERVAL_MS,
  parseLoopIntervalToken,
} from '../chat/loop/parse-command';
import { pauseActiveLoop, resumeActiveLoop } from '../chat/loop/pause';
import { skipActiveLoop } from '../chat/loop/skip';
import { runLoopTick } from '../chat/loop/ticker';
import { isStreamDomVisible } from '../chat/streaming-state';
import type { ActiveLoopState, Chat } from '../types';
import {
  findChatById,
  getActiveLoops,
  hasActiveLoops,
  removeActiveLoop,
  sessionState,
  updateActiveLoop,
} from '../state/sessions';
import { appendChatTranscriptNode } from './chat-mount';
import { scrollChatIfPinned } from './chat-scroll';
import { syncChatItemLoopIconsInDom } from './chat-item-loop-icon';

const LOOP_STATUS_CLASS = 'loop-status';
const panelByChatId = new Map<string, HTMLElement>();
let countdownTimer: ReturnType<typeof setInterval> | null = null;

/** Human-readable countdown until the next fire. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return 'due now';
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 48) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Round-trip interval ms to a compact token for the editor (e.g. 300000 → 5m). */
function formatIntervalMs(ms: number): string {
  const sec = Math.max(1, Math.floor(ms / 1000));
  if (sec >= 86_400 && sec % 86_400 === 0) return `${sec / 86_400}d`;
  if (sec >= 3_600 && sec % 3_600 === 0) return `${sec / 3_600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

function loopDelayMs(loop: ActiveLoopState): number {
  if (loop.kind === 'interval') {
    return Math.max(MIN_LOOP_INTERVAL_MS, loop.intervalMs ?? MIN_LOOP_INTERVAL_MS);
  }
  return Math.min(
    MAX_LOOP_AUTO_DELAY_MS,
    Math.max(
      MIN_LOOP_INTERVAL_MS,
      loop.currentDelayMs ?? INITIAL_LOOP_AUTO_DELAY_MS,
    ),
  );
}

function loopPromptLabel(loop: ActiveLoopState): string {
  const trimmed = loop.promptText.trim();
  if (trimmed) return trimmed;
  return 'maintenance';
}

function applyLoopIntervalChange(chat: Chat, loop: ActiveLoopState, rawToken: string): boolean {
  const token = rawToken.trim();
  if (!token) return false;
  const parsedMs = parseLoopIntervalToken(token);
  if (parsedMs == null) return false;

  const now = Date.now();
  const patch: Partial<ActiveLoopState> = {};

  if (loop.paused) {
    patch.pausedRemainingMs = parsedMs;
  } else {
    patch.dueAt = now + parsedMs;
  }

  if (loop.kind === 'interval') {
    patch.intervalMs = parsedMs;
  } else {
    patch.currentDelayMs = parsedMs;
  }

  updateActiveLoop(chat, loop.id, patch);
  return true;
}

function buildPausePlayButton(chat: Chat, loop: ActiveLoopState): HTMLButtonElement {
  const btn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  btn.type = 'button';
  setButtonClassName(btn, 'loop-status__pause-play icon-btn');
  const paused = loop.paused === true;
  btn.textContent = paused ? '▶' : '⏸';
  btn.setAttribute(
    'aria-label',
    paused ? `Resume loop #${loop.id}` : `Pause loop #${loop.id}`,
  );
  btn.addEventListener('click', () => {
    if (paused) {
      resumeActiveLoop(chat, loop.id);
    } else {
      pauseActiveLoop(chat, loop.id);
    }
    syncLoopStatusUi(chat.id);
  });
  return btn;
}

function buildSkipButton(chat: Chat, loop: ActiveLoopState): HTMLButtonElement {
  const btn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  btn.type = 'button';
  setButtonClassName(btn, 'loop-status__skip icon-btn');
  btn.textContent = '⏭';
  btn.setAttribute('aria-label', `Skip wait for loop #${loop.id}`);
  btn.title = 'Run next loop now';
  btn.addEventListener('click', () => {
    skipActiveLoop(chat, loop.id);
    syncLoopStatusUi(chat.id);
    void runLoopTick().catch(() => undefined);
  });
  return btn;
}

function buildStopButton(chat: Chat, loopId: number): HTMLButtonElement {
  const btn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  btn.type = 'button';
  setButtonClassName(btn, 'loop-status__stop icon-btn');
  btn.setAttribute('aria-label', `Stop loop #${loopId}`);
  btn.textContent = '×';
  btn.addEventListener('click', () => {
    removeActiveLoop(chat, loopId);
    syncLoopStatusUi(chat.id);
  });
  return btn;
}

function buildLoopItem(chat: Chat, loop: ActiveLoopState): HTMLElement {
  const item = document.createElement('li');
  item.className = 'loop-status__item';
  item.dataset.loopId = String(loop.id);

  const meta = document.createElement('div');
  meta.className = 'loop-status__meta';

  const idEl = document.createElement('span');
  idEl.className = 'loop-status__id';
  idEl.textContent = `#${loop.id}`;

  const promptEl = document.createElement('span');
  promptEl.className = 'loop-status__prompt';
  promptEl.textContent = loopPromptLabel(loop);
  promptEl.title = loop.promptText.trim() || 'Maintenance loop (.minnow/loop.md or built-in)';

  meta.appendChild(idEl);
  meta.appendChild(promptEl);

  const controls = document.createElement('div');
  controls.className = 'loop-status__controls';

  const intervalWrap = document.createElement('label');
  intervalWrap.className = 'loop-status__interval-wrap';
  intervalWrap.title =
    loop.kind === 'interval' ? 'Interval between runs' : 'Current self-paced delay';

  const intervalInput = createTextInput({ appearance: 'surface', type: 'text' });
  intervalInput.type = 'text';
  setControlClassName(intervalInput, 'loop-status__interval');
  intervalInput.value = formatIntervalMs(loopDelayMs(loop));
  intervalInput.setAttribute('aria-label', `Loop #${loop.id} interval`);
  intervalInput.spellcheck = false;

  const commitInterval = (): void => {
    const ok = applyLoopIntervalChange(chat, loop, intervalInput.value);
    if (!ok) {
      intervalInput.value = formatIntervalMs(loopDelayMs(loop));
      intervalInput.classList.add('loop-status__interval--invalid');
      window.setTimeout(() => {
        intervalInput.classList.remove('loop-status__interval--invalid');
      }, 1200);
      return;
    }
    syncLoopStatusUi(chat.id);
  };

  intervalInput.addEventListener('change', commitInterval);
  intervalInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      intervalInput.blur();
      commitInterval();
    }
  });

  intervalWrap.appendChild(intervalInput);

  const countdownEl = document.createElement('span');
  countdownEl.className = 'loop-status__countdown';
  countdownEl.dataset.loopId = String(loop.id);
  if (loop.paused) {
    const remaining = loop.pausedRemainingMs ?? 0;
    countdownEl.textContent =
      remaining > 0 ? `paused · ${formatCountdown(remaining)}` : 'paused';
  } else {
    countdownEl.textContent = formatCountdown(Math.max(0, loop.dueAt - Date.now()));
  }

  const actions = document.createElement('div');
  actions.className = 'loop-status__actions';
  actions.appendChild(buildPausePlayButton(chat, loop));
  actions.appendChild(buildSkipButton(chat, loop));
  actions.appendChild(buildStopButton(chat, loop.id));

  controls.appendChild(intervalWrap);
  controls.appendChild(countdownEl);
  controls.appendChild(actions);

  item.appendChild(meta);
  item.appendChild(controls);
  return item;
}

function buildLoopStatusPanel(chat: Chat): HTMLElement {
  const panel = document.createElement('div');
  panel.className = LOOP_STATUS_CLASS;
  panel.dataset.chatId = chat.id;

  const header = document.createElement('div');
  header.className = 'loop-status__header';

  const title = document.createElement('span');
  title.className = 'loop-status__title';
  title.textContent = 'Loops';

  const runs = document.createElement('span');
  runs.className = 'loop-status__runs';
  const count = getActiveLoops(chat).length;
  const pausedCount = getActiveLoops(chat).filter((loop) => loop.paused).length;
  if (pausedCount > 0 && pausedCount < count) {
    runs.textContent = `${count - pausedCount} running · ${pausedCount} paused`;
  } else if (pausedCount === count) {
    runs.textContent = count === 1 ? '1 paused' : `${count} paused`;
  } else {
    runs.textContent = count === 1 ? '1 active' : `${count} active`;
  }

  header.appendChild(title);
  header.appendChild(runs);

  const list = document.createElement('ul');
  list.className = 'loop-status__list';
  for (const loop of getActiveLoops(chat)) {
    list.appendChild(buildLoopItem(chat, loop));
  }

  panel.appendChild(header);
  panel.appendChild(list);
  return panel;
}

function hideLoopStatusPanel(chatId: string): void {
  const panel = panelByChatId.get(chatId);
  if (panel) {
    if (panel.isConnected) {
      panel.remove();
    }
    panelByChatId.delete(chatId);
  }
}

function showLoopStatusPanel(chat: Chat): void {
  hideLoopStatusPanel(chat.id);

  const panel = buildLoopStatusPanel(chat);
  panelByChatId.set(chat.id, panel);
  appendChatTranscriptNode(panel);
  scrollChatIfPinned();
}

function refreshCountdowns(): void {
  const now = Date.now();
  for (const [chatId, panel] of panelByChatId) {
    if (!panel.isConnected) {
      panelByChatId.delete(chatId);
      continue;
    }
    const chat = findChatById(chatId);
    if (!chat || !hasActiveLoops(chat)) {
      hideLoopStatusPanel(chatId);
      continue;
    }

    const loops = getActiveLoops(chat);
    for (const loop of loops) {
      const el = panel.querySelector<HTMLElement>(
        `.loop-status__countdown[data-loop-id="${loop.id}"]`,
      );
      if (!el) continue;
      if (loop.paused) {
        const remaining = loop.pausedRemainingMs ?? 0;
        el.textContent =
          remaining > 0 ? `paused · ${formatCountdown(remaining)}` : 'paused';
      } else {
        el.textContent = formatCountdown(Math.max(0, loop.dueAt - now));
      }
    }
  }
}

/** One-time init for loop countdown refresh. */
export function initLoopStatusUi(): void {
  if (typeof document === 'undefined') return;
  if (countdownTimer != null) return;
  countdownTimer = setInterval(() => refreshCountdowns(), 1000);
}

/** Sync the chat loop panel for one chat (defaults to active chat). */
export function syncLoopStatusUi(chatId?: string): void {
  if (typeof document === 'undefined') return;

  const id = chatId ?? sessionState?.activeId;
  if (!id) return;

  for (const otherId of panelByChatId.keys()) {
    if (otherId !== id) hideLoopStatusPanel(otherId);
  }

  const chat = findChatById(id);
  if (!chat || !hasActiveLoops(chat) || !isStreamDomVisible(chat.id)) {
    hideLoopStatusPanel(id);
    return;
  }

  showLoopStatusPanel(chat);
}

/** Back-compat alias used across boot, ticker, and composer paths. */
export function syncLoopActiveHint(): void {
  if (typeof document === 'undefined') return;
  if (!sessionState?.activeId) {
    syncChatItemLoopIconsInDom();
    return;
  }
  syncLoopStatusUi(sessionState.activeId);
  syncChatItemLoopIconsInDom();
}
