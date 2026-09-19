import { streamFetch } from '../api/stream-fetch';
/**
 * Typed fetch wrappers for /api/research/* and SSE progress subscription.
 */

import type {
  ResearchDetailResponse,
  ResearchLibraryResponse,
  ResearchProgress,
  ResearchResultResponse,
  ResearchStartRequest,
  ResearchStartResponse,
  ResearchStatusResponse,
  ResearchStreamEndEvent,
} from './types';
import { withSessionToken } from '../api/session-token.ts';
import { buildResearchReportThemeSearchParams } from './report-theme-params.ts';

export class ResearchNotFoundError extends Error {
  constructor() {
    super('Research run not found');
    this.name = 'ResearchNotFoundError';
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed?.error) return String(parsed.error);
  } catch {}
  return text || res.statusText || `HTTP ${res.status}`;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/** POST /api/research/start */
export async function startResearch(
  body: ResearchStartRequest,
): Promise<ResearchStartResponse> {
  const res = await fetch('/api/research/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const payload = (await res.json()) as ResearchStartResponse;
  const researchId = typeof payload.researchId === 'string' ? payload.researchId.trim() : '';
  if (!researchId) {
    throw new Error('Missing researchId in response');
  }
  return { researchId };
}

/** GET /api/research/status/:id */
export async function fetchResearchStatus(researchId: string): Promise<ResearchStatusResponse> {
  const res = await fetch(`/api/research/status/${encodeURIComponent(researchId)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) {
    throw new ResearchNotFoundError();
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as ResearchStatusResponse;
}

/** GET /api/research/result/:id */
export async function fetchResearchResult(researchId: string): Promise<ResearchResultResponse> {
  const res = await fetch(`/api/research/result/${encodeURIComponent(researchId)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) {
    throw new ResearchNotFoundError();
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as ResearchResultResponse;
}

/** GET /api/research/detail/:id */
export async function fetchResearchDetail(researchId: string): Promise<ResearchDetailResponse> {
  const res = await fetch(`/api/research/detail/${encodeURIComponent(researchId)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) {
    throw new ResearchNotFoundError();
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as ResearchDetailResponse;
}

/** Normalize activity log rows from detail API (snake_case or camelCase). */
export function normalizeResearchActivityLog(
  detail: ResearchDetailResponse | Record<string, unknown>,
): ResearchProgress[] {
  const raw =
    (detail as ResearchDetailResponse).activityLog ??
    (detail as Record<string, unknown>).activity_log;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (row): row is ResearchProgress =>
      Boolean(row) && typeof row === 'object' && typeof (row as { phase?: unknown }).phase === 'string',
  );
}

/** URL for the visual HTML report (open in preview or new tab). */
export function researchReportUrl(researchId: string): string {
  const base = withSessionToken(`/api/research/report/${encodeURIComponent(researchId)}`);
  const themeQs = buildResearchReportThemeSearchParams().toString();
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${themeQs}`;
}

export interface FetchResearchLibraryOptions {
  search?: string;
  sort?: string;
  archived?: boolean;
  limit?: number;
}

// ── Library ──────────────────────────────────────────────────────────────────

/** GET /api/research/library */
export async function fetchResearchLibrary(
  options: FetchResearchLibraryOptions = {},
): Promise<ResearchLibraryResponse> {
  const params = new URLSearchParams();
  if (options.search?.trim()) params.set('search', options.search.trim());
  if (options.sort?.trim()) params.set('sort', options.sort.trim());
  if (options.archived === true) params.set('archived', 'true');
  if (options.archived === false) params.set('archived', 'false');
  if (options.limit != null && options.limit > 0) {
    params.set('limit', String(options.limit));
  }
  const qs = params.toString();
  const res = await fetch(`/api/research/library${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const payload = (await res.json()) as ResearchLibraryResponse & {
    research?: Array<Record<string, unknown>>;
  };
  const raw = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.research)
      ? payload.research
      : [];
  const items = raw.map((row) => normalizeLibraryItem(libraryWireRow(row)));
  return { items };
}

/** Coerce API / legacy library rows to a plain record for normalization. */
function libraryWireRow(row: Record<string, unknown> | import('./types').ResearchLibraryItem): Record<string, unknown> {
  return { ...row };
}

function normalizeLibraryItem(row: Record<string, unknown>): import('./types').ResearchLibraryItem {
  const started = row.startedAt ?? row.started_at;
  const completed = row.completedAt ?? row.completed_at;
  return {
    id: String(row.id ?? ''),
    query: String(row.query ?? ''),
    title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined,
    status: (row.status as import('./types').ResearchStatus) ?? 'done',
    category: typeof row.category === 'string' ? row.category : undefined,
    archived: Boolean(row.archived),
    startedAt: typeof started === 'string' ? started : undefined,
    completedAt:
      typeof completed === 'string'
        ? completed
        : typeof completed === 'number' && completed > 0
          ? new Date(completed).toISOString()
          : undefined,
    sourceCount: Number(row.sourceCount ?? row.source_count ?? 0) || undefined,
    rounds: (row.rounds as number | string | undefined) ?? undefined,
    duration: typeof row.duration === 'string' ? row.duration : undefined,
  };
}

// ── Mutate ───────────────────────────────────────────────────────────────────

/** POST /api/research/cancel/:id */
export async function cancelResearch(researchId: string): Promise<void> {
  const res = await fetch(`/api/research/cancel/${encodeURIComponent(researchId)}`, {
    method: 'POST',
  });
  if (res.status === 404) {
    return;
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

/** POST /api/research/:id/archive?archived=bool */
export async function archiveResearch(researchId: string, archived: boolean): Promise<void> {
  const res = await fetch(
    `/api/research/${encodeURIComponent(researchId)}/archive?archived=${archived ? 'true' : 'false'}`,
    { method: 'POST' },
  );
  if (res.status === 404) {
    throw new ResearchNotFoundError();
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

/** DELETE /api/research/:id */
export async function deleteResearch(researchId: string): Promise<void> {
  const res = await fetch(`/api/research/${encodeURIComponent(researchId)}`, {
    method: 'DELETE',
  });
  if (res.status === 404) {
    throw new ResearchNotFoundError();
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

export interface SubscribeToResearchStreamOptions {
  signal?: AbortSignal;
  onStreamOpen?: () => void;
  onProgress: (event: ResearchProgress) => void;
  onEnd?: (event?: ResearchStreamEndEvent) => void;
  onTransportError?: (err: unknown) => void;
}

// ── Stream ───────────────────────────────────────────────────────────────────

function parseResearchDataLine(dataLine: string): ResearchProgress | ResearchStreamEndEvent | null {
  try {
    const parsed = JSON.parse(dataLine) as Record<string, unknown>;
    if (parsed.final === true && typeof parsed.status === 'string') {
      const status = parsed.status;
      if (status === 'done' || status === 'error' || status === 'cancelled') {
        return {
          status,
          final: true,
          message: typeof parsed.message === 'string' ? parsed.message : undefined,
        };
      }
    }
    if (typeof parsed.phase === 'string') {
      return parsed as ResearchProgress;
    }
  } catch {
    return null;
  }
  return null;
}

function parseResearchSseBlock(block: string): ResearchProgress | ResearchStreamEndEvent | null {
  const lines = block.split('\n');
  let dataLine: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      dataLine = trimmed.slice(5).trim();
    }
  }
  if (!dataLine) return null;
  return parseResearchDataLine(dataLine);
}

/**
 * Subscribe to research SSE (`/api/research/stream/:id`).
 * Mirrors block parsing from `src/api/generations.ts`.
 */
export function subscribeToResearchStream(
  researchId: string,
  options: SubscribeToResearchStreamOptions,
): () => void {
  const controller = new AbortController();
  const combined = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  let cancelled = false;

  void (async () => {
    try {
      const res = await streamFetch(`/api/research/stream/${encodeURIComponent(researchId)}`, {
        method: 'GET',
        signal: combined,
      });

      if (res.status === 404) {
        throw new ResearchNotFoundError();
      }

      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }

      options.onStreamOpen?.();

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

          if (block.trim()) {
            const payload = parseResearchSseBlock(block);
            if (payload && 'final' in payload && payload.final) {
              options.onEnd?.(payload);
              return;
            }
            if (payload && 'phase' in payload) {
              options.onProgress(payload);
            }
          }

          endIndex = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim()) {
        const payload = parseResearchSseBlock(buffer);
        if (payload && 'final' in payload && payload.final) {
          options.onEnd?.(payload);
          return;
        }
        if (payload && 'phase' in payload) {
          options.onProgress(payload);
        }
      }

      options.onEnd?.();
    } catch (err) {
      if (cancelled) return;
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      options.onTransportError?.(err);
    } finally {
      controller.abort();
    }
  })();

  return () => {
    cancelled = true;
    controller.abort();
  };
}
