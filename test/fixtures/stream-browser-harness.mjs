// Manual Chromium regression: node test/fixtures/stream-browser-harness.mjs
// Opens an isolated fixture, never the user's Minnow data or providers.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { attachStreamWebSocketServer } from '../../server/runtime/stream-ws.js';
import { getSessionToken } from '../../server/runtime/session-token.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'minnow-stream-browser-'));
process.env.MINNOW_HOME = home;
const token = getSessionToken();
const bundle = await build({
  stdin: { contents: `
    import { streamFetch } from './src/api/stream-fetch.ts';
    document.querySelector('button').onclick = async () => {
      const result = {};
      const native = await Promise.all(Array.from({ length: 6 }, (_, i) => fetch('/api/live?i=' + i)));
      try {
        await fetch('/api/ping', { signal: AbortSignal.timeout(500) });
        result.baselineBlocked = false;
      } catch { result.baselineBlocked = true; }
      await Promise.all(native.map(response => response.body.cancel()));
      const shared = await Promise.all(Array.from({ length: 32 }, (_, i) => streamFetch('/api/live?i=' + i)));
      const start = performance.now();
      result.ping = await (await fetch('/api/ping', { signal: AbortSignal.timeout(1000) })).text();
      result.pingMs = Math.round(performance.now() - start);
      result.streams = shared.length;
      await Promise.all(shared.map(response => response.body.cancel()));
      document.querySelector('pre').textContent = JSON.stringify(result);
    };
  `, resolveDir: process.cwd() }, bundle: true, format: 'esm', write: false,
});
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
  if (req.url === '/api/ping') { res.end('pong'); return; }
  if (req.url.startsWith('/api/live')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ready\n\n'); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<title>Stream transport regression</title><button>Run regression</button><pre>Ready</pre>
    <script>window.__MINNOW_SESSION_TOKEN__=${JSON.stringify(token)}</script><script type="module" src="/bundle.js"></script>`);
});
const wss = attachStreamWebSocketServer(server);
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
process.on('SIGINT', async () => {
  for (const ws of wss.clients) ws.terminate();
  server.closeAllConnections(); server.close();
  await rm(home, { recursive: true, force: true });
  process.exit();
});
