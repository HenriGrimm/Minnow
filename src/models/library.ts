/**
 * Local model library — flattens the cached-model scan into one servable row
 * per weight file, enriched with catalog metadata.
 *
 * The scan returns repo-shaped rows (an HF repo can hold six quants of the same
 * model); the library surface lists what you can actually load, so each GGUF
 * model file becomes its own row.
 */

import {
  isKnownModelMakerSlug,
  modelProducerLogoSvg,
  producerDisplayName,
  producerSlugFromModelId,
  resolveModelProducer,
} from '../providers/model-producer';
import { getModels } from './catalog';
import {
  DEFAULT_LIBRARY_LIST_SORT,
  sortLibraryForList,
  type LibraryListSort,
  type LibrarySortPreset,
} from './library-sort';
import { inferUseCase, paramsB as catalogParamsB } from './quant';
import type { CachedModelRow, ServeRecord } from './api-client';
import type { CatalogModel } from './types';

export type { LibraryListSort, LibraryTableSortKey, LibrarySortPreset } from './library-sort';
export {
  ariaSortValue as libraryAriaSortValue,
  cycleLibraryListSort,
  DEFAULT_LIBRARY_LIST_SORT,
  presetForSort,
  sortFromPreset,
} from './library-sort';

// ── Types ────────────────────────────────────────────────────────────────────

export type LibraryFormat = 'GGUF' | 'MLX' | 'SafeTensors' | 'Diffusion' | 'Ollama' | 'Unknown';
export type LibrarySource = 'downloaded' | 'hf-cache' | 'local-dir' | 'ollama';

export interface LibraryModel {
  /** Stable identity for selection and DOM keys. */
  id: string;
  /** File stem (GGUF) or repo tail — what the user recognises. */
  name: string;
  repoId: string;
  publisher: string;
  /** Normalized maker slug (qwen, google, meta, …). */
  producerSlug: string;
  /** Friendly maker label for the table and filters. */
  producerName: string;
  /** Model id passed to logo detection (catalog name, repo, or file stem). */
  producerLogoId: string;
  format: LibraryFormat;
  quant: string;
  arch: string;
  domain: string;
  paramsB: number | null;
  contextLength: number | null;
  capabilities: string[];
  sizeBytes: number;
  /** Absolute path to the weights, when one file can be handed to a runtime. */
  path: string | null;
  fileName: string | null;
  source: LibrarySource;
  /** A local runtime can load this row directly. */
  servable: boolean;
  incomplete: boolean;
  isMoe: boolean;
  /** A sibling `mmproj*.gguf` exists, so the load settings can switch vision off. */
  hasProjector?: boolean;
}

const CAPABILITY_LABELS: Record<string, string> = {
  vision: 'Vision',
  tool_use: 'Tools',
  tools: 'Tools',
  reasoning: 'Reasoning',
  embedding: 'Embeddings',
  audio: 'Audio',
  code: 'Code',
};

