#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const MAX_LINE = 1024 * 1024;

/** Minimal stdio MCP. Tools request a handoff; this process never executes a tool. */
export function startMcpShim({ env = process.env, input = process.stdin, output = process.stdout, fetchImpl = fetch } = {}) {
  const url = new URL(env.MINNOW_CLI_BRIDGE_URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/call' || url.username || url.password) throw new Error('Invalid Minnow CLI bridge address.');
  const tools = JSON.parse(readFileSync(env.MINNOW_CLI_TOOLS_FILE, 'utf8'));
  const catalog = new Set(tools.map(tool => tool.name));
  const controller = new AbortController();
  let requested = false;
  let bytes = 0;
  input.on('data', chunk => {
    for (const byte of Buffer.from(chunk)) { bytes = byte === 10 ? 0 : bytes + 1; if (bytes > MAX_LINE) { input.destroy(new Error('MCP input record exceeds 1 MB.')); break; } }
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  function reply(id, result, error) { output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`); }
  lines.on('line', async line => {
    let request;
    try { request = JSON.parse(line); } catch { reply(null, null, { code: -32700, message: 'Invalid JSON.' }); return; }
    if (!request || typeof request !== 'object' || Array.isArray(request)) { reply(null, null, { code: -32600, message: 'Invalid request.' }); return; }
    if (request.id === undefined) return;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') { reply(request.id, null, { code: -32600, message: 'Invalid request.' }); return; }
    if (request.method === 'initialize') {
      const requestedVersion = request.params?.protocolVersion;
      const protocolVersion = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requestedVersion)
        ? requestedVersion
        : '2024-11-05';
      reply(request.id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'minnow', version: '1.0.0' } });
      return;
    }
    if (request.method === 'ping') { reply(request.id, {}); return; }
    if (request.method === 'tools/list') { reply(request.id, { tools }); return; }
    if (request.method !== 'tools/call') { reply(request.id, null, { code: -32601, message: 'Method not found.' }); return; }
    const args = request.params?.arguments ?? {};
    if (!catalog.has(request.params?.name) || !args || typeof args !== 'object' || Array.isArray(args)) { reply(request.id, null, { code: -32602, message: 'Unknown tool or invalid arguments.' }); return; }
    if (requested) { reply(request.id, null, { code: -32600, message: 'One tool request per inference round. Await Minnow.' }); return; }
    requested = true;
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${env.MINNOW_CLI_BRIDGE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: request.params.name, arguments: args }), signal: controller.signal });
      if (!response.ok) throw new Error('Tool handoff rejected.');
      reply(request.id, null, { code: -32603, message: 'The bridge returned without yielding control.' });
    } catch {
      if (!controller.signal.aborted) reply(request.id, null, { code: -32603, message: 'Minnow tool handoff closed.' });
    }
  });
  lines.on('close', () => controller.abort());
  input.on('error', () => { controller.abort(); lines.close(); });
  return { close: () => { controller.abort(); lines.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { startMcpShim(); } catch { process.stderr.write('Could not start the Minnow tool bridge.\n'); process.exitCode = 1; }
}
