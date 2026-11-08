import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNodeRuntimeEnv } from '../../lsp/node-runtime.js';
import { isParallelSafeTool } from '../../runner/parallel-tool-policy.js';
import { CLI_READ_BATCH, cliReadBatchTool, expandCliReadBatch } from './read-batch.js';

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
    return { name, originalName: fn.name, description: String(fn.description ?? ''), inputSchema: fn.parameters ?? { type: 'object', properties: {} },
      annotations: { readOnlyHint: isParallelSafeTool(fn.name), destructiveHint: !isParallelSafeTool(fn.name) } };
  });
  if ((selected || body.tool_choice === 'required') && !tools.length) throw new Error('The requested agent CLI tool is not available.');
  if (tools.length > 512 || Buffer.byteLength(JSON.stringify(tools)) > 2 * 1024 * 1024) throw new Error('Agent CLI tool catalog exceeds its size limit.');
  return tools;
}

/** Private tool handoff, deliberately incapable of executing Minnow tools. */
export async function createAgentCliBridge({ tools, tempDir, onCall, interactive = false, readBatch = false, toolChoice }) {
  const token = randomBytes(32).toString('hex');
  const secret = Buffer.from(`Bearer ${token}`);
  const catalog = new Map(tools.map(tool => [tool.name, tool]));
  const batchTool = readBatch ? cliReadBatchTool(tools, toolChoice) : null;
  const advertised = batchTool ? [...tools, batchTool] : tools;
  if (batchTool) catalog.set(batchTool.name, batchTool);
  const sockets = new Set();
  const pending = new Map();
  let handoffCount = 0;
  let closed = false;
  let queuedPrompt;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const toolsFile = join(tempDir, 'tools.json');
  await writeFile(toolsFile, JSON.stringify(advertised.map(({ originalName, ...tool }) => tool)), { mode: 0o600 });
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    if (closed || req.method !== 'POST' || !['/call', ...(interactive ? ['/ready', '/prompt'] : [])].includes(req.url) || req.headers.origin || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
      res.writeHead(403).end(); return;
    }
    if (req.url === '/call' && handoffCount >= MAX_HANDOFF_CALLS) { res.writeHead(409).end('Tool handoff batch is full.'); return; }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_CALL_BYTES) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/ready') { readyResolve(true); res.writeHead(200).end('{}'); return; }
      if (req.url === '/prompt') {
        if (!queuedPrompt || payload.nonce !== queuedPrompt.nonce) { res.writeHead(409).end(); return; }
        const prompt = queuedPrompt; queuedPrompt = null;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messages: prompt.messages }));
        return;
      }
      const tool = catalog.get(payload?.name);
      if (!tool || !payload.arguments || typeof payload.arguments !== 'object' || Array.isArray(payload.arguments)) { res.writeHead(400).end('Unknown tool or invalid arguments.'); return; }
      if (handoffCount >= MAX_HANDOFF_CALLS || closed) { res.writeHead(409).end(); return; }
      let functions;
      try { functions = batchTool && payload.name === CLI_READ_BATCH ? expandCliReadBatch(payload.arguments, catalog)
        : [{ name: tool.originalName, arguments: JSON.stringify(payload.arguments) }]; }
      catch (error) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ isError: true,
          content: [{ type: 'text', text: `${error.message} No calls were executed.` }] }));
        return;
      }
      if (handoffCount + functions.length > MAX_HANDOFF_CALLS) { res.writeHead(409).end('Tool handoff batch is full.'); return; }
      handoffCount += functions.length;
      const nativeCall = { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(payload.arguments) } };
      const calls = functions.map(fn => ({ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: fn }));
      if (tool !== batchTool) nativeCall.id = calls[0].id;
      const group = { res, calls, nativeCall, batched: tool === batchTool, results: new Map() };
      for (const call of calls) pending.set(call.id, group);
      res.on('close', () => { for (const call of calls) pending.delete(call.id); });
      for (const call of calls) onCall(call);
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
    ...(interactive ? { MINNOW_CLI_INTERACTIVE: '1' } : {}),
  }, process.execPath);
  return {
    config: { command: process.execPath, args: [fileURLToPath(new URL('./mcp-shim.mjs', import.meta.url))], env },
    ready,
    queuePrompt(content) {
      if (!interactive || closed || queuedPrompt) throw new Error('Interactive Claude input is not ready.');
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      const messages = parts.map(part => ({ role: 'user', content: part.type === 'image'
        ? { type: 'image', data: part.source.data, mimeType: part.source.media_type }
        : { type: 'text', text: part.text } }));
      const nonce = randomBytes(16).toString('hex');
      queuedPrompt = { nonce, messages };
      return `/mcp__minnow__message ${nonce}`;
    },
    resetBatch: () => { handoffCount = 0; },
    nativeCalls: calls => [...new Map(calls.map(call => {
      const native = pending.get(call.id)?.nativeCall ?? call;
      return [native.id, native];
    })).values()],
    resolveCall: (id, content, images = []) => {
      const group = pending.get(id);
      const response = group?.res;
      if (!response || response.destroyed || response.writableEnded) return false;
      pending.delete(id);
      group.results.set(id, { content: String(content ?? ''), images });
      if (group.results.size !== group.calls.length) return true;
      const resultContent = group.calls.flatMap((call, index) => {
        const result = group.results.get(call.id);
        return [{ type: 'text', text: group.batched ? JSON.stringify({ index, name: call.function.name, content: result.content }) : result.content },
          ...result.images.map(image => ({ type: 'image', data: image.source.data, mimeType: image.source.media_type }))];
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: resultContent }));
      return true;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      queuedPrompt = null; readyResolve(false);
      pending.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
