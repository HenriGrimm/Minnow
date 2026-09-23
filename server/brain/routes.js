/**
 * HTTP handlers for /api/brain/* (wiki store, retrieve, ingest, lint).
 */

import fs from 'node:fs/promises';
import { getMinnowHome } from '../config/home.js';
import { getEmbedder, embedTexts, EMBEDDINGS_WARMUP_TIMEOUT_MS } from '../engine/embeddings.js';
import { BrainPathError, getBrainDir, getBrainLogPath, getBrainSchemaPath } from './paths.js';
import { backupBrain, restoreBrain } from './backup.js';
import { ingestSource, clearIngestSources } from './ingest.js';
import { lintBrainWiki, pruneWeakSimilarLinks } from './lint.js';
import { generateBrainCleanupPlan } from './cleanup/plan.js';
import { readBrainUsage } from './usage.js';
import {
  listMemoryProposals,
  getMemoryProposal,
  updateMemoryProposalStatus,
  applyMemoryProposalEdits,
} from './proposals.js';
import { clearSynthesisProposals } from './clear-synthesis-proposals.js';
import {
  retrieveBrainBlockHybrid,
  loadAllPagesWithBodies,
  scopePagesToExpert,
} from './retrieve.js';
import {
  bundleArchiveRange,
  deleteChatArchive,
  getArchiveStatus,
  reconcileOrphanArchives,
} from './archive.js';
import { captureChatToBrain, captureResearchToBrain } from './capture.js';
import { handleCodeIndexRequest } from './code/routes.js';
import { handleSynthesisRequest } from './synthesis-routes.js';
import { slugifyFactTitle } from './synthesis.js';
import { clearReindexNeeded } from './vector-sync.js';
import { executeBrainCleanup } from './cleanup/execute.js';
import { createVectorStore } from '../engine/vector-store.js';
import { getEnginePaths } from './engine-paths.js';
import { isValidPageId } from './paths.js';
import {
  createPage as createWikiPage,
  deletePage,
  ensureBrainStore,
  getPageTree,
  listPages,
  loadBrainConfig,
  readPage,
  saveBrainConfig,
  updatePage,
  appendLog,
} from './store.js';

const vectorStore = createVectorStore(getEnginePaths, { isValidEntryId: isValidPageId });
const {
  getVectorCount,
  loadVectorStore,
  isVectorStoreCompatible,
  reindexAllMemoryEntries,
  clearVectorStore,
} = vectorStore;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function pageMetaToEntry(meta) {
  return {
    id: meta.id,
    title: meta.title,
    tags: meta.tags ?? [],
    source: meta.source,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pinned: Boolean(meta.pinned),
  };
}

/** Valid expert id slug for namespaced memory paths. */
function isValidExpertId(expertId) {
  return /^[a-z][a-z0-9-]{0,63}$/.test(String(expertId ?? '').trim());
}

/**
 * Handle /api/brain requests. Returns true if handled.
 * prune-links is a dry run unless the caller sets apply — it rewrites frontmatter.
 */
