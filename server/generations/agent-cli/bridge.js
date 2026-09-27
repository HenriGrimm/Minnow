import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNodeRuntimeEnv } from '../../lsp/node-runtime.js';

const MAX_CALL_BYTES = 1024 * 1024;
const MAX_HANDOFF_CALLS = 8;

/** Expose exactly the caller's tools, including local report/question interceptors. */
export function buildAgentCliToolCatalog(body) {
  if (body.tool_choice === 'none') return [];
  const names = new Set();
  const selected = body.tool_choice?.function?.name;
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter(tool => !selected || tool.function?.name === selected).map((tool, index) => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !fn || typeof fn.name !== 'string' || !fn.name) throw new Error('Agent CLI requires named function tools.');
    const name = /^[A-Za-z0-9_-]{1,64}$/.test(fn.name) ? fn.name : `tool_${index}_${fn.name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 45)}`;
    if (names.has(name)) throw new Error('Agent CLI tool names must be unique.');
    names.add(name);
    return { name, originalName: fn.name, description: String(fn.description ?? ''), inputSchema: fn.parameters ?? { type: 'object', properties: {} } };
  });
  if ((selected || body.tool_choice === 'required') && !tools.length) throw new Error('The requested agent CLI tool is not available.');
  if (tools.length > 512 || Buffer.byteLength(JSON.stringify(tools)) > 2 * 1024 * 1024) throw new Error('Agent CLI tool catalog exceeds its size limit.');
  return tools;
}

/** Private tool handoff, deliberately incapable of executing Minnow tools. */
export async function createAgentCliBridge({ tools, tempDir, onCall }) {
  const token = randomBytes(32).toString('hex');
  const secret = Buffer.from(`Bearer ${token}`);
  const catalog = new Map(tools.map(tool => [tool.name, tool]));
  const sockets = new Set();
  const pending = new Map();
  let handoffCount = 0;
  let closed = false;
  const toolsFile = join(tempDir, 'tools.json');
  await writeFile(toolsFile, JSON.stringify(tools.map(({ originalName, ...tool }) => tool)), { mode: 0o600 });
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    if (closed || req.method !== 'POST' || req.url !== '/call' || req.headers.origin || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
      res.writeHead(403).end(); return;
    }
    if (handoffCount >= MAX_HANDOFF_CALLS) { res.writeHead(409).end('Tool handoff batch is full.'); return; }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_CALL_BYTES) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const tool = catalog.get(payload?.name);
      if (!tool || !payload.arguments || typeof payload.arguments !== 'object' || Array.isArray(payload.arguments)) { res.writeHead(400).end('Unknown tool or invalid arguments.'); return; }
      if (handoffCount >= MAX_HANDOFF_CALLS || closed) { res.writeHead(409).end(); return; }
      handoffCount += 1;
      const call = { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: tool.originalName, arguments: JSON.stringify(payload.arguments) } };
      pending.set(call.id, res);
      res.on('close', () => pending.delete(call.id));
      onCall(call);
    } catch {
      if (!res.destroyed && !res.headersSent) res.writeHead(400).end('Invalid tool request.');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 20;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const env = applyNodeRuntimeEnv({
    MINNOW_CLI_BRIDGE_URL: `http://127.0.0.1:${address.port}/call`,
    MINNOW_CLI_BRIDGE_TOKEN: token,
    MINNOW_CLI_TOOLS_FILE: toolsFile,
  }, process.execPath);
  return {
    config: { command: process.execPath, args: [fileURLToPath(new URL('./mcp-shim.mjs', import.meta.url))], env },
    resetBatch: () => { handoffCount = 0; },
    resolveCall: (id, content) => {
      const response = pending.get(id);
      if (!response || response.destroyed || response.writableEnded) return false;
      pending.delete(id);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: String(content ?? '') }] }));
      return true;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      pending.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