/** Human label for a raw capability key. */
export function capabilityLabel(key: string): string {
  return CAPABILITY_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** Publisher segment of a repo id, or a source-derived fallback. */
function publisherOf(repoId: string, source: LibrarySource): string {
  if (repoId.includes('/')) return repoId.split('/')[0];
  if (source === 'ollama') return 'ollama';
  return 'local';
}

/** Who built the weights (Qwen, Google, …), not the HF repo that packaged the GGUF. */
function libraryProducer(
  entry: CatalogModel | null,
  repoId: string,
  displayName: string,
): { slug: string; name: string; logoId: string } {
  if (entry?.provider) {
    const slug = producerSlugFromModelId(entry.provider);
    if (isKnownModelMakerSlug(slug)) {
      const logoId = entry.name || repoId || displayName;
      return { slug, name: producerDisplayName(slug), logoId };
    }
  }

  const candidates = [entry?.name, displayName, repoId].filter(Boolean) as string[];
  for (const id of candidates) {
    const resolved = resolveModelProducer(id);
    if (isKnownModelMakerSlug(resolved.slug)) {
      return { slug: resolved.slug, name: resolved.displayName, logoId: id };
    }
  }

  for (const id of candidates) {
    if (!modelProducerLogoSvg(id)) continue;
    const slug = producerSlugFromModelId(id);
    if (isKnownModelMakerSlug(slug)) {
      return { slug, name: producerDisplayName(slug), logoId: id };
    }
  }

  const fallbackId = candidates[0] ?? displayName;
  const fallback = resolveModelProducer(fallbackId);
  return { slug: fallback.slug, name: fallback.displayName, logoId: fallbackId };
}

/**
 * Join path segments with the separator the scan already used, so Windows paths
 * stay `C:\...\file.gguf` rather than a mixed-separator hybrid.
 */
function joinPath(base: string, ...segments: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const tail = segments
    .join('/')
    .split('/')
    .filter(Boolean)
    .join(sep);
  return `${base.replace(/[/\\]+$/, '')}${sep}${tail}`;
}

/** Reconstruct an absolute path for a GGUF inside the HF hub cache layout. */
function hfCacheFilePath(cacheDir: string, repoId: string, relPath: string): string {
  const repoDir = `models--${repoId.replace(/\//g, '--')}`;
  return joinPath(cacheDir, repoDir, 'snapshots', relPath);
}

/** Strip quant suffix and extension to a display name. */
function displayNameFromFile(fileName: string): string {
  return fileName.replace(/\.gguf$/i, '').replace(/-\d+-of-\d+$/i, '');
}

// ── Infer ────────────────────────────────────────────────────────────────────

/** Billions of parameters parsed out of a model or file name. */
export function inferParamsFromName(name: string): number | null {
  const match = name.match(/(?:^|[-_./])(\d+(?:\.\d+)?)\s*b(?:[-_./]|$)/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 && value < 5000 ? value : null;
}

/** Architecture guess from a model name, used when the catalog has no entry. */
export function inferArchFromName(name: string): string {
  const n = name.toLowerCase();
  const known = [
    ['qwen', 'qwen'],
    ['llama', 'llama'],
    ['mistral', 'mistral'],
    ['mixtral', 'mixtral'],
    ['gemma', 'gemma'],
    ['phi', 'phi'],
    ['deepseek', 'deepseek'],
    ['gpt-oss', 'gpt_oss'],
    ['granite', 'granite'],
    ['command-r', 'command_r'],
    ['glm', 'glm'],
    ['nemotron', 'nemotron'],
    ['smollm', 'smollm'],
    ['olmo', 'olmo'],
  ] as const;
  for (const [needle, arch] of known) {
    if (n.includes(needle)) return arch;
  }
  return '';
}

let catalogIndex: Map<string, CatalogModel> | null = null;
let catalogIndexLoad: Promise<Map<string, CatalogModel>> | null = null;

/** Lower-cased lookup over catalog names, repo tails, and GGUF source repos. */
async function ensureCatalogIndex(): Promise<Map<string, CatalogModel>> {
  if (catalogIndex) return catalogIndex;
  if (!catalogIndexLoad) {
    catalogIndexLoad = (async () => {
      const index = new Map<string, CatalogModel>();
      const put = (key: string | undefined, model: CatalogModel) => {
        if (!key) return;
        const k = key.toLowerCase();
        if (!index.has(k)) index.set(k, model);
      };
      for (const model of await getModels()) {
        put(model.name, model);
        put(model.name.split('/').pop(), model);
        for (const src of model.gguf_sources ?? []) {
          put(src.repo, model);
          put(src.repo.split('/').pop(), model);
        }
      }
      catalogIndex = index;
      return index;
    })();
  }
  return catalogIndexLoad;
}

function getCatalogIndex(): Map<string, CatalogModel> {
  return catalogIndex ?? new Map();
}

/** Test helper — drop the memoised catalog index. */
export function clearCatalogIndexForTests(): void {
  catalogIndex = null;
  catalogIndexLoad = null;
}

/** Best catalog match for a repo id / file name pair. */
export function matchCatalogEntry(repoId: string, fileName?: string | null): CatalogModel | null {
  const index = getCatalogIndex();
  const candidates = [repoId, repoId.split('/').pop() ?? '', fileName ?? ''].filter(Boolean);
  for (const candidate of candidates) {
    const hit = index.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  if (fileName) {
    const stem = displayNameFromFile(fileName).replace(
      /[-_.](?:UD-)?(?:IQ\d+_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)+|BF16|F16|FP16|F32)$/i,
      '',
    );
    const hit = index.get(stem.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * Format classification for a repo that holds no GGUF.
 *
 * MLX comes from the scanner's `mlx_root` signal, not the repo name: the name
 * says nothing about whether the weights on disk are actually MLX-quantized.
 */
function nonGgufFormat(row: CachedModelRow): LibraryFormat {
  if (row.is_diffusion) return 'Diffusion';
  if (row.mlx_root) return 'MLX';
  return 'SafeTensors';
}

function sourceOf(row: CachedModelRow): LibrarySource {
  if (row.is_ollama) return 'ollama';
  if (row.is_local_dir) return 'local-dir';
  if (row.status === 'downloaded') return 'downloaded';
  return 'hf-cache';
}

/**
 * A sibling `mmproj*.gguf` is exactly what `llama-server` is handed via `--mmproj`
 * when Minnow serves the row, so the weights are a VLM even when the catalog entry
 * (or a repo with no catalog match at all) never says so.
 */
function capabilitiesWithProjectorVision(
  capabilities: string[],
  hasProjector: boolean,
): string[] {
  if (!hasProjector || capabilities.includes('vision')) return capabilities;
  return [...capabilities, 'vision'];
}

/** Absolute path for a GGUF entry, or null when it cannot be resolved. */
function ggufPath(row: CachedModelRow, relPath: string, source: LibrarySource): string | null {
  if (!relPath) return null;
  if (source === 'hf-cache') return hfCacheFilePath(row.path, row.repo_id, relPath);
  return joinPath(row.path, relPath);
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Flatten cached repo rows into one library row per loadable weight file.
 */
export async function buildLibrary(cached: CachedModelRow[]): Promise<LibraryModel[]> {
  await ensureCatalogIndex();
  const out: LibraryModel[] = [];

  for (const row of cached) {
    const source = sourceOf(row);
    const publisher = publisherOf(row.repo_id, source);
    const modelFiles = (row.gguf_files ?? []).filter((f) => f.role === 'model');
    const hasProjector = (row.gguf_files ?? []).some((f) => f.role === 'projector');

    if (!modelFiles.length) {
      const entry = matchCatalogEntry(row.repo_id);
      const displayName = row.repo_id.split('/').pop() || row.repo_id;
      const producer = libraryProducer(entry, row.repo_id, displayName);
      const isMlx = Boolean(row.mlx_root) && !row.is_ollama;
      out.push({
        id: isMlx ? `mlx:${row.repo_id}` : `repo:${row.repo_id}`,
        name: displayName,
        repoId: row.repo_id,
        publisher,
        producerSlug: producer.slug,
        producerName: producer.name,
        producerLogoId: producer.logoId,
        format: row.is_ollama ? 'Ollama' : nonGgufFormat(row),
        quant: isMlx ? (row.mlx_quant ?? '') : '',
        arch: entry?.architecture ?? inferArchFromName(row.repo_id),
        domain: entry ? inferUseCase(entry) : inferUseCase({ name: row.repo_id } as CatalogModel),
        paramsB: entry ? catalogParamsB(entry) || null : inferParamsFromName(row.repo_id),
        contextLength: row.mlx_context_length ?? entry?.context_length ?? null,
        capabilities: entry?.capabilities ?? [],
        sizeBytes: row.size_bytes,
        path: isMlx ? (row.mlx_root ?? null) : null,
        fileName: null,
        source,
        servable: isMlx,
        incomplete: row.has_incomplete,
        isMoe: entry?.is_moe ?? false,
      });
      continue;
    }

    for (const file of modelFiles) {
      const entry = matchCatalogEntry(row.repo_id, file.name);
      const path = ggufPath(row, file.rel_path, source);
      const name = displayNameFromFile(file.name);
      const producer = libraryProducer(entry, row.repo_id, name);
      out.push({
        id: `gguf:${row.repo_id}:${file.rel_path}`,
        name,
        repoId: row.repo_id,
        publisher,
        producerSlug: producer.slug,
        producerName: producer.name,
        producerLogoId: producer.logoId,
        format: 'GGUF',
        quant: file.quant || entry?.quantization || '',
        arch: entry?.architecture ?? inferArchFromName(name || row.repo_id),
        domain: entry ? inferUseCase(entry) : inferUseCase({ name } as CatalogModel),
        paramsB: (entry ? catalogParamsB(entry) || null : null) ?? inferParamsFromName(name),
        contextLength: row.mlx_context_length ?? entry?.context_length ?? null,
        capabilities: capabilitiesWithProjectorVision(
          entry?.capabilities ?? [],
          hasProjector,
        ),
        sizeBytes: file.size_bytes,
        path,
        fileName: file.name,
        source,
        servable: Boolean(path),
        incomplete: row.has_incomplete,
        isMoe: entry?.is_moe ?? false,
        hasProjector,
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name) || a.quant.localeCompare(b.quant));
  return out;
}

/** Serve record currently holding this library row, if any. */
export function activeServeFor(
  model: LibraryModel,
  serves: ServeRecord[],
): ServeRecord | undefined {
  return serves.find(
    (s) =>
      (s.status === 'running' || s.status === 'starting') &&
      (model.path
        ? s.modelPath === model.path
        : s.modelLabel === model.repoId || s.modelLabel === model.name),
  );
}

/** Toolbar preset ids for My Models sort (maps to {@link LibraryListSort}). */
export type LibrarySortKey = LibrarySortPreset;

// ── Filter ───────────────────────────────────────────────────────────────────

/**
 * Rows the My Models table lists: GGUF with a resolved path, plus MLX repos on
 * hardware that can actually run them.
 *
 * The MLX gate reads `hardware.backend`, not the mlx-lm runtime probe. Hardware
 * is already in store state when the table first paints, while the runtime probe
 * resolves a beat later — gating on it would make rows appear and the list
 * visibly reorder. Whether the runtime is *installed* is the Load button's
 * problem, and it drives the install prompt from there.
 *
 * `backend` omitted means "not measured yet", and MLX rows stay hidden until it
 * is, so a Windows machine with an mlx-community repo in its HF cache never
 * shows a row it cannot serve.
 */
export function loadableLibrary(
  models: LibraryModel[],
  options?: { backend?: string | null },
): LibraryModel[] {
  const metal = options?.backend === 'metal';
  return models.filter((m) => {
    if (!m.servable || m.source === 'ollama') return false;
    if (m.format === 'MLX' && !metal) return false;
    return true;
  });
}

export interface LibraryFilter {
  search?: string;
  format?: string;
  publisher?: string;
  producer?: string;
  listSort?: LibraryListSort;
}

/** Apply the My Models toolbar filters. */
export function filterLibrary(models: LibraryModel[], filter: LibraryFilter): LibraryModel[] {
  const needle = filter.search?.trim().toLowerCase() ?? '';
  const rows = models.filter((m) => {
    if (filter.format && m.format !== filter.format) return false;
    if (filter.publisher && m.publisher !== filter.publisher) return false;
    if (filter.producer && m.producerSlug !== filter.producer) return false;
    if (!needle) return true;
    return (
      m.name.toLowerCase().includes(needle) ||
      m.repoId.toLowerCase().includes(needle) ||
      m.quant.toLowerCase().includes(needle) ||
      m.arch.toLowerCase().includes(needle)
    );
  });

  return sortLibraryForList(rows, filter.listSort ?? DEFAULT_LIBRARY_LIST_SORT);
}
