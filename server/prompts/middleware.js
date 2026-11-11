/**
 * HTTP middleware for /api/prompts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptRegistry } from './registry.js';
import {
  deleteExpertEntityDir,
  deletePromptFileOverride,
  readBuiltinPromptFile,
  readPromptFile,
  writePromptFileOverride,
} from './file-overrides.js';

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
  if (!pathname.startsWith('/api/prompts/')) {
    return false;
  }

  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
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

    const expertEntityMatch = pathname.match(
      /^\/api\/prompts\/experts\/([a-z][a-z0-9-]{0,63})$/,
    );
    if (expertEntityMatch && req.method === 'DELETE') {
      const entityId = expertEntityMatch[1];
      await deletePromptFileOverride('experts', entityId).catch(() => false);
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
      if (params.has('profile') && params.get('profile') !== 'full') {
        sendJson(res, 400, { error: 'Prompt variants are no longer supported' });
        return true;
      }

      if (req.method === 'GET') {
        const result = baselineBuiltin
          ? await readBuiltinPromptFile(PROJECT_ROOT, family, entityId)
          : await readPromptFile(PROJECT_ROOT, family, entityId, {
              raw: rawFile,
            });
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (body.profile !== undefined && body.profile !== 'full') {
          sendJson(res, 400, { error: 'Prompt variants are no longer supported' });
          return true;
        }
        const content = typeof body.content === 'string' ? body.content : '';
        await writePromptFileOverride(family, entityId, content);
        const result = await readPromptFile(PROJECT_ROOT, family, entityId);
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'DELETE') {
        const removed = await deletePromptFileOverride(
          family,
          entityId,
        );
        if (!removed) {
          sendJson(res, 404, { error: 'No override to remove' });
          return true;
        }
        const result = await readPromptFile(PROJECT_ROOT, family, entityId);
        sendJson(res, 200, result);
        return true;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[prompts]', message);
    sendJson(res, 500, { error: message });
    return true;
  }
}

/** Vite middleware hook. */
export function createPromptsMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '';
    const q = rawUrl.indexOf('?');
    const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    const search = q >= 0 ? rawUrl.slice(q) : '';
    if (!pathname.startsWith('/api/prompts/')) {
      next();
      return;
    }
    const handled = await handlePromptRequest(req, res, pathname, search);
    if (!handled) next();
  };
}
