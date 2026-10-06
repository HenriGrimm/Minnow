/**
 * Skills Library HTTP client with offline shipped-index fallback (MIN-477).
 */

import { SKILLS_LIBRARY_PACKS } from './library/registry.mjs';
import type {
  SkillsLibraryIndexSkill,
  SkillsLibraryPackIndex,
  SkillsLibraryTrust,
} from './library/registry';
import { isLocalServerAvailable } from '../tools/config';

import addyOsmaniIndex from './library/index/addy-osmani.json';
import browserbaseIndex from './library/index/browserbase.json';
import last30daysIndex from './library/index/last30days.json';
import mattPocockIndex from './library/index/matt-pocock.json';
import superpowersIndex from './library/index/superpowers.json';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Shipped pack indexes keyed by pack id (offline browse). */
const SHIPPED_PACK_INDEXES: Record<string, SkillsLibraryPackIndex> = {
  'matt-pocock': mattPocockIndex as SkillsLibraryPackIndex,
  'addy-osmani': addyOsmaniIndex as SkillsLibraryPackIndex,
  superpowers: superpowersIndex as SkillsLibraryPackIndex,
  last30days: last30daysIndex as SkillsLibraryPackIndex,
  browserbase: browserbaseIndex as SkillsLibraryPackIndex,
};

/** Summary row returned by GET /api/skills/library/packs. */
export interface LibraryPackSummary {
  id: string;
  label: string;
  description: string;
  publisher: string;
  trust: SkillsLibraryTrust;
  runtimeNote?: string;
  postInstallPatch?: string;
  source: { repo: string; commit: string };
  installedCount: number;
  totalCount: number;
}

/** Search hit across shipped pack indexes. */
export interface LibrarySearchHit {
  packId: string;
  skill: SkillsLibraryIndexSkill;
}

/** Installed skill row from POST /api/skills/library/install. */
export interface LibraryInstalledSkill {
  skillId: string;
  path?: string;
  sha256?: string;
}

export interface LibraryInstallResult {
  installed: LibraryInstalledSkill[];
  skipped: Array<{ skillId: string; reason: string }>;
  failed: Array<{ skillId: string; error: string }>;
}

interface PacksResponse {
  packs?: LibraryPackSummary[];
  error?: string;
}

interface PackIndexResponse {
  index?: SkillsLibraryPackIndex;
  error?: string;
}

interface SearchResponse {
  query?: string;
  results?: LibrarySearchHit[];
  error?: string;
}

interface InstallResponse {
  ok?: boolean;
  installed?: LibraryInstalledSkill[];
  skipped?: LibraryInstallResult['skipped'];
  failed?: LibraryInstallResult['failed'];
  error?: string;
}

interface RemoveResponse {
  ok?: boolean;
  skillId?: string;
  removed?: Array<{ skillId: string; removed: boolean }> | boolean;
  failed?: LibraryInstallResult['failed'];
  error?: string;
}

/** Build offline pack summaries from shipped registry + indexes. */
export function getOfflineLibraryPacks(): LibraryPackSummary[] {
  return SKILLS_LIBRARY_PACKS.map((pack) => ({
    id: pack.id,
    label: pack.label,
    description: pack.description,
    publisher: pack.publisher,
    trust: pack.trust,
    runtimeNote: pack.runtimeNote,
    postInstallPatch: pack.postInstallPatch,
    source: { repo: pack.source.repo, commit: pack.source.commit },
    installedCount: 0,
    totalCount: SHIPPED_PACK_INDEXES[pack.id]?.skills.length ?? 0,
  }));
}

/** Load a shipped pack index without the server. */
export function getOfflinePackIndex(packId: string): SkillsLibraryPackIndex | null {
  return SHIPPED_PACK_INDEXES[packId] ?? null;
}

/** Search shipped indexes locally (offline browse). */
export function searchOfflineLibrarySkills(query: string): LibrarySearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: LibrarySearchHit[] = [];
  for (const [packId, index] of Object.entries(SHIPPED_PACK_INDEXES)) {
    for (const skill of index.skills) {
      const haystack = `${skill.skillId} ${skill.label} ${skill.description}`.toLowerCase();
      if (haystack.includes(q)) {
        results.push({ packId, skill });
      }
    }
  }
  return results;
}

