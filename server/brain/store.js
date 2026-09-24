/**
 * Brain wiki page CRUD, catalog cache, and log maintenance under ~/.minnow/brain/.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import { DEFAULT_EMBEDDINGS_CONFIG } from '../engine/embeddings.js';
import {
  getBrainDir,
  getBrainIndexPath,
  getBrainLogPath,
  getBrainPagesDir,
  getBrainSchemaPath,
  getBrainStatePath,
  getCatalogPath,
  assertSafeRelativePagePath,
  BrainPathError,
  isValidPageId,
  resolvePagePath,
} from './paths.js';
import { DEFAULT_BRAIN_CODE_CONFIG, normalizeBrainCodeConfig } from './code/config.js';
import { DEFAULT_LINKING_CONFIG, normalizeLinkingConfig } from './linking-config.js';
import {
  deleteAnchorsForPage,
  syncAnchorsForPage,
} from './code/anchors.js';
import {
  DEFAULT_BRAIN_CONFIG,
  scheduleEntryVectorSync,
  syncDeleteEntryVector,
} from './vector-sync.js';

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const DEFAULT_CATALOG = { version: 1, generatedAt: null, pages: [] };

const VALID_SOURCES = new Set(['user', 'agent', 'synthesis', 'ingest', 'archive']);
const VALID_STATUS = new Set(['current', 'stale', 'orphan']);

// Share write serialization across the UI, built-in agents and external MCP clients.
function serialQueue() {
  let pending = Promise.resolve();
  return work => {
    const next = pending.then(work, work);
    pending = next.catch(() => {});
    return next;
  };
}
const mutatePage = serialQueue();
const mutateCatalog = serialQueue();
const mutateLog = serialQueue();

/** Default brain section in config.json when missing. */
export const DEFAULT_BRAIN_STORE_CONFIG = {
  ...DEFAULT_BRAIN_CONFIG,
  linking: { ...DEFAULT_LINKING_CONFIG },
};

// ── Config ───────────────────────────────────────────────────────────────────

async function ensurePagesLayout() {
  await fs.mkdir(getBrainPagesDir(), { recursive: true });
}

/** Load merged brain config (embeddings inherit memory defaults when unset). */
export async function loadBrainConfig() {
  const config = (await readConfigJson('config.json')) ?? {};
  const raw =
    config.brain && typeof config.brain === 'object' ? config.brain : {};
  const memoryEmb =
    config.memory?.embeddings && typeof config.memory.embeddings === 'object'
      ? config.memory.embeddings
      : {};
  const memory =
    config.memory && typeof config.memory === 'object' ? config.memory : {};
  const embeddings =
    raw.embeddings && typeof raw.embeddings === 'object'
      ? { ...DEFAULT_EMBEDDINGS_CONFIG, ...memoryEmb, ...raw.embeddings }
      : { ...DEFAULT_EMBEDDINGS_CONFIG, ...memoryEmb };
  const codeRaw = raw.code && typeof raw.code === 'object' ? raw.code : {};
  return {
    ...DEFAULT_BRAIN_STORE_CONFIG,
    ...raw,
    enabled: raw.enabled ?? memory.enabled ?? true,
    maxInjectCharsFull:
      raw.maxInjectCharsFull ?? memory.maxInjectCharsFull ?? 8000,
    maxInjectCharsLite:
      raw.maxInjectCharsLite ?? memory.maxInjectCharsLite ?? 800,
    embeddings,
    code: { ...DEFAULT_BRAIN_CODE_CONFIG, ...codeRaw },
    linking: normalizeLinkingConfig(raw.linking),
  };
}

