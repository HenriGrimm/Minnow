/**
 * Serves SPA navigations with the host token only to loopback requests.
 * LAN companions receive the same shell without the privileged credential.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isHostAllowed, isLoopbackClient } from '../network/access.js';
import { getSessionToken, injectSessionTokenScript } from './session-token.js';
import { getMinnowHome } from '../config/home.js';
import {
  appearanceBootPayload,
  appearanceLooksPersisted,
  injectAppearanceBootScript,
  normalizeAppearanceConfig,
} from '../config/appearance.js';

/** Vite dev-only paths have no file extension but must not receive the SPA shell. */
function isViteDevInternalPath(pathname) {
  return (
    pathname.startsWith('/@vite/') ||
    pathname.startsWith('/@fs/') ||
    pathname.startsWith('/@id/')
  );
}

/** Paths that must never be replaced with the SPA shell. */
function isNonSpaAssetPath(pathname) {
  return pathname.startsWith('/api/') || isViteDevInternalPath(pathname);
}

/** Whether a GET/HEAD request should receive the SPA navigation shell. */
export function isHtmlNavigationRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (isNonSpaAssetPath(pathname)) return false;
  const accept = req.headers.accept ?? '';
  if (accept.includes('text/html')) return true;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

/** Inject the host credential only for a loopback peer using a loopback Host. */
export function addRequestAuthToHtml(html, req) {
  if (!isLoopbackClient(req) || !isHostAllowed(req.headers.host ?? '', 'local')) return html;
  return injectSessionTokenScript(html, getSessionToken());
}

/** Read persisted appearance for FOUC seeding. Missing/unpersisted files skip inject. */
async function readAppearanceBootPayload() {
  try {
    const raw = await fs.readFile(path.join(getMinnowHome(), 'appearance.json'), 'utf8');
    const state = normalizeAppearanceConfig(JSON.parse(raw));
    if (!appearanceLooksPersisted(state)) return null;
    return appearanceBootPayload(state);
  } catch {
    return null;
  }
}

/**
 * Build a navigation middleware shared by Vite and packaged Electron.
 * Vite supplies transformHtml so its normal HTML plugins still run.
 */
export function createSpaAuthHtmlMiddleware({ indexPath, transformHtml = async (_url, html) => html }) {
  return async function spaAuthHtmlMiddleware(req, res, next) {
    if (!isHtmlNavigationRequest(req)) {
      next();
      return;
    }

    try {
      const source = await fs.readFile(indexPath, 'utf8');
      const transformed = await transformHtml(req.originalUrl ?? req.url ?? '/', source);
      const boot = await readAppearanceBootPayload();
      const withAppearance = injectAppearanceBootScript(transformed, boot);
      const html = addRequestAuthToHtml(withAppearance, req);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch (error) {
      next(error);
    }
  };
}

