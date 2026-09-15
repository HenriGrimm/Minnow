/**
 * MCP server id and stdio transport validation.
 */

const MCP_SERVER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Built-in / reserved ids — cannot be created or deleted via the API. */
export const RESERVED_MCP_SERVER_IDS = new Set(['context7', 'fixture', 'minnow']);

/**
 * @param {string} id
 * @returns {string}
 */
export function validateMcpServerId(id) {
  if (typeof id !== 'string' || !MCP_SERVER_ID_RE.test(id)) {
    throw new Error('Invalid server id (use letters, numbers, hyphens, underscores)');
  }
  if (RESERVED_MCP_SERVER_IDS.has(id)) {
    throw new Error(`Server id "${id}" is reserved`);
  }
  return id;
}

/**
 * @param {unknown} raw
 * @returns {{ type: 'stdio', command: string, args: string[], env: Record<string, string> }}
 */
export function validateStdioTransport(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('transport is required');
  }
  const transport = /** @type {Record<string, unknown>} */ (raw);
  if (transport.type !== 'stdio') {
    throw new Error('Only stdio transport is supported');
  }
  const command =
    typeof transport.command === 'string' ? transport.command.trim() : '';
  if (!command) {
    throw new Error('transport.command is required');
  }
  const args = Array.isArray(transport.args)
    ? transport.args.map((a) => String(a).trim()).filter(Boolean)
    : [];
  const env =
    transport.env && typeof transport.env === 'object' && !Array.isArray(transport.env)
      ? Object.fromEntries(
          Object.entries(/** @type {Record<string, unknown>} */ (transport.env)).map(
            ([k, v]) => [String(k), String(v)],
          ),
        )
      : {};
  return { type: 'stdio', command, args, env };
}

/** Accept the config format shared by MCP clients, including copied Markdown URLs. */
export function normalizeMcpUrl(value) {
  const text = String(value ?? '').trim();
  const unwrapped = text.match(/^\[https?:\/\/[^\]]+\]\((https?:\/\/[^)]+)\)$/)?.[1] ?? text;
  const url = new URL(unwrapped);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid MCP URL: use HTTP or HTTPS without embedded credentials');
  }
  return url.href;
}

export function validateMcpTransport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid MCP configuration');
  if (raw.url) {
    if (raw.command) throw new Error('Invalid MCP configuration: specify url or command');
    if (raw.type && !['http', 'sse', 'streamable-http'].includes(raw.type)) throw new Error('Invalid MCP transport type');
    if (raw.oauth?.grantType && !['authorization_code', 'client_credentials'].includes(raw.oauth.grantType)) throw new Error('Invalid MCP OAuth grantType');
    return {
      type: raw.type === 'sse' ? 'sse' : 'http',
      url: normalizeMcpUrl(raw.url),
      headers: stringMap(raw.headers, 'headers'),
      ...(raw.oauth ? { oauth: stringMap(raw.oauth, 'oauth') } : {}),
    };
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(a => typeof a !== 'string'))) {
    throw new Error('Invalid MCP args: expected an array of strings');
  }
  const transport = validateStdioTransport({ ...raw, type: raw.type ?? 'stdio' });
  transport.args = (raw.args ?? []).map(arg => /^\[https?:/.test(arg) ? normalizeMcpUrl(arg) : arg);
  transport.env = stringMap(raw.env, 'env');
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) throw new Error('Invalid MCP cwd');
    transport.cwd = raw.cwd;
  }
  return transport;
}

function stringMap(raw, label) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw).some(v => typeof v !== 'string')) {
    throw new Error(`Invalid MCP ${label}: expected string values`);
  }
  return { ...raw };
}

export function validateMcpImport(body) {
  const entries = body?.mcpServers;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || !Object.keys(entries).length) {
    throw new Error('Invalid configuration: mcpServers must contain at least one server');
  }
  return Object.entries(entries).map(([id, config]) => validateCreateMcpServerBody({
    ...config, id, enabled: config?.enabled !== false && config?.disabled !== true, transport: config,
  }));
}

/**
 * @param {unknown} body
 */
export function validateCreateMcpServerBody(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body is required');
  }
  const payload = /** @type {Record<string, unknown>} */ (body);
  const id = validateMcpServerId(String(payload.id ?? ''));
  const label =
    typeof payload.label === 'string' && payload.label.trim()
      ? payload.label.trim()
      : id;
  const description =
    typeof payload.description === 'string' ? payload.description.trim() : '';
  const transport = validateMcpTransport(payload.transport ?? payload);
  const enabled = payload.enabled !== false;
  return { id, label, description, transport, enabled };
}
