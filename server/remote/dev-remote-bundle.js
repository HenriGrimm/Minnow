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
import path from 'node:path';
import { createSpaAuthHtmlMiddleware } from '../runtime/spa-auth-html.js';
import { createBundleAssetMiddleware } from './bundle-assets.js';

/** How long a remote request waits for the first build before using live modules. */
const FIRST_BUILD_WAIT_MS = 20_000;

/**
 * @param {{ root: string, outDir: string, script?: string }} opts
 */
export function createDevRemoteBundle({ root, outDir, script = path.join(root, 'scripts', 'remote-bundle-watch.mjs') }) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let ready = false;
  /** @type {Set<(built: boolean) => void>} */
  const waiters = new Set();
  const assets = createBundleAssetMiddleware({ outDir });
  const indexPath = path.join(outDir, 'index.html');
  const html = createSpaAuthHtmlMiddleware({ indexPath });

  const finishWaiting = (built) => {
    for (const wake of waiters) wake(built);
    waiters.clear();
  };

  /** Start the watcher once; later calls are no-ops. */
  function start() {
    if (child) return;
    const proc = spawn(process.execPath, [script, outDir], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = proc;
    let buffered = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk) => {
      if (child !== proc) return;
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.event === 'built') {
          if (!ready) console.log(`[remote] phone bundle ready (${event.ms} ms); phones load it instead of live modules`);
          ready = true;
          finishWaiting(true);
        } else if (event?.event === 'error') {
          console.warn(`[remote] phone bundle build failed: ${event.message}`);
        }
      }
    });
    proc.stderr?.on('data', (chunk) => {
      if (process.env.MINNOW_DEBUG === '1') process.stderr.write(`[remote-bundle] ${chunk}`);
    });
    proc.once('error', (error) => console.warn(`[remote] phone bundle worker failed: ${error.message}`));
    proc.once('close', () => {
      if (child !== proc) return;
      child = null;
      finishWaiting(false);
    });
  }

  function stop() {
    const proc = child;
    child = null;
    finishWaiting(false);
    if (!proc) return;
    const closed = new Promise(resolve => proc.once('close', resolve));
    try { proc.stdin?.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 3_000);
    timer.unref?.();
    return closed.finally(() => clearTimeout(timer));
  }

  /** Resolves true once a build exists, false after `timeoutMs`. */
  function whenReady(timeoutMs = FIRST_BUILD_WAIT_MS) {
    if (ready) return Promise.resolve(true);
    start();
    return new Promise((resolve) => {
      const done = (built) => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(built);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      waiters.add(done);
    });
  }

  /**
   * Serve one non-API request from the bundle.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function serve(req, res) {
    const finish = (error) => {
      res.statusCode = error ? 500 : 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(error ? 'Could not load Minnow' : 'Not found');
    };
    let fallthrough = false;
    await html(req, res, (error) => {
      if (error) finish(error);
      else fallthrough = true;
    });
    if (fallthrough) await assets(req, res, finish);
  }

  return { stop, whenReady, serve, isReady: () => ready };
}
