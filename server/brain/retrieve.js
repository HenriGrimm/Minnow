/**
 * Workspace-scoped brain retrieval — loads wiki pages, scopes, then calls the pure engine.
 */

import { bindRetrieveVectorStore, retrieveMemoryBlockHybrid } from '../engine/retrieve.js';
import { createVectorStore } from '../engine/vector-store.js';
import { getEnginePaths } from './engine-paths.js';
import { isValidPageId } from './paths.js';
import { archiveFolderPrefix } from './archive.js';
import { rerankArchiveHits, llmRerankArchiveHits } from './archive-rerank.js';
import { listPages, readPage, loadBrainConfig, loadCatalog, computeBacklinks } from './store.js';

const vectorStore = createVectorStore(getEnginePaths, { isValidEntryId: isValidPageId });
bindRetrieveVectorStore(vectorStore);

export * from '../engine/retrieve.js';

/**
 * Keep global pages and only the matching workspace subtree.
 * @param {Array<{ path: string }>} pages
 * @param {string} [workspaceKey]
 */
export function scopePagesToWorkspace(pages, workspaceKey) {
  const key = String(workspaceKey ?? '').trim().replace(/\\/g, '/');
  const workspacePrefix = key ? `workspaces/${key}/` : null;

  return pages.filter((page) => {
    const rel = String(page.path ?? '').replace(/\\/g, '/');
    if (!rel.startsWith('workspaces/')) {
      return true;
    }
    if (!workspacePrefix) {
      return false;
    }
    return rel.startsWith(workspacePrefix);
  });
}

/**
 * Keep only pages under an expert's long-term memory namespace.
 * @param {Array<{ path: string }>} pages
 * @param {string} expertId
 */
export function scopePagesToExpert(pages, expertId) {
  const id = String(expertId ?? '').trim();
  if (!id) return [];
  const prefix = `experts/${id}/facts/`;
  return pages.filter((page) => {
    const rel = String(page.path ?? '').replace(/\\/g, '/');
    return rel.startsWith(prefix);
  });
}

/**
 * When chatId is set, keep only that chat's archive subtree (optionally union globals).
 * @param {Array<{ path: string }>} pages
 * @param {string} workspaceKey
 * @param {string} chatId
 * @param {boolean} [includeGlobal]
 */
export function scopePagesToChatArchive(pages, workspaceKey, chatId, includeGlobal = false) {
  const prefix = `${archiveFolderPrefix(workspaceKey, chatId)}/`;
  return pages.filter((page) => {
    const rel = String(page.path ?? '').replace(/\\/g, '/');
    if (rel.startsWith(prefix)) return true;
    if (includeGlobal && !rel.startsWith('workspaces/')) return true;
    return false;
  });
}

/**
 * Workspace-wide archive + promoted concepts (opt-in cross-chat recall).
 * @param {Array<{ path: string }>} pages
 * @param {string} workspaceKey
 * @param {boolean} [includeGlobal]
 */
export function scopePagesToWorkspaceArchive(pages, workspaceKey, includeGlobal = false) {
  const key = String(workspaceKey ?? '').trim().replace(/\\/g, '/');
  const archivePrefix = key ? `workspaces/${key}/archive/` : '';
  const conceptsPrefix = key ? `workspaces/${key}/concepts/` : '';
  return pages.filter((page) => {
    const rel = String(page.path ?? '').replace(/\\/g, '/');
    if (archivePrefix && rel.startsWith(archivePrefix)) return true;
    if (conceptsPrefix && rel.startsWith(conceptsPrefix)) return true;
    if (includeGlobal && !rel.startsWith('workspaces/')) return true;
    return false;
  });
}

/** Extract first blockquote line from archive page body as sourceQuote. */
function extractSourceQuote(body) {
  const match = String(body ?? '').match(/^>\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

/** Build rich hits for archive auto-prelude / recall tools. */
export async function buildRetrieveHits(entries, ids, scoreById = null) {
  const idSet = new Set(ids ?? []);
  const catalog = await loadCatalog();
  const backlinks = computeBacklinks(catalog);
  const hits = [];
  for (const row of entries) {
    const id = row.meta?.id;
    if (!idSet.has(id)) continue;
    const relPath = row.meta.path ?? '';
    const linkKey = relPath.replace(/\.md$/, '');
    hits.push({
      path: relPath,
      title: row.meta.title ?? 'Untitled',
      excerpt: String(row.body ?? '').slice(0, 800),
      sourceQuote: extractSourceQuote(row.body),
      frontmatter: row.meta,
      backlinks: backlinks[linkKey] ?? backlinks[relPath] ?? [],
      score: scoreById?.get(id),
    });
  }
  return hits;
}

/** Load every wiki page with body text for retrieval. */
export async function loadAllPagesWithBodies() {
  const metas = await listPages();
  const out = [];
  for (const meta of metas) {
    try {
      const row = await readPage(meta.path);
      out.push({ meta: row.meta, body: row.body });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/**
 * Hybrid retrieve over scoped wiki pages (workspace filter applied before engine call).
 * @param {{ query?: string, limit?: number, tags?: string[], maxChars?: number, autoInject?: boolean, workspaceKey?: string, scope?: { chatId?: string, mode?: string, includeGlobal?: boolean }, includeHits?: boolean, embeddingModelId?: string, llmRerank?: boolean }} opts
 * @param {object} [brainConfig]
 */
export async function retrieveBrainBlockHybrid(opts = {}, brainConfig) {
  let config = brainConfig ?? (await loadBrainConfig());
  if (opts.embeddingModelId) {
    config = {
      ...config,
      embeddings: {
        ...(config.embeddings ?? {}),
        modelId: String(opts.embeddingModelId).trim(),
      },
    };
  }
  const all = await loadAllPagesWithBodies();
  let scopedMetas = scopePagesToWorkspace(
    all.map((row) => row.meta),
    opts.workspaceKey,
  );
  const chatId = opts.scope?.chatId ? String(opts.scope.chatId).trim() : '';
  const expertId = opts.scope?.expertId ? String(opts.scope.expertId).trim() : '';
  const workspaceArchive =
    opts.scope?.mode === 'workspace' || opts.scope?.workspaceArchive === true;
  if (expertId) {
    scopedMetas = scopePagesToExpert(scopedMetas, expertId);
  } else if (chatId) {
    scopedMetas = scopePagesToChatArchive(
      scopedMetas,
      opts.workspaceKey ?? '',
      chatId,
      opts.scope?.includeGlobal === true,
    );
  } else if (workspaceArchive) {
    scopedMetas = scopePagesToWorkspaceArchive(
      scopedMetas,
      opts.workspaceKey ?? '',
      opts.scope?.includeGlobal === true,
    );
  }
  const scopedPaths = new Set(scopedMetas.map((m) => m.path));
  const entries = all.filter((row) => scopedPaths.has(row.meta.path));
  const { block, ids } = await retrieveMemoryBlockHybrid(entries, opts, config);
  if (opts.includeHits === true) {
    let hits = await buildRetrieveHits(entries, ids);
    if (chatId || workspaceArchive) {
      hits = rerankArchiveHits(hits);
      if (opts.llmRerank === true) {
        hits = await llmRerankArchiveHits(
          hits,
          String(opts.query ?? ''),
          opts.limit ?? 12,
        );
      }
    }
    return { block, ids, hits };
  }
  return { block, ids };
}
