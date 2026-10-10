/**
 * Central chat completions fetch — backed by /api/generations with a synthetic Response
 * so existing SSE readers stay unchanged.
 */

import {
  cancelGeneration,
  createGeneration,
  subscribeToGenerationRaw,
  type GenerationEndEvent,
  type FallbackRole,
  type CreateGenerationOptions,
} from '../api/generations';
import type { ChatCompletionBody } from '../api/chat';
import { parseCompletionResponseBody } from '../api/sse-parse';
import type { ChatCompletionChunk } from '../types';
import { retryOnceOnTransientFetch } from '../lib/transient-fetch-retry';
import type { ProviderPublic } from './types';
import { resolveProviderEndpoints } from './resolve';
import { noteRouterAssignment } from '../models/routers';

export interface PostChatOptions {
  stream?: boolean;
  fallbackRole?: FallbackRole;
  /**
   * Persist the generation after terminal (main chat reload re-subscribe). Default
   * false — sub-agents / titles keep the short eviction window.
   */
  persist?: boolean;
  /** Active chat id for webhook chat.completed payloads. */
  chatId?: string;
  /**
   * Re-subscribe to an existing generation (boot resume) instead of POST.
   * Later tool-loop rounds omit this so they create a new generation (MIN-187).
   */
  resumeGenerationId?: string;
  /** Fired once the generation id is known (new or resumed). */
  onGenerationId?: (generationId: string) => void;
  /** Capabilities `body` was sanitized with; the server re-sanitizes with them. */
  modelCapabilities?: CreateGenerationOptions['modelCapabilities'];
}

/**
 * POST chat/completions for the given provider via backend generations.
 * Returns a Response whose body replays upstream SSE bytes from the generation stream.
 *
 * P6-D: pass `resumeGenerationId` to skip POST and subscribe to `/api/generations/:id/stream`.
 * Main chat passes `persist: true` so reload can re-subscribe.
 */
export async function postChatCompletions(
  provider: ProviderPublic,
  body: ChatCompletionBody & { stream?: boolean; stream_options?: { include_usage: boolean } },
  signal: AbortSignal,
  options: PostChatOptions = {},
): Promise<Response> {
  const payload = {
    ...body,
    stream: options.stream ?? body.stream ?? true,
  };

  const resumeId = options.resumeGenerationId?.trim();
  const generationId = resumeId
    ? resumeId
    : (
        await retryOnceOnTransientFetch(() =>
          createGeneration(provider.id, payload, {
            persist: options.persist === true,
            fallbackRole: options.fallbackRole,
            chatId: options.chatId,
            modelCapabilities: options.modelCapabilities,
          }),
        )
      ).generationId;
  options.onGenerationId?.(generationId);

  if (signal.aborted) {
    await cancelGeneration(generationId);
    throw new DOMException('Aborted', 'AbortError');
  }

  let streamUnsubscribe: (() => void) | null = null;
  let removeAbortListener: (() => void) | null = null;

  const stopSubscription = (): void => {
    streamUnsubscribe?.();
    streamUnsubscribe = null;
    removeAbortListener?.();
    removeAbortListener = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let sawBytes = false;

      const failStream = (err: unknown): void => {
        if (closed) return;
        closed = true;
        stopSubscription();
        controller.error(err);
      };

      const closeStream = (): void => {
        if (closed) return;
        closed = true;
        stopSubscription();
        try {
          controller.close();
        } catch {}
      };

      streamUnsubscribe = subscribeToGenerationRaw(
        generationId,
        {
          onChunk: (text) => {
            if (closed) return;
            if (provider.id === 'minnow-router' && options.chatId) {
              try {
                const payload = JSON.parse(text.trim().replace(/^data:\s*/, ''));
                const route = payload.minnow_router;
                if (route) noteRouterAssignment(options.chatId, route.providerId, route.modelId, route.routerId);
              } catch {}
            }
            sawBytes = true;
            controller.enqueue(new TextEncoder().encode(text));
          },
          onEnd: (event?: GenerationEndEvent) => {
            if (event?.status === 'error') {
              failStream(new Error(event.errorMessage ?? 'Generation failed'));
              return;
            }
            if (event?.status === 'cancelled') {
              failStream(new DOMException('Aborted', 'AbortError'));
              return;
            }
            if (event?.status === 'complete' && !sawBytes) {
              failStream(new Error('The provider returned an empty response.'));
              return;
            }
            closeStream();
          },
          onTransportError: (err) => {
            failStream(err);
          },
          onAbort: () => {
            failStream(new DOMException('Aborted', 'AbortError'));
          },
        },
        signal,
      );

      const onSignalAbort = () => {
        stopSubscription();
        failStream(new DOMException('Aborted', 'AbortError'));
        void cancelGeneration(generationId).catch(() => {});
      };
      signal.addEventListener('abort', onSignalAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onSignalAbort);
      if (signal.aborted) onSignalAbort();
    },
    cancel() {
      stopSubscription();
      return cancelGeneration(generationId).catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Non-streaming completion via backend generations (read body as text, then parse).
 * Never call Response.json() on the SSE shim — see BUG-016 / parseCompletionResponseBody.
 */
export async function completeNonStreamingViaGenerations(
  provider: ProviderPublic,
  body: ChatCompletionBody,
  signal: AbortSignal,
  options: Pick<PostChatOptions, 'fallbackRole'> = {},
): Promise<ChatCompletionChunk> {
  const res = await postChatCompletions(
    provider,
    { ...body, stream: false },
    signal,
    { stream: false, fallbackRole: options.fallbackRole },
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseCompletionResponseBody(text);
}

/** Re-export for callers that need URLs without posting. */
export { resolveProviderEndpoints };