/** Fetch curated packs; falls back to shipped registry when offline. */
export async function fetchLibraryPacks(): Promise<LibraryPackSummary[]> {
  if (!isLocalServerAvailable()) {
    return getOfflineLibraryPacks();
  }

  try {
    const res = await fetch('/api/skills/library/packs');
    const data = (await res.json().catch(() => ({}))) as PacksResponse;
    if (!res.ok) {
      throw new Error(data.error ?? `Failed to load packs (${res.status})`);
    }
    return data.packs ?? [];
  } catch {
    return getOfflineLibraryPacks();
  }
}

/** Fetch one pack index; falls back to shipped JSON when offline. */
export async function fetchPackIndex(packId: string): Promise<SkillsLibraryPackIndex> {
  const offline = getOfflinePackIndex(packId);
  if (!isLocalServerAvailable()) {
    if (!offline) throw new Error(`Unknown pack: ${packId}`);
    return offline;
  }

  try {
    const res = await fetch(`/api/skills/library/packs/${encodeURIComponent(packId)}/index`);
    const data = (await res.json().catch(() => ({}))) as PackIndexResponse;
    if (!res.ok) {
      throw new Error(data.error ?? `Failed to load pack index (${res.status})`);
    }
    if (!data.index) {
      throw new Error(`Pack index missing for ${packId}`);
    }
    return data.index;
  } catch (err) {
    if (offline) return offline;
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Search skills across packs; falls back to local indexes when offline. */
export async function searchLibrarySkills(query: string): Promise<LibrarySearchHit[]> {
  if (!isLocalServerAvailable()) {
    return searchOfflineLibrarySkills(query);
  }

  try {
    const res = await fetch(
      `/api/skills/library/search?q=${encodeURIComponent(query.trim())}`,
    );
    const data = (await res.json().catch(() => ({}))) as SearchResponse;
    if (!res.ok) {
      throw new Error(data.error ?? `Search failed (${res.status})`);
    }
    return data.results ?? [];
  } catch {
    return searchOfflineLibrarySkills(query);
  }
}

/** Install selected skills or all skills from a curated pack. */
export async function installPackSkills(
  packId: string,
  options: { skillIds?: string[]; all?: boolean },
): Promise<LibraryInstallResult> {
  if (!isLocalServerAvailable()) {
    throw new Error('Skills Library install needs network — open Minnow and check your connection.');
  }

  const res = await fetch('/api/skills/library/install', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ pack: packId, ...options }),
  });
  const data = (await res.json().catch(() => ({}))) as InstallResponse;
  if (!res.ok) {
    throw new Error(data.error ?? `Install failed (${res.status})`);
  }
  return { installed: data.installed ?? [], skipped: data.skipped ?? [], failed: data.failed ?? [] };
}

/** Install a skill from a public GitHub repository URL. */
export async function installSkillFromGitHubUrl(
  repoUrl: string,
  subpath?: string,
): Promise<LibraryInstalledSkill[]> {
  if (!isLocalServerAvailable()) {
    throw new Error('Add-from-URL needs network — open Minnow and check your connection.');
  }

  const body: { repoUrl: string; subpath?: string } = { repoUrl: repoUrl.trim() };
  if (subpath?.trim()) body.subpath = subpath.trim();

  const res = await fetch('/api/skills/library/install', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as InstallResponse;
  if (!res.ok) {
    throw new Error(data.error ?? `Install failed (${res.status})`);
  }
  return data.installed ?? [];
}

/** Remove an installed library skill from ~/.minnow/skills/. */
export async function removeInstalledLibrarySkill(skillId: string): Promise<void> {
  if (!isLocalServerAvailable()) {
    throw new Error('Remove needs Minnow running locally — open or restart the app and try again.');
  }

  const res = await fetch('/api/skills/library/remove', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ skillId }),
  });
  const data = (await res.json().catch(() => ({}))) as RemoveResponse;
  if (!res.ok) {
    throw new Error(data.error ?? `Remove failed (${res.status})`);
  }
}

/** Remove every skill installed from a curated pack. */
export async function removePackSkills(packId: string): Promise<{ removed: string[]; failed: LibraryInstallResult['failed'] }> {
  if (!isLocalServerAvailable()) {
    throw new Error('Remove needs Minnow running locally — open or restart the app and try again.');
  }

  const res = await fetch('/api/skills/library/remove', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ pack: packId, all: true }),
  });
  const data = (await res.json().catch(() => ({}))) as RemoveResponse;
  if (!res.ok) {
    throw new Error(data.error ?? `Remove failed (${res.status})`);
  }

  const rows = Array.isArray(data.removed) ? data.removed : [];
  return { removed: rows.map((row) => row.skillId), failed: data.failed ?? [] };
}
