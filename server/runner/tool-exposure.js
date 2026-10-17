import { createLazyToolSession } from './lazy-tools.js';

export const SEARCH_MCP_TOOLS_NAME = 'search_mcp_tools';
export const CALL_MCP_TOOL_NAME = 'call_mcp_tool';

const MCP_TOOLS = [{ type: 'function', function: {
  name: SEARCH_MCP_TOOLS_NAME,
  description: 'Discover permitted MCP integration tools by capability or exact namespaced name, before using call_mcp_tool. Returns the matching tools\' complete parameter schemas. Use list_only: true to list permitted names without schemas. MCP tools are invoked through call_mcp_tool, never as direct function calls.',
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'Capability or exact mcp__server__tool name. Required unless list_only is true.' },
    list_only: { type: 'boolean', description: 'List names without loading parameter schemas.' },
    limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum matches; defaults to 3.' },
  } },
} }, { type: 'function', function: {
  name: CALL_MCP_TOOL_NAME,
  description: 'Invoke a permitted MCP tool discovered with search_mcp_tools. Supply its exact namespaced name and an arguments object matching its discovered parameter schema. Tools discovered in earlier turns remain usable when still permitted. Minnow applies the original tool\'s execution and permission checks.',
  parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'Exact mcp__server__tool name returned by search_mcp_tools.' },
    arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching that MCP tool\'s parameter schema.' },
  }, required: ['name', 'arguments'] },
} }];

/** Stable native schemas; only discovery results contain individual MCP schemas. */
function createCliMcpTools(catalog) {
  const permitted = new Map(catalog.filter(tool => tool.function.name.startsWith('mcp__'))
    .map(tool => [tool.function.name, tool]));
  const discovery = createLazyToolSession([...permitted.values()]);
  return {
    search(raw) {
      const found = discovery.search(raw);
      if (found.startsWith('Error:')) return found.replaceAll('search_tools', SEARCH_MCP_TOOLS_NAME);
      const result = JSON.parse(found);
      return JSON.stringify(result.names ? { names: result.names, message: 'Search by name to retrieve its schema, then use call_mcp_tool.' }
        : { tools: result.loaded.map(name => permitted.get(name).function),
          message: result.loaded.length ? 'Use call_mcp_tool with the exact name and arguments matching its schema.' : 'No permitted MCP tools matched.' });
    },
    resolveCall(raw) {
      let args = raw;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return { error: 'Error: call_mcp_tool requires valid JSON arguments.' }; }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.name !== 'string'
        || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) {
        return { error: 'Error: provide an exact MCP tool name and an arguments object.' };
      }
      if (!permitted.has(args.name)) return { error: 'Error: this MCP tool is not available or permitted. Use search_mcp_tools to find permitted tools.' };
      return { name: args.name, arguments: args.arguments };
    },
  };
}

/** Shared by execution and the outbound context estimate. */
export function createToolExposure(catalog, { apiKind, lazyTools = false, alwaysLoaded = [] } = {}) {
  if (apiKind === 'agent-cli-v1') {
    return { tools: [...catalog.filter(tool => !tool.function.name.startsWith('mcp__')
      && ![SEARCH_MCP_TOOLS_NAME, CALL_MCP_TOOL_NAME].includes(tool.function.name)), ...structuredClone(MCP_TOOLS)],
    cliMcpTools: createCliMcpTools(catalog), lazyTools: null };
  }
  const lazy = lazyTools ? createLazyToolSession(catalog, alwaysLoaded) : null;
  return { tools: lazy?.tools ?? catalog, cliMcpTools: null, lazyTools: lazy };
}
