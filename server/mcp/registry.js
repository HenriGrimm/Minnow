/**
 * MCP server registry — load configs, connect clients, list/call tools.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getMcpOAuthProvider, closeMcpOAuth } from './oauth.js';
import { getMinnowHome } from '../config/home.js';
import {
  BUILTIN_MCP_INDEX,
  CONTEXT7_SERVER,
  FIXTURE_SERVER,
} from './defaults.js';
import { toNamespacedName, toOpenAIDefinitions, parseNamespacedName } from './bridge.js';
import {
  RESERVED_MCP_SERVER_IDS,
  validateCreateMcpServerBody,
  validateMcpServerId,
  validateMcpImport,
  validateMcpTransport,
} from './validate.js';
import { getContext7ApiKey, resolveMcpTransportEnv } from './secrets.js';
import { agentCliSearchPath } from '../generations/agent-cli/resolve-bin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const clients = new Map();
const toolMaps = new Map();
const connecting = new Map();
const connectionErrors = new Map();
const authProviders = new Map();
const fingerprints = new Map();

async function allTools(client) {
  const tools = [];
  let cursor;
  const seen = new Set();
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools ?? []));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('MCP server repeated a tools cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { tools };
}

function mcpHome() {
  return path.join(getMinnowHome(), 'mcp');
}

function resolveTransportCommand(transport) {
  const cmd = [...(transport.command ? [transport.command] : []), ...(transport.args ?? [])];
  return cmd.map((part) => {
    if (part === 'test/fixtures/mock-mcp-server.mjs') {
      return path.join(PROJECT_ROOT, 'test/fixtures/mock-mcp-server.mjs');
    }
    return part;
  });
}

/**
 * Working directory for stdio servers. The packaged app's root is
 * Resources/app.asar — a file to the OS — so spawning there fails with
 * ENOTDIR on macOS; fall back to the home directory in that case.
 */
export function defaultStdioCwd(root = PROJECT_ROOT) {
  return /\.asar(?:[\\/]|$)/.test(root) ? os.homedir() : root;
}

/**
 * Stdio env. Finder-launched macOS apps inherit PATH=/usr/bin:/bin:…, so
 * `npx` (and the `node` its shebang needs) are invisible without the
 * Homebrew/npm bin dirs.
 */
function stdioEnv(resolvedEnv) {
  const env = { ...process.env, ...resolvedEnv };
  if (process.platform !== 'win32') env.PATH = agentCliSearchPath(env);
  return env;
}

/** In-process fixture client for deterministic tests (no stdio). */
function createFixtureClient() {
  return {
    async listTools() {
      return {
        tools: [
          {
            name: 'echo',
            description: 'Echo fixture',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
            },
          },
        ],
      };
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'pong' }] };
    },
    async close() {},
  };
}

/**
 * Cache namespaced id → the server's own tool name, so dispatch never has to
 * guess it back out of the lossy encoding.
 * Hyphen and underscore names collide; the first listing wins.
 * @param {string} serverId
 * @param {Array<{ name: string }>} tools
 */
function rememberTools(serverId, tools) {
  const map = new Map();
  for (const tool of tools ?? []) {
    const key = toNamespacedName(serverId, tool.name);
    if (!map.has(key)) map.set(key, tool.name);
  }
  toolMaps.set(serverId, map);
  return map;
}

/**
 * Real tool name for a namespaced id, preferring the live listing over the
 * lossy decode. Returns `null` when the server does not expose the tool.
 * @param {string} namespacedName
 * @param {{ serverId: string, toolName: string }} parsed
 */
function resolveMcpToolName(namespacedName, parsed) {
  const map = toolMaps.get(parsed.serverId);
  if (!map) return { toolName: parsed.toolName, known: [] };
  return { toolName: map.get(namespacedName) ?? null, known: [...map.values()] };
}

async function connectServer(serverId, config) {
  if (connecting.has(serverId)) return connecting.get(serverId);
  const pending = connectServerNow(serverId, config);
  connecting.set(serverId, pending);
  try { return await pending; }
  finally { connecting.delete(serverId); }
}

