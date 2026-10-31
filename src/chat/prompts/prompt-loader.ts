import { parsePromptMarkdown, partIdFromKind } from './parse-front-matter';
import type { ParsedPrompt, PromptKind, PromptProfile } from './types';

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

function profileSuffix(relativePath: string): 'full' | 'lite' | null {
  if (relativePath.endsWith('.full.md')) return 'full';
  if (relativePath.endsWith('.lite.md')) return 'lite';
  return null;
}

interface Accumulator {
  full?: ParsedPrompt;
  lite?: ParsedPrompt;
  default?: ParsedPrompt;
}

/** Merge full/lite variants into one ParsedPrompt per id. */
function registerVariant(
  accMap: Map<string, Accumulator>,
  parsed: ParsedPrompt,
  suffix: 'full' | 'lite' | null,
  body: string,
): void {
  const key = registryKey(parsed.kind, parsed.id);
  let acc = accMap.get(key);
  if (!acc) {
    acc = {};
    accMap.set(key, acc);
  }

  const entry: ParsedPrompt = { ...parsed, body };
  if (suffix === 'full') {
    acc.full = entry;
  } else if (suffix === 'lite') {
    acc.lite = entry;
  } else {
    acc.default = entry;
  }
}

function buildFromRawMap(
  rawMap: Record<string, string>,
  source: 'builtin' | 'user',
): Map<string, ParsedPrompt> {
  const accMap = new Map<string, Accumulator>();

  for (const [globPath, raw] of Object.entries(rawMap)) {
    const relativePath = globPath
      .replace(/^\.\//, '')
      .replace(/^.*?prompts[\\/]/, '');
    if (shouldSkipPath(relativePath)) continue;

    let parsedRecord: ParsedPrompt;
    const suffix = profileSuffix(relativePath);
    try {
      const { frontMatter, markdownBody } = parsePromptMarkdown(raw, relativePath);
      const kind = frontMatter.kind ?? inferKindFromPath(relativePath) ?? 'base';
      const bodyText =
        suffix === 'lite'
          ? (frontMatter.liteBody ?? frontMatter.body ?? markdownBody)
          : (frontMatter.fullBody ?? frontMatter.body ?? markdownBody);
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

    registerVariant(accMap, parsedRecord, suffix, parsedRecord.body);
  }

  const out = new Map<string, ParsedPrompt>();
  for (const [key, acc] of accMap) {
    const merged = acc.default ?? acc.full ?? acc.lite;
    if (!merged) continue;
    out.set(key, {
      ...merged,
      body: merged.body,
      // @ts-expect-error attach profile bodies for composer
      _fullBody: acc.full?.body ?? acc.default?.body ?? merged.body,
      _liteBody: acc.lite?.body,
    });
  }
  return out;
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
    userRegistry.set(registryKey(entry.kind, entry.id), entry);
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

export interface LoadedPromptBody {
  body: string;
  fullBody?: string;
  liteBody?: string;
}

function getStoredBodies(prompt: ParsedPrompt): LoadedPromptBody {
  const ext = prompt as ParsedPrompt & { _fullBody?: string; _liteBody?: string };
  return {
    body: prompt.body,
    fullBody: ext._fullBody ?? prompt.body,
    liteBody: ext._liteBody,
  };
}

/**
 * Resolve shipped built-in prompt body only (ignores user registry overrides).
 */
export function loadBuiltinPromptById(
  kind: PromptKind,
  id: string,
  profile: PromptProfile,
): LoadedPromptBody | null {
  initBuiltinPromptRegistry();
  const key = registryKey(kind, id);
  const prompt = registry.get(key);
  if (!prompt) return null;
  captureReads?.push({ ...prompt });

  const bodies = getStoredBodies(prompt);
  if (profile === 'lite' && bodies.liteBody?.trim()) {
    return { body: bodies.liteBody.trim(), fullBody: bodies.fullBody, liteBody: bodies.liteBody };
  }
  if (profile === 'lite') {
    return { body: bodies.fullBody ?? bodies.body, fullBody: bodies.fullBody, liteBody: bodies.liteBody };
  }
  return { body: bodies.fullBody ?? bodies.body, fullBody: bodies.fullBody, liteBody: bodies.liteBody };
}

// ── Load ─────────────────────────────────────────────────────────────────────

/**
 * Resolve prompt body for kind + id and profile.
 */
export function loadPromptById(
  kind: PromptKind,
  id: string,
  profile: PromptProfile,
): LoadedPromptBody | null {
  initBuiltinPromptRegistry();
  const key = registryKey(kind, id);
  const prompt = userRegistry.get(key) ?? registry.get(key);
  if (!prompt) return null;
  captureReads?.push({ ...prompt });

  const bodies = getStoredBodies(prompt);
  if (profile === 'lite' && bodies.liteBody?.trim()) {
    return { body: bodies.liteBody.trim(), fullBody: bodies.fullBody, liteBody: bodies.liteBody };
  }
  if (profile === 'lite') {
    return { body: bodies.fullBody ?? bodies.body, fullBody: bodies.fullBody, liteBody: bodies.liteBody };
  }
  return { body: bodies.fullBody ?? bodies.body, fullBody: bodies.fullBody, liteBody: bodies.liteBody };
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
