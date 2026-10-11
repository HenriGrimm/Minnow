/**
 * Seed a V2 board's journaled model from the pair the header chip already shows.
 * Start reads `state.model`; the chip falls back to `#modelSelect`, so they can
 * disagree until this writes `board.model.set`.
 */

import type { BoardState } from '../../server/orchestrator/core/types';
import { getModelRowForSelectOrCanonicalId, modelCache } from '../api/models';
import {
  decodeModelSelectKey,
  findFirstSelectKeyForCanonicalModelId,
} from '../lib/model-select-key';

const LIBRARY_PROVIDER_ID = 'minnow-library';

export type BoardModelPair = { providerId: string; id: string };

/** Menubar `#modelSelect` value: composite key, or a bare canonical id. */
function readMenubarSelectPair(): { providerId: string; modelId: string } {
  if (typeof document === 'undefined') return { providerId: '', modelId: '' };
  const raw =
    (document.getElementById('modelSelect') as HTMLSelectElement | null)?.value?.trim() ?? '';
  const decoded = decodeModelSelectKey(raw);
  if (decoded) return decoded;
  return { providerId: '', modelId: raw };
}

/**
 * Resolve the provider/model pair currently shown on the board chip (journal
 * override, then `#modelSelect`, then the in-memory catalog).
 * Returns null when there is no complete pair yet (catalog still loading).
 */
export function resolveDisplayedBoardModel(state: BoardState | null): BoardModelPair | null {
  const bound = state?.model;
  const boundProvider = bound?.providerId?.trim() ?? '';
  const boundId = bound?.id?.trim() ?? '';
  if (boundProvider && boundId) {
    return { providerId: boundProvider, id: boundId };
  }

  const shown = readMenubarSelectPair();
  let providerId = shown.providerId.trim();
  let id = shown.modelId.trim();
  if (!id) return null;

  if (!providerId) {
    // Bare select values: look up the catalog key so we can POST both halves.
    getModelRowForSelectOrCanonicalId(id);
    const key = findFirstSelectKeyForCanonicalModelId(modelCache.keys(), id);
    const decoded = key ? decodeModelSelectKey(key) : decodeModelSelectKey(id);
    if (decoded) {
      providerId = decoded.providerId;
      id = decoded.modelId;
    } else if (id.startsWith('gguf:') || id.startsWith('mlx:') || id.startsWith('mtplx:')) {
      providerId = LIBRARY_PROVIDER_ID;
    }
  }

  if (!providerId || !id) return null;
  return { providerId, id };
}

/** Menubar/chip pair to send on `POST /api/boards` when the caller did not pin one. */
export function readDisplayedBoardModelSeed(): BoardModelPair | null {
  return resolveDisplayedBoardModel(null);
}

/**
 * Journal the displayed model when the board has no override yet.
 * No-ops when already bound or when the catalog has not produced a pair.
 */
export async function ensureBoardModelBound(options: {
  state: BoardState | null;
  setModel: (providerId: string, id: string) => Promise<void>;
}): Promise<boolean> {
  const boundProvider = options.state?.model?.providerId?.trim() ?? '';
  const boundId = options.state?.model?.id?.trim() ?? '';
  if (boundProvider && boundId) return true;

  const pair = resolveDisplayedBoardModel(options.state);
  if (!pair) return false;

  await options.setModel(pair.providerId, pair.id);
  return true;
}
