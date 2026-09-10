import { parseSseEventBlock } from './sse-parse';
import {
  formatOutOfUsageMessage,
  isQuotaExhaustedText,
} from '../../server/generations/quota-error.js';
import type { ChatCompletionChunk } from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

/** Terminal SSE payload from the server `event: end` sentinel. */
export interface GenerationEndEvent {
  status: 'complete' | 'error' | 'cancelled';
  errorMessage?: string;
  /** The provider refused because its usage allowance is spent, not for backpressure. */
  quotaExceeded?: boolean;
  fallbackUsed?: boolean;
  chosenProviderId?: string;
  chosenModelId?: string;
}

/** Notified once per terminal event that reports a spent provider allowance. */
export type GenerationQuotaListener = (event: GenerationEndEvent) => void;

const quotaListeners = new Set<GenerationQuotaListener>();

/**
 * Subscribe to "the provider is out of usage" terminal events.
 *
 * Registered from `initNotificationProducers` rather than imported here, so
 * this module keeps no dependency on UI or app state.
 */
export function onGenerationQuotaExceeded(listener: GenerationQuotaListener): () => void {
  quotaListeners.add(listener);
  return () => {
    quotaListeners.delete(listener);
  };
}

/** True when a generation error means the allowance is spent, not that we went too fast. */
export function isOutOfUsageError(
  event: GenerationEndEvent | string | undefined | null,
): boolean {
  if (!event) return false;
  if (typeof event === 'string') return isQuotaExhaustedText(event);
  return event.quotaExceeded === true || isQuotaExhaustedText(event.errorMessage);
}

function announceQuotaExceeded(event: GenerationEndEvent): void {
  for (const listener of quotaListeners) {
    try {
      listener(event);
    } catch {
      /* a bad listener must not break the stream */
    }
  }
}

/** Role or routing-row key for server-side fallback chain lookup. */
export type FallbackRole = string;

export class GenerationNotFoundError extends Error {
  constructor() {
    super('Generation not found');
    this.name = 'GenerationNotFoundError';
  }
}

/** User-facing copy when a persisted generation id no longer exists (server restart). */
export const GENERATION_LOST_ON_RESTART_MESSAGE =
  'This reply was lost when the server restarted.';

/**
 * Replace opaque fetch-abort copy with an actionable message (timeouts, stale tabs).
 */
export function formatGenerationErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return 'Unknown error';
  const lower = trimmed.toLowerCase();
  if (
    lower === 'this operation was aborted' ||
    lower === 'the operation was aborted' ||
    lower === 'aborted' ||
    lower.includes('operation was aborted')
  ) {
    return 'The connection to the model was interrupted (timeout or server restart). Try again.';
  }
  if (
    trimmed === 'UND_ERR_BODY_TIMEOUT' ||
    trimmed === 'UND_ERR_HEADERS_TIMEOUT' ||
    trimmed === 'UND_ERR_CONNECT_TIMEOUT' ||
    lower.includes('und_err_body_timeout') ||
    lower.includes('und_err_headers_timeout')
  ) {
    return 'The model stopped sending data for several minutes (connection timed out). Try again, shorten context, or adjust Generation timeouts in Settings → Agents → Watchdog.';
  }
  if (isQuotaExhaustedText(trimmed)) {
    return formatOutOfUsageMessage({ detail: trimmed });
  }
  if (
    lower.includes('upstream http 503') ||
    lower.includes('inference is temporarily unavailable')
  ) {
    return 'The model provider is temporarily unavailable (HTTP 503). Load a model in LM Studio, wait for it to finish loading, or switch the top-bar model and try again.';
  }
  return trimmed;
}

/** True when a generation `event: end` error payload is a server idle/max timeout. */
export function isGenerationTimeoutError(message: string | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return (
    lower.includes('stopped sending data') ||
    lower.includes('server limit') ||
    lower.includes('connection timed out')
  );
}

