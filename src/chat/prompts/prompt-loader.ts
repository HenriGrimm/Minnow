import { parsePromptMarkdown, partIdFromKind } from './parse-front-matter';
import type { ParsedPrompt, PromptKind } from './types';

/** In-memory registry keyed by `${kind}:${id}`. */
const registry = new Map<string, ParsedPrompt>();

/** User overrides from ~/.minnow/prompts (merged when server registry is set). */
const userRegistry = new Map<string, ParsedPrompt>();
let captureReads: ParsedPrompt[] | null = null;

/** Synchronous composition can capture only its resolved sources for a durable profile. */
export function captureResolvedPromptSources<T>(compose: () => T): { value: T; prompts: ParsedPrompt[] } {
  const previous = captureReads;
  const prompts: ParsedPrompt[] = [];
  captureReads = prompts;
  try { return { value: compose(), prompts }; }
  finally { captureReads = previous; }
}

// ── Parse ────────────────────────────────────────────────────────────────────

function registryKey(kind: PromptKind, id: string): string {
  return `${kind}:${id}`;
}

function shouldSkipPath(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, '/');
  if (norm.includes('/_example/') || norm.startsWith('_example/')) return true;
  if (norm.includes('/_template/') || norm.startsWith('_template/')) return true;
  if (norm.includes('/__tests__/')) return true;
  return false;
}

function inferKindFromPath(relativePath: string): PromptKind | null {
  const norm = relativePath.replace(/\\/g, '/');
  const match = norm.match(
    /(?:^|\/)(base|modes|experts|tool-usage|info|work-agents|titles)\//,
  );
  if (!match) return null;
  const folder = match[1];
  if (folder === 'modes') return 'mode';
  if (folder === 'experts') return 'expert';
  if (folder === 'work-agents') return 'work-agent';
  if (folder === 'titles') return 'title';
  return folder as PromptKind;
}

function buildFromRawMap(
  rawMap: Record<string, string>,
  source: 'builtin' | 'user',
): Map<string, ParsedPrompt> {
  const prompts = new Map<string, ParsedPrompt>();

  for (const [globPath, raw] of Object.entries(rawMap)) {
    const relativePath = globPath
      .replace(/^\.\//, '')
      .replace(/^.*?prompts[\\/]/, '');
    if (shouldSkipPath(relativePath) || /(?:^|[./\\])lite\.md$/i.test(relativePath)) continue;

    let parsedRecord: ParsedPrompt;
    try {
      const { frontMatter, markdownBody } = parsePromptMarkdown(raw, relativePath);
      const kind = frontMatter.kind ?? inferKindFromPath(relativePath) ?? 'base';
      const bodyText = frontMatter.fullBody ?? frontMatter.body ?? markdownBody;
      parsedRecord = {
        id: frontMatter.id,
        kind,
        part: partIdFromKind(kind, frontMatter.part),
        label: frontMatter.label,
        version: frontMatter.version,
        description: frontMatter.description,
        body: bodyText,
        relativePath,
        source,
      };
    } catch {
      continue;
    }

    const key = registryKey(parsedRecord.kind, parsedRecord.id);
    if (!prompts.has(key) || relativePath.endsWith('.full.md')) prompts.set(key, parsedRecord);
  }
  return prompts;
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize built-in registry from Vite glob map (idempotent).
 * @param builtinRaw — from `builtin-globs.ts` (browser build only)
 */
export function initBuiltinPromptRegistry(
  builtinRaw: Record<string, string> = {},
): void {
  if (registry.size > 0) return;
  const built = buildFromRawMap(builtinRaw, 'builtin');
  for (const [key, value] of built) {
    registry.set(key, value);
  }
}

/** Replace user override registry (from GET /api/prompts/registry). */
export function setUserPromptRegistry(entries: ParsedPrompt[]): void {
  userRegistry.clear();
  for (const entry of entries) {
    if (!/(?:^|[./\\])lite\.md$/i.test(entry.relativePath)) {
      userRegistry.set(registryKey(entry.kind, entry.id), entry);
    }
  }
}

/** Clear user overrides (tests). */
export function clearUserPromptRegistry(): void {
  userRegistry.clear();
}

/** Reset all registries (tests). */
export function resetPromptRegistry(): void {
  registry.clear();
  userRegistry.clear();
}

/** Register prompts from a raw path→content map (tests / fixtures). */
export function registerPromptFilesFromRaw(
  rawMap: Record<string, string>,
  source: 'builtin' | 'user' = 'builtin',
): void {
  const built = buildFromRawMap(rawMap, source);
  const target = source === 'user' ? userRegistry : registry;
  for (const [key, value] of built) {
    target.set(key, value);
  }
}

/**
 * Resolve shipped built-in prompt body only (ignores user registry overrides).
 */
export function loadBuiltinPromptById(
  kind: PromptKind,
  id: string,
): ParsedPrompt | null {
  initBuiltinPromptRegistry();
  const key = registryKey(kind, id);
  const prompt = registry.get(key);
  if (!prompt) return null;
  captureReads?.push({ ...prompt });

  return { ...prompt };
}

// ── Load ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the prompt body for a kind and ID.
 */
export function loadPromptById(
  kind: PromptKind,
  id: string,
): ParsedPrompt | null {
  initBuiltinPromptRegistry();
  const key = registryKey(kind, id);
  const prompt = userRegistry.get(key) ?? registry.get(key);
  if (!prompt) return null;
  captureReads?.push({ ...prompt });

  return { ...prompt };
}

/** List all registered prompt ids for a kind (built-in + user). */
export function listPromptIdsForKind(kind: PromptKind): string[] {
  initBuiltinPromptRegistry();
  const ids = new Set<string>();
  for (const map of [registry, userRegistry]) {
    for (const key of map.keys()) {
      if (key.startsWith(`${kind}:`)) {
        ids.add(key.slice(kind.length + 1));
      }
    }
  }
  return [...ids];
}
