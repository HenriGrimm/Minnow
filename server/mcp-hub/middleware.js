import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHubServer, listHubTools } from './server.js';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getMinnowHome } from '../config/home.js';

/** Runs behind the ordinary auth and workspace gates in both desktop and dev hosts. */
export function createMcpHubMiddleware() {
  return function mcpHub(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!['/api/mcp/hub', '/api/mcp/hub/info'].includes(url.pathname)) return next();
    // Pin every request to an explicit validated workspace, never the active UI window.
    if (!req.minnowWorkspaceRoot) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Set X-Minnow-Workspace to a workspace opened in Minnow.' }));
      return;
    }
    if (req.headers.origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch {}
      if (!sameOrigin) { res.writeHead(403); res.end('Forbidden origin'); return; }
    }
    if (url.pathname.endsWith('/info')) {
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
      const cliPath = fileURLToPath(new URL('../../bin/minnow.mjs', import.meta.url));
      void fs.access(cliPath).then(() => cliPath, () => null).then(availableCli => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          workspace: req.minnowWorkspaceRoot,
          endpoint: '/api/mcp/hub',
          stdio: availableCli && !availableCli.includes('.asar')
            ? { command: 'node', cliPath: availableCli, home: getMinnowHome() } : null,
          tools: listHubTools().map(tool => ({ name: tool.name, description: tool.description, readOnly: tool.annotations.readOnlyHint })),
        }));
      });
      return;
    }
    const server = createHubServer({ workspace: req.minnowWorkspaceRoot, readOnly: url.searchParams.get('readOnly') === '1' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    void server.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'MCP hub request failed.' }));
      void server.close().catch(() => {});
    });
  };
}
