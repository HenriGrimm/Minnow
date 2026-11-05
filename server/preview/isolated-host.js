import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { getEffectiveWorkspaceRoot, resolveSafePath } from '../runtime/path-access.js';
import { runWithToolContext } from '../runtime/path-access.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { isResolvedPathUnderRoot, realpathForBoundaryCheck } from '../workspace/safe-path.js';
import { handlePreviewRequest } from './middleware.js';

const CAPABILITY_LIFETIME_MS = 10 * 60 * 1000;
const capabilities = new Map();
let previewServer = null;
let previewPort = 0;

function reject(res, status = 403) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function capabilityFor(token) {
  const grant = capabilities.get(token);
  if (!grant || grant.expiresAt <= Date.now()) return null;
  return { token, ...grant };
}

function isPreviewAsset(pathname) {
  return pathname.startsWith('/api/preview/file/') ||
    pathname.startsWith('/api/preview/document-html/');
}

async function servePreview(req, res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url ?? '/', 'http://preview.invalid');
  if (req.method !== 'GET') return reject(res, 405);
  const match = /^\/p\/([a-f0-9]{64})(\/api\/preview\/.*)$/.exec(url.pathname);
  if (!match) return reject(res, 404);
  const grant = capabilityFor(match[1]);
  if (!grant) return reject(res);
  const pathname = match[2];
  if (!isPreviewAsset(pathname)) return reject(res, 404);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return reject(res, 400);
  }
  if (decodedPath.includes('\\') || decodedPath.split('/').some((segment) => segment.startsWith('.'))) return reject(res);
  url.searchParams.delete('workspaceRoot');
  await runWithToolContext(
    () => handlePreviewRequest(req, res, pathname, url.searchParams, {
      resolveSafePath: (userPath) => {
        const resolved = realpathForBoundaryCheck(resolveSafePath(userPath));
        if (!isResolvedPathUnderRoot(resolved, grant.workspaceRoot)) {
          throw new Error('Preview path is outside its workspace');
        }
        const relative = path.relative(realpathForBoundaryCheck(grant.workspaceRoot), resolved);
        if (relative.split(path.sep).some((segment) => segment.startsWith('.'))) {
          throw Object.assign(new Error('Hidden preview path'), { code: 'EPREVIEWDENIED' });
        }
        return resolved;
      },
      runWithPathAccess: (fn) => fn(),
      isolated: true,
      baseFilePrefix: `/p/${grant.token}/api/preview/file/`,
    }),
    { workspaceRoot: grant.workspaceRoot, allowOutsideWorkspace: false },
  );
}

async function bindPreviewHost(host, port) {
  const server = http.createServer((req, res) => {
    void servePreview(req, res).catch(() => reject(res, 500));
  });
  await new Promise((resolve, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, host, resolve);
  });
  previewPort = server.address().port;
  previewServer = server;
}

async function closePreviewListener() {
  const server = previewServer;
  previewServer = null;
  if (server) await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

let pending = Promise.resolve();
function changePreviewListener(operation) {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

/** Start privately; remote ingress widens the listener only after a successful bind. */
export function startIsolatedPreviewHost() {
  return changePreviewListener(() => previewServer || bindPreviewHost('127.0.0.1', 0));
}

export function setPreviewLanAccess(enabled) {
  return changePreviewListener(async () => {
    const host = enabled ? '0.0.0.0' : '127.0.0.1';
    if (!previewPort || previewServer?.address()?.address === host) return;
    // Existing desktop pages and grants keep their origin through an address change.
    await closePreviewListener();
    try {
      await bindPreviewHost(host, previewPort);
    } catch (error) {
      if (enabled) await bindPreviewHost('127.0.0.1', previewPort);
      throw error;
    }
  });
}

export function stopIsolatedPreviewHost() {
  return changePreviewListener(async () => {
    await closePreviewListener();
    previewPort = 0;
    capabilities.clear();
  });
}

/** Authenticated main-origin endpoint. The returned token only works on the preview origin. */
export function createPreviewAccessMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/preview/access') return next();
    if (req.method !== 'GET') return reject(res, 405);
    if (!previewPort) return reject(res, 503);
    try {
      const workspaceRoot = url.searchParams.get('workspaceRoot')
        ? await validateAllowedWorkspaceRoot(url.searchParams.get('workspaceRoot'))
        : getEffectiveWorkspaceRoot();
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + CAPABILITY_LIFETIME_MS;
      for (const [key, value] of capabilities) {
        if (value.expiresAt <= Date.now()) capabilities.delete(key);
      }
      capabilities.set(token, { workspaceRoot, expiresAt });
      const hostname = new URL(`http://${req.headers.host}`).hostname;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ origin: `http://${hostname}:${previewPort}`, token, expiresAt }));
    } catch {
      reject(res, 400);
    }
  };
}
