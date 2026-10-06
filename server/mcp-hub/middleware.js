import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHubServer, listHubTools } from './server.js';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getMinnowHome } from '../config/home.js';
import { createMcpConnection, listMcpConnections, revokeMcpConnection, mcpWorkspaceKey } from '../auth/mcp-store.js';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** External Node cannot read Electron's ASAR virtual filesystem. */
export function describeHubStdio(cliPath) {
  return cliPath && !/\.asar(?:[\\/]|$)/i.test(cliPath)
    ? { stdio: { command: 'node', cliPath, home: getMinnowHome() }, stdioUnavailableReason: null }
    : { stdio: null, stdioUnavailableReason: 'This build cannot run the local bridge directly. Local command (stdio) requires a Minnow source checkout with dependencies installed and Node.js. Use HTTP here, or run node /path/to/Minnow/bin/minnow.mjs mcp from a source checkout.' };
}

async function manageConnections(req, res, url) {
  try {
    if (req.method === 'GET') return sendJson(res, 200, { connections: listMcpConnections(req.minnowWorkspaceRoot) });
    if (req.method === 'DELETE') {
      const removed = revokeMcpConnection(url.searchParams.get('id'), req.minnowWorkspaceRoot);
      return sendJson(res, removed ? 200 : 404, { revoked: removed });
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST, DELETE' }); res.end(); return; }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 8192) return sendJson(res, 413, { error: 'Request body too large' });
    }
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object') throw new TypeError('Invalid request');
    if (body.workspaceScope !== undefined && !['agent', 'workspace'].includes(body.workspaceScope)) throw new TypeError('Invalid workspace scope');
    if (body.workspaceScope === 'workspace' && !req.minnowWorkspaceRoot) throw new TypeError('A workspace-scoped connection requires X-Minnow-Workspace');
    const result = createMcpConnection({ name: body.name, access: body.access, replaceId: body.replaceId, workspace: body.workspaceScope === 'workspace' ? req.minnowWorkspaceRoot : undefined });
    sendJson(res, 201, result);
  } catch (error) {
    sendJson(res, error instanceof TypeError || error instanceof SyntaxError ? 400 : 500,
      { error: error instanceof TypeError ? error.message : 'Could not update MCP connections' });
  }
}

/** Runs behind the ordinary auth and workspace gates in both desktop and dev hosts. */
export function createMcpHubMiddleware() {
  return function mcpHub(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!['/api/mcp/hub', '/api/mcp/hub/info', '/api/mcp/hub/connections'].includes(url.pathname)) return next();
    if (req.headers.origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch {}
      if (!sameOrigin) { res.writeHead(403); res.end('Forbidden origin'); return; }
    }
    if (url.pathname.endsWith('/connections')) {
      if (req.minnowAuth?.kind !== 'host') return sendJson(res, 403, { error: 'Host session required' });
      void manageConnections(req, res, url);
      return;
    }
    if (url.pathname.endsWith('/info')) {
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
      const cliPath = fileURLToPath(new URL('../../bin/minnow.mjs', import.meta.url));
      void fs.access(cliPath).then(() => cliPath, () => null).then(availableCli => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          workspace: req.minnowWorkspaceRoot ?? '',
          endpoint: '/api/mcp/hub',
          ...describeHubStdio(availableCli),
          tools: listHubTools().map(tool => ({ name: tool.name, description: tool.description, readOnly: tool.annotations.readOnlyHint })),
        }));
      });
      return;
    }
    if (req.minnowAuth?.kind === 'mcp' && req.minnowAuth.workspace !== null && req.minnowAuth.workspace !== mcpWorkspaceKey(req.minnowWorkspaceRoot)) {
      return sendJson(res, 403, { error: 'Connection workspace mismatch' });
    }
    const server = createHubServer({ workspace: req.minnowWorkspaceRoot, boundWorkspace: req.minnowAuth?.kind === 'mcp' ? req.minnowAuth.workspace : null, readOnly: req.minnowAuth?.readOnly === true || url.searchParams.get('readOnly') === '1' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    void server.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'MCP hub request failed.' }));
      void server.close().catch(() => {});
    });
  };
}