/** Persist brain settings (and mirrored memory limits when provided). */
export async function saveBrainConfig(partial) {
  const config = (await readConfigJson('config.json')) ?? {};
  const existing =
    config.brain && typeof config.brain === 'object'
      ? { ...DEFAULT_BRAIN_STORE_CONFIG, ...config.brain }
      : { ...DEFAULT_BRAIN_STORE_CONFIG };
  const memory =
    config.memory && typeof config.memory === 'object' ? config.memory : {};

  const partialEmb =
    partial?.embeddings && typeof partial.embeddings === 'object'
      ? partial.embeddings
      : null;
  const existingEmb =
    existing.embeddings && typeof existing.embeddings === 'object'
      ? { ...DEFAULT_EMBEDDINGS_CONFIG, ...existing.embeddings }
      : { ...DEFAULT_EMBEDDINGS_CONFIG };

  const nextEmb = partialEmb ? { ...existingEmb, ...partialEmb } : existingEmb;
  if (
    partialEmb &&
    ((partialEmb.backend !== undefined && partialEmb.backend !== existingEmb.backend) ||
      (partialEmb.modelId !== undefined && partialEmb.modelId !== existingEmb.modelId) ||
      (partialEmb.providerId !== undefined && partialEmb.providerId !== existingEmb.providerId) ||
      (partialEmb.enabled === true && !existingEmb.enabled))
  ) {
    nextEmb.reindexNeeded = true;
  }

  const partialCode =
    partial?.code && typeof partial.code === 'object' ? partial.code : null;
  const existingCode =
    existing.code && typeof existing.code === 'object'
      ? { ...DEFAULT_BRAIN_CODE_CONFIG, ...existing.code }
      : { ...DEFAULT_BRAIN_CODE_CONFIG };
  const nextCode = partialCode
    ? normalizeBrainCodeConfig({ ...existingCode, ...partialCode })
    : existingCode;

  const nextLinking = normalizeLinkingConfig(
    partial?.linking,
    existing.linking && typeof existing.linking === 'object' ? existing.linking : {},
  );

  config.brain = {
    ...existing,
    ...partial,
    embeddings: nextEmb,
    code: nextCode,
    linking: nextLinking,
  };

  if (partialEmb) {
    config.memory = {
      ...memory,
      embeddings: { ...(memory.embeddings ?? {}), ...nextEmb },
    };
  }

  await writeConfigJson('config.json', config);
  return config.brain;
}

// ── Pages ────────────────────────────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from a markdown page.
 * @param {string} raw
 * @param {string} [fallbackId]
 */
export function parsePageMarkdown(raw, fallbackId) {
  const trimmed = String(raw ?? '');
  if (!trimmed.startsWith('---')) {
    return { front: {}, body: trimmed };
  }
  const end = trimmed.indexOf('---', 3);
  if (end < 0) return { front: {}, body: trimmed };
  const frontBlock = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trim();
  const front = parseFrontmatterBlock(frontBlock);
  if (!front.id && fallbackId) front.id = fallbackId;
  return { front, body };
}

