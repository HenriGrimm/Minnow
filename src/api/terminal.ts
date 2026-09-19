import { streamFetch } from './stream-fetch';
export interface TerminalRunStart {
  runId: string;
  startedAt: number;
}

export type TerminalStreamEvent =
  | { type: 'meta'; runId: string; command: string; cwd: string }
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'exit'; code: number | null; timedOut: boolean; stopped?: boolean }
  | { type: 'error'; message: string };

/** Parse SSE `data:` JSON lines from a text chunk. */
export function parseTerminalSseChunk(
  text: string,
  onEvent: (ev: TerminalStreamEvent) => void,
): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      onEvent(JSON.parse(payload) as TerminalStreamEvent);
    } catch {}
  }
}

/** Start a terminal run on the local dev server. */
export async function startTerminalRun(body: {
  command: string;
  args?: string[];
  shell?: boolean;
  chatId: string;
  source: 'user' | 'agent';
  toolCallId?: string;
  /** Allow-listed workspace root; agent runs default to chat worktree when omitted. */
  workspaceRoot?: string;
  /** Working directory relative to workspaceRoot (or server base when omitted). */
  cwd?: string;
  /** Custom timeout in ms (1000–600000). Defaults to server COMMAND_TIMEOUT_MS (30s). */
  timeoutMs?: number;
  /** Prefer-mode approval to run without sandbox when unavailable. */
  allowUnsandboxed?: boolean;
}): Promise<TerminalRunStart> {
  const res = await fetch('/api/terminal/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as {
    runId?: string;
    startedAt?: number;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(payload.error ?? `Terminal run failed (${res.status})`);
  }
  if (!payload.runId) {
    throw new Error('Terminal run response missing runId');
  }
  return {
    runId: payload.runId,
    startedAt: payload.startedAt ?? Date.now(),
  };
}

/**
 * Subscribe to stdout/stderr/exit events until the run completes.
 */
export async function streamTerminalRun(
  runId: string,
  onEvent: (ev: TerminalStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await streamFetch(`/api/terminal/stream/${encodeURIComponent(runId)}`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal,
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `Terminal stream failed (${res.status})`);
  }

  if (!res.body) {
    throw new Error('Terminal stream has no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        parseTerminalSseChunk(part, onEvent);
      }
    }
    if (buffer.trim()) {
      parseTerminalSseChunk(buffer, onEvent);
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

/** Load persisted terminal history for a chat. */
export async function loadTerminalHistory(
  chatId: string,
): Promise<import('../types').TerminalRunRecord[]> {
  const res = await fetch(
    `/api/terminal/history?chatId=${encodeURIComponent(chatId)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as { runs?: import('../types').TerminalRunRecord[] };
  return Array.isArray(body.runs) ? body.runs : [];
}

/** Cancel an in-flight agent terminal run (e.g. when the user stops generation). */
export async function cancelTerminalRun(runId: string): Promise<boolean> {
  const res = await fetch(`/api/terminal/cancel/${encodeURIComponent(runId)}`, {
    method: 'POST',
  });
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
  return body.ok === true;
}

/** Fetch log tail for a prior run. */
export async function fetchTerminalLog(runId: string): Promise<string | null> {
  const res = await fetch(`/api/terminal/log/${encodeURIComponent(runId)}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { text?: string };
  return typeof body.text === 'string' ? body.text : null;
}
