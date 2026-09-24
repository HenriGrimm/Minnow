/**
 * Fetch skills catalog from server; fall back to built-in manifest when offline.
 */

import { isLocalServerAvailable } from '../tools/config';
import builtinManifest from './builtin-manifest.json';
import { isSkillEnabled } from './config';
import { mergeSkillLists } from './loader';
import type { SkillDetail, SkillListItem } from './types';

/** Vite-only glob map; lazy so Node/tsx tests never call import.meta.glob. */
let builtinSkillModules: Record<string, () => Promise<string>> | null | undefined;

function getBuiltinSkillModules(): Record<string, () => Promise<string>> {
  if (builtinSkillModules !== undefined) {
    return builtinSkillModules ?? {};
  }
  const globFn = (import.meta as ImportMeta & { glob?: (p: string, o: object) => unknown }).glob;
  if (typeof globFn !== 'function') {
    builtinSkillModules = null;
    return {};
  }
  builtinSkillModules = globFn('./*/SKILL.md', {
    query: '?raw',
    import: 'default',
  }) as Record<string, () => Promise<string>>;
  return builtinSkillModules;
}

async function loadBuiltinSkillRaw(id: string): Promise<string | null> {
  const loader = getBuiltinSkillModules()[`./${id}/SKILL.md`];
  if (loader) return loader();

  if (process.env.MINNOW_TEST === '1') {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const skillPath = join(dirname(fileURLToPath(import.meta.url)), id, 'SKILL.md');
    try {
      return await readFile(skillPath, 'utf8');
    } catch {
      return null;
    }
  }

  return null;
}

interface SkillsListResponse {
  skills: SkillListItem[];
}

interface SkillDetailResponse {
  skill: SkillDetail;
}

let skillCatalog: SkillListItem[] = [];
const detailCache = new Map<string, SkillDetail>();

/** Built-in list from generated manifest (dev without server). */
function getBuiltinListFromManifest(): SkillListItem[] {
  const manifest = builtinManifest as { skills: SkillListItem[] };
  return manifest.skills.map((s) => ({ ...s, source: 'builtin' as const }));
}

/** Catalog rows that are enabled in settings (default: enabled). */
function filterEnabledSkills(skills: SkillListItem[]): SkillListItem[] {
  return skills.filter((skill) => isSkillEnabled(skill.id));
}

/** Current merged catalog (built-in + user when server available). */
export function getSkillCatalog(): readonly SkillListItem[] {
  return filterEnabledSkills(skillCatalog);
}

/** Full catalog including disabled skills (settings UI). */
export function getAllSkillCatalog(): readonly SkillListItem[] {
  return skillCatalog;
}

/** Refresh catalog from GET /api/skills or manifest-only fallback. */
export async function refreshSkillCatalog(): Promise<void> {
  detailCache.clear();

  const builtin = getBuiltinListFromManifest();

  if (!isLocalServerAvailable()) {
    skillCatalog = mergeSkillLists(builtin, []);
    return;
  }

  try {
    const res = await fetch('/api/skills');
    if (!res.ok) {
      skillCatalog = mergeSkillLists(builtin, []);
      return;
    }
    const data = (await res.json()) as SkillsListResponse;
    skillCatalog = Array.isArray(data.skills) ? data.skills : mergeSkillLists(builtin, []);
  } catch {
    skillCatalog = mergeSkillLists(builtin, []);
  }
}

/** Fetch full skill body by id (cached). */
export async function fetchSkillById(id: string): Promise<SkillDetail | null> {
  const cached = detailCache.get(id);
  if (cached && !id.startsWith('plugin-')) return cached;

  const inCatalog = skillCatalog.find((s) => s.id === id);
  if (!inCatalog || !isSkillEnabled(id)) return null;

  if (!isLocalServerAvailable()) {
    if (inCatalog.source !== 'builtin') {
      return null;
    }
    const raw = await loadBuiltinSkillRaw(id);
    if (!raw) return null;
    try {
      const { parseSkillFrontmatter, defaultSkillLabel } = await import('./parse-frontmatter');
      const { meta, body } = parseSkillFrontmatter(raw);
      const detail: SkillDetail = {
        id,
        label: meta.label?.trim() || defaultSkillLabel(id),
        description: meta.description.trim(),
        source: 'builtin',
        body,
        raw,
      };
      detailCache.set(id, detail);
      return detail;
    } catch {
      return null;
    }
  }

  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as SkillDetailResponse;
    if (!data.skill?.body) return null;
    detailCache.set(id, data.skill);
    return data.skill;
  } catch {
    return null;
  }
}

/** Resolve active skill for send (null if unknown). */
export async function resolveActiveSkill(skillId: string): Promise<SkillDetail | null> {
  return fetchSkillById(skillId);
}
