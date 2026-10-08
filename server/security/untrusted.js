/**
 * Server re-export of shared untrusted-content helpers.
 */

export {
  escapeGuardMarkers,
  GUARD_CLOSE,
  GUARD_OPEN_PREFIX,
  isWrappedUntrusted,
  sanitizeSourceLabel,
  UNTRUSTED_CONTEXT_POLICY_FULL,
  UNTRUSTED_CONTEXT_POLICY_LITE,
  wrapUntrusted,
} from '../../src/lib/untrusted.mjs';

import { isMcpToolName } from '../mcp/registry.js';
import { parseNamespacedName } from '../mcp/bridge.js';
import path from 'node:path';
import { isWrappedUntrusted, wrapUntrusted } from '../../src/lib/untrusted.mjs';

/** Per-tool source labels for middleware wrapping of server tool output. */
const TOOL_SOURCE_RESOLVERS = {
  fetch_web_content: (args) => `web:${String(args?.url ?? 'unknown').trim()}`,
  rag_web_content: (args) => `web-rag:${String(args?.url ?? 'unknown').trim()}`,
  read_document: (args) => {
    if (typeof args?.path === 'string' && args.path.trim()) {
      return `document:${path.basename(args.path.trim())}`;
    }
    const name =
      typeof args?.filename === 'string' && args.filename.trim()
        ? path.basename(args.filename.trim())
        : 'document';
    return `document:${name}`;
  },
  browser_drive_read_page: (args) => `browser:${String(args?.mode ?? 'a11y').trim() || 'a11y'}`,
  browser_drive_read_console: () => 'browser:console',
  browser_drive_read_network: () => 'browser:network',
  web_search_ddg: () => 'web-search:ddg',
  web_search_tavily: () => 'web-search:tavily',
  web_map: () => 'web-map:tavily',
  web_extract: () => 'web-extract:tavily',
  web_search_searxng: () => 'web-search:searxng',
};

/** Human-readable MCP source label for untrusted fences (e.g. mcp:fixture/echo). */
function mcpToolSourceLabel(toolName) {
  const parsed = parseNamespacedName(toolName);
  if (parsed) {
    return `mcp:${parsed.serverId}/${parsed.toolName}`;
  }
  return `mcp:${String(toolName).replace(/^mcp_/, '')}`;
}

/**
 * Whether a tool result string should be wrapped at the middleware boundary.
 * @param {string} toolName
 * @param {string} result
 * @returns {boolean}
 */
export function shouldWrapServerToolResult(toolName, result) {
  if (typeof result !== 'string' || !result.trim()) {
    return false;
  }
  if (result.startsWith('Error:')) {
    return false;
  }
  if (isWrappedUntrusted(result)) {
    return false;
  }
  if (toolName in TOOL_SOURCE_RESOLVERS) {
    return true;
  }
  return isMcpToolName(toolName);
}

/**
 * Wrap a server tool result when it carries untrusted external text.
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string} result
 * @returns {string}
 */
export function wrapServerToolResult(toolName, args, result) {
  const text = String(result ?? '');
  if (!shouldWrapServerToolResult(toolName, text)) {
    return text;
  }

  const resolver = TOOL_SOURCE_RESOLVERS[toolName];
  const source = resolver
    ? resolver(args ?? {})
    : mcpToolSourceLabel(toolName);

  return wrapUntrusted(text, { source });
}