export interface CreateGenerationOptions {
  /** When true, generation state survives 5 minutes after terminal (main chat). */
  persist?: boolean;
  /** Optional role for server-side fallback chain resolution. */
  fallbackRole?: FallbackRole;
  /** Active chat id for webhook chat.completed payloads. */
  chatId?: string;
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Start a backend-owned completion; returns immediately with a generation id.
 */
export async function createGeneration(
  providerId: string,
  body: unknown,
  options: CreateGenerationOptions = {},
): Promise<{ generationId: string }> {
  const res = await fetch('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId,
      body,
      persist: options.persist === true,
      ...(options.fallbackRole ? { fallbackRole: options.fallbackRole } : {}),
      ...(options.chatId ? { chatId: options.chatId } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err}`);
  }

  const payload = (await res.json()) as { generationId?: string };
  const generationId =
    typeof payload.generationId === 'string' ? payload.generationId.trim() : '';
  if (!generationId) {
    throw new Error('Missing generationId in response');
  }
  return { generationId };
}

export const SSE_BLOCKS_PER_YIELD = 8;

type SchedulerWithYield = { yield: () => Promise<void> };

/** Prefer `scheduler.yield()`, then rAF, then a 0 ms timeout. */
export function yieldForSseBurst(): Promise<void> {
  const sched = (globalThis as typeof globalThis & { scheduler?: SchedulerWithYield })
    .scheduler;
  if (sched && typeof sched.yield === 'function') {
    return sched.yield();
  }
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function consumeSseBlocks(
  bufferRef: { value: string },
  cancelled: () => boolean,
  onBlock: (block: string) => 'continue' | 'stop',
): Promise<'continue' | 'stop'> {
  let sinceYield = 0;
  let boundary = findSseBoundary(bufferRef.value);
  while (boundary) {
    if (cancelled()) return 'stop';
    const block = bufferRef.value.slice(0, boundary.index);
    bufferRef.value = bufferRef.value.slice(boundary.index + boundary.length);
    const action = onBlock(block);
    if (action === 'stop') return 'stop';
    if (block.trim()) {
      sinceYield += 1;
      if (sinceYield >= SSE_BLOCKS_PER_YIELD) {
        sinceYield = 0;
        if (findSseBoundary(bufferRef.value)) {
          await yieldForSseBurst();
        }
      }
    }
    boundary = findSseBoundary(bufferRef.value);
  }
  return 'continue';
}

class GenerationStreamHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`HTTP ${status}: ${detail}`);
    this.name = 'GenerationStreamHttpError';
  }
}

function findSseBoundary(text: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(text);
  return match ? { index: match.index, length: match[0].length } : null;
}

const GENERATION_STREAM_RECONNECT_ATTEMPTS = 1;

async function consumeGenerationStream(
  generationId: string,
  signal: AbortSignal,
  cancelled: () => boolean,
  handlers: {
    onStreamOpen?: () => void;
    onBlock: (block: string) => void;
    onEnd: (event: GenerationEndEvent) => void;
  },
): Promise<void> {
  let deliveredBlocks = 0;
  let notifiedOpen = false;

  for (let attempt = 0; attempt <= GENERATION_STREAM_RECONNECT_ATTEMPTS; attempt += 1) {
    let replayBlock = 0;
    try {
      const res = await fetch(`/api/generations/${generationId}/stream`, {
        method: 'GET',
        signal,
      });

      if (res.status === 404) throw new GenerationNotFoundError();
      if (!res.ok) throw new GenerationStreamHttpError(res.status, await res.text());
      if (!res.body) throw new Error('Missing response body');

      if (!notifiedOpen) {
        notifiedOpen = true;
        handlers.onStreamOpen?.();
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const bufferRef = { value: '' };
      let reachedEof = false;

      const acceptBlock = (block: string): 'continue' | 'stop' => {
        const endPayload = parseEndEventBlock(block);
        if (endPayload) {
          handlers.onEnd(endPayload);
          return 'stop';
        }
        if (!block.trim()) return 'continue';
        replayBlock += 1;
        if (replayBlock <= deliveredBlocks) return 'continue';
        handlers.onBlock(block);
        deliveredBlocks += 1;
        return 'continue';
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            reachedEof = true;
            break;
          }
          if (cancelled()) return;
          bufferRef.value += decoder.decode(value, { stream: true });
          const consumed = await consumeSseBlocks(bufferRef, cancelled, acceptBlock);
          if (consumed === 'stop' || cancelled()) return;
        }

        bufferRef.value += decoder.decode();
        const consumed = await consumeSseBlocks(bufferRef, cancelled, acceptBlock);
        if (consumed === 'stop' || cancelled()) return;

        if (bufferRef.value.trim()) {
          const endPayload = parseEndEventBlock(bufferRef.value);
          if (endPayload) {
            handlers.onEnd(endPayload);
            return;
          }
        }
        throw new Error('Generation stream ended before the terminal event');
      } finally {
        if (!reachedEof) {
          try {
            await reader.cancel?.();
          } catch {
          }
        }
        try {
          reader.releaseLock?.();
        } catch {
        }
      }
    } catch (err) {
      if (cancelled()) return;
      if (
        signal.aborted ||
        err instanceof GenerationNotFoundError ||
        (err instanceof GenerationStreamHttpError && err.status < 500)
      ) {
        throw err;
      }
      if (attempt >= GENERATION_STREAM_RECONNECT_ATTEMPTS) throw err;
    }
  }
}

export interface SubscribeToGenerationOptions {
  signal?: AbortSignal;
  onStreamOpen?: () => void;
  onChunk: (chunk: ChatCompletionChunk) => void;
  onEnd?: (event?: GenerationEndEvent) => void;
  onTransportError?: (err: unknown) => void;
  onAbort?: () => void;
}

// ── Subscribe ────────────────────────────────────────────────────────────────

export function subscribeToGeneration(
  generationId: string,
  options: SubscribeToGenerationOptions,
): () => void {
  const controller = new AbortController();
  const combined = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  let cancelled = false;

  void (async () => {
    try {
      await consumeGenerationStream(generationId, combined, () => cancelled, {
        onStreamOpen: options.onStreamOpen,
        onBlock: (block) => feedSseBlock(block, options.onChunk),
        onEnd: (event) => options.onEnd?.(event),
      });
    } catch (err) {
      if (cancelled) return;
      if (combined.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        options.onAbort?.();
        return;
      }
      options.onTransportError?.(err);
    }
  })();

  return () => {
    cancelled = true;
    controller.abort();
  };
}

export interface SubscribeToGenerationRawHandlers {
  onChunk: (text: string) => void;
  onEnd?: (event?: GenerationEndEvent) => void;
  onTransportError?: (err: unknown) => void;
  onAbort?: () => void;
}

/**
 * Raw-byte subscribe for {@link postChatCompletions} shim (replays verbatim SSE blocks).
 */
export function subscribeToGenerationRaw(
  generationId: string,
  handlers: SubscribeToGenerationRawHandlers,
  signal?: AbortSignal,
): () => void {
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  let cancelled = false;

  void (async () => {
    try {
      await consumeGenerationStream(generationId, combined, () => cancelled, {
        onBlock: (block) => {
          handlers.onChunk(`${block.replace(/[\r\n]+$/, '')}\n\n`);
        },
        onEnd: (event) => handlers.onEnd?.(event),
      });
    } catch (err) {
      if (cancelled) return;
      if (combined.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        handlers.onAbort?.();
        return;
      }
      handlers.onTransportError?.(err);
    }
  })();

  return () => {
    cancelled = true;
    controller.abort();
  };
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/** Cancel upstream generation (Stop button). */
export async function cancelGeneration(generationId: string): Promise<void> {
  const res = await fetch(`/api/generations/${generationId}/cancel`, {
    method: 'POST',
  });
  if (res.status === 404) {
    return;
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err}`);
  }
}

function feedSseBlock(block: string, onChunk: (chunk: ChatCompletionChunk) => void): void {
  if (!block.trim()) return;
  parseSseEventBlock(block, onChunk);
}

function parseEndEventBlock(block: string): GenerationEndEvent | null {
  const lines = block.split(/\r\n|\r|\n/);
  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trim());
    }
  }

  if (eventName !== 'end' || dataLines.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(dataLines.join('\n')) as GenerationEndEvent;
    if (
      parsed.status === 'complete' ||
      parsed.status === 'error' ||
      parsed.status === 'cancelled'
    ) {
      if (parsed.status === 'error' && isOutOfUsageError(parsed)) {
        announceQuotaExceeded(parsed);
      }
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}
