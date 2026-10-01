/**
 * Memory back-compat adapter: brain vector sync (MIN-B3).
 * TRACKING: remove with memory adapter layer.
 */

export {
  markReindexNeeded,
  clearReindexNeeded,
  entryEmbedText,
  syncEntryVector,
  scheduleEntryVectorSync,
  syncDeleteEntryVector,
  drainVectorDeletes,
} from '../brain/vector-sync.js';
