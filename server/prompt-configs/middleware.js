/**
 * HTTP middleware for /api/prompt-configs and /api/prompts/registry
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deletePromptConfigFile,
  duplicatePromptConfigFile,
  listPromptConfigs,
  loadPromptConfigFile,
  savePromptConfigFile,
} from './handlers.js';
import { buildPromptRegistry } from '../prompts/registry.js';
import {
  deleteExpertEntityDir,
  deletePromptFileOverride,
  readBuiltinPromptFile,
  readPromptFile,
  writePromptFileOverride,
} from '../prompts/file-overrides.js';

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

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} [search]
 * @returns {Promise<boolean>}
 */
export async function handlePromptRequest(req, res, pathname, search = '') {
  if (!pathname.startsWith('/api/prompt')) {
    return false;
  }

  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const profileParam = params.get('profile') === 'lite' ? 'lite' : 'full';
  const baselineBuiltin = params.get('baseline') === 'builtin';
  const rawFile = params.get('raw') === '1' || params.get('raw') === 'true';

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (pathname === '/api/prompts/registry' && req.method === 'GET') {
      const entries = await buildPromptRegistry(PROJECT_ROOT);
      sendJson(res, 200, { prompts: entries });
      return true;
    }

    if (pathname === '/api/prompt-configs' && req.method === 'GET') {
      const configs = await listPromptConfigs();
      sendJson(res, 200, { configs });
      return true;
    }

    const duplicateMatch = pathname.match(
      /^\/api\/prompt-configs\/([a-z0-9][a-z0-9-_]{0,63})\/duplicate$/,
    );
    if (duplicateMatch && req.method === 'POST') {
      const sourceId = duplicateMatch[1];
      const body = await readJsonBody(req);
      const newId = typeof body.newId === 'string' ? body.newId : '';
      const newLabel = typeof body.newLabel === 'string' ? body.newLabel : undefined;
      if (!newId) {
        sendJson(res, 400, { error: 'newId is required' });
        return true;
      }
      const saved = await duplicatePromptConfigFile(sourceId, newId, newLabel);
      sendJson(res, 200, { ok: true, config: saved });
      return true;
    }

    const expertEntityMatch = pathname.match(
      /^\/api\/prompts\/experts\/([a-z][a-z0-9-]{0,63})$/,
    );
    if (expertEntityMatch && req.method === 'DELETE') {
      const entityId = expertEntityMatch[1];
      await deletePromptFileOverride('experts', entityId, 'full').catch(() => false);
      await deletePromptFileOverride('experts', entityId, 'lite').catch(() => false);
      await deleteExpertEntityDir(entityId);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const filePromptMatch = pathname.match(
      /^\/api\/prompts\/(modes|experts|sub-agents|base|tool-usage|info)\/([a-zA-Z][a-zA-Z0-9_-]{0,63})\/prompt$/,
    );
    if (filePromptMatch) {
      const family = filePromptMatch[1];
      const entityId = filePromptMatch[2];

      if (req.method === 'GET') {
        const result = baselineBuiltin
          ? await readBuiltinPromptFile(PROJECT_ROOT, family, entityId, profileParam)
          : await readPromptFile(PROJECT_ROOT, family, entityId, profileParam, {
              raw: rawFile,
            });
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const content = typeof body.content === 'string' ? body.content : '';
        const writeProfile = body.profile === 'lite' ? 'lite' : profileParam;
        await writePromptFileOverride(family, entityId, writeProfile, content);
        const result = await readPromptFile(PROJECT_ROOT, family, entityId, writeProfile);
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'DELETE') {
        const removed = await deletePromptFileOverride(
          family,
          entityId,
          profileParam,
        );
        if (!removed) {
          sendJson(res, 404, { error: 'No override to remove' });
          return true;
        }
        const result = await readPromptFile(PROJECT_ROOT, family, entityId, profileParam);
        sendJson(res, 200, result);
        return true;
      }
    }

    const idMatch = pathname.match(/^\/api\/prompt-configs\/([a-z0-9][a-z0-9-_]{0,63})$/);
    if (idMatch) {
      const id = idMatch[1];

      if (req.method === 'GET') {
        const config = await loadPromptConfigFile(id);
        if (!config) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, config);
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const withId = { ...body, id };
        const saved = await savePromptConfigFile(withId);
        sendJson(res, 200, { ok: true, config: saved });
        return true;
      }

      if (req.method === 'DELETE') {
        try {
          const removed = await deletePromptConfigFile(id);
          if (!removed) {
            sendJson(res, 404, { error: 'Not found' });
            return true;
          }
          sendJson(res, 200, { ok: true });
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: message });
          return true;
        }
      }
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[prompt-configs]', message);
    sendJson(res, 500, { error: message });
    return true;
  }
}

/** Vite middleware hook. */
export function createPromptConfigsMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '';
    const q = rawUrl.indexOf('?');
    const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    const search = q >= 0 ? rawUrl.slice(q) : '';
    if (!pathname.startsWith('/api/prompt')) {
      next();
      return;
    }
    const handled = await handlePromptRequest(req, res, pathname, search);
    if (!handled) next();
  };
}