export async function handleBrainRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/brain')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (pathname === '/api/brain/ping' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/brain/status' && req.method === 'GET') {
      const brain = await loadBrainConfig();
      const pages = await listPages();
      sendJson(res, 200, {
        enabled: brain.enabled !== false,
        pageCount: pages.length,
        home: getMinnowHome(),
        brainDir: getBrainDir(),
      });
      return true;
    }

    if (pathname === '/api/brain/tree' && req.method === 'GET') {
      const tree = await getPageTree();
      sendJson(res, 200, { tree });
      return true;
    }

    if (pathname === '/api/brain/page' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const relPath = url.searchParams.get('path') ?? '';
      const page = await readPage(relPath);
      sendJson(res, 200, page);
      return true;
    }

    if (pathname === '/api/brain/page' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const relPath = String(body.path ?? body.relPath ?? '');
      if (!relPath) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      let exists = true;
      try {
        await readPage(relPath);
      } catch {
        exists = false;
      }
      if (exists) {
        const updated = await updatePage(relPath, body);
        sendJson(res, 200, updated);
      } else {
        const created = await createWikiPage({
          relPath,
          title: body.title,
          body: body.body,
          tags: body.tags,
          source: body.source,
          summary: body.summary,
          pinned: body.pinned,
          id: body.id,
        });
        sendJson(res, 201, created);
      }
      return true;
    }

    if (pathname === '/api/brain/page' && req.method === 'DELETE') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const relPath = url.searchParams.get('path') ?? '';
      if (!relPath) {
        const body = await readJsonBody(req);
        const fromBody = String(body.path ?? body.relPath ?? '');
        if (!fromBody) {
          sendJson(res, 400, { error: 'path is required' });
          return true;
        }
        await deletePage(fromBody);
        sendJson(res, 200, { ok: true });
        return true;
      }
      await deletePage(relPath);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/brain/retrieve' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const brain = await loadBrainConfig();
      if (brain.enabled === false) {
        sendJson(res, 200, { block: '', ids: [] });
        return true;
      }
      const profile = body.profile === 'lite' ? 'lite' : 'full';
      const maxChars =
        profile === 'lite'
          ? brain.maxInjectCharsLite ?? 800
          : brain.maxInjectCharsFull ?? 8000;
      const { block, ids, hits } = await retrieveBrainBlockHybrid(
        {
          query: body.query,
          autoInject: body.autoInject === true,
          limit: body.limit ?? 12,
          tags: body.tags,
          maxChars,
          workspaceKey: body.workspaceKey,
          scope: body.scope,
          includeHits: body.includeHits === true,
          embeddingModelId: body.embeddingModelId,
          llmRerank: body.llmRerank === true,
        },
        brain,
      );
      sendJson(res, 200, { block, ids, ...(hits ? { hits } : {}) });
      return true;
    }

    if (pathname === '/api/brain/archive' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await bundleArchiveRange(body);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/capture/chat' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await captureChatToBrain(body);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/capture/research' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await captureResearchToBrain(body);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/archive/status' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const chatId = url.searchParams.get('chatId') ?? '';
      const workspaceKey = url.searchParams.get('workspaceKey') ?? '';
      let pending = [];
      const pendingRaw = url.searchParams.get('pending');
      if (pendingRaw) {
        try {
          pending = JSON.parse(pendingRaw);
        } catch {
          pending = [];
        }
      }
      const status = await getArchiveStatus(chatId, workspaceKey, pending);
      sendJson(res, 200, status);
      return true;
    }

    const archiveChatMatch = pathname.match(/^\/api\/brain\/archive\/chat\/([^/]+)$/);
    if (archiveChatMatch && req.method === 'DELETE') {
      const chatId = decodeURIComponent(archiveChatMatch[1]);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const workspaceKey = url.searchParams.get('workspaceKey') ?? '';
      const result = await deleteChatArchive(chatId, workspaceKey);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/log' && req.method === 'GET') {
      const content = await fs.readFile(getBrainLogPath(), 'utf8').catch(() => '');
      sendJson(res, 200, { log: content });
      return true;
    }

    if (pathname === '/api/brain/schema' && req.method === 'GET') {
      const content = await fs.readFile(getBrainSchemaPath(), 'utf8').catch(() => '');
      sendJson(res, 200, { schema: content });
      return true;
    }

    if (pathname === '/api/brain/schema' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const schema = String(body.schema ?? body.content ?? '');
      await fs.writeFile(getBrainSchemaPath(), schema, 'utf8');
      await appendLog('updated schema.md');
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/brain/ingest' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await ingestSource(body);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/sources/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirmed !== true) {
        sendJson(res, 400, { error: 'confirmed: true is required' });
        return true;
      }
      const result = await clearIngestSources({ archive: body.archive === true });
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/lint' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const report = await lintBrainWiki({
        includeLlm: body.includeLlm !== false,
        apply: body.apply === true,
      });
      sendJson(res, 200, report);
      return true;
    }

    if (pathname === '/api/brain/usage' && req.method === 'GET') {
      sendJson(res, 200, await readBrainUsage());
      return true;
    }

    if (pathname === '/api/brain/prune-links' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const report = await pruneWeakSimilarLinks({ dryRun: body.apply !== true });
      sendJson(res, 200, report);
      return true;
    }

    if (pathname === '/api/brain/cleanup/execute' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const outcome = await executeBrainCleanup({
        planId: String(body.planId ?? ''),
        providerId: String(body.providerId ?? ''),
        modelId: String(body.modelId ?? ''),
      });
      const httpStatus = outcome.status === 'error' ? 500 : 200;
      sendJson(res, httpStatus, outcome);
      return true;
    }

    if (pathname === '/api/brain/cleanup/plan' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const result = await generateBrainCleanupPlan({
          providerId: body.providerId,
          modelId: body.modelId ?? body.model,
          maxSnapshotChars: body.maxSnapshotChars,
        });
        sendJson(res, 200, result);
      } catch (err) {
        const status =
          err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
            ? err.statusCode
            : 500;
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, status, { error: message });
      }
      return true;
    }

    if (pathname === '/api/brain/proposals' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const status = url.searchParams.get('status') ?? undefined;
      const proposals = await listMemoryProposals(
        /** @type {'pending' | 'accepted' | 'rejected' | undefined} */ (status),
      );
      sendJson(res, 200, { proposals });
      return true;
    }

    if (pathname === '/api/brain/proposals/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirmed !== true) {
        sendJson(res, 400, { error: 'confirmed: true is required' });
        return true;
      }
      const scope = body.scope === 'all' ? 'all' : 'pending';
      const result = await clearSynthesisProposals(scope);
      sendJson(res, 200, result);
      return true;
    }

    const acceptMatch = pathname.match(/^\/api\/brain\/proposals\/([^/]+)\/accept$/);
    if (acceptMatch && req.method === 'POST') {
      const id = decodeURIComponent(acceptMatch[1]);
      const body = await readJsonBody(req);
      const existing = await getMemoryProposal(id);
      if (!existing) {
        sendJson(res, 404, { error: 'Proposal not found' });
        return true;
      }
      if (existing.status !== 'pending') {
        sendJson(res, 409, { error: 'Proposal already resolved' });
        return true;
      }
      const edited = await applyMemoryProposalEdits(id, {
        title: body.title,
        body: body.body,
        tags: body.tags,
      });
      const row = edited ?? existing;
      const slug = slugifyFactTitle(row.title);
      const expertId =
        typeof row.expertId === 'string' ? row.expertId.trim() : '';
      let relPath = `facts/${slug}.md`;
      if (expertId && /^[a-z][a-z0-9-]{0,63}$/.test(expertId)) {
        relPath = `experts/${expertId}/facts/${slug}.md`;
      }
      const page = await createWikiPage({
        relPath,
        title: row.title,
        body: row.body,
        tags: row.tags,
        source: 'agent',
      });
      await updateMemoryProposalStatus(id, 'accepted');
      sendJson(res, 200, { ok: true, page: pageMetaToEntry(page.meta), proposalId: id });
      return true;
    }

    const rejectMatch = pathname.match(/^\/api\/brain\/proposals\/([^/]+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      const id = decodeURIComponent(rejectMatch[1]);
      const row = await updateMemoryProposalStatus(id, 'rejected');
      if (!row) {
        sendJson(res, 404, { error: 'Proposal not found' });
        return true;
      }
      sendJson(res, 200, { ok: true, proposalId: id });
      return true;
    }

    if (pathname === '/api/brain/embeddings/status' && req.method === 'GET') {
      const brain = await loadBrainConfig();
      const emb = brain.embeddings ?? {};
      const vectorCount = await getVectorCount();
      const store = await loadVectorStore();
      const pageCount = (await listPages()).length;
      let healthy = false;
      if (emb.enabled) {
        try {
          const embedder = await getEmbedder(brain);
          const compatible = isVectorStoreCompatible(store, {
            modelId: embedder.id,
            backend: emb.backend,
            dim: embedder.dim,
          });
          healthy = compatible && (pageCount === 0 || vectorCount > 0);
        } catch {
          healthy = false;
        }
      }
      sendJson(res, 200, {
        enabled: emb.enabled === true,
        backend: emb.backend ?? 'local',
        model: emb.modelId ?? '',
        providerId: emb.providerId ?? '',
        blendWeight: typeof emb.blendWeight === 'number' ? emb.blendWeight : 0.5,
        queryTimeoutMs: typeof emb.queryTimeoutMs === 'number' ? emb.queryTimeoutMs : 3000,
        dim: store.dim ?? 0,
        vectorCount,
        pageCount,
        reindexNeeded: emb.reindexNeeded === true,
        healthy,
      });
      return true;
    }

    if (pathname === '/api/brain/embeddings/config' && req.method === 'GET') {
      const brain = await loadBrainConfig();
      sendJson(res, 200, { embeddings: brain.embeddings });
      return true;
    }

    if (pathname === '/api/brain/embeddings/config' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const brain = await saveBrainConfig({
        embeddings: {
          ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
          ...(typeof body.backend === 'string' ? { backend: body.backend } : {}),
          ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
          ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
          ...(typeof body.blendWeight === 'number'
            ? { blendWeight: Math.min(1, Math.max(0, body.blendWeight)) }
            : {}),
          ...(typeof body.queryTimeoutMs === 'number'
            ? { queryTimeoutMs: Math.min(60_000, Math.max(500, Math.floor(body.queryTimeoutMs))) }
            : {}),
        },
      });
      sendJson(res, 200, { embeddings: brain.embeddings });
      return true;
    }

    if (pathname === '/api/brain/embeddings/reindex' && req.method === 'POST') {
      const started = Date.now();
      const brain = await loadBrainConfig();
      const emb = brain.embeddings ?? {};
      if (!emb.enabled) {
        sendJson(res, 400, { error: 'Embeddings are disabled' });
        return true;
      }
      const embedder = await getEmbedder(brain);
      const pages = await loadAllPagesWithBodies();
      const embedTimeoutMs = Math.max(
        Number(emb.queryTimeoutMs) || 0,
        EMBEDDINGS_WARMUP_TIMEOUT_MS,
      );
      const result = await reindexAllMemoryEntries(
        async (text) => {
          const [vector] = await embedTexts(embedder, [text], embedTimeoutMs);
          return vector;
        },
        pages,
        {
          model: embedder.id,
          backend: emb.backend,
          dim: embedder.dim,
        },
      );
      await clearReindexNeeded();
      sendJson(res, 200, {
        ok: true,
        indexed: result.indexed,
        failed: result.failed,
        durationMs: Date.now() - started,
      });
      return true;
    }

    const expertMemoriesMatch = pathname.match(
      /^\/api\/brain\/experts\/([^/]+)\/memories$/,
    );
    if (expertMemoriesMatch && req.method === 'GET') {
      const expertId = decodeURIComponent(expertMemoriesMatch[1]);
      if (!isValidExpertId(expertId)) {
        sendJson(res, 400, { error: 'Invalid expert id' });
        return true;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const includeBody = url.searchParams.get('includeBody') === '1';
      const pages = scopePagesToExpert(await listPages(), expertId);
      if (!includeBody) {
        sendJson(res, 200, {
          entries: pages.map((meta) => ({ ...pageMetaToEntry(meta), path: meta.path })),
        });
        return true;
      }
      const entries = [];
      for (const meta of pages) {
        try {
          const row = await readPage(meta.path);
          entries.push({
            ...pageMetaToEntry(row.meta),
            path: row.meta.path,
            body: row.body,
          });
        } catch {
          entries.push({
            ...pageMetaToEntry(meta),
            path: meta.path,
            body: '',
          });
        }
      }
      sendJson(res, 200, { entries });
      return true;
    }

    const expertMemoriesClearMatch = pathname.match(
      /^\/api\/brain\/experts\/([^/]+)\/memories\/clear$/,
    );
    if (expertMemoriesClearMatch && req.method === 'POST') {
      const expertId = decodeURIComponent(expertMemoriesClearMatch[1]);
      if (!isValidExpertId(expertId)) {
        sendJson(res, 400, { error: 'Invalid expert id' });
        return true;
      }
      const body = await readJsonBody(req);
      if (body.confirmed !== true) {
        sendJson(res, 400, { error: 'confirmed: true is required' });
        return true;
      }
      const pages = scopePagesToExpert(await listPages(), expertId);
      let removed = 0;
      for (const page of pages) {
        try {
          await deletePage(page.path);
          removed += 1;
        } catch {
          /* ignore per-page failures */
        }
      }
      sendJson(res, 200, { removed });
      return true;
    }

    if (pathname === '/api/brain/backup' && req.method === 'POST') {
      const result = await backupBrain();
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let archivePath = null;
      if (body.archive === true) {
        const backup = await backupBrain();
        archivePath = backup.path;
      }
      const pages = await listPages();
      for (const page of pages) {
        try {
          await deletePage(page.path);
        } catch {
          /* ignore */
        }
      }
      try {
        await clearVectorStore();
      } catch {
        /* ignore */
      }
      sendJson(res, 200, { removed: pages.length, archivePath });
      return true;
    }

    if (pathname === '/api/brain/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.backupId) {
        sendJson(res, 400, { error: 'backupId required' });
        return true;
      }
      const result = await restoreBrain(String(body.backupId));
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    const codeHandled = await handleCodeIndexRequest(req, res, pathname);
    if (codeHandled) return true;

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    if (err instanceof BrainPathError) {
      sendJson(res, 400, { error: err.message });
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = err && typeof err === 'object' && 'statusCode' in err ? err.statusCode : 500;
    sendJson(res, status, { error: message });
    return true;
  }
}

/** Combined handler for brain + legacy synthesis routes on /api/memory. */
export async function handleBrainAndSynthesisRequest(req, res, pathname) {
  if (pathname.startsWith('/api/memory/')) {
    const synthesisHandled = await handleSynthesisRequest(req, res, pathname);
    if (synthesisHandled) return true;
  }
  return handleBrainRequest(req, res, pathname);
}

/** Startup hook: ensure brain wiki layout exists. */
export async function initBrainApi() {
  await ensureBrainStore();
  try {
    const { readAllChatIds, useJsonSessionsStore } = await import(
      '../config/sessions-repo.js'
    );
    /** @type {Set<string>} */
    let ids;
    if (!useJsonSessionsStore()) {
      ids = new Set(
        readAllChatIds()
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      );
    } else {
      const { readResource } = await import('../config/store.js');
      const sessions = await readResource('sessions');
      ids = new Set(
        (Array.isArray(sessions?.chats) ? sessions.chats : [])
          .map((c) => String(c?.id ?? '').trim())
          .filter(Boolean),
      );
    }
    if (ids.size > 0) {
      void reconcileOrphanArchives(ids);
    }
  } catch {
    /* sessions unavailable yet */
  }
  const { warmRecentWorkspaceCodeIndexes } = await import('./code/workspace-cache.js');
  void warmRecentWorkspaceCodeIndexes();
}