async function connectServerNow(serverId, config) {
  if (serverId === 'context7' && !(await getContext7ApiKey())) {
    throw new Error('Context7 API key is not configured');
  }
  const fingerprint = JSON.stringify(config);
  if (clients.has(serverId) && fingerprints.get(serverId) !== fingerprint) {
    await clients.get(serverId).close().catch(() => {});
    clients.delete(serverId);
    toolMaps.delete(serverId);
    authProviders.get(serverId)?.close();
    authProviders.delete(serverId);
  }
  if (clients.has(serverId)) {
    await authProviders.get(serverId)?.prepare();
    return clients.get(serverId);
  }

  if (serverId === 'fixture') {
    const client = createFixtureClient();
    const listed = await allTools(client);
    rememberTools(serverId, listed.tools ?? []);
    clients.set(serverId, client);
    fingerprints.set(serverId, fingerprint);
    return client;
  }

  const transportCfg = config.transport;
  if (!transportCfg) {
    throw new Error(`Unsupported transport for ${serverId}`);
  }

  let transport;
  if (transportCfg.url) {
    const provider = await getMcpOAuthProvider(serverId, transportCfg.url, async () => {
      connectionErrors.delete(serverId);
      const index = await loadIndex();
      if (index.servers?.[serverId]?.enabled !== false && index.servers?.[serverId]) {
        await connectServer(serverId, await loadServerConfig(serverId));
      }
    }, transportCfg.oauth);
    authProviders.set(serverId, provider);
    if (provider.authorizationUrl) throw new Error('Sign in to connect this server');
    await provider.prepare();
    const Transport = transportCfg.type === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport;
    transport = new Transport(new URL(transportCfg.url), {
      authProvider: provider,
      requestInit: { headers: transportCfg.headers ?? {} },
    });
    provider.setFinishAuth(code => transport.finishAuth(code));
  } else {
    const command = resolveTransportCommand(transportCfg);
    const resolvedEnv = await resolveMcpTransportEnv(transportCfg.env);
    transport = new StdioClientTransport({
      command: command[0],
      args: command.slice(1),
      env: stdioEnv(resolvedEnv),
      cwd: transportCfg.cwd ?? defaultStdioCwd(),
    });
  }

  const client = new Client(
    { name: 'minnow', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const listed = await allTools(client);
    rememberTools(serverId, listed.tools ?? []);
    clients.set(serverId, client);
    fingerprints.set(serverId, fingerprint);
    connectionErrors.delete(serverId);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    if (transportCfg.type === 'http' && [404, 405].includes(error.code)) {
      const fallback = await connectServerNow(serverId, { ...config, transport: { ...transportCfg, type: 'sse' } });
      fingerprints.set(serverId, fingerprint);
      return fallback;
    }
    connectionErrors.set(serverId, error.message);
    throw error;
  }
}

/** Copy built-in MCP seeds on first run. */
export async function ensureMcpSeed() {
  const home = mcpHome();
  await fs.mkdir(path.join(home, 'servers'), { recursive: true });
  const indexPath = path.join(getMinnowHome(), 'mcp.json');
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(
      indexPath,
      `${JSON.stringify(BUILTIN_MCP_INDEX, null, 2)}\n`,
      'utf8',
    );
  }

  const seeds = [
    { name: 'context7.json', data: CONTEXT7_SERVER },
    { name: 'fixture.json', data: FIXTURE_SERVER },
    { name: 'README.md', data: null, text: '# MCP servers\n\nSet the Context7 API key in Settings → MCP or save it to mcp/secrets.json.\n' },
  ];

  for (const seed of seeds) {
    const dest = path.join(home, 'servers', seed.name);
    try {
      await fs.access(dest);
    } catch {
      if (seed.text) {
        await fs.writeFile(dest, seed.text, 'utf8');
      } else {
        await fs.writeFile(dest, `${JSON.stringify(seed.data, null, 2)}\n`, 'utf8');
      }
    }
  }
}

async function loadIndex() {
  const indexPath = path.join(getMinnowHome(), 'mcp.json');
  try {
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index.servers = { ...index.servers };
    index.mcpServers = { ...index.mcpServers };
    for (const [id, config] of Object.entries(index.mcpServers ?? {})) {
      try {
        validateMcpServerId(id);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid MCP server configuration');
      } catch (error) {
        // A hand-edited or imported entry must not disable discovery for every
        // chat and board. Never let it shadow a reserved built-in either.
        delete index.mcpServers[id];
        console.warn(`MCP server ${id} skipped: ${error.message}`);
        continue;
      }
      index.servers[id] = { enabled: config.enabled !== false && config.disabled !== true, standard: true };
    }
    return index;
  } catch (error) {
    if (error.code === 'ENOENT') return { servers: {} };
    throw error;
  }
}

