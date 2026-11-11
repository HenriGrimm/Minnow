import { parsePromptMarkdown } from '../prompts/parse-front-matter';
import { fetchPromptFileRaw } from '../prompts/prompt-file-api';
import { parseExpertMetaFromMarkdown } from './expert-meta-parse';
import type { ExpertRecord } from './types';

const SKIP_PREFIXES = ['_template', '_example'];

/** Built-in raw map from Vite glob (lazy). */
let builtinRaw: Record<string, string> | null = null;

const builtinRegistry = new Map<string, ExpertRecord>();
const userRegistry = new Map<string, ExpertRecord>();

// ── Parse ────────────────────────────────────────────────────────────────────

function shouldSkipExpertId(id: string): boolean {
  if (!id || id.startsWith('_')) return true;
  return SKIP_PREFIXES.some((p) => id === p || id.startsWith(`${p}/`));
}

function expertIdFromPath(relativePath: string): string | null {
  const norm = relativePath.replace(/\\/g, '/');
  const match = norm.match(/experts\/([^/]+)\/expert\.full\.md$/);
  return match?.[1] ?? null;
}

function buildRegistryFromRaw(
  rawMap: Record<string, string>,
  source: 'builtin' | 'user',
): Map<string, ExpertRecord> {
  const records = new Map<string, ExpertRecord>();

  for (const [globPath, raw] of Object.entries(rawMap)) {
    const relativePath = globPath
      .replace(/^\.\//, '')
      .replace(/^.*?prompts[\\/]/, '');
    if (!relativePath.includes('experts/')) continue;

    const expertId = expertIdFromPath(relativePath);
    if (!expertId || shouldSkipExpertId(expertId)) continue;
    const record = recordFromRawFile(expertId, raw, source);
    if (record) records.set(expertId, record);
  }
  return records;
}

function recordFromRawFile(
  expertId: string,
  fullRaw: string,
  source: 'builtin' | 'user',
): ExpertRecord | null {
  const relativePath = `experts/${expertId}/expert.full.md`;
  const meta = parseExpertMetaFromMarkdown(fullRaw, relativePath);
  if (!meta) return null;

  let fullBody = '';
  try {
    fullBody = parsePromptMarkdown(fullRaw, relativePath).markdownBody.trim();
  } catch {
    return null;
  }
  if (!fullBody) return null;

  return {
    meta,
    fullBody,
    source,
  };
}

async function loadUserExpertRecordFromApi(expertId: string): Promise<ExpertRecord | null> {
  const response = await fetchPromptFileRaw('experts', expertId);
  return response?.content?.trim() ? recordFromRawFile(expertId, response.content, 'user') : null;
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Initialize built-in experts from Vite glob (idempotent). */
export function initBuiltinExpertRegistry(raw: Record<string, string> = {}): void {
  if (builtinRegistry.size > 0 && Object.keys(raw).length === 0) return;
  builtinRaw = raw;
  builtinRegistry.clear();
  const built = buildRegistryFromRaw(raw, 'builtin');
  for (const [id, record] of built) {
    builtinRegistry.set(id, record);
  }
}

/** Replace user expert overrides (from server registry scan). */
export function setUserExpertRegistry(records: ExpertRecord[]): void {
  userRegistry.clear();
  for (const record of records) {
    userRegistry.set(record.meta.id, record);
  }
}

/** Ids shipped in the built-in bundle (for ownership checks). */
export function getBuiltinExpertIds(): ReadonlySet<string> {
  return new Set(builtinRegistry.keys());
}

/** Register expert files for tests. */
export function registerExpertFilesFromRaw(
  rawMap: Record<string, string>,
  source: 'builtin' | 'user' = 'builtin',
): void {
  const built = buildRegistryFromRaw(rawMap, source);
  const target = source === 'user' ? userRegistry : builtinRegistry;
  for (const [id, record] of built) {
    target.set(id, record);
  }
}

export function resetExpertRegistry(): void {
  builtinRegistry.clear();
  userRegistry.clear();
  builtinRaw = null;
}

function mergedRegistry(): ExpertRecord[] {
  const ids = new Set<string>([...builtinRegistry.keys(), ...userRegistry.keys()]);
  const list: ExpertRecord[] = [];
  for (const id of ids) {
    const record = userRegistry.get(id) ?? builtinRegistry.get(id);
    if (record) list.push(record);
  }
  return list.sort((a, b) => a.meta.label.localeCompare(b.meta.label));
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/** List all experts for dropdown (sorted by label). */
export function listExperts(): ExpertRecord[] {
  if (builtinRegistry.size === 0 && builtinRaw) {
    initBuiltinExpertRegistry(builtinRaw);
  }
  return mergedRegistry();
}

/** Get one expert by id. */
export function getExpert(id: string): ExpertRecord | null {
  return userRegistry.get(id) ?? builtinRegistry.get(id) ?? null;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Load user-created experts from ~/.minnow via the prompt API. */
export async function syncExpertRegistryFromServer(): Promise<void> {
  if (builtinRegistry.size === 0 && builtinRaw) {
    initBuiltinExpertRegistry(builtinRaw);
  }

  try {
    const res = await fetch('/api/prompts/registry', { cache: 'no-store' });
    if (!res.ok) {
      userRegistry.clear();
      return;
    }
    const body = (await res.json()) as {
      prompts?: { kind: string; id: string; source: string }[];
    };
    const userOnlyIds = [
      ...new Set(
        (body.prompts ?? [])
          .filter((p) => p.kind === 'expert' && p.source === 'user')
          .map((p) => p.id)
          .filter((id) => !shouldSkipExpertId(id) && !builtinRegistry.has(id)),
      ),
    ];

    if (userOnlyIds.length === 0) {
      userRegistry.clear();
      return;
    }

    const records: ExpertRecord[] = [];
    for (const id of userOnlyIds) {
      const record = await loadUserExpertRecordFromApi(id);
      if (record) records.push(record);
    }
    setUserExpertRegistry(records);
  } catch {
    userRegistry.clear();
  }
}

/** Reload built-in + optional user experts from prompt registry API. */
export async function refreshExpertRegistry(
  builtinRawMap?: Record<string, string>,
): Promise<void> {
  if (builtinRawMap) {
    builtinRegistry.clear();
    initBuiltinExpertRegistry(builtinRawMap);
  } else if (builtinRaw) {
    initBuiltinExpertRegistry(builtinRaw);
  }
  await syncExpertRegistryFromServer();
}

/** Load built-in experts using bundled prompt markdown (call from init). */
export function loadBuiltinExpertsFromPromptRaw(raw: Record<string, string>): void {
  initBuiltinExpertRegistry(raw);
}
