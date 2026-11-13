/**
 * HTTP handlers for /api/memory/* (Vite configureServer middleware).
 * Thin adapter delegating to the brain wiki store (MIN-B3).
 * TRACKING: remove when UI and tools migrate to /api/brain (MIN-B4+).
 */

import {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  clearEntries,
  loadMemoryConfig,
  saveMemoryConfig,
  getEntryCount,
  loadAllEntriesWithBodies,
  ensureMemoryStore,
} from './store.js';
import { retrieveMemoryBlockHybrid } from './retrieve.js';
import { loadAllPagesWithBodies } from '../brain/retrieve.js';
import { listPages } from '../brain/store.js';
import { backupMemory, restoreMemory } from './backup.js';
import { isValidEntryId } from './paths.js';
import { getMinnowHome } from '../config/home.js';
import { getEmbedder, embedTexts, EMBEDDINGS_WARMUP_TIMEOUT_MS } from './embeddings.js';
import {
  getVectorCount,
  loadVectorStore,
  isVectorStoreCompatible,
  reindexAllMemoryEntries,
} from './vector-store.js';
import { clearReindexNeeded } from './vector-sync.js';
import { handleSynthesisRequest } from '../brain/synthesis-routes.js';

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

/**
 * Handle /api/memory requests. Returns true if handled.
 */
export async function handleMemoryRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/memory')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    const synthesisHandled = await handleSynthesisRequest(req, res, pathname);
    if (synthesisHandled) {
      return true;
    }

    if (pathname === '/api/memory/ping' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/memory/status' && req.method === 'GET') {
      const memory = await loadMemoryConfig();
      const entryCount = await getEntryCount();
      sendJson(res, 200, {
        enabled: memory.enabled !== false,
        entryCount,
        home: getMinnowHome(),
      });
      return true;
    }

    if (pathname === '/api/memory/entries' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.searchParams.get('includeBody') === '1') {
        const rows = await loadAllEntriesWithBodies();
        const entries = rows.map(({ meta, body }) => ({ ...meta, body }));
        sendJson(res, 200, { entries });
        return true;
      }
      const entries = await listEntries();
      sendJson(res, 200, { entries });
      return true;
    }

    const entryMatch = pathname.match(/^\/api\/memory\/entries\/([^/]+)$/);
    if (entryMatch) {
      const id = decodeURIComponent(entryMatch[1]);
      if (!isValidEntryId(id)) {
        sendJson(res, 400, { error: 'Invalid entry id' });
        return true;
      }

      if (req.method === 'GET') {
        const row = await getEntry(id);
        if (!row) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, row);
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const entry = await updateEntry(id, body);
        if (!entry) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, { entry });
        return true;
      }

      if (req.method === 'DELETE') {
        const ok = await deleteEntry(id);
        if (!ok) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    if (pathname === '/api/memory/entries' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const entry = await createEntry(body);
      sendJson(res, 201, { entry });
      return true;
    }

    if (pathname === '/api/memory/retrieve' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const memory = await loadMemoryConfig();
      if (memory.enabled === false) {
        sendJson(res, 200, { block: '', ids: [] });
        return true;
      }
      const maxChars = memory.maxInjectCharsFull ?? 8000;
      const all = await loadAllEntriesWithBodies();
      const { block, ids } = await retrieveMemoryBlockHybrid(all, {
        query: body.query,
        limit: body.limit ?? 12,
        tags: body.tags,
        maxChars,
      }, memory);
      sendJson(res, 200, { block, ids });
      return true;
    }

    if (pathname === '/api/memory/embeddings/status' && req.method === 'GET') {
      const memory = await loadMemoryConfig();
      const emb = memory.embeddings ?? {};
      const vectorCount = await getVectorCount();
      const store = await loadVectorStore();
      const pageCount = (await listPages()).length;
      let healthy = false;
      if (emb.enabled) {
        try {
          const embedder = await getEmbedder(memory);
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

    if (pathname === '/api/memory/embeddings/warmup' && req.method === 'POST') {
      const started = Date.now();
      const memory = await loadMemoryConfig();
      const emb = memory.embeddings ?? {};
      const backend = emb.backend === 'provider' ? 'provider' : 'local';
      const modelId = String(emb.modelId ?? '').trim();

      if (backend === 'provider') {
        if (!emb.enabled) {
          sendJson(res, 400, { error: 'Enable semantic embeddings before probing a provider backend.' });
          return true;
        }
        if (!String(emb.providerId ?? '').trim()) {
          sendJson(res, 400, { error: 'Select a provider when using provider embeddings.' });
          return true;
        }
      } else if (!modelId) {
        sendJson(res, 400, { error: 'Model id is required to download a local embedding model.' });
        return true;
      }

      const embedder = await getEmbedder(memory);
      const warmupTimeoutMs = Math.max(
        Number(emb.queryTimeoutMs) || 0,
        EMBEDDINGS_WARMUP_TIMEOUT_MS,
      );
      const [vector] = await embedTexts(embedder, ['warmup'], warmupTimeoutMs);
      if (!Array.isArray(vector) || vector.length === 0) {
        sendJson(res, 500, { error: 'Warmup produced empty embedding' });
        return true;
      }

      sendJson(res, 200, {
        ok: true,
        model: embedder.id,
        backend: embedder.backend,
        dim: vector.length,
        durationMs: Date.now() - started,
      });
      return true;
    }

    if (pathname === '/api/memory/embeddings/reindex' && req.method === 'POST') {
      const started = Date.now();
      const memory = await loadMemoryConfig();
      const emb = memory.embeddings ?? {};
      if (!emb.enabled) {
        sendJson(res, 400, { error: 'Embeddings are disabled' });
        return true;
      }

      const embedder = await getEmbedder(memory);
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

    if (pathname === '/api/memory/embeddings/config' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const memory = await saveMemoryConfig({
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
      sendJson(res, 200, { embeddings: memory.embeddings });
      return true;
    }

    if (pathname === '/api/memory/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await clearEntries(body.archive === true);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/memory/backup' && req.method === 'POST') {
      const result = await backupMemory();
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/memory/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.backupId) {
        sendJson(res, 400, { error: 'backupId required' });
        return true;
      }
      const result = await restoreMemory(String(body.backupId));
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err.statusCode ?? 500;
    sendJson(res, status, { error: message });
    return true;
  }
}

/** Startup hook: ensure memory adapter + brain store layout exists. */
export async function initMemoryApi() {
  await ensureMemoryStore();
}