async function loadServerConfig(serverId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(serverId)) throw new Error('Invalid MCP server id');
  const index = await loadIndex();
  if (index.mcpServers?.[serverId]) {
    const raw = index.mcpServers[serverId];
    return { id: serverId, label: serverId, enabled: raw.enabled !== false && raw.disabled !== true, transport: validateMcpTransport(raw) };
  }
  const filePath = path.join(mcpHome(), 'servers', `${serverId}.json`);
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export async function listServers() {
  const index = await loadIndex();
  const out = [];
  for (const [id, meta] of Object.entries(index.servers ?? {})) {
    let label = id;
    let description = '';
    let builtin = false;
    try {
      const config = await loadServerConfig(id);
      label = config.label ?? id;
      description = config.description ?? '';
      builtin = config.builtin === true;
    } catch {
      /* config file missing — index entry only */
    }
    out.push({
      id,
      label,
      description,
      builtin,
      enabled: meta.enabled !== false,
      connected: clients.has(id),
      authorizationUrl: authProviders.get(id)?.authorizationUrl,
      error: connectionErrors.get(id),
    });
  }
  return out;
}

/**
 * Connect every enabled server and collect its live tool listing.
 * Servers that fail to start are returned with `error` set rather than dropped,
 * so callers can tell "no tools" apart from "never connected".
 * Refresh the dispatch map — the live listing can differ from connect time.
 */
async function collectEnabledServerTools() {
  const index = await loadIndex();
  const out = [];
  for (const [serverId, meta] of Object.entries(index.servers ?? {})) {
    if (meta.enabled === false) continue;
    const entry = { id: serverId, label: serverId, tools: [], error: null };
    try {
      const config = await loadServerConfig(serverId);
      entry.label = config.label ?? serverId;
      if (config.enabled === false) continue;
      const client = await connectServer(serverId, config);
      const listed = await allTools(client);
      entry.tools = listed.tools ?? [];
      rememberTools(serverId, entry.tools);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      connectionErrors.set(serverId, entry.error);
    }
    out.push(entry);
  }
  return out;
}

export async function listEnabledMcpTools() {
  const defs = [{ type: 'function', function: {
    name: 'mcp__minnow__add_servers',
    description: 'Add or update MCP servers from a user-provided standard mcpServers configuration. Adding a server approves its tools. Return provider sign-in links to the user when authentication is required. Use only when the user asks to configure an integration.',
    parameters: { type: 'object', properties: { mcpServers: { type: 'object', description: 'Server names mapped to {url, headers?} or {command, args?, env?, cwd?}.' } }, required: ['mcpServers'] },
  } }];
  for (const server of await collectEnabledServerTools()) {
    if (server.error) {
      console.warn(`MCP server ${server.id} skipped: ${server.error}`);
      continue;
    }
    defs.push(...toOpenAIDefinitions(server.id, server.tools));
  }
  return defs;
}

/**
 * Per-server tool listing for Settings → Tools: namespaced ids for permission
 * rows, without the JSON schemas the model-facing definitions carry.
 */
export async function listMcpToolCatalog() {
  const servers = await collectEnabledServerTools();
  return servers.map((server) => ({
    id: server.id,
    label: server.label,
    error: server.error,
    tools: server.tools.map((tool) => ({
      name: tool.name,
      namespacedName: toNamespacedName(server.id, tool.name),
      description: tool.description ?? '',
    })),
  }));
}

export async function callMcpTool(namespacedName, args) {
  if (namespacedName === 'mcp__minnow__add_servers') {
    await importMcpServers(args);
    const tools = await listEnabledMcpTools();
    return JSON.stringify({ servers: await listServers(), tools, message: 'Servers added and approved. Use their tools immediately; if sign-in is required, give the user the authorizationUrl.' });
  }
  const parsed = parseNamespacedName(namespacedName);
  if (!parsed) {
    return `Error: invalid MCP tool name ${namespacedName}`;
  }

  const index = await loadIndex();
  if (!index.servers?.[parsed.serverId] || index.servers[parsed.serverId].enabled === false) {
    return 'Error: MCP server is disabled or removed';
  }
  const config = await loadServerConfig(parsed.serverId);
  if (config.enabled === false) return 'Error: MCP server is disabled';
  if (config.id === 'context7') {
    const key = await getContext7ApiKey();
    if (!key) {
      return 'Error: Context7 API key not configured. Set it in Settings → MCP or export CONTEXT7_API_KEY.';
    }
  }

  await connectServer(parsed.serverId, config);
  const client = clients.get(parsed.serverId);
  const { toolName, known } = resolveMcpToolName(namespacedName, parsed);
  if (!toolName) {
    const available = known.length > 0 ? known.join(', ') : 'none';
    return `Error: MCP server "${parsed.serverId}" has no tool "${parsed.toolName}". Available tools: ${available}`;
  }

  const result = await client.callTool({
    name: toolName,
    arguments: args ?? {},
  });

  const parts = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n') || 'OK';
}

