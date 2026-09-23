/**
 * Browser client for /api/memory/* when npm start is running.
 */

import { isLocalServerAvailable } from '../tools/config';
import { brainWorkspaceKeyFromPath } from '../lib/brain-workspace-key';
import { getWorkspacePath } from '../state/workspace';
import type {
  MemoryEntryMeta,
  MemoryEntryWithBody,
  MemoryRetrieveResult,
  MemoryEmbeddingsStatus,
  MemoryEmbeddingsReindexResult,
  MemoryEmbeddingsWarmupResult,
  MemoryEmbeddingsConfig,
  MemoryEmbeddingsOpResult,
} from './types';
import type { PromptProfile } from '../chat/prompts/types';

const API_BASE = '';

async function memoryFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  if (!isLocalServerAvailable()) return null;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function parseMemoryApiError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  if (body && typeof body === 'object' && 'error' in body) {
    return String((body as { error: unknown }).error);
  }
  return res.statusText || `HTTP ${res.status}`;
}

/** Embeddings mutations return server error text instead of swallowing failures. */
async function memoryEmbeddingsFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<MemoryEmbeddingsOpResult<T>> {
  if (!isLocalServerAvailable()) {
    return { kind: 'err', error: 'Open Minnow to use memory embeddings.' };
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      return { kind: 'err', error: await parseMemoryApiError(res) };
    }
    return { kind: 'ok', value: (await res.json()) as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'err', error: message };
  }
}

/** Expert-scoped memory entry (Brain pages under experts/<id>/facts/). */
export interface ExpertMemoryEntry extends MemoryEntryWithBody {
  path: string;
}

/** List accepted long-term memories for one expert. */
export async function fetchExpertMemories(
  expertId: string,
  includeBody = true,
): Promise<ExpertMemoryEntry[] | null> {
  const id = expertId.trim();
  if (!id) return null;
  const qs = includeBody ? '?includeBody=1' : '';
  const data = await memoryFetch<{ entries: ExpertMemoryEntry[] }>(
    `/api/brain/experts/${encodeURIComponent(id)}/memories${qs}`,
  );
  return data?.entries ?? null;
}