/** Parse simple frontmatter lines (scalars, booleans, inline arrays). */
function parseFrontmatterBlock(block) {
  const front = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([\w_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rawValue = m[2].trim();
    if (rawValue === 'true' || rawValue === 'false') {
      front[key] = rawValue === 'true';
      continue;
    }
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      const items = inner
        ? inner.split(',').map((v) => v.trim().replace(/^["']|["']$/g, ''))
        : [];
      if (key === 'sourceTurnIndices') {
        front[key] = items.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      } else {
        front[key] = items;
      }
      continue;
    }
    front[key] = rawValue.replace(/^["']|["']$/g, '');
  }
  return front;
}

function quoteYamlString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function serializeArrayField(values) {
  const items = Array.isArray(values) ? values : [];
  if (items.length === 0) return '[]';
  return `[${items.map((v) => quoteYamlString(v)).join(', ')}]`;
}

/** Serialize page frontmatter + body to markdown. */
export function serializePage(meta, body) {
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const anchors = Array.isArray(meta.anchors) ? meta.anchors : [];
  const source = VALID_SOURCES.has(meta.source) ? meta.source : 'user';
  const status = VALID_STATUS.has(meta.status) ? meta.status : 'current';
  const archiveLines = [];
  if (meta.chatId) {
    archiveLines.push(`chatId: ${quoteYamlString(meta.chatId)}`);
  }
  if (Array.isArray(meta.sourceTurnIndices) && meta.sourceTurnIndices.length > 0) {
    archiveLines.push(
      `sourceTurnIndices: [${meta.sourceTurnIndices.map((n) => String(n)).join(', ')}]`,
    );
  }
  if (Array.isArray(meta.similarTo) && meta.similarTo.length > 0) {
    archiveLines.push(`similarTo: ${serializeArrayField(meta.similarTo)}`);
  }
  const archiveBlock = archiveLines.length ? `${archiveLines.join('\n')}\n` : '';
  return `---
id: ${quoteYamlString(meta.id)}
title: ${quoteYamlString(meta.title ?? 'Untitled')}
tags: ${serializeArrayField(tags)}
source: ${source}
summary: ${quoteYamlString(meta.summary ?? '')}
pinned: ${Boolean(meta.pinned)}
createdAt: ${quoteYamlString(meta.createdAt)}
updatedAt: ${quoteYamlString(meta.updatedAt)}
anchors: ${serializeArrayField(anchors)}
status: ${status}
input_hash: ${quoteYamlString(meta.input_hash ?? '')}
${archiveBlock}---

${body}`;
}

/** Extract path-based wikilinks from markdown body. */
export function extractWikilinks(body) {
  const links = [];
  const seen = new Set();
  const text = String(body ?? '');
  for (const match of text.matchAll(WIKILINK_RE)) {
    const target = String(match[1] ?? '').trim().replace(/\\/g, '/');
    if (!target || seen.has(target)) continue;
    seen.add(target);
    links.push(target);
  }
  return links;
}

/** Derive slug and folder from a pages-relative path. */
export function pagePathParts(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const folder = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized, '.md');
  return {
    path: normalized,
    slug: base,
    folder: folder === '.' ? '' : folder,
  };
}

/** Build catalog entry from frontmatter + relative path + body links. */
export function buildCatalogEntry(front, relPath, body) {
  const parts = pagePathParts(relPath);
  const links = extractWikilinks(body);
  return {
    id: String(front.id ?? ''),
    title: String(front.title ?? 'Untitled'),
    tags: Array.isArray(front.tags)
      ? front.tags
      : typeof front.tags === 'string' && front.tags
        ? [front.tags]
        : [],
    source: VALID_SOURCES.has(front.source) ? front.source : 'user',
    summary: String(front.summary ?? ''),
    pinned: Boolean(front.pinned),
    createdAt: String(front.createdAt ?? ''),
    updatedAt: String(front.updatedAt ?? ''),
    anchors: Array.isArray(front.anchors) ? front.anchors : [],
    status: VALID_STATUS.has(front.status) ? front.status : 'current',
    input_hash: String(front.input_hash ?? ''),
    links,
    ...(front.chatId ? { chatId: String(front.chatId) } : {}),
    ...(Array.isArray(front.sourceTurnIndices)
      ? { sourceTurnIndices: front.sourceTurnIndices }
      : {}),
    ...(Array.isArray(front.similarTo) ? { similarTo: front.similarTo } : {}),
    ...parts,
  };
}

/** Compute inbound links keyed by target path (without .md). */
export function computeBacklinks(catalog) {
  const pages = catalog?.pages ?? [];
  /** @type {Record<string, string[]>} */
  const backlinks = {};
  for (const page of pages) {
    for (const link of page.links ?? []) {
      const key = link.replace(/\\/g, '/');
      if (!backlinks[key]) backlinks[key] = [];
      backlinks[key].push(page.path);
    }
  }
  return backlinks;
}

/** Normalize a link/page reference for comparison (strip .md, normalize slashes). */
function normalizePageRef(ref) {
  return String(ref ?? '').replace(/\\/g, '/').replace(/\.md$/i, '');
}

/**
 * Paths that participate in any `similarTo` edge, keyed without `.md`.
 *
 * Both endpoints count as connected: a page that lists similar pages is not
 * isolated, and neither is a page that others point to. Only edges resolving to
 * a real page count, so dangling references don't mask a true orphan. This
 * mirrors how the graph view (buildPageGraph) treats `similar` edges.
 */
export function computeSimilarLinks(catalog) {
  const pages = catalog?.pages ?? [];
  const valid = new Set(pages.map((p) => normalizePageRef(p.path)));
  const connected = new Set();
  for (const page of pages) {
    const refs = Array.isArray(page.similarTo) ? page.similarTo : [];
    const resolved = refs.map(normalizePageRef).filter((r) => valid.has(r));
    if (resolved.length === 0) continue;
    connected.add(normalizePageRef(page.path));
    for (const r of resolved) connected.add(r);
  }
  return connected;
}

/** Pages with no inbound links and no similarTo edges (excluding non-orphan roots). */
export function findOrphanPages(catalog) {
  const pages = catalog?.pages ?? [];
  const backlinks = computeBacklinks(catalog);
  const similarConnected = computeSimilarLinks(catalog);
  const rootPaths = new Set(['index.md']);
  return pages.filter((page) => {
    if (page.status === 'orphan') return true;
    if (rootPaths.has(page.path)) return false;
    const linkKey = page.path.replace(/\.md$/i, '');
    const inbound = backlinks[linkKey] ?? backlinks[page.path] ?? [];
    if (inbound.length > 0) return false;
    return !similarConnected.has(linkKey);
  });
}

async function walkMarkdownFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      files.push(...(await walkMarkdownFiles(full, baseDir)));
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      files.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return files;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/** Load catalog.json from disk. */
export async function loadCatalog() {
  try {
    const raw = await fs.readFile(getCatalogPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CATALOG, pages: [] };
    return {
      version: parsed.version ?? 1,
      generatedAt: parsed.generatedAt ?? null,
      pages: Array.isArray(parsed.pages) ? parsed.pages : [],
    };
  } catch {
    return { ...DEFAULT_CATALOG, pages: [] };
  }
}

async function saveCatalog(catalog) {
  const tmp = `${getCatalogPath()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, getCatalogPath());
}

/** Re-scan pages/ and rebuild catalog.json from frontmatter (cache only). */
export function rebuildCatalog() {
  return mutateCatalog(rebuildCatalogNow);
}

async function rebuildCatalogNow() {
  await ensurePagesLayout();
  const relPaths = await walkMarkdownFiles(getBrainPagesDir());
  const pages = [];
  for (const relPath of relPaths.sort()) {
    const abs = await resolvePagePath(relPath);
    const raw = await fs.readFile(abs, 'utf8');
    const { front, body } = parsePageMarkdown(raw);
    pages.push(buildCatalogEntry(front, relPath, body));
  }
  const catalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    pages,
  };
  await saveCatalog(catalog);
  return catalog;
}

/** Regenerate index.md as a human-readable catalog view. */
export async function rebuildIndex() {
  const catalog = await loadCatalog();
  const lines = ['# Brain Wiki Index', '', `_Generated ${new Date().toISOString()}_`, ''];
  const byFolder = new Map();
  for (const page of catalog.pages) {
    const folder = page.folder || '(root)';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(page);
  }
  for (const [folder, folderPages] of [...byFolder.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`## ${folder}`, '');
    for (const page of folderPages.sort((a, b) => a.title.localeCompare(b.title))) {
      lines.push(`- [[${page.path.replace(/\.md$/i, '')}]] — ${page.title}`);
    }
    lines.push('');
  }
  const content = `${lines.join('\n').trimEnd()}\n`;
  await fs.writeFile(getBrainIndexPath(), content, 'utf8');
  return content;
}

/** Append a timestamped line to log.md. */
export function appendLog(entry) {
  return mutateLog(() => appendLogNow(entry));
}

async function appendLogNow(entry) {
  await ensurePagesLayout();
  const line = `- ${new Date().toISOString()} — ${String(entry ?? '').trim()}\n`;
  let existing = '';
  try {
    existing = await fs.readFile(getBrainLogPath(), 'utf8');
  } catch {
    existing = '# Brain Changelog\n\n';
  }
  await fs.writeFile(getBrainLogPath(), `${existing.trimEnd()}\n${line}`, 'utf8');
}

/** List page metadata from catalog (rebuilds when empty but pages exist). */
export async function listPages() {
  let catalog = await loadCatalog();
  if (catalog.pages.length === 0) {
    const relPaths = await walkMarkdownFiles(getBrainPagesDir()).catch(() => []);
    if (relPaths.length > 0) {
      catalog = await rebuildCatalog();
    }
  }
  return catalog.pages;
}

/** Nested folder tree of page paths for UI/routing. */
export async function getPageTree() {
  const pages = await listPages();
  /** @type {Record<string, unknown>} */
  const tree = {};
  for (const page of pages) {
    const segments = page.path.replace(/\\/g, '/').split('/');
    let node = tree;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const isLeaf = i === segments.length - 1;
      if (isLeaf) {
        node[seg] = { type: 'page', ...page };
      } else {
        if (!node[seg] || typeof node[seg] !== 'object') {
          node[seg] = { type: 'folder', children: {} };
        }
        node = node[seg].children;
      }
    }
  }
  return tree;
}

/**
 * Resolve a wikilink key against catalog metadata only (no filesystem).
 * Mirrors the catalog branch of {@link resolvePageLookup}.
 * @param {string} key
 * @param {Array<{ id?: string, path: string }>} pages
 * @returns {'missing' | 'ambiguous' | string} resolved path, or sentinel when not unique
 */
export function resolvePageKeyInCatalog(key, pages) {
  const input = String(key ?? '').trim().replace(/\\/g, '/');
  if (!input) return 'missing';

  if (isValidPageId(input)) {
    const byId = pages.find((p) => p.id === input);
    return byId ? byId.path : 'missing';
  }

  const basename = path.posix.basename(input);
  const normalizedInput = normalizePageRef(input);
  const candidates = pages.filter((page) => {
    const pagePath = page.path.replace(/\\/g, '/');
    if (normalizePageRef(pagePath) === normalizedInput) return true;
    if (pagePath === input) return true;
    if (path.posix.basename(pagePath) === basename) return true;
    if (input.endsWith('.md') && pagePath.endsWith(`/${input}`)) return true;
    if (!input.includes('/') && pagePath.endsWith(`/${input}.md`)) return true;
    if (!input.includes('/') && path.posix.basename(pagePath, '.md') === input) return true;
    return false;
  });

  if (candidates.length === 1) return candidates[0].path;
  if (candidates.length > 1) return 'ambiguous';
  return 'missing';
}

/**
 * Resolve a page lookup key (full path, basename, or page id) to a pages-relative path.
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function resolvePageLookup(key) {
  const input = String(key ?? '').trim().replace(/\\/g, '/');
  if (!input) {
    throw new Error('Page path is required');
  }

  if (isValidPageId(input)) {
    const pages = await listPages();
    const byId = pages.find((p) => p.id === input);
    if (byId) return byId.path;
    throw new Error(`No wiki page found with id ${input}`);
  }

  try {
    assertSafeRelativePagePath(input);
    const abs = await resolvePagePath(input);
    await fs.access(abs);
    return input;
  } catch (err) {
    if (err instanceof BrainPathError) throw err;
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
    if (code !== 'ENOENT') throw err;
  }

  const pages = await listPages();
  const resolved = resolvePageKeyInCatalog(input, pages);
  if (resolved === 'missing') {
    throw new Error(
      `No wiki page found at "${input}". Use brain_search or brain_list to find the correct path.`,
    );
  }
  if (resolved === 'ambiguous') {
    const basename = path.posix.basename(input);
    const normalizedInput = normalizePageRef(input);
    const candidates = pages.filter((page) => {
      const pagePath = page.path.replace(/\\/g, '/');
      if (normalizePageRef(pagePath) === normalizedInput) return true;
      if (pagePath === input) return true;
      if (path.posix.basename(pagePath) === basename) return true;
      if (input.endsWith('.md') && pagePath.endsWith(`/${input}`)) return true;
      if (!input.includes('/') && pagePath.endsWith(`/${input}.md`)) return true;
      if (!input.includes('/') && path.posix.basename(pagePath, '.md') === input) return true;
      return false;
    });
    const options = candidates.map((page) => page.path).join(', ');
    throw new Error(
      `Ambiguous page lookup "${input}". Use the full path from brain_search: ${options}`,
    );
  }
  return resolved;
}

/** Read one page by relative path. */
export async function readPage(relPath) {
  const abs = await resolvePagePath(relPath);
  const raw = await fs.readFile(abs, 'utf8');
  const { front, body } = parsePageMarkdown(raw);
  const meta = buildCatalogEntry(front, relPath.replace(/\\/g, '/'), body);
  return { meta, body, path: meta.path };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/** Create a new wiki page at relPath. */
export function createPage(input) {
  return mutatePage(() => createPageNow(input));
}

async function createPageNow(input) {
  await ensurePagesLayout();
  const relPath = String(input.relPath ?? '').replace(/\\/g, '/');
  const abs = await resolvePagePath(relPath);

  try {
    await fs.access(abs);
    const err = new Error('Page already exists');
    err.statusCode = 409;
    throw err;
  } catch (e) {
    if (e && typeof e === 'object' && 'statusCode' in e) throw e;
    if (e && typeof e === 'object' && 'code' in e && e.code !== 'ENOENT') throw e;
  }

  const now = new Date().toISOString();
  const id =
    input.id && isValidPageId(input.id) ? input.id : randomUUID();
  const catalog = await loadCatalog();
  if (catalog.pages.some((p) => p.id === id)) {
    const err = new Error('Page id already exists');
    err.statusCode = 409;
    throw err;
  }

  const body = String(input.body ?? '');
  const meta = {
    id,
    title: String(input.title ?? 'Untitled'),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t)) : [],
    source: VALID_SOURCES.has(input.source) ? input.source : 'user',
    summary: String(input.summary ?? ''),
    pinned: Boolean(input.pinned),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    anchors: Array.isArray(input.anchors) ? input.anchors : [],
    status: VALID_STATUS.has(input.status) ? input.status : 'current',
    input_hash: String(input.input_hash ?? ''),
  };
  if (input.chatId) meta.chatId = String(input.chatId);
  if (Array.isArray(input.sourceTurnIndices)) {
    meta.sourceTurnIndices = input.sourceTurnIndices.map((n) => Number(n));
  }
  if (Array.isArray(input.similarTo) && input.similarTo.length > 0) {
    meta.similarTo = input.similarTo.map((s) => String(s));
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, serializePage(meta, body), 'utf8');
  syncAnchorsForPage(id, meta.anchors);
  await appendLog(`created ${relPath} (${id})`);
  await rebuildCatalog();

  const brainConfig = await loadBrainConfig();
  if (!input.skipVectorSync) {
    scheduleEntryVectorSync(meta, body, brainConfig);
  }

  return { meta: (await readPage(relPath)).meta, body, path: relPath };
}

/** Update an existing page. */
export function updatePage(relPath, input) {
  return mutatePage(() => updatePageNow(relPath, input));
}

async function updatePageNow(relPath, input) {
  const existing = await readPage(relPath);
  const abs = await resolvePagePath(relPath);
  const meta = { ...existing.meta };
  if (input.title !== undefined) meta.title = String(input.title);
  if (input.tags !== undefined) {
    meta.tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t)) : [];
  }
  if (input.source !== undefined && VALID_SOURCES.has(input.source)) meta.source = input.source;
  if (input.summary !== undefined) meta.summary = String(input.summary);
  if (input.pinned !== undefined) meta.pinned = Boolean(input.pinned);
  if (input.anchors !== undefined) {
    meta.anchors = Array.isArray(input.anchors) ? input.anchors : [];
  }
  if (input.status !== undefined && VALID_STATUS.has(input.status)) meta.status = input.status;
  else if (input.anchors !== undefined || input.body !== undefined) {
    meta.status = 'current';
  }
  if (input.input_hash !== undefined) meta.input_hash = String(input.input_hash);
  if (input.similarTo !== undefined) {
    meta.similarTo = Array.isArray(input.similarTo) ? input.similarTo.map(String) : [];
  }
  meta.updatedAt = new Date().toISOString();

  const body = input.body !== undefined ? String(input.body) : existing.body;
  await fs.writeFile(abs, serializePage(meta, body), 'utf8');
  if (!input.skipAnchorSync) {
    syncAnchorsForPage(meta.id, meta.anchors);
  }
  await appendLog(`updated ${relPath} (${meta.id})`);
  await rebuildCatalog();

  const brainConfig = await loadBrainConfig();
  scheduleEntryVectorSync(meta, body, brainConfig);

  return { meta: (await readPage(relPath)).meta, body, path: relPath };
}

