/**
 * HTTP handlers for /api/brain/* (scoped memories, embeddings, and code indexing).
 */

import { getMinnowHome } from '../config/home.js';
import { getEmbedder, embedTexts, EMBEDDINGS_WARMUP_TIMEOUT_MS } from '../engine/embeddings.js';
import { BrainPathError, getBrainDir } from './paths.js';
import { readBrainUsage } from './usage.js';
import { loadAllPagesWithBodies } from './retrieve.js';
import { handleCodeIndexRequest } from './code/routes.js';
import { handleSynthesisRequest } from './synthesis-routes.js';
import { clearReindexNeeded } from './vector-sync.js';
import { createVectorStore } from '../engine/vector-store.js';
import { getEnginePaths } from './engine-paths.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { isValidPageId } from './paths.js';
import { memoryScopeOfPath, resolveMemoryProject } from './memory/scope.js';
import {
  MEMORY_KINDS,
  MEMORY_LIMITS,
  MemoryError,
  createMemory,
  forgetMemory,
  loadMemoryEntries,
  updateMemory,
} from './memory/store.js';
import { getRequestWorkspaceRoot } from '../runtime/path-access.js';
import {
  listPages,
  loadBrainConfig,
  saveBrainConfig,
} from './store.js';

const vectorStore = createVectorStore(getEnginePaths, { isValidEntryId: isValidPageId });
const {
  getVectorCount,
  loadVectorStore,
  isVectorStoreCompatible,
  reindexAllMemoryEntries,
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

/** Memory project for a request: explicit workspaceRoot, else the requesting view's workspace. */
async function requestMemoryProject(workspaceRoot) {
  const root = workspaceRoot
    ? await validateAllowedWorkspaceRoot(workspaceRoot)
    : getRequestWorkspaceRoot();
  return root ? resolveMemoryProject(root).catch(() => null) : null;
}

function memoryErrorStatus(error) {
  if (error.code === 'not_found') return 404;
  if (error.code === 'stale' || error.code === 'duplicate') return 409;
  return 400;
}

function memoryRecord(entry) {
  return {
    id: entry.meta.id,
    title: entry.meta.title,
    kind: entry.meta.kind ?? 'reference',
    scope: entry.meta.scope,
    body: entry.body,
    evidence: entry.meta.evidence ?? '',
    supersedes: entry.meta.supersedes ?? [],
    source: entry.meta.source,
    sourceChatId: entry.meta.sourceChatId ?? null,
    createdAt: entry.meta.createdAt,
    updatedAt: entry.meta.updatedAt,
    revision: entry.revision,
  };
}

/** /api/brain/memories — the memories agents can see for one project, plus user memories. */
async function handleMemoryRequest(req, res, pathname) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (pathname === '/api/brain/memories' && req.method === 'GET') {
    const project = await requestMemoryProject(url.searchParams.get('workspaceRoot'));
    const entries = await loadMemoryEntries(project);
    entries.sort((a, b) => String(b.meta.updatedAt).localeCompare(String(a.meta.updatedAt)));
    sendJson(res, 200, {
      project: project ? { key: project.key, label: project.label } : null,
      kinds: MEMORY_KINDS,
      limits: MEMORY_LIMITS,
      memories: entries.map(memoryRecord),
    });
    return true;
  }
  if (pathname === '/api/brain/memories' && req.method === 'POST') {
    // Memories you add yourself go through the same caps, duplicate and secret checks as agent saves.
    try {
      const body = await readJsonBody(req);
      const project = await requestMemoryProject(body.workspaceRoot);
      const scope = body.scope === 'user' ? 'user' : 'project';
      if (scope === 'project' && !project) {
        sendJson(res, 400, { error: 'Open a project to add a project memory.', code: 'no_project' });
        return true;
      }
      const created = await createMemory({
        project, scope, title: body.title, body: body.body, kind: body.kind, evidence: body.evidence, source: 'user',
      });
      sendJson(res, 201, memoryRecord({ meta: { ...created.meta, scope: created.scope }, body: created.body, revision: created.revision }));
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      sendJson(res, memoryErrorStatus(error), { error: error.message, code: error.code, conflictId: error.conflictId });
    }
    return true;
  }
  const match = pathname.match(/^\/api\/brain\/memories\/([^/]+)$/);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  try {
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const project = await requestMemoryProject(body.workspaceRoot);
      const updated = await updateMemory({
        project, id, expectedRevision: body.expectedRevision,
        title: body.title, body: body.body, kind: body.kind, evidence: body.evidence, source: 'user',
      });
      sendJson(res, 200, memoryRecord({ meta: { ...updated.meta, scope: updated.scope }, body: updated.body, revision: updated.revision }));
      return true;
    }
    if (req.method === 'DELETE') {
      const project = await requestMemoryProject(url.searchParams.get('workspaceRoot'));
      const expected = url.searchParams.get('expectedRevision') ?? undefined;
      sendJson(res, 200, { ok: true, ...(await forgetMemory({ project, id, expectedRevision: expected })) });
      return true;
    }
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    sendJson(res, memoryErrorStatus(error), { error: error.message, code: error.code });
    return true;
  }
  return false;
}

/**
 * Handle /api/brain requests. Returns true if handled.
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

    if (pathname.startsWith('/api/brain/memories') && await handleMemoryRequest(req, res, pathname)) return true;

    if (pathname === '/api/brain/usage' && req.method === 'GET') {
      sendJson(res, 200, await readBrainUsage());
      return true;
    }

    if (pathname === '/api/brain/embeddings/status' && req.method === 'GET') {
      const brain = await loadBrainConfig();
      const emb = brain.embeddings ?? {};
      const vectorCount = await getVectorCount();
      const store = await loadVectorStore();
      const pageCount = (await listPages()).filter(page => memoryScopeOfPath(page.path)).length;
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
      const pages = await loadAllPagesWithBodies((await listPages()).filter(page => memoryScopeOfPath(page.path)));
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

/** Warm cached code indexes on startup. */
export async function initBrainApi() {
  const { warmRecentWorkspaceCodeIndexes } = await import('./code/workspace-cache.js');
  void warmRecentWorkspaceCodeIndexes();
}
