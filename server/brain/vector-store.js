/**
 * Brain vector store binding (re-exported for memory back-compat).
 */

import { createVectorStore, cosineSimilarity } from '../engine/vector-store.js';
import { getEnginePaths } from './engine-paths.js';
import { isValidPageId } from './paths.js';

const vectorStore = createVectorStore(getEnginePaths, { isValidEntryId: isValidPageId });

export { cosineSimilarity };

export const {
  getVectorStorePath,
  loadVectorStore,
  saveVectorStore,
  isVectorStoreCompatible,
  upsertEntryVector,
  deleteEntryVector,
  keepEntryVectors,
  clearVectorStore,
  getVectorCount,
  reindexAllMemoryEntries,
  getEntryVector,
} = vectorStore;
