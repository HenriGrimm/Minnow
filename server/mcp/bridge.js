/**
 * MCP tool namespacing and OpenAI function definition mapping.
 *
 * Encoding folds `-` into `_` to stay inside the function-name charset, so it is
 * lossy: `browser_navigate` and `browser-navigate` both encode to the same id.
 * Decoding therefore cannot recover the server's own spelling — dispatch must
 * resolve against the live tool listing (see `resolveMcpToolName` in registry.js)
 * and treat this parse as a hint only.
 */

/** mcp__<serverId>__<toolName> */
export function toNamespacedName(serverId, toolName) {
  const safeTool = String(toolName).replace(/-/g, '_');
  return `mcp__${serverId}__${safeTool}`;
}

/**
 * Split `mcp__<serverId>__<toolName>`.
 * `toolName` keeps the encoded spelling; `toolNameCandidates` holds every
 * spelling that could have produced it, most likely first.
 */
export function parseNamespacedName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  const parts = name.slice(5).split('__');
  if (parts.length < 2) return null;
  const serverId = parts[0];
  const encoded = parts.slice(1).join('__');
  const dashed = encoded.replace(/_/g, '-');
  return {
    serverId,
    toolName: encoded,
    toolNameCandidates: dashed === encoded ? [encoded] : [encoded, dashed],
  };
}

/**
 * Permission hint from MCP tool annotations: `read` for readOnlyHint tools,
 * `destructive` for destructiveHint, otherwise `write` (an unknown effect).
 * @param {{ annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean } }} tool
 * @returns {'read'|'write'|'destructive'}
 */
export function mcpToolPermissionHint(tool) {
  const a = tool?.annotations;
  if (a?.readOnlyHint === true) return 'read';
  if (a?.destructiveHint === true) return 'destructive';
  return 'write';
}

/**
 * @param {string} serverId
 * @param {Array<{ name: string, description?: string, inputSchema?: object }>} tools
 */
export function toOpenAIDefinitions(serverId, tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: toNamespacedName(serverId, tool.name),
      description: tool.description ?? `MCP tool ${tool.name} from ${serverId}`,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}
