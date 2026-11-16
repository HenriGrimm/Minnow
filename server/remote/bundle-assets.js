import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

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

function acceptsGzip(header) {
  let wildcard = false;
  for (const entry of String(header ?? '').toLowerCase().split(',')) {
    const [coding, ...parameters] = entry.split(';').map(part => part.trim());
    if (coding !== 'gzip' && coding !== '*') continue;
    const quality = parameters.find(parameter => /^q\s*=/.test(parameter));
    const accepted = quality === undefined || Number(quality.split('=')[1]) > 0;
    if (coding === 'gzip') return accepted;
    wildcard = accepted;
  }
  return wildcard;
}

/** Serve Vite build output on remote listeners. The packaged server handles
 * public files and range requests through its existing static middleware.
 * @param {{ outDir: string, assetsOnly?: boolean }} options
 */
export function createBundleAssetMiddleware({ outDir, assetsOnly = false }) {
  /** @type {Map<string, { mtimeMs: number, size: number, gz: Promise<Buffer> }>} */
  const gzCache = new Map();

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {(err?: unknown) => void} next
   */
  return async function serveBundleAsset(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try {
      pathname = decodeURIComponent(String(req.url ?? '/').split(/[?#]/, 1)[0]);
    } catch {
      return next();
    }
    if (assetsOnly && (!pathname.startsWith('/assets/') || req.headers.range)) return next();
    const file = path.resolve(outDir, `.${pathname}`);
    const rel = path.relative(outDir, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return next();
    const hashed = rel.startsWith(`assets${path.sep}`);
    if (assetsOnly && !hashed) return next();

    let stat;
    try {
      stat = await fsp.stat(file);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return next();
      return next(error);
    }
    if (!stat.isFile()) return next();

    try {
      const ext = path.extname(file).toLowerCase();
      const compressible = COMPRESSIBLE.has(ext);
      let gz;
      if (compressible && acceptsGzip(req.headers['accept-encoding'])) {
        let cached = gzCache.get(file);
        if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
          cached = { mtimeMs: stat.mtimeMs, size: stat.size, gz: fsp.readFile(file).then(buffer => gzipAsync(buffer)) };
          gzCache.set(file, cached);
        }
        try {
          gz = await cached.gz;
        } catch (error) {
          if (gzCache.get(file) === cached) gzCache.delete(file);
          throw error;
        }
      }
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (compressible) res.setHeader('Vary', 'Accept-Encoding');
      if (gz) res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(gz?.length ?? stat.size));
      if (req.method === 'HEAD' || gz) {
        res.end(req.method === 'HEAD' ? undefined : gz);
      } else {
        await pipeline(fs.createReadStream(file), res);
      }
    } catch (error) {
      if (!res.destroyed) next(error);
    }
  };
}
