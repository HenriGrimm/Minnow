/**
 * Shared fixtures for remote-access tests: a scratch Minnow home and a minimal
 * app (auth gate + auth/remote routes + SPA shell) to put behind real listeners.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resetDeviceStoreCache } from '../../server/auth/device-store.js';
import { resetPairingState } from '../../server/auth/pairing.js';
import { resetAccessRequests } from '../../server/auth/requests.js';
import { resetHandoffState } from '../../server/auth/handoff.js';
import { resetDeviceCookieState } from '../../server/auth/cookie.js';
import { resetSessionTokenCache } from '../../server/runtime/session-token.js';
import { initNetworkAccess, setActiveNetworkAccess } from '../../server/network/access.js';
import { createAuthMiddleware, createRemoteResponseHeadersMiddleware } from '../../server/runtime/auth-middleware.js';
import { createAuthRoutesMiddleware } from '../../server/auth/routes.js';
import { createRemoteMiddleware } from '../../server/remote/middleware.js';
import { createSpaAuthHtmlMiddleware } from '../../server/runtime/spa-auth-html.js';

export function resetRemoteState() {
  resetMinnowHomeCache();
  resetSessionTokenCache();
  resetPairingState();
  resetAccessRequests();
  resetHandoffState();
  resetDeviceStoreCache();
  resetDeviceCookieState();
}

/** Point MINNOW_HOME at a fresh folder; returns a cleanup function. */
export async function useScratchHome(prefix = 'minnow-remote') {
  resetRemoteState();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  process.env.MINNOW_HOME = home;
  delete process.env.MINNOW_NETWORK;
  initNetworkAccess({});
  return {
    home,
    async cleanup() {
      resetRemoteState();
      setActiveNetworkAccess('local');
      delete process.env.MINNOW_HOME;
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

/** A minimal Minnow app: the real auth gate, auth + remote routes, and an SPA shell. */
export async function createTestApp(home) {
  const indexPath = path.join(home, 'index.html');
  await fs.writeFile(
    indexPath,
    '<!doctype html><html><head><link rel="manifest" href="/manifest.json"></head><body>app</body></html>',
  );
  const app = connect();
  app.use(createRemoteResponseHeadersMiddleware());
  app.use(createAuthMiddleware());
  app.use(createAuthRoutesMiddleware());
  app.use(createRemoteMiddleware());
  app.use((req, res, next) => {
    if (req.url?.startsWith('/api/echo')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ auth: req.minnowAuth ?? null }));
      return;
    }
    next();
  });
  app.use(createSpaAuthHtmlMiddleware({ indexPath }));
  return app;
}

/** Reserve a free TCP port (then release it) for listeners that need a fixed one. */
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Parse `minnow_device=<token>` from a Set-Cookie header. */
export function deviceCookieFrom(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie().join('\n') : String(headers.get?.('set-cookie') ?? '');
  const match = /minnow_device=([^;]*)/.exec(raw);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Raw HTTP request (fetch cannot override Host, which tailnet tests need).
 * @param {number} port
 * @param {{ method?: string, path?: string, headers?: Record<string, string>, body?: unknown }} [opts]
 */
export function rawRequest(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'] ?? [];
          const match = /minnow_device=([^;]*)/.exec(setCookie.join('\n'));
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
            cookie: match ? decodeURIComponent(match[1]) : '',
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
