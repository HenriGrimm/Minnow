/**
 * Dev-only gate in front of Vite for the remote listeners. A packaged app
 * serves only `dist/` to phones; the dev server would otherwise serve the whole
 * checkout (server code, docs, dotfiles) to anyone holding the Anywhere address,
 * and scanners probing `/.DS_Store` make Vite push parse errors to every open
 * window. Phones get what the SPA loads: `/api`, Vite's own module paths, `src/`,
 * dependencies, `public/`, SPA routes, and any other file the SPA imports (Vite
 * records each import in its module graph before the browser asks for it).
 */

import fs from 'node:fs';
import path from 'node:path';

/** First path segments the SPA loads in dev. */
const ALLOWED_ROOTS = new Set(['api', 'src', 'node_modules', '@vite', '@id', '@react-refresh', 'index.html']);

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @typedef {{
 *   root: string,
 *   publicDir?: string,
 *   isImportedModule?: (pathname: string) => boolean,
 * }} DevRemoteOptions
 */

/**
 * @param {DevRemoteOptions} opts
 * @returns {(pathname: string) => boolean} whether a remote request may reach Vite
 */
export function createDevRemotePathPolicy({ root, publicDir = path.join(root, 'public'), isImportedModule = () => false }) {
  const readNames = (dir) => {
    try {
      return new Set(fs.readdirSync(dir));
    } catch {
      return new Set();
    }
  };
  const publicNames = readNames(publicDir);
  const rootNames = readNames(root);
  const fsAllowed = [path.join(root, 'src'), path.join(root, 'node_modules')];

  return (pathname) => {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const segments = decoded.split('/').filter(Boolean);
    if (segments.length === 0) return true;
    const hidden = (segment, i) =>
      segment.startsWith('.') && !(segment === '.vite' && segments[i - 1] === 'node_modules');
    if (segments.some((segment, i) => hidden(segment, i) || segment.includes('\\'))) return false;
    const [first] = segments;
    if (ALLOWED_ROOTS.has(first) || first.startsWith('__vite')) return true;
    // `/@fs/<absolute path>`: Vite's own fs.allow is the whole checkout; narrow it.
    if (first === '@fs') return fsAllowed.some((dir) => isInside(path.resolve('/', ...segments.slice(1)), dir));
    if (publicNames.has(first)) return true;
    if (isImportedModule(pathname)) return true;
    // Anything else at the top of the checkout stays private; unknown names are SPA routes.
    return !rootNames.has(first);
  };
}

/**
 * Wrap Vite's middlewares for the remote listeners. With `bundle`, everything
 * but `/api` comes from the bundled build (see dev-remote-bundle.js); live
 * modules are the fallback while the first build is still running.
 * @param {import('node:http').RequestListener} handler
 * @param {DevRemoteOptions & { bundle?: ReturnType<typeof import('./dev-remote-bundle.js').createDevRemoteBundle> }} opts
 * @returns {import('node:http').RequestListener}
 */
export function createDevRemoteHandler(handler, opts) {
  const allowed = createDevRemotePathPolicy(opts);
  const { bundle } = opts;
  return (req, res) => {
    const pathname = String(req.url ?? '/').split(/[?#]/, 1)[0];
    if (bundle && !pathname.startsWith('/api/')) {
      void bundle.whenReady().then((built) => {
        if (built) return bundle.serve(req, res);
        return serveLive();
      }).catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Could not load Minnow');
        }
      });
      return;
    }
    serveLive();

    function serveLive() {
      if (!allowed(pathname)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }
      handler(req, res);
    }
  };
}
