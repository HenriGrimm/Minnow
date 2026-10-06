/**
 * The `wait` tool: park a chat turn on a timer, then continue in the same loop.
 *
 * The tool call blocks until the timer fires and returns a tool result the model
 * reads as "the timer completed". While it runs, the user gets an in-app
 * notification so a parked agent is not mistaken for a stuck one.
 */

import { randomUUID } from '../lib/random-id.ts';
import { appIdForChat } from '../notifications/app-for-chat';
import { pushNotificationOrActiveChatSound } from '../notifications/push';
import { findChatById } from '../state/sessions';

/** Longest single wait. Kept under the 4 h `chat.generationMaxDurationMs` default. */
export const MAX_WAIT_MS = 2 * 60 * 60 * 1000;

/** Fallback when a caller omits the duration. */
export const DEFAULT_WAIT_MS = 60_000;

/** Reason used when the model sends none, so previews never read "Waiting 5m —". */
export const DEFAULT_WAIT_REASON = 'waiting';

/** One `1h30m`-style token; `s`/`m`/`h` each optional, at most one of each. */
const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*([smh])/gi;

/** Pending timers, so tests can clear them and no timer outlives its turn. */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

/** Human label for a duration: `30s`, `5m`, `1h30m`. */
export function formatWaitDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join('');
}

/**
 * Parse a model-supplied duration into milliseconds.
 *
 * Accepts `30s`, `5m`, `1h30m`, `90m`, or a bare number of seconds. Rejects
 * empty, non-finite, non-positive, and anything above {@link MAX_WAIT_MS}.
 */
export function parseWaitDuration(
  raw: unknown,
): { ok: true; ms: number } | { ok: false; error: string } {
  const invalid = (shown: string): { ok: false; error: string } => ({
    ok: false,
    error: `Error: duration must be between 1s and 2h (got "${shown}"). Use "30s", "5m", or "1h30m".`,
  });

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return invalid(String(raw));
    const ms = Math.round(raw * 1000);
    return ms > MAX_WAIT_MS ? invalid(String(raw)) : { ok: true, ms };
  }

  if (typeof raw !== 'string') return invalid(String(raw ?? ''));
  const text = raw.trim();
  if (!text) return invalid('');

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return parseWaitDuration(Number(text));
  }

  let ms = 0;
  let matched = '';
  DURATION_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(DURATION_TOKEN)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
    ms += value * factor;
    matched += match[0];
  }

  // Every character must belong to a token — "5 minutes" and "abc" are both rejected.
  if (!matched || matched.replace(/\s/g, '').length !== text.replace(/\s/g, '').length) {
    return invalid(text);
  }
  if (!Number.isFinite(ms) || ms <= 0) return invalid(text);
  return ms > MAX_WAIT_MS ? invalid(text) : { ok: true, ms: Math.round(ms) };
}

/** Timer capability injected into the chat turn, mirroring `AskCapability`. */
export interface WaitCapability {
  wait(input: {
    durationMs: number;
    reason: string;
    chatId?: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

/** Push the menubar alert when a wait timer fires. Never throws. */
export function notifyWaitTimerFired(input: {
  chatId?: string;
  reason: string;
  durationMs: number;
}): void {
  try {
    const chat = input.chatId ? findChatById(input.chatId) : undefined;
    if (!chat) return;
    const reason = input.reason.trim() || DEFAULT_WAIT_REASON;
    pushNotificationOrActiveChatSound({
      kind: 'agent_wait',
      title: chat.name?.trim() || 'Chat',
      preview: `Waiting ${formatWaitDuration(input.durationMs)} — ${reason}`,
      chatId: chat.id,
      appId: appIdForChat(chat),
      dedupeKey: `wait:${chat.id}:${randomUUID()}`,
      os: true,
    });
  } catch {
    // A notification must never fail a tool call.
  }
}

/** Build a capability that parks the caller until the timer fires. */
export function createWaitCapability(): WaitCapability {
  return {
    wait({ durationMs, reason, chatId, signal }) {
      return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          const err = new Error('wait aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }

        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
          clearTimeout(timer);
          pendingTimers.delete(timer);
          const err = new Error('wait aborted');
          err.name = 'AbortError';
          reject(err);
        };

        timer = setTimeout(() => {
          pendingTimers.delete(timer);
          signal?.removeEventListener('abort', onAbort);
          notifyWaitTimerFired({ chatId, reason, durationMs });
          resolve(
            `Timer completed after ${formatWaitDuration(durationMs)} — ${reason.trim() || DEFAULT_WAIT_REASON}. Continue now.`,
          );
        }, durationMs);

        pendingTimers.add(timer);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** Clear pending timers (tests). */
export function resetWaitTimersForTests(): void {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
}
