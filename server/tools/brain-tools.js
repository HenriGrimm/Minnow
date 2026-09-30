/**
 * Agent-facing Brain wiki tools — search, read, list, write, log, and ingest.
 */

import { ingestSource, clearIngestSources } from '../brain/ingest.js';
import { retrieveBrainBlockHybrid } from '../brain/retrieve.js';
import { deleteChatArchive } from '../brain/archive.js';
import { backupBrain } from '../brain/backup.js';
import { clearCodeIndex } from '../brain/code/schema.js';
import { clearSynthesisProposals } from '../brain/clear-synthesis-proposals.js';
import { clearVectorStore } from '../brain/vector-store.js';
import { brainWorkspaceKeyFromPath } from '../brain/paths.js';
import {
  appendLog,
  createPage,
  deletePage,
  getPageTree,
  listPages,
  loadBrainConfig,
  readPage,
  resolvePageLookup,
  updatePage,
} from '../brain/store.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { recordBrainUsage } from '../brain/usage.js';

/** Resolve workspace key for scoped wiki retrieve/write. */
function activeWorkspaceKey() {
  return brainWorkspaceKeyFromPath(getEffectiveWorkspaceRoot());
}

/**
 * Semantic/hybrid search over the wiki (workspace-scoped).
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolBrainSearch(args) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) {
    return 'Error: Brain wiki is disabled in Settings → Memory.';
  }

  const query = String(args?.query ?? '').trim();
  if (!query) {
    return 'Error: query is required.';
  }

  const limit = typeof args?.limit === 'number' ? Math.min(20, Math.max(1, args.limit)) : 8;
  const tags = Array.isArray(args?.tags)
    ? args.tags.map((t) => String(t).trim()).filter(Boolean)
    : undefined;

  const { block, ids } = await retrieveBrainBlockHybrid(
    {
      query,
      limit,
      tags,
      maxChars: brain.maxInjectCharsFull ?? 8000,
      workspaceKey: activeWorkspaceKey(),
    },
    brain,
  );

  if (!block.trim()) {
    return 'No matching wiki pages found.';
  }

  const pages = await listPages();
  const paths = ids
    .map((id) => pages.find((page) => page.id === id)?.path)
    .filter(Boolean);
  const pathLine = paths.length ? `\n\nMatched page paths: ${paths.join(', ')}` : '';
  const idLine = ids.length ? `\nMatched page ids: ${ids.join(', ')}` : '';
  void recordBrainUsage('agent-read');
  return `${block.trim()}${pathLine}${idLine}`;
}

/**
 * Read one wiki page by relative path under pages/.
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolBrainReadPage(args) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) {
    return 'Error: Brain wiki is disabled in Settings → Memory.';
  }

  const lookup = String(args?.path ?? args?.id ?? '').trim();
  if (!lookup) {
    return 'Error: path is required (e.g. minnow/architecture.md or a page id from brain_search).';
  }

  const relPath = await resolvePageLookup(lookup);
  const page = await readPage(relPath);
  const tags = (page.meta.tags ?? []).join(', ') || 'none';
  void recordBrainUsage('agent-read');
  return [
    `# ${page.meta.title}`,
    `path: ${page.path}`,
    `id: ${page.meta.id}`,
    `revision: ${page.revision}`,
    `tags: ${tags}`,
    `source: ${page.meta.source ?? 'user'}`,
    '',
    page.body.trim() || '(empty body)',
  ].join('\n');
}

/**
 * List the wiki page tree (metadata only).
 * @param {Record<string, unknown>} [_args]
 * @returns {Promise<string>}
 */
export async function toolBrainList(_args) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) {
    return 'Error: Brain wiki is disabled in Settings → Memory.';
  }

  const tree = await getPageTree();
  return JSON.stringify(tree, null, 2);
}

