/**
 * HTTP middleware for /api/agent-packs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCachedAgentPackList,
  refreshAgentPackCache,
  setPackEnabled,
} from './registry.js';
import { assertValidPackId } from './paths.js';
import { buildAgentPackTemplateZip } from './template.js';
import {
  BUILTIN_AGENT_PACK_ZIP_FILENAME,
  buildBuiltinAgentPackZip,
} from './builtin-pack.js';
import {
  AGENT_PACK_ZIP_MAX_BYTES,
  installAgentPackFromZip,
} from './install.js';
import { parseMultipartFile } from '../stt/multipart.js';
import { builtinWorkAgentsDir } from '../work-agents/paths.js';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

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

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function loadBuiltinAgentIdSet() {
  const ids = new Set();
  const baseDir = builtinWorkAgentsDir(PROJECT_ROOT);
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const ent of entries) {
    if (ent.isDirectory() && !ent.name.startsWith('_')) {
      ids.add(ent.name);
    }
  }
  try {
    const indexPath = path.join(baseDir, 'registry.json');
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.ids)) {
      for (const id of parsed.ids) ids.add(String(id));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

function packListResponse(packs) {
  return packs.map((p) => ({
    id: p.id,
    label: p.label,
    version: p.version,
    description: p.description,
    enabled: p.enabled,
    valid: p.valid,
    errors: p.errors,
    agents: p.agents,
    packRoot: p.packRoot,
  }));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleAgentPacksRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/agent-packs')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    const builtinIds = await loadBuiltinAgentIdSet();

    if (pathname === '/api/agent-packs/ping' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/agent-packs/template' && req.method === 'GET') {
      const zip = buildAgentPackTemplateZip();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="minnow-agent-pack-template.zip"');
      res.setHeader('Content-Length', String(zip.length));
      res.end(zip);
      return true;
    }

    if (pathname === '/api/agent-packs/builtin' && req.method === 'GET') {
      const zip = await buildBuiltinAgentPackZip(PROJECT_ROOT);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${BUILTIN_AGENT_PACK_ZIP_FILENAME}"`,
      );
      res.setHeader('Content-Length', String(zip.length));
      res.end(zip);
      return true;
    }

    if (pathname === '/api/agent-packs/upload' && req.method === 'POST') {
      const file = await parseMultipartFile(req, AGENT_PACK_ZIP_MAX_BYTES);
      const filename = String(file.filename || '').toLowerCase();
      if (!filename.endsWith('.zip')) {
        sendJson(res, 400, { error: 'Upload must be a .zip file' });
        return true;
      }
      const installed = await installAgentPackFromZip(file.buffer, builtinIds);
      await refreshAgentPackCache(PROJECT_ROOT, builtinIds);
      const pack = getCachedAgentPackList().find((p) => p.id === installed.packId);
      if (!pack) {
        sendJson(res, 500, { error: 'Pack installed but could not be scanned' });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        packId: installed.packId,
        filesWritten: installed.filesWritten,
        packRoot: installed.packRoot,
        pack: packListResponse([pack])[0],
      });
      return true;
    }

    if (pathname === '/api/agent-packs' && req.method === 'GET') {
      const packs = await refreshAgentPackCache(PROJECT_ROOT, builtinIds);
      sendJson(res, 200, { packs: packListResponse(packs) });
      return true;
    }

    const packMatch = pathname.match(/^\/api\/agent-packs\/([a-z][a-z0-9-]{0,63})$/);
    if (packMatch && req.method === 'GET') {
      const packId = packMatch[1];
      await refreshAgentPackCache(PROJECT_ROOT, builtinIds);
      const pack = getCachedAgentPackList().find((p) => p.id === packId);
      if (!pack) {
        sendJson(res, 404, { error: 'Agent pack not found' });
        return true;
      }
      sendJson(res, 200, { pack: packListResponse([pack])[0] });
      return true;
    }

    if (packMatch && req.method === 'PATCH') {
      const packId = packMatch[1];
      assertValidPackId(packId);
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled boolean required' });
        return true;
      }
      await setPackEnabled(packId, body.enabled);
      await refreshAgentPackCache(PROJECT_ROOT, builtinIds);
      const pack = getCachedAgentPackList().find((p) => p.id === packId);
      if (!pack) {
        sendJson(res, 404, { error: 'Agent pack not found' });
        return true;
      }
      sendJson(res, 200, { pack: packListResponse([pack])[0] });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Invalid') ? 400 : 500;
    sendJson(res, status, { error: message });
    return true;
  }
}

/**
 * Vite connect middleware factory.
 */
export function createAgentPacksMiddleware() {
  return async (req, res, next) => {
    const url = req.url ?? '';
    const q = url.indexOf('?');
    const pathname = q >= 0 ? url.slice(0, q) : url;

    const handled = await handleAgentPacksRequest(req, res, pathname);
    if (handled) return;
    next();
  };
}
