/**
 * /api/mcp/* middleware.
 */

import { getMinnowHome } from '../config/home.js';
import {
  ensureMcpSeed,
  listServers,
  listEnabledMcpTools,
  getMcpToolHints,
  listMcpToolCatalog,
  callMcpTool,
  reloadMcp,
  createMcpServer,
  deleteMcpServer,
  importMcpServers,
  setMcpServerEnabled,
  refreshMcpServer,
  getMcpCatalogRevision,
  subscribeMcpCatalogChanges,
} from './registry.js';
import { readMcpSecrets, updateMcpSecrets } from './secrets.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createMcpMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/mcp')) {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (url === '/api/mcp/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = revision => {
          if (res.destroyed || res.writableEnded) return;
          if (res.writableLength > 64 * 1024) { res.destroy(); return; }
          res.write(`data: ${JSON.stringify({ revision })}\n\n`);
        };
        const unsubscribe = subscribeMcpCatalogChanges(send);
        send(getMcpCatalogRevision());
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(': ping\n\n');
        }, 15_000);
        heartbeat.unref?.();
        res.once('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }

      if (url === '/api/mcp/ping' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          homeDir: getMinnowHome(),
          serverCount: (await listServers()).length,
        });
        return;
      }

      if (url === '/api/mcp/servers' && req.method === 'GET') {
        sendJson(res, 200, { servers: await listServers() });
        return;
      }

      if (url === '/api/mcp/secrets' && req.method === 'GET') {
        const secrets = await readMcpSecrets();
        sendJson(res, 200, {
          hasContext7ApiKey: secrets.context7ApiKey.trim().length > 0,
        });
        return;
      }

      if (url === '/api/mcp/secrets' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const flags = await updateMcpSecrets(body);
        await reloadMcp();
        sendJson(res, 200, flags);
        return;
      }

      if (url === '/api/mcp/servers' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body.mcpServers) {
          sendJson(res, 201, { servers: await importMcpServers(body) });
          return;
        }
        const server = await createMcpServer(body);
        sendJson(res, 201, { server });
        return;
      }

      if (url === '/api/mcp/tools' && req.method === 'GET') {
        const revision = getMcpCatalogRevision();
        const tools = await listEnabledMcpTools();
        sendJson(res, 200, { tools, revision, hints: getMcpToolHints() });
        return;
      }

      if (url === '/api/mcp/tools/catalog' && req.method === 'GET') {
        sendJson(res, 200, { servers: await listMcpToolCatalog() });
        return;
      }

      if (url === '/api/mcp/tools/call' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await callMcpTool(String(body.name ?? ''), body.args ?? {});
        sendJson(res, 200, { result });
        return;
      }

      if (url === '/api/mcp/reload' && req.method === 'POST') {
        await reloadMcp();
        sendJson(res, 200, { ok: true });
        return;
      }

      const serverMatch = url.match(/^\/api\/mcp\/servers\/([^/]+)$/);
      if (serverMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(serverMatch[1]);
        await deleteMcpServer(id);
        sendJson(res, 200, { ok: true });
        return;
      }

      const enableMatch = url.match(/^\/api\/mcp\/servers\/([^/]+)\/enabled$/);
      if (enableMatch && req.method === 'PUT') {
        const id = decodeURIComponent(enableMatch[1]);
        const body = await readJsonBody(req);
        await setMcpServerEnabled(id, body.enabled !== false);
        sendJson(res, 200, { ok: true });
        return;
      }

      const refreshMatch = url.match(/^\/api\/mcp\/servers\/([^/]+)\/refresh$/);
      if (refreshMatch && req.method === 'POST') {
        await refreshMcpServer(decodeURIComponent(refreshMatch[1]));
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        message.includes('already exists') ||
        message.includes('Invalid') ||
        message.includes('required') ||
        message.includes('reserved') ||
        message.includes('Unknown MCP')
          ? 400
          : message.includes('Cannot delete')
            ? 403
            : 500;
      sendJson(res, status, { error: message });
    }
  };
}

export async function initMcpApi() {
  await ensureMcpSeed();
}
