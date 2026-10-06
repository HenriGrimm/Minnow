/**
 * Issues taxonomy store — persisted in ~/.minnow/issues/taxonomy.json.
 * Vite-only fallback: localStorage minnow-issues-taxonomy-v1.
 */

import { getIssuesTaxonomy, putIssuesTaxonomy } from '../config/api-client.ts';
import { isServerStorageMode } from '../config/storage-mode.ts';
import {
  createDefaultIssuesTaxonomy,
  seedDefaultBoardVisibility,
  seedDefaultIssueTypes,
  validateIssuesTaxonomy,
  type IssuesTaxonomy,
} from '../issues/taxonomy.ts';
import { emitIssuesTaxonomyChange } from './issues-taxonomy-events.ts';
import { getIssuesSnapshot } from './issues-store.ts';

const TAXONOMY_STORAGE_KEY = 'minnow-issues-taxonomy-v1';

let taxonomyState: IssuesTaxonomy | null = null;
let taxonomyLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function touchTaxonomyStore(): void {
  emitIssuesTaxonomyChange();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveIssuesTaxonomyNow();
  }, 400);
}

/** In-memory taxonomy; defaults until load completes. */
export function getIssuesTaxonomySync(): IssuesTaxonomy {
  return taxonomyState ?? createDefaultIssuesTaxonomy();
}

export function isIssuesTaxonomyLoaded(): boolean {
  return taxonomyLoaded;
}

function parseTaxonomy(raw: unknown): IssuesTaxonomy {
  try {
    return seedDefaultBoardVisibility(seedDefaultIssueTypes(validateIssuesTaxonomy(raw)));
  } catch {
    return createDefaultIssuesTaxonomy();
  }
}

/** Persist when Feature/Improvement seed ran so the revision is not applied again. */
function persistIfSeeded(before: unknown, after: IssuesTaxonomy): void {
  const prevRev =
    before && typeof before === 'object' && 'typeSeedRevision' in before
      ? (before as { typeSeedRevision?: unknown }).typeSeedRevision
      : undefined;
  const prevBoardRev =
    before && typeof before === 'object' && 'boardSeedRevision' in before
      ? (before as { boardSeedRevision?: unknown }).boardSeedRevision
      : undefined;
  if (after.typeSeedRevision === prevRev && after.boardSeedRevision === prevBoardRev) return;
  void saveIssuesTaxonomyNow();
}

/** Load taxonomy from API or localStorage; seed defaults when missing. */
export async function loadIssuesTaxonomyFromStorage(): Promise<void> {
  if (isServerStorageMode()) {
    try {
      const raw = await getIssuesTaxonomy();
      taxonomyState = raw !== null ? parseTaxonomy(raw) : createDefaultIssuesTaxonomy();
      taxonomyLoaded = true;
      if (raw !== null) persistIfSeeded(raw, taxonomyState);
      return;
    } catch {
      taxonomyState = createDefaultIssuesTaxonomy();
      taxonomyLoaded = true;
      void import('../ui/status.ts').then((m) =>
        m.setStatus('err', 'Could not load issues taxonomy from ~/.minnow'),
      );
      return;
    }
  }

  try {
    const raw = localStorage.getItem(TAXONOMY_STORAGE_KEY);
    const parsedJson = raw ? JSON.parse(raw) : null;
    taxonomyState = parsedJson ? parseTaxonomy(parsedJson) : createDefaultIssuesTaxonomy();
    taxonomyLoaded = true;
    if (parsedJson) persistIfSeeded(parsedJson, taxonomyState);
  } catch {
    taxonomyState = createDefaultIssuesTaxonomy();
    taxonomyLoaded = true;
  }
}

/** Immediate persist of the in-memory taxonomy. */
export async function saveIssuesTaxonomyNow(): Promise<void> {
  if (!taxonomyState) return;
  if (isServerStorageMode()) {
    try {
      await putIssuesTaxonomy(taxonomyState);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save issues taxonomy';
      void import('../ui/status.ts').then((m) => m.setStatus('err', message));
    }
    return;
  }
  try {
    localStorage.setItem(TAXONOMY_STORAGE_KEY, JSON.stringify(taxonomyState));
  } catch {}
}

/** Replace taxonomy after validation (blocks in-use deletes). */
export function setIssuesTaxonomy(next: IssuesTaxonomy): void {
  const issues = getIssuesSnapshot()?.issues ?? [];
  taxonomyState = validateIssuesTaxonomy(next, {
    previous: getIssuesTaxonomySync(),
    issues,
  });
  taxonomyLoaded = true;
  touchTaxonomyStore();
}

/** Test harness: inject taxonomy without API. */
export function setIssuesTaxonomyForTests(state: IssuesTaxonomy | null): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  taxonomyState = state;
  taxonomyLoaded = state !== null;
}
