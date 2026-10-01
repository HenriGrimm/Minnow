/**
 * Keep vector sidecar in sync with entry CRUD (non-blocking on API paths).
 */

import { getEmbedder, embedTexts, DEFAULT_EMBEDDINGS_CONFIG } from './embeddings.js';

/**
 * Create vector sync API bound to a vector store and config patcher.
 * @param {ReturnType<import('./vector-store.js').createVectorStore>} vectorStore
 * @param {{ patchEmbeddingsConfig: (patch: Record<string, unknown>) => Promise<void> }} deps
 */
export function createVectorSync(vectorStore, deps) {
  const {
    upsertEntryVector,
    deleteEntryVector,
    isVectorStoreCompatible,
    loadVectorStore,
  } = vectorStore;

  /** Mark embeddings reindex flag in config.json. */
  async function markReindexNeeded() {
    await deps.patchEmbeddingsConfig({ reindexNeeded: true });
  }

  /** Clear reindex-needed flag after a successful full reindex. */
  async function clearReindexNeeded() {
    await deps.patchEmbeddingsConfig({ reindexNeeded: false });
  }

  /**
   * Build embed text for a memory entry (title + body).
   * @param {{ title?: string }} meta
   * @param {string} body
   */
  function entryEmbedText(meta, body) {
    return `${String(meta?.title ?? '')}\n${String(body ?? '')}`.trim();
  }

  /**
   * Embed and upsert one entry vector. Logs and marks reindex on failure.
   * @param {{ id: string, title?: string }} meta
   * @param {string} body
   * @param {object} memoryConfig
   * @param {{ getEmbedder?: typeof getEmbedder, embedTexts?: typeof embedTexts }} [syncDeps]
   */
  async function syncEntryVector(meta, body, memoryConfig, syncDeps = {}) {
    const getEmbedderFn = syncDeps.getEmbedder ?? getEmbedder;
    const embedTextsFn = syncDeps.embedTexts ?? embedTexts;
    const emb = {
      ...DEFAULT_EMBEDDINGS_CONFIG,
      ...(memoryConfig?.embeddings && typeof memoryConfig.embeddings === 'object'
        ? memoryConfig.embeddings
        : {}),
    };
    if (!emb.enabled) return;

    try {
      const embedder = await getEmbedderFn(memoryConfig);
      const store = await loadVectorStore();
      if (
        Object.keys(store.vectors).length > 0 &&
        !isVectorStoreCompatible(store, {
          modelId: embedder.id,
          backend: emb.backend,
          dim: embedder.dim,
        })
      ) {
        await markReindexNeeded();
        return;
      }

      const [vector] = await embedTextsFn(
        embedder,
        [entryEmbedText(meta, body)],
        emb.queryTimeoutMs,
      );
      await upsertEntryVector(meta.id, vector, {
        model: embedder.id,
        backend: emb.backend,
        dim: vector.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[memory] vector sync failed for ${meta.id}: ${message}`);
      await markReindexNeeded();
    }
  }

  /**
   * Fire-and-forget vector sync (does not block API responses).
   * @param {{ id: string, title?: string }} meta
   * @param {string} body
   * @param {object} memoryConfig
   */
  function scheduleEntryVectorSync(meta, body, memoryConfig) {
    void syncEntryVector(meta, body, memoryConfig);
  }

  /**
   * Remove vector for a deleted entry.
   * @param {string} entryId
   */
  const pendingDeletes = new Set();

  function syncDeleteEntryVector(entryId) {
    const operation = (async () => {
      try {
        await deleteEntryVector(entryId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[memory] vector delete failed for ${entryId}: ${message}`);
      }
    })();
    pendingDeletes.add(operation);
    void operation.finally(() => pendingDeletes.delete(operation));
    return operation;
  }

  /** Await actual sidecar deletions before assertions or storage teardown. */
  async function drainVectorDeletes() {
    while (pendingDeletes.size) await Promise.all([...pendingDeletes]);
  }

  return {
    markReindexNeeded,
    clearReindexNeeded,
    entryEmbedText,
    syncEntryVector,
    scheduleEntryVectorSync,
    syncDeleteEntryVector,
    drainVectorDeletes,
  };
}
