/**
 * HTTP handlers for /api/brain/code/* (code index status, reindex, queries).
 */

import {
  callsOf,
  explainSymbol,
  findSymbol,
  loadBrainCodeConfig,
  queryCodeStatus,
  readSymbol,
  ensureWarmCodeIndex,
  repoMap,
  resolveRepoKey,
  whoCalls,
} from './query.js';
import { saveBrainConfig } from '../store.js';
import { clearCodeIndex } from './schema.js';
import {
  getGitHookStatus,
  installGitHook,
  runCascade,
  startReindexJob,
  uninstallGitHook,
} from './cascade.js';
import { runWithToolContext } from '../../runtime/path-access.js';
import { validateAllowedWorkspaceRoot } from '../../chats-workspace/paths.js';
import { brainWorkspaceKeyFromPath } from '../paths.js';

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

/** Optional workspace root from query string or JSON body (matches tool workspace overrides). */
function workspaceRootParam(url, body) {
  const raw = body?.workspaceRoot ?? url.searchParams.get('workspaceRoot') ?? '';
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || null;
}

/**
 * Run a code-index handler under an optional validated workspace root override.
 * @template T
 * @param {import('node:http').IncomingMessage} req
 * @param {Record<string, unknown>} body
 * @param {() => Promise<T>} fn
 */
async function withCodeWorkspace(req, body, fn) {
  const url = new URL(req.url ?? '', 'http://localhost');
  const rootParam = workspaceRootParam(url, body);
  if (!rootParam) {
    return fn();
  }
  const resolved = await validateAllowedWorkspaceRoot(rootParam);
  return runWithToolContext(fn, { workspaceRoot: resolved });
}

/**
 * Handle /api/brain/code/* requests.
 * @returns {Promise<boolean>} true when handled
 */
export async function handleCodeIndexRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/brain/code')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    const code = await loadBrainCodeConfig();
    if (!code.enabled && pathname !== '/api/brain/code/status') {
      sendJson(res, 400, { error: 'Brain code index is disabled in config.brain.code' });
      return true;
    }

    if (pathname === '/api/brain/code/status' && req.method === 'GET') {
      const payload = await withCodeWorkspace(req, {}, () => queryCodeStatus());
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/brain/code/config' && req.method === 'GET') {
      const code = await loadBrainCodeConfig();
      sendJson(res, 200, { code });
      return true;
    }

    if (pathname === '/api/brain/code/config' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const brain = await saveBrainConfig({ code: body });
      sendJson(res, 200, { code: brain.code });
      return true;
    }

    if (pathname === '/api/brain/code/reindex' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const files = Array.isArray(body.files)
        ? body.files.map((f) => String(f))
        : undefined;
      const result = await withCodeWorkspace(req, body, async () =>
        startReindexJob({
          trigger: 'manual',
          files,
          codeConfig: code,
          force: true,
        }),
      );
      sendJson(res, 202, { ok: true, ...result });
      return true;
    }

    if (pathname === '/api/brain/code/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirmed !== true) {
        sendJson(res, 400, { error: 'confirmed: true is required' });
        return true;
      }
      const result = clearCodeIndex({
        workspaceKey:
          body.workspaceKey !== undefined
            ? String(body.workspaceKey)
            : body.workspaceRoot
              ? brainWorkspaceKeyFromPath(String(body.workspaceRoot))
              : undefined,
        all: body.all === true,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/brain/code/cascade' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const files = Array.isArray(body.files)
        ? body.files.map((f) => String(f))
        : undefined;
      const trigger =
        body.trigger === 'git-hook' ||
        body.trigger === 'workspace-switch' ||
        body.trigger === 'lazy-query'
          ? body.trigger
          : 'manual';
      const result = await withCodeWorkspace(req, body, () =>
        runCascade({
          trigger,
          files,
          codeConfig: code,
          force: body.force === true,
        }),
      );
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (pathname === '/api/brain/code/git-hook/status' && req.method === 'GET') {
      sendJson(res, 200, await getGitHookStatus());
      return true;
    }

    if (pathname === '/api/brain/code/git-hook/install' && req.method === 'POST') {
      const result = await installGitHook();
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (pathname === '/api/brain/code/git-hook/uninstall' && req.method === 'POST') {
      const result = await uninstallGitHook();
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (pathname === '/api/brain/code/find-symbol' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const url = new URL(req.url ?? '', 'http://localhost');
      const query = url.searchParams.get('query') ?? body.query ?? '';
      const limit = Number(url.searchParams.get('limit') ?? body.limit ?? 20);
      const payload = await withCodeWorkspace(req, body, () =>
        findSymbol(String(query), limit),
      );
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/brain/code/repo-map' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const url = new URL(req.url ?? '', 'http://localhost');
      const rawFocus = url.searchParams.get('focus') ?? body.focus ?? undefined;
      const focus = Array.isArray(rawFocus)
        ? rawFocus.map(String).filter(Boolean)
        : rawFocus
          ? String(rawFocus)
          : undefined;
      const tokenBudget = Number(
        url.searchParams.get('tokenBudget') ?? body.tokenBudget ?? body.token_budget ?? 0,
      );
      const repoParam = body.repo ?? url.searchParams.get('repo') ?? undefined;
      const repo = resolveRepoKey(repoParam);
      const ensureIndexed =
        body.ensureIndexed === true ||
        url.searchParams.get('ensureIndexed') === 'true' ||
        url.searchParams.get('ensureIndexed') === '1';
      const map = await withCodeWorkspace(req, body, async () => {
        if (ensureIndexed) {
          await ensureWarmCodeIndex(repo);
        }
        const profile =
          body.profile === 'injection' || url.searchParams.get('profile') === 'injection'
            ? 'injection'
            : 'default';
        return repoMap({
          repo,
          focus,
          tokenBudget: tokenBudget > 0 ? tokenBudget : undefined,
          profile,
          skipStalenessCheck: ensureIndexed,
        });
      });
      sendJson(res, 200, map);
      return true;
    }

    if (pathname === '/api/brain/code/who-calls' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const url = new URL(req.url ?? '', 'http://localhost');
      const symbol = url.searchParams.get('symbol') ?? body.symbol ?? '';
      const payload = await withCodeWorkspace(req, body, () => whoCalls(String(symbol)));
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/brain/code/calls-of' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const url = new URL(req.url ?? '', 'http://localhost');
      const symbol = url.searchParams.get('symbol') ?? body.symbol ?? '';
      const payload = await withCodeWorkspace(req, body, () => callsOf(String(symbol)));
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/brain/code/read-symbol' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const url = new URL(req.url ?? '', 'http://localhost');
      const symbol = url.searchParams.get('symbol') ?? body.symbol ?? '';
      const payload = await withCodeWorkspace(req, body, () => readSymbol(String(symbol)));
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/brain/code/explain' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const url = new URL(req.url ?? '', 'http://localhost');
      const symbol = url.searchParams.get('symbol') ?? body.symbol ?? '';
      const payload = await withCodeWorkspace(req, body, () => explainSymbol(String(symbol)));
      sendJson(res, 200, payload);
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
        ? err.statusCode
        : 500;
    sendJson(res, status, { error: message });
    return true;
  }
}
