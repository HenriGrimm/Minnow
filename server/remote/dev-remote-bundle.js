/**
 * Dev only: phones on the remote listeners load a bundled build instead of the
 * Vite dev server's unbundled modules. Live modules are ~1,600 separate files
 * fetched in import-depth waves; over Tailscale Funnel on mobile data that took
 * about three minutes. A packaged app already serves `dist/` to phones; this
 * gives the dev server the same shape and keeps it current with a background
 * `vite build --watch` (scripts/remote-bundle-watch.mjs, ~1 s per build).
 *
 * The bundle is served like a packaged app's: navigations through the shared
 * auth-aware HTML middleware, hashed assets cached as immutable, text gzipped
 * once and kept in memory. `/api` never reaches this module.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { createSpaAuthHtmlMiddleware } from '../runtime/spa-auth-html.js';

const gzipAsync = promisify(zlib.gzip);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.map', '.svg', '.txt', '.wasm']);
/** How long a remote request waits for the first build before using live modules. */
const FIRST_BUILD_WAIT_MS = 20_000;

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {{ root: string, outDir: string, script?: string }} opts
 */
export function createDevRemoteBundle({ root, outDir, script = path.join(root, 'scripts', 'remote-bundle-watch.mjs') }) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let ready = false;
  /** @type {(() => void)[]} */
  let waiters = [];
  /** @type {Map<string, { mtimeMs: number, size: number, gz: Buffer }>} */
  const gzCache = new Map();
  const indexPath = path.join(outDir, 'index.html');
  const html = createSpaAuthHtmlMiddleware({ indexPath });

  const markReady = () => {
    ready = true;
    for (const wake of waiters) wake();
    waiters = [];
  };

  /** Start the watcher once; later calls are no-ops. */
  function start() {
    if (child) return;
    fs.rmSync(outDir, { recursive: true, force: true });
    gzCache.clear();
    const proc = spawn(process.execPath, [script, outDir], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = proc;
    let buffered = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.event === 'built') {
          if (!ready) console.log(`[remote] phone bundle ready (${event.ms} ms); phones load it instead of live modules`);
          markReady();
        } else if (event?.event === 'error') {
          console.warn(`[remote] phone bundle build failed: ${event.message}`);
        }
      }
    });
    proc.stderr?.on('data', (chunk) => {
      if (process.env.MINNOW_DEBUG === '1') process.stderr.write(`[remote-bundle] ${chunk}`);
    });
    proc.once('exit', () => {
      if (child === proc) child = null;
    });
  }

  function stop() {
    const proc = child;
    child = null;
    if (!proc) return;
    try { proc.stdin?.end(); } catch { /* already closed */ }
    setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 3_000).unref?.();
  }

  /** Resolves true once a build exists, false after `timeoutMs`. */
  function whenReady(timeoutMs = FIRST_BUILD_WAIT_MS) {
    if (ready) return Promise.resolve(true);
    start();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((wake) => wake !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(true); };
      waiters.push(done);
    });
  }

  /**
   * Serve one non-API request from the bundle.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function serve(req, res) {
    const notFound = () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
    };
    let fallthrough = false;
    await html(req, res, (error) => {
      if (error) {
        res.statusCode = 500;
        res.end('Could not load Minnow');
        return;
      }
      fallthrough = true;
    });
    if (!fallthrough) return;

    let pathname;
    try {
      pathname = decodeURIComponent(String(req.url ?? '/').split(/[?#]/, 1)[0]);
    } catch {
      notFound();
      return;
    }
    const file = path.resolve(outDir, `.${pathname}`);
    if (!isInside(file, outDir)) {
      notFound();
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      notFound();
      return;
    }
    if (!stat.isFile()) {
      notFound();
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    // Content-hashed build output never changes; everything else revalidates.
    res.setHeader('Cache-Control', pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');

    const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (gzip) {
      let cached = gzCache.get(file);
      if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
        cached = { mtimeMs: stat.mtimeMs, size: stat.size, gz: await gzipAsync(await fsp.readFile(file)) };
        gzCache.set(file, cached);
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(cached.gz.length));
      res.end(req.method === 'HEAD' ? undefined : cached.gz);
      return;
    }
    res.setHeader('Content-Length', String(stat.size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  }

  return { start, stop, whenReady, serve, isReady: () => ready };
}
