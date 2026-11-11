/**
 * Minimal MCP stdio server — newline-delimited JSON-RPC, per the MCP stdio spec.
 * Exposes plain, snake_case, and dashed tools so dispatch can be asserted to send
 * the server's own spelling back (`called:<name>`), not a re-encoded guess.
 */

import process from 'node:process';

const TOOLS = [
  { name: 'echo', description: 'Echo fixture' },
  { name: 'echo_message', description: 'Snake_case fixture', annotations: { readOnlyHint: true } },
  { name: 'echo-dashed', description: 'Dashed fixture' },
].map((tool) => ({
  ...tool,
  inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
}));

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

let buffer = '';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-mcp', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name ?? '';
    if (!TOOL_NAMES.has(name)) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: name === 'echo' ? 'pong' : `called:${name}` }],
      },
    });
    return;
  }

  // Notifications carry no id and expect no reply.
  if (msg.id != null) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
    newline = buffer.indexOf('\n');
  }
});
