import { lookupKnownContextLength } from './known-context-windows.mjs';

/**
 * Context window from a models-list row.
 *
 * For a loaded GGUF, `loaded_context_length` is `/props` `n_ctx` (the `-c` we
 * actually allocated). `capabilities.contextLength` is often `n_ctx_train`
 * (128k–262k) and would keep the 90% compact trigger above the real window.
 */
/** @param {{ id?: string, state?: string, loaded_context_length?: number, max_context_length?: number, capabilities?: { contextLength?: number | null } }} row */
export function contextLengthFromModelRow(row) {
  if (row.state === 'loaded') {
    const loaded = row.loaded_context_length;
    if (typeof loaded === 'number' && Number.isFinite(loaded) && loaded > 0) {
      return loaded;
    }
  }
  const fromCaps = row.capabilities?.contextLength;
  if (typeof fromCaps === 'number' && Number.isFinite(fromCaps) && fromCaps > 0) {
    return fromCaps;
  }
  const max = row.max_context_length;
  if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
    return max;
  }
  if (typeof row.id === 'string' && row.id.trim()) {
    return lookupKnownContextLength(row.id);
  }
  return undefined;
}
