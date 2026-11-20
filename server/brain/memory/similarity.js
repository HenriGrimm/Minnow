/**
 * Embedding similarity between a text and stored memory vectors (shared by
 * search and duplicate detection).
 */

import { getEmbedder, embedTexts, DEFAULT_EMBEDDINGS_CONFIG } from '../../engine/embeddings.js';
import { runWithDeadline } from '../../../src/lib/async-deadline.mjs';
import {
  cosineSimilarity,
  getEntryVector,
  isVectorStoreCompatible,
  loadVectorStore,
} from '../vector-store.js';

/**
 * Cosine similarity of `text` to each entry's stored vector, or null when
 * embeddings are disabled, incompatible, slow or failing.
 * @param {string} text
 * @param {Array<{ meta: { id: string } }>} entries
 * @param {object} config — brain config (embeddings section)
 * @param {object} [deps]
 * @returns {Promise<Map<string, number> | null>}
 */
export async function memorySimilarities(text, entries, config, deps = {}) {
  const emb = { ...DEFAULT_EMBEDDINGS_CONFIG, ...(config?.embeddings ?? {}) };
  if (!emb.enabled || entries.length === 0 || !String(text ?? '').trim()) return null;
  const load = deps.loadVectorStore ?? loadVectorStore;
  const compatible = deps.isVectorStoreCompatible ?? isVectorStoreCompatible;
  const vectorOf = deps.getEntryVector ?? getEntryVector;
  try {
    return await runWithDeadline(async signal => {
      const embedder = await (deps.getEmbedder ?? getEmbedder)(config);
      signal.throwIfAborted();
      if (deps.fresh) {
        const vectors = await (deps.embedTexts ?? embedTexts)(embedder,
          [String(text), ...entries.map(entry => `${entry.meta.title}\n${entry.body}`)], emb.queryTimeoutMs, { signal });
        signal.throwIfAborted();
        if (vectors.length !== entries.length + 1) return null;
        return new Map(entries.map((entry, index) => [entry.meta.id, cosineSimilarity(vectors[0], vectors[index + 1])]));
      }
      const [queryVector] = await (deps.embedTexts ?? embedTexts)(embedder, [String(text)], emb.queryTimeoutMs, { signal });
      signal.throwIfAborted();
      const store = await load();
      if (!queryVector || !compatible(store, { modelId: embedder.id, backend: emb.backend, dim: embedder.dim })) return null;
      const out = new Map();
      for (const entry of entries) {
        const stored = store.vectors?.[entry.meta.id] ?? (await vectorOf(entry.meta.id));
        out.set(entry.meta.id, stored ? cosineSimilarity(queryVector, stored) : 0);
      }
      return out;
    }, { timeoutMs: emb.queryTimeoutMs, signal: deps.signal });
  } catch {
    deps.signal?.throwIfAborted();
    return null;
  }
}
