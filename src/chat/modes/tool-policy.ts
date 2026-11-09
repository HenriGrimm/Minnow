import type { ToolDefinition } from '../../tools/definitions';
import type { ModeId } from './types';

/** MCP and native plugin tools are user-configured outside the built-in catalog. */
export function isExternalDynamicTool(toolName: string): boolean {
  return toolName.startsWith('mcp__') || toolName.startsWith('plugin__');
}

/**
 * One agent: tools are no longer gated by mode. Availability comes from
 * Settings → Tools; the permission level and turn clamps (/ask, /plan) decide
 * per call. Kept as a pass-through so older callers compile.
 */
export function filterToolsByMode(defs: ToolDefinition[], _modeId: ModeId): ToolDefinition[] {
  return defs;
}

export function isToolAllowedForMode(_modeId: ModeId, _toolName: string): boolean {
  return true;
}
