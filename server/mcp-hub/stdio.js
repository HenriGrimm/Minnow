import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function startHubStdio(argv = process.argv.slice(3)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      process.stderr.write('Usage: minnow mcp [--workspace <absolute-path>] [--base-url http://127.0.0.1:9473] [--read-only]\nWorkspace comes from tool arguments, agent MCP roots, or the launch directory. --workspace supplies a legacy fallback. Keep Minnow open. Uses MINNOW_TOKEN or the session-token in MINNOW_HOME (default ~/.minnow).\n');
      return;
    }
    if (flag === '--read-only') { options.readOnly = true; continue; }
    if (!['--workspace', '--base-url'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid MCP option: ${flag}`);
    options[flag.slice(2)] = argv[++i];
  }
  if (options.workspace && !path.isAbsolute(options.workspace)) throw new Error('--workspace must be an absolute path.');
  const url = new URL(options['base-url'] ?? 'http://127.0.0.1:9473');
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The stdio bridge requires a loopback HTTP(S) base URL.');
  }
  url.pathname = '/api/mcp/hub';
  if (options.readOnly) url.searchParams.set('readOnly', '1');
  const home = process.env.MINNOW_HOME || path.join(os.homedir(), '.minnow');
  const upstream = new Client({ name: 'minnow-stdio', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const token = process.env.MINNOW_TOKEN?.trim() || (await fs.readFile(path.join(home, 'session-token'), 'utf8')).trim();
      const headers = new Headers(init?.headers);
      headers.set('X-Minnow-Token', token);
      return fetch(input, { ...init, headers, redirect: 'error' });
    },
  });
  await upstream.connect(transport);
  const server = new Server({ name: 'minnow-hub', version: '1.0.0' }, {
    capabilities: { tools: {} }, instructions: upstream.getInstructions(),
  });
  server.setRequestHandler(ListToolsRequestSchema, request => upstream.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = { ...request.params.arguments };
      if (args.workspace_path === undefined) {
        if (server.getClientCapabilities()?.roots) {
          const { roots } = await server.listRoots({}, { signal: extra.signal });
          if (roots.length !== 1) throw new Error('The agent exposes multiple or no workspace roots. Pass your current workspace_path on this call.');
          args.workspace_path = fileURLToPath(roots[0].uri);
        } else {
          args.workspace_path = options.workspace ?? process.cwd();
        }
      }
      return await upstream.callTool({ ...request.params, arguments: args }, undefined, { signal: extra.signal });
    }
    catch (error) { return { isError: true, content: [{ type: 'text', text: `Minnow request failed: ${error.message}. Ensure Minnow is open and the workspace is available. Read current state before retrying a write.` }] }; }
  });
  server.onclose = () => { void upstream.close(); };
  await server.connect(new StdioServerTransport());
}