/** Delete a page by relative path. */
export function deletePage(relPath) {
  return mutatePage(() => deletePageNow(relPath));
}

async function deletePageNow(relPath) {
  const existing = await readPage(relPath);
  const abs = await resolvePagePath(relPath);
  await fs.unlink(abs);
  deleteAnchorsForPage(existing.meta.id);
  await appendLog(`deleted ${relPath} (${existing.meta.id})`);
  await rebuildCatalog();
  void syncDeleteEntryVector(existing.meta.id);
  return true;
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** Ensure brain wiki directories and seed files exist. */
export async function ensureBrainLayout() {
  await fs.mkdir(getBrainDir(), { recursive: true });
  await ensurePagesLayout();

  const seeds = [
    {
      path: getBrainIndexPath(),
      content: `# Brain Wiki Index

This catalog is maintained by the assistant. Pages live under \`pages/\`.
`,
    },
    {
      path: getBrainLogPath(),
      content: `# Brain Changelog

`,
    },
    {
      path: getBrainSchemaPath(),
      content: `# Brain Routing Schema

## Page layout

- \`pages/facts/\` — discrete facts (migrated memory entries)
- \`pages/<domain>/\` — global knowledge domains
- \`pages/workspaces/<key>/\` — workspace-scoped pages

## Frontmatter

Each page carries \`id\` (stable UUID), \`title\`, \`tags\`, \`source\`, \`summary\`, \`pinned\`, timestamps, \`anchors\`, \`status\`, and \`input_hash\`.
`,
    },
    {
      path: getCatalogPath(),
      content: `${JSON.stringify(DEFAULT_CATALOG, null, 2)}\n`,
    },
  ];

  for (const seed of seeds) {
    try {
      await fs.access(seed.path);
    } catch {
      await fs.writeFile(seed.path, seed.content, 'utf8');
    }
  }

  try {
    await fs.access(getBrainStatePath());
  } catch {
    await fs.writeFile(
      getBrainStatePath(),
      `${JSON.stringify({ migratedFromMemory: false }, null, 2)}\n`,
      'utf8',
    );
  }
}

/** Bootstrap brain wiki tree, seed files, and one-time memory migration. */
export async function ensureBrainStore() {
  await ensureBrainLayout();
  await fs.mkdir(path.join(getBrainDir(), 'sources'), { recursive: true });
  await fs.mkdir(path.join(getBrainDir(), 'code'), { recursive: true });
  await fs.mkdir(path.join(getBrainPagesDir(), 'facts'), { recursive: true });
  await fs.mkdir(path.join(getBrainPagesDir(), 'workspaces'), { recursive: true });
  const { migrateFromMemory } = await import('./migrate.js');
  await migrateFromMemory();
}