export function isMcpToolName(name) {
  return name.startsWith('mcp__');
}

export async function reloadMcp() {
  await Promise.allSettled([...connecting.values()]);
  for (const [, client] of clients) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
  clients.clear();
  fingerprints.clear();
  toolMaps.clear();
  connectionErrors.clear();
  authProviders.clear();
  closeMcpOAuth();
}

async function writeIndex(index) {
  for (const id of Object.keys(index.mcpServers ?? {})) delete index.servers[id];
  const indexPath = path.join(getMinnowHome(), 'mcp.json');
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/** Validate the entire paste before merging. Existing unrelated servers are preserved. */
export async function importMcpServers(body) {
  const entries = validateMcpImport(body);
  await ensureMcpSeed();
  const index = await loadIndex();
  index.mcpServers = { ...index.mcpServers };
  for (const entry of entries) {
    const { type, ...transport } = entry.transport;
    index.mcpServers[entry.id] = { ...transport, ...(type === 'sse' ? { type } : {}), ...(entry.enabled ? {} : { disabled: true }) };
  }
  await writeIndex(index);
  await reloadMcp();
  return listServers();
}

export async function setMcpServerEnabled(id, enabled) {
  const index = await loadIndex();
  if (!index.servers?.[id]) throw new Error('Unknown MCP server');
  if (index.mcpServers?.[id]) {
    index.mcpServers[id].disabled = !enabled;
    delete index.mcpServers[id].enabled;
  }
  else {
    index.servers[id].enabled = enabled;
    const config = await loadServerConfig(id);
    config.enabled = enabled;
    await fs.writeFile(path.join(mcpHome(), 'servers', `${id}.json`), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  await writeIndex(index);
  await reloadMcp();
}

/**
 * Register a custom stdio MCP server (writes config + index entry).
 * @param {unknown} body
 */
export async function createMcpServer(body) {
  await ensureMcpSeed();
  const payload = validateCreateMcpServerBody(body);
  const index = await loadIndex();
  if (index.servers?.[payload.id]) {
    throw new Error('MCP server already exists');
  }

  const config = {
    id: payload.id,
    label: payload.label,
    description: payload.description,
    transport: payload.transport,
    enabled: payload.enabled,
    builtin: false,
  };

  const filePath = path.join(mcpHome(), 'servers', `${payload.id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  index.servers = index.servers ?? {};
  index.servers[payload.id] = {
    enabled: payload.enabled,
    configFile: `servers/${payload.id}.json`,
  };
  await writeIndex(index);
  await reloadMcp();
  return listServers().then((servers) => servers.find((s) => s.id === payload.id));
}

/**
 * Remove a user-added MCP server (built-ins cannot be deleted).
 * @param {string} serverId
 */
export async function deleteMcpServer(serverId) {
  const id = validateMcpServerId(serverId);
  if (RESERVED_MCP_SERVER_IDS.has(id)) {
    throw new Error('Cannot delete a built-in MCP server');
  }

  const index = await loadIndex();
  if (!index.servers?.[id]) {
    throw new Error('Unknown MCP server');
  }

  let builtin = false;
  try {
    const config = await loadServerConfig(id);
    builtin = config.builtin === true;
  } catch {
    /* missing config — allow delete of orphan index entry */
  }
  if (builtin) {
    throw new Error('Cannot delete a built-in MCP server');
  }

  delete index.servers[id];
  if (index.mcpServers) delete index.mcpServers[id];
  await writeIndex(index);

  const filePath = path.join(mcpHome(), 'servers', `${id}.json`);
  try {
    await fs.unlink(filePath);
  } catch {
    /* file may already be missing */
  }

  await reloadMcp();
}