/**
 * Create or update a wiki page (frontmatter + body).
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolBrainWritePage(args) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) {
    return 'Error: Brain wiki is disabled in Settings → Memory.';
  }

  const relPath = String(args?.path ?? '').trim().replace(/\\/g, '/');
  const title = String(args?.title ?? '').trim();
  const body = String(args?.body ?? '').trim();

  if (!relPath) {
    return 'Error: path is required (e.g. facts/preference.md or edgeflight/overview.md).';
  }
  if (!title) {
    return 'Error: title is required.';
  }
  if (!body) {
    return 'Error: body is required.';
  }

  const tags = Array.isArray(args?.tags)
    ? args.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const summary = args?.summary !== undefined ? String(args.summary) : undefined;
  const expectedRevision = args?.expectedRevision;
  if (expectedRevision !== undefined &&
    (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) {
    return 'Error: expectedRevision must be a 64-character revision from brain_read_page.';
  }

  let exists = true;
  try {
    await readPage(relPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    exists = false;
  }

  if (exists) {
    const updated = await updatePage(relPath, {
      title, body, tags, summary, source: 'agent', expectedRevision,
    });
    void recordBrainUsage('agent-write');
    return `Updated wiki page "${updated.meta.title}" at ${updated.path} (id: ${updated.meta.id}, revision: ${updated.revision}).`;
  }

  if (expectedRevision !== undefined) {
    return 'Error: Page changed since it was loaded; the page no longer exists.';
  }

  const created = await createPage({
    relPath,
    title,
    body,
    tags,
    summary,
    source: 'agent',
  });
  void recordBrainUsage('agent-write');
  return `Created wiki page "${created.meta.title}" at ${created.path} (id: ${created.meta.id}, revision: ${created.revision}).`;
}

/**
 * Append a line to brain log.md (changelog).
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolBrainAppendLog(args) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) {
    return 'Error: Brain wiki is disabled in Settings → Memory.';
  }

  const entry = String(args?.entry ?? args?.message ?? '').trim();
  if (!entry) {
    return 'Error: entry is required.';
  }

  await appendLog(entry);
  void recordBrainUsage('agent-write');
  return 'Appended to brain log.md.';
}

/**
 * Ingest a non-code source into immutable sources/ + synthesized wiki pages.
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolBrainIngestSource(args) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) {
    return 'Error: Brain wiki is disabled in Settings → Memory.';
  }

  const content = String(args?.content ?? '').trim();
  if (!content) {
    return 'Error: content is required.';
  }

  try {
    const result = await ingestSource({
      content,
      filename: args?.filename !== undefined ? String(args.filename) : undefined,
      title: args?.title !== undefined ? String(args.title) : undefined,
    });
    const pages = Array.isArray(result?.pages)
      ? result.pages
      : Array.isArray(result?.paths)
        ? result.paths
        : [];
    if (!pages.length) {
      return 'Ingest completed but no wiki pages were created.';
    }
    return `Ingested source into ${pages.length} page(s): ${pages.join(', ')}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error ingesting source: ${message}`;
  }
}

const MANAGE_BRAIN_DESTRUCTIVE = new Set([
  'delete_page',
  'clear_wiki',
  'delete_archive',
  'clear_proposals',
  'clear_code_index',
  'clear_sources',
]);

/**
 * Destructive Brain data management (wiki, archives, proposals, code index, sources).
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolManageBrain(args) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) {
    return 'Error: Brain wiki is disabled in Settings → Memory.';
  }

  const action = String(args?.action ?? '').trim();
  if (!action) {
    return 'Error: action is required.';
  }

  const confirmed =
    args?.confirmed === true ||
    args?.confirm === true ||
    args?.confirmed === 'true' ||
    args?.confirm === 'true';
  if (MANAGE_BRAIN_DESTRUCTIVE.has(action) && !confirmed) {
    return 'Deletion requires confirmation. Re-run with confirmed: true after user approval.';
  }

  const workspaceKey = activeWorkspaceKey();

  if (action === 'delete_page') {
    const lookup = String(args?.path ?? '').trim();
    if (!lookup) {
      return 'Error: path is required for delete_page.';
    }
    const relPath = await resolvePageLookup(lookup);
    let page;
    try {
      page = await readPage(relPath);
    } catch {
      return `Error: page not found at ${lookup}.`;
    }
    await deletePage(page.path);
    return `Deleted wiki page "${page.meta.title}" at ${page.path}.`;
  }

  if (action === 'clear_wiki') {
    let archivePath;
    if (args?.archive === true) {
      const backup = await backupBrain();
      archivePath = backup.path;
    }
    const pages = await listPages();
    for (const page of pages) {
      try {
        await deletePage(page.path);
      } catch {
        /* ignore per-page errors */
      }
    }
    try {
      await clearVectorStore();
    } catch {
      /* ignore vector cleanup */
    }
    const archiveNote = archivePath ? ` Backup: ${archivePath}.` : '';
    return `Cleared ${pages.length} wiki page(s).${archiveNote}`;
  }

  if (action === 'delete_archive') {
    const chatId = String(args?.chatId ?? '').trim();
    if (!chatId) {
      return 'Error: chatId is required for delete_archive.';
    }
    const key =
      String(args?.workspaceKey ?? '').trim() || workspaceKey;
    const result = await deleteChatArchive(chatId, key);
    return `Deleted chat archive ${chatId} (${result.removed} page(s)).`;
  }

  if (action === 'clear_proposals') {
    const scope = args?.scope === 'all' ? 'all' : 'pending';
    const result = await clearSynthesisProposals(scope);
    return `Cleared ${result.removed} proposal(s) (scope: ${scope}).`;
  }

  if (action === 'clear_code_index') {
    const result = clearCodeIndex({
      all: args?.all === true,
      workspaceKey:
        args?.workspaceKey !== undefined ? String(args.workspaceKey) : undefined,
    });
    const keys = result.workspaceKeys.length
      ? result.workspaceKeys.join(', ')
      : 'none';
    return `Reset code index for ${result.removed} workspace(s): ${keys}.`;
  }

  if (action === 'clear_sources') {
    const result = await clearIngestSources({ archive: args?.archive === true });
    const archiveNote = result.archivePath ? ` Backup: ${result.archivePath}.` : '';
    return `Cleared ${result.removed} ingest source file(s).${archiveNote}`;
  }

  return `Error: unknown action "${action}".`;
}
