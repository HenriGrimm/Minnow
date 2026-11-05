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
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';

const CLIENT_PATHS = new Set(['/index.html', '/@vite/client', '/@vite/env', '/@react-refresh', '/__vite_ping']);

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isPublicFileWithin(file, dir) {
  try {
    return isInside(file, dir) && isResolvedPathUnderRoot(file, dir);
  } catch {
    return false;
  }
}

/** A direct desktop request also enters Vite's graph. Only follow imports from client code. */
export function isDevClientImport(graph, pathname, root) {
  const id = pathname.startsWith('/@id/') ? pathname.slice(5).replace('__x00__', '\0') : pathname;
  const module = graph.urlToModuleMap.get(pathname) ?? graph.urlToModuleMap.get(id) ?? graph.getModuleById(id);
  const pending = Array.from(module?.importers ?? []);
  const seen = new Set();
  while (pending.length) {
    const importer = pending.pop();
    if (seen.has(importer)) continue;
    seen.add(importer);
    if (importer.file && ['src', 'node_modules'].some(dir => isPublicFileWithin(importer.file, path.join(root, dir)))) return true;
    for (const parent of importer.importers) pending.push(parent);
  }
  return false;
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
    if (first === 'api' || CLIENT_PATHS.has(decoded)) return true;
    // `/@fs/<absolute path>`: Vite's own fs.allow is the whole checkout; narrow it.
    if (first === '@fs' || first === 'src' || first === 'node_modules') {
      const target = first === '@fs' ? path.resolve('/', decoded.slice('/@fs/'.length)) : path.join(root, ...segments);
      return fsAllowed.some(dir => isPublicFileWithin(target, dir));
    }
    if (isImportedModule(pathname)) return true;
    const asset = path.join(publicDir, ...segments);
    return fs.existsSync(asset) && isPublicFileWithin(asset, publicDir) && !fs.existsSync(path.join(root, ...segments));
  };
}

/**
 * Wrap Vite's middlewares for the remote listeners. With `bundle`, everything
 * but `/api` comes from the bundled build (see dev-remote-bundle.js); live
 * modules are the fallback while the first build is still running.
 * @param {import('node:http').RequestListener} handler
 * @param {DevRemoteOptions & { serveShell?: Function, bundle?: ReturnType<typeof import('./dev-remote-bundle.js').createDevRemoteBundle> }} opts
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
        // Pass extensionless browser navigations directly to the shell renderer.
        // Passing the original filename to Vite here would serve private checkout files.
        if (opts.serveShell && (req.method === 'GET' || req.method === 'HEAD') &&
            req.headers.accept?.includes('text/html') && /^\/[\w/-]+$/.test(pathname)) {
          opts.serveShell(req, res, () => {
            if (!res.headersSent) res.statusCode = 500;
            res.end('Could not load Minnow');
          });
          return;
        }
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }
      handler(req, res);
    }
  };
}
