import type { PostChatCompletions } from './adapters';

/**
 * Agent-family fallback role used when the loop does not pass one.
 * Not in `NON_AGENT_FALLBACK_ROLES` (`utility`, `chat-titles`, `goal-eval`,
 * `editor-completion`). Matching `tryNonStreamingFallback` in the extracted loop.
 */
export const RUNNER_FALLBACK_ROLE: 'sub-agent';

export interface CompletionStreamOptions {
  signal?: AbortSignal;
  fallbackRole?: string | null;
  chatId?: string | null;
  routerPreferAvailable?: boolean;
}

/** Async iterable of raw SSE text payloads plus the generation id for tests. */
export interface CompletionStream extends AsyncIterable<string> {
  generationId: string;
}

/**
 * In-process completion stream (no HTTP hop).
 * Payloads are the same utf8 SSE bytes `server/runner/sse-parse.js` consumes.
 */
export function createCompletionStream(
  providerId: string,
  body: unknown,
  options?: CompletionStreamOptions,
): Promise<CompletionStream>;

/**
 * Server-default completions adapter. Synthetic `Response` replaying the
 * in-process stream. Renderer keeps HTTP `/api/generations`.
 */
export const postChatCompletionsInProcess: PostChatCompletions;
