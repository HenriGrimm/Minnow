import { showToast } from '../../ui/toast';
import type { ActiveLoopState, Chat } from '../../types';
import { isGoalEvaluating } from '../goal/evaluating-state';
import {
  isChatStreaming,
} from '../streaming-state';
import { isChatTurnSetupPending } from '../chat-turn-guard';
import {
  ensureChatHistoryLoaded,
  getActiveLoops,
  removeActiveLoop,
  requireHistory,
  sessionState,
  updateActiveLoop,
} from '../../state/sessions';
import { setStatus } from '../../ui/status';
import { syncLoopActiveHint } from '../../ui/loop-active-hint';
import {
  INITIAL_LOOP_AUTO_DELAY_MS,
  MIN_LOOP_INTERVAL_MS,
} from './parse-command';
import { isLoopPaused } from './pause';
import { resolveLoopPromptText } from './maintenance';
import {
  clearLoopAwaitingPace,
  markLoopAwaitingPace,
} from './pacing';

/** Poll interval matching the server scheduler tick (safety net). */
export const LOOP_TICK_INTERVAL_MS = 15_000;

/** Retry when a loop is past due but the chat is still busy. */
const OVERDUE_LOOP_RETRY_MS = 1_000;

export type LoopSendFn = (chat: Chat, text: string) => Promise<void>;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let tickerStarted = false;
let sendFn: LoopSendFn | null = null;

/** Inject send implementation (tests / boot wiring). */
export function setLoopSendFn(fn: LoopSendFn | null): void {
  sendFn = fn;
}

// ── Predicates ───────────────────────────────────────────────────────────────

/** Whether the chat is idle enough to fire a loop this tick. */
export function isChatIdleForLoop(chat: Chat): boolean {
  if (isChatStreaming(chat.id)) return false;
  if (isChatTurnSetupPending(chat.id)) return false;
  if (isGoalEvaluating(chat.id)) return false;
  if (chat.pendingMessageQueue?.length) return false;
  return true;
}

/** True when a loop is past its 7-day expiry. */
export function isLoopExpired(loop: ActiveLoopState, now: number): boolean {
  return now > loop.expiresAt;
}

/** True when a loop's dueAt has arrived. */
export function isLoopDue(loop: ActiveLoopState, now: number): boolean {
  return loop.dueAt <= now;
}

/** Earliest dueAt among active, unpaused, unexpired loops (null when none). */
export function findNextLoopWakeAt(
  chats: Chat[],
  now = Date.now(),
): number | null {
  let next: number | null = null;

  for (const chat of chats) {
    for (const loop of getActiveLoops(chat)) {
      if (isLoopPaused(loop)) continue;
      if (isLoopExpired(loop, now)) continue;
      if (next == null || loop.dueAt < next) {
        next = loop.dueAt;
      }
    }
  }

  return next;
}

/** Delay until the next wake; overdue loops retry quickly while waiting for idle. */
export function computeLoopWakeDelayMs(
  nextDueAt: number,
  now = Date.now(),
): number {
  const untilDue = nextDueAt - now;
  if (untilDue > 0) return untilDue;
  return OVERDUE_LOOP_RETRY_MS;
}

function clearLoopWakeTimer(): void {
  if (wakeTimer != null) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}

function scheduleLoopWake(): void {
  clearLoopWakeTimer();
  if (!tickerStarted) return;

  const chats = sessionState?.chats ? [...sessionState.chats] : [];
  const now = Date.now();
  const nextDueAt = findNextLoopWakeAt(chats, now);
  if (nextDueAt == null) return;

  const delayMs = computeLoopWakeDelayMs(nextDueAt, now);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void runLoopTick().catch((err) => {
      console.warn(
        '[loop] wake tick failed:',
        err instanceof Error ? err.message : err,
      );
    });
  }, delayMs);
}

// ── Schedule ─────────────────────────────────────────────────────────────────

/** Reschedule the precise wake timer after loop dueAt changes. */
export function notifyLoopScheduleChanged(): void {
  if (!tickerStarted) return;
  scheduleLoopWake();
}

export function advanceLoopSchedule(
  loop: ActiveLoopState,
  now: number,
): Partial<ActiveLoopState> {
  if (loop.kind === 'interval') {
    const intervalMs = Math.max(
      MIN_LOOP_INTERVAL_MS,
      loop.intervalMs ?? MIN_LOOP_INTERVAL_MS,
    );
    return {
      dueAt: now + intervalMs,
      runCount: loop.runCount + 1,
    };
  }

  const delay = Math.max(
    MIN_LOOP_INTERVAL_MS,
    loop.currentDelayMs ?? INITIAL_LOOP_AUTO_DELAY_MS,
  );
  return {
    dueAt: now + delay,
    runCount: loop.runCount + 1,
    currentDelayMs: delay,
  };
}

