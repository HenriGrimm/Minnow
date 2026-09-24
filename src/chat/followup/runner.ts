/**
 * /followup chain runner (MIN-206).
 *
 * A chain advances when the chat that owns it goes idle, so the fire trigger is the
 * parent's stream end (registered here) plus a slow safety sweep — the same
 * belt-and-braces design as the /loop ticker, and the reason a chain survives a
 * reload: the sweep runs once at boot over persisted chain records.
 *
 * The stream-end callback fires *before* streaming flags clear, so it defers with
 * `queueMicrotask` (see `src/chat/pending-mode.ts`) or the idle gate rejects its own
 * chat.
 */

import { reportBackgroundError } from '../../boot/report-background-error';
import { isChatTurnSetupPending } from '../chat-turn-guard';
import { isGoalEvaluating } from '../goal/evaluating-state';
import { isChatStreaming, subscribeChatStreamEnd } from '../streaming-state';
import {
  clearFollowupChain,
  findChatById,
  getFollowupChain,
  sessionState,
} from '../../state/sessions';
import { setStatus } from '../../ui/status';
import { syncFollowupActiveHint } from '../../ui/followup-active-hint';
import type { Chat } from '../../types';
import { generateFollowupTask } from './generate-task';
import { fallbackFollowupTask } from './seed-message';
import { isFollowupSendPending, spawnFollowupChat } from './spawn';
import { buildFollowupContextSummary } from './summary';

/** Safety sweep interval (stream end is the primary trigger). */
export const FOLLOWUP_SWEEP_INTERVAL_MS = 30_000;

export type FollowupReportFn = (level: 'ok' | 'err', message: string) => void;

export interface FollowupSweepOptions {
  /** Restrict the sweep to these chats (stream-end path). */
  chatIds?: string[];
  /** Override the chat list (tests). */
  chats?: Chat[];
  /** Override the idle gate (tests). */
  isIdle?: (chat: Chat) => boolean;
  /** Override the spawner (tests). */
  spawn?: typeof spawnFollowupChat;
  /** Override the task generator (tests). */
  generateTask?: typeof generateFollowupTask;
  reportStatus?: FollowupReportFn;
  /** Skip the chat panel sync (tests / headless). */
  syncHint?: boolean;
}

export interface FollowupSweepResult {
  fired: number;
  skipped: string | null;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeStreamEnd: (() => void) | null = null;
const inFlightChats = new Set<string>();
let runnerStarted = false;

/** Whether the chat is idle enough to hand work to a follow-up chat. */
export function isChatIdleForFollowup(chat: Chat): boolean {
  if (isFollowupSendPending(chat.id)) return false;
  if (isChatStreaming(chat.id)) return false;
  if (isChatTurnSetupPending(chat.id)) return false;
  if (isGoalEvaluating(chat.id)) return false;
  if (chat.pendingMessageQueue?.length) return false;
  return true;
}

function resolveSweepChats(options: FollowupSweepOptions): Chat[] {
  if (options.chats) return options.chats;
  if (options.chatIds?.length) {
    const out: Chat[] = [];
    for (const id of options.chatIds) {
      const chat = findChatById(id);
      if (chat) out.push(chat);
    }
    return out;
  }
  return sessionState?.chats ? [...sessionState.chats] : [];
}

/**
 * Advance every idle chat that owes a follow-up. Each chat has its own in-flight
 * guard, so another chat can advance while one follow-up turn is still running.
 */
export async function runFollowupSweep(
  options: FollowupSweepOptions = {},
): Promise<FollowupSweepResult> {
  const idleCheck = options.isIdle ?? isChatIdleForFollowup;
  const spawn = options.spawn ?? spawnFollowupChat;
  const generateTask = options.generateTask ?? generateFollowupTask;
  const shouldSyncHint = options.syncHint !== false;
  const report: FollowupReportFn =
    options.reportStatus ?? ((level, message) => setStatus(level, message));
  const pending: Promise<boolean>[] = [];
  let skippedInFlight = false;

  for (const chat of resolveSweepChats(options)) {
    const chain = getFollowupChain(chat);
    if (!chain || !idleCheck(chat)) continue;
    if (inFlightChats.has(chat.id)) {
      skippedInFlight = true;
      continue;
    }

    inFlightChats.add(chat.id);
    const isCurrent = () =>
      getFollowupChain(chat) === chain && findChatById(chat.id) === chat;
    const work = (async (): Promise<boolean> => {
      try {
        const summary = buildFollowupContextSummary(chat);
        let taskText = chain.promptText.trim();
        if (!taskText) {
          const generated = await generateTask(summary, { chat });
          if (!isCurrent()) return false;
          taskText = generated.task?.trim() || fallbackFollowupTask(summary);
        }

        if (!isCurrent()) return false;
        const result = await spawn({ sourceChat: chat, chain, taskText, summary, isCurrent });
        if (!isCurrent()) return false;
        if (!result.ok) {
          report('err', `Follow-up chain stalled: ${result.error}`);
          return false;
        }

        clearFollowupChain(chat);
        report('ok', `Follow-up ${chain.index + 1}/${chain.total} started in a new chat`);
        notifyFollowupScheduleChanged();
        return true;
      } catch (err) {
        if (isCurrent()) {
          const message = err instanceof Error ? err.message : String(err);
          report('err', `Follow-up chain failed: ${message}`);
          reportBackgroundError('followup-runner', err);
        }
        return false;
      } finally {
        inFlightChats.delete(chat.id);
        if (shouldSyncHint) syncFollowupActiveHint();
      }
    })();
    pending.push(work);
  }

  const results = await Promise.all(pending);
  return {
    fired: results.filter(Boolean).length,
    skipped: pending.length === 0 && skippedInFlight ? 'sweep_in_progress' : null,
  };
}

/**
 * Sweep soon (microtask) — used right after a chain is armed on an idle chat.
 * No-op until the runner is started from boot, so arming never spawns chats in
 * contexts that do not own the runner (same gate as the /loop ticker).
 */
export function notifyFollowupScheduleChanged(): void {
  if (!runnerStarted) return;
  queueMicrotask(() => {
    void runFollowupSweep().catch((err) => {
      reportBackgroundError('followup-runner', err);
    });
  });
}

/** Start the chain runner (idempotent): stream-end trigger, safety sweep, boot recovery. */
export function initFollowupRunner(options: { intervalMs?: number } = {}): void {
  if (runnerStarted) return;
  runnerStarted = true;

  unsubscribeStreamEnd = subscribeChatStreamEnd((chatId) => {
    queueMicrotask(() => {
      void runFollowupSweep({ chatIds: [chatId] }).catch((err) => {
        reportBackgroundError('followup-runner', err);
      });
    });
  });

  sweepTimer = setInterval(() => {
    void runFollowupSweep().catch((err) => {
      reportBackgroundError('followup-runner', err);
    });
  }, options.intervalMs ?? FOLLOWUP_SWEEP_INTERVAL_MS);

  // Reload recovery: a chain armed before a restart still owes its next chat.
  notifyFollowupScheduleChanged();
}

/** Stop the runner (tests / shutdown). */
export function stopFollowupRunner(): void {
  if (sweepTimer != null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  unsubscribeStreamEnd?.();
  unsubscribeStreamEnd = null;
  runnerStarted = false;
  inFlightChats.clear();
}
