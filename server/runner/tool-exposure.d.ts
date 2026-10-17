import type { TurnToolDefinition } from './run-turn';
import { createLazyToolSession } from './lazy-tools';

export const SEARCH_MCP_TOOLS_NAME: 'search_mcp_tools';
export const CALL_MCP_TOOL_NAME: 'call_mcp_tool';
export function createToolExposure(catalog: TurnToolDefinition[], options?: {
  apiKind?: string;
  lazyTools?: boolean;
  alwaysLoaded?: string[];
}): {
  tools: TurnToolDefinition[];
  lazyTools: ReturnType<typeof createLazyToolSession> | null;
  cliMcpTools: {
    search(raw: unknown): string;
    resolveCall(raw: unknown): { error: string } | { name: string; arguments: Record<string, unknown> };
  } | null;
};
