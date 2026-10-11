import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
export async function startApp({ root, dataDir, token = randomBytes(32).toString('hex') }) {
  await fs.mkdir(dataDir, { recursive: true });
  const backend = await import(pathToFileURL(path.join(root, 'backend.mjs')).href);
  const prefix = `/a/${token}/`;
  let origin = '';
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'");
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url, origin);
      if (!url.pathname.startsWith(prefix)) { res.writeHead(403); res.end(); return; }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (relative === '__health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
      if (relative.startsWith('api/')) {
        req.url = `/${relative.slice(4)}${url.search}`;
        await backend.handle(req, res, { dataDir }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      const dist = path.join(root, 'dist');
      const file = path.resolve(dist, relative || 'index.html');
      const rel = path.relative(dist, file);
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).some(x => x.startsWith('.'))) { res.writeHead(403); res.end(); return; }
      const bytes = await fs.readFile(file);
      res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { if (!res.headersSent) res.writeHead(500); res.end('App request failed'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin + prefix };
}

if (process.argv[2] === '--serve') {
  const runtime = await startApp({ root: process.argv[3], dataDir: process.argv[4] });
  process.stdout.write(`REEF_READY ${runtime.url}\n`);
  process.on('SIGTERM', () => runtime.server.close(() => process.exit(0)));
}