/** Delete one expert memory page by wiki-relative path. */
export async function deleteExpertMemoryPage(pagePath: string): Promise<boolean> {
  if (!isLocalServerAvailable()) return false;
  const path = pagePath.trim().replace(/\\/g, '/');
  if (!path) return false;
  try {
    const res = await fetch(
      `${API_BASE}/api/brain/page?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Remove all accepted memories for one expert namespace. */
export async function clearExpertMemories(expertId: string): Promise<number | null> {
  const id = expertId.trim();
  if (!id || !isLocalServerAvailable()) return null;
  try {
    const res = await fetch(
      `${API_BASE}/api/brain/experts/${encodeURIComponent(id)}/memories/clear`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { removed?: number };
    return typeof data.removed === 'number' ? data.removed : 0;
  } catch {
    return null;
  }
}

/** Ping memory API. */
export async function pingMemoryApi(): Promise<boolean> {
  const data = await memoryFetch<{ ok: boolean }>('/api/memory/ping');
  return data?.ok === true;
}

export interface MemoryStatus {
  enabled: boolean;
  entryCount: number;
  home: string;
}

/** List memory entries (metadata only unless includeBody). */
export async function fetchMemoryEntries(
  includeBody = true,
): Promise<MemoryEntryWithBody[] | null> {
  const qs = includeBody ? '?includeBody=1' : '';
  const data = await memoryFetch<{ entries: MemoryEntryWithBody[] }>(
    `/api/memory/entries${qs}`,
  );
  if (!data?.entries) return null;
  return data.entries;
}

/** Delete one memory entry by id. */
export async function deleteMemoryEntry(id: string): Promise<boolean> {
  if (!isLocalServerAvailable()) return false;
  try {
    const res = await fetch(
      `${API_BASE}/api/memory/entries/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Server memory status (enabled flag, entry count, home path). */
export async function fetchMemoryStatus(): Promise<MemoryStatus | null> {
  const data = await memoryFetch<MemoryStatus>('/api/memory/status');
  if (!data) return null;
  return {
    enabled: data.enabled !== false,
    entryCount: typeof data.entryCount === 'number' ? data.entryCount : 0,
    home: data.home ?? '',
  };
}

/** Whether memory is enabled globally (from server config). */
export async function fetchMemoryEnabled(): Promise<boolean> {
  const status = await fetchMemoryStatus();
  return status?.enabled !== false;
}

/** Retrieve formatted memory block for prompt injection (via Brain wiki retrieve). */
export async function retrieveMemoryBlock(options: {
  query?: string;
  profile?: PromptProfile;
  limit?: number;
  expertId?: string;
  autoInject?: boolean;
}): Promise<string> {
  const enabled = await fetchMemoryEnabled();
  if (!enabled) return '';

  const workspaceKey = brainWorkspaceKeyFromPath(getWorkspacePath());

  const data = await memoryFetch<MemoryRetrieveResult>('/api/brain/retrieve', {
    method: 'POST',
    body: JSON.stringify({
      query: options.query ?? '',
      profile: options.profile ?? 'full',
      limit: options.limit ?? 12,
      workspaceKey,
      ...(options.autoInject ? { autoInject: true } : {}),
      ...(options.expertId?.trim()
        ? { scope: { expertId: options.expertId.trim() } }
        : {}),
    }),
  });
  return data?.block?.trim() ?? '';
}

/** Create a memory entry (settings / agent use). */
export async function createMemoryEntry(input: {
  title: string;
  body: string;
  tags?: string[];
  source?: 'user' | 'agent' | 'self-heal';
}): Promise<MemoryEntryMeta | null> {
  const data = await memoryFetch<{ entry: MemoryEntryMeta }>('/api/memory/entries', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data?.entry ?? null;
}

/** Update an existing memory entry by id. */
export async function updateMemoryEntry(
  id: string,
  input: {
    title?: string;
    body?: string;
    tags?: string[];
    pinned?: boolean;
  },
): Promise<MemoryEntryMeta | null> {
  const data = await memoryFetch<{ entry: MemoryEntryMeta }>(
    `/api/memory/entries/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
    },
  );
  return data?.entry ?? null;
}

/** Clear all memory entries. */
export async function clearMemory(archive = true): Promise<boolean> {
  const data = await memoryFetch<{ removed: number }>('/api/memory/clear', {
    method: 'POST',
    body: JSON.stringify({ archive }),
  });
  return data != null;
}

/** Backup memory store. */
export async function backupMemory(): Promise<string | null> {
  const data = await memoryFetch<{ backupId: string }>('/api/memory/backup', {
    method: 'POST',
    body: '{}',
  });
  return data?.backupId ?? null;
}

/** Fetch semantic embeddings status for memory vectors. */
export async function fetchMemoryEmbeddingsStatus(): Promise<MemoryEmbeddingsStatus | null> {
  return memoryFetch<MemoryEmbeddingsStatus>('/api/memory/embeddings/status');
}

/** Update memory embeddings settings on the server. */
export async function saveMemoryEmbeddingsConfig(
  partial: Partial<MemoryEmbeddingsConfig>,
): Promise<MemoryEmbeddingsOpResult<MemoryEmbeddingsConfig>> {
  const result = await memoryEmbeddingsFetch<{ embeddings: MemoryEmbeddingsConfig }>(
    '/api/memory/embeddings/config',
    {
      method: 'PUT',
      body: JSON.stringify(partial),
    },
  );
  if (result.kind === 'err') return result;
  if (!result.value.embeddings) {
    return { kind: 'err', error: 'Server did not return embeddings config.' };
  }
  return { kind: 'ok', value: result.value.embeddings };
}

/** Download / load the active embedding model (local transformers.js or provider probe). */
export async function warmupMemoryEmbeddings(): Promise<
  MemoryEmbeddingsOpResult<MemoryEmbeddingsWarmupResult>
> {
  return memoryEmbeddingsFetch<MemoryEmbeddingsWarmupResult>('/api/memory/embeddings/warmup', {
    method: 'POST',
    body: '{}',
  });
}

/** Reindex all memory entry vectors. */
export async function reindexMemoryEmbeddings(): Promise<
  MemoryEmbeddingsOpResult<MemoryEmbeddingsReindexResult>
> {
  return memoryEmbeddingsFetch<MemoryEmbeddingsReindexResult>('/api/memory/embeddings/reindex', {
    method: 'POST',
    body: '{}',
  });
}
