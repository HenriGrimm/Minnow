/**
 * Workspace file preview routes for the in-app browser panel.
 * GET /api/preview/ping — health
 * GET /api/preview/file/* — stream a workspace file with safe path resolution
 */

import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { runWithToolContext } from '../runtime/path-access.js';
import { contentTypeForPreviewPath } from './mime-types.js';
import {
  isDocumentHtmlPreviewPath,
  renderDocumentPreviewHtml,
} from './document-html.js';

const PREVIEW_FILE_PREFIX = '/api/preview/file/';
const PREVIEW_DOCUMENT_HTML_PREFIX = '/api/preview/document-html/';

/** Heavy trees — block early so HTML cannot fan out thousands of preview requests. */
const BLOCKED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.minnow',
  '.vite',
]);

/** Cap concurrent preview streams (cloud browsers exhaust sockets easily). */
const MAX_CONCURRENT_PREVIEW_STREAMS = 24;
let activePreviewStreams = 0;

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isBlockedPreviewPath(relativePath) {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  return parts.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment));
}

/**
 * Ensure relative asset URLs resolve under /api/preview/file/… (not Vite SPA routes).
 * @param {string} html
 * @param {string} relativePath workspace-relative file path
 * @param {string} origin e.g. http://localhost:5173
 */
function injectPreviewBaseHref(html, relativePath, origin, filePrefix = PREVIEW_FILE_PREFIX) {
  if (/<base\s/i.test(html)) return html;
  const dir = relativePath.replace(/\\/g, '/').replace(/[^/]+$/, '');
  const encodedDir = dir
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const basePath = encodedDir
    ? `${filePrefix}${encodedDir}/`
    : filePrefix;
  const baseTag = `<base href="${origin}${basePath}">`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], `${headMatch[0]}${baseTag}`);
  }
  return `${baseTag}${html}`;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Missing files are 404; allowlist / path errors stay 400. */
function previewCatchStatus(err) {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
    return 404;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('ENOENT')) return 404;
  return 400;
}

/**
 * Decode the path segment after /api/preview/file/ (may contain slashes).
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePreviewRelativePath(pathname) {
  if (!pathname.startsWith(PREVIEW_FILE_PREFIX)) return null;
  const encoded = pathname.slice(PREVIEW_FILE_PREFIX.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * Decode the path segment after /api/preview/document-html/ (may contain slashes).
 * @param {string} pathname
 * @returns {string | null}
 */
function decodeDocumentHtmlRelativePath(pathname) {
  if (!pathname.startsWith(PREVIEW_DOCUMENT_HTML_PREFIX)) return null;
  const encoded = pathname.slice(PREVIEW_DOCUMENT_HTML_PREFIX.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * Editor loads pass ?raw=1 so we never inject a base href (that would dirty saves).
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {URLSearchParams} [searchParams]
 * @param {{ resolveSafePath: (userPath: string) => string, runWithPathAccess: <T>(fn: () => Promise<T>) => Promise<T>, isolated?: boolean, baseFilePrefix?: string }} deps
 * @returns {Promise<boolean>}
 */
export async function handlePreviewRequest(req, res, pathname, searchParams, deps) {

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (req.method !== 'GET') {
    if (pathname.startsWith('/api/preview')) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    return false;
  }

  if (pathname === '/api/preview/ping') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  const documentHtmlPath = decodeDocumentHtmlRelativePath(pathname);
  if (documentHtmlPath !== null) {
    if (isBlockedPreviewPath(documentHtmlPath)) {
      sendJson(res, 403, {
        error:
          'Preview blocked for dependency/build paths (node_modules, dist, .git, .vite, .minnow).',
      });
      return true;
    }
    if (!isDocumentHtmlPreviewPath(documentHtmlPath)) {
      sendJson(res, 400, {
        error: 'document-html preview supports spreadsheet and Word document paths only',
      });
      return true;
    }

    const workspaceRootParam = searchParams?.get('workspaceRoot')?.trim() || undefined;
    let workspaceRoot;
    if (workspaceRootParam) {
      try {
        workspaceRoot = await validateAllowedWorkspaceRoot(workspaceRootParam);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { error: message });
        return true;
      }
    }

    try {
      const absPath = workspaceRoot
        ? await runWithToolContext(async () => deps.resolveSafePath(documentHtmlPath), {
            workspaceRoot,
          })
        : await deps.runWithPathAccess(async () => deps.resolveSafePath(documentHtmlPath));
      const buffer = await fsp.readFile(absPath);
      const html = await renderDocumentPreviewHtml(absPath, buffer);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(html);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, previewCatchStatus(err), { error: message });
      return true;
    }
  }

  const relativePath = decodePreviewRelativePath(pathname);
  if (relativePath === null) {
    if (pathname.startsWith('/api/preview')) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    return false;
  }

  if (isBlockedPreviewPath(relativePath)) {
    sendJson(res, 403, {
      error:
        'Preview blocked for dependency/build paths (node_modules, dist, .git, .vite, .minnow).',
    });
    return true;
  }

  if (activePreviewStreams >= MAX_CONCURRENT_PREVIEW_STREAMS) {
    sendJson(res, 503, { error: 'Too many preview requests; try again shortly.' });
    return true;
  }

  const workspaceRootParam = searchParams?.get('workspaceRoot')?.trim() || undefined;
  let workspaceRoot;
  if (workspaceRootParam) {
    try {
      workspaceRoot = await validateAllowedWorkspaceRoot(workspaceRootParam);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { error: message });
      return true;
    }
  }

  try {
    const absPath = workspaceRoot
      ? await runWithToolContext(async () => deps.resolveSafePath(relativePath), {
          workspaceRoot,
        })
      : await deps.runWithPathAccess(async () => deps.resolveSafePath(relativePath));
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: 'Not a file' });
      return true;
    }

    const contentType = contentTypeForPreviewPath(absPath);
    const isHtml = contentType.startsWith('text/html') && /\.html?$/i.test(relativePath);
    const wantRaw =
      searchParams?.get('raw') === '1' || searchParams?.get('raw') === 'true';

    if (isHtml) {
      let html = await fsp.readFile(absPath, 'utf8');
      if (!wantRaw) {
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        html = injectPreviewBaseHref(html, relativePath, origin, deps.baseFilePrefix);
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!deps.isolated) {
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.setHeader('Content-Disposition', 'attachment');
      }
      res.end(html);
      return true;
    }

    activePreviewStreams += 1;
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!deps.isolated) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      if (contentType.startsWith('image/svg+xml')) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    }
    const stream = createReadStream(absPath);
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activePreviewStreams = Math.max(0, activePreviewStreams - 1);
    };
    res.on('close', releaseSlot);
    res.on('finish', releaseSlot);
    stream.on('error', () => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Failed to read file' });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, previewCatchStatus(err), { error: message });
    return true;
  }
}

/**
 * @param {{ resolveSafePath: (userPath: string) => string, runWithPathAccess: <T>(fn: () => Promise<T>) => Promise<T> }} deps
 */
export function createPreviewMiddleware(deps) {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    if (!parsed.pathname.startsWith('/api/preview')) {
      next();
      return;
    }
    const handled = await handlePreviewRequest(req, res, parsed.pathname, parsed.searchParams, deps);
    if (!handled) next();
  };
}
