/**
 * Memory API types (Step 16).
 */

export interface MemoryEntryMeta {
  id: string;
  title: string;
  tags: string[];
  source: 'user' | 'agent' | 'self-heal';
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
}

/** Full entry returned when listing with includeBody=1. */
export interface MemoryEntryWithBody extends MemoryEntryMeta {
  body: string;
}

export interface MemoryEmbeddingsConfig {
  enabled: boolean;
  backend: 'local' | 'provider';
  modelId: string;
  providerId: string;
  blendWeight: number;
  queryTimeoutMs: number;
  reindexNeeded: boolean;
}

export interface MemoryConfig {
  enabled: boolean;
  maxInjectCharsFull: number;
  retrieveLimit: number;
  defaultTags: string[];
  embeddings?: MemoryEmbeddingsConfig;
}

export interface MemoryEmbeddingsStatus {
  enabled: boolean;
  backend: string;
  model: string;
  providerId: string;
  blendWeight: number;
  queryTimeoutMs: number;
  dim: number;
  vectorCount: number;
  /** Total wiki pages in the brain store (reindex covers all, not only facts/). */
  pageCount?: number;
  reindexNeeded: boolean;
  healthy: boolean;
}

export interface MemoryEmbeddingsReindexResult {
  ok: boolean;
  indexed: number;
  failed: number;
  durationMs: number;
}

export interface MemoryEmbeddingsWarmupResult {
  ok: boolean;
  model: string;
  backend: string;
  dim: number;
  durationMs: number;
}

/** Result wrapper for embeddings mutations that surface server errors. */
export type MemoryEmbeddingsOpResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'err'; error: string };

export interface MemoryRetrieveResult {
  block: string;
  ids: string[];
}
