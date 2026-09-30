import crypto from 'node:crypto';
import http from 'node:http';
import { getNetworkAccess } from '../network/access.js';
import { getEffectiveWorkspaceRoot, resolveSafePath } from '../runtime/path-access.js';
import { runWithToolContext } from '../runtime/path-access.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';
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
  if (decodedPath.split('/').some((segment) => segment.startsWith('.'))) return reject(res);
  url.searchParams.delete('workspaceRoot');
  await runWithToolContext(
    () => handlePreviewRequest(req, res, pathname, url.searchParams, {
      resolveSafePath: (userPath) => {
        const resolved = resolveSafePath(userPath);
        if (!isResolvedPathUnderRoot(resolved, grant.workspaceRoot)) {
          throw new Error('Preview path is outside its workspace');
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

/** Start a route-limited origin before the main application starts serving HTML. */
export async function startIsolatedPreviewHost() {
  if (previewServer) return;
  const server = http.createServer((req, res) => {
    void servePreview(req, res).catch(() => reject(res, 500));
  });
  const host = getNetworkAccess() === 'lan' ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, host, resolve);
  });
  previewPort = server.address().port;
  previewServer = server;
}

export async function stopIsolatedPreviewHost() {
  const server = previewServer;
  previewServer = null;
  previewPort = 0;
  capabilities.clear();
  if (server) await new Promise((resolve) => server.close(resolve));
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
