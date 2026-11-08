/**
 * Memory back-compat adapter over the brain wiki store (MIN-B3).
 * TRACKING: remove when /api/memory and save_memory migrate to brain tools (MIN-B4+).
 */

import { randomUUID } from 'node:crypto';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import { DEFAULT_EMBEDDINGS_CONFIG } from '../engine/embeddings.js';
import {
  createPage,
  deletePage,
  ensureBrainStore,
  listPages,
  loadBrainConfig,
  readPage,
  updatePage,
} from '../brain/store.js';
import { clearVectorStore } from '../brain/vector-store.js';
import { slugifyFactTitle } from '../brain/synthesis.js';
import { isValidEntryId } from './paths.js';
import { backupBrain } from '../brain/backup.js';

const MAX_BODY_BYTES = 32 * 1024;
const FACTS_PREFIX = 'facts/';

/** Default memory section in config.json when missing. */
export const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  maxInjectCharsFull: 8000,
  maxInjectCharsLite: 800,
  retrieveLimit: 20,
  defaultTags: [],
  embeddings: { ...DEFAULT_EMBEDDINGS_CONFIG },
};

/** Map wiki page meta to legacy memory entry metadata. */
export function pageMetaToEntryMeta(meta) {
  let source = 'user';
  if (meta.source === 'agent' || meta.source === 'synthesis') {
    source = meta.source;
  } else if (meta.source === 'ingest') {
    source = 'agent';
  }
  return {
    id: meta.id,
    title: String(meta.title ?? 'Untitled').slice(0, 200),
    tags: Array.isArray(meta.tags)
      ? meta.tags.map((t) => String(t).slice(0, 64))
      : [],
    source,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pinned: Boolean(meta.pinned),
  };
}

function isFactsPage(page) {
  return String(page.path ?? '').replace(/\\/g, '/').startsWith(FACTS_PREFIX);
}

async function findFactsPageById(id) {
  if (!isValidEntryId(id)) return null;
  const pages = await listPages();
  const meta = pages.find((p) => p.id === id && isFactsPage(p));
  if (!meta) return null;
  const row = await readPage(meta.path);
  return row;
}

async function allocateFactsPath(title, id) {
  const baseSlug = slugifyFactTitle(title);
  let slug = baseSlug;
  let n = 2;
  while (n < 100) {
    const relPath = `${FACTS_PREFIX}${slug}.md`;
    try {
      await readPage(relPath);
      slug = n === 2 && id ? `${baseSlug}-${id.slice(0, 8)}` : `${baseSlug}-${n}`;
      n += 1;
    } catch {
      return relPath;
    }
  }
  return `${FACTS_PREFIX}${baseSlug}-${randomUUID().slice(0, 8)}.md`;
}

/** Load merged memory config from config.json. */
export async function loadMemoryConfig() {
  const config = (await readConfigJson('config.json')) ?? {};
  const raw =
    config.memory && typeof config.memory === 'object'
      ? config.memory
      : {};
  // Older profiles may still contain the removed entry-count cap.
  delete raw.maxEntries;
  const brainEmb = (await loadBrainConfig()).embeddings ?? {};
  const embeddings =
    raw.embeddings && typeof raw.embeddings === 'object'
      ? { ...DEFAULT_EMBEDDINGS_CONFIG, ...brainEmb, ...raw.embeddings }
      : { ...DEFAULT_EMBEDDINGS_CONFIG, ...brainEmb };
  return {
    ...DEFAULT_MEMORY_CONFIG,
    ...raw,
    embeddings,
  };
}

/** Persist memory.enabled, limits, and embeddings into config.json. */
export async function saveMemoryConfig(partial) {
  const config = (await readConfigJson('config.json')) ?? {};
  const existing =
    config.memory && typeof config.memory === 'object'
      ? { ...DEFAULT_MEMORY_CONFIG, ...config.memory }
      : { ...DEFAULT_MEMORY_CONFIG };
  const existingEmb =
    existing.embeddings && typeof existing.embeddings === 'object'
      ? { ...DEFAULT_EMBEDDINGS_CONFIG, ...existing.embeddings }
      : { ...DEFAULT_EMBEDDINGS_CONFIG };

  const partialEmb =
    partial?.embeddings && typeof partial.embeddings === 'object'
      ? partial.embeddings
      : null;

  const nextEmb = partialEmb
    ? { ...existingEmb, ...partialEmb }
    : existingEmb;

  if (
    partialEmb &&
    ((partialEmb.backend !== undefined && partialEmb.backend !== existingEmb.backend) ||
      (partialEmb.modelId !== undefined && partialEmb.modelId !== existingEmb.modelId) ||
      (partialEmb.providerId !== undefined && partialEmb.providerId !== existingEmb.providerId))
  ) {
    nextEmb.reindexNeeded = true;
  }

  config.memory = {
    ...existing,
    ...partial,
    embeddings: nextEmb,
  };
  delete config.memory.maxEntries;

  const brain =
    config.brain && typeof config.brain === 'object' ? config.brain : {};
  config.brain = {
    ...brain,
    embeddings: { ...(brain.embeddings ?? {}), ...nextEmb },
  };

  await writeConfigJson('config.json', config);
  return config.memory;
}

