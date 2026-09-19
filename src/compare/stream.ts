import { streamFetch } from '../api/stream-fetch';
/**
 * Client helpers for compare generation streams (redacted SSE path).
 */

import { parseSseEventBlock } from '../api/sse-parse';
import type { ChatCompletionChunk } from '../types';
import type { GenerationEndEvent } from '../api/generations';

export interface CompareStreamHandlers {
  signal?: AbortSignal;
  onChunk: (chunk: ChatCompletionChunk) => void;
  onEnd?: (event?: GenerationEndEvent) => void;
  onTransportError?: (err: unknown) => void;
}

function parseEndEventBlock(block: string): GenerationEndEvent | null {
  const lines = block.split('\n');
  let eventName: string | null = null;
  let dataLine: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      dataLine = trimmed.slice(5).trim();
    }
  }
  if (eventName !== 'end' || !dataLine) return null;
  try {
    const parsed = JSON.parse(dataLine) as GenerationEndEvent;
    if (
      parsed.status === 'complete' ||
      parsed.status === 'error' ||
      parsed.status === 'cancelled'
    ) {
      delete parsed.chosenProviderId;
      delete parsed.chosenModelId;
      delete parsed.fallbackUsed;
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

/** Stream key: numeric screen index or legacy left/right aliases. */
export type CompareStreamKey = number | 'left' | 'right';

/**
 * Subscribe to a compare column stream via the redacting compare proxy route.
 */
export function subscribeToCompareStream(
  sessionId: string,
  side: CompareStreamKey,
  handlers: CompareStreamHandlers,
): () => void {
  const controller = new AbortController();
  const combined = handlers.signal
    ? AbortSignal.any([handlers.signal, controller.signal])
    : controller.signal;

  let cancelled = false;

  void (async () => {
    try {
      const streamKey = typeof side === 'number' ? String(side) : side;
      const res = await streamFetch(
        `/api/compare/${encodeURIComponent(sessionId)}/stream/${streamKey}`,
        { method: 'GET', signal: combined },
      );
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err}`);
      }
      if (!res.body) {
        throw new Error('Missing response body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let endIndex = buffer.indexOf('\n\n');
        while (endIndex >= 0) {
          const block = buffer.slice(0, endIndex);
          buffer = buffer.slice(endIndex + 2);

          const endPayload = parseEndEventBlock(block);
          if (endPayload) {
            handlers.onEnd?.(endPayload);
            return;
          }

          if (block.trim()) {
            parseSseEventBlock(block, handlers.onChunk);
          }
          endIndex = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim()) {
        const endPayload = parseEndEventBlock(buffer);
        if (endPayload) {
          handlers.onEnd?.(endPayload);
          return;
        }
        parseSseEventBlock(buffer, handlers.onChunk);
      }
      handlers.onEnd?.();
    } catch (err) {
      if (cancelled) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      handlers.onTransportError?.(err);
    } finally {
      controller.abort();
    }
  })();

  return () => {
    cancelled = true;
    controller.abort();
  };
}
