/**
 * Serves SPA navigations with the host token only to loopback requests.
 * LAN companions receive the same shell without the privileged credential.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isHostAllowed, isLoopbackClient } from '../network/access.js';
import { getRequestIngress, ingressScheme } from '../network/ingress.js';
import { setDeviceCookie } from '../auth/cookie.js';
import { consumeHandoffTicket, getOrCreateInstallTicket } from '../auth/handoff.js';
import { resolveRequestAuth } from './request-auth.js';
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

/**
 * Inject the host credential only on the loopback desktop listener, for a
 * loopback peer using a loopback Host. Remote listeners proxy from 127.0.0.1
 * too, so the peer address alone is never enough.
 */
export function addRequestAuthToHtml(html, req) {
  if (getRequestIngress(req) !== 'loopback') return html;
  if (!isLoopbackClient(req) || !isHostAllowed(req.headers.host ?? '', 'local')) return html;
  return injectSessionTokenScript(html, getSessionToken());
}

const MANIFEST_LINK_RE = /<link rel="manifest" href="[^"]*"([^>]*)>/;

/**
 * Point a signed-in device's manifest at one carrying an install ticket, so
 * Add to Home Screen produces an app that signs itself in — decided on the
 * server, before any script runs.
 */
export function addDeviceManifestToHtml(html, req) {
  if (getRequestIngress(req) === 'loopback') return html;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const auth = resolveRequestAuth(req, url);
  if (!auth.ok || auth.auth.kind !== 'device') return html;
  let ticket;
  try {
    ticket = getOrCreateInstallTicket(auth.auth.deviceId).ticket;
  } catch {
    return html;
  }
  return html.replace(
    MANIFEST_LINK_RE,
    `<link rel="manifest" href="/api/auth/manifest?handoff=${encodeURIComponent(ticket)}"$1>`,
  );
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end();
}

/**
 * Exchange `?handoff=<ticket>` (a Home Screen app's start URL, or a move to
 * another address) for this origin's device cookie. iOS relaunches the start
 * URL every time, so a used ticket with a valid cookie redirects silently.
 * @returns {boolean} true when the response was sent
 */
export function handleHandoffNavigation(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const ticket = url.searchParams.get('handoff');
  if (!ticket || getRequestIngress(req) === 'loopback') return false;
  const ingress = getRequestIngress(req);
  const origin = `${ingressScheme(ingress)}://${String(req.headers.host ?? '')}`;
  let exchanged = null;
  try {
    exchanged = consumeHandoffTicket(ticket, { origin });
  } catch {
    exchanged = null;
  }
  if (exchanged) {
    setDeviceCookie(res, exchanged.token, {
      secure: ingressScheme(ingress) === 'https',
      credentialId: exchanged.credentialId,
    });
    redirect(res, '/');
    return true;
  }
  const existing = resolveRequestAuth(req, url);
  redirect(res, existing.ok && existing.auth.kind === 'device' ? '/' : '/connect?reason=handoff-expired');
  return true;
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
      if (handleHandoffNavigation(req, res)) return;
      const source = await fs.readFile(indexPath, 'utf8');
      const transformed = await transformHtml(req.originalUrl ?? req.url ?? '/', source);
      const boot = await readAppearanceBootPayload();
      const withAppearance = injectAppearanceBootScript(transformed, boot);
      const html = addDeviceManifestToHtml(addRequestAuthToHtml(withAppearance, req), req);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch (error) {
      next(error);
    }
  };
}