/** List memory entries (facts pages only). */
export async function listEntries() {
  const pages = await listPages();
  return pages.filter(isFactsPage).map(pageMetaToEntryMeta);
}

/** Read one memory entry by id. */
export async function getEntry(id) {
  const row = await findFactsPageById(id);
  if (!row) return null;
  return { entry: pageMetaToEntryMeta(row.meta), body: row.body };
}

/** Create a memory entry as a facts wiki page. */
export async function createEntry(input) {
  const entries = await listEntries();
  const body = String(input.body ?? '');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    const err = new Error('Entry body exceeds 32KB limit');
    err.statusCode = 413;
    throw err;
  }

  const id =
    input.id && isValidEntryId(input.id) ? input.id : randomUUID();
  if (entries.some((e) => e.id === id)) {
    const err = new Error('Entry id already exists');
    err.statusCode = 409;
    throw err;
  }

  const title = String(input.title ?? 'Untitled').slice(0, 200);
  const relPath = await allocateFactsPath(title, id);
  const source =
    input.source === 'agent' || input.source === 'self-heal' ? 'agent' : 'user';

  const page = await createPage({
    relPath,
    id,
    title,
    body,
    tags: Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).slice(0, 64))
      : [],
    source,
    pinned: Boolean(input.pinned),
    skipVectorSync: Boolean(input.skipVectorSync),
  });

  return pageMetaToEntryMeta(page.meta);
}

/** Update an existing memory entry. */
export async function updateEntry(id, input) {
  const row = await findFactsPageById(id);
  if (!row) return null;

  let body = row.body;
  if (input.body !== undefined) {
    body = String(input.body);
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      const err = new Error('Entry body exceeds 32KB limit');
      err.statusCode = 413;
      throw err;
    }
  }

  const updated = await updatePage(row.path, {
    title: input.title !== undefined ? String(input.title).slice(0, 200) : undefined,
    tags:
      input.tags !== undefined
        ? Array.isArray(input.tags)
          ? input.tags.map((t) => String(t).slice(0, 64))
          : []
        : undefined,
    pinned: input.pinned,
    body: input.body !== undefined ? body : undefined,
  });

  return pageMetaToEntryMeta(updated.meta);
}

/** Delete a memory entry. */
export async function deleteEntry(id) {
  const row = await findFactsPageById(id);
  if (!row) return false;
  await deletePage(row.path);
  return true;
}

/** Remove all memory entries; optionally archive first. */
export async function clearEntries(archive = false) {
  const entries = await listEntries();
  const count = entries.length;
  if (count === 0) return { removed: 0, archivePath: null };

  let archivePath = null;
  if (archive) {
    const backup = await backupBrain();
    archivePath = backup.path;
  }

  for (const entry of entries) {
    const row = await findFactsPageById(entry.id);
    if (row) {
      try {
        await deletePage(row.path);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    await clearVectorStore();
  } catch {
    /* ignore */
  }

  return { removed: count, archivePath };
}

/** Entry count for status. */
export async function getEntryCount() {
  const entries = await listEntries();
  return entries.length;
}

/** Read all memory entries with bodies for retrieval. */
export async function loadAllEntriesWithBodies() {
  const entries = await listEntries();
  const out = [];
  for (const meta of entries) {
    try {
      const row = await findFactsPageById(meta.id);
      if (!row) continue;
      out.push({ meta: pageMetaToEntryMeta(row.meta), body: row.body });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/** Ensure brain wiki (memory adapter bootstrap). */
export async function ensureMemoryStore() {
  await ensureBrainStore();
  const config = (await readConfigJson('config.json')) ?? {};
  if (!config.memory) {
    await saveMemoryConfig(DEFAULT_MEMORY_CONFIG);
  }
}