export interface LoopTickResult {
  fired: number;
  expired: number;
  skipped: string | null;
}

// ── Tick ─────────────────────────────────────────────────────────────────────

export async function runLoopTick(options: {
  now?: number;
  send?: LoopSendFn;
  chats?: Chat[];
  /** Override idle gate (tests). */
  isIdle?: (chat: Chat) => boolean;
  reportStatus?: (level: 'ok' | 'err', message: string) => void;
  /** Skip composer hint sync (tests / headless). */
  syncHint?: boolean;
} = {}): Promise<LoopTickResult> {
  if (ticking) {
    return { fired: 0, expired: 0, skipped: 'tick_in_progress' };
  }

  ticking = true;
  let fired = 0;
  let expired = 0;
  const now = options.now ?? Date.now();
  const send = options.send ?? sendFn;
  const idleCheck = options.isIdle ?? isChatIdleForLoop;
  const shouldSyncHint = options.syncHint !== false;
  const report =
    options.reportStatus ??
    ((level: 'ok' | 'err', message: string) => {
      level === 'err' ? setStatus('err', message) : showToast(message);
    });

  try {
    const chats =
      options.chats ??
      (sessionState?.chats ? [...sessionState.chats] : []);

    for (const chat of chats) {
      const loops = getActiveLoops(chat);
      if (!loops.length) continue;

      for (const loop of [...loops]) {
        if (!isLoopExpired(loop, now)) continue;
        removeActiveLoop(chat, loop.id);
        expired += 1;
        report('ok', `Loop #${loop.id} expired after 7 days`);
      }

      const remaining = getActiveLoops(chat);
      if (!remaining.length) {
        if (shouldSyncHint) syncLoopActiveHint();
        continue;
      }

      if (!idleCheck(chat)) continue;

      const due = remaining
        .filter((loop) => !isLoopPaused(loop) && isLoopDue(loop, now))
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
      const loop = due[0];
      if (!loop) continue;

      if (!send) {
        report('err', 'Loop ticker has no send handler');
        continue;
      }

      try {
        await ensureChatHistoryLoaded(chat.id);
        requireHistory(chat);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report('err', `Loop #${loop.id} history load failed: ${message}`);
        continue;
      }

      const schedulePatch = advanceLoopSchedule(loop, now);
      updateActiveLoop(chat, loop.id, schedulePatch);

      if (loop.kind === 'auto') {
        markLoopAwaitingPace(chat.id, loop.id);
      }

      let prompt: string;
      try {
        prompt = await resolveLoopPromptText(chat, loop.promptText);
      } catch (err) {
        clearLoopAwaitingPace(chat.id);
        const message = err instanceof Error ? err.message : String(err);
        report('err', `Loop #${loop.id} prompt failed: ${message}`);
        continue;
      }

      try {
        await send(chat, prompt);
        fired += 1;
      } catch (err) {
        clearLoopAwaitingPace(chat.id);
        const message = err instanceof Error ? err.message : String(err);
        report('err', `Loop #${loop.id} failed: ${message}`);
      }

      if (shouldSyncHint) syncLoopActiveHint();
    }
  } finally {
    ticking = false;
    notifyLoopScheduleChanged();
  }

  return { fired, expired, skipped: null };
}

/** Start the global loop ticker (idempotent). */
export function startLoopTicker(options: {
  intervalMs?: number;
  send?: LoopSendFn;
} = {}): void {
  if (options.send) {
    setLoopSendFn(options.send);
  }
  if (tickTimer != null) return;

  tickerStarted = true;
  const intervalMs = options.intervalMs ?? LOOP_TICK_INTERVAL_MS;
  const tick = () => {
    void runLoopTick().catch((err) => {
      console.warn(
        '[loop] tick failed:',
        err instanceof Error ? err.message : err,
      );
    });
  };
  tickTimer = setInterval(tick, intervalMs);
  tick();
  scheduleLoopWake();
}

/** Stop the ticker (tests / shutdown). */
export function stopLoopTicker(): void {
  if (tickTimer != null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  clearLoopWakeTimer();
  tickerStarted = false;
  ticking = false;
}
